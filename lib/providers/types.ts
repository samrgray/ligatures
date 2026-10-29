import type { AccountRow, Card, CardEdit, Env, Group } from '../types';

/**
 * A contacts backend: Google today; CardDAV and iCloud later.
 * Ligature keeps the provider's own record (`raw`) as a cache and shows it through `toCard`.
 * Writes always carry the provider's version tag (`etag`), so a stale copy can never
 * overwrite a newer change.
 */
export interface ProviderContact {
  providerContactId: string;
  etag: string;
  deleted: boolean;
  /** Ligature IDs found in the provider's hidden per-app data. Usually 0 or 1; >1 after a merge. */
  linkIds: string[];
  raw: unknown;
}

export interface SyncResult {
  contacts: ProviderContact[];
  /** True when this was a full listing, so anything not returned has been deleted. */
  full: boolean;
  syncToken: string | null;
  groups: Group[];
}

export interface ProviderCtx {
  env: Env;
  db: D1Database;
  account: AccountRow;
}

export interface CachedContact {
  providerContactId: string;
  etag: string;
  raw: unknown;
}

export interface Provider {
  id: string;
  name: string;
  toCard(raw: unknown): Card;
  sync(ctx: ProviderCtx, syncToken: string | null): Promise<SyncResult>;
  get(ctx: ProviderCtx, providerContactId: string): Promise<ProviderContact>;
  update(ctx: ProviderCtx, contact: CachedContact, edit: CardEdit): Promise<ProviderContact>;
  create(ctx: ProviderCtx, edit: CardEdit, linkId: string): Promise<ProviderContact>;
  /** Store Ligature's ID in the contact's hidden per-app data. */
  setLink(ctx: ProviderCtx, contact: CachedContact, linkId: string): Promise<ProviderContact>;
  /** Replace the contact’s photo. `jpegBase64` is the image, base64-encoded. */
  setPhoto(ctx: ProviderCtx, contact: CachedContact, jpegBase64: string): Promise<ProviderContact>;
  deletePhoto(ctx: ProviderCtx, contact: CachedContact): Promise<ProviderContact>;
  /** The contact’s current photo as base64 (with its media type), as large as the provider has up to `px`. */
  photo(raw: unknown, px: number): Promise<{ base64: string; type: string } | null>;
  /**
   * Delete contacts, but only those still at the etag we have: anything changed in the
   * provider since our last sync is left alone and reported in `changed`.
   */
  deleteContacts(ctx: ProviderCtx, contacts: CachedContact[]): Promise<{ deleted: string[]; changed: string[]; gone: string[] }>;
  /**
   * Everything the provider has on a contact (every field, not just the ones Ligature shows),
   * plus its photo, so it can be archived and later recreated exactly.
   */
  snapshot(ctx: ProviderCtx, providerContactId: string): Promise<{ raw: unknown; photo: string | null }>;
  /** Recreate an archived contact, on the lists in `groupIds` that still exist. */
  restore(ctx: ProviderCtx, raw: unknown, photo: string | null, linkId: string, groupIds: string[]): Promise<ProviderContact>;
  /** A draft: a contact in the provider’s shape that only Ligature has (until it’s made real with `restore`). */
  draftRaw(edit: CardEdit): unknown;
  editDraft(raw: unknown, edit: CardEdit): unknown;
  setDraftPhoto(raw: unknown, jpegBase64: string | null): unknown;
  setDraftGroups(raw: unknown, groupIds: string[]): unknown;
  /** Fresh copies of several contacts (ones not found are left out). */
  getMany(ctx: ProviderCtx, providerContactIds: string[]): Promise<ProviderContact[]>;

  // Lists (Google calls them labels or contact groups).
  listGroups(ctx: ProviderCtx): Promise<Group[]>;
  createGroup(ctx: ProviderCtx, name: string): Promise<Group>;
  renameGroup(ctx: ProviderCtx, groupId: string, name: string): Promise<Group>;
  /** Delete a list but not its contacts. Returns the contacts that were in it. */
  deleteGroup(ctx: ProviderCtx, groupId: string): Promise<string[]>;
  /** Add and remove contacts. Returns the contacts the provider couldn’t find. */
  modifyGroup(ctx: ProviderCtx, groupId: string, add: string[], remove: string[]): Promise<string[]>;
}
