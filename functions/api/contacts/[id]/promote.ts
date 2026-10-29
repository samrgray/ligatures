import type { Data, Env, Group } from '../../../../lib/types';
import { HttpError, json, now } from '../../../../lib/http';
import { requireUser } from '../../../../lib/session';
import { provider } from '../../../../lib/providers';
import { loadContact, sortKeyFor } from '../../../../lib/contacts';
import { contactPayload } from '../../../../lib/payload';
import { carryOriginal } from '../../../../lib/photos';

// POST /api/contacts/:id/promote  → make a draft real: create it in Google (with its photo and
// lists), then keep syncing it like any other contact. Your fields and relationships stay.
export const onRequestPost: PagesFunction<Env, 'id', Data> = async ({ env, data, params }) => {
  const user = requireUser(data.user);
  const { row, account } = await loadContact(env.DB, user, String(params.id));
  if (!row.draft) throw new HttpError(400, 'This contact is already in Google.');
  if (row.archived_at) throw new HttpError(409, 'Restore this draft before adding it to Google.', 'archived');
  const p = provider(account.provider);
  const raw = JSON.parse(row.data_json ?? '{}');
  const card = p.toCard(raw);
  const photo = card.photoUrl.startsWith('data:') ? card.photoUrl.split(',')[1] ?? null : null;
  const existing = new Set((JSON.parse(account.groups_json ?? '[]') as Group[]).map((g) => g.id));
  const groups = card.groups.filter((g) => existing.has(g) && g !== 'contactGroups/myContacts');
  const pc = await p.restore({ env, db: env.DB, account }, raw, photo, row.id, groups);
  const fresh = p.toCard(pc.raw);
  const t = now();
  await env.DB
    .prepare(
      `UPDATE contacts SET provider_contact_id = ?2, etag = ?3, display_name = ?4, sort_key = ?5, data_json = ?6,
         link_stamped = 1, draft = 0, updated_at = ?7 WHERE id = ?1`,
    )
    .bind(row.id, pc.providerContactId, pc.etag, fresh.displayName, sortKeyFor(fresh), JSON.stringify(pc.raw), t)
    .run();
  await carryOriginal(env.DB, row.id, card.photoUrl, fresh.photoUrl);
  const saved = { ...row, provider_contact_id: pc.providerContactId, etag: pc.etag, data_json: JSON.stringify(pc.raw), draft: 0, link_stamped: 1 };
  return json(await contactPayload(env.DB, user, saved, account));
};
