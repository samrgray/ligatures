import type { Data, Env } from '../../../../lib/types';
import { HttpError, json, readJson } from '../../../../lib/http';
import { requireUser } from '../../../../lib/session';
import { provider } from '../../../../lib/providers';
import { cached, loadContact, saveDraft, saveFromProvider } from '../../../../lib/contacts';
import { cleanEdit, contactPayload } from '../../../../lib/payload';
import { NOTES, fixMentions, rememberMentions } from '../../../../lib/mentions';
import type { ContactRow, UserRow } from '../../../../lib/types';

/** After an edit: remember who the notes mention, and if they were renamed, update mentions of them. */
async function afterEdit(env: Env, user: UserRow, before: ContactRow, saved: ContactRow, notes: string | undefined, waitUntil: (p: Promise<unknown>) => void) {
  if (notes !== undefined) await rememberMentions(env.DB, user.id, saved.id, [{ source: NOTES, text: notes }]);
  if (before.display_name !== saved.display_name) waitUntil(fixMentions(env, user).catch((e) => console.warn('mention renames failed', e)));
}

// GET /api/contacts/:id
export const onRequestGet: PagesFunction<Env, 'id', Data> = async ({ env, data, params }) => {
  const user = requireUser(data.user);
  const { row, account } = await loadContact(env.DB, user, String(params.id));
  return json(await contactPayload(env.DB, user, row, account));
};

// PATCH /api/contacts/:id  { etag, edit }  → write Google fields. The etag the user saw goes
// to Google with the write; if anything changed since, Google rejects it and we reload.
export const onRequestPatch: PagesFunction<Env, 'id', Data> = async ({ request, env, data, params, waitUntil }) => {
  const user = requireUser(data.user);
  const body = await readJson<{ etag?: string; edit?: unknown }>(request);
  if (!body.etag) throw new HttpError(400, 'Missing etag.');
  const { row, account } = await loadContact(env.DB, user, String(params.id));
  if (row.archived_at) throw new HttpError(409, 'This contact is archived. Restore it to edit it.', 'archived');
  const p = provider(account.provider);
  const ctx = { env, db: env.DB, account };

  // A draft is only here: check it’s the copy you saw, then save it.
  if (row.draft) {
    if (body.etag !== row.etag) {
      throw new HttpError(409, 'This draft changed since you opened it. It’s been reloaded; make your edit again.', 'conflict', {
        contact: await contactPayload(env.DB, user, row, account),
      });
    }
    const edit = cleanEdit(body.edit);
    const saved = await saveDraft(env.DB, row, p.editDraft(JSON.parse(row.data_json ?? '{}'), edit), account.provider);
    await afterEdit(env, user, row, saved, edit.notes, waitUntil);
    return json(await contactPayload(env.DB, user, saved, account));
  }

  const conflict = async () => {
    const fresh = await saveFromProvider(env.DB, row, await p.get(ctx, row.provider_contact_id), account.provider);
    throw new HttpError(409, 'This contact changed in Google since you opened it. It’s been reloaded; make your edit again.', 'conflict', {
      contact: await contactPayload(env.DB, user, fresh, account),
    });
  };

  // The browser’s copy is older than ours: someone else already moved it on.
  if (body.etag !== row.etag) await conflict();

  try {
    const edit = cleanEdit(body.edit);
    const updated = await p.update(ctx, { ...cached(row), etag: body.etag }, edit);
    const saved = await saveFromProvider(env.DB, row, updated, account.provider);
    await afterEdit(env, user, row, saved, edit.notes, waitUntil);
    return json(await contactPayload(env.DB, user, saved, account));
  } catch (e) {
    if (e instanceof HttpError && e.code === 'conflict') await conflict();
    throw e;
  }
};
