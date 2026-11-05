import type { AccountRow, Address, CardEdit, ContactRow, Data, Env } from '../../../lib/types';
import { HttpError, json, now, readJson } from '../../../lib/http';
import { requireUser } from '../../../lib/session';
import { provider } from '../../../lib/providers';
import { relationshipsFor, sortKeyFor } from '../../../lib/contacts';
import { fieldDefsFor, cleanEdit, contactPayload, searchText } from '../../../lib/payload';

/**
 * The first address as a street, a “City, ST 12345” line and a country, and whether it’s the one
 * the Neighborhood field belongs to (the home address, or the only one).
 */
function addressParts(list: Address[]) {
  const a = list[0];
  if (!a || !(a.city || a.region || a.postalCode || a.country)) return null;
  const home = list.findIndex((x) => x.label.trim().toLowerCase() === 'home');
  return {
    street: a.street.replace(/\s*\n\s*/g, ', ').trim(),
    city: a.city.trim(),
    rest: [a.region.trim(), a.postalCode.trim()].filter(Boolean).join(' '),
    country: a.country.trim(),
    hood: home <= 0,
  };
}

/** Ligatures sees new contacts within an hour of connecting as already there before it. */
const FIRST_SYNC = 60 * 60 * 1000;

/**
 * When a contact was created and last modified, as ISO times ('' if unknown). Providers may not
 * say when a contact was made, so “created” is when Ligatures first saw it, left blank for
 * everyone already there when the account was connected. “Modified” is the latest of the
 * provider’s own time and your fields.
 */
function dates(r: { created_at: number; updated_at: number; account_created: number; fields_at: number | null; draft: number }, provider?: string) {
  const iso = (t: number) => (t > 0 ? new Date(t).toISOString() : '');
  const known = r.draft || r.created_at > r.account_created + FIRST_SYNC;
  const mod = Math.max(Date.parse(provider || '') || 0, r.fields_at ?? 0, r.draft ? r.updated_at : 0);
  return { created: known ? iso(r.created_at) : '', modified: iso(mod) };
}

// GET /api/contacts  → one row per contact for the table: the columns it can show, plus
// your own fields and when you last messaged them.
export const onRequestGet: PagesFunction<Env, string, Data> = async ({ env, data }) => {
  const user = requireUser(data.user);
  const rows = (
    await env.DB
      .prepare(
        `SELECT c.id, c.account_id, c.data_json, c.draft, a.provider, c.created_at, c.updated_at, a.created_at AS account_created,
           (SELECT json_group_object(fv.field_id, fv.value) FROM field_values fv WHERE fv.contact_id = c.id) AS fields_json,
           (SELECT MAX(fv.updated_at) FROM field_values fv WHERE fv.contact_id = c.id) AS fields_at
         FROM contacts c JOIN accounts a ON a.id = c.account_id
         WHERE c.user_id = ?1 AND c.deleted_at IS NULL AND c.merged_into IS NULL AND c.archived_at IS NULL
         ORDER BY c.sort_key`,
      )
      .bind(user.id)
      .all<{
        id: string; account_id: string; data_json: string; draft: number; provider: string; fields_json: string | null;
        created_at: number; updated_at: number; account_created: number; fields_at: number | null;
      }>()
  ).results;
  const defs = await fieldDefsFor(env.DB, user.id);

  return json({
    relationships: await relationshipsFor(env.DB, user.id),
    contacts: rows.map((r) => {
      const card = provider(r.provider).toCard(JSON.parse(r.data_json));
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
        // The parts, so the table can put the neighborhood in front of the city.
        addressParts: addressParts(card.addresses),
        birthday: card.birthday,
        birthdayKey: card.birthdayKey,
        notes: card.notes.slice(0, 300),
        photoUrl: card.photoUrl,
        search: searchText(card, fields, defs, r.account_id),
        groups: card.groups,
        fields,
        ...dates(r, card.modifiedAt),
        ...(r.draft ? { draft: true } : {}),
      };
    }),
  });
};

// POST /api/contacts  { accountId, edit }  → create in the provider.
export const onRequestPost: PagesFunction<Env, string, Data> = async ({ request, env, data }) => {
  const user = requireUser(data.user);
  const body = await readJson<{ accountId?: string; edit?: CardEdit; draft?: boolean }>(request);
  const account = await env.DB
    .prepare('SELECT * FROM accounts WHERE id = ?1 AND user_id = ?2')
    .bind(body.accountId ?? '', user.id)
    .first<AccountRow>();
  if (!account) throw new HttpError(400, 'Choose an account for the new contact.');
  const edit = cleanEdit(body.edit);
  // Only lists that exist in this account (the one you were viewing, usually).
  const lists = new Set((JSON.parse(account.groups_json ?? '[]') as { id: string }[]).map((g) => g.id));
  edit.groups = edit.groups?.filter((g) => lists.has(g) && g !== 'contactGroups/myContacts');
  if (!edit.givenName && !edit.familyName && !edit.organization) throw new HttpError(400, 'Add a name or a company.');

  const p = provider(account.provider);
  const id = crypto.randomUUID();
  // A draft stays in Ligature: the same fields, in Google’s shape, but nothing sent to Google.
  const pc = body.draft
    ? { providerContactId: `draft:${id}`, etag: crypto.randomUUID(), deleted: false, linkIds: [id], raw: p.draftRaw(edit) }
    : await p.create({ env, db: env.DB, account }, edit, id);
  const card = p.toCard(pc.raw);
  const t = now();
  const row: ContactRow = {
    id,
    user_id: user.id,
    account_id: account.id,
    provider_contact_id: pc.providerContactId,
    etag: pc.etag,
    display_name: card.displayName,
    sort_key: sortKeyFor(card),
    data_json: JSON.stringify(pc.raw),
    link_stamped: pc.linkIds.includes(id) ? 1 : 0,
    merged_into: null,
    deleted_at: null,
    updated_at: t,
    created_at: t,
    draft: body.draft ? 1 : 0,
  };
  await env.DB
    .prepare(
      `INSERT INTO contacts (id, user_id, account_id, provider_contact_id, etag, display_name, sort_key, data_json,
         link_stamped, merged_into, deleted_at, updated_at, created_at, draft)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, NULL, ?10, ?10, ?11)`,
    )
    .bind(row.id, row.user_id, row.account_id, row.provider_contact_id, row.etag, row.display_name, row.sort_key, row.data_json, row.link_stamped, t, body.draft ? 1 : 0)
    .run();
  return json(await contactPayload(env.DB, user, row, account), 201);
};
