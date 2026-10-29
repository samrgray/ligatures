import type { Data, Env } from '../../../../lib/types';
import { HttpError, json, readJson } from '../../../../lib/http';
import { requireUser } from '../../../../lib/session';
import { provider } from '../../../../lib/providers';
import { cached, loadContact, saveDraft, saveFromProvider } from '../../../../lib/contacts';
import { contactPayload } from '../../../../lib/payload';
import { MAX_ORIGINAL_BASE64, cleanCrop, cleanImage, deleteOriginal, saveOriginal } from '../../../../lib/photos';

const MAX_BASE64 = 2_000_000; // about 1.5 MB of image; the apps send a 512 px JPEG

type Ctx = Parameters<PagesFunction<Env, 'id', Data>>[0];

/**
 * Google’s photo endpoints don’t take an etag, so first make sure the contact is the one
 * you saw: our copy must match your etag, and Google’s current copy must match ours.
 * If either has moved on, reload and ask you to try again rather than overwrite.
 */
async function prepare(ctx: Ctx, etag: unknown) {
  const user = requireUser(ctx.data.user);
  if (typeof etag !== 'string' || !etag) throw new HttpError(400, 'Missing etag.');
  const { row, account } = await loadContact(ctx.env.DB, user, String(ctx.params.id));
  if (row.archived_at) throw new HttpError(409, 'This contact is archived. Restore it to edit it.', 'archived');
  const p = provider(account.provider);
  const pctx = { env: ctx.env, db: ctx.env.DB, account };
  const conflict = async (fresh = row) => {
    throw new HttpError(409, 'This contact changed in Google since you opened it. It’s been reloaded; change the photo again.', 'conflict', {
      contact: await contactPayload(ctx.env.DB, user, fresh, account),
    });
  };
  if (etag !== row.etag) await conflict();
  if (row.draft) return { user, row, account, p, pctx, draft: true };
  const current = await p.get(pctx, row.provider_contact_id);
  if (current.etag !== row.etag) await conflict(await saveFromProvider(ctx.env.DB, row, current, account.provider));
  return { user, row, account, p, pctx, draft: false };
}

// PUT /api/contacts/:id/photo  { etag, image, original?, crop? }  → set the photo in Google
// (JPEG, base64). With the uncropped original and where the photo sits in it, Ligature keeps
// those so the crop can be changed later; they never go to Google.
export const onRequestPut: PagesFunction<Env, 'id', Data> = async (ctx) => {
  const body = await readJson<{ etag?: unknown; image?: unknown; original?: unknown; crop?: unknown }>(ctx.request);
  const image = cleanImage(body.image, MAX_BASE64);
  const original = body.original == null ? null : { image: cleanImage(body.original, MAX_ORIGINAL_BASE64), crop: cleanCrop(body.crop) };
  const { user, row, account, p, pctx, draft } = await prepare(ctx, body.etag);
  const saved = draft
    ? await saveDraft(ctx.env.DB, row, p.setDraftPhoto(JSON.parse(row.data_json ?? '{}'), image), account.provider)
    : await saveFromProvider(ctx.env.DB, row, await p.setPhoto(pctx, cached(row), image), account.provider);
  const photoUrl = p.toCard(JSON.parse(saved.data_json ?? '{}')).photoUrl;
  if (original && photoUrl) await saveOriginal(ctx.env.DB, user.id, row.id, original.image, original.crop, photoUrl);
  else await deleteOriginal(ctx.env.DB, row.id);
  return json(await contactPayload(ctx.env.DB, user, saved, account));
};

// DELETE /api/contacts/:id/photo?etag=…  → remove the photo in Google.
export const onRequestDelete: PagesFunction<Env, 'id', Data> = async (ctx) => {
  const { user, row, account, p, pctx, draft } = await prepare(ctx, new URL(ctx.request.url).searchParams.get('etag'));
  const saved = draft
    ? await saveDraft(ctx.env.DB, row, p.setDraftPhoto(JSON.parse(row.data_json ?? '{}'), null), account.provider)
    : await saveFromProvider(ctx.env.DB, row, await p.deletePhoto(pctx, cached(row)), account.provider);
  await deleteOriginal(ctx.env.DB, row.id);
  return json(await contactPayload(ctx.env.DB, user, saved, account));
};
