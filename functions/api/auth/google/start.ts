import type { Data, Env } from '../../../../lib/types';
import { HttpError, now, redirect } from '../../../../lib/http';
import { pkceChallenge, randomToken } from '../../../../lib/crypto';
import { authorizationUrl, GMAIL_SEND_SCOPE, googleConfigured } from '../../../../lib/providers/google';

// GET /api/auth/google/start                          sign in
// GET /api/auth/google/start?link=1                   add another Google account to the signed-in user
// GET /api/auth/google/start?purpose=gmail&account=ID allow Ligature to send email from that account
// GET /api/auth/google/start?app=1&challenge=…        sign in the iOS app (PKCE S256 challenge, base64url)
export const onRequestGet: PagesFunction<Env, string, Data> = async ({ request, env, data }) => {
  if (!googleConfigured(env)) throw new HttpError(500, 'Google sign-in isn’t configured on this server.', 'not_configured');
  const url = new URL(request.url);

  let purpose: 'signin' | 'link' | 'gmail' | 'app' = 'signin';
  let accountId: string | null = null;
  let appChallenge: string | null = null;
  if (url.searchParams.get('app') === '1') {
    appChallenge = url.searchParams.get('challenge') ?? '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(appChallenge)) throw new HttpError(400, 'Missing sign-in challenge from the app.');
    purpose = 'app';
  } else if (url.searchParams.get('purpose') === 'gmail') {
    if (!data.user) return redirect('/');
    accountId = url.searchParams.get('account') ?? '';
    const owned = await env.DB.prepare('SELECT 1 FROM accounts WHERE id = ?1 AND user_id = ?2').bind(accountId, data.user.id).first();
    if (!owned) return redirect(`/?auth_error=${encodeURIComponent('That account isn’t connected to Ligatures.')}`);
    purpose = 'gmail';
  } else if (url.searchParams.get('link') === '1' && data.user) {
    purpose = 'link';
  }

  const state = randomToken(24);
  const verifier = randomToken(48);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_states WHERE created_at < ?1').bind(now() - 15 * 60_000),
    env.DB
      .prepare(
        'INSERT INTO oauth_states (id, verifier, user_id, created_at, purpose, account_id, app_challenge) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
      )
      .bind(state, verifier, purpose === 'link' || purpose === 'gmail' ? data.user!.id : null, now(), purpose, accountId, appChallenge),
  ]);
  return redirect(
    authorizationUrl(
      env,
      `${url.origin}/api/auth/google/callback`,
      state,
      await pkceChallenge(verifier),
      purpose === 'gmail' ? [GMAIL_SEND_SCOPE] : [],
    ),
  );
};
