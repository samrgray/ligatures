// @-mentions in notes and your text fields. The text holds a plain “@Full Name” (so it reads
// naturally in Google and on iPhone); this remembers which contact each one points to, so the
// link survives renames and same-named people, and rewrites the text when that person is renamed.
// The matching rules are the same as public/mentions.js and the iOS app’s Mentions.swift.

import type { AccountRow, ContactRow, Env, UserRow } from './types';
import { provider } from './providers';
import { cached, saveDraft, saveFromProvider } from './contacts';
import { HttpError, now } from './http';

export interface Named {
  id: string;
  name: string;
}

export interface Found extends Named {
  start: number;
  end: number;
}

/** Where a mention lives on a contact: its notes, or one of your fields. */
export const NOTES = 'notes';
export const fieldSource = (fieldId: string) => `f:${fieldId}`;

/** How many renamed mentions one pass rewrites (each may be a write to Google). */
const FIXES_PER_PASS = 20;

const WORD = /[\p{L}\p{N}]/u;
const clean = (s: string) => s.trim().replace(/\s+/g, ' ');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nameRe = (name: string, flags = 'iuy') => new RegExp(clean(name).split(' ').map(escapeRe).join('\\s+'), flags);

/** Your contacts’ names, to match mentions against. */
export async function liveNames(db: D1Database, userId: string): Promise<Named[]> {
  return (
    await db
      .prepare(
        `SELECT id, display_name AS name FROM contacts
         WHERE user_id = ?1 AND deleted_at IS NULL AND merged_into IS NULL AND archived_at IS NULL AND COALESCE(display_name, '') != ''`,
      )
      .bind(userId)
      .all<Named>()
  ).results;
}

/**
 * Every “@Name” in the text naming one of these people (or one already remembered, in `known`,
 * which wins). Longer names win, and an @ inside a word (an email address) isn’t a mention.
 */
export function findMentions(text: string, names: Named[], known: Named[] = []): Found[] {
  const s = String(text ?? '');
  if (!s.includes('@')) return [];
  const byFirst = new Map<string, { id: string; name: string; rank: number }[]>();
  const add = (n: Named, rank: number) => {
    const name = clean(n.name);
    if (!name) return;
    const first = name.toLowerCase().split(' ')[0];
    if (!byFirst.has(first)) byFirst.set(first, []);
    byFirst.get(first)!.push({ id: n.id, name, rank });
  };
  for (const n of known) add(n, 0);
  for (const n of names) add(n, 1);
  for (const v of byFirst.values()) v.sort((a, b) => b.name.length - a.name.length || a.rank - b.rank);

  const out: Found[] = [];
  for (let i = s.indexOf('@'); i >= 0; i = s.indexOf('@', i + 1)) {
    if (i > 0 && WORD.test(s[i - 1])) continue;
    const first = (/^[^\s@]+/.exec(s.slice(i + 1))?.[0] ?? '').toLowerCase();
    const cands = byFirst.get(first) ?? byFirst.get(first.replace(/[.,;:!?)’'”"]+$/u, '')) ?? [];
    for (const c of cands) {
      const re = nameRe(c.name);
      re.lastIndex = i + 1;
      if (!re.test(s)) continue;
      const end = re.lastIndex;
      if (WORD.test(s[end] ?? '')) continue;
      out.push({ start: i, end, id: c.id, name: c.name });
      i = end - 1;
      break;
    }
  }
  return out;
}

/** Remember who the mentions in one piece of text point to (replacing what was remembered). */
export function recordMentions(db: D1Database, userId: string, contactId: string, source: string, text: string, names: Named[], known: Named[]) {
  const seen = new Set<string>();
  const found = findMentions(text, names, known).filter((m) => !seen.has(m.name.toLowerCase()) && seen.add(m.name.toLowerCase()));
  const t = now();
  return [
    db.prepare('DELETE FROM mentions WHERE contact_id = ?1 AND source = ?2').bind(contactId, source),
    ...found.map((m) =>
      db
        .prepare('INSERT OR REPLACE INTO mentions (user_id, contact_id, source, name, target_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
        .bind(userId, contactId, source, m.name, m.id, t),
    ),
  ];
}

/** What’s remembered for one contact, by source. */
export async function mentionsOf(db: D1Database, contactId: string): Promise<{ source: string; name: string; id: string }[]> {
  return (
    await db
      .prepare('SELECT source, name, target_id AS id FROM mentions WHERE contact_id = ?1')
      .bind(contactId)
      .all<{ source: string; name: string; id: string }>()
  ).results;
}

/** Re-record the mentions in a contact’s notes and text fields after they changed. */
export async function rememberMentions(db: D1Database, userId: string, contactId: string, texts: { source: string; text: string }[]) {
  if (!texts.length) return;
  const known = await mentionsOf(db, contactId);
  const names = texts.some((x) => x.text.includes('@')) ? await liveNames(db, userId) : [];
  const stmts = texts.flatMap((x) =>
    recordMentions(db, userId, contactId, x.source, x.text, names, known.filter((k) => k.source === x.source)),
  );
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
}

/** After a sync: re-record the mentions in notes that changed (in one go for many contacts). */
export async function rememberNotes(db: D1Database, userId: string, items: { id: string; notes: string }[]) {
  if (!items.length) return;
  const had = new Set(
    (await db.prepare('SELECT DISTINCT contact_id FROM mentions WHERE user_id = ?1 AND source = ?2').bind(userId, NOTES).all<{ contact_id: string }>())
      .results.map((r) => r.contact_id),
  );
  const todo = items.filter((x) => x.notes.includes('@') || had.has(x.id));
  if (!todo.length) return;
  const names = await liveNames(db, userId);
  const known = (
    await db
      .prepare(
        `SELECT contact_id, name, target_id AS id FROM mentions
         WHERE user_id = ?1 AND source = ?2 AND contact_id IN (SELECT value FROM json_each(?3))`,
      )
      .bind(userId, NOTES, JSON.stringify(todo.map((x) => x.id)))
      .all<{ contact_id: string; name: string; id: string }>()
  ).results;
  const stmts = todo.flatMap((x) => recordMentions(db, userId, x.id, NOTES, x.notes, names, known.filter((k) => k.contact_id === x.id)));
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
}

/** “@Old Name” → “@New Name” throughout the text. */
function rename(text: string, from: string, to: string): string {
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])@${nameRe(from, '').source}(?![\\p{L}\\p{N}])`, 'giu');
  return text.replace(re, (_, pre) => `${pre}@${clean(to)}`);
}

/**
 * Bring mentions up to date with renames (and merges): rewrite “@Old Name” to the person’s
 * current name in the notes (in Google) or field that holds it. A few per pass; the rest wait
 * for the next sync or edit.
 */
export async function fixMentions(env: Env, user: UserRow): Promise<number> {
  const db = env.DB;
  const rows = (
    await db
      .prepare(
        `SELECT m.contact_id, m.source, m.name, m.target_id, t.display_name AS current, t.merged_into
         FROM mentions m JOIN contacts t ON t.id = m.target_id
         WHERE m.user_id = ?1 AND (t.merged_into IS NOT NULL
           OR (t.deleted_at IS NULL AND COALESCE(t.display_name, '') != '' AND t.display_name != m.name))
         LIMIT ?2`,
      )
      .bind(user.id, FIXES_PER_PASS)
      .all<{ contact_id: string; source: string; name: string; target_id: string; current: string | null; merged_into: string | null }>()
  ).results;
  let fixed = 0;
  for (const m of rows) {
    const key = [m.contact_id, m.source, m.name];
    if (m.merged_into) {
      // Merged: point at the contact it became (a rename, if any, is picked up next time).
      await db.prepare('UPDATE OR IGNORE mentions SET target_id = ?4 WHERE contact_id = ?1 AND source = ?2 AND name = ?3').bind(...key, m.merged_into).run();
      continue;
    }
    const to = clean(m.current ?? '');
    try {
      if (m.source === NOTES) {
        const holder = await db.prepare('SELECT * FROM contacts WHERE id = ?1 AND user_id = ?2').bind(m.contact_id, user.id).first<ContactRow>();
        if (!holder || holder.deleted_at || holder.merged_into || holder.archived_at) continue;
        const account = await db.prepare('SELECT * FROM accounts WHERE id = ?1').bind(holder.account_id).first<AccountRow>();
        if (!account) continue;
        const p = provider(account.provider);
        const notes = p.toCard(JSON.parse(holder.data_json ?? '{}')).notes;
        const next = rename(notes, m.name, to);
        if (next !== notes) {
          if (holder.draft) await saveDraft(db, holder, p.editDraft(JSON.parse(holder.data_json ?? '{}'), { notes: next }), p.id);
          else {
            const ctx = { env, db, account };
            try {
              await saveFromProvider(db, holder, await p.update(ctx, cached(holder), { notes: next }), p.id);
            } catch (e) {
              // Our copy was out of date: take Google’s, and try again next pass.
              if (e instanceof HttpError && e.code === 'conflict') await saveFromProvider(db, holder, await p.get(ctx, holder.provider_contact_id), p.id);
              throw e;
            }
          }
        }
      } else if (m.source.startsWith('f:')) {
        const fieldId = m.source.slice(2);
        const v = await db.prepare('SELECT value FROM field_values WHERE contact_id = ?1 AND field_id = ?2').bind(m.contact_id, fieldId).first<{ value: string }>();
        const next = v ? rename(v.value, m.name, to) : '';
        if (v && next !== v.value) {
          await db.prepare('UPDATE field_values SET value = ?3, updated_at = ?4 WHERE contact_id = ?1 AND field_id = ?2').bind(m.contact_id, fieldId, next, now()).run();
        }
      }
      // Remembered under the new name (if the text no longer had the old one, this just catches up).
      await db.batch([
        db.prepare('DELETE FROM mentions WHERE contact_id = ?1 AND source = ?2 AND name = ?3').bind(...key),
        db
          .prepare('INSERT OR REPLACE INTO mentions (user_id, contact_id, source, name, target_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
          .bind(user.id, m.contact_id, m.source, to, m.target_id, now()),
      ]);
      fixed++;
    } catch (e) {
      // Changed in Google meanwhile, or offline: the next pass tries again with a fresh copy.
      console.warn('mention rename failed', m.contact_id, e);
    }
  }
  return fixed;
}
