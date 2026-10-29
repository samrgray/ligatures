import type { Data, Env } from '../../../../../lib/types';
import { HttpError, json } from '../../../../../lib/http';
import { requireUser } from '../../../../../lib/session';
import { provider } from '../../../../../lib/providers';
import { loadContact } from '../../../../../lib/contacts';
import { currentOriginal } from '../../../../../lib/photos';

// GET /api/contacts/:id/photo/original  → { image, crop }: what to crop the photo from.
// The uncropped original and its crop when the photo was cropped in Ligature; otherwise the
// photo itself at the largest size the provider has, with no crop yet.
export const onRequestGet: PagesFunction<Env, 'id', Data> = async ({ env, data, params }) => {
  const user = requireUser(data.user);
  const { row, account } = await loadContact(env.DB, user, String(params.id));
  const p = provider(account.provider);
  const raw = JSON.parse(row.data_json ?? '{}');
  const photoUrl = p.toCard(raw).photoUrl;
  if (!photoUrl) throw new HttpError(404, 'This contact has no photo.', 'no_photo');
  const kept = await currentOriginal(env.DB, row.id, photoUrl);
  if (kept) return json({ image: `data:image/jpeg;base64,${kept.image}`, crop: kept.crop });
  const photo = await p.photo(raw, 1600).catch(() => null);
  if (!photo) throw new HttpError(502, 'Couldn’t load the photo. Try again.', 'photo_unavailable');
  return json({ image: `data:${photo.type};base64,${photo.base64}`, crop: null });
};
