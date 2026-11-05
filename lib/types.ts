export interface Env {
  DB: D1Database;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Optional base64 32-byte key. If unset, a key is derived from GOOGLE_CLIENT_SECRET. */
  TOKEN_ENCRYPTION_KEY?: string;
  /** "first" (default) or "open". */
  ALLOW_SIGNUPS?: string;
  /** Endpoint overrides, used only for local testing against a mock. */
  GOOGLE_AUTH_URL?: string;
  GOOGLE_TOKEN_URL?: string;
  GOOGLE_API_URL?: string;
  GOOGLE_GMAIL_URL?: string;
  /** A Nominatim-compatible geocoder. Defaults to OpenStreetMap’s. */
  GEOCODER_URL?: string;
  /** Contact for the geocoder’s User-Agent, as OpenStreetMap’s policy asks. */
  GEOCODER_CONTACT?: string;
}

export interface UserRow {
  id: string;
  display_name: string | null;
  /** Unused; left from an earlier read-only switch. */
  read_only: number;
  /** JSON: table columns and sort. */
  prefs: string | null;
  created_at: number;
}

export interface AccountRow {
  id: string;
  user_id: string;
  provider: string;
  provider_account_id: string;
  label: string | null;
  credentials_enc: string | null;
  sync_token: string | null;
  groups_json: string | null;
  last_synced_at: number | null;
  /** Space-separated OAuth scopes the account has granted. */
  scopes: string | null;
  created_at: number;
}

export interface ContactRow {
  id: string;
  user_id: string;
  account_id: string;
  provider_contact_id: string;
  etag: string | null;
  display_name: string | null;
  sort_key: string | null;
  data_json: string | null;
  link_stamped: number;
  merged_into: string | null;
  deleted_at: number | null;
  archived_at?: number | null;
  /** 1 for a draft: only in Ligature, not (yet) in the provider. */
  draft?: number;
  updated_at: number;
  created_at: number;
}

export interface Data extends Record<string, unknown> {
  user: UserRow | null;
}

/** A labelled value: a phone number, email, URL, address, relation. */
export interface Labeled {
  value: string;
  label: string;
}

/** A postal address: the formatted text in `value`, plus its parts for editing. */
export interface Address extends Labeled {
  street: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}

/** Provider-neutral view of a contact. Every provider maps its own record to this. */
export interface Card {
  givenName: string;
  familyName: string;
  displayName: string;
  organization: string;
  title: string;
  phones: Labeled[];
  emails: Labeled[];
  urls: Labeled[];
  addresses: Address[];
  relations: Labeled[];
  events: Labeled[];
  birthday: string;
  /** MM-DD, for sorting by birthday regardless of year. Empty if unknown. */
  birthdayKey: string;
  notes: string;
  photoUrl: string;
  groups: string[];
  /** When the provider last changed this contact (ISO time), if it says. */
  modifiedAt?: string;
}

/** The parts of a Card the app can write back to a provider. */
export interface CardEdit {
  givenName?: string;
  familyName?: string;
  organization?: string;
  title?: string;
  phones?: Labeled[];
  emails?: Labeled[];
  urls?: Labeled[];
  addresses?: Omit<Address, 'value'>[];
  notes?: string;
  /** New contacts only: lists to put them on. */
  groups?: string[];
}

export interface Group {
  id: string;
  name: string;
  system: boolean;
}
