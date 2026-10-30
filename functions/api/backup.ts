import type { Data, Env } from '../../lib/types';
import { requireUser } from '../../lib/session';

// What a backup leaves out. Everything else is included automatically: any table with a
// user_id column, so data from new features is backed up without touching this file.
// Only add to these lists for things that are secret, short-lived or rebuildable.
const SKIP_TABLES = new Set([
  'users', // exported separately, below
  'sessions', // sign-in sessions
  'oauth_states', // half-finished sign-ins
  'app_codes', // one-time iPhone sign-in codes
  'geocodes', // a cache of OpenStreetMap lookups, shared and rebuildable
  'meta', // schema version and rate-limit locks
]);
const SKIP_COLUMNS = new Set(['user_id', 'credentials_enc', 'sync_token']);

const parse = (s: unknown) => {
  if (typeof s !== 'string' || !s) return s ?? null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

/** A row as JSON: secrets dropped, and *_json columns parsed (person_json → person). */
function clean(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (SKIP_COLUMNS.has(k)) continue;
    if (k.endsWith('_json')) out[k.slice(0, -5)] = parse(v);
    else out[k] = v;
  }
  return out;
}

// GET /api/backup → everything Ligature keeps for you, as one JSON file to download.
export const onRequestGet: PagesFunction<Env, string, Data> = async ({ env, data }) => {
  const user = requireUser(data.user);

  const tables = (
    await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`).all<{
      name: string;
    }>()
  ).results.map((t) => t.name).filter((t) => !SKIP_TABLES.has(t));

  const out: Record<string, unknown[]> = {};
  for (const table of tables) {
    const cols = (await env.DB.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>()).results.map((c) => c.name);
    if (!cols.includes('user_id')) continue;
    const rows = (await env.DB.prepare(`SELECT * FROM "${table}" WHERE user_id = ?1`).bind(user.id).all<Record<string, unknown>>()).results;
    out[table] = rows.map(clean);
  }

  const backup = {
    app: 'Ligatures',
    version: 2,
    exportedAt: new Date().toISOString(),
    user: { id: user.id, name: user.display_name, prefs: parse(user.prefs) },
    ...out,
  };

  const day = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(backup, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="ligature-backup-${day}.json"`,
      'cache-control': 'no-store',
    },
  });
};
