import type { Data, Env } from '../../../../lib/types';
import { HttpError, json, now, readJson } from '../../../../lib/http';
import { requireUser } from '../../../../lib/session';
import { provider } from '../../../../lib/providers';
import { cached, loadContact, sortKeyFor } from '../../../../lib/contacts';
import { contactPayload } from '../../../../lib/payload';
import { carryOriginal } from '../../../../lib/photos';

// POST /api/contacts/:id/demote  { etag }  → turn a real contact into a draft: keep everything
// Google has (fields, photo, lists) here, then delete it from Google. Your fields and
// relationships stay. Only if it hasn’t changed since you opened it.
export const onRequestPost: PagesFunction<Env, 'id', Data> = async ({ request, env, data, params }) => {
  const user = requireUser(data.user);
  const body = await readJson<{ etag?: unknown }>(request);
  const { row, account } = await loadContact(env.DB, user, String(params.id));
  if (row.draft) throw new HttpError(400, 'This contact is already a draft.');
  if (row.archived_at) throw new HttpError(409, 'This contact is archived. Restore it first.', 'archived');
  const conflict = () => {
    throw new HttpError(409, 'This contact changed in Google since you opened it. Reload and try again.', 'conflict');
  };
  if (typeof body.etag !== 'string' || body.etag !== row.etag) conflict();
  const p = provider(account.provider);
  const ctx = { env, db: env.DB, account };

  // 1. Keep everything first: every field Google has, and the photo itself.
  const snap = await p.snapshot(ctx, row.provider_contact_id);
  const raw = p.setDraftPhoto(snap.raw, snap.photo);
  // 2. Then delete it from Google, but only the copy we just kept.
  const result = await p.deleteContacts(ctx, [cached(row)]);
  if (!result.deleted.length && !result.gone.length) conflict();

  const card = p.toCard(raw);
  const t = now();
  const draftId = `draft:${row.id}`;
  const etag = crypto.randomUUID();
  await env.DB
    .prepare(
      `UPDATE contacts SET provider_contact_id = ?2, etag = ?3, display_name = ?4, sort_key = ?5, data_json = ?6,
         link_stamped = 1, draft = 1, updated_at = ?7 WHERE id = ?1`,
    )
    .bind(row.id, draftId, etag, card.displayName, sortKeyFor(card), JSON.stringify(raw), t)
    .run();
  await carryOriginal(env.DB, row.id, p.toCard(JSON.parse(row.data_json ?? '{}')).photoUrl, card.photoUrl);
  const saved = { ...row, provider_contact_id: draftId, etag, data_json: JSON.stringify(raw), draft: 1, link_stamped: 1 };
  return json(await contactPayload(env.DB, user, saved, account));
};
