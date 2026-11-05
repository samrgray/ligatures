import type { AccountRow, Card, CardEdit, ContactRow, Labeled, UserRow } from './types';
import { provider } from './providers';
import { HttpError } from './http';
import { mentionsOf } from './mentions';

export interface FieldInfo {
  label: string;
  type: string;
  accountId: string | null;
  listId: string | null;
}

/** Your field definitions, for search: types, and which list (if any) each belongs to. */
export async function fieldDefsFor(db: D1Database, userId: string): Promise<Map<string, FieldInfo>> {
  const rows = (
    await db
      .prepare(`SELECT id, label, type, account_id AS accountId, list_id AS listId FROM field_defs WHERE user_id = ?1`)
      .bind(userId)
      .all<FieldInfo & { id: string }>()
  ).results;
  return new Map(rows.map(({ id, ...f }) => [id, f]));
}

/**
 * Everything about a contact that search looks through: every Google field and your fields
 * that are on them (not a list’s fields they’re no longer on). Phone numbers are also there as
 * bare digits, so “5550188” finds “(503) 555-0188”. Ticked checkboxes match by their name.
 */
export function searchText(card: Card, fields: Record<string, string>, defs: Map<string, FieldInfo>, accountId: string, groups = card.groups): string {
  const labeled = (list: Labeled[]) => list.flatMap((l) => [l.value, l.label]);
  const own = Object.entries(fields).map(([id, v]) => {
    const f = defs.get(id);
    if (!f) return '';
    if (f.listId && (f.accountId !== accountId || !groups.includes(f.listId))) return '';
    if (f.type === 'checkbox') return v === '1' ? f.label : '';
    return v;
  });
  return [
    card.givenName, card.familyName, card.displayName, card.organization, card.title,
    ...labeled(card.phones), ...card.phones.map((p) => p.value.replace(/\D/g, '')),
    ...labeled(card.emails), ...labeled(card.urls), ...labeled(card.relations), ...labeled(card.events),
    ...card.addresses.flatMap((a) => [a.value, a.label]),
    card.birthday, card.notes,
    ...own,
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export async function contactPayload(db: D1Database, user: UserRow, row: ContactRow, account: AccountRow) {
  const p = provider(account.provider);
  const values = (
    await db.prepare('SELECT field_id, value, updated_at FROM field_values WHERE contact_id = ?1').bind(row.id).all<{
      field_id: string; value: string; updated_at: number;
    }>()
  ).results;
  const card = p.toCard(JSON.parse(row.data_json ?? '{}'));
  let archived: { at: number; groups: string[] } | undefined;
  if (row.archived_at) {
    // Archived: Google no longer has them, so the photo and lists come from the archive.
    const a = await db
      .prepare('SELECT photo, groups_json, archived_at FROM archives WHERE contact_id = ?1')
      .bind(row.id)
      .first<{ photo: string | null; groups_json: string; archived_at: number }>();
    card.photoUrl = a?.photo ? `data:image/jpeg;base64,${a.photo}` : '';
    card.groups = JSON.parse(a?.groups_json ?? '[]');
    archived = { at: a?.archived_at ?? row.archived_at, groups: card.groups };
  }
  const fields: Record<string, string> = Object.fromEntries(values.map((v) => [v.field_id, v.value]));
  return {
    id: row.id,
    etag: row.etag,
    archived,
    // Only in Ligature, not in Google (until it’s added).
    draft: Boolean(row.draft),
    card,
    fields,
    search: searchText(card, fields, await fieldDefsFor(db, user.id), account.id),
    linked: Boolean(row.link_stamped),
    account: { id: account.id, provider: account.provider, providerName: p.name, label: account.label },
    syncedAt: row.updated_at,
    // Who the @-mentions in the notes and fields point to (the links survive renames).
    mentions: await mentionsOf(db, row.id),
  };
}

const str = (v: unknown, max = 2000) => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new HttpError(400, 'Expected text.');
  return v.slice(0, max);
};
const list = (v: unknown): Labeled[] | undefined => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 50) throw new HttpError(400, 'Expected a list.');
  return v.map((i) => ({ value: str(i?.value, 500) ?? '', label: str(i?.label, 60) ?? '' }));
};

const addresses = (v: unknown) => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 20) throw new HttpError(400, 'Expected a list of addresses.');
  return v.map((i) => ({
    label: str(i?.label, 60) ?? '',
    street: str(i?.street, 500) ?? '',
    city: str(i?.city, 200) ?? '',
    region: str(i?.region, 200) ?? '',
    postalCode: str(i?.postalCode, 40) ?? '',
    country: str(i?.country, 200) ?? '',
  }));
};

export function cleanEdit(e: unknown): CardEdit {
  const x = (e ?? {}) as Record<string, unknown>;
  return {
    givenName: str(x.givenName, 200),
    familyName: str(x.familyName, 200),
    organization: str(x.organization, 200),
    title: str(x.title, 200),
    phones: list(x.phones),
    emails: list(x.emails),
    urls: list(x.urls),
    addresses: addresses(x.addresses),
    groups: Array.isArray(x.groups) ? x.groups.filter((g): g is string => typeof g === 'string').slice(0, 20) : undefined,
    notes: str(x.notes, 20000),
  };
}
