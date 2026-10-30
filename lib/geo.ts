import type { Address, Env } from './types';
import { now } from './http';

// Putting contacts on the map. Each address becomes a place to look up on OpenStreetMap
// (Nominatim): the street address if there is one; otherwise the person’s neighborhood in that
// city, or just the city. Results are cached per user, so each place is only looked up once.

export type Precision = 'address' | 'neighborhood' | 'city' | 'postal' | 'region';

export interface Place {
  /** The address’s label: home, work… */
  label: string;
  precision: Precision;
  /** Cache keys to try in order (a neighborhood falls back to its city). */
  queries: { key: string; precision: Precision }[];
  text: string;
}

const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

function key(params: Record<string, string>): string {
  const kept = Object.entries(params).filter(([, v]) => v).map(([k, v]) => [k, v.toLowerCase()]);
  return JSON.stringify(Object.fromEntries(kept.sort(([a], [b]) => a.localeCompare(b))));
}

/**
 * The street as OpenStreetMap can match it: the first line, without an apartment, unit, suite
 * or floor (“12 Main St, Apt 3” → “12 Main St”), which otherwise makes the lookup find nothing.
 */
export function lookupStreet(street: string): string {
  const first = street.split(/\n/).map((l) => l.trim()).find(Boolean) ?? '';
  return clean(
    first
      .replace(/[,\s]+(apt|apartment|unit|suite|ste|fl|floor|rm|room|bldg|building|dept)\b\.?\s*[\w-]+.*$/i, '')
      .replace(/[,\s]*#\s*[\w-]+.*$/, ''),
  ).replace(/[,\s]+$/, '');
}

/** The places to show for one contact. */
export function placesFor(addresses: Address[], neighborhood: string): Place[] {
  const out: Place[] = [];
  // The neighborhood belongs to the home address (or the only one there is).
  const homeAt = Math.max(0, addresses.findIndex((a) => clean(a.label).toLowerCase() === 'home'));
  addresses.forEach((a, i) => {
    const hood = i === homeAt ? clean(neighborhood) : '';
    const label = clean(a.label).toLowerCase() || 'other';
    const street = clean(a.street);
    const city = clean(a.city);
    const state = clean(a.region);
    const postalcode = clean(a.postalCode);
    const country = clean(a.country);
    const structured = Boolean(city || state || postalcode || country);
    // Shown on the map: every filled-in part of the address, with the neighborhood before the city.
    const text = [
      a.street.split(/\n/).map(clean).filter(Boolean).join(', '),
      hood,
      city,
      [state, postalcode].filter(Boolean).join(' '),
      country,
    ]
      .filter(Boolean)
      .join(', ') || clean(a.value);
    const cityQ = city ? { key: key({ city, state, country }), precision: 'city' as const } : null;
    if (street && structured) {
      // Exact first; then without the ZIP (OpenStreetMap’s can differ); then as plain text;
      // only then the city.
      const s = lookupStreet(a.street) || street;
      const free = [s, city, [state, postalcode].filter(Boolean).join(' '), country].filter(Boolean).join(', ');
      const tries = [
        key({ street: s, city, state, postalcode, country }),
        key({ street: s, city, state, country }),
        key({ q: free }),
      ];
      out.push({
        label,
        precision: 'address',
        text,
        queries: [...[...new Set(tries)].map((k) => ({ key: k, precision: 'address' as Precision })), ...(cityQ ? [cityQ] : [])],
      });
    } else if (street) {
      // An address typed as one block of text.
      const q = a.street.split(/\n/).map((l) => l.trim()).filter(Boolean).join(', ');
      const tries = [...new Set([key({ q }), key({ q: [lookupStreet(a.street), ...q.split(', ').slice(1)].filter(Boolean).join(', ') })])];
      out.push({ label, precision: 'address', text, queries: tries.map((k) => ({ key: k, precision: 'address' as const })) });
    } else if (city && hood) {
      out.push({ label, precision: 'neighborhood', text, queries: [{ key: key({ q: [hood, city, state, country].filter(Boolean).join(', ') }), precision: 'neighborhood' }, cityQ!] });
    } else if (cityQ) {
      out.push({ label, precision: 'city', text, queries: [cityQ] });
    } else if (postalcode) {
      out.push({ label, precision: 'postal', text, queries: [{ key: key({ postalcode, country }), precision: 'postal' }] });
    } else if (state || country) {
      out.push({ label, precision: 'region', text, queries: [{ key: key({ state, country }), precision: 'region' }] });
    }
  });
  return out;
}

interface GeoRow {
  query: string;
  status: string;
  lat: number | null;
  lng: number | null;
  place: string | null;
  tried_at: number;
}

const RETRY_ERRORS_AFTER = 10 * 60_000;
const SPACING_MS = 1100; // OpenStreetMap asks for at most one lookup a second

export async function cachedGeocodes(db: D1Database, userId: string): Promise<Map<string, GeoRow>> {
  const rows = (await db.prepare('SELECT query, status, lat, lng, place, tried_at FROM geocodes WHERE user_id = ?1').bind(userId).all<GeoRow>()).results;
  return new Map(rows.map((r) => [r.query, r]));
}

/**
 * Resolve a place against the cache: the first query that found something. `missing` is the
 * next query that still needs looking up, if any.
 */
export function resolve(place: Place, cache: Map<string, GeoRow>, t = now()) {
  for (const q of place.queries) {
    const r = cache.get(q.key);
    if (!r || (r.status === 'error' && t - r.tried_at > RETRY_ERRORS_AFTER)) return { missing: q.key };
    if (r.status === 'ok') return { lat: r.lat!, lng: r.lng!, precision: q.precision, place: r.place ?? '' };
  }
  return { failed: true };
}

function geocoder(env: Env) {
  return {
    base: (env.GEOCODER_URL || 'https://nominatim.openstreetmap.org').replace(/\/$/, ''),
    headers: {
      'user-agent': `Ligatures/1.0 (personal contacts app; ${env.GEOCODER_CONTACT || 'https://github.com/samrgray/ligature'})`,
      'accept-language': 'en',
    },
  };
}

/** Search for a place by name or address, for pinning it on the map. */
export async function searchPlaces(env: Env, q: string) {
  const g = geocoder(env);
  const params = new URLSearchParams({ q, format: 'jsonv2', limit: '6' });
  const res = await fetch(`${g.base}/search?${params}`, { headers: g.headers });
  if (!res.ok) throw new Error(`OpenStreetMap answered ${res.status}.`);
  const hits = (await res.json()) as { lat: string; lon: string; display_name?: string; name?: string }[];
  return hits.map((h) => {
    const full = (h.display_name ?? '').trim();
    return { name: (h.name || full.split(',')[0] || '').trim(), address: full, lat: Number(h.lat), lng: Number(h.lon) };
  });
}

/** Look up places one at a time, a second apart. Returns how many were looked up. */
export async function geocode(env: Env, userId: string, queries: string[], deadline: number): Promise<number> {
  const g = geocoder(env);
  let done = 0;
  for (const q of queries) {
    if (done && Date.now() + SPACING_MS > deadline) break;
    if (done) await new Promise((r) => setTimeout(r, SPACING_MS));
    const params = new URLSearchParams({ ...(JSON.parse(q) as Record<string, string>), format: 'jsonv2', limit: '1' });
    let row: Omit<GeoRow, 'query'>;
    try {
      const res = await fetch(`${g.base}/search?${params}`, { headers: g.headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const [hit] = (await res.json()) as { lat: string; lon: string; display_name?: string }[];
      row = hit
        ? { status: 'ok', lat: Number(hit.lat), lng: Number(hit.lon), place: hit.display_name ?? null, tried_at: now() }
        : { status: 'none', lat: null, lng: null, place: null, tried_at: now() };
    } catch (e) {
      console.warn('geocode failed', e);
      row = { status: 'error', lat: null, lng: null, place: null, tried_at: now() };
    }
    await env.DB
      .prepare(
        `INSERT INTO geocodes (user_id, query, status, lat, lng, place, tried_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(user_id, query) DO UPDATE SET status = excluded.status, lat = excluded.lat, lng = excluded.lng,
           place = excluded.place, tried_at = excluded.tried_at`,
      )
      .bind(userId, q, row.status, row.lat, row.lng, row.place, row.tried_at)
      .run();
    done++;
    if (row.status === 'error') break; // don’t hammer a service that’s refusing us
  }
  return done;
}
