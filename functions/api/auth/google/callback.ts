import type { AccountRow, Data, Env } from '../../../../lib/types';
import { HttpError, now, redirect } from '../../../../lib/http';
import { encryptJson } from '../../../../lib/crypto';
import { exchangeCode, GMAIL_SEND_SCOPE } from '../../../../lib/providers/google';
import { createSession, createUser } from '../../../../lib/session';
import { randomToken, sha256Hex } from '../../../../lib/crypto';

/** Where the iOS app listens for the end of sign-in. */
export const APP_CALLBACK = 'ligature://auth';
const failWeb = (message: string) => redirect(`/?auth_error=${encodeURIComponent(message)}`);
const failApp = (message: string) => redirect(`${APP_CALLBACK}?error=${encodeURIComponent(message)}`);

export const onRequestGet: PagesFunction<Env, string, Data> = async ({ request, env }) => {
  const url = new URL(request.url);
  const db = env.DB;

  const stateId = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const state = await db.prepare('SELECT * FROM oauth_states WHERE id = ?1').bind(stateId).first<{
    id: string; verifier: string; user_id: string | null; created_at: number; purpose: string | null; account_id: string | null;
    app_challenge: string | null;
  }>();
  await db.prepare('DELETE FROM oauth_states WHERE id = ?1').bind(stateId).run();
  const purpose = state?.purpose ?? (state?.user_id ? 'link' : 'signin');
  // Gmail consent started from the iOS app goes back to the app too.
  const toApp = purpose === 'app' || (purpose === 'gmail' && state?.app_challenge === 'app');
  const fail = toApp ? failApp : failWeb;

  if (url.searchParams.get('error')) {
    return fail(purpose === 'gmail' ? 'Gmail wasn’t connected, so nothing was sent.' : 'Google sign-in was cancelled.');
  }
  if (!state || !code || now() - state.created_at > 15 * 60_000) return fail('That sign-in link expired. Try again.');

  try {
    const { accountId, credentials, scopes } = await exchangeCode(env, code, `${url.origin}/api/auth/google/callback`, state.verifier);
    const sealed = await encryptJson(env, credentials);
    const granted = scopes.join(' ');
    const existing = await db
      .prepare(`SELECT * FROM accounts WHERE provider = 'google' AND provider_account_id = ?1`)
      .bind(accountId)
      .first<AccountRow>();

    if (purpose === 'gmail') {
      if (!existing || existing.id !== state.account_id || existing.user_id !== state.user_id) {
        return fail('That was a different Google account from the one connected to Ligatures. Try again and choose the same account.');
      }
      if (!scopes.includes(GMAIL_SEND_SCOPE)) {
        return fail('Ligatures needs permission to send email. Try again and leave “Send email on your behalf” checked.');
      }
      await db.prepare('UPDATE accounts SET credentials_enc = ?2, scopes = ?3 WHERE id = ?1').bind(existing.id, sealed, granted).run();
      return redirect(toApp ? `${APP_CALLBACK}?gmail=connected` : '/?gmail=connected');
    }

    let userId: string;
    if (purpose === 'link') {
      // Adding an account to someone already signed in.
      if (existing && existing.user_id !== state.user_id) return fail('That Google account belongs to another Ligatures user.');
      userId = state.user_id!;
    } else if (existing) {
      userId = existing.user_id;
    } else {
      const mode = (env.ALLOW_SIGNUPS || 'first').toLowerCase();
      const anyUser = await db.prepare('SELECT 1 FROM users LIMIT 1').first();
      if (anyUser && mode !== 'open') return fail('This Ligatures server isn’t taking new sign-ups.');
      userId = await createUser(db, null);
    }

    // No name or email comes with the Contacts scope, so the account is labelled “Google”.
    if (existing) {
      await db.prepare('UPDATE accounts SET credentials_enc = ?2, scopes = ?3 WHERE id = ?1').bind(existing.id, sealed, granted).run();
    } else {
      await db
        .prepare(
          `INSERT INTO accounts (id, user_id, provider, provider_account_id, label, credentials_enc, scopes, created_at)
           VALUES (?1, ?2, 'google', ?3, 'Google', ?4, ?5, ?6)`,
        )
        .bind(crypto.randomUUID(), userId, accountId, sealed, granted, now())
        .run();
    }

    if (purpose === 'link') return redirect('/');
    if (purpose === 'app') {
      // Hand the app a short-lived one-time code; it proves it started this sign-in by
      // sending the verifier behind the challenge when it trades the code for a session.
      const code = randomToken(32);
      await db.batch([
        db.prepare('DELETE FROM app_codes WHERE created_at < ?1').bind(now() - 5 * 60_000),
        db
          .prepare('INSERT INTO app_codes (id, user_id, challenge, created_at) VALUES (?1, ?2, ?3, ?4)')
          .bind(await sha256Hex(code), userId, state.app_challenge ?? '', now()),
      ]);
      return redirect(`${APP_CALLBACK}?code=${encodeURIComponent(code)}`);
    }
    return redirect('/', { 'set-cookie': await createSession(db, request, userId) });
  } catch (e) {
    if (e instanceof HttpError) return fail(e.message);
    throw e;
  }
};
