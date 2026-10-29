// Demo mode: made-up contacts that live only in this tab. Every API call is answered here, so
// nothing reaches the server or Google. The same people as the iOS demo, around Portland.

const KEY = 'ligature-demo';

export function demoOn() {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setDemo(on) {
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* per-browser convenience only */
  }
}

const ACCOUNT = 'demo';
const PEOPLE = [
  ['Zoe', 'Abernathy', '', '', ['contactGroups/family']],
  ['Jonah', 'Albrecht', 'Albrecht Design', 'Founder', ['contactGroups/book']],
  ['Rosa', 'Alvarez', '', '', ['contactGroups/neighbors', 'contactGroups/starred']],
  ['Will', 'Ashby', 'Ashby Insurance', 'Agent', []],
  ['Marco', 'Bellini', 'Trattoria Bellini', 'Owner', ['contactGroups/book']],
  ['Eli', 'Brandt', 'Brandt Legal', 'Attorney', []],
  ['Imani', 'Brooks', 'Lincoln Elementary', 'Teacher', ['contactGroups/neighbors']],
  ['Ava', 'Chen', 'Northwind Studio', 'Design Lead', ['contactGroups/work', 'contactGroups/starred']],
  ['Yusuf', 'Demir', 'Demir Imports', '', []],
  ['Aaron', 'Diaz', 'Diaz & Co.', '', ['contactGroups/work']],
  ['Paul', 'Dubois', 'Atelier M', 'Chef', []],
  ['Wren', 'Ellis', 'Fieldwork', 'Producer', ['contactGroups/work']],
  ['Isaac', 'Feld', 'Feld Physical Therapy', '', []],
  ['Noah', 'Fischer', 'Fischer Dental', 'Dentist', []],
  ['Olivia', 'Grant', 'Grant Realty', '', ['contactGroups/neighbors']],
  ['Nadia', 'Haddad', '', '', ['contactGroups/book']],
  ['Devon', 'Hale', 'Hale Builders', '', []],
  ['Quinn', 'Harper', 'Harper Coaching', 'Coach', []],
  ['Zane', 'Holloway', 'Holloway Cycles', '', ['contactGroups/neighbors']],
  ['Dana', 'Kim', '', '', ['contactGroups/family']],
  ['Lena', 'Kowalski', '', '', ['contactGroups/family']],
  ['Uma', 'Krishnan', 'Harbor Health', '', []],
  ['Sofia', 'Lindqvist', 'Nordic Supply', '', []],
  ['Theo', 'Marsh', 'Marsh Woodworks', 'Carpenter', []],
];
// Photos for most people, bundled so the demo still makes no network calls (Unsplash, free to use).
const PHOTOS = new Set(['zoe', 'jonah', 'rosa', 'marco', 'eli', 'imani', 'ava', 'aaron', 'paul', 'wren', 'noah', 'olivia', 'nadia', 'zane', 'lena', 'uma', 'sofia']);
const STREETS = ['SE Belmont St', 'NE Alberta St', 'SE Division St', 'N Mississippi Ave', 'NW 23rd Ave', 'SE Hawthorne Blvd', 'NE Fremont St', 'SW Vista Ave'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

let D = null; // the demo’s data, made on first use

function seed() {
  const groups = [
    { id: 'contactGroups/starred', name: 'Favorites', system: true },
    { id: 'contactGroups/book', name: 'Book Club', system: false },
    { id: 'contactGroups/family', name: 'Family', system: true },
    { id: 'contactGroups/neighbors', name: 'Neighbors', system: false },
    { id: 'contactGroups/work', name: 'Work', system: false },
  ];
  const fields = [
    { id: 'met', label: 'How we met', type: 'text' },
    { id: 'follow', label: 'Follow up', type: 'date' },
    { id: 'interests', label: 'Interests', type: 'text' },
    { id: 'hood', label: 'Neighborhood', type: 'text', key: 'neighborhood' },
    { id: 'notes', label: 'Private notes', type: 'longtext' },
    { id: 'signal', label: 'On Signal', type: 'checkbox', key: 'signal' },
    { id: 'signalUser', label: 'Signal username', type: 'text', key: 'signal_username' },
    { id: 'gate', label: 'Gate code', type: 'text', accountId: ACCOUNT, listId: 'contactGroups/neighbors', listName: 'Neighbors' },
  ].map((f, i) => ({ key: null, accountId: null, listId: null, listName: null, ...f, position: i }));
  const hoods = ['Buckman', 'Concordia', 'Richmond', 'Boise', 'Nob Hill', 'Sunnyside', 'Sabin', 'Goose Hollow'];

  const contacts = PEOPLE.map(([first, last, org, title, lists], i) => {
    const email = `${first.toLowerCase()}.${last.toLowerCase()}@example.com`;
    const phones = [{ value: `(503) 555-01${String(i + 10).padStart(2, '0')}`, label: 'mobile' }];
    const emails = [{ value: email, label: 'home' }];
    if (org) {
      phones.push({ value: '(971) 555-0188', label: 'work' });
      emails.push({ value: `${first.toLowerCase()}@${last.toLowerCase()}.example.com`, label: 'work' });
    }
    const month = (i * 5) % 12;
    const day = ((i * 7) % 27) + 1;
    const values = {};
    if (i % 3 === 0) values.met = ['Design Week', 'Neighbors', 'College', 'Book club'][i % 4];
    if (i % 4 === 1) values.signal = '1';
    if (i % 2 === 0) values.hood = hoods[i % hoods.length];
    if (i === 7) Object.assign(values, { follow: '2026-11-02', interests: 'Ceramics, trail running' });
    if (lists.includes('contactGroups/neighbors')) values.gate = String(1200 + i * 37);
    return {
      id: `demo-${i}`,
      etag: `demo-${i}-1`,
      draft: i === 4,
      fields: values,
      card: {
        givenName: first,
        familyName: last,
        displayName: `${first} ${last}`,
        organization: org,
        title,
        phones,
        emails,
        urls: [],
        addresses: [
          address('home', `${100 + ((i * 131) % 4800)} ${STREETS[i % STREETS.length]}`, 'Portland', 'OR', `972${String(10 + (i % 30)).padStart(2, '0')}`),
        ],
        relations: [],
        events: [],
        birthday: i % 5 === 3 ? '' : `${MONTHS[month]} ${day}, ${1970 + ((i * 3) % 30)}`,
        birthdayKey: i % 5 === 3 ? '' : `${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        notes: i % 4 === 2 ? 'Kids go to Lincoln.' : '',
        photoUrl: PHOTOS.has(first.toLowerCase()) ? `/demo/${first.toLowerCase()}.jpg` : '',
        groups: ['contactGroups/myContacts', ...lists],
      },
    };
  });
  D = {
    groups,
    fields,
    contacts,
    archived: [],
    // Zoe and Rosa show as one; Eli is Zoe’s son, shown on his own.
    relationships: [
      { id: 'demo-r1', a: 'demo-0', b: 'demo-2', kind: 'spouse', label: '', combined: true },
      { id: 'demo-r2', a: 'demo-0', b: 'demo-5', kind: 'parent', label: '', combined: false },
    ],
    pins: [{ id: 'demo-pin', label: 'Washington Park', address: 'Washington Park, Portland, OR', lat: 45.51, lng: -122.716 }],
    prefs: { pinnedLists: ['contactGroups/starred', 'contactGroups/book', 'contactGroups/neighbors', 'contactGroups/work'].map((id) => ({ accountId: ACCOUNT, id })) },
    syncedAt: Date.now(),
    n: 0,
  };
}

function address(label, street, city, region, postalCode, country = '') {
  const line2 = [[city, region].filter(Boolean).join(', '), postalCode].filter(Boolean).join(' ');
  return { label, street, city, region, postalCode, country, value: [street, line2, country].filter(Boolean).join('\n') };
}

// ---------------------------------------------------------------- shapes the server returns

const copy = (x) => structuredClone(x);
const uid = () => `demo-${Date.now().toString(36)}-${++D.n}`;
const fieldDef = (id) => D.fields.find((f) => f.id === id);

function search(c) {
  const card = c.card;
  const labeled = (l) => l.flatMap((x) => [x.value, x.label]);
  const own = Object.entries(c.fields).map(([id, v]) => {
    const f = fieldDef(id);
    if (!f) return '';
    if (f.listId && !card.groups.includes(f.listId)) return '';
    return f.type === 'checkbox' ? (v === '1' ? f.label : '') : v;
  });
  return [
    card.givenName, card.familyName, card.displayName, card.organization, card.title,
    ...labeled(card.phones), ...card.phones.map((p) => p.value.replace(/\D/g, '')),
    ...labeled(card.emails), ...labeled(card.urls), ...card.addresses.flatMap((a) => [a.value, a.label]),
    card.birthday, card.notes, ...own,
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').toLowerCase();
}

function row(c) {
  const card = c.card;
  const a = card.addresses[0];
  const mobile = card.phones.find((p) => /mobile|cell|iphone/i.test(p.label)) ?? card.phones[0];
  const home = card.addresses.findIndex((x) => x.label.trim().toLowerCase() === 'home');
  return {
    id: c.id,
    accountId: ACCOUNT,
    givenName: card.givenName,
    familyName: card.familyName,
    displayName: card.displayName,
    organization: card.organization,
    title: card.title,
    email: card.emails[0]?.value ?? '',
    phone: mobile?.value ?? '',
    address: a?.value.replace(/\s*\n\s*/g, ', ') ?? '',
    addressParts:
      a && (a.city || a.region || a.postalCode || a.country)
        ? { street: a.street, city: a.city, rest: [a.region, a.postalCode].filter(Boolean).join(' '), country: a.country, hood: home <= 0 }
        : null,
    birthday: card.birthday,
    birthdayKey: card.birthdayKey,
    notes: card.notes.slice(0, 300),
    photoUrl: card.photoUrl,
    search: search(c),
    groups: card.groups,
    fields: copy(c.fields),
    ...(c.draft ? { draft: true } : {}),
    ...(c.archivedAt ? { archivedAt: c.archivedAt } : {}),
  };
}

function payload(c) {
  return copy({
    id: c.id,
    etag: c.etag,
    archived: c.archivedAt ? { at: c.archivedAt, groups: c.card.groups } : undefined,
    draft: Boolean(c.draft),
    card: c.card,
    fields: c.fields,
    search: search(c),
    linked: true,
    account: { id: ACCOUNT, provider: 'google', providerName: 'Google', label: 'Google' },
    syncedAt: D.syncedAt,
  });
}

function session() {
  return copy({
    configured: true,
    demo: true,
    user: { id: 'demo', name: 'Demo', prefs: D.prefs },
    accounts: [{ id: ACCOUNT, provider: 'google', providerName: 'Google', label: 'Google', canEmail: true, lastSyncedAt: D.syncedAt, groups: sortLists(D.groups) }],
    fields: D.fields,
  });
}

function sortLists(groups) {
  const starred = (g) => (g.id === 'contactGroups/starred' ? 0 : 1);
  return [...groups].sort((a, b) => starred(a) - starred(b) || a.name.localeCompare(b.name));
}

// Around Portland, Oregon: most at a street address, a few only by neighborhood or city.
function mapPoints() {
  const points = [];
  D.contacts.forEach((c, i) => {
    if (!c.card.addresses.length || i % 7 === 6) return;
    const text = c.card.addresses[0].value.replace(/\s*\n\s*/g, ', ');
    if (i % 5 === 4) points.push({ id: c.id, label: 'home', precision: 'neighborhood', lat: 45.4638, lng: -122.653, text: 'Sellwood, Portland, OR' });
    else if (i % 9 === 8) points.push({ id: c.id, label: 'home', precision: 'city', lat: 45.5152, lng: -122.6784, text: 'Portland, OR' });
    else {
      const lat = 45.52 + (((i * 37) % 23) / 23) * 0.16 - 0.08;
      const lng = -122.66 + (((i * 53) % 29) / 29) * 0.2 - 0.1;
      points.push({ id: c.id, label: 'home', precision: 'address', lat, lng, text });
    }
  });
  return points;
}

// ---------------------------------------------------------------- requests

class DemoError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = { error: message, code };
  }
}

function find(id, { archived = false } = {}) {
  const c = D.contacts.find((x) => x.id === id && Boolean(x.archivedAt) === archived);
  if (!c) throw new DemoError(404, 'Contact not found.');
  return c;
}

function touch(c) {
  c.etag = `${c.id}-${uid()}`;
  c.card.displayName = [c.card.givenName, c.card.familyName].filter(Boolean).join(' ') || c.card.organization;
}

function applyEdit(c, edit = {}) {
  for (const k of ['givenName', 'familyName', 'organization', 'title', 'notes']) if (typeof edit[k] === 'string') c.card[k] = edit[k];
  for (const k of ['phones', 'emails', 'urls']) if (Array.isArray(edit[k])) c.card[k] = edit[k].filter((x) => x.value?.trim());
  if (Array.isArray(edit.addresses)) {
    c.card.addresses = edit.addresses.map((a) => address(a.label ?? '', a.street ?? '', a.city ?? '', a.region ?? '', a.postalCode ?? '', a.country ?? ''));
  }
  touch(c);
}

const live = () => D.contacts.filter((c) => !c.archivedAt);

/** Answers one API call the way the server would, from the demo’s data. */
export async function demoApi(path, { method = 'GET', body } = {}) {
  if (!D) seed();
  const [route, query = ''] = path.split('?');
  const q = new URLSearchParams(query);
  const parts = route.split('/').filter(Boolean).map(decodeURIComponent);
  const [top, id, sub] = parts;
  const b = body ?? {};

  switch (`${method} ${top}`) {
    case 'GET session':
      return session();
    case 'POST sync':
      D.syncedAt = Date.now();
      return { results: [{ accountId: ACCOUNT }] };
    case 'POST auth':
      return { ok: true };
    case 'PUT prefs':
      D.prefs = copy(b.prefs ?? {});
      return { ok: true };
    case 'PATCH prefs':
      Object.assign(D.prefs, copy(b.set ?? {}));
      return { ok: true, prefs: copy(D.prefs) };
    case 'GET archive':
      return { contacts: D.contacts.filter((c) => c.archivedAt).map(row) };
    case 'POST archive': {
      const ids = b.ids ?? [];
      const done = [];
      for (const c of D.contacts) {
        if (!ids.includes(c.id)) continue;
        if (b.action === 'archive' && !c.archivedAt) c.archivedAt = Date.now();
        else if (b.action === 'restore' && c.archivedAt) c.archivedAt = undefined;
        else if (b.action === 'forget' && c.archivedAt) c.forgotten = true;
        else continue;
        done.push(c.id);
      }
      if (b.action === 'forget') {
        D.contacts = D.contacts.filter((c) => !c.forgotten);
        D.relationships = D.relationships.filter((r) => !done.includes(r.a) && !done.includes(r.b));
      }
      return { done, skipped: [], missing: ids.filter((x) => !done.includes(x)) };
    }
    case 'GET contacts':
      if (id && sub === 'photo') {
        const c = find(id);
        if (!c.card.photoUrl) throw new DemoError(404, 'This contact has no photo.', 'no_photo');
        return c.photoOriginal ?? { image: c.card.photoUrl, crop: null };
      }
      if (id) return payload(D.contacts.find((x) => x.id === id) ?? find(id));
      return { relationships: copy(D.relationships), contacts: live().map(row) };
    case 'POST contacts': {
      if (id === 'lookup') {
        return {
          contacts: live()
            .filter((c) => b.ids?.includes(c.id))
            .map((c) => ({ ...row(c), phones: copy(c.card.phones), emails: copy(c.card.emails) })),
        };
      }
      if (id === 'delete') {
        const deleted = live().filter((c) => b.ids?.includes(c.id)).map((c) => c.id);
        D.contacts = D.contacts.filter((c) => !deleted.includes(c.id));
        return { deleted, changed: [], missing: [] };
      }
      if (sub === 'demote' || sub === 'promote') {
        const c = find(id);
        c.draft = sub === 'demote';
        touch(c);
        return payload(c);
      }
      const e = b.edit ?? {};
      if (!e.givenName && !e.familyName && !e.organization) throw new DemoError(400, 'Add a name or a company.');
      const c = {
        id: uid(),
        draft: Boolean(b.draft),
        fields: {},
        card: { givenName: '', familyName: '', displayName: '', organization: '', title: '', phones: [], emails: [], urls: [], addresses: [], relations: [], events: [], birthday: '', birthdayKey: '', notes: '', photoUrl: '', groups: ['contactGroups/myContacts', ...(e.groups ?? []).filter((g) => D.groups.some((x) => x.id === g))] },
      };
      applyEdit(c, e);
      D.contacts.push(c);
      return payload(c);
    }
    case 'PATCH contacts': {
      const c = find(id);
      if (b.etag !== c.etag) throw new DemoError(409, 'This contact changed since you opened it. It’s been reloaded; make your edit again.', 'conflict');
      applyEdit(c, b.edit);
      return payload(c);
    }
    case 'PUT contacts': {
      const c = D.contacts.find((x) => x.id === id) ?? find(id);
      if (sub === 'photo') {
        c.card.photoUrl = b.image?.startsWith('data:') ? b.image : `data:image/jpeg;base64,${b.image}`;
        c.photoOriginal = b.original ? { image: b.original, crop: b.crop } : undefined;
        touch(c);
        return payload(c);
      }
      for (const [k, v] of Object.entries(b.values ?? {})) {
        if (!fieldDef(k)) throw new DemoError(400, 'Unknown field.');
        if (String(v).trim()) c.fields[k] = String(v);
        else delete c.fields[k];
      }
      return payload(c);
    }
    case 'DELETE contacts': {
      const c = find(id);
      c.card.photoUrl = '';
      delete c.photoOriginal;
      touch(c);
      return payload(c);
    }
    case 'POST lists':
      return lists(b);
    case 'POST fields': {
      const label = String(b.label ?? '').trim();
      if (!label) throw new DemoError(400, 'Give the field a name.');
      const list = b.list ? { accountId: ACCOUNT, listId: b.list.listId, listName: D.groups.find((g) => g.id === b.list.listId)?.name ?? null } : {};
      const f = { id: uid(), label, type: b.type || 'text', position: D.fields.length, key: null, accountId: null, listId: null, listName: null, ...list };
      D.fields.push(f);
      return copy(f);
    }
    case 'PATCH fields': {
      const f = fieldDef(id);
      if (!f) throw new DemoError(404, 'Field not found.');
      if ((b.type !== undefined || b.list !== undefined) && f.key) throw new DemoError(400, 'This field is built in, so it’s on every contact and its type can’t change.');
      if (typeof b.label === 'string' && b.label.trim()) f.label = b.label.trim();
      if (typeof b.type === 'string') f.type = b.type;
      if (typeof b.position === 'number') f.position = b.position;
      if (b.list !== undefined) {
        f.accountId = b.list ? ACCOUNT : null;
        f.listId = b.list?.listId ?? null;
        f.listName = b.list ? D.groups.find((g) => g.id === b.list.listId)?.name ?? null : null;
      }
      D.fields.sort((x, y) => x.position - y.position);
      return { ok: true };
    }
    case 'DELETE fields': {
      const f = fieldDef(id);
      if (f?.key) throw new DemoError(400, 'This field is built in, so it can’t be deleted. You can hide its column.');
      D.fields = D.fields.filter((x) => x.id !== id);
      for (const c of D.contacts) delete c.fields[id];
      return { ok: true };
    }
    case 'GET relationships':
      return { relationships: copy(D.relationships) };
    case 'POST relationships': {
      const same = (r) => (r.a === b.a && r.b === b.b) || (r.a === b.b && r.b === b.a);
      const old = D.relationships.find(same);
      const r = { id: old?.id ?? uid(), a: b.a, b: b.b, kind: b.kind, label: b.kind === 'other' ? String(b.label ?? '').trim() : '', combined: Boolean(b.combined) };
      D.relationships = [...D.relationships.filter((x) => !same(x)), r];
      return { relationship: copy(r) };
    }
    case 'DELETE relationships':
      D.relationships = D.relationships.filter((r) => r.id !== id);
      return { ok: true };
    case 'GET map':
      return { points: mapPoints(), failed: [], pending: 0 };
    case 'POST map':
      return { points: mapPoints(), failed: [], pending: 0 };
    case 'GET pins':
      return { pins: copy(D.pins) };
    case 'POST pins': {
      const p = { id: uid(), label: String(b.label ?? '').trim() || 'Pin', address: b.address ?? '', lat: Number(b.lat), lng: Number(b.lng) };
      D.pins.push(p);
      return { pin: copy(p) };
    }
    case 'PATCH pins': {
      const p = D.pins.find((x) => x.id === id);
      if (!p) throw new DemoError(404, 'That pin is gone.');
      p.label = String(b.label ?? '').trim() || p.label;
      return { pin: copy(p) };
    }
    case 'DELETE pins':
      D.pins = D.pins.filter((x) => x.id !== id);
      return { ok: true };
    case 'GET places': {
      const text = (q.get('q') ?? '').trim();
      if (text.length < 3) throw new DemoError(400, 'Type a bit more of the address.');
      return { places: [{ name: text, address: `${text}, Portland, OR`, lat: 45.523, lng: -122.676 }] };
    }
    case 'POST messages':
      // Pretend it went: nothing is sent from the demo.
      return { ok: true, messageId: uid(), sent: (b.recipients ?? []).length };
  }
  throw new DemoError(404, 'Not available in the demo.');
}

function lists(b) {
  const g = D.groups.find((x) => x.id === b.groupId);
  const name = typeof b.name === 'string' ? b.name.trim().replace(/\s+/g, ' ') : '';
  let changed = [];
  let group;
  switch (b.action) {
    case 'create':
      if (!name) throw new DemoError(400, 'Give the list a name.');
      group = { id: `contactGroups/${uid()}`, name, system: false };
      D.groups.push(group);
      break;
    case 'rename':
      if (!g) throw new DemoError(404, 'That list isn’t in this account.');
      if (!name) throw new DemoError(400, 'Give the list a name.');
      g.name = name;
      for (const f of D.fields) if (f.listId === g.id) f.listName = name;
      group = g;
      break;
    case 'delete':
      if (!g) throw new DemoError(404, 'That list isn’t in this account.');
      D.groups = D.groups.filter((x) => x !== g);
      changed = D.contacts.filter((c) => c.card.groups.includes(g.id));
      for (const c of changed) c.card.groups = c.card.groups.filter((x) => x !== g.id);
      if (Array.isArray(D.prefs.listParents)) D.prefs.listParents = D.prefs.listParents.filter((x) => x.id !== g.id && x.parentId !== g.id);
      break;
    case 'members': {
      if (!g) throw new DemoError(404, 'That list isn’t in this account.');
      const add = new Set(b.add ?? []);
      const remove = new Set(b.remove ?? []);
      changed = live().filter((c) => add.has(c.id) || remove.has(c.id));
      for (const c of changed) {
        c.card.groups = c.card.groups.filter((x) => x !== g.id);
        if (add.has(c.id)) c.card.groups.push(g.id);
        touch(c);
      }
      group = g;
      break;
    }
    default:
      throw new DemoError(400, 'Unknown list action.');
  }
  return copy({ group, groups: sortLists(D.groups), contacts: changed.map((c) => ({ id: c.id, etag: c.etag, groups: c.card.groups })), skipped: 0 });
}
