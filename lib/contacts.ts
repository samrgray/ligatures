import type { AccountRow, Card, ContactRow, Env, UserRow } from './types';
import type { ProviderContact, ProviderCtx } from './providers/types';
import { provider } from './providers';
import { HttpError, now } from './http';
import { rememberNotes } from './mentions';

const MAX_CHUNK_BYTES = 800_000;
const STAMPS_PER_SYNC = 10;

export function sortKeyFor(card: Card): string {
  return (card.familyName || card.givenName || card.displayName || '').trim().toLowerCase();
}

export async function accountsFor(db: D1Database, userId: string): Promise<AccountRow[]> {
  const r = await db.prepare('SELECT * FROM accounts WHERE user_id = ?1 ORDER BY created_at').bind(userId).all<AccountRow>();
  return r.results;
}

export async function loadContact(db: D1Database, user: UserRow, id: string): Promise<{ row: ContactRow; account: AccountRow }> {
  let row = await db.prepare('SELECT * FROM contacts WHERE id = ?1 AND user_id = ?2').bind(id, user.id).first<ContactRow>();
  // Follow merges so an old link still lands on the surviving contact.
  for (let hops = 0; row?.merged_into && hops < 5; hops++) {
    row = await db.prepare('SELECT * FROM contacts WHERE id = ?1 AND user_id = ?2').bind(row.merged_into, user.id).first<ContactRow>();
  }
  if (!row) throw new HttpError(404, 'Contact not found.');
  const account = await db.prepare('SELECT * FROM accounts WHERE id = ?1 AND user_id = ?2').bind(row.account_id, user.id).first<AccountRow>();
  if (!account) throw new HttpError(404, 'Account not found.');
  return { row, account };
}

/** Write a provider's fresh copy of one contact back to the cache. */
export async function saveFromProvider(db: D1Database, row: ContactRow, pc: ProviderContact, providerId: string): Promise<ContactRow> {
  const card = provider(providerId).toCard(pc.raw);
  const next: ContactRow = {
    ...row,
    provider_contact_id: pc.providerContactId,
    etag: pc.etag,
    display_name: card.displayName,
    sort_key: sortKeyFor(card),
    data_json: JSON.stringify(pc.raw),
    link_stamped: pc.linkIds.length === 1 && pc.linkIds[0] === row.id ? 1 : 0,
    updated_at: now(),
  };
  await db
    .prepare(
      `UPDATE contacts SET provider_contact_id = ?2, etag = ?3, display_name = ?4, sort_key = ?5,
       data_json = ?6, link_stamped = ?7, updated_at = ?8 WHERE id = ?1`,
    )
    .bind(next.id, next.provider_contact_id, next.etag, next.display_name, next.sort_key, next.data_json, next.link_stamped, next.updated_at)
    .run();
  return next;
}

/** Save a draft’s new data (drafts live only here, so this is their whole write). */
export async function saveDraft(db: D1Database, row: ContactRow, raw: unknown, providerId: string): Promise<ContactRow> {
  return saveFromProvider(db, row, { providerContactId: row.provider_contact_id, etag: crypto.randomUUID(), deleted: false, linkIds: [row.id], raw }, providerId);
}

/** Put drafts on a list or take them off (Ligature-only, like the drafts themselves). */
export async function setDraftMembership(db: D1Database, rows: ContactRow[], groupId: string, on: boolean, providerId: string): Promise<ContactRow[]> {
  const p = provider(providerId);
  const out: ContactRow[] = [];
  for (const r of rows) {
    const raw = JSON.parse(r.data_json ?? '{}');
    const groups = p.toCard(raw).groups.filter((g) => g !== groupId);
    if (on) groups.push(groupId);
    out.push(await saveDraft(db, r, p.setDraftGroups(raw, groups), providerId));
  }
  return out;
}

/**
 * Reload several contacts from the provider and write them to the cache in one batch
 * (after a change made outside the contact itself, like adding it to a list).
 */
export async function refreshContacts(env: Env, account: AccountRow, rows: ContactRow[]): Promise<ContactRow[]> {
  if (!rows.length) return [];
  const p = provider(account.provider);
  const fresh = new Map((await p.getMany({ env, db: env.DB, account }, rows.map((r) => r.provider_contact_id))).map((pc) => [pc.providerContactId, pc]));
  const t = now();
  const out: ContactRow[] = [];
  const stmts: D1PreparedStatement[] = [];
  for (const row of rows) {
    const pc = fresh.get(row.provider_contact_id);
    if (!pc) continue;
    const card = p.toCard(pc.raw);
    const next: ContactRow = {
      ...row,
      etag: pc.etag,
      display_name: card.displayName,
      sort_key: sortKeyFor(card),
      data_json: JSON.stringify(pc.raw),
      link_stamped: pc.linkIds.length === 1 && pc.linkIds[0] === row.id ? 1 : 0,
      updated_at: t,
    };
    out.push(next);
    stmts.push(
      env.DB
        .prepare('UPDATE contacts SET etag = ?2, display_name = ?3, sort_key = ?4, data_json = ?5, link_stamped = ?6, updated_at = ?7 WHERE id = ?1')
        .bind(next.id, next.etag, next.display_name, next.sort_key, next.data_json, next.link_stamped, t),
    );
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return out;
}

/** The user’s live contacts among `ids`. Throws if any don’t belong to them. */
export async function ownedContacts(db: D1Database, user: UserRow, ids: string[]): Promise<ContactRow[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const rows = (
    await db
      .prepare(
        `SELECT * FROM contacts WHERE user_id = ?1 AND deleted_at IS NULL AND merged_into IS NULL AND archived_at IS NULL
           AND id IN (SELECT value FROM json_each(?2))`,
      )
      .bind(user.id, JSON.stringify(unique))
      .all<ContactRow>()
  ).results;
  if (rows.length !== unique.length) throw new HttpError(400, 'Some of those contacts no longer exist. Sync and try again.');
  return rows;
}

export function cached(row: ContactRow) {
  return { providerContactId: row.provider_contact_id, etag: row.etag ?? '', raw: JSON.parse(row.data_json ?? '{}') };
}

/** Write Ligature's ID into the contact's hidden per-app data, so the link survives merges. */
export async function stampLink(env: Env, db: D1Database, account: AccountRow, row: ContactRow): Promise<ContactRow> {
  const p = provider(account.provider);
  const ctx: ProviderCtx = { env, db, account };
  try {
    return await saveFromProvider(db, row, await p.setLink(ctx, cached(row), row.id), account.provider);
  } catch (e) {
    if (e instanceof HttpError && e.code === 'conflict') {
      // Our copy was stale. Refresh it, then retry once with the current etag.
      const fresh = await saveFromProvider(db, row, await p.get(ctx, row.provider_contact_id), account.provider);
      return saveFromProvider(db, fresh, await p.setLink(ctx, cached(fresh), row.id), account.provider);
    }
    throw e;
  }
}

interface ExistingRow {
  id: string;
  provider_contact_id: string;
  merged_into: string | null;
  deleted_at: number | null;
  nvals: number;
}

export interface SyncSummary {
  accountId: string;
  full: boolean;
  changed: number;
  removed: number;
  merged: number;
  linked: number;
}

export async function syncAccount(env: Env, db: D1Database, user: UserRow, account: AccountRow): Promise<SyncSummary> {
  const p = provider(account.provider);
  const ctx: ProviderCtx = { env, db, account };
  const result = await p.sync(ctx, account.sync_token);
  const t = now();

  const existing = (
    await db
      .prepare(
        `SELECT c.id, c.provider_contact_id, c.merged_into, c.deleted_at,
           (SELECT COUNT(*) FROM field_values fv WHERE fv.contact_id = c.id)
             + (SELECT COUNT(*) FROM interactions i WHERE i.contact_id = c.id)
             + (SELECT COUNT(*) FROM relationships r WHERE r.a_id = c.id OR r.b_id = c.id) AS nvals
         FROM contacts c WHERE c.account_id = ?1 AND c.archived_at IS NULL AND c.draft = 0`,
      )
      .bind(account.id)
      .all<ExistingRow>()
  ).results;

  const byId = new Map(existing.map((r) => [r.id, r]));
  const livePcid = new Map(existing.filter((r) => !r.merged_into && !r.deleted_at).map((r) => [r.provider_contact_id, r]));
  const resolve = (id: string) => {
    let r = byId.get(id);
    for (let hops = 0; r?.merged_into && hops < 5; hops++) r = byId.get(r.merged_into);
    return r;
  };

  const assigned = new Set<string>();
  const upserts: Record<string, unknown>[] = [];
  const notes: { id: string; notes: string }[] = [];
  const merges: { id: string; into: string }[] = [];
  const deletes: string[] = [];

  for (const c of result.contacts) {
    if (c.deleted) {
      const r = livePcid.get(c.providerContactId);
      if (r) deletes.push(r.id);
      continue;
    }
    const linked = [...new Set(c.linkIds.map(resolve).filter((r): r is ExistingRow => Boolean(r) && !assigned.has(r!.id)))];
    const byPcid = livePcid.get(c.providerContactId);
    const pcidRow = byPcid && !assigned.has(byPcid.id) ? byPcid : undefined;
    const primary = linked.find((r) => r.nvals > 0) ?? linked[0] ?? pcidRow;

    const id = primary?.id ?? crypto.randomUUID();
    for (const other of [...linked, pcidRow]) {
      if (!other || other.id === id || merges.some((m) => m.id === other.id)) continue;
      merges.push({ id: other.id, into: id });
    }
    assigned.add(id);

    const card = p.toCard(c.raw);
    notes.push({ id, notes: card.notes });
    upserts.push({
      id,
      pcid: c.providerContactId,
      etag: c.etag,
      name: card.displayName,
      sort: sortKeyFor(card),
      data: JSON.stringify(c.raw),
      stamped: c.linkIds.length === 1 && c.linkIds[0] === id ? 1 : 0,
    });
  }

  if (result.full) {
    for (const r of livePcid.values()) {
      if (!assigned.has(r.id) && !merges.some((m) => m.id === r.id) && !deletes.includes(r.id)) deletes.push(r.id);
    }
  }

  const stmts: D1PreparedStatement[] = [];
  if (merges.length) {
    const j = JSON.stringify(merges);
    // Carry the merged contact’s own fields over, without overwriting the survivor’s.
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO field_values (contact_id, field_id, user_id, value, updated_at)
           SELECT json_extract(j.value, '$.into'), fv.field_id, fv.user_id, fv.value, fv.updated_at
           FROM field_values fv JOIN json_each(?1) j ON fv.contact_id = json_extract(j.value, '$.id')`,
        )
        .bind(j),
      db
        .prepare(
          `UPDATE contacts SET
             merged_into = (SELECT json_extract(value, '$.into') FROM json_each(?1) WHERE json_extract(value, '$.id') = contacts.id),
             deleted_at = ?2, updated_at = ?2
           WHERE account_id = ?3 AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?1))`,
        )
        .bind(j, t, account.id),
      // Message history moves to the surviving contact too.
      db
        .prepare(
          `UPDATE interactions SET
             contact_id = (SELECT json_extract(value, '$.into') FROM json_each(?1) WHERE json_extract(value, '$.id') = interactions.contact_id)
           WHERE contact_id IN (SELECT json_extract(value, '$.id') FROM json_each(?1))`,
        )
        .bind(j),
      // So do relationships. One that now points from a contact to itself goes.
      ...(['a_id', 'b_id'] as const).map((col) =>
        db
          .prepare(
            `UPDATE relationships SET
               ${col} = (SELECT json_extract(value, '$.into') FROM json_each(?1) WHERE json_extract(value, '$.id') = relationships.${col})
             WHERE ${col} IN (SELECT json_extract(value, '$.id') FROM json_each(?1))`,
          )
          .bind(j),
      ),
      db.prepare('DELETE FROM relationships WHERE a_id = b_id AND user_id = ?1').bind(user.id),
    );
  }
  if (deletes.length) {
    stmts.push(
      db
        .prepare(`UPDATE contacts SET deleted_at = ?2, updated_at = ?2 WHERE account_id = ?3 AND id IN (SELECT value FROM json_each(?1))`)
        .bind(JSON.stringify(deletes), t, account.id),
    );
  }
  for (const chunk of chunkBySize(upserts, MAX_CHUNK_BYTES)) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO contacts (id, user_id, account_id, provider_contact_id, etag, display_name, sort_key,
             data_json, link_stamped, merged_into, deleted_at, updated_at, created_at)
           SELECT json_extract(value, '$.id'), ?2, ?3, json_extract(value, '$.pcid'), json_extract(value, '$.etag'),
             json_extract(value, '$.name'), json_extract(value, '$.sort'), json_extract(value, '$.data'),
             json_extract(value, '$.stamped'), NULL, NULL, ?4, ?4
           FROM json_each(?1) WHERE true
           ON CONFLICT(id) DO UPDATE SET
             provider_contact_id = excluded.provider_contact_id, etag = excluded.etag,
             display_name = excluded.display_name, sort_key = excluded.sort_key, data_json = excluded.data_json,
             link_stamped = excluded.link_stamped, merged_into = NULL, deleted_at = NULL, updated_at = excluded.updated_at`,
        )
        .bind(JSON.stringify(chunk), user.id, account.id, t),
    );
  }
  stmts.push(
    db
      .prepare('UPDATE accounts SET sync_token = ?2, groups_json = ?3, last_synced_at = ?4 WHERE id = ?1')
      .bind(account.id, result.syncToken, JSON.stringify(result.groups), t),
  );
  await db.batch(stmts);
  account.sync_token = result.syncToken;
  // Who the @-mentions in changed notes point to (notes edited in Google or on iPhone too).
  try {
    await rememberNotes(db, user.id, notes);
  } catch (e) {
    console.warn('mentions not recorded', e);
  }
  account.last_synced_at = t;

  // Retry: contacts that carry your own fields but whose link didn’t reach Google when saved.
  let linked = 0;
  {
    const pending = (
      await db
        .prepare(
          `SELECT c.* FROM contacts c
           WHERE c.account_id = ?1 AND c.link_stamped = 0 AND c.deleted_at IS NULL AND c.merged_into IS NULL AND c.archived_at IS NULL
             AND (EXISTS (SELECT 1 FROM field_values fv WHERE fv.contact_id = c.id)
                  OR EXISTS (SELECT 1 FROM interactions i WHERE i.contact_id = c.id)
                  OR EXISTS (SELECT 1 FROM relationships r WHERE r.a_id = c.id OR r.b_id = c.id))
           LIMIT ?2`,
        )
        .bind(account.id, STAMPS_PER_SYNC)
        .all<ContactRow>()
    ).results;
    for (const row of pending) {
      try {
        await stampLink(env, db, account, row);
        linked++;
      } catch (e) {
        console.warn('link stamp failed', row.id, e);
      }
    }
  }

  return { accountId: account.id, full: result.full, changed: upserts.length, removed: deletes.length, merged: merges.length, linked };
}

function chunkBySize<T>(items: T[], maxBytes: number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let size = 0;
  for (const item of items) {
    const n = JSON.stringify(item).length;
    if (cur.length && size + n > maxBytes) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(item);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

export interface RelationshipRow {
  id: string;
  a_id: string;
  b_id: string;
  kind: string;
  label: string | null;
  combined: number;
}

export function relationshipJson(r: RelationshipRow) {
  return { id: r.id, a: r.a_id, b: r.b_id, kind: r.kind, label: r.label ?? '', combined: Boolean(r.combined) };
}

/** Relationships between the user’s live contacts. */
export async function relationshipsFor(db: D1Database, userId: string) {
  const rows = (
    await db
      .prepare(
        `SELECT r.* FROM relationships r
         JOIN contacts ca ON ca.id = r.a_id AND ca.deleted_at IS NULL AND ca.merged_into IS NULL AND ca.archived_at IS NULL
         JOIN contacts cb ON cb.id = r.b_id AND cb.deleted_at IS NULL AND cb.merged_into IS NULL AND cb.archived_at IS NULL
         WHERE r.user_id = ?1 ORDER BY r.created_at`,
      )
      .bind(userId)
      .all<RelationshipRow>()
  ).results;
  return rows.map(relationshipJson);
}
