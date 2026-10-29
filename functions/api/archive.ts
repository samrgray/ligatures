import type { AccountRow, ContactRow, Data, Env, Group } from '../../lib/types';
import { HttpError, json, now, readJson } from '../../lib/http';
import { requireUser } from '../../lib/session';
import { provider } from '../../lib/providers';
import { cached, sortKeyFor } from '../../lib/contacts';
import { fieldDefsFor, searchText } from '../../lib/payload';
import { carryOriginal } from '../../lib/photos';

const MAX = 100;

// GET /api/archive → archived contacts, for the Archived view.
export const onRequestGet: PagesFunction<Env, string, Data> = async ({ env, data }) => {
  const user = requireUser(data.user);
  const rows = (
    await env.DB
      .prepare(
        `SELECT c.id, c.account_id, c.draft, a.provider, ar.person_json, ar.groups_json, ar.photo, ar.archived_at,
           (SELECT json_group_object(fv.field_id, fv.value) FROM field_values fv WHERE fv.contact_id = c.id) AS fields_json
         FROM contacts c JOIN archives ar ON ar.contact_id = c.id JOIN accounts a ON a.id = c.account_id
         WHERE c.user_id = ?1 AND c.archived_at IS NOT NULL AND c.deleted_at IS NULL AND c.merged_into IS NULL
         ORDER BY c.sort_key`,
      )
      .bind(user.id)
      .all<{ id: string; account_id: string; draft: number; provider: string; person_json: string; groups_json: string; photo: string | null; archived_at: number; fields_json: string | null }>()
  ).results;
  const defs = await fieldDefsFor(env.DB, user.id);
  return json({
    contacts: rows.map((r) => {
      const card = provider(r.provider).toCard(JSON.parse(r.person_json));
      const fields = JSON.parse(r.fields_json || '{}') as Record<string, string>;
      const mobile = card.phones.find((p) => /mobile|cell|iphone/i.test(p.label)) ?? card.phones[0];
      return {
        id: r.id,
        accountId: r.account_id,
        givenName: card.givenName,
        familyName: card.familyName,
        displayName: card.displayName,
        organization: card.organization,
        title: card.title,
        email: card.emails[0]?.value ?? '',
        phone: mobile?.value ?? '',
        address: card.addresses[0]?.value.replace(/\s*\n\s*/g, ', ') ?? '',
        birthday: card.birthday,
        birthdayKey: card.birthdayKey,
        notes: card.notes.slice(0, 300),
        photoUrl: r.photo ? `data:image/jpeg;base64,${r.photo}` : '',
        search: searchText(card, fields, defs, r.account_id, JSON.parse(r.groups_json) as string[]),
        groups: JSON.parse(r.groups_json) as string[],
        fields,
        archivedAt: r.archived_at,
        ...(r.draft ? { draft: true } : {}),
      };
    }),
  });
};

// POST /api/archive
//   { action: 'archive', ids, etags? } → keep everything Google has on them (every field, their
//      photo and their lists) in Ligature, then delete them from Google.
//   { action: 'restore', ids }          → recreate them in Google, back on their lists.
//   { action: 'forget', ids }           → delete archived contacts for good.
export const onRequestPost: PagesFunction<Env, string, Data> = async ({ request, env, data }) => {
  const user = requireUser(data.user);
  const body = await readJson<{ action?: unknown; ids?: unknown; etags?: unknown }>(request);
  if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > MAX || body.ids.some((id) => typeof id !== 'string')) {
    throw new HttpError(400, `Choose up to ${MAX} contacts.`);
  }
  const ids = body.ids as string[];
  const archived = body.action !== 'archive';
  const rows = (
    await env.DB
      .prepare(
        `SELECT * FROM contacts WHERE user_id = ?1 AND deleted_at IS NULL AND merged_into IS NULL
           AND archived_at IS ${archived ? 'NOT NULL' : 'NULL'} AND id IN (SELECT value FROM json_each(?2))`,
      )
      .bind(user.id, JSON.stringify(ids))
      .all<ContactRow>()
  ).results;
  const accounts = new Map(
    (await env.DB.prepare('SELECT * FROM accounts WHERE user_id = ?1').bind(user.id).all<AccountRow>()).results.map((a) => [a.id, a]),
  );
  const done: string[] = [];
  const skipped: { id: string; reason: string }[] = [];

  if (body.action === 'archive') {
    const seen = (body.etags && typeof body.etags === 'object' ? body.etags : {}) as Record<string, unknown>;
    for (const accountId of new Set(rows.map((r) => r.account_id))) {
      const account = accounts.get(accountId);
      if (!account) continue;
      const p = provider(account.provider);
      const ctx = { env, db: env.DB, account };
      const list = rows.filter((r) => r.account_id === accountId);
      // 1. Keep everything first.
      const kept: ContactRow[] = [];
      for (const r of list) {
        if (typeof seen[r.id] === 'string' && seen[r.id] !== r.etag) {
          skipped.push({ id: r.id, reason: 'changed' });
          continue;
        }
        if (r.draft) {
          // A draft is already only here: keep it as it is, and nothing goes to Google.
          const raw = JSON.parse(r.data_json ?? '{}');
          const photoUrl = p.toCard(raw).photoUrl;
          const t = now();
          await env.DB.batch([
            env.DB
              .prepare(
                `INSERT INTO archives (contact_id, user_id, person_json, groups_json, photo, archived_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(contact_id) DO UPDATE SET person_json = excluded.person_json, groups_json = excluded.groups_json,
                   photo = excluded.photo, archived_at = excluded.archived_at`,
              )
              .bind(r.id, user.id, r.data_json ?? '{}', JSON.stringify(p.toCard(raw).groups), photoUrl.startsWith('data:') ? photoUrl.split(',')[1] : null, t),
            env.DB.prepare('UPDATE contacts SET archived_at = ?2 WHERE id = ?1').bind(r.id, t),
          ]);
          done.push(r.id);
          continue;
        }
        try {
          const snap = await p.snapshot(ctx, r.provider_contact_id);
          const groups = p.toCard(snap.raw).groups;
          const t = now();
          await env.DB.batch([
            env.DB
              .prepare(
                `INSERT INTO archives (contact_id, user_id, person_json, groups_json, photo, archived_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(contact_id) DO UPDATE SET person_json = excluded.person_json, groups_json = excluded.groups_json,
                   photo = excluded.photo, archived_at = excluded.archived_at`,
              )
              .bind(r.id, user.id, JSON.stringify(snap.raw), JSON.stringify(groups), snap.photo, t),
            env.DB.prepare('UPDATE contacts SET archived_at = ?2, data_json = ?3 WHERE id = ?1').bind(r.id, t, JSON.stringify(snap.raw)),
          ]);
          kept.push(r);
        } catch (e) {
          skipped.push({ id: r.id, reason: (e as Error).message });
        }
      }
      // 2. Then delete them from Google. Anyone Google wouldn’t delete goes back as they were.
      if (!kept.length) continue;
      const result = await p.deleteContacts(ctx, kept.map(cached));
      const gone = new Set([...result.deleted, ...result.gone]);
      const undo: string[] = [];
      for (const r of kept) {
        if (gone.has(r.provider_contact_id)) done.push(r.id);
        else {
          undo.push(r.id);
          skipped.push({ id: r.id, reason: 'changed' });
        }
      }
      if (undo.length) {
        const j = JSON.stringify(undo);
        await env.DB.batch([
          env.DB.prepare('DELETE FROM archives WHERE contact_id IN (SELECT value FROM json_each(?1))').bind(j),
          env.DB.prepare('UPDATE contacts SET archived_at = NULL WHERE id IN (SELECT value FROM json_each(?1))').bind(j),
        ]);
      }
    }
  } else if (body.action === 'restore') {
    for (const r of rows) {
      const account = accounts.get(r.account_id);
      const a = await env.DB.prepare('SELECT * FROM archives WHERE contact_id = ?1').bind(r.id).first<{ person_json: string; groups_json: string; photo: string | null }>();
      if (!account || !a) {
        skipped.push({ id: r.id, reason: 'missing' });
        continue;
      }
      const p = provider(account.provider);
      if (r.draft) {
        // Back as a draft, still only in Ligature.
        await env.DB.batch([
          env.DB.prepare('UPDATE contacts SET archived_at = NULL WHERE id = ?1').bind(r.id),
          env.DB.prepare('DELETE FROM archives WHERE contact_id = ?1').bind(r.id),
        ]);
        done.push(r.id);
        continue;
      }
      const existing = new Set((JSON.parse(account.groups_json ?? '[]') as Group[]).map((g) => g.id));
      // Back on the lists that still exist. Google adds everyone to My Contacts itself.
      const groups = (JSON.parse(a.groups_json) as string[]).filter((g) => existing.has(g) && g !== 'contactGroups/myContacts');
      try {
        const pc = await p.restore({ env, db: env.DB, account }, JSON.parse(a.person_json), a.photo, r.id, groups);
        const card = p.toCard(pc.raw);
        const t = now();
        await env.DB.batch([
          env.DB
            .prepare(
              `UPDATE contacts SET provider_contact_id = ?2, etag = ?3, display_name = ?4, sort_key = ?5, data_json = ?6,
                 link_stamped = 1, archived_at = NULL, updated_at = ?7 WHERE id = ?1`,
            )
            .bind(r.id, pc.providerContactId, pc.etag, card.displayName, sortKeyFor(card), JSON.stringify(pc.raw), t),
          env.DB.prepare('DELETE FROM archives WHERE contact_id = ?1').bind(r.id),
        ]);
        await carryOriginal(env.DB, r.id, p.toCard(JSON.parse(r.data_json ?? '{}')).photoUrl, card.photoUrl);
        done.push(r.id);
      } catch (e) {
        skipped.push({ id: r.id, reason: (e as Error).message });
      }
    }
  } else if (body.action === 'forget') {
    const j = JSON.stringify(rows.map((r) => r.id));
    const t = now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM archives WHERE contact_id IN (SELECT value FROM json_each(?1))').bind(j),
      env.DB.prepare('DELETE FROM relationships WHERE a_id IN (SELECT value FROM json_each(?1)) OR b_id IN (SELECT value FROM json_each(?1))').bind(j),
      env.DB.prepare('DELETE FROM field_values WHERE contact_id IN (SELECT value FROM json_each(?1))').bind(j),
      env.DB.prepare('DELETE FROM photo_originals WHERE contact_id IN (SELECT value FROM json_each(?1))').bind(j),
      env.DB.prepare('UPDATE contacts SET deleted_at = ?2, updated_at = ?2 WHERE id IN (SELECT value FROM json_each(?1))').bind(j, t),
    ]);
    done.push(...rows.map((r) => r.id));
  } else {
    throw new HttpError(400, 'Unknown action.');
  }
  return json({ done, skipped, missing: ids.filter((id) => !rows.some((r) => r.id === id)) });
};
