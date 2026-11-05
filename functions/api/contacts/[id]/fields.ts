import type { Data, Env } from '../../../../lib/types';
import { HttpError, json, now, readJson } from '../../../../lib/http';
import { requireUser } from '../../../../lib/session';
import { loadContact, stampLink } from '../../../../lib/contacts';
import { contactPayload } from '../../../../lib/payload';
import { fieldSource, rememberMentions } from '../../../../lib/mentions';

// PUT /api/contacts/:id/fields  { values: { [fieldId]: string } }
// Your own fields. Stored only in Ligature’s database, never sent to Google.
export const onRequestPut: PagesFunction<Env, 'id', Data> = async ({ request, env, data, params }) => {
  const user = requireUser(data.user);
  const body = await readJson<{ values?: Record<string, unknown> }>(request);
  const values = body.values ?? {};
  let { row, account } = await loadContact(env.DB, user, String(params.id));

  const owned = new Set(
    (await env.DB.prepare('SELECT id FROM field_defs WHERE user_id = ?1').bind(user.id).all<{ id: string }>()).results.map((r) => r.id),
  );
  const t = now();
  const stmts: D1PreparedStatement[] = [];
  const texts: { source: string; text: string }[] = [];
  for (const [fieldId, raw] of Object.entries(values)) {
    if (!owned.has(fieldId)) throw new HttpError(400, 'Unknown field.');
    if (typeof raw !== 'string') throw new HttpError(400, 'Field values must be text.');
    const value = raw.slice(0, 20000);
    texts.push({ source: fieldSource(fieldId), text: value });
    stmts.push(
      value.trim()
        ? env.DB
            .prepare(
              `INSERT INTO field_values (contact_id, field_id, user_id, value, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
               ON CONFLICT(contact_id, field_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            )
            .bind(row.id, fieldId, user.id, value, t)
        : env.DB.prepare('DELETE FROM field_values WHERE contact_id = ?1 AND field_id = ?2').bind(row.id, fieldId),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  await rememberMentions(env.DB, user.id, row.id, texts);

  // First time this contact gets fields of its own: put our ID in Google’s hidden per-app data
  // so the link survives merges. If that fails, the next sync retries.
  let linkError: string | undefined;
  if (!row.link_stamped) {
    try {
      row = await stampLink(env, env.DB, account, row);
    } catch (e) {
      linkError = (e as Error).message;
    }
  }
  return json({ ...(await contactPayload(env.DB, user, row, account)), linkError });
};
