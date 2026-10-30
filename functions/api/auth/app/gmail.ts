import type { Data, Env } from '../../../../lib/types';
import { HttpError, json, now, readJson } from '../../../../lib/http';
import { pkceChallenge, randomToken } from '../../../../lib/crypto';
import { requireUser } from '../../../../lib/session';
import { authorizationUrl, GMAIL_SEND_SCOPE, googleConfigured } from '../../../../lib/providers/google';

// POST /api/auth/app/gmail  { accountId }  → { url }
// The iOS app can’t carry the web cookie into the sign-in browser, so it asks for the Google
// consent link here (signed in with its bearer token) and opens it. Google returns to the
// usual callback, which sends the browser back to the app: ligature://auth?gmail=connected.
export const onRequestPost: PagesFunction<Env, string, Data> = async ({ request, env, data }) => {
  const user = requireUser(data.user);
  if (!googleConfigured(env)) throw new HttpError(500, 'Google sign-in isn’t configured on this server.', 'not_configured');
  const { accountId } = await readJson<{ accountId?: unknown }>(request);
  const owned = await env.DB
    .prepare(`SELECT 1 FROM accounts WHERE id = ?1 AND user_id = ?2 AND provider = 'google'`)
    .bind(String(accountId ?? ''), user.id)
    .first();
  if (!owned) throw new HttpError(404, 'That account isn’t connected to Ligatures.');

  const state = randomToken(24);
  const verifier = randomToken(48);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_states WHERE created_at < ?1').bind(now() - 15 * 60_000),
    env.DB
      .prepare(
        `INSERT INTO oauth_states (id, verifier, user_id, created_at, purpose, account_id, app_challenge)
         VALUES (?1, ?2, ?3, ?4, 'gmail', ?5, 'app')`,
      )
      .bind(state, verifier, user.id, now(), String(accountId)),
  ]);
  const origin = new URL(request.url).origin;
  return json({
    url: authorizationUrl(env, `${origin}/api/auth/google/callback`, state, await pkceChallenge(verifier), [GMAIL_SEND_SCOPE]),
  });
};
