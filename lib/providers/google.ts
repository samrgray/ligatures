import type { Address, Card, CardEdit, Env, Group, Labeled } from '../types';
import type { CachedContact, Provider, ProviderContact, ProviderCtx, SyncResult } from './types';
import { decryptJson, encryptJson } from '../crypto';
import { HttpError, now } from '../http';

// Contacts access, plus `openid`. With the Contacts scope alone Google gives no way to tell which
// account a token belongs to; `openid` adds only an opaque account number (the ID token's `sub`),
// no name, email or profile.
export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/contacts';
const SCOPES = ['openid', GOOGLE_SCOPE];
/** Asked for only when you first send email from Ligature. Send-only: no reading your mail. */
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

export function canSendEmail(account: { scopes: string | null }): boolean {
  return (account.scopes ?? '').split(/\s+/).includes(GMAIL_SEND_SCOPE);
}

const LINK_KEY = 'ligatureId';
const PERSON_FIELDS = [
  'names', 'nicknames', 'organizations', 'phoneNumbers', 'emailAddresses', 'urls', 'addresses',
  'birthdays', 'events', 'relations', 'biographies', 'photos', 'memberships', 'clientData', 'metadata',
].join(',');

// Every field a contact can have, for archiving it whole.
const ALL_FIELDS = [
  'addresses', 'ageRanges', 'biographies', 'birthdays', 'calendarUrls', 'clientData', 'coverPhotos', 'emailAddresses',
  'events', 'externalIds', 'genders', 'imClients', 'interests', 'locales', 'locations', 'memberships', 'metadata',
  'miscKeywords', 'names', 'nicknames', 'occupations', 'organizations', 'phoneNumbers', 'photos', 'relations',
  'sipAddresses', 'skills', 'urls', 'userDefined',
].join(',');
// The fields Google lets you set when creating a contact.
const WRITABLE = [
  'addresses', 'biographies', 'birthdays', 'calendarUrls', 'clientData', 'emailAddresses', 'events', 'externalIds',
  'genders', 'imClients', 'interests', 'locales', 'locations', 'miscKeywords', 'names', 'nicknames', 'occupations',
  'organizations', 'phoneNumbers', 'relations', 'sipAddresses', 'urls', 'userDefined',
];

/** Strip what Google fills in itself (sources, display names, formatted types) from a field. */
function writable(item: unknown): unknown {
  if (!item || typeof item !== 'object') return item;
  const { metadata, formattedType, formattedProtocol, displayName, displayNameLastFirst, ...rest } = item as Record<string, unknown>;
  void metadata; void formattedType; void formattedProtocol; void displayName; void displayNameLastFirst;
  return rest;
}

export interface GoogleCredentials {
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
}

function urls(env: Env) {
  return {
    auth: env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
    token: env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    api: env.GOOGLE_API_URL || 'https://people.googleapis.com',
    gmail: env.GOOGLE_GMAIL_URL || 'https://gmail.googleapis.com',
  };
}

export function googleConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

// ---------------------------------------------------------------- OAuth (server-side code flow)

export function authorizationUrl(env: Env, redirectUri: string, state: string, challenge: string, extraScopes: string[] = []): string {
  const u = new URL(urls(env).auth);
  u.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: [...SCOPES, ...extraScopes].join(' '),
    // Keep permissions granted earlier (such as Gmail sending) when signing in again.
    include_granted_scopes: 'true',
    access_type: 'offline', // ask for a refresh token
    prompt: 'consent', // always return a refresh token, even on re-consent
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return u.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(env: Env, params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(urls(env).token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      ...params,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || body.error) {
    if (body.error === 'invalid_grant') {
      throw new HttpError(401, 'Google access has expired or was revoked. Sign in with Google again.', 'reauth');
    }
    throw new HttpError(502, `Google sign-in failed: ${body.error_description || body.error || res.status}`);
  }
  return body;
}

export async function exchangeCode(env: Env, code: string, redirectUri: string, verifier: string) {
  const t = await tokenRequest(env, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const scopes = (t.scope ?? '').split(/\s+/);
  if (!scopes.includes(GOOGLE_SCOPE)) {
    throw new HttpError(403, 'Ligatures needs access to your contacts. Sign in again and leave that box checked.', 'scope');
  }
  if (!t.refresh_token) {
    throw new HttpError(502, 'Google didn’t return a refresh token. Remove Ligatures at myaccount.google.com/permissions and sign in again.');
  }
  return {
    scopes,
    accountId: accountIdFromIdToken(env, t.id_token),
    credentials: {
      refreshToken: t.refresh_token,
      accessToken: t.access_token,
      expiresAt: now() + t.expires_in * 1000,
    } satisfies GoogleCredentials,
  };
}

/**
 * The Google account's stable ID (`sub`) from the ID token. The token came straight from
 * Google's token endpoint over TLS, so per OpenID Connect its signature needn't be re-checked;
 * we still check who issued it and for which app.
 */
function accountIdFromIdToken(env: Env, idToken: string | undefined): string {
  const fail = () => {
    throw new HttpError(502, 'Couldn’t identify your Google account: Google sent no ID token.');
  };
  if (!idToken) fail();
  let claims: { sub?: string; aud?: string; iss?: string; exp?: number };
  try {
    const part = idToken!.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    claims = JSON.parse(atob(part + '==='.slice((part.length + 3) % 4)));
  } catch {
    return fail();
  }
  if (claims.aud !== env.GOOGLE_CLIENT_ID) throw new HttpError(403, 'That sign-in was issued to a different app.');
  if (claims.iss && !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) && !env.GOOGLE_TOKEN_URL) {
    throw new HttpError(403, 'That sign-in didn’t come from Google.');
  }
  if (!claims.sub) return fail();
  return claims.sub;
}

async function accessToken(ctx: ProviderCtx, force = false): Promise<string> {
  const { env, db, account } = ctx;
  if (!account.credentials_enc) throw new HttpError(401, 'Sign in with Google again.', 'reauth');
  const creds = await decryptJson<GoogleCredentials>(env, account.credentials_enc);
  if (!force && creds.accessToken && (creds.expiresAt ?? 0) > now() + 60_000) return creds.accessToken;
  const t = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: creds.refreshToken });
  const next: GoogleCredentials = {
    refreshToken: t.refresh_token || creds.refreshToken,
    accessToken: t.access_token,
    expiresAt: now() + t.expires_in * 1000,
  };
  account.credentials_enc = await encryptJson(env, next);
  await db.prepare('UPDATE accounts SET credentials_enc = ?1 WHERE id = ?2').bind(account.credentials_enc, account.id).run();
  return t.access_token;
}

// ---------------------------------------------------------------- People API

interface GoogleError {
  error?: { code?: number; message?: string; status?: string; details?: { reason?: string }[] };
}

class GoogleApiError extends Error {
  constructor(public status: number, public body: GoogleError) {
    super(body.error?.message || `Google API error ${status}`);
  }
  get reason() {
    return this.body.error?.details?.find((d) => d.reason)?.reason ?? this.body.error?.status ?? '';
  }
  get isEtagConflict() {
    return this.status === 400 && this.body.error?.status === 'FAILED_PRECONDITION' && /etag/i.test(this.message);
  }
  get isExpiredSyncToken() {
    return this.reason === 'EXPIRED_SYNC_TOKEN' || /sync token/i.test(this.message) || this.status === 410;
  }
}

function api<T>(ctx: ProviderCtx, path: string, init: RequestInit = {}): Promise<T> {
  return request<T>(ctx, urls(ctx.env).api + path, init);
}

async function request<T>(ctx: ProviderCtx, url: string, init: RequestInit = {}, retried = false): Promise<T> {
  const token = await accessToken(ctx, retried);
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  if (res.status === 401 && !retried) return request<T>(ctx, url, init, true);
  const body = (await res.json().catch(() => ({}))) as T & GoogleError;
  if (!res.ok) throw new GoogleApiError(res.status, body);
  return body;
}

function toHttpError(e: unknown): never {
  if (e instanceof GoogleApiError) {
    if (e.isEtagConflict) {
      throw new HttpError(409, 'This contact changed in Google since you opened it. It’s been reloaded; make your edit again.', 'conflict');
    }
    if (e.status === 429) throw new HttpError(429, 'Google is rate-limiting requests. Wait a minute and try again.');
    if (e.status === 403) throw new HttpError(403, `Google refused: ${e.message}`);
    throw new HttpError(502, `Google error: ${e.message}`);
  }
  throw e;
}

// ---------------------------------------------------------------- Gmail

/** Send one RFC 2822 message (base64url) through the account’s Gmail. */
export async function sendGmail(ctx: ProviderCtx, raw: string): Promise<{ id: string }> {
  try {
    return await request<{ id: string }>(ctx, `${urls(ctx.env).gmail}/gmail/v1/users/me/messages/send`, {
      method: 'POST',
      body: JSON.stringify({ raw }),
    });
  } catch (e) {
    if (e instanceof GoogleApiError) {
      if (e.status === 403 && /insufficient|scope/i.test(e.message + e.reason)) {
        throw new HttpError(403, 'Ligatures doesn’t have permission to send email from this account yet. Connect Gmail and try again.', 'gmail_scope');
      }
      if (e.status === 429) throw new HttpError(429, 'Gmail is limiting how fast you can send. Wait a few minutes and retry the rest.', 'rate_limited');
      if (e.status === 400) throw new HttpError(400, `Gmail couldn’t send it: ${e.message}`);
      throw new HttpError(e.status === 403 ? 403 : 502, `Gmail refused: ${e.message}`);
    }
    throw e;
  }
}

interface GoogleField {
  metadata?: { primary?: boolean; source?: { type?: string; id?: string } };
  [k: string]: unknown;
}
interface GooglePerson {
  resourceName: string;
  etag: string;
  metadata?: { deleted?: boolean; sources?: { type?: string; id?: string; etag?: string }[] };
  names?: (GoogleField & { givenName?: string; familyName?: string; middleName?: string; displayName?: string; displayNameLastFirst?: string })[];
  nicknames?: (GoogleField & { value?: string })[];
  organizations?: (GoogleField & { name?: string; title?: string; department?: string })[];
  phoneNumbers?: (GoogleField & { value?: string; type?: string; formattedType?: string })[];
  emailAddresses?: (GoogleField & { value?: string; type?: string; formattedType?: string })[];
  urls?: (GoogleField & { value?: string; type?: string; formattedType?: string })[];
  addresses?: (GoogleField & {
    formattedValue?: string; type?: string; formattedType?: string;
    streetAddress?: string; extendedAddress?: string; poBox?: string; city?: string; region?: string;
    postalCode?: string; country?: string; countryCode?: string;
  })[];
  birthdays?: (GoogleField & { date?: { year?: number; month?: number; day?: number }; text?: string })[];
  events?: (GoogleField & { date?: { year?: number; month?: number; day?: number }; type?: string; formattedType?: string })[];
  relations?: (GoogleField & { person?: string; type?: string; formattedType?: string })[];
  biographies?: (GoogleField & { value?: string; contentType?: string })[];
  photos?: (GoogleField & { url?: string; default?: boolean })[];
  memberships?: (GoogleField & { contactGroupMembership?: { contactGroupResourceName?: string } })[];
  clientData?: (GoogleField & { key?: string; value?: string })[];
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function formatDate(d?: { year?: number; month?: number; day?: number }, text?: string): string {
  if (!d?.month || !d.day) return text ?? '';
  return `${MONTHS[d.month - 1]} ${d.day}${d.year ? `, ${d.year}` : ''}`;
}

function monthDay(d?: { month?: number; day?: number }): string {
  return d?.month && d.day ? `${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` : '';
}

function labeled<T extends { formattedType?: string; type?: string }>(items: T[] | undefined, value: (i: T) => string | undefined): Labeled[] {
  return (items ?? [])
    .map((i) => ({ value: (value(i) ?? '').trim(), label: (i.formattedType || i.type || '').toLowerCase() }))
    .filter((i) => i.value);
}

function toContact(p: GooglePerson): ProviderContact {
  return {
    providerContactId: p.resourceName,
    etag: p.etag,
    deleted: Boolean(p.metadata?.deleted),
    linkIds: (p.clientData ?? []).filter((c) => c.key === LINK_KEY && c.value).map((c) => c.value!),
    raw: p,
  };
}

function toAddresses(items: GooglePerson['addresses']): Address[] {
  return (items ?? [])
    .map((a) => {
      const structured = Boolean(a.streetAddress || a.extendedAddress || a.poBox || a.city || a.region || a.postalCode || a.country);
      const street = [a.poBox ? `PO Box ${a.poBox}` : '', a.streetAddress, a.extendedAddress].filter(Boolean).join('\n');
      const value = (a.formattedValue ?? '').trim() || formatAddress({ street, city: a.city ?? '', region: a.region ?? '', postalCode: a.postalCode ?? '', country: a.country ?? '' });
      return {
        value,
        label: (a.formattedType || a.type || '').toLowerCase(),
        // An address typed as one block of text has no parts; edit it as the street.
        street: structured ? street : value,
        city: a.city ?? '',
        region: a.region ?? '',
        postalCode: a.postalCode ?? '',
        country: a.country ?? '',
      };
    })
    .filter((a) => a.value);
}

/** US-style: street, then “City, ST 12345”, then the country. */
function formatAddress(a: Omit<Address, 'value' | 'label'>): string {
  const line2 = [[a.city, a.region].filter(Boolean).join(', '), a.postalCode].filter(Boolean).join(' ');
  return [a.street.trim(), line2, a.country.trim()].filter(Boolean).join('\n');
}

/** Google addresses from edited parts. Keeps the country code when the country didn’t change. */
function rebuildAddresses(list: Omit<Address, 'value'>[], old: GooglePerson['addresses'] = []) {
  const t = (s: string) => s.trim();
  return list
    .map((a) => ({ ...a, street: t(a.street), city: t(a.city), region: t(a.region), postalCode: t(a.postalCode), country: t(a.country) }))
    .filter((a) => a.street || a.city || a.region || a.postalCode || a.country)
    .map((a) => {
      const code = old.find((o) => o.country && o.country === a.country)?.countryCode;
      return {
        type: t(a.label) || 'home',
        streetAddress: a.street,
        city: a.city,
        region: a.region,
        postalCode: a.postalCode,
        country: a.country,
        ...(code ? { countryCode: code } : {}),
        formattedValue: formatAddress(a),
      };
    });
}

/** Rebuild a list field (phones, emails, URLs) from edited values and labels. */
function rebuildList(list: Labeled[]) {
  return list
    .map((i) => ({ value: i.value.trim(), type: i.label.trim() || 'other' }))
    .filter((i) => i.value);
}

// Google's built-in groups worth showing. Importing a CSV with a “Family”, “Friends” or
// “Coworkers” label files those contacts into these system groups, not new labels.
const SYSTEM_GROUP_NAMES: Record<string, string> = {
  'contactGroups/starred': 'Favorites',
  'contactGroups/family': 'Family',
  'contactGroups/friends': 'Friends',
  'contactGroups/coworkers': 'Coworkers',
};

interface GoogleGroup {
  resourceName: string;
  etag?: string;
  name?: string;
  formattedName?: string;
  groupType?: string;
  memberCount?: number;
  memberResourceNames?: string[];
}

function toGroup(cg: GoogleGroup): Group {
  const system = cg.groupType === 'SYSTEM_CONTACT_GROUP';
  return { id: cg.resourceName, name: system ? SYSTEM_GROUP_NAMES[cg.resourceName] ?? cg.name ?? '' : cg.formattedName || cg.name || 'Untitled', system };
}

export function sortGroups(groups: Group[]): Group[] {
  const starred = (g: Group) => (g.id === 'contactGroups/starred' ? 0 : 1);
  return groups.sort((a, b) => starred(a) - starred(b) || a.name.localeCompare(b.name));
}

function groupError(e: unknown): never {
  if (e instanceof GoogleApiError && e.status === 409) throw new HttpError(409, 'There’s already a list with that name.');
  if (e instanceof GoogleApiError && e.status === 404) throw new HttpError(404, 'That list no longer exists in Google. Sync and try again.');
  toHttpError(e);
}

/** The fields an edit changes, as Google wants them for updateContact. */
function editBody(p: GooglePerson, edit: CardEdit): { body: Record<string, unknown>; fields: string[] } {
  const body: Record<string, unknown> = {};
  const fields: string[] = [];

  if (edit.givenName !== undefined || edit.familyName !== undefined) {
    const { displayName, displayNameLastFirst, unstructuredName, metadata, ...rest } = (p.names?.[0] ?? {}) as Record<string, unknown>;
    void displayName; void displayNameLastFirst; void unstructuredName; void metadata;
    const given = (edit.givenName ?? (rest.givenName as string) ?? '').trim();
    const family = (edit.familyName ?? (rest.familyName as string) ?? '').trim();
    body.names = given || family ? [{ ...rest, givenName: given, familyName: family }] : [];
    fields.push('names');
  }
  if (edit.organization !== undefined || edit.title !== undefined) {
    const { metadata, ...rest } = (p.organizations?.[0] ?? {}) as Record<string, unknown>;
    void metadata;
    const name = (edit.organization ?? (rest.name as string) ?? '').trim();
    const title = (edit.title ?? (rest.title as string) ?? '').trim();
    body.organizations = name || title ? [{ ...rest, name, title }, ...(p.organizations ?? []).slice(1)] : (p.organizations ?? []).slice(1);
    fields.push('organizations');
  }
  if (edit.phones) { body.phoneNumbers = rebuildList(edit.phones); fields.push('phoneNumbers'); }
  if (edit.emails) { body.emailAddresses = rebuildList(edit.emails); fields.push('emailAddresses'); }
  if (edit.urls) { body.urls = rebuildList(edit.urls); fields.push('urls'); }
  if (edit.addresses) { body.addresses = rebuildAddresses(edit.addresses, p.addresses); fields.push('addresses'); }
  if (edit.notes !== undefined) {
    body.biographies = edit.notes.trim() ? [{ value: edit.notes, contentType: 'TEXT_PLAIN' }] : [];
    fields.push('biographies');
  }
  return { body, fields };
}

/** A new contact as Google wants it for createContact. */
function newPerson(edit: CardEdit): Record<string, unknown> {
  const person: Record<string, unknown> = {
    names: [{ givenName: edit.givenName?.trim() ?? '', familyName: edit.familyName?.trim() ?? '' }],
  };
  if (edit.organization || edit.title) person.organizations = [{ name: edit.organization ?? '', title: edit.title ?? '' }];
  if (edit.phones) person.phoneNumbers = rebuildList(edit.phones);
  if (edit.emails) person.emailAddresses = rebuildList(edit.emails);
  if (edit.urls) person.urls = rebuildList(edit.urls);
  if (edit.addresses) person.addresses = rebuildAddresses(edit.addresses);
  if (edit.notes?.trim()) person.biographies = [{ value: edit.notes, contentType: 'TEXT_PLAIN' }];
  if (edit.groups?.length) {
    person.memberships = edit.groups.map((g) => ({ contactGroupMembership: { contactGroupResourceName: g } }));
  }
  return person;
}

export const google: Provider = {
  id: 'google',
  name: 'Google',

  toCard(raw): Card {
    const p = raw as GooglePerson;
    const name = p.names?.[0];
    const org = p.organizations?.[0];
    const display =
      name?.displayName || [name?.givenName, name?.familyName].filter(Boolean).join(' ') ||
      org?.name || p.emailAddresses?.[0]?.value || p.phoneNumbers?.[0]?.value || '';
    return {
      givenName: name?.givenName ?? '',
      familyName: name?.familyName ?? '',
      displayName: display,
      organization: org?.name ?? '',
      title: org?.title ?? '',
      phones: labeled(p.phoneNumbers, (i) => i.value),
      emails: labeled(p.emailAddresses, (i) => i.value),
      urls: labeled(p.urls, (i) => i.value),
      addresses: toAddresses(p.addresses),
      relations: labeled(p.relations, (i) => i.person),
      events: labeled(p.events, (i) => formatDate(i.date)),
      birthday: formatDate(p.birthdays?.[0]?.date, p.birthdays?.[0]?.text),
      birthdayKey: monthDay(p.birthdays?.[0]?.date),
      notes: p.biographies?.[0]?.value ?? '',
      photoUrl: p.photos?.find((ph) => !ph.default)?.url ?? '',
      groups: (p.memberships ?? [])
        .map((m) => m.contactGroupMembership?.contactGroupResourceName)
        .filter((g): g is string => Boolean(g)),
    };
  },

  async sync(ctx, syncToken): Promise<SyncResult> {
    const list = async (token: string | null) => {
      const contacts: ProviderContact[] = [];
      let pageToken: string | undefined;
      let nextSyncToken: string | null = null;
      do {
        const q = new URLSearchParams({ personFields: PERSON_FIELDS, pageSize: '1000', requestSyncToken: 'true' });
        if (token) q.set('syncToken', token);
        if (pageToken) q.set('pageToken', pageToken);
        const page = await api<{ connections?: GooglePerson[]; nextPageToken?: string; nextSyncToken?: string }>(
          ctx,
          `/v1/people/me/connections?${q}`,
        );
        for (const p of page.connections ?? []) contacts.push(toContact(p));
        pageToken = page.nextPageToken;
        nextSyncToken = page.nextSyncToken ?? nextSyncToken;
      } while (pageToken);
      return { contacts, syncToken: nextSyncToken };
    };

    let result: { contacts: ProviderContact[]; syncToken: string | null };
    let full = !syncToken;
    try {
      result = await list(syncToken);
    } catch (e) {
      if (syncToken && e instanceof GoogleApiError && e.isExpiredSyncToken) {
        full = true;
        result = await list(null);
      } else {
        toHttpError(e);
      }
    }

    const groups = await google.listGroups(ctx);
    return { contacts: result.contacts, full, syncToken: result.syncToken, groups };
  },

  async listGroups(ctx) {
    const groups: Group[] = [];
    try {
      const g = await api<{ contactGroups?: GoogleGroup[] }>(ctx, '/v1/contactGroups?pageSize=1000&groupFields=name,groupType,memberCount');
      for (const cg of g.contactGroups ?? []) {
        const system = cg.groupType === 'SYSTEM_CONTACT_GROUP';
        if (system && !SYSTEM_GROUP_NAMES[cg.resourceName]) continue;
        // Family, Friends and Coworkers exist in every account; show them only when used.
        if (system && cg.resourceName !== 'contactGroups/starred' && !cg.memberCount) continue;
        groups.push(toGroup(cg));
      }
    } catch (e) {
      toHttpError(e);
    }
    return sortGroups(groups);
  },

  async createGroup(ctx, name) {
    try {
      return toGroup(await api<GoogleGroup>(ctx, '/v1/contactGroups', { method: 'POST', body: JSON.stringify({ contactGroup: { name } }) }));
    } catch (e) {
      groupError(e);
    }
  },

  async renameGroup(ctx, groupId, name) {
    try {
      const current = await api<GoogleGroup>(ctx, `/v1/${groupId}?groupFields=name`);
      return toGroup(
        await api<GoogleGroup>(ctx, `/v1/${groupId}`, {
          method: 'PUT',
          body: JSON.stringify({ contactGroup: { resourceName: groupId, etag: current.etag, name }, updateGroupFields: 'name', readGroupFields: 'name,groupType' }),
        }),
      );
    } catch (e) {
      groupError(e);
    }
  },

  async deleteGroup(ctx, groupId) {
    try {
      const g = await api<GoogleGroup>(ctx, `/v1/${groupId}?maxMembers=5000&groupFields=name`);
      await api(ctx, `/v1/${groupId}?deleteContacts=false`, { method: 'DELETE' });
      return g.memberResourceNames ?? [];
    } catch (e) {
      groupError(e);
    }
  },

  async modifyGroup(ctx, groupId, add, remove) {
    const missing: string[] = [];
    try {
      // Google takes up to 1000 contacts per call.
      for (let i = 0; i < Math.max(add.length, remove.length); i += 1000) {
        const r = await api<{ notFoundResourceNames?: string[] }>(ctx, `/v1/${groupId}/members:modify`, {
          method: 'POST',
          body: JSON.stringify({ resourceNamesToAdd: add.slice(i, i + 1000), resourceNamesToRemove: remove.slice(i, i + 1000) }),
        });
        missing.push(...(r.notFoundResourceNames ?? []));
      }
    } catch (e) {
      groupError(e);
    }
    return missing;
  },

  async getMany(ctx, ids) {
    const out: ProviderContact[] = [];
    try {
      for (let i = 0; i < ids.length; i += 200) {
        const q = new URLSearchParams({ personFields: PERSON_FIELDS });
        for (const id of ids.slice(i, i + 200)) q.append('resourceNames', id);
        const r = await api<{ responses?: { person?: GooglePerson }[] }>(ctx, `/v1/people:batchGet?${q}`);
        for (const x of r.responses ?? []) if (x.person && !x.person.metadata?.deleted) out.push(toContact(x.person));
      }
    } catch (e) {
      toHttpError(e);
    }
    return out;
  },

  async get(ctx, providerContactId) {
    try {
      return toContact(await api<GooglePerson>(ctx, `/v1/${providerContactId}?personFields=${PERSON_FIELDS}`));
    } catch (e) {
      toHttpError(e);
    }
  },

  async update(ctx, contact, edit) {
    const p = contact.raw as GooglePerson;
    const { body, fields } = editBody(p, edit);
    body.etag = contact.etag;
    if (!fields.length) return toContact(p);

    try {
      const q = new URLSearchParams({ updatePersonFields: fields.join(','), personFields: PERSON_FIELDS });
      return toContact(await api<GooglePerson>(ctx, `/v1/${contact.providerContactId}:updateContact?${q}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }));
    } catch (e) {
      toHttpError(e);
    }
  },

  async create(ctx, edit, linkId) {
    const person = { ...newPerson(edit), clientData: [{ key: LINK_KEY, value: linkId }] };
    try {
      return toContact(await api<GooglePerson>(ctx, `/v1/people:createContact?personFields=${PERSON_FIELDS}`, {
        method: 'POST',
        body: JSON.stringify(person),
      }));
    } catch (e) {
      toHttpError(e);
    }
  },

  // Drafts: kept only in Ligature, in Google’s own shape, so making one real is a restore.
  draftRaw(edit) {
    return newPerson(edit);
  },

  editDraft(raw, edit) {
    const { body, fields } = editBody(raw as GooglePerson, edit);
    const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    for (const f of fields) out[f] = body[f];
    return out;
  },

  setDraftPhoto(raw, jpegBase64) {
    const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    if (jpegBase64) out.photos = [{ url: `data:image/jpeg;base64,${jpegBase64}` }];
    else delete out.photos;
    return out;
  },

  setDraftGroups(raw, groupIds) {
    return { ...(raw as Record<string, unknown>), memberships: groupIds.map((g) => ({ contactGroupMembership: { contactGroupResourceName: g } })) };
  },

  async snapshot(ctx, providerContactId) {
    let raw: GooglePerson;
    try {
      raw = await api<GooglePerson>(ctx, `/v1/${providerContactId}?personFields=${ALL_FIELDS}`);
    } catch (e) {
      toHttpError(e);
    }
    // Keep the photo itself: once the contact is deleted, Google’s link to it may stop working.
    const photo = (await this.photo(raw, 512).catch((e) => (console.warn('archive photo fetch failed', e), null)))?.base64 ?? null;
    return { raw, photo };
  },

  async photo(raw, px) {
    const url = (raw as GooglePerson).photos?.find((p) => !p.default)?.url;
    if (!url) return null;
    const data = url.match(/^data:([\w/+.-]+);base64,(.*)$/);
    if (data) return { type: data[1], base64: data[2] };
    // Google photo URLs take a size; it never upscales past what it has.
    const res = await fetch(/googleusercontent\.com/.test(url) ? url.replace(/=s\d+(-c)?$/, '') + `=s${px}` : url);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { type: res.headers.get('content-type')?.split(';')[0] || 'image/jpeg', base64: btoa(bin) };
  },

  async restore(ctx, raw, photo, linkId, groupIds) {
    const p = raw as Record<string, unknown>;
    const person: Record<string, unknown> = {};
    for (const key of WRITABLE) {
      const v = p[key];
      if (Array.isArray(v) && v.length) person[key] = v.map(writable);
    }
    person.clientData = [
      ...((person.clientData as { key?: string }[] | undefined) ?? []).filter((c) => c.key !== LINK_KEY),
      { key: LINK_KEY, value: linkId },
    ];
    // Google allows one birthday, name and gender on a contact; keep the first.
    for (const key of ['names', 'birthdays', 'genders']) if (Array.isArray(person[key])) person[key] = (person[key] as unknown[]).slice(0, 1);
    person.memberships = groupIds.map((g) => ({ contactGroupMembership: { contactGroupResourceName: g } }));
    let created: ProviderContact;
    try {
      created = toContact(await api<GooglePerson>(ctx, `/v1/people:createContact?personFields=${PERSON_FIELDS}`, {
        method: 'POST',
        body: JSON.stringify(person),
      }));
    } catch (e) {
      toHttpError(e);
    }
    if (photo) {
      try {
        created = await this.setPhoto(ctx, created, photo);
      } catch (e) {
        console.warn('restore photo failed', e);
      }
    }
    return created;
  },

  // Google’s delete takes no etag, so compare each contact’s current etag first (one batch
  // read), then delete the unchanged ones in one batch call.
  async deleteContacts(ctx, contacts) {
    const deleted: string[] = [];
    const changed: string[] = [];
    const gone: string[] = [];
    for (let i = 0; i < contacts.length; i += 200) {
      const chunk = contacts.slice(i, i + 200);
      // Google’s etag depends on the fields requested, so ask for the same fields sync stores.
      const q = new URLSearchParams({ personFields: PERSON_FIELDS });
      for (const c of chunk) q.append('resourceNames', c.providerContactId);
      let current: { requestedResourceName?: string; person?: GooglePerson; status?: { code?: number } }[];
      try {
        current = (await api<{ responses?: typeof current }>(ctx, `/v1/people:batchGet?${q}`)).responses ?? [];
      } catch (e) {
        toHttpError(e);
      }
      const etags = new Map(current.filter((r) => r.person).map((r) => [r.requestedResourceName ?? r.person!.resourceName, r.person!]));
      const ok: string[] = [];
      for (const c of chunk) {
        const p = etags.get(c.providerContactId);
        if (!p || p.metadata?.deleted) gone.push(c.providerContactId);
        else if (p.etag !== c.etag) changed.push(c.providerContactId);
        else ok.push(c.providerContactId);
      }
      if (ok.length) {
        try {
          await api(ctx, '/v1/people:batchDeleteContacts', { method: 'POST', body: JSON.stringify({ resourceNames: ok }) });
        } catch (e) {
          toHttpError(e);
        }
        deleted.push(...ok);
      }
    }
    return { deleted, changed, gone };
  },

  // Google’s photo calls take no etag, so the route checks the contact hasn’t changed first.
  async setPhoto(ctx, contact, jpegBase64) {
    try {
      const r = await api<{ person: GooglePerson }>(ctx, `/v1/${contact.providerContactId}:updateContactPhoto`, {
        method: 'PATCH',
        body: JSON.stringify({ photoBytes: jpegBase64, personFields: PERSON_FIELDS }),
      });
      return toContact(r.person);
    } catch (e) {
      toHttpError(e);
    }
  },

  async deletePhoto(ctx, contact) {
    try {
      const r = await api<{ person: GooglePerson }>(
        ctx,
        `/v1/${contact.providerContactId}:deleteContactPhoto?personFields=${PERSON_FIELDS}`,
        { method: 'DELETE' },
      );
      return toContact(r.person);
    } catch (e) {
      toHttpError(e);
    }
  },

  async setLink(ctx, contact: CachedContact, linkId) {
    const q = new URLSearchParams({ updatePersonFields: 'clientData', personFields: PERSON_FIELDS });
    try {
      return toContact(await api<GooglePerson>(ctx, `/v1/${contact.providerContactId}:updateContact?${q}`, {
        method: 'PATCH',
        body: JSON.stringify({ etag: contact.etag, clientData: [{ key: LINK_KEY, value: linkId }] }),
      }));
    } catch (e) {
      toHttpError(e);
    }
  },
};
