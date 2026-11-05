import type { Data, Env } from '../../lib/types';
import { json } from '../../lib/http';
import { requireUser } from '../../lib/session';
import { accountsFor, syncAccount, type SyncSummary } from '../../lib/contacts';
import { fixMentions } from '../../lib/mentions';

// POST /api/sync  → pull changes from every connected account.
export const onRequestPost: PagesFunction<Env, string, Data> = async ({ env, data }) => {
  const user = requireUser(data.user);
  const results: (SyncSummary | { accountId: string; error: string; code?: string })[] = [];
  for (const account of await accountsFor(env.DB, user.id)) {
    try {
      results.push(await syncAccount(env, env.DB, user, account));
    } catch (e) {
      const err = e as { message?: string; code?: string };
      results.push({ accountId: account.id, error: err.message ?? 'Sync failed', code: err.code });
    }
  }
  // Someone renamed: their @-mentions elsewhere follow. (Picked up by the next sync.)
  try {
    await fixMentions(env, user);
  } catch (e) {
    console.warn('mention renames failed', e);
  }
  return json({ results });
};
