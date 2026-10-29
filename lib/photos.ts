import { HttpError, now } from './http';

// Uncropped originals of photos cropped in Ligature, kept so the crop can be changed later.
// Each is tied to the photo its crop made (by a hash of that photo’s URL): if the contact’s
// photo changes anywhere else, the original no longer applies.

/** Where the photo sits in the original, as fractions of its width and height. */
export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MAX_ORIGINAL_BASE64 = 1_900_000; // D1 keeps up to 2 MB per value; the apps send at most 1600 px

async function photoKey(url: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Check a crop from a client: four fractions, inside the image. */
export function cleanCrop(v: unknown): Crop {
  const c = (v ?? {}) as Record<string, unknown>;
  const n = (k: string) => {
    const x = c[k];
    if (typeof x !== 'number' || !Number.isFinite(x) || x < -0.001 || x > 1.001) throw new HttpError(400, 'That crop isn’t valid.');
    return Math.min(1, Math.max(0, x));
  };
  const crop = { x: n('x'), y: n('y'), w: n('w'), h: n('h') };
  if (crop.w <= 0 || crop.h <= 0) throw new HttpError(400, 'That crop isn’t valid.');
  return crop;
}

/** Check an image from a client: base64 (a data URL is fine), not too large. */
export function cleanImage(v: unknown, max: number): string {
  if (typeof v !== 'string' || !v) throw new HttpError(400, 'No image.');
  const image = v.replace(/^data:image\/[\w+.-]+;base64,/, '');
  if (image.length > max || !/^[A-Za-z0-9+/]+=*$/.test(image)) throw new HttpError(400, 'That image is too large or not readable.');
  return image;
}

export async function saveOriginal(db: D1Database, userId: string, contactId: string, image: string, crop: Crop, photoUrl: string) {
  await db
    .prepare(
      `INSERT INTO photo_originals (contact_id, user_id, image, crop_json, photo_key, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(contact_id) DO UPDATE SET image = excluded.image, crop_json = excluded.crop_json,
         photo_key = excluded.photo_key, updated_at = excluded.updated_at`,
    )
    .bind(contactId, userId, image, JSON.stringify(crop), await photoKey(photoUrl), now())
    .run();
}

export async function deleteOriginal(db: D1Database, contactId: string) {
  await db.prepare('DELETE FROM photo_originals WHERE contact_id = ?1').bind(contactId).run();
}

/** The original behind the contact’s current photo, if there is one. A stale one is dropped. */
export async function currentOriginal(db: D1Database, contactId: string, photoUrl: string): Promise<{ image: string; crop: Crop } | null> {
  const r = await db
    .prepare('SELECT image, crop_json, photo_key FROM photo_originals WHERE contact_id = ?1')
    .bind(contactId)
    .first<{ image: string; crop_json: string; photo_key: string }>();
  if (!r) return null;
  if (!photoUrl || r.photo_key !== (await photoKey(photoUrl))) {
    await deleteOriginal(db, contactId);
    return null;
  }
  return { image: r.image, crop: JSON.parse(r.crop_json) };
}

/**
 * The same photo moved somewhere new (a draft added to Google, a contact made a draft or
 * restored from the archive): keep its original with it.
 */
export async function carryOriginal(db: D1Database, contactId: string, before: string, after: string) {
  if (!before || !after || before === after) return;
  await db
    .prepare('UPDATE photo_originals SET photo_key = ?3 WHERE contact_id = ?1 AND photo_key = ?2')
    .bind(contactId, await photoKey(before), await photoKey(after))
    .run();
}
