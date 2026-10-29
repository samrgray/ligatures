// The app migrates its own D1 database on first request, so a fresh deploy
// (Cloudflare Git deploy or self-hosted) needs no manual migration step.
// Append new migrations; never edit old ones.
// Backups (functions/api/backup.ts) include every table with a user_id column, so give new
// tables of your data one; anything secret or disposable goes in that file’s skip lists.

const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      read_only INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
    `CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_account_id TEXT NOT NULL,
      label TEXT,
      credentials_enc TEXT,
      sync_token TEXT,
      groups_json TEXT,
      last_synced_at INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE (provider, provider_account_id)
    )`,
    `CREATE INDEX IF NOT EXISTS accounts_user ON accounts(user_id)`,
    `CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      provider_contact_id TEXT NOT NULL,
      etag TEXT,
      display_name TEXT,
      sort_key TEXT,
      data_json TEXT,
      link_stamped INTEGER NOT NULL DEFAULT 0,
      merged_into TEXT,
      deleted_at INTEGER,
      updated_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS contacts_live_pcid ON contacts(account_id, provider_contact_id)
      WHERE deleted_at IS NULL AND merged_into IS NULL`,
    `CREATE INDEX IF NOT EXISTS contacts_user_sort ON contacts(user_id, sort_key)`,
    `CREATE TABLE IF NOT EXISTS field_defs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text',
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS field_defs_user ON field_defs(user_id, position)`,
    `CREATE TABLE IF NOT EXISTS field_values (
      contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      field_id TEXT NOT NULL REFERENCES field_defs(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (contact_id, field_id)
    )`,
    `CREATE INDEX IF NOT EXISTS field_values_user ON field_values(user_id)`,
    `CREATE TABLE IF NOT EXISTS oauth_states (
      id TEXT PRIMARY KEY,
      verifier TEXT NOT NULL,
      user_id TEXT,
      created_at INTEGER NOT NULL
    )`,
  ],
  [
    // Messaging: which scopes each account granted (Gmail sending is opt-in), what an OAuth
    // round trip is for, and a log of messages sent to each contact.
    `ALTER TABLE accounts ADD COLUMN scopes TEXT`,
    `ALTER TABLE oauth_states ADD COLUMN purpose TEXT`,
    `ALTER TABLE oauth_states ADD COLUMN account_id TEXT`,
    `CREATE TABLE IF NOT EXISTS interactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      channel TEXT NOT NULL,
      mode TEXT NOT NULL,
      subject TEXT,
      body TEXT,
      occurred_at INTEGER NOT NULL,
      batch_id TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS interactions_contact ON interactions(contact_id, occurred_at)`,
  ],
  [
    // Per-user display settings: table columns, widths and sort.
    `ALTER TABLE users ADD COLUMN prefs TEXT`,
  ],
  [
    // “Last talked” is gone: nobody keeps it up by hand, and Ligature only saw its own messages.
    // (The old message log stays in the interactions table, unused.)
    `DELETE FROM field_values WHERE field_id IN (SELECT id FROM field_defs WHERE label = 'Last talked' AND type = 'date')`,
    `DELETE FROM field_defs WHERE label = 'Last talked' AND type = 'date'`,
  ],
  [
    // The iOS app: sign-in hands it a one-time code (bound to the app’s PKCE challenge),
    // which it trades for a session token sent as a bearer header.
    `ALTER TABLE oauth_states ADD COLUMN app_challenge TEXT`,
    `CREATE TABLE IF NOT EXISTS app_codes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      challenge TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  ],
  [
    // Relationships between your contacts, kept only in Ligature. For one-way kinds (parent,
    // manager), a is the parent or manager. `combined` shows the people as one entry in the list.
    `CREATE TABLE IF NOT EXISTS relationships (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      a_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      b_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      label TEXT,
      combined INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS relationships_user ON relationships(user_id)`,
  ],
  [
    // Built-in fields have a key: Neighborhood places people without a street address on the map.
    `ALTER TABLE field_defs ADD COLUMN key TEXT`,
    `INSERT INTO field_defs (id, user_id, label, type, position, created_at, key)
       SELECT lower(hex(randomblob(16))), u.id, 'Neighborhood', 'text',
         (SELECT COALESCE(MAX(position), -1) + 1 FROM field_defs f WHERE f.user_id = u.id), CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'neighborhood'
       FROM users u WHERE NOT EXISTS (SELECT 1 FROM field_defs f WHERE f.user_id = u.id AND f.key = 'neighborhood')`,
    // Places looked up on OpenStreetMap, so each address is only looked up once.
    `CREATE TABLE IF NOT EXISTS geocodes (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      query TEXT NOT NULL,
      status TEXT NOT NULL,
      lat REAL,
      lng REAL,
      place TEXT,
      tried_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, query)
    )`,
  ],
  [
    // Your own pins on the map: places you searched for and labelled.
    `CREATE TABLE IF NOT EXISTS pins (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      address TEXT,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS pins_user ON pins(user_id)`,
  ],
  [
    // The archive: contacts taken out of Google but kept whole in Ligature, to restore later.
    // The contacts row stays (with your fields and relationships); archives holds everything
    // Google had, the lists they were on, and their photo.
    `ALTER TABLE contacts ADD COLUMN archived_at INTEGER`,
    `CREATE TABLE IF NOT EXISTS archives (
      contact_id TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      person_json TEXT NOT NULL,
      groups_json TEXT NOT NULL,
      photo TEXT,
      archived_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS archives_user ON archives(user_id)`,
  ],
  [
    // Built-in “On Signal” checkbox: puts a Signal button on the contact.
    `INSERT INTO field_defs (id, user_id, label, type, position, created_at, key)
       SELECT lower(hex(randomblob(16))), u.id, 'On Signal', 'checkbox',
         (SELECT COALESCE(MAX(position), -1) + 1 FROM field_defs f WHERE f.user_id = u.id), CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'signal'
       FROM users u WHERE NOT EXISTS (SELECT 1 FROM field_defs f WHERE f.user_id = u.id AND f.key = 'signal')`,
  ],
  [
    // Built-in “Signal username”: when filled in, the Signal button uses it instead of the phone number.
    `INSERT INTO field_defs (id, user_id, label, type, position, created_at, key)
       SELECT lower(hex(randomblob(16))), u.id, 'Signal username', 'text',
         (SELECT COALESCE(MAX(position), -1) + 1 FROM field_defs f WHERE f.user_id = u.id), CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'signal_username'
       FROM users u WHERE NOT EXISTS (SELECT 1 FROM field_defs f WHERE f.user_id = u.id AND f.key = 'signal_username')`,
  ],
  [
    // List-specific fields: shown only on people in that list (and as columns when you view it).
    // list_name keeps the list’s name for when the list itself is deleted.
    `ALTER TABLE field_defs ADD COLUMN account_id TEXT`,
    `ALTER TABLE field_defs ADD COLUMN list_id TEXT`,
    `ALTER TABLE field_defs ADD COLUMN list_name TEXT`,
  ],
  [
    // Drafts: contacts only in Ligature, not (yet) in Google. Their provider ID is "draft:<id>".
    `ALTER TABLE contacts ADD COLUMN draft INTEGER NOT NULL DEFAULT 0`,
  ],
  [
    // The uncropped photo behind each photo cropped in Ligature, and the crop, so it can be
    // changed later. photo_key is a hash of the photo the crop made: once the contact’s photo
    // changes anywhere else, the original no longer applies and is dropped.
    `CREATE TABLE IF NOT EXISTS photo_originals (
      contact_id TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      image TEXT NOT NULL,
      crop_json TEXT NOT NULL,
      photo_key TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS photo_originals_user ON photo_originals(user_id)`,
  ],
];

let ready: Promise<void> | null = null;

export function ensureSchema(db: D1Database): Promise<void> {
  if (!ready) {
    ready = migrate(db).catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

async function migrate(db: D1Database): Promise<void> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`).run();
  const row = await db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).first<{ value: string }>();
  let version = row ? Number(row.value) : 0;
  while (version < MIGRATIONS.length) {
    const stmts = MIGRATIONS[version].map((sql) => db.prepare(sql));
    version += 1;
    stmts.push(
      db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?1)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(String(version)),
    );
    await db.batch(stmts);
  }
}

export const DEFAULT_FIELDS: { label: string; type: string; key?: string }[] = [
  { label: 'How we met', type: 'text' },
  { label: 'Neighborhood', type: 'text', key: 'neighborhood' },
  { label: 'On Signal', type: 'checkbox', key: 'signal' },
  { label: 'Signal username', type: 'text', key: 'signal_username' },
  { label: 'Follow up', type: 'date' },
  { label: 'Interests', type: 'text' },
  { label: 'Private notes', type: 'longtext' },
];

/** Relationship kinds. parent and manager are one-way: a is the parent or manager of b. */
export const RELATIONSHIP_KINDS = ['spouse', 'partner', 'parent', 'sibling', 'relative', 'friend', 'colleague', 'manager', 'other'] as const;

export const FIELD_TYPES = ['text', 'longtext', 'date', 'url', 'checkbox'] as const;
