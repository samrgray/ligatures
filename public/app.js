// Ligature web app. Plain ES modules, no build step.

import {
  BUILTIN_TAGS, CHANNELS, defaultEmail, defaultPhone, findTags, formatPhoneTyping, render, signalHref, smsHref, unknownTags, whatsappHref,
} from './messaging.js';
import { ROLES, otherId, relationshipBody, roleLabel, roleOf, togetherGroups, togetherName } from './relations.js';
import { demoApi, demoOn, setDemo } from './demo.js';

const S = {
  session: null,
  contacts: [],
  relationships: [], // { id, a, b, kind, label, combined }
  archived: [], // archived contacts, shown only in the Archived view
  filter: { type: 'all' }, // { type: 'all' } | { type: 'account', id } | { type: 'group', accountId, id }
  query: '',
  selectedId: null,
  detail: null,
  mode: 'view', // 'view' | 'edit' | 'new'
  syncing: false,
  view: 'main', // narrow screens: 'sidebar' shows the lists over the table
  drawer: false, // detail panel open
  selected: new Set(), // contacts ticked for messaging
  anchorId: null, // where a shift-click range starts
  cols: [], // shown columns, in order: { id, w? }
  nameSort: 'last', // the Name column sorts by 'last' or 'first' name
  sort: { id: 'name', dir: 'asc' },
  layout: 'table', // 'table' | 'map'
};

const LAYOUT_KEY = 'ligature-layout';
try {
  if (localStorage.getItem(LAYOUT_KEY) === 'map') S.layout = 'map';
} catch {
  /* per-browser convenience only */
}

// ---------------------------------------------------------------- helpers

const $ = (sel, el = document) => el.querySelector(sel);
const h = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Demo mode: made-up contacts kept in this tab; nothing goes to the server or Google. */
const DEMO = demoOn();

async function api(path, { method = 'GET', body } = {}) {
  if (DEMO) return demoApi(path, { method, body });
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && method !== 'GET' && WRITES_TO_GOOGLE.test(path)) syncSoon();
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data.code;
    err.data = data;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------- staying current
// Edits go to Google as you make them. After one, Ligature also checks Google for anything
// changed elsewhere, so the “Synced” time means “current as of”. It checks again when you come
// back to the tab after a minute away, and every five minutes while the tab is in view.

const WRITES_TO_GOOGLE = /^\/(contacts(\/(?!lookup\b)[^/?]+(\/photo)?)?|lists|archive)(\?|$)/;
const CHECK_AFTER_AWAY = 60_000;
const CHECK_EVERY = 5 * 60_000;
let syncSoonTimer;

/** One background check after a burst of edits. */
function syncSoon() {
  clearTimeout(syncSoonTimer);
  syncSoonTimer = setTimeout(() => {
    // A check already running may have started before this edit; go again when it ends.
    if (S.syncing) S.syncAgain = true;
    else sync({ quiet: true });
  }, 1500);
}

function lastChecked() {
  return Math.max(0, ...(S.session?.accounts ?? []).map((a) => a.lastSyncedAt || 0));
}

function checkIfStale(maxAge) {
  if (!S.session?.user || !S.session.accounts.length || document.hidden) return;
  if (Date.now() - lastChecked() > maxAge) sync({ quiet: true });
}

document.addEventListener('visibilitychange', () => checkIfStale(CHECK_AFTER_AWAY));
setInterval(() => checkIfStale(CHECK_EVERY - 5_000), 60_000);

let toastTimer;
function toast(msg, ms = 4000) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function handleError(e) {
  if (e.code === 'signed_out') return boot();
  if (e.code === 'reauth') {
    toast('Google access expired. Sign in again to keep syncing.', 8000);
    return;
  }
  toast(e.message || 'Something went wrong.');
}

function ago(ts) {
  if (!ts) return 'never';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function initials(c) {
  const a = (c.givenName || '').trim()[0] || '';
  const b = (c.familyName || '').trim()[0] || '';
  return (a + b || (c.displayName || '?').trim()[0] || '?').toUpperCase();
}

const ICON = {
  person: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="9" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  pin: '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M10.6 1.2a1 1 0 0 1 1.4 0l2.8 2.8a1 1 0 0 1 0 1.4l-.9.9a1 1 0 0 1-1 .25L10.4 8.8l.4 2.7a1 1 0 0 1-.28.86l-.7.7a1 1 0 0 1-1.42 0L6 10.66l-3.3 3.3a.75.75 0 0 1-1.06-1.06L4.94 9.6 2.5 7.18a1 1 0 0 1 0-1.42l.7-.7a1 1 0 0 1 .86-.28l2.7.4 2.25-2.5a1 1 0 0 1 .25-1z"/></svg>',
  more: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>',
  dash: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 8h8"/></svg>',
  plus: '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M10 3v14M3 10h14"/></svg>',
  search: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="5"/><path d="m11 11 3.5 3.5"/></svg>',
  back: '<svg width="10" height="16" viewBox="0 0 12 20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 2 2 10l8 8"/></svg>',
  copy: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.8"/><path d="M10.5 3.2A1.8 1.8 0 0 0 8.8 2H4.3A1.8 1.8 0 0 0 2.5 3.8v4.5a1.8 1.8 0 0 0 1.2 1.7"/></svg>',
  check: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 8.5 3.2 3L13 4.5"/></svg>',
  sun: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="10" r="3.5"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4"/></svg>',
  moon: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M16.5 12.3A7 7 0 0 1 7.7 3.5a7 7 0 1 0 8.8 8.8Z"/></svg>',
  auto: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M10 3a7 7 0 0 1 0 14Z" fill="currentColor" stroke="none"/></svg>',
  x: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8"/></svg>',
  sidebar: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="13" rx="2.5"/><path d="M7.5 3.5v13"/><path d="M4.5 7h1M4.5 9.5h1M4.5 12h1" stroke-linecap="round"/></svg>',
  menu: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 6h14M3 10h14M3 14h14"/></svg>',
  columns: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M6.5 2.5v11M10 2.5v11"/></svg>',
  up: '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2 6.5 3-3 3 3"/></svg>',
  directions: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.3 2.4a1 1 0 0 1 1.4 0l7 7a1 1 0 0 1 0 1.4l-7 7a1 1 0 0 1-1.4 0l-7-7a1 1 0 0 1 0-1.4z"/><path d="M7.5 12.5v-2a1.5 1.5 0 0 1 1.5-1.5h4"/><path d="m11 6.8 2.2 2.2-2.2 2.2"/></svg>',
  down: '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2 3.5 3 3 3-3"/></svg>',
  grip: '<svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true"><circle cx="3" cy="3" r="1.2"/><circle cx="7" cy="3" r="1.2"/><circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/><circle cx="3" cy="11" r="1.2"/><circle cx="7" cy="11" r="1.2"/></svg>',
  check: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2.5 6.2 2.3 2.3 4.7-5"/></svg>',
  open: '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 2.5h5v5M9.5 2.5 3 9"/></svg>',
  sync: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M13.5 8A5.5 5.5 0 1 1 8 2.5c1.8 0 3.2.8 4.3 2"/><path d="M12.5 1.5v3h-3"/></svg>',
};

// ---------------------------------------------------------------- boot

async function boot() {
  const params = new URLSearchParams(location.search);
  const authError = params.get('auth_error');
  if (authError) history.replaceState(null, '', '/');
  try {
    S.session = await api('/session');
  } catch (e) {
    $('#root').innerHTML = `<div class="center"><div class="signin"><h1>Ligatures</h1><p class="error">${h(e.message)}</p></div></div>`;
    return;
  }
  if (!S.session.user) return renderSignIn(authError);
  applyFont(currentFont());
  const gmail = params.get('gmail');
  if (gmail) history.replaceState(null, '', '/');
  loadPrefs();
  renderShell();
  await loadContacts();
  if (authError) toast(authError, 8000);
  else if (gmail === 'connected') toast('Gmail connected. Ligatures can now send email for you.', 5000);
  if (gmail || authError) await resumeComposer();
  checkIfStale(CHECK_AFTER_AWAY);
}

function renderSignIn(error) {
  const configured = S.session.configured;
  $('#root').innerHTML = `
    <main class="center">
      <div class="signin">
        <h1 class="logo" role="img" aria-label="Ligatures"></h1>
        <p>A personal CRM on top of Google Contacts. Your own fields stay here and never sync back to Google, iPhone or Mac.</p>
        ${error ? `<p class="error" role="alert">${h(error)}</p>` : ''}
        ${
          configured
            ? `<a class="btn primary" href="/api/auth/google/start">Sign in with Google</a>
               <p>Ligatures asks for access to your contacts only.</p>
               <p><button type="button" class="link" data-action="demo-on">Try the demo</button> with made-up contacts.</p>`
            : `<p class="error">Google sign-in isn’t set up on this server yet.</p>
               <ol>
                 <li>Create an OAuth client (Web application) in Google Cloud and enable the People API.</li>
                 <li>Add <code>${h(location.origin)}/api/auth/google/callback</code> as a redirect URI.</li>
                 <li>Set <code>GOOGLE_CLIENT_ID</code> and the secret <code>GOOGLE_CLIENT_SECRET</code>, then redeploy.</li>
               </ol>`
        }
      </div>
    </main>`;
}

function renderShell() {
  $('#root').innerHTML = `
    <div class="app" data-view="${S.view}">
      <aside class="sidebar" id="sidebar" aria-label="Accounts and lists"></aside>
      <div class="sidebar-resize" id="sidebar-resize" title="Drag to resize. Double-click to reset." aria-hidden="true"></div>
      <div class="scrim" data-action="hide-sidebar" aria-hidden="true"></div>
      <main class="main">
        <div class="main-bar">
          <button type="button" class="icon-btn sidebar-btn" id="sidebar-btn" data-action="toggle-sidebar" aria-controls="sidebar">${ICON.sidebar}</button>
          <div class="title-block"><h1 id="view-title">All Contacts</h1><span class="count" id="list-count"></span>
            <label class="sub-toggle" id="drafts-toggle" hidden title="Show drafts (only in Ligatures, not in Google Contacts)"><input type="checkbox" data-drafts-toggle> Drafts</label>
            <label class="sub-toggle" id="sub-toggle" hidden title="Also show people in this list’s sublists"><input type="checkbox" data-sub-toggle> Include sublists</label></div>
          <label class="photo-zoom" title="Photo size">
            <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="6" r="3" fill="currentColor"/><path d="M2.5 15a5.5 5.5 0 0 1 11 0" fill="currentColor"/></svg>
            <input type="range" id="photo-zoom" min="${PHOTO.min}" max="${PHOTO.max}" step="2" value="${S.photoSize}" aria-label="Photo size">
            <svg width="17" height="17" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="6" r="3" fill="currentColor"/><path d="M2.5 15a5.5 5.5 0 0 1 11 0" fill="currentColor"/></svg>
          </label>
          <div class="seg layout-seg" role="group" aria-label="View as">
            <button type="button" data-layout="table" aria-pressed="${S.layout === 'table'}">Table</button>
            <button type="button" data-layout="map" aria-pressed="${S.layout === 'map'}">Map</button>
          </div>
          <div class="search">
            ${ICON.search}
            <label for="q" class="sr">Search contacts</label>
            <input id="q" type="search" placeholder="Search" autocomplete="off" spellcheck="false" value="${h(S.query)}">
          </div>
          <span class="grow"></span>
          <span class="sel-tools" id="sel-tools"></span>
          <div class="bar-actions">
            <button type="button" class="btn" data-action="columns">${ICON.columns} Columns</button>
            <button type="button" class="btn" data-action="add-to-list" id="add-to-list-btn" title="Add people to this list (A)" aria-label="Add people to this list" hidden>${ICON.plus} Add</button>
            <button type="button" class="btn" data-action="compose" id="msg-btn">Message All</button>
            <button type="button" class="btn primary" data-action="new">New Contact</button>
          </div>
        </div>
        <div class="content">
          <div class="grid-wrap" id="grid-wrap"${S.layout === 'map' ? ' hidden' : ''}><table class="grid" id="grid"></table></div>
          <div class="map-wrap" id="map-wrap"${S.layout === 'map' ? '' : ' hidden'}></div>
          <aside class="drawer" id="detail" aria-label="Contact details"></aside>
        </div>
      </main>
    </div>
    <dialog id="fields-dlg" aria-labelledby="fields-title"></dialog>
    <dialog id="columns-dlg" class="columns-dlg" aria-labelledby="columns-title"></dialog>
    <dialog id="confirm-dlg" class="confirm-dlg" aria-labelledby="confirm-title"></dialog>
    <dialog id="list-style-dlg" class="list-style-dlg" aria-labelledby="list-style-title"></dialog>
    <dialog id="photo-dlg" class="photo-dlg" aria-label="Photo"></dialog>
    <dialog id="rel-dlg" class="rel-dlg" aria-labelledby="rel-title"></dialog>
    <dialog id="compose-dlg" class="compose-dlg" aria-labelledby="compose-title"></dialog>
    <dialog id="keys-dlg" class="keys-dlg" aria-labelledby="keys-title"></dialog>
    <dialog id="add-dlg" class="add-dlg" aria-labelledby="add-title"></dialog>`;
  $('#detail').inert = true;
  applySidebar();
  $('#rel-dlg').addEventListener('close', () => (RD = null));
  $('#add-dlg').addEventListener('close', () => (AD = null));
  $('#rel-dlg').addEventListener('submit', (e) => {
    e.preventDefault();
    saveRelationship();
  });
  $('#rel-dlg').addEventListener('input', (e) => RD && relDialogInput(e.target));
  $('#compose-dlg').addEventListener('cancel', (e) => {
    if (!closeComposer()) e.preventDefault();
  });
  applyPhotoSize();
  $('#photo-zoom').addEventListener('input', (e) => setPhotoSize(Number(e.target.value), false));
  $('#photo-zoom').addEventListener('change', (e) => setPhotoSize(Number(e.target.value), true));
  $('#q').addEventListener('input', (e) => {
    S.query = e.target.value;
    renderGrid();
  });
  renderSidebar();
  renderGrid();
  renderDetail();
  if (S.layout === 'map') setLayout('map');
}

// ---------------------------------------------------------------- map

let mapView = null;

const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
};

async function setLayout(layout) {
  S.layout = layout;
  try {
    localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    /* not remembered */
  }
  for (const b of document.querySelectorAll('[data-layout]')) b.setAttribute('aria-pressed', String(b.dataset.layout === layout));
  $('#grid-wrap').hidden = layout === 'map';
  $('#map-wrap').hidden = layout !== 'map';
  if (layout !== 'map') {
    mapView?.hide();
    return renderGrid();
  }
  if (!mapView) {
    const { PeopleMap } = await import('./map.js');
    mapView = new PeopleMap($('#map-wrap'), {
      people: () => visibleContacts(),
      selected: () => S.selected,
      setSelected: (ids, on) => {
        for (const id of ids) on ? S.selected.add(id) : S.selected.delete(id);
        syncChecks();
      },
      open: (id) => select(id),
      api,
      dark: isDark,
      error: handleError,
    });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => mapView.setTheme());
  }
  await mapView.show();
}

function setView(v) {
  S.view = v;
  const app = $('.app');
  if (app) app.dataset.view = v;
  applySidebar();
}

// ---------------------------------------------------------------- sidebar collapse
// Desktop: the sidebar can be hidden to give the table more room (remembered per browser).
// Phone: the same button slides the sidebar in over the table.

const SIDEBAR_KEY = 'ligature-sidebar';
const NARROW = window.matchMedia('(max-width: 820px)');

function sidebarCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === 'hidden';
  } catch {
    return false;
  }
}

const SIDEBAR_W_KEY = 'ligature-sidebar-width';
const SIDEBAR_W = { min: 180, max: 440, default: 220 };

function sidebarWidth() {
  try {
    const w = Number(localStorage.getItem(SIDEBAR_W_KEY));
    if (w >= SIDEBAR_W.min && w <= SIDEBAR_W.max) return w;
  } catch {
    /* per-browser convenience only */
  }
  return SIDEBAR_W.default;
}

function setSidebarWidth(w, save) {
  w = Math.round(Math.min(SIDEBAR_W.max, Math.max(SIDEBAR_W.min, w)));
  $('.app')?.style.setProperty('--sidebar-w', `${w}px`);
  if (save) {
    try {
      if (w === SIDEBAR_W.default) localStorage.removeItem(SIDEBAR_W_KEY);
      else localStorage.setItem(SIDEBAR_W_KEY, String(w));
    } catch {
      /* not remembered */
    }
  }
}

function applySidebar() {
  setSidebarWidth(sidebarWidth(), false);
  const app = $('.app');
  const btn = $('#sidebar-btn');
  if (!app || !btn) return;
  const collapsed = sidebarCollapsed();
  app.classList.toggle('sidebar-collapsed', collapsed);
  const open = NARROW.matches ? S.view === 'sidebar' : !collapsed;
  btn.setAttribute('aria-expanded', String(open));
  const label = open ? 'Hide sidebar' : 'Show sidebar';
  btn.setAttribute('aria-label', label);
  btn.title = NARROW.matches ? label : `${label} (Ctrl-Cmd-S)`;
  $('#sidebar').inert = !NARROW.matches && collapsed;
}

function toggleSidebar() {
  if (NARROW.matches) return setView(S.view === 'sidebar' ? 'main' : 'sidebar');
  try {
    if (sidebarCollapsed()) localStorage.removeItem(SIDEBAR_KEY);
    else localStorage.setItem(SIDEBAR_KEY, 'hidden');
  } catch {
    /* not remembered, but still toggles below */
    $('.app').classList.toggle('sidebar-collapsed');
    return;
  }
  applySidebar();
}

NARROW.addEventListener('change', () => applySidebar());

// ---------------------------------------------------------------- appearance

const THEMES = { auto: 'Auto', light: 'Light', dark: 'Dark' };
const NEXT_THEME = { auto: 'light', light: 'dark', dark: 'auto' };

function themeButton() {
  const t = currentTheme();
  const next = NEXT_THEME[t];
  return `<button type="button" class="theme-btn" data-theme-set="${next}" aria-label="Appearance: ${THEMES[t]}. Switch to ${THEMES[next]}." title="Appearance: ${THEMES[t]} (click for ${THEMES[next]})">${ICON[{ auto: 'auto', light: 'sun', dark: 'moon' }[t]]}</button>`;
}

/** “at 9:58 PM” today, “on Oct 14 at 9:58 PM” otherwise. */
function syncStamp(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return `at ${time}`;
  return `on ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${time}`;
}

const THEME_KEY = 'ligature-theme';

function currentTheme() {
  try {
    return localStorage.getItem(THEME_KEY) || 'auto';
  } catch {
    return 'auto';
  }
}

function setTheme(theme) {
  try {
    if (theme === 'auto') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* not saved; still applies to this page */
  }
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  renderSidebar();
  mapView?.setTheme();
  if (S.detail && S.mode === 'view') drawHeroMap(S.detail);
}

// ---------------------------------------------------------------- data

async function loadContacts() {
  try {
    const [{ contacts, relationships }, archive] = await Promise.all([api('/contacts'), api('/archive')]);
    S.contacts = contacts;
    S.archived = archive.contacts;
    S.relationships = relationships ?? [];
    mapView?.invalidate();
    S.places = null;
  } catch (e) {
    return handleError(e);
  }
  renderSidebar();
  renderGrid();
}

async function refreshSession() {
  const prefs = S.session?.user?.prefs; // the table’s settings here may be newer than the server’s
  S.session = await api('/session');
  if (prefs && S.session.user) S.session.user.prefs = { ...S.session.user.prefs, views: prefs.views };
  renderSidebar();
}

async function sync({ quiet = false } = {}) {
  if (S.syncing) return;
  S.syncing = true;
  renderSidebar();
  try {
    const { results } = await api('/sync', { method: 'POST' });
    const failed = results.filter((r) => r.error);
    if (failed.length) handleError({ message: failed[0].error, code: failed[0].code });
    else if (!quiet) toast('Synced.', 2000);
    await refreshSession();
    await loadContacts();
    if (S.selectedId && S.mode === 'view') await loadDetail(S.selectedId);
  } catch (e) {
    handleError(e);
  } finally {
    S.syncing = false;
    renderSidebar();
    if (S.syncAgain) {
      S.syncAgain = false;
      syncSoon();
    }
  }
}

/** Everyone shown, with people shown together next to each other. */
function visibleContacts() {
  return visibleEntries().flat();
}

/**
 * The rows of the table: one per person, except people marked to show together, who share
 * one entry wherever the first of them sorts. A list or search only shows the members it matches.
 */
function visibleEntries() {
  const groups = togetherGroups(S.contacts, S.relationships);
  const shown = matchingContacts();
  const ids = new Set(shown.map((c) => c.id));
  const done = new Set();
  const out = [];
  for (const c of shown) {
    if (done.has(c.id)) continue;
    const members = (groups.get(c.id) ?? [c]).filter((m) => ids.has(m.id));
    for (const m of members) done.add(m.id);
    out.push(members);
  }
  return out;
}

const inArchive = () => S.filter.type === 'archive';

function matchingContacts() {
  const q = S.query.trim().toLowerCase();
  const f = S.filter;
  syncViewPrefs();
  // A list, plus everyone in its sublists when you’ve chosen to include them.
  const viewGroups = f.type === 'group' ? [f.id, ...(S.withSub ? descendantsOf(f.accountId, f.id) : [])] : [];
  return sortContacts(
    (inArchive() ? S.archived : S.contacts).filter((c) => {
      if (f.type === 'account' && c.accountId !== f.id) return false;
      if (f.type === 'group' && (c.accountId !== f.accountId || !viewGroups.some((g) => c.groups.includes(g)))) return false;
      if (c.draft && S.hideDrafts) return false;
      if (q && !q.split(/\s+/).every((w) => c.search.includes(w))) return false;
      return true;
    }),
  );
}

// ---------------------------------------------------------------- sidebar

function renderSidebar() {
  const el = $('#sidebar');
  if (!el || !S.session?.user) return;
  const { accounts, user } = S.session;
  const f = S.filter;
  const countFor = (pred) => S.contacts.filter(pred).length;
  const lastSync = Math.max(0, ...accounts.map((a) => a.lastSyncedAt || 0));
  const multi = accounts.length > 1;

  const groups = accounts.flatMap((a) =>
    a.groups.map((g) => ({ ...g, accountId: a.id, accountLabel: a.label, count: countFor((c) => c.accountId === a.id && c.groups.includes(g.id)) })),
  );

  el.innerHTML = `
    <div class="brand"><h1 class="logo" role="img" aria-label="Ligatures"></h1></div>

    <nav class="nav" aria-label="Accounts">
      <div class="nav-h">Accounts</div>
      <button class="nav-item" data-filter="all" aria-current="${f.type === 'all'}"><span>All Contacts</span><span class="count">${S.contacts.length}</span></button>
      ${accounts
        .map(
          (a) => `<button class="nav-item" data-filter="account" data-id="${h(a.id)}" aria-current="${f.type === 'account' && f.id === a.id}" title="${h(a.label && a.label !== a.providerName ? `${a.providerName} · ${a.label}` : a.providerName)}">
            <span>${h(a.label || a.providerName)}</span><span class="count">${countFor((c) => c.accountId === a.id)}</span></button>`,
        )
        .join('')}
      ${DEMO ? '' : `<a class="nav-add" href="/api/auth/google/start?link=1">${ICON.plus} Add Google Account</a>`}
    </nav>

    <nav class="nav" aria-label="Lists">
      <div class="nav-h-row"><div class="nav-h">Lists</div>${
        accounts.length ? `<button type="button" class="nav-h-btn" data-action="new-list" aria-label="New list" title="New List">${ICON.plus}</button>` : ''
      }</div>
      ${listTree(groups)
        .map(({ g, depth, kids, collapsed }) => {
          if (LE?.mode === 'rename' && LE.accountId === g.accountId && LE.id === g.id) return listNameForm(LE.value ?? g.name);
          const current = f.type === 'group' && f.id === g.id && f.accountId === g.accountId;
          return `<div class="nav-row${current ? ' current' : ''}" data-depth="${Math.min(depth, 8)}">
            ${
              kids
                ? `<button type="button" class="nav-twisty${collapsed ? ' collapsed' : ''}" data-action="list-toggle" data-id="${h(g.id)}" data-account="${h(g.accountId)}" aria-expanded="${!collapsed}" aria-label="${collapsed ? 'Show' : 'Hide'} lists inside ${h(g.name)}">${ICON.down}</button>`
                : ''
            }
            <button class="nav-item" data-filter="group" data-id="${h(g.id)}" data-account="${h(g.accountId)}" aria-current="${current}">
              <span>${listMark(g.accountId, g.id)}${h(g.name)}${multi ? ` <span class="count">· ${h(g.accountLabel)}</span>` : ''}${
                isPinned(g.accountId, g.id) ? `<span class="pin-mark" title="Pinned" aria-label="Pinned">${ICON.pin}</span>` : ''
              }</span><span class="count">${g.count}</span></button>
            <button type="button" class="nav-more" data-action="list-menu" data-id="${h(g.id)}" data-account="${h(g.accountId)}" aria-label="Options for ${h(g.name)}" title="${g.system ? 'Pin, color or icon' : 'Pin, color, icon, rename or delete'}">${ICON.more}</button>
          </div>`;
        })
        .join('')}
      ${LE?.mode === 'create' ? listNameForm(LE.value ?? '') : ''}
      ${!groups.length && LE?.mode !== 'create' ? '<div class="nav-empty">No lists yet.</div>' : ''}
    </nav>

    ${
      S.archived.length || f.type === 'archive'
        ? `<nav class="nav" aria-label="Archive"><button class="nav-item" data-filter="archive" aria-current="${f.type === 'archive'}"><span>Archived</span><span class="count">${S.archived.length}</span></button></nav>`
        : ''
    }

    ${
      DEMO
        ? `<div class="sync-line demo">
      <span class="dot" aria-hidden="true"></span>
      <span class="tip-wrap">
        <button type="button" class="tip-btn sync-when" aria-describedby="sync-tip">Demo mode</button>
        <span class="tip" role="tooltip" id="sync-tip">Made-up contacts, kept only in this tab. Nothing you do here reaches Google or your real contacts. Reloading starts the demo over.</span>
      </span>
      <button class="link sync-now" data-action="demo-off">Exit Demo</button>
    </div>`
        : `<div class="sync-line${S.syncing ? ' syncing' : ''}">
      <span class="dot" aria-hidden="true"></span>
      <span class="tip-wrap">
        <button type="button" class="tip-btn sync-when" aria-describedby="sync-tip">${S.syncing ? 'Syncing…' : `Synced ${ago(lastSync)}`}</button>
        <span class="tip" role="tooltip" id="sync-tip">Synced with Google${lastSync ? ` ${h(syncStamp(lastSync))}` : ''}. Edits go to Google Contacts and reach your iPhone and Mac. Your own fields stay in Ligatures.</span>
      </span>
      ${S.syncing ? '' : '<button class="link sync-now" data-action="sync">Sync Now</button>'}
    </div>`
    }

    <div class="sidebar-foot">
      <button class="link" data-action="fields">Your Fields…</button>
      <button class="link" data-action="shortcuts" title="Keyboard shortcuts (?)">Shortcuts</button>
      <button class="link" data-action="font">Font…</button>
      ${
        DEMO
          ? ''
          : `<a class="link" href="/api/backup" download title="Downloads everything Ligatures keeps for you, as one file">Download Backup</a>
      <button class="link" data-action="demo-on" title="Show made-up contacts instead of yours, to try things or show Ligatures to someone">Demo Mode</button>
      <button class="link" data-action="logout">Sign Out</button>`
      }
      ${themeButton()}
    </div>`;
}

// ---------------------------------------------------------------- table

const COL_MIN = 60;
const CHECK_W = 40;
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function shortDate(ts) {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** YYYY-MM-DD → “Oct 14”, with the year only when it isn’t this year. */
function shortDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return iso || '';
  return shortDate(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime());
}

/** Ask Google for a small square version of a contact photo. */
/** Google photo URLs take a size; ask for a large one (Google never upscales past the original). */
function largePhoto(url) {
  return /googleusercontent\.com/.test(url) ? url.replace(/=s\d+(-c)?$/, '') + '=s1200' : url;
}

function enlargePhoto() {
  const c = S.detail?.card;
  const dlg = $('#photo-dlg');
  if (!c?.photoUrl || !dlg) return;
  dlg.setAttribute('aria-label', `Photo of ${c.displayName || 'contact'}`);
  dlg.innerHTML = `<img src="${h(largePhoto(c.photoUrl))}" alt="${h(c.displayName || 'Contact photo')}" referrerpolicy="no-referrer">
    <button type="button" class="photo-close" aria-label="Close" title="Close (Esc)">${ICON.x}</button>`;
  // If Google won’t serve the large size, fall back to the photo as shown in the panel.
  const img = dlg.querySelector('img');
  img.addEventListener('error', () => (img.src = c.photoUrl), { once: true });
  dlg.showModal();
}

function thumb(url) {
  // Big enough for the photo size you’ve chosen, on a sharp screen.
  const px = S.photoSize > 32 ? 240 : 64;
  return /googleusercontent\.com/.test(url) ? url.replace(/=s\d+(-c)?$/, '') + `=s${px}-c` : url;
}

// ---- photo size in the table (a slider next to Table | Map)
const PHOTO_KEY = 'ligature-photo-size';
const PHOTO = { min: 22, max: 96, default: 22 };
S.photoSize = (() => {
  try {
    const v = Number(localStorage.getItem(PHOTO_KEY));
    return v >= PHOTO.min && v <= PHOTO.max ? v : PHOTO.default;
  } catch {
    return PHOTO.default;
  }
})();

const CELL_LINE = 18; // px, the line height of wrapped table text

function applyPhotoSize() {
  const app = $('.app');
  if (!app) return;
  app.style.setProperty('--av', `${S.photoSize}px`);
  // Rows tall enough for more than one line wrap their text onto as many lines as fit.
  const row = Math.max(32, S.photoSize + 8);
  const lines = Math.max(1, Math.floor((row - 6) / CELL_LINE));
  app.style.setProperty('--lines', String(lines));
  app.classList.toggle('wrap-cells', lines > 1);
}

function setPhotoSize(v, done) {
  const before = S.photoSize;
  S.photoSize = Math.min(PHOTO.max, Math.max(PHOTO.min, Math.round(v)));
  applyPhotoSize();
  if (!done) return;
  try {
    if (S.photoSize === PHOTO.default) localStorage.removeItem(PHOTO_KEY);
    else localStorage.setItem(PHOTO_KEY, String(S.photoSize));
  } catch {
    /* not remembered */
  }
  // Crossing into larger sizes needs sharper photos.
  if ((before > 32) !== (S.photoSize > 32) || done === 'force') renderGrid();
}

function nameKey(c) {
  if (S.nameSort === 'first') return `${c.givenName || c.familyName || c.displayName || ''} ${c.familyName || ''}`.trim().toLowerCase();
  return `${c.familyName || c.givenName || c.displayName || ''} ${c.givenName || ''}`.trim().toLowerCase();
}

const neighborhoodField = () => S.session.fields.find((f) => f.key === 'neighborhood');

/** The first address on one line, with the neighborhood (if any) in front of the city. */
function addressLine(c) {
  const p = c.addressParts;
  const hoodId = neighborhoodField()?.id;
  const hood = p?.hood && hoodId ? (c.fields?.[hoodId] ?? '').trim() : '';
  if (!p || !hood) return c.address;
  const city = [hood, [p.city, p.rest].filter(Boolean).join(p.city && p.rest ? ', ' : '')].filter(Boolean).join(', ');
  return [p.street, city, p.country].filter(Boolean).join(', ');
}

// ---- List-specific fields: shown only on people in that list, and as columns while viewing it.

const fieldList = (f) => (f.listId ? accountById(f.accountId)?.groups.find((g) => g.id === f.listId) ?? null : null);
const fieldListName = (f) => fieldList(f)?.name ?? f.listName ?? 'a list';
/** Whether a field belongs on a contact: every-contact fields always; a list’s fields if they’re on it. */
const fieldApplies = (f, accountId, groups) => !f.listId || (f.accountId === accountId && (groups ?? []).includes(f.listId));
const fieldOnView = (f) => !f.listId || (S.filter.type === 'group' && S.filter.id === f.listId && S.filter.accountId === f.accountId);

/** Every column the table can show: built-ins, then your own fields (a list’s own fields only
 *  while you’re viewing that list, unless `all`). */
function columnDefs(all = false) {
  const tel = (v) => `tel:${v.replace(/[^\d+]/g, '')}`;
  const oneLine = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  return [
    { id: 'name', label: 'Name', w: 220, fixed: true, text: (c) => c.displayName || 'No name', sort: nameKey },
    { id: 'first', label: 'First name', w: 130, text: (c) => c.givenName },
    { id: 'last', label: 'Last name', w: 140, text: (c) => c.familyName },
    { id: 'company', label: 'Company', w: 180, text: (c) => c.organization },
    { id: 'title', label: 'Job title', w: 160, text: (c) => c.title },
    { id: 'email', label: 'Email', w: 230, text: (c) => c.email, href: (c) => c.email && `mailto:${c.email}` },
    { id: 'phone', label: 'Phone', w: 175, nums: true, text: (c) => c.phone, href: (c) => c.phone && tel(c.phone) },
    { id: 'address', label: 'Address', w: 260, text: addressLine },
    { id: 'birthday', label: 'Birthday', w: 140, text: (c) => c.birthday, sort: (c) => c.birthdayKey },
    { id: 'lists', label: 'Lists', w: 180, text: (c) => (accountById(c.accountId)?.groups ?? []).filter((g) => c.groups.includes(g.id)).map((g) => g.name).join(', ') },
    { id: 'notes', label: 'Notes', w: 260, text: (c) => oneLine(c.notes) },
    ...S.session.fields.filter((f) => all || fieldOnView(f)).map((f) => ({
      id: `f:${f.id}`,
      label: f.label,
      own: true,
      field: f,
      nums: f.type === 'date',
      w: f.type === 'checkbox' ? 100 : f.type === 'date' ? 130 : f.type === 'longtext' ? 260 : 180,
      text: (c) => {
        const v = c.fields?.[f.id] ?? '';
        if (f.type === 'checkbox') return v === '1' ? '✓' : '';
        return f.type === 'date' ? shortDay(v) : oneLine(v);
      },
      sort: (c) => c.fields?.[f.id] ?? '',
      href:
        f.type === 'url'
          ? (c) => {
              const v = c.fields?.[f.id];
              return v ? (/^https?:\/\//i.test(v) ? v : `https://${v}`) : '';
            }
          : null,
    })),
  ];
}

function defaultColumns() {
  const field = (re) => S.session.fields.find((f) => re.test(f.label.trim()));
  const fu = field(/^follow up$/i);
  return ['name', 'company', 'email', 'phone', 'lists', fu && `f:${fu.id}`]
    .filter(Boolean)
    .map((id) => ({ id }));
}

/** Which view’s table settings apply: each list, account, All Contacts and Archived has its own. */
function viewKey(f = S.filter) {
  if (f.type === 'group') return `list:${f.accountId}:${f.id}`;
  if (f.type === 'account') return `account:${f.id}`;
  return f.type === 'archive' ? 'archive' : 'all';
}

/**
 * Columns, widths and sort for the current view, saved on the server so they follow you between
 * devices. Each view is separate; one you haven’t changed starts from your original setup (plus a
 * list’s own fields).
 */
function loadPrefs() {
  const p = S.session.user.prefs || {};
  const key = viewKey();
  const legacy = { columns: p.columns, sort: p.sort, nameSort: p.nameSort };
  const views = p.views || {};
  // A view you haven’t changed starts from the setup you had before views were separate
  // (frozen, so changing one view never changes another), or the defaults.
  const v = views[key] ?? legacy;
  const known = new Set(columnDefs(true).map((c) => c.id));
  let cols = Array.isArray(v.columns)
    ? v.columns.filter((c) => c && known.has(c.id)).map((c) => (Number(c.w) >= COL_MIN ? { id: c.id, w: Number(c.w) } : { id: c.id }))
    : [];
  if (!cols.length) cols = defaultColumns();
  if (!views[key] && S.filter.type === 'group') {
    for (const f of S.session.fields) {
      if (f.listId && fieldOnView(f) && !cols.some((c) => c.id === `f:${f.id}`)) cols.push({ id: `f:${f.id}` });
    }
  }
  S.cols = [cols.find((c) => c.id === 'name') ?? { id: 'name' }, ...cols.filter((c) => c.id !== 'name')];
  S.sort = v.sort && known.has(v.sort.id) ? { id: v.sort.id, dir: v.sort.dir === 'desc' ? 'desc' : 'asc' } : { id: 'name', dir: 'asc' };
  S.nameSort = v.nameSort === 'first' ? 'first' : 'last';
  S.withSub = views[key]?.withSub === true; // off unless you’ve turned it on for this list
  S.hideDrafts = views[key]?.hideDrafts === true; // drafts show unless you hide them here
  S.prefsView = key;
}

/** Switches the table’s settings when you move to another list or view. */
function syncViewPrefs() {
  if (S.session?.user && S.prefsView !== viewKey()) loadPrefs();
}

window.matchMedia('(max-width: 820px)').addEventListener('change', () => applyWidths());

let prefsTimer;
function savePrefs() {
  // Saved under the view they belong to, right away, so switching lists can’t mix them up.
  const prefs = (S.session.user.prefs = S.session.user.prefs || {});
  prefs.views = {
    ...(prefs.views || {}),
    [S.prefsView ?? viewKey()]: {
      columns: S.cols.map((c) => (c.w ? { id: c.id, w: Math.round(c.w) } : { id: c.id })),
      sort: S.sort,
      nameSort: S.nameSort,
      ...(S.withSub ? { withSub: true } : {}),
      ...(S.hideDrafts ? { hideDrafts: true } : {}),
    },
  };
  clearTimeout(prefsTimer);
  // Only the key the table owns, so the iPhone’s settings (pinned lists) aren’t overwritten.
  prefsTimer = setTimeout(() => api('/prefs', { method: 'PATCH', body: { set: { views: prefs.views } } }).catch(handleError), 500);
}

function activeColumns() {
  syncViewPrefs();
  const defs = new Map(columnDefs().map((d) => [d.id, d]));
  return S.cols.filter((c) => defs.has(c.id)).map((c) => ({ ...defs.get(c.id), w: c.w || defs.get(c.id).w }));
}

function sortContacts(list) {
  syncViewPrefs();
  const defs = columnDefs();
  const def = defs.find((d) => d.id === S.sort.id) ?? defs[0];
  const key = def.sort ?? def.text;
  const dir = S.sort.dir === 'desc' ? -1 : 1;
  const rows = list.map((c) => ({ c, k: key(c), n: nameKey(c) }));
  rows.sort((a, b) => {
    // Blanks always sink to the bottom, whichever way you sort.
    const ea = a.k === '' || a.k == null;
    const eb = b.k === '' || b.k == null;
    if (ea !== eb) return ea ? 1 : -1;
    let r = 0;
    if (!ea) r = typeof a.k === 'number' && typeof b.k === 'number' ? a.k - b.k : collator.compare(String(a.k), String(b.k));
    return r * dir || collator.compare(a.n, b.n);
  });
  return rows.map((r) => r.c);
}

function viewTitle() {
  const f = S.filter;
  if (f.type === 'group') return S.session.accounts.flatMap((a) => a.groups).find((g) => g.id === f.id)?.name ?? 'List';
  if (f.type === 'account') return S.session.accounts.find((a) => a.id === f.id)?.label ?? 'Account';
  return 'All Contacts';
}

function sortTitle(c) {
  if (c.id === 'name') return `Sort by ${S.nameSort} name`;
  return `Sort by ${c.label}. Drag to move.`;
}

// ---------------------------------------------------------------- header: name sort menu, hide, drag to move

function nameMenu() {
  let m = $('#name-menu');
  if (!m) {
    m = document.createElement('div');
    m.id = 'name-menu';
    m.className = 'menu';
    m.popover = 'auto';
    m.setAttribute('role', 'menu');
    m.setAttribute('aria-label', 'Sort names by');
    document.body.append(m);
    m.addEventListener('beforetoggle', (e) => {
      if (e.newState === 'open') fillNameMenu(m);
    });
    m.addEventListener('toggle', (e) => {
      const btn = $('#name-menu-btn');
      btn?.setAttribute('aria-expanded', String(e.newState === 'open'));
      if (e.newState !== 'open' || !btn) return;
      const r = btn.getBoundingClientRect();
      m.style.top = `${Math.round(r.bottom + 4)}px`;
      m.style.left = `${Math.round(Math.max(8, Math.min(r.right - m.offsetWidth, window.innerWidth - m.offsetWidth - 8)))}px`;
      m.querySelector('[aria-checked="true"]')?.focus();
    });
  }
  return m;
}

function fillNameMenu(m) {
  m.innerHTML = [
    ['last', 'Last name'],
    ['first', 'First name'],
  ]
    .map(
      ([v, label]) =>
        `<button type="button" role="menuitemradio" aria-checked="${S.nameSort === v}" data-name-sort="${v}"><span class="menu-check">${S.nameSort === v ? ICON.check : ''}</span>${label}</button>`,
    )
    .join('');
}

function setNameSort(v) {
  S.nameSort = v;
  S.sort = { id: 'name', dir: S.sort.id === 'name' ? S.sort.dir : 'asc' };
  $('#name-menu')?.hidePopover();
  renderGrid();
  savePrefs();
  $('#name-menu-btn')?.focus();
}

function hideColumn(id) {
  if (id === 'name') return;
  S.cols = S.cols.filter((c) => c.id !== id);
  if (S.sort.id === id) S.sort = { id: 'name', dir: 'asc' };
  columnsChanged();
  const label = columnDefs().find((d) => d.id === id)?.label ?? 'Column';
  toast(`Hid ${label}. Add it back in Columns.`, 2500);
}

// Drag a header (not its edge) sideways to move the column. Name stays first.
let suppressHeaderClick = false;
document.addEventListener('pointerdown', (e) => {
  const btn = e.target.closest('#grid thead .th-btn');
  if (!btn || e.button !== 0 || e.pointerType === 'touch') return;
  const th = btn.closest('th');
  const id = th.dataset.col;
  if (id === 'name') return;
  const wrap = $('#grid-wrap');
  const startX = e.clientX;
  let dragging = false;
  let target = null;
  let line = null;

  const headers = () => [...document.querySelectorAll('#grid thead th[data-col]')].filter((x) => x.dataset.col !== 'name');
  const move = (ev) => {
    if (!dragging) {
      if (Math.abs(ev.clientX - startX) < 5) return;
      dragging = true;
      btn.setPointerCapture(ev.pointerId);
      th.classList.add('col-dragging');
      document.body.classList.add('moving-col');
      line = document.createElement('div');
      line.className = 'col-drop';
      document.body.append(line);
    }
    // Scroll the table when you drag near its edges.
    const wr = wrap.getBoundingClientRect();
    if (ev.clientX > wr.right - 40) wrap.scrollLeft += 16;
    else if (ev.clientX < wr.left + 40 + CHECK_W) wrap.scrollLeft -= 16;
    // Drop before the first header whose middle is right of the pointer.
    const hs = headers();
    const others = hs.filter((x) => x !== th);
    const before = others.find((x) => {
      const r = x.getBoundingClientRect();
      return ev.clientX < r.left + r.width / 2;
    });
    target = before ? before.dataset.col : null; // null: the end
    const ref = before ?? others[others.length - 1];
    const r = ref.getBoundingClientRect();
    const x = before ? r.left : r.right;
    const head = $('#grid thead').getBoundingClientRect();
    line.style.left = `${Math.round(Math.max(x, $('#grid thead th.c-name').getBoundingClientRect().right) - 1)}px`;
    line.style.top = `${Math.round(head.top)}px`;
    line.style.height = `${Math.round(Math.min(wr.bottom, window.innerHeight) - head.top)}px`;
  };
  const up = (ev) => {
    btn.removeEventListener('pointermove', move);
    btn.removeEventListener('pointerup', up);
    btn.removeEventListener('pointercancel', up);
    if (!dragging) return;
    th.classList.remove('col-dragging');
    document.body.classList.remove('moving-col');
    line?.remove();
    suppressHeaderClick = true;
    setTimeout(() => (suppressHeaderClick = false), 0);
    if (ev.type === 'pointercancel') return;
    const from = S.cols.findIndex((c) => c.id === id);
    const [entry] = S.cols.splice(from, 1);
    const to = target ? S.cols.findIndex((c) => c.id === target) : S.cols.length;
    S.cols.splice(Math.max(1, to), 0, entry);
    if (to !== from) columnsChanged();
    else renderGrid();
  };
  btn.addEventListener('pointermove', move);
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
});

function renderGrid() {
  syncViewPrefs();
  const table = $('#grid');
  if (!table) return;
  nameMenu();
  const items = visibleContacts();
  const cols = activeColumns();
  $('#view-title').textContent = viewTitle();
  $('#list-count').textContent = `${items.length} ${items.length === 1 ? 'contact' : 'contacts'}`;
  const dt = $('#drafts-toggle');
  if (dt) {
    // Shown wherever this view has drafts (hidden or not).
    const was = S.hideDrafts;
    S.hideDrafts = false;
    const any = matchingContacts().some((c) => c.draft);
    S.hideDrafts = was;
    dt.hidden = !any;
    dt.querySelector('input').checked = !S.hideDrafts;
  }
  const sub = $('#sub-toggle');
  const hasSubs = S.filter.type === 'group' && descendantsOf(S.filter.accountId, S.filter.id).length > 0;
  if (sub) {
    sub.hidden = !hasSubs;
    sub.querySelector('input').checked = !!S.withSub;
  }

  const ind = (id) => (S.sort.id === id ? (S.sort.dir === 'asc' ? ICON.up : ICON.down) : '');
  const head = `<thead><tr>
      <th class="c-check" scope="col"><input type="checkbox" id="check-all" aria-label="Select everyone shown"></th>
      ${cols
        .map(
          (c) => `<th scope="col" data-col="${h(c.id)}" class="${c.id === 'name' ? 'c-name' : ''}${c.nums ? ' nums' : ''}"
            aria-sort="${S.sort.id === c.id ? (S.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">
            <button type="button" class="th-btn" data-sort="${h(c.id)}" title="${h(sortTitle(c))}"><span>${h(c.label)}</span><span class="sort-ind" aria-hidden="true">${ind(c.id)}</span></button>
            ${
              c.id === 'name'
                ? `<button type="button" class="th-menu" id="name-menu-btn" popovertarget="name-menu" aria-haspopup="menu" aria-expanded="false" aria-label="Sort names by" title="Sort by first or last name">${S.nameSort === 'first' ? 'First' : 'Last'}${ICON.down}</button>`
                : `<button type="button" class="th-remove" data-remove-col="${h(c.id)}" aria-label="Hide the ${h(c.label)} column" title="Hide column">${ICON.x}</button>`
            }
            <span class="col-resize" data-resize="${h(c.id)}" title="Drag to resize. Double-click to reset." aria-hidden="true"></span></th>`,
        )
        .join('')}
      <th class="c-fill" aria-hidden="true"></th></tr></thead>`;

  let body;
  if (!items.length) {
    const msg = S.contacts.length ? 'No matches.' : S.syncing ? 'Loading your contacts…' : 'No contacts yet.';
    body = `<tbody><tr class="empty-row"><td colspan="${cols.length + 2}">${msg}</td></tr></tbody>`;
  } else {
    body = `<tbody>${visibleEntries()
      .map((members) => members.map((c, j) => gridRow(c, j, members, cols)).join(''))
      .join('')}</tbody>`;
  }
  const colgroup = `<colgroup><col class="c-check">${cols.map((c) => `<col data-col="${h(c.id)}">`).join('')}<col class="c-fill"></colgroup>`;
  table.innerHTML = colgroup + head + body;
  applyWidths(cols);
  syncChecks();
  if (cellEdit) remountCellEdit();
  if (S.layout === 'map') mapView?.update();
}

/** One person’s row. People shown together share the checkbox and name cells of the first row. */
function gridRow(c, j, members, cols) {
  const together = members.length > 1;
  const open = S.drawer && c.id === S.selectedId;
  const ids = members.map((m) => m.id);
  const span = together ? ` rowspan="${members.length}"` : '';
  const av = (m) =>
    `<span class="mini-av" aria-hidden="true">${
      m.photoUrl ? `<img src="${h(thumb(m.photoUrl))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : h(initials(m))
    }</span>`;
  const cells = cols
    .map((col) => {
      const v = String(col.text(c) ?? '');
      if (col.id === 'name') {
        if (j > 0) return '';
        const name = together ? togetherName(members) : v;
        const avs = together ? `<span class="av-stack">${members.map(av).join('')}</span>` : av(c);
        return `<td class="c-name"${span} data-ids="${h(ids.join(' '))}"${together ? ` title="${h(name)}"` : ''}><button type="button" class="cell-open" data-open="${h(c.id)}" draggable="${inArchive() ? 'false' : 'true'}">${avs}<span class="cell-name">${h(name)}</span>${
          members.some((m) => m.draft) ? '<span class="draft-tag" title="Only in Ligatures, not in Google Contacts">Draft</span>' : ''
        }</button></td>`;
      }
      const tip = together ? `${c.displayName || 'No name'}: ${v}` : v;
      const title = (together && v) || v.length > 20 ? ` title="${h(tip)}"` : '';
      const href = v && col.href ? col.href(c) : '';
      let inner = href
        ? `<a href="${h(href)}"${/^https?:/i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : ''}>${h(v)}</a>`
        : h(v);
      if (v && (col.id === 'email' || col.id === 'phone')) inner = `<span class="copyable">${inner}${copyBtn(v, col.id === 'email' ? 'email' : 'number')}</span>`;
      else if (v) inner = `<span class="clamp">${inner}</span>`;
      if (col.id === 'lists') {
        const badges = contactLists(c.accountId, c.groups).map((g) => listBadge(c.accountId, g)).join('');
        return `<td class="editable lists-cell" data-lists="${h(c.id)}"${title}><span class="list-badges">${badges}</span></td>`;
      }
      if (col.field) return `<td class="editable${col.nums ? ' nums' : ''}" data-edit="${h(col.field.id)}"${title}>${inner}</td>`;
      return `<td class="${col.nums ? 'nums' : ''}"${title}>${inner}</td>`;
    })
    .join('');
  const cls = [open ? 'open' : '', c.draft ? 'is-draft' : '', S.selected.has(c.id) ? 'checked' : '', together ? 'grp' : '', together && j === members.length - 1 ? 'grp-last' : '']
    .filter(Boolean)
    .join(' ');
  const label = together ? togetherName(members) : c.displayName || 'contact';
  const check = j > 0 ? '' : `<td class="c-check"${span}><input type="checkbox" data-check="${h(ids.join(' '))}" aria-label="Select ${h(label)}"></td>`;
  return `<tr data-id="${h(c.id)}" class="${cls}"${open ? ' aria-current="true"' : ''}>${check}${cells}<td class="c-fill"></td></tr>`;
}

/** Widths go on through the DOM: the page’s security policy blocks inline style attributes. */
function applyWidths(cols = activeColumns()) {
  const table = $('#grid');
  if (!table) return;
  // Saved widths follow you between devices; on a phone the pinned Name column stays narrow.
  const narrow = window.matchMedia('(max-width: 820px)').matches;
  let total = CHECK_W;
  for (const c of cols) {
    const w = narrow && c.id === 'name' ? Math.min(c.w, 150) : c.w;
    const col = table.querySelector(`col[data-col="${CSS.escape(c.id)}"]`);
    if (col) col.style.width = `${w}px`;
    total += w;
  }
  table.style.minWidth = `${total}px`;
}

function bodyRows() {
  return [...($('#grid')?.tBodies[0]?.rows ?? [])].filter((tr) => tr.dataset.id);
}

/** Reflect the selection in the table and toolbar without rebuilding the table. */
function syncChecks() {
  const rows = bodyRows();
  let on = 0;
  for (const tr of rows) {
    const checked = S.selected.has(tr.dataset.id);
    if (checked) on++;
    tr.classList.toggle('checked', checked);
  }
  for (const cb of document.querySelectorAll('#grid [data-check]')) {
    const ids = cb.dataset.check.split(' ');
    const n = ids.filter((id) => S.selected.has(id)).length;
    cb.checked = n === ids.length;
    cb.indeterminate = n > 0 && n < ids.length;
  }
  const all = $('#check-all');
  if (all) {
    all.checked = rows.length > 0 && on === rows.length;
    all.indeterminate = on > 0 && on < rows.length;
  }
  const n = S.selected.size;
  const tools = $('#sel-tools');
  if (tools) {
    const head = `<span class="sel-count">${n} selected</span><button type="button" class="link" data-action="clear-select">Clear</button>`;
    tools.innerHTML = !n
      ? ''
      : inArchive()
        ? `${head}<button type="button" class="btn" data-action="restore-selected">Restore</button>
           <button type="button" class="btn danger" data-action="forget-selected">Delete Forever…</button>`
        : `${head}<button type="button" class="btn" id="lists-sel-btn" data-action="lists-selected" aria-haspopup="menu">Lists${ICON.down}</button>
           <button type="button" class="btn" data-action="archive-selected">Archive</button>
           <button type="button" class="btn danger" data-action="delete-selected">Delete…</button>`;
  }
  const msg = $('#msg-btn');
  if (msg) {
    msg.textContent = n ? `Message ${n}` : 'Message All';
    msg.hidden = inArchive(); // archived people aren’t in Google, so there’s nothing to message
  }
  const addBtn = $('#add-to-list-btn');
  if (addBtn) addBtn.hidden = !currentList();
  if (S.layout === 'map') mapView?.refreshSelection();
}

function markOpen() {
  for (const tr of bodyRows()) {
    const on = S.drawer && tr.dataset.id === S.selectedId;
    tr.classList.toggle('open', on);
    if (on) tr.setAttribute('aria-current', 'true');
    else tr.removeAttribute('aria-current');
  }
}

// ---------------------------------------------------------------- detail panel

function setDrawer(open) {
  S.drawer = open;
  const d = $('#detail');
  if (!d) return;
  d.classList.toggle('open', open);
  d.inert = !open;
  markOpen();
}

async function select(id) {
  if (S.mode !== 'view' && !(await confirmDiscard())) return;
  draft = null;
  S.mode = 'view';
  S.selectedId = id;
  setDrawer(true);
  renderDetail();
  await loadDetail(id);
}

async function closeDrawer() {
  if (S.mode !== 'view' && !(await confirmDiscard())) return false;
  draft = null;
  S.mode = 'view';
  setDrawer(false);
  if (S.selectedId) $(`[data-open="${CSS.escape(S.selectedId)}"]`)?.focus({ preventScroll: true });
  return true;
}

function moveSelection(step) {
  const items = visibleContacts();
  if (!items.length) return;
  const i = items.findIndex((c) => c.id === S.selectedId);
  const next = items[i < 0 ? 0 : Math.max(0, Math.min(items.length - 1, i + step))];
  const btn = $(`[data-open="${CSS.escape(next.id)}"]`);
  btn?.focus({ preventScroll: true });
  btn?.closest('tr')?.scrollIntoView({ block: 'nearest' });
  if (S.drawer) select(next.id);
  else S.selectedId = next.id;
}

async function loadDetail(id) {
  try {
    const d = await api(`/contacts/${encodeURIComponent(id)}`);
    if (S.selectedId !== id) return;
    S.detail = d;
    if (d.id !== id) {
      S.selectedId = d.id; // followed a merge
      markOpen();
    }
  } catch (e) {
    S.detail = null;
    handleError(e);
  }
  renderDetail();
}

// ---------------------------------------------------------------- columns dialog

function renderColumnsDialog() {
  const dlg = $('#columns-dlg');
  const defs = columnDefs();
  const byId = new Map(defs.map((d) => [d.id, d]));
  const shown = S.cols.filter((c) => byId.has(c.id)).map((c) => byId.get(c.id));
  const hidden = defs.filter((d) => !S.cols.some((c) => c.id === d.id));
  const item = (d, on, i) => `<li class="col-item${on ? '' : ' off'}" data-col-item="${h(d.id)}"${on && !d.fixed ? ' draggable="true"' : ''}>
      <span class="grip" aria-hidden="true">${on && !d.fixed ? ICON.grip : ''}</span>
      <label><input type="checkbox" data-col-toggle="${h(d.id)}" ${on ? 'checked' : ''} ${d.fixed ? 'disabled' : ''}>
        <span>${h(d.label)}${d.own ? ' <span class="muted">· your field</span>' : ''}${d.fixed ? ' <span class="muted">· always shown</span>' : ''}</span></label>
      ${
        on && !d.fixed
          ? `<span class="col-move">
              <button type="button" class="icon-btn" data-col-move="-1" data-id="${h(d.id)}" aria-label="Move ${h(d.label)} up" ${i <= 1 ? 'disabled' : ''}>${ICON.up}</button>
              <button type="button" class="icon-btn" data-col-move="1" data-id="${h(d.id)}" aria-label="Move ${h(d.label)} down" ${i >= shown.length - 1 ? 'disabled' : ''}>${ICON.down}</button>
            </span>`
          : ''
      }
    </li>`;
  dlg.innerHTML = `
    <form method="dialog" class="dlg">
      <h2 id="columns-title">Columns</h2>
      <p>Tick the columns to show. Drag or use the arrows to reorder; the top of the list is the left of the table. Drag a column’s edge in the table to resize it, and click a heading to sort.</p>
      <ul class="col-list" id="col-shown">${shown.map((d, i) => item(d, true, i)).join('')}</ul>
      ${hidden.length ? `<div class="col-h">Hidden</div><ul class="col-list">${hidden.map((d) => item(d, false)).join('')}</ul>` : ''}
      <div class="dlg-foot"><button type="button" class="btn" data-action="cols-reset">Reset</button><span class="grow"></span><button class="btn primary" value="close">Done</button></div>
    </form>`;
}

function columnsChanged(focusSelector) {
  renderColumnsDialog();
  renderGrid();
  savePrefs();
  if (focusSelector) $(focusSelector)?.focus();
}

let dragCol = null;

// ---------------------------------------------------------------- copy buttons

/** A copy button for an email address or phone number. */
function copyBtn(value, what, cls = 'copy-btn') {
  // On a pill (“Call”, “Email”) the value isn’t shown, so “Copied” names it.
  return `<button type="button" class="${cls}" data-copy="${h(value)}"${cls === 'pill-copy' ? ' data-copy-say' : ''} aria-label="Copy ${what} ${h(value)}" title="Copy ${what}">${ICON.copy}</button>`;
}

let copiedTimer;
/**
 * “Copied”, in a small bubble just above the button. A popover, so it shows over open dialogs
 * (the full-screen map) too.
 */
function copiedTip(btn, text = 'Copied') {
  let tip = $('#copied-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'copied-tip';
    tip.className = 'copied-tip';
    tip.setAttribute('popover', 'manual');
    tip.setAttribute('role', 'status');
    document.body.append(tip);
  }
  tip.textContent = text;
  if (tip.matches(':popover-open')) tip.hidePopover();
  tip.classList.remove('gone');
  tip.showPopover();
  const r = btn.getBoundingClientRect();
  tip.style.left = `${Math.round(Math.max(8, Math.min(innerWidth - tip.offsetWidth - 8, r.left + r.width / 2 - tip.offsetWidth / 2)))}px`;
  tip.style.top = `${Math.round(r.top - tip.offsetHeight - 8)}px`;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    tip.classList.add('gone');
    copiedTimer = setTimeout(() => tip.hidePopover(), 200);
  }, 1200);
}

async function copyClick(btn) {
  const value = btn.dataset.copy;
  if (!(await copyText(value))) return toast('Couldn’t copy. Select the text and copy it.', 3000);
  copiedTip(btn, 'copySay' in btn.dataset ? `Copied ${value}` : 'Copied');
  btn.innerHTML = ICON.check;
  btn.classList.add('copied');
  setTimeout(() => {
    btn.innerHTML = ICON.copy;
    btn.classList.remove('copied');
  }, 1500);
}

// ---------------------------------------------------------------- lists (Google labels)
// Create, rename and delete lists in the sidebar; add and remove people from the
// Lists button (ticked rows), the Lists cell in the table, or the panel. All go to Google.

let LE = null; // sidebar list name being edited: { mode: 'create' | 'rename', accountId, id? }
let LM = null; // list whose ⋯ menu is open: { accountId, id }
let LP = null; // list picker: { ids, anchor, creating }

function accountById(id) {
  return S.session.accounts.find((a) => a.id === id);
}

/** Pinned lists first, in the order they were pinned; then the rest as before. */
// ---- nested lists (only in Ligature; Google’s labels stay flat)

function listParents() {
  const p = S.session.user.prefs?.listParents;
  return Array.isArray(p) ? p.filter((x) => x && typeof x.id === 'string' && typeof x.accountId === 'string' && typeof x.parentId === 'string') : [];
}

/** A list’s parent, if it has one that still exists. */
function parentOf(accountId, id) {
  const e = listParents().find((x) => x.accountId === accountId && x.id === id);
  if (!e || e.parentId === id || !accountById(accountId)?.groups.some((g) => g.id === e.parentId)) return null;
  // A loop (which saving never makes) would hide lists; treat it as top level.
  const seen = new Set([id]);
  for (let p = e.parentId; p; ) {
    if (seen.has(p)) return null;
    seen.add(p);
    const up = listParents().find((x) => x.accountId === accountId && x.id === p);
    p = up && accountById(accountId)?.groups.some((g) => g.id === up.parentId) ? up.parentId : null;
  }
  return e.parentId;
}

/** Every list inside this one, all the way down. */
function descendantsOf(accountId, id) {
  const groups = accountById(accountId)?.groups ?? [];
  const out = [];
  const walk = (pid) => {
    for (const g of groups) {
      if (g.id !== id && !out.includes(g.id) && parentOf(accountId, g.id) === pid) {
        out.push(g.id);
        walk(g.id);
      }
    }
  };
  walk(id);
  return out;
}

const COLLAPSED_KEY = 'ligature-collapsed-lists';
const collapsedLists = (() => {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]'));
  } catch {
    return new Set();
  }
})();

function toggleCollapsed(accountId, id) {
  const k = `${accountId}|${id}`;
  if (collapsedLists.has(k)) collapsedLists.delete(k);
  else collapsedLists.add(k);
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedLists]));
  } catch {}
  renderSidebar();
}

/** Lists as an indented tree, in your order, skipping the insides of collapsed ones (unless `all`). */
function listTree(groups, all = false) {
  const ordered = sortPinnedFirst(groups);
  const rows = [];
  const visit = (accountId, parent, depth) => {
    for (const g of ordered) {
      if ((accountId && g.accountId !== accountId) || parentOf(g.accountId, g.id) !== parent) continue;
      const kids = ordered.some((x) => x.accountId === g.accountId && parentOf(x.accountId, x.id) === g.id);
      const collapsed = !all && collapsedLists.has(`${g.accountId}|${g.id}`);
      rows.push({ g, depth, kids, collapsed });
      if (kids && !collapsed) visit(g.accountId, g.id, depth + 1);
    }
  };
  visit(null, null, 0);
  return rows;
}

async function saveListLayout(set) {
  S.session.user.prefs = { ...(S.session.user.prefs || {}), ...set };
  renderSidebar();
  renderGrid();
  try {
    await api('/prefs', { method: 'PATCH', body: { set } });
  } catch (e) {
    handleError(e);
  }
}

/** Puts a list inside another (or at the top level, with parentId null), as its last sublist. */
async function nestList(me, parentId) {
  if (parentId && (parentId === me.id || descendantsOf(me.accountId, me.id).includes(parentId))) return toast('A list can’t go inside itself.');
  const parents = listParents().filter((x) => !(x.accountId === me.accountId && x.id === me.id));
  if (parentId) parents.push({ accountId: me.accountId, id: me.id, parentId });
  // In your order, right after the new parent’s last sublist.
  const all = sortPinnedFirst(S.session.accounts.flatMap((a) => a.groups.map((g) => ({ accountId: a.id, id: g.id })))).map((g) => ({ accountId: g.accountId, id: g.id }));
  const moving = [me, ...descendantsOf(me.accountId, me.id).map((id) => ({ accountId: me.accountId, id }))];
  const isMoving = (x) => moving.some((m) => m.accountId === x.accountId && m.id === x.id);
  const rest = all.filter((x) => !isMoving(x));
  let at = rest.length;
  if (parentId) {
    const family = [parentId, ...descendantsOf(me.accountId, parentId)];
    const lastIdx = rest.reduce((acc, x, i) => (x.accountId === me.accountId && family.includes(x.id) ? i : acc), -1);
    at = lastIdx + 1;
  }
  rest.splice(at, 0, ...moving.filter((m) => all.some((x) => x.accountId === m.accountId && x.id === m.id)));
  if (parentId) collapsedLists.delete(`${me.accountId}|${parentId}`);
  await saveListLayout({ listParents: parents, listOrder: rest });
  const name = (id) => accountById(me.accountId)?.groups.find((g) => g.id === id)?.name ?? 'the list';
  toast(parentId ? `Moved ${name(me.id)} inside ${name(parentId)}.` : `Moved ${name(me.id)} to the top level.`, 2500);
}

function sortPinnedFirst(groups) {
  const key = (x) => `${x.accountId}\n${x.id}`;
  const pins = pinnedLists().map(key);
  const order = listOrder().map(key);
  const pinRank = (g) => {
    const i = pins.indexOf(key(g));
    return i < 0 ? Infinity : i;
  };
  // Your own order (dragged in the sidebar) for the rest; new lists go after, as Google sorts them.
  const orderRank = (g) => {
    const i = order.indexOf(key(g));
    return i < 0 ? Infinity : i;
  };
  return groups
    .map((g, i) => ({ g, i }))
    .sort((a, b) => pinRank(a.g) - pinRank(b.g) || orderRank(a.g) - orderRank(b.g) || a.i - b.i)
    .map((x) => x.g);
}

function listOrder() {
  const p = S.session.user.prefs?.listOrder;
  return Array.isArray(p) ? p.filter((x) => x && typeof x.id === 'string' && typeof x.accountId === 'string') : [];
}

/** One account’s lists in your order (pinned first), for menus and pickers. */
function orderedLists(accountId) {
  const a = accountById(accountId);
  return sortPinnedFirst((a?.groups ?? []).map((g) => ({ ...g, accountId }))).map(({ accountId: _, ...g }) => g);
}

/** A list’s name indented for a native select, which can’t be padded. */
const indentedName = (name, depth) => (depth ? `${'\u2003'.repeat(depth - 1)}↳ ${name}` : name);

/** One account’s lists as the sidebar nests them, everything expanded: [{ g, depth }]. */
function nestedLists(accountId) {
  const a = accountById(accountId);
  return listTree((a?.groups ?? []).map((g) => ({ ...g, accountId })), true).map(({ g: { accountId: _, ...g }, depth }) => ({ g, depth }));
}

// Drag a list in the sidebar to reorder it. Dropping it among the pinned lists pins it;
// dropping a pinned one below them unpins it. Dropping it onto another list puts it inside.
let suppressListClick = false;
document.addEventListener('pointerdown', (e) => {
  const row = e.target.closest?.('nav[aria-label="Lists"] .nav-row');
  if (!row || e.button !== 0 || e.pointerType === 'touch' || e.target.closest('.nav-more, .nav-twisty') || LE) return;
  const startY = e.clientY;
  const item = row.querySelector('.nav-item');
  const me = { accountId: item.dataset.account, id: item.dataset.id };
  const inside = descendantsOf(me.accountId, me.id);
  let dragging = false;
  let line = null;
  let drop = null; // { index } between rows, or { into: id } onto a row
  const rowsNow = () => [...document.querySelectorAll('nav[aria-label="Lists"] .nav-row')];
  const idOf = (r) => r.querySelector('.nav-item')?.dataset;
  const clearInto = () => document.querySelector('.nav-row.drop-into')?.classList.remove('drop-into');
  const move = (ev) => {
    if (!dragging) {
      if (Math.abs(ev.clientY - startY) < 5) return;
      dragging = true;
      row.setPointerCapture(ev.pointerId);
      row.classList.add('row-dragging');
      document.body.classList.add('moving-list');
      line = document.createElement('div');
      line.className = 'list-drop';
      document.body.append(line);
    }
    // Your own sublists move with you, so they aren’t places to drop.
    const others = rowsNow().filter((r) => r !== row && !(idOf(r)?.account === me.accountId && inside.includes(idOf(r)?.id)));
    clearInto();
    // The middle of another list in the same account: put it inside.
    const over = others.find((r) => {
      const b = r.getBoundingClientRect();
      return ev.clientY >= b.top + b.height * 0.25 && ev.clientY <= b.bottom - b.height * 0.25;
    });
    const o = over && idOf(over);
    if (o && o.account === me.accountId && o.id !== 'contactGroups/myContacts') {
      drop = { into: o.id };
      over.classList.add('drop-into');
      line.hidden = true;
      return;
    }
    line.hidden = false;
    let i = others.findIndex((r) => {
      const b = r.getBoundingClientRect();
      return ev.clientY < b.top + b.height / 2;
    });
    if (i < 0) i = others.length;
    drop = { index: i, before: others[i] ? idOf(others[i]) : null, after: others[i - 1] ? idOf(others[i - 1]) : null };
    const ref = others[i] ?? others[others.length - 1];
    if (!ref) return;
    const b = ref.getBoundingClientRect();
    const y = others[i] ? b.top : b.bottom;
    line.style.top = `${Math.round(y - 1)}px`;
    line.style.left = `${Math.round(b.left + 4)}px`;
    line.style.width = `${Math.round(b.width - 8)}px`;
  };
  const up = (ev) => {
    row.removeEventListener('pointermove', move);
    row.removeEventListener('pointerup', up);
    row.removeEventListener('pointercancel', up);
    if (!dragging) return;
    row.classList.remove('row-dragging');
    document.body.classList.remove('moving-list');
    clearInto();
    line?.remove();
    suppressListClick = true;
    setTimeout(() => (suppressListClick = false), 0);
    if (ev.type === 'pointercancel' || !drop) return;
    if (drop.into) return nestList(me, drop.into);
    reorderLists(me, drop);
  };
  row.addEventListener('pointermove', move);
  row.addEventListener('pointerup', up);
  row.addEventListener('pointercancel', up);
});
document.addEventListener(
  'click',
  (e) => {
    if (suppressListClick && e.target.closest?.('nav[aria-label="Lists"]')) {
      e.stopPropagation();
      e.preventDefault();
    }
  },
  true,
);

/**
 * Moves a list (with its sublists) to a spot between two rows. It joins the level of the list
 * below the spot (or the one above, at the end of a group).
 */
async function reorderLists(me, drop) {
  const same = (x) => x.accountId === me.accountId && x.id === me.id;
  const key = (x) => `${x.accountId}|${x.id}`;
  const all = sortPinnedFirst(S.session.accounts.flatMap((a) => a.groups.map((g) => ({ accountId: a.id, id: g.id })))).map((g) => ({ accountId: g.accountId, id: g.id }));
  const moving = [me, ...descendantsOf(me.accountId, me.id).map((id) => ({ accountId: me.accountId, id }))];
  const movingKeys = new Set(moving.map(key));
  const rest = all.filter((x) => !movingKeys.has(key(x)));
  const before = drop.before && { accountId: drop.before.account, id: drop.before.id };
  const after = drop.after && { accountId: drop.after.account, id: drop.after.id };
  let at = before ? rest.findIndex((x) => key(x) === key(before)) : rest.length;
  if (at < 0) at = rest.length;
  rest.splice(at, 0, ...moving);

  // The new level: the list below’s parent; at the very end, the list above’s.
  const anchor = before ?? after;
  const parentId = anchor && anchor.accountId === me.accountId ? parentOf(anchor.accountId, anchor.id) : null;
  const parents = listParents().filter((x) => !same(x));
  if (parentId) parents.push({ accountId: me.accountId, id: me.id, parentId });

  // Pinning works among the top-level lists, as before.
  const shownRoots = [...document.querySelectorAll('nav[aria-label="Lists"] .nav-row')]
    .filter((r) => r.dataset.depth === '0')
    .map((r) => r.querySelector('.nav-item').dataset)
    .map((d) => ({ accountId: d.account, id: d.id }));
  const pins = pinnedLists().filter((x) => shownRoots.some((y) => key(y) === key(x)));
  let pinned = pins.some(same);
  if (!parentId) {
    const rootsAfter = rest.filter((x) => !parentOf(x.accountId, x.id) || same(x));
    const myIdx = rootsAfter.findIndex(same);
    const pinsWithout = pins.filter((x) => !same(x));
    const lastPin = Math.max(-1, ...pinsWithout.map((p) => rootsAfter.findIndex((x) => key(x) === key(p))));
    const firstUnpinned = rootsAfter.findIndex((x) => !same(x) && !pinsWithout.some((p) => key(p) === key(x)));
    if (myIdx < lastPin) pinned = true;
    else if (firstUnpinned >= 0 && myIdx > firstUnpinned) pinned = false;
  }
  const nextPins = rest.filter((x) => (same(x) ? pinned && !parentId : pins.some((p) => key(p) === key(x))));
  await saveListLayout({ pinnedLists: nextPins, listOrder: rest, listParents: parents });
}

function listNameForm(value) {
  return `<form class="nav-edit" data-list-form>
      <input class="input" id="list-name" value="${h(value)}" maxlength="100" placeholder="List name" aria-label="List name" autocomplete="off">
    </form>`;
}

function startListName(mode, target) {
  const f = S.filter;
  const accountId = target?.accountId ?? (f.type === 'account' ? f.id : f.type === 'group' ? f.accountId : S.session.accounts[0]?.id);
  if (!accountId) return;
  $('#list-menu')?.hidePopover();
  LE = { mode, accountId, id: target?.id };
  renderSidebar();
  const input = $('#list-name');
  input?.focus();
  input?.select();
}

async function finishListName(save) {
  const le = LE;
  const input = $('#list-name');
  if (!le || !input) return;
  const name = input.value.trim();
  const before = le.mode === 'rename' ? accountById(le.accountId)?.groups.find((g) => g.id === le.id)?.name : '';
  LE = null;
  if (!save || !name || name === before) return renderSidebar();
  input.disabled = true;
  try {
    const r = await api('/lists', { method: 'POST', body: { action: le.mode, accountId: le.accountId, groupId: le.id, name } });
    applyListResult(le.accountId, r);
    if (le.mode === 'create') toast(`Created ${r.group.name}. Tick people and use Lists to add them.`, 4000);
  } catch (e) {
    renderSidebar();
    handleError(e);
  }
}

document.addEventListener('submit', (e) => {
  if (!e.target.matches?.('[data-list-form]')) return;
  e.preventDefault();
  finishListName(true);
});
document.addEventListener('keydown', (e) => {
  if (e.target.id === 'list-name' && e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    finishListName(false);
  }
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'list-name' && LE) LE.value = e.target.value; // survives a sidebar re-render
});
document.addEventListener('focusout', (e) => {
  if (e.target.id === 'list-name' && LE) setTimeout(() => LE && document.activeElement?.id !== 'list-name' && finishListName(true), 0);
});

// Pinned lists come first in the sidebar, and as tabs above the contacts on iPhone.
// Saved to your account: prefs.pinnedLists = [{ accountId, id }], in order.
function pinnedLists() {
  const p = S.session.user.prefs?.pinnedLists;
  return Array.isArray(p) ? p.filter((x) => x && typeof x.id === 'string' && typeof x.accountId === 'string') : [];
}

function isPinned(accountId, id) {
  return pinnedLists().some((x) => x.accountId === accountId && x.id === id);
}

// A list’s color and emoji, only in Ligature (Google labels have neither).
// Saved to your account: prefs.listStyles = [{ accountId, id, color?, emoji? }].
const LIST_COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'gray'];
const LIST_EMOJI = ['⭐', '❤️', '🏠', '👪', '🧑‍🤝‍🧑', '💼', '🎓', '🏫', '⚽', '🏃', '🎵', '🎨', '📚', '☕', '🍽️', '🍷', '✈️', '🌱', '🐶', '🎉', '🙏', '🏥', '💻', '📍'];

function listStyles() {
  const p = S.session.user.prefs?.listStyles;
  return Array.isArray(p) ? p.filter((x) => x && typeof x.id === 'string' && typeof x.accountId === 'string') : [];
}

function listStyle(accountId, id) {
  const x = listStyles().find((y) => y.accountId === accountId && y.id === id);
  return { color: LIST_COLORS.includes(x?.color) ? x.color : '', emoji: typeof x?.emoji === 'string' ? x.emoji : '' };
}

/** The emoji, or a dot in the list’s color, to put before its name. */
function listMark(accountId, id) {
  const st = listStyle(accountId, id);
  if (st.emoji) return `<span class="list-emoji" aria-hidden="true">${h(st.emoji)}</span>`;
  if (st.color) return `<span class="list-dot" data-color="${st.color}" aria-hidden="true"></span>`;
  return '';
}

/** A list as a label: its emoji and name, in its color. */
function listBadge(accountId, g, st = listStyle(accountId, g.id)) {
  return `<span class="list-badge"${st.color ? ` data-color="${st.color}"` : ''}>${st.emoji ? `<span class="list-emoji" aria-hidden="true">${h(st.emoji)}</span>` : ''}<span class="list-badge-name">${h(g.name)}</span></span>`;
}

/** The lists a contact is on, in your order. */
function contactLists(accountId, groups) {
  return nestedLists(accountId)
    .map(({ g }) => g)
    .filter((g) => groups.includes(g.id) && g.id !== 'contactGroups/myContacts');
}

/** The first emoji someone typed (an emoji can be several characters). */
function firstGrapheme(text) {
  const t = String(text ?? '').trim();
  if (!t) return '';
  if (typeof Intl !== 'undefined' && Intl.Segmenter) return [...new Intl.Segmenter().segment(t)][0]?.segment ?? '';
  return [...t][0];
}

/** Choose a list’s color and emoji. */
async function editListStyle(target) {
  $('#list-menu')?.hidePopover();
  const g = target && accountById(target.accountId)?.groups.find((x) => x.id === target.id);
  if (!g) return;
  let st = listStyle(target.accountId, g.id);
  const dlg = $('#list-style-dlg');
  const draw = () => {
    dlg.innerHTML = `<form method="dialog" class="dlg">
        <h2 id="list-style-title">Color &amp; Icon</h2>
        <div class="ls-preview"></div>
        <div class="ls-h">Color</div>
        <div class="ls-colors" role="radiogroup" aria-label="Color">
          <button type="button" class="ls-swatch none" role="radio" aria-checked="${!st.color}" data-ls-color="" title="No color" aria-label="No color"></button>
          ${LIST_COLORS.map((c) => `<button type="button" class="ls-swatch" role="radio" aria-checked="${st.color === c}" data-ls-color="${c}" data-color="${c}" title="${c[0].toUpperCase() + c.slice(1)}" aria-label="${c}"></button>`).join('')}
        </div>
        <div class="ls-h">Emoji</div>
        <div class="ls-emoji" role="radiogroup" aria-label="Emoji">
          <button type="button" class="ls-em none" role="radio" aria-checked="${!st.emoji}" data-ls-emoji="" title="No emoji" aria-label="No emoji">${ICON.x}</button>
          ${[...new Set([...(st.emoji && !LIST_EMOJI.includes(st.emoji) ? [st.emoji] : []), ...LIST_EMOJI])]
            .map((e) => `<button type="button" class="ls-em" role="radio" aria-checked="${st.emoji === e}" data-ls-emoji="${h(e)}">${h(e)}</button>`)
            .join('')}
        </div>
        <label class="f">Or type any emoji<input class="input ls-typed" id="ls-typed" maxlength="16" autocomplete="off" placeholder="Press ⌃⌘Space for emoji"></label>
        <div class="dlg-foot">
          <button class="btn" value="cancel">Cancel</button>
          <button class="btn primary" value="ok">Done</button>
        </div>
      </form>`;
  };
  // The list as it’ll look, with what you’ve chosen so far.
  const preview = () => {
    dlg.querySelector('.ls-preview').innerHTML = listBadge(target.accountId, g, st);
    for (const b of dlg.querySelectorAll('[data-ls-color]')) b.setAttribute('aria-checked', String(b.dataset.lsColor === st.color));
    for (const b of dlg.querySelectorAll('[data-ls-emoji]')) b.setAttribute('aria-checked', String(b.dataset.lsEmoji === st.emoji));
  };
  draw();
  preview();
  const onClick = (e) => {
    const c = e.target.closest('[data-ls-color]');
    const em = e.target.closest('[data-ls-emoji]');
    if (c) st = { ...st, color: c.dataset.lsColor };
    else if (em) {
      st = { ...st, emoji: em.dataset.lsEmoji };
      dlg.querySelector('#ls-typed').value = '';
    } else return;
    preview();
  };
  const onInput = (e) => {
    if (e.target.id !== 'ls-typed') return;
    const em = firstGrapheme(e.target.value);
    if (em) st = { ...st, emoji: em };
    preview();
  };
  dlg.addEventListener('click', onClick);
  dlg.addEventListener('input', onInput);
  dlg.returnValue = '';
  dlg.showModal();
  dlg.querySelector('[aria-checked="true"]')?.focus();
  const ok = await new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
  dlg.removeEventListener('click', onClick);
  dlg.removeEventListener('input', onInput);
  if (!ok) return;
  const rest = listStyles().filter((x) => !(x.accountId === target.accountId && x.id === g.id));
  const next = st.color || st.emoji ? [...rest, { accountId: target.accountId, id: g.id, ...(st.color ? { color: st.color } : {}), ...(st.emoji ? { emoji: st.emoji } : {}) }] : rest;
  S.session.user.prefs = { ...(S.session.user.prefs || {}), listStyles: next };
  renderSidebar();
  renderGrid();
  if (S.detail && S.mode === 'view') renderDetail();
  try {
    await api('/prefs', { method: 'PATCH', body: { set: { listStyles: next } } });
  } catch (e) {
    handleError(e);
  }
}

async function togglePin(target) {
  $('#list-menu')?.hidePopover();
  if (!target) return;
  const was = isPinned(target.accountId, target.id);
  const next = was
    ? pinnedLists().filter((x) => !(x.accountId === target.accountId && x.id === target.id))
    : [...pinnedLists(), { accountId: target.accountId, id: target.id }];
  S.session.user.prefs = { ...(S.session.user.prefs || {}), pinnedLists: next };
  renderSidebar();
  try {
    await api('/prefs', { method: 'PATCH', body: { set: { pinnedLists: next } } });
  } catch (e) {
    handleError(e);
  }
}

function listMenu() {
  let m = $('#list-menu');
  if (!m) {
    m = document.createElement('div');
    m.id = 'list-menu';
    m.className = 'menu';
    m.popover = 'auto';
    m.setAttribute('role', 'menu');
    document.body.append(m);
  }
  return m;
}

function openListMenu(btn) {
  LM = { accountId: btn.dataset.account, id: btn.dataset.id };
  const m = listMenu();
  const g = accountById(LM.accountId)?.groups.find((x) => x.id === LM.id);
  const inside = descendantsOf(LM.accountId, LM.id);
  const targets = nestedLists(LM.accountId).filter(({ g: x }) => x.id !== LM.id && x.id !== 'contactGroups/myContacts' && !inside.includes(x.id));
  const parent = parentOf(LM.accountId, LM.id);
  const moveMenu = `<div class="menu-sep"></div><div class="menu-h">Move inside</div>${
    parent ? '<button type="button" role="menuitem" data-action="list-unnest"><span class="menu-check"></span>Top Level</button>' : ''
  }${targets
    .map(
      ({ g: x, depth }) => `<button type="button" role="menuitem" data-action="list-nest" data-parent="${h(x.id)}" data-depth="${Math.min(depth, 8)}"${x.id === parent ? ' aria-checked="true"' : ''}><span class="menu-check">${x.id === parent ? ICON.check : ''}</span>${h(x.name)}</button>`,
    )
    .join('')}`;
  m.innerHTML = `<button type="button" role="menuitem" data-action="list-pin"><span class="menu-check"></span>${isPinned(LM.accountId, LM.id) ? 'Unpin' : 'Pin to Top'}</button>
    <button type="button" role="menuitem" data-action="list-style"><span class="menu-check"></span>Color &amp; Icon…</button>${
    g?.system
      ? ''
      : `<button type="button" role="menuitem" data-action="list-rename"><span class="menu-check"></span>Rename…</button>
         <button type="button" role="menuitem" data-action="list-delete" class="danger-item"><span class="menu-check"></span>Delete…</button>`
  }${targets.length || parent ? moveMenu : ''}`;
  m.showPopover();
  placePopover(m, btn);
  m.querySelector('button')?.focus();
}

function placePopover(m, anchor) {
  const r = anchor.getBoundingClientRect();
  const below = r.bottom + 4 + m.offsetHeight <= window.innerHeight - 8;
  m.style.top = `${Math.round(below ? r.bottom + 4 : Math.max(8, r.top - 4 - m.offsetHeight))}px`;
  m.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8)))}px`;
}

async function deleteList(target) {
  $('#list-menu')?.hidePopover();
  const g = target && accountById(target.accountId)?.groups.find((x) => x.id === target.id);
  if (!g) return;
  const n = S.contacts.filter((c) => c.accountId === target.accountId && c.groups.includes(g.id)).length;
  const ok = await confirmDialog({
    title: `Delete the list “${g.name}”?`,
    body: `${n ? `The ${plural(n, 'contact', 'contacts')} in it stay; they’re just no longer in this list.` : 'It has no contacts.'} The label is deleted in Google Contacts too.`,
    action: 'Delete List',
  });
  if (!ok) return;
  try {
    const r = await api('/lists', { method: 'POST', body: { action: 'delete', accountId: target.accountId, groupId: g.id } });
    // Its sublists move up a level (the server does the same).
    const up = parentOf(target.accountId, g.id);
    const parents = listParents()
      .filter((x) => !(x.accountId === target.accountId && x.id === g.id))
      .flatMap((x) => (x.accountId === target.accountId && x.parentId === g.id ? (up ? [{ ...x, parentId: up }] : []) : [x]));
    const styles = listStyles().filter((x) => !(x.accountId === target.accountId && x.id === g.id));
    S.session.user.prefs = { ...(S.session.user.prefs || {}), listParents: parents, listStyles: styles };
    if (S.filter.type === 'group' && S.filter.id === g.id && S.filter.accountId === target.accountId) S.filter = { type: 'all' };
    applyListResult(target.accountId, r);
    toast(`Deleted ${g.name}.`, 2500);
  } catch (e) {
    handleError(e);
  }
}

/** Take the server’s answer: the account’s lists, and which lists each changed contact is in. */
function applyListResult(accountId, r) {
  const account = accountById(accountId);
  if (account) account.groups = r.groups;
  for (const c of r.contacts ?? []) {
    const row = S.contacts.find((x) => x.id === c.id);
    if (row) row.groups = c.groups;
    if (S.detail?.id === c.id) {
      S.detail.card = { ...S.detail.card, groups: c.groups };
      S.detail.etag = c.etag;
    }
  }
  renderSidebar();
  renderGrid();
  if (S.detail && S.mode === 'view' && r.contacts?.some((c) => c.id === S.detail.id)) renderDetail();
  if (LP && $('#list-picker')?.matches(':popover-open')) fillListPicker();
  // Search only covers a list’s fields while they’re on it, so refresh what it looks through.
  if (r.contacts?.length && S.session.fields.some((f) => f.listId && f.accountId === accountId)) loadContacts().catch(() => {});
}

// ---- the picker: tick the lists these people are in

function listPicker() {
  let m = $('#list-picker');
  if (!m) {
    m = document.createElement('div');
    m.id = 'list-picker';
    m.className = 'menu list-picker';
    m.popover = 'auto';
    m.setAttribute('role', 'menu');
    m.setAttribute('aria-label', 'Lists');
    m.addEventListener('toggle', (e) => {
      if (e.newState === 'closed') LP = null;
    });
    m.addEventListener('submit', (e) => {
      e.preventDefault();
      createFromPicker(m.querySelector('input').value);
    });
    m.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && LP?.creating) {
        e.preventDefault();
        e.stopPropagation();
        LP.creating = false;
        fillListPicker();
      }
    });
    document.body.append(m);
  }
  return m;
}

function openListPicker(anchor, ids) {
  if (!ids.length) return;
  const m = listPicker();
  if (m.matches(':popover-open') && LP?.anchor === anchor) return m.hidePopover();
  LP = { ids, anchor, creating: false };
  fillListPicker();
  m.showPopover();
  placePopover(m, anchor);
  m.querySelector('button')?.focus();
}

function pickerContacts() {
  return LP.ids.map((id) => S.contacts.find((c) => c.id === id)).filter(Boolean);
}

function fillListPicker() {
  const m = $('#list-picker');
  if (!m || !LP) return;
  const people = pickerContacts();
  const accountIds = [...new Set(people.map((c) => c.accountId))];
  const sections = accountIds.map((aid) => {
    const a = accountById(aid);
    const mine = people.filter((c) => c.accountId === aid);
    const items = nestedLists(aid).map(({ g, depth }) => {
      const n = mine.filter((c) => c.groups.includes(g.id)).length;
      const state = n === 0 ? 'false' : n === mine.length ? 'true' : 'mixed';
      return `<button type="button" role="menuitemcheckbox" aria-checked="${state}" data-lp-account="${h(aid)}" data-lp-group="${h(g.id)}" data-depth="${Math.min(depth, 8)}"${LP.busy ? ' disabled' : ''}>
          <span class="menu-check">${state === 'true' ? ICON.check : state === 'mixed' ? ICON.dash : ''}</span><span class="lp-name">${listBadge(aid, g)}</span></button>`;
    });
    const head = accountIds.length > 1 ? `<div class="menu-h">${h(a?.label || a?.providerName || '')}</div>` : '';
    return head + (items.join('') || '<div class="menu-empty">No lists yet.</div>');
  });
  const who = people.length === 1 ? h(people[0].displayName || 'This contact') : `${people.length} people`;
  m.innerHTML = `<div class="menu-h">${who}</div>${sections.join('<hr>')}<hr>${
    LP.creating
      ? `<form class="lp-new"><input class="input" maxlength="100" placeholder="New list name" aria-label="New list name" autocomplete="off"></form>`
      : `<button type="button" data-action="lp-new"><span class="menu-check">${ICON.plus}</span>New List…</button>`
  }`;
  if (LP.creating) m.querySelector('input').focus();
}

function showPickerNewList() {
  if (!LP) return;
  LP.creating = true;
  fillListPicker();
}

async function togglePickerList(accountId, groupId) {
  if (!LP || LP.busy) return;
  const mine = pickerContacts().filter((c) => c.accountId === accountId);
  const inIt = mine.filter((c) => c.groups.includes(groupId));
  const removing = inIt.length === mine.length;
  const body = removing
    ? { action: 'members', accountId, groupId, remove: mine.map((c) => c.id) }
    : { action: 'members', accountId, groupId, add: mine.filter((c) => !c.groups.includes(groupId)).map((c) => c.id) };
  await changeMembers(body, removing);
}

async function changeMembers(body, removing) {
  const name = accountById(body.accountId)?.groups.find((g) => g.id === body.groupId)?.name ?? 'the list';
  const n = (body.add ?? body.remove).length;
  LP && (LP.busy = true);
  fillListPicker();
  try {
    const r = await api('/lists', { method: 'POST', body });
    applyListResult(body.accountId, r);
    if (n > 1 || !LP || LP.ids.length > 1) toast(`${removing ? 'Removed' : 'Added'} ${plural(n, 'contact', 'contacts')} ${removing ? 'from' : 'to'} ${name}.`, 2500);
  } catch (e) {
    handleError(e);
  } finally {
    if (LP) LP.busy = false;
    fillListPicker();
  }
}

async function createFromPicker(raw) {
  const name = raw.trim();
  if (!LP || !name) return;
  const accountId = pickerContacts()[0]?.accountId;
  if (!accountId) return;
  LP.creating = false;
  LP.busy = true;
  fillListPicker();
  try {
    const r = await api('/lists', { method: 'POST', body: { action: 'create', accountId, name } });
    applyListResult(accountId, r);
    const add = pickerContacts().filter((c) => c.accountId === accountId).map((c) => c.id);
    LP.busy = false;
    await changeMembers({ action: 'members', accountId, groupId: r.group.id, add }, false);
  } catch (e) {
    if (LP) LP.busy = false;
    fillListPicker();
    handleError(e);
  }
}

// ---------------------------------------------------------------- detail

function uniqueBy(list, key) {
  const seen = new Set();
  return list.filter((x) => {
    const k = key(x);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const actionHref = (scheme, value) => (scheme === 'mailto' ? `mailto:${value.trim()}` : `${scheme}:${value.replace(/[^\d+]/g, '')}`);

/** Message, Call or Email. With more than one number or address, a menu to pick one (each with a copy button). */
function actionPill(scheme, label, items) {
  const what = scheme === 'mailto' ? 'email' : 'number';
  if (items.length === 1) {
    const v = items[0].value;
    return `<span class="pill pill-split"><a href="${h(actionHref(scheme, v))}" title="${h(v)}">${label}</a>${copyBtn(v, what, 'pill-copy')}</span>`;
  }
  const id = `pm-${scheme}`;
  return `<button type="button" class="pill" id="${id}-btn" popovertarget="${id}" aria-haspopup="menu" aria-expanded="false">${label}${ICON.down}</button>
    <div class="menu pick-menu" id="${id}" popover role="menu" aria-label="${label}" data-anchor="${id}-btn">${items
      .map(
        (it) => `<div class="pick-row"><a role="menuitem" href="${h(actionHref(scheme, it.value))}"><span class="pick-value">${h(it.value)}</span>${
          it.label ? `<span class="pick-label">${h(it.label)}</span>` : ''
        }</a>${copyBtn(it.value, what)}</div>`,
      )
      .join('')}</div>`;
}

/** Opens a popover menu under its button (popovers sit in the top layer, so they aren’t clipped). */
function anchorMenu(m) {
  m.addEventListener('toggle', (e) => {
    const btn = document.getElementById(m.dataset.anchor);
    btn?.setAttribute('aria-expanded', String(e.newState === 'open'));
    if (e.newState !== 'open' || !btn) return;
    const r = btn.getBoundingClientRect();
    const below = r.bottom + 4 + m.offsetHeight <= window.innerHeight - 8;
    m.style.top = `${Math.round(below ? r.bottom + 4 : Math.max(8, r.top - 4 - m.offsetHeight))}px`;
    m.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8)))}px`;
    m.querySelector('a, button')?.focus();
  });
}

function propRows(card) {
  const rows = [];
  const link = (href, text) => `<a href="${h(href)}">${h(text)}</a>`;
  const copyable = (inner, value, what) => `<span class="copyable">${inner}${copyBtn(value, what)}</span>`;
  for (const p of card.phones) rows.push([p.label || 'phone', copyable(link(`tel:${p.value.replace(/[^\d+]/g, '')}`, p.value), p.value, 'number')]);
  for (const e of card.emails) rows.push([e.label || 'email', copyable(link(`mailto:${e.value}`, e.value), e.value, 'email')]);
  for (const u of card.urls) {
    const safe = /^https?:\/\//i.test(u.value) ? u.value : `https://${u.value}`;
    rows.push([u.label || 'url', `<a href="${h(safe)}" target="_blank" rel="noopener noreferrer">${h(u.value)}</a>`]);
  }
  for (const a of card.addresses) rows.push([a.label || 'address', h(a.value)]);
  if (card.birthday) rows.push(['birthday', h(card.birthday)]);
  for (const ev of card.events) rows.push([ev.label || 'date', h(ev.value)]);
  for (const r of card.relations) rows.push([r.label || 'related', h(r.value)]);
  {
    const account = accountById(S.detail?.account?.id) ?? S.session.accounts[0];
    const listed = account ? contactLists(account.id, card.groups) : [];
    const badges = `<span class="list-badges wrap">${listed.map((g) => listBadge(account.id, g)).join('')}</span>`;
    if (S.detail?.archived) {
      if (listed.length) rows.push(['lists', badges]);
    } else rows.push([
      'lists',
      `<button type="button" class="lists-btn" id="lists-contact-btn" data-action="lists-contact" aria-haspopup="menu">${
        listed.length ? badges : '<span class="muted">Add to a list</span>'
      }${ICON.down}</button>`,
    ]);
  }
  if (card.notes) rows.push(['notes', h(card.notes)]);
  return rows;
}

// ---- Signal: contacts marked “On Signal” get a button that opens them in Signal

const signalField = () => S.session.fields.find((f) => f.key === 'signal');
const signalUsernameField = () => S.session.fields.find((f) => f.key === 'signal_username');
const signalUsername = (d) => (d.fields?.[signalUsernameField()?.id] || '').trim();
const onSignal = (d) => !d.archived && (d.fields?.[signalField()?.id] === '1' || !!signalUsername(d));

// A Signal username link (signal.me/#eu/…) opens their chat directly. A plain
// username can’t be linked to, so it’s copied for Signal’s search instead.
const signalLink = (v) => (/^https:\/\/signal\.me\/#/i.test(v) ? v : '');

function signalPill(card, phones) {
  const user = signalUsername(S.detail || {});
  if (user && signalLink(user)) {
    return `<a class="pill" href="${h(signalLink(user))}" target="_blank" rel="noopener noreferrer" title="Open in Signal">Signal</a>`;
  }
  if (user) {
    return `<button type="button" class="pill" data-action="signal-name" title="Copies their username and opens Signal, so you can paste it into search">Signal</button>`;
  }
  if (phones.length) {
    // Their chat, by phone number (the mobile one if there are several).
    return `<a class="pill" href="${h(signalHref(defaultPhone(phones)))}" target="_blank" rel="noopener noreferrer" title="Open in Signal">Signal</a>`;
  }
  return `<button type="button" class="pill" data-action="signal-name" title="Copies their name and opens Signal, so you can paste it into search">Signal</button>`;
}

async function signalByName() {
  const name = signalUsername(S.detail || {}) || S.detail?.card.displayName || '';
  try {
    await navigator.clipboard.writeText(name);
    toast(`Copied “${name}”. Paste it into Signal’s search.`);
  } catch {
    toast('Couldn’t copy that.');
  }
  window.location.href = 'sgnl://';
}

let detailTimer;
// ---------------------------------------------------------------- the map behind a contact’s name

/** A contact’s places, as the Map view found them: one per address, home first. */
async function contactPlaces(id) {
  S.places ??= api('/map')
    .then(({ points }) => {
      const byId = new Map();
      for (const p of points) byId.set(p.id, [...(byId.get(p.id) ?? []), p]);
      return byId;
    })
    .catch(() => new Map());
  const seen = {};
  return ((await S.places).get(id) ?? [])
    .map((point) => {
      const type = point.label || 'other';
      const n = (seen[type] = (seen[type] ?? 0) + 1);
      return { key: `${type}-${n}`, title: type[0].toUpperCase() + type.slice(1) + (n > 1 ? ` ${n}` : ''), point };
    })
    .sort((a, b) => (a.point.label === 'home' ? 0 : 1) - (b.point.label === 'home' ? 0 : 1));
}

/** A faint map behind their photo and name, and which address it shows if they have several. */
async function drawHeroMap(d) {
  const places = d.archived ? [] : await contactPlaces(d.id);
  const host = $('#hero-map');
  if (!host || S.detail?.id !== d.id || !places.length) return;
  if (S.heroPlace?.id !== d.id) S.heroPlace = { id: d.id, key: places[0].key };
  const place = places.find((p) => p.key === S.heroPlace.key) ?? places[0];
  const hero = host.closest('.hero');
  hero.classList.add('mapped');
  host.hidden = false;
  // A dot only for a street address; for an area, the map centred on it says enough.
  host.innerHTML = place.point.precision === 'address' ? '<span class="hero-dot"></span>' : '';
  // On the title’s line (or the name’s), right-aligned: just the address’s name and a caret.
  const slot = hero.querySelector('.place-slot');
  if (slot) {
    slot.innerHTML =
      places.length > 1
        ? `<label class="place-pick"><select data-hero-pick aria-label="Address on the map">${places
            .map((p) => `<option value="${h(p.key)}"${p === place ? ' selected' : ''}>${h(p.title)}</option>`)
            .join('')}</select>${ICON.down}</label>`
        : '';
  }
  try {
    const { heroMap } = await import('./map.js');
    await heroMap(host, place.point, isDark());
  } catch {
    host.hidden = true; // no map today; the header is fine without it
  }
}

/** The address a place is for, written out: from their card when it can be matched, else as looked up. */
function placeAddress(place, card) {
  const n = Number(place.key.split('-').pop()) || 1;
  const a = (card?.addresses ?? []).filter((x) => (x.label.trim().toLowerCase() || 'other') === (place.point.label || 'other'))[n - 1];
  return a?.value || place.point.text || '';
}

let PM = null; // the full-screen map of one contact’s places

/** Their places on a full map you can move around, with your pins, and the address below. */
async function openPlaceMap() {
  const d = S.detail;
  if (!d) return;
  const places = await contactPlaces(d.id);
  if (!places.length) return;
  let dlg = $('#place-dlg');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'place-dlg';
    dlg.className = 'place-dlg';
    dlg.setAttribute('aria-label', 'Map');
    dlg.addEventListener('close', () => {
      PM?.remove();
      PM = null;
    });
    document.body.append(dlg);
  }
  dlg.innerHTML = `<div class="place-canvas" id="place-canvas"></div>
    <button type="button" class="icon-btn place-close" data-action="close-place" aria-label="Close map" title="Close (Esc)">${ICON.x}</button>
    <div class="place-card" id="place-card"></div>`;
  dlg.showModal();
  renderPlaceCard(places, d);
  const card = $('#place-card');
  const person = S.contacts.find((c) => c.id === d.id) ?? d.card;
  const place = places.find((p) => p.key === S.heroPlace?.key) ?? places[0];
  try {
    const [{ placeMap }, { pins }] = await Promise.all([import('./map.js'), api('/pins').catch(() => ({ pins: [] }))]);
    if (!dlg.open) return;
    PM = await placeMap($('#place-canvas'), { person, point: place.point, pins, dark: isDark(), bottom: card.offsetHeight + 24 });
  } catch (e) {
    handleError(e);
  }
}

/** The panel along the bottom: which address (a dropdown if there are several) and the address itself. */
function renderPlaceCard(places, d) {
  const place = places.find((p) => p.key === S.heroPlace?.key) ?? places[0];
  const addr = placeAddress(place, d.card);
  const app = mapsApp();
  $('#place-card').innerHTML = `
    <div class="place-card-head">${
      places.length > 1
        ? `<label class="place-pick"><select data-place-pick aria-label="Address">${places
            .map((p) => `<option value="${h(p.key)}"${p === place ? ' selected' : ''}>${h(p.title)}</option>`)
            .join('')}</select>${ICON.down}</label>`
        : h(place.title)
    }</div>
    <div class="place-card-row">
      <div class="place-card-addr">${h(addr || 'No address written out').replace(/\n/g, '<br>')}</div>
      ${addr ? `<button type="button" class="place-btn" data-copy="${h(addr)}" aria-label="Copy address" title="Copy address">${ICON.copy}</button>` : ''}
      <a class="place-btn" href="${h(mapsUrl(place.point, addr))}" target="_blank" rel="noopener noreferrer" aria-label="Show in ${h(app.title)}" title="Show in ${h(app.title)}">${ICON.directions}</a>
    </div>`;
  return place;
}

/** Where places open, set on the iPhone (Settings → Maps) and shared through your account. */
function mapsApp() {
  return S.session?.user?.prefs?.mapsApp === 'google' ? { id: 'google', title: 'Google Maps' } : { id: 'apple', title: 'Apple Maps' };
}

/** The place in your maps app: shown there, not directions to it. */
function mapsUrl(point, written) {
  const query = written ? written.split('\n').map((l) => l.trim()).filter(Boolean).join(', ') : `${point.lat},${point.lng}`;
  if (mapsApp().id === 'google') return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  return `https://maps.apple.com/?q=${encodeURIComponent(query)}&ll=${point.lat},${point.lng}`;
}

function renderDetailSoon() {
  clearTimeout(detailTimer);
  detailTimer = setTimeout(() => {
    if (S.mode === 'view' && !document.activeElement?.matches?.('textarea, input:not([type="checkbox"])')) renderDetail();
  }, 50);
}

function ownFieldInput(f, value) {
  const id = `own-${f.id}`;
  if (f.type === 'checkbox') {
    return `<input type="checkbox" id="${id}" class="own-input own-check" data-field="${h(f.id)}"${value === '1' ? ' checked' : ''}>`;
  }
  const common = `id="${id}" class="own-input" data-field="${h(f.id)}" autocomplete="off"`;
  if (f.type === 'longtext') return `<textarea ${common} rows="1" placeholder="Add">${h(value)}</textarea>`;
  const type = f.type === 'date' ? 'date' : f.type === 'url' ? 'url' : 'text';
  return `<input ${common} type="${type}" value="${h(value)}" placeholder="${f.type === 'url' ? 'https://' : f.key === 'signal_username' ? 'Username or link' : 'Add'}"${f.key === 'signal_username' ? ' autocapitalize="off" spellcheck="false"' : ''}>`;
}

function renderDetail() {
  const el = $('#detail');
  if (!el) return;
  if (S.mode === 'edit' || S.mode === 'new') return renderEditor(el);

  const d = S.detail;
  const ready = d && d.id === S.selectedId;
  const toolbar = `<div class="toolbar drawer-bar">
      <button type="button" class="icon-btn" data-action="close-detail" aria-label="Close details" title="Close (Esc)">${ICON.x}</button>
      <span class="grow"></span>
      ${
        !ready
          ? ''
          : d.archived
            ? '<button type="button" class="btn danger" data-action="forget-contact">Delete Forever…</button><button type="button" class="btn primary" data-action="restore-contact">Restore</button>'
            : '<button type="button" class="btn" data-action="archive-contact" title="Take them out of Google, keeping everything here">Archive</button><button type="button" class="btn" data-action="edit">Edit</button>'
      }</div>`;

  if (!ready) {
    el.innerHTML = `${toolbar}<div class="empty-detail">${S.selectedId ? 'Loading…' : ''}</div>`;
    return;
  }

  const c = d.card;
  const subtitle = [c.title, c.organization].filter(Boolean).join(' · ');
  const phones = uniqueBy(c.phones, (p) => p.value.replace(/[^\d+]/g, ''));
  const emails = uniqueBy(c.emails, (e) => e.value.trim().toLowerCase());
  const rows = propRows(c);
  const applying = S.session.fields.filter((f) => fieldApplies(f, d.account.id, c.groups));
  const fields = applying.filter((f) => !f.listId);
  // A list’s own fields, under the list’s name.
  const listSections = [...new Set(applying.filter((f) => f.listId).map((f) => f.listId))].map((listId) => {
    const lf = applying.filter((f) => f.listId === listId);
    return { name: fieldListName(lf[0]), fields: lf };
  });
  // Values in a list’s fields they’re no longer on, or whose list was deleted.
  const past = S.session.fields.filter((f) => !fieldApplies(f, d.account.id, c.groups) && (d.fields[f.id] ?? '') !== '');
  const hasOwn = Object.keys(d.fields).length > 0;

  el.innerHTML = `${toolbar}
    <div class="detail-body"><div class="sheet">
      ${
        d.archived
          ? d.draft
            ? `<div class="banner archived-banner">Archived draft, ${h(shortDate(d.archived.at))}. Restore brings it back as a draft.</div>`
            : `<div class="banner archived-banner">Archived ${h(shortDate(d.archived.at))}. Not in Google Contacts; everything is kept here. Restore puts ${h(c.givenName || 'them')} back in Google${
              d.archived.groups.filter((g) => g !== 'contactGroups/myContacts').length ? ', on the same lists' : ''
            }.</div>`
          : `${togetherSwitcher(d.id)}${
              d.draft
                ? `<div class="banner draft-banner"><span><strong>Draft.</strong> Only in Ligatures: not in Google Contacts, so not on your iPhone or Mac.</span><button type="button" class="btn primary" data-action="promote-contact">Add to Google</button></div>`
                : ''
            }`
      }
      <div class="hero">
        <div class="hero-map" id="hero-map" hidden aria-hidden="true"></div>
        ${
          c.photoUrl
            ? `<button type="button" class="avatar avatar-btn" data-action="enlarge-photo" aria-label="Enlarge photo" title="Enlarge photo"><img src="${h(c.photoUrl)}" alt="" referrerpolicy="no-referrer"></button>`
            : `<div class="avatar" aria-hidden="true">${h(initials(c))}</div>`
        }
        <div class="hero-text">
          <div class="hero-line"><h1>${h(c.displayName || 'No name')}</h1>${subtitle ? '' : '<span class="place-slot"></span>'}</div>
          ${subtitle ? `<div class="hero-line"><div class="subtitle">${h(subtitle)}</div><span class="place-slot"></span></div>` : ''}
          ${
            phones.length || emails.length || onSignal(d)
              ? `<div class="pills">
                  ${phones.length ? `<span class="pill-set">${actionPill('sms', 'Message', phones)}${actionPill('tel', 'Call', phones)}</span>` : ''}
                  ${emails.length ? `<span class="pill-set">${actionPill('mailto', 'Email', emails)}</span>` : ''}
                  ${onSignal(d) ? signalPill(c, phones) : ''}
                </div>`
              : ''
          }
        </div>
      </div>

      ${
        rows.length
          ? `<dl class="props">${rows.map(([k, v]) => `<dt>${h(k)}</dt><dd>${v}</dd>`).join('')}</dl>`
          : `<p class="props empty">No details in ${h(d.account.providerName)}.</p>`
      }

      ${d.archived ? '' : relationshipsSection(d.id)}

      <section class="own" aria-labelledby="own-h">
        <div class="own-h">
          <h2 id="own-h">Your fields</h2>
          <p>Only in Ligatures. Never synced to Google, iPhone or Mac.</p>
        </div>
        ${
          fields.length
            ? `<dl class="props">${fields
                .map(ownFieldRow)
                .join('')}</dl>`
            : listSections.length
              ? ''
              : `<p class="empty">No fields yet. <button class="link" data-action="fields">Add one</button>.</p>`
        }
        <div class="own-status" id="own-status" role="status" aria-live="polite"></div>
      </section>

      ${listSections
        .map(
          (l, i) => `<section class="own list-fields" aria-labelledby="lf-h-${i}">
            <div class="own-h"><h2 id="lf-h-${i}">${h(l.name)}</h2><p>Fields for this list.</p></div>
            <dl class="props">${l.fields.map(ownFieldRow).join('')}</dl>
          </section>`,
        )
        .join('')}

      ${past.length ? pastFieldsSection(past, d) : ''}

      <div class="foot">${h(d.account.providerName)}${d.account.label && d.account.label !== d.account.providerName ? ` · ${h(d.account.label)}` : ''} · Synced ${h(ago(d.syncedAt))}${
        hasOwn && !d.linked ? ' · Linking to Google…' : ''
      }</div>
    </div></div>`;

  for (const ta of el.querySelectorAll('textarea.own-input')) autosize(ta);
  for (const m of el.querySelectorAll('.menu[popover]')) anchorMenu(m);
  drawHeroMap(d);
}

function ownFieldRow(f) {
  return `<dt><label for="own-${h(f.id)}">${h(f.label)}</label></dt><dd>${ownFieldInput(f, S.detail?.fields[f.id] ?? '')}</dd>`;
}

function pastValue(f, v) {
  if (f.type === 'checkbox') return 'Yes';
  if (f.type === 'date') return h(shortDay(v));
  if (f.type === 'url') return `<a href="${h(/^https?:\/\//i.test(v) ? v : `https://${v}`)}" target="_blank" rel="noopener noreferrer">${h(v)}</a>`;
  return h(v);
}

let pastOpenFor = null; // the contact whose Past fields you opened, so a re-render keeps it open

function pastFieldsSection(past, d) {
  const lists = [...new Set(past.map((f) => `${f.accountId}|${f.listId}`))].map((k) => past.filter((f) => `${f.accountId}|${f.listId}` === k));
  return `<details class="own past" id="past-fields" data-contact="${h(d.id)}"${pastOpenFor === d.id ? ' open' : ''}>
      <summary class="own-h">
        <h2>${ICON.down} Past fields <span class="count">${past.length}</span></h2>
        <p>From lists they’re no longer on, or that were deleted.</p>
      </summary>
      ${lists
        .map((fields) => {
          const f0 = fields[0];
          const status = fieldList(f0) ? 'Not on this list' : 'Deleted list';
          return `<div class="past-list">
            <h3>${h(fieldListName(f0))} <span>${status}</span></h3>
            <dl class="props">${fields
              .map(
                (f) => `<dt>${h(f.label)}</dt>
                  <dd class="past-row"><span class="past-value">${pastValue(f, d.fields[f.id])}</span>
                    <button type="button" class="icon-btn" data-action="clear-past" data-id="${h(f.id)}" aria-label="Remove ${h(f.label)}" title="Remove">${ICON.x}</button></dd>`,
              )
              .join('')}</dl>
          </div>`;
        })
        .join('')}
    </details>`;
}

document.addEventListener(
  'toggle',
  (e) => {
    if (e.target.id === 'past-fields') pastOpenFor = e.target.open ? e.target.dataset.contact : null;
  },
  true,
);

// ---------------------------------------------------------------- relationships

const contactById = (id) => S.contacts.find((c) => c.id === id);
const firstName = (c) => c?.givenName || c?.displayName || 'them';

/** For people shown together: switch between them at the top of the panel. */
function togetherSwitcher(id) {
  const members = togetherGroups(S.contacts, S.relationships).get(id);
  if (!members) return '';
  return `<div class="seg together-seg" role="group" aria-label="Shown together">${members
    .map((m) => `<button type="button" data-switch="${h(m.id)}" aria-pressed="${m.id === id}">${h(firstName(m))}</button>`)
    .join('')}</div>`;
}

function relationshipsFor(id) {
  return S.relationships.filter((r) => (r.a === id || r.b === id) && contactById(otherId(r, id)));
}

function relationshipsSection(id) {
  const rels = relationshipsFor(id);
  const rows = rels.map((r) => {
    const o = contactById(otherId(r, id));
    const av = o.photoUrl ? `<img src="${h(thumb(o.photoUrl))}" alt="" referrerpolicy="no-referrer">` : h(initials(o));
    return `<dt>${h(roleLabel(r, id))}</dt><dd class="rel-row">
        <button type="button" class="rel-person" data-switch="${h(o.id)}"><span class="mini-av" aria-hidden="true">${av}</span><span class="cell-name">${h(o.displayName || 'No name')}</span></button>
        ${r.combined ? '<span class="rel-tag" title="Shown as one in the contacts list">Together</span>' : ''}
        <button type="button" class="icon-btn rel-edit" data-rel-edit="${h(r.id)}" aria-label="Edit relationship with ${h(o.displayName || 'contact')}" title="Edit">${ICON.more}</button>
      </dd>`;
  });
  return `<section class="own rels" aria-labelledby="rels-h">
      <div class="own-h">
        <h2 id="rels-h">Relationships</h2>
        <p>Only in Ligatures.</p>
      </div>
      ${rows.length ? `<dl class="props">${rows.join('')}</dl>` : ''}
      <div><button type="button" class="link" data-action="add-rel">${ICON.plus} Add relationship</button></div>
    </section>`;
}

let RD = null; // relationship dialog: { me, relId?, other?, role, label, together, touched, query, busy }

function openRelDialog(relId) {
  const me = S.detail?.id;
  if (!me) return;
  const r = relId && S.relationships.find((x) => x.id === relId);
  RD = r
    ? { me, relId, other: otherId(r, me), role: roleOf(r, me).id, label: r.label, together: r.combined, touched: true, query: '' }
    : { me, role: 'spouse', label: '', together: true, touched: false, query: '' };
  renderRelDialog();
  $('#rel-dlg').showModal();
  ($('#rel-q') ?? $('#rel-role')).focus();
}

function renderRelDialog() {
  const dlg = $('#rel-dlg');
  if (!dlg || !RD) return;
  const me = contactById(RD.me);
  const o = RD.other && contactById(RD.other);
  const role = ROLES.find((x) => x.id === RD.role);
  const person = o
    ? `<div class="rel-picked"><span class="cell-name">${h(o.displayName || 'No name')}</span>${
        RD.relId ? '' : '<button type="button" class="link" data-action="rel-change">Change</button>'
      }</div>`
    : `<input class="input" id="rel-q" type="search" placeholder="Search contacts" autocomplete="off" spellcheck="false" aria-label="Person" value="${h(RD.query)}">
       <div class="rel-results" id="rel-results" role="listbox" aria-label="Matches">${relResults()}</div>`;
  dlg.innerHTML = `<form class="dlg rel-form" id="rel-form">
      <h2 id="rel-title">${RD.relId ? 'Edit Relationship' : 'Add Relationship'}</h2>
      <div class="f">Person${person}</div>
      <label class="f">${o ? `${h(firstName(o))} is ${h(firstName(me))}’s` : `Who they are to ${h(firstName(me))}`}
        <select class="input" id="rel-role">${ROLES.map(
          (x) => `<option value="${x.id}"${x.id === RD.role ? ' selected' : ''}>${h(x.label)}</option>`,
        ).join('')}</select></label>
      ${
        role?.kind === 'other'
          ? `<label class="f">Relationship<input class="input" id="rel-label" maxlength="60" placeholder="Godparent, neighbour…" value="${h(RD.label)}" autocomplete="off"></label>`
          : ''
      }
      <label class="check-row"><input type="checkbox" id="rel-together"${RD.together ? ' checked' : ''}>
        <span>Show as one in the contacts list${o && RD.together ? `<span class="hint">${h(togetherPreview())}</span>` : ''}</span></label>
      <div class="dlg-foot">
        ${RD.relId ? '<button type="button" class="btn danger" data-action="rel-remove">Remove</button><span class="grow"></span>' : ''}
        <button type="button" class="btn" data-action="rel-cancel">Cancel</button>
        <button type="submit" class="btn primary"${o && !RD.busy ? '' : ' disabled'}>${RD.relId ? 'Save' : 'Add'}</button>
      </div>
    </form>`;
}

/** The entry’s name once this relationship joins them. */
function togetherPreview() {
  const rels = S.relationships.filter((r) => r.id !== RD.relId && !samePair(r, RD.me, RD.other));
  rels.push({ ...relationshipBody(RD.me, RD.other, RD.role, RD.label, true), id: 'preview' });
  const members = togetherGroups(S.contacts, rels).get(RD.me) ?? [];
  return `Shown as “${togetherName(members)}”`;
}

const samePair = (r, x, y) => (r.a === x && r.b === y) || (r.a === y && r.b === x);

function relResults() {
  const q = RD.query.trim().toLowerCase();
  if (!q) return '';
  const words = q.split(/\s+/);
  const matches = S.contacts
    .filter((c) => c.id !== RD.me && words.every((w) => c.search.includes(w)))
    .slice(0, 8);
  if (!matches.length) return '<div class="menu-empty">No matches.</div>';
  return matches
    .map((c) => {
      const av = c.photoUrl ? `<img src="${h(thumb(c.photoUrl))}" alt="" referrerpolicy="no-referrer">` : h(initials(c));
      const sub = [c.organization, c.email].filter(Boolean)[0] ?? '';
      return `<button type="button" role="option" data-rel-pick="${h(c.id)}"><span class="mini-av" aria-hidden="true">${av}</span><span class="cell-name">${h(c.displayName || 'No name')}</span>${
        sub ? `<span class="muted">${h(sub)}</span>` : ''
      }</button>`;
    })
    .join('');
}

async function saveRelationship() {
  if (!RD?.other || RD.busy) return;
  RD.busy = true;
  renderRelDialog();
  const body = relationshipBody(RD.me, RD.other, RD.role, RD.label.trim(), RD.together);
  try {
    const { relationship } = await api('/relationships', { method: 'POST', body });
    S.relationships = S.relationships.filter((r) => r.id !== relationship.id && !samePair(r, body.a, body.b));
    S.relationships.push(relationship);
    $('#rel-dlg').close();
    relationshipsChanged();
  } catch (e) {
    RD.busy = false;
    renderRelDialog();
    handleError(e);
  }
}

async function removeRelationship() {
  if (!RD?.relId || RD.busy) return;
  const id = RD.relId;
  RD.busy = true;
  try {
    await api(`/relationships/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (e) {
    if (e.status !== 404) {
      RD.busy = false;
      return handleError(e);
    }
  }
  S.relationships = S.relationships.filter((r) => r.id !== id);
  $('#rel-dlg').close();
  relationshipsChanged();
}

function relationshipsChanged() {
  renderGrid();
  if (S.mode === 'view') renderDetail();
}

function relDialogClick(e) {
  const t = e.target;
  const pick = t.closest('[data-rel-pick]');
  if (pick) {
    RD.other = pick.dataset.relPick;
    renderRelDialog();
    $('#rel-role')?.focus();
    return true;
  }
  const a = t.closest('[data-action]')?.dataset.action;
  if (a === 'rel-change') {
    RD.other = null;
    renderRelDialog();
    $('#rel-q')?.focus();
  } else if (a === 'rel-cancel') $('#rel-dlg').close();
  else if (a === 'rel-remove') removeRelationship();
  else return false;
  return true;
}

function relDialogInput(t) {
  if (t.id === 'rel-q') {
    RD.query = t.value;
    $('#rel-results').innerHTML = relResults();
  } else if (t.id === 'rel-label') RD.label = t.value;
  else if (t.id === 'rel-role') {
    RD.role = t.value;
    // Couples show together unless you’ve said otherwise; other kinds don’t.
    if (!RD.touched) RD.together = Boolean(ROLES.find((x) => x.id === RD.role)?.together);
    renderRelDialog();
    $('#rel-role').focus();
    if (RD.role === 'other') $('#rel-label')?.focus();
  } else if (t.id === 'rel-together') {
    RD.together = t.checked;
    RD.touched = true;
    renderRelDialog();
    $('#rel-together').focus();
  }
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

// ---------------------------------------------------------------- your fields: autosave

const pending = new Map();
let saveTimer;

function queueFieldSave(input, immediate) {
  pending.set(input.dataset.field, input.type === 'checkbox' ? (input.checked ? '1' : '') : input.value);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushFieldSaves, immediate ? 0 : 700);
}

async function flushFieldSaves() {
  if (!pending.size || !S.detail) return;
  const values = Object.fromEntries(pending);
  const id = S.detail.id;
  pending.clear();
  const status = $('#own-status');
  if (status) status.textContent = 'Saving…';
  try {
    const d = await api(`/contacts/${encodeURIComponent(id)}/fields`, { method: 'PUT', body: { values } });
    if (Object.keys(values).some((f) => fieldById(f)?.key === 'neighborhood')) {
      mapView?.invalidate();
      S.places = null;
    }
    if (S.detail?.id === id) {
      const wasLinked = S.detail.linked;
      S.detail = { ...S.detail, fields: d.fields, linked: d.linked, etag: d.etag, card: d.card };
      if (status) status.textContent = d.linkError ? `Saved. Couldn’t link to Google yet: ${d.linkError}` : 'Saved';
      if (wasLinked !== d.linked) {
        const foot = $('.foot');
        if (foot) foot.textContent = foot.textContent.replace(/ · Link.*$/, '');
      }
    }
    const row = S.contacts.find((c) => c.id === id);
    if (row) {
      row.fields = d.fields;
      if (d.search) row.search = d.search;
      renderGrid();
    }
  } catch (e) {
    if (status) status.textContent = '';
    handleError(e);
  }
}

// ---------------------------------------------------------------- editor (Google fields)

const PHONE_LABELS = ['mobile', 'home', 'work', 'main', 'other'];
const EMAIL_LABELS = ['home', 'work', 'other'];
const URL_LABELS = ['homepage', 'work', 'blog', 'profile', 'other'];
const ADDRESS_LABELS = ['home', 'work', 'other'];
const ADDRESS_PARTS = ['street', 'city', 'region', 'postalCode', 'country'];
const blankAddress = (label) => ({ label, street: '', city: '', region: '', postalCode: '', country: '' });

let draft = null;

function startEdit(isNew) {
  if (isNew && !S.session.accounts.length) return toast('Connect a Google account first.');
  const c = isNew ? null : S.detail?.card;
  draft = {
    accountId: isNew ? (S.filter.accountId || S.filter.id || S.session.accounts[0].id) : S.detail.account.id,
    // A new contact joins the list you’re viewing.
    groups: isNew && S.filter.type === 'group' ? [S.filter.id] : [],
    givenName: c?.givenName ?? '',
    familyName: c?.familyName ?? '',
    organization: c?.organization ?? '',
    title: c?.title ?? '',
    phones: (c?.phones ?? []).map((x) => ({ ...x })),
    emails: (c?.emails ?? []).map((x) => ({ ...x })),
    urls: (c?.urls ?? []).map((x) => ({ ...x })),
    addresses: (c?.addresses ?? []).map((a) => ({ label: a.label, street: a.street ?? a.value, city: a.city ?? '', region: a.region ?? '', postalCode: a.postalCode ?? '', country: a.country ?? '' })),
    notes: c?.notes ?? '',
    photo: null, // { action: 'set', data } or { action: 'remove' }, saved with the contact
  };
  if (!S.session.accounts.some((a) => a.id === draft.accountId)) draft.accountId = S.session.accounts[0].id;
  S.mode = isNew ? 'new' : 'edit';
  setDrawer(true);
  renderDetail();
  $('#e-given')?.focus();
}

function multiGroup(key, title, labels) {
  const rows = draft[key]
    .map(
      (item, i) => `<div class="multi">
        <input class="input" list="labels-${key}" aria-label="${title} ${i + 1} label" data-multi="${key}" data-i="${i}" data-part="label" value="${h(item.label)}">
        <input class="input" aria-label="${title} ${i + 1}" data-multi="${key}" data-i="${i}" data-part="value" value="${h(item.value)}"
          type="${key === 'emails' ? 'email' : key === 'urls' ? 'url' : 'tel'}">
        <button type="button" class="icon-btn" data-action="remove-row" data-multi="${key}" data-i="${i}" aria-label="Remove ${title.toLowerCase()} ${i + 1}">${ICON.x}</button>
      </div>`,
    )
    .join('');
  return `<div class="group">
      <div class="group-h">${title}</div>
      ${rows}
      <datalist id="labels-${key}">${labels.map((l) => `<option value="${l}">`).join('')}</datalist>
      <div><button type="button" class="nav-add" data-action="add-row" data-multi="${key}" data-label="${labels[0]}">${ICON.plus} Add ${title.toLowerCase().replace(/s$/, '')}</button></div>
    </div>`;
}

function addressGroup() {
  const field = (a, i, part, label, cls = '') =>
    `<input class="input${cls}" aria-label="Address ${i + 1} ${label.toLowerCase()}" placeholder="${label}" data-multi="addresses" data-i="${i}" data-part="${part}" value="${h(a[part])}" autocomplete="off">`;
  const rows = draft.addresses
    .map(
      (a, i) => `<div class="multi addr">
        <input class="input" list="labels-addresses" aria-label="Address ${i + 1} label" data-multi="addresses" data-i="${i}" data-part="label" value="${h(a.label)}">
        <div class="addr-parts">
          <textarea class="input addr-street" rows="2" aria-label="Address ${i + 1} street" placeholder="Street" data-multi="addresses" data-i="${i}" data-part="street">${h(a.street)}</textarea>
          <div class="addr-line">${field(a, i, 'city', 'City')}${field(a, i, 'region', 'State', ' addr-region')}${field(a, i, 'postalCode', 'ZIP', ' addr-zip')}</div>
          ${field(a, i, 'country', 'Country')}
        </div>
        <button type="button" class="icon-btn" data-action="remove-row" data-multi="addresses" data-i="${i}" aria-label="Remove address ${i + 1}">${ICON.x}</button>
      </div>`,
    )
    .join('');
  return `<div class="group">
      <div class="group-h">Addresses</div>
      ${rows}
      <datalist id="labels-addresses">${ADDRESS_LABELS.map((l) => `<option value="${l}">`).join('')}</datalist>
      <div><button type="button" class="nav-add" data-action="add-row" data-multi="addresses" data-label="home">${ICON.plus} Add address</button></div>
    </div>`;
}

function renderEditor(el) {
  const isNew = S.mode === 'new';
  const accounts = S.session.accounts;
  el.innerHTML = `
    <form class="editor" id="editor" novalidate>
      <div class="toolbar drawer-bar">
        <h2 class="drawer-title">${isNew ? 'New Contact' : 'Edit Contact'}</h2>
        <span class="grow"></span>
        <button type="button" class="btn" data-action="cancel-edit">Cancel</button>
        ${isNew ? '<button type="button" class="btn" data-action="save-draft" title="Keep it only in Ligatures for now">Save as Draft</button>' : ''}
        <button type="submit" class="btn primary" id="save-btn">${isNew ? 'Create' : 'Save'}</button>
      </div>
      <div class="detail-body"><div class="sheet form">
        <div class="banner">${
          isNew
            ? `Creates the contact in Google${
                draft.groups.length ? `, in “${h(accountById(draft.accountId)?.groups.find((g) => g.id === draft.groups[0])?.name ?? 'this list')}”` : ''
              }. It reaches your iPhone and Mac through Google.`
            : S.detail?.draft
              ? 'A draft: changes stay in Ligatures until you add it to Google.'
              : 'Changes save to Google and reach your iPhone and Mac.'
        }${isNew ? ' Or save it as a draft, kept only in Ligatures until you add it to Google.' : ''}</div>
        ${
          isNew && accounts.length > 1
            ? `<label class="f">Account<select class="input" data-draft="accountId">${accounts
                .map((a) => `<option value="${h(a.id)}" ${a.id === draft.accountId ? 'selected' : ''}>${h(a.label)}</option>`)
                .join('')}</select></label>`
            : ''
        }
        ${photoPicker()}
        <div class="form-grid">
          <label class="f">First name<input class="input" id="e-given" data-draft="givenName" value="${h(draft.givenName)}" autocomplete="off"></label>
          <label class="f">Last name<input class="input" data-draft="familyName" value="${h(draft.familyName)}" autocomplete="off"></label>
          <label class="f">Company<input class="input" data-draft="organization" value="${h(draft.organization)}" autocomplete="off"></label>
          <label class="f">Job title<input class="input" data-draft="title" value="${h(draft.title)}" autocomplete="off"></label>
        </div>
        ${multiGroup('phones', 'Phones', PHONE_LABELS)}
        ${multiGroup('emails', 'Emails', EMAIL_LABELS)}
        ${addressGroup()}
        ${multiGroup('urls', 'Websites', URL_LABELS)}
        <label class="f">Notes<textarea class="input" data-draft="notes">${h(draft.notes)}</textarea></label>
        ${
          isNew || S.detail?.draft
            ? ''
            : `<div class="make-draft"><button type="button" class="btn" data-action="make-draft">Make Draft…</button>
                <p>Takes them out of Google Contacts (and your iPhone and Mac), keeping everything here as a draft. Add them back to Google anytime.</p></div>`
        }
        ${isNew ? '' : '<div class="danger-zone"><button type="button" class="btn danger" data-action="delete-contact">Delete Contact…</button></div>'}
      </div></div>
    </form>`;
}

function photoPicker() {
  const current = S.mode === 'edit' ? S.detail?.card.photoUrl : '';
  const shown = draft.photo?.action === 'set' ? draft.photo.data : draft.photo?.action === 'remove' ? '' : current;
  const name = { givenName: draft.givenName, familyName: draft.familyName, displayName: `${draft.givenName} ${draft.familyName}`.trim() || '?' };
  return `<div class="photo-edit" id="photo-drop">
      <div class="avatar" aria-hidden="true">${shown ? `<img src="${h(shown)}" alt="" referrerpolicy="no-referrer">` : h(initials(name))}</div>
      <div class="photo-actions">
        <div class="photo-btns">
          <button type="button" class="btn" data-action="photo-choose">${shown ? 'Change Photo…' : 'Add Photo…'}</button>
          ${shown ? '<button type="button" class="btn" data-action="photo-crop">Crop…</button>' : ''}
          ${shown ? '<button type="button" class="btn" data-action="photo-remove">Remove</button>' : ''}
          ${draft.photo ? '<button type="button" class="link" data-action="photo-undo">Undo</button>' : ''}
        </div>
        <p class="hint">${
          draft.photo ? 'Saves to Google with the contact, then reaches your iPhone and Mac.' : 'Or drop an image here.'
        }</p>
        <input type="file" id="photo-file" accept="image/*" hidden>
      </div>
    </div>`;
}

// ---- photo cropping
// A new photo is kept uncropped (up to 1600 px) along with where the crop sits in it, so the
// crop can be changed later. Only the cropped square goes to Google.

const ORIGINAL_PX = 1600;

/** Any image (a file, or a data URL) as a JPEG data URL at most `px` on its longer side. */
async function originalJpeg(source, px = ORIGINAL_PX) {
  let bmp;
  try {
    bmp = await createImageBitmap(typeof source === 'string' ? await loadImage(source) : source);
  } catch {
    throw new Error('Couldn’t read that image. Try a JPEG or PNG.');
  }
  const k = Math.min(1, px / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * k));
  canvas.height = Math.max(1, Math.round(bmp.height * k));
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff'; // transparent PNGs get a white background
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return { data: canvas.toDataURL('image/jpeg', 0.9), width: canvas.width, height: canvas.height };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Couldn’t read that image.'));
    img.src = src;
  });
}

/** The crop of `src` as a square JPEG, at most 512 px, as a data URL. */
async function croppedJpeg(src, crop, size = 512) {
  const img = await loadImage(src);
  const sw = crop.w * img.naturalWidth;
  const sh = crop.h * img.naturalHeight;
  const out = Math.max(1, Math.round(Math.min(size, sw)));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = out;
  const g = canvas.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, crop.x * img.naturalWidth, crop.y * img.naturalHeight, sw, sh, 0, 0, out, out);
  return canvas.toDataURL('image/jpeg', 0.88);
}

/** The largest centred square, as a crop. */
function centredCrop(w, h) {
  const side = Math.min(w, h);
  return { x: (w - side) / 2 / w, y: (h - side) / 2 / h, w: side / w, h: side / h };
}

const CROP_INSET = 20; // room around the circle, where the rest of the photo shows dimmed
const CROP_ZOOM = 6; // how far in you can zoom, past filling the circle

/**
 * Position and zoom a photo in a circle: drag to move, scroll, pinch or the slider to zoom.
 * Resolves to the crop (fractions of the image), or null if cancelled.
 */
async function cropDialog(src, crop) {
  const img = await loadImage(src);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const dlg = document.createElement('dialog');
  dlg.className = 'crop-dlg';
  dlg.setAttribute('aria-labelledby', 'crop-title');
  dlg.innerHTML = `<form method="dialog" class="dlg">
      <h2 id="crop-title">Crop Photo</h2>
      <div class="crop-stage" tabindex="0" role="application" aria-label="Photo. Drag or use the arrow keys to move it; scroll, pinch, or plus and minus to zoom.">
        <img class="crop-under" src="${h(src)}" alt="" draggable="false">
        <div class="crop-ring"><img src="${h(src)}" alt="" draggable="false"></div>
      </div>
      <label class="crop-zoom">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2"/></svg>
        <input type="range" min="0" max="1" step="0.001" value="0" aria-label="Zoom">
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="1" y="2.5" width="14" height="11" rx="2"/></svg>
      </label>
      <div class="dlg-foot">
        <button type="button" class="link crop-reset">Reset</button>
        <span class="grow"></span>
        <button class="btn" value="cancel">Cancel</button>
        <button class="btn primary" value="ok">Done</button>
      </div>
    </form>`;
  document.body.append(dlg);
  const stage = dlg.querySelector('.crop-stage');
  const under = dlg.querySelector('.crop-under');
  const top = dlg.querySelector('.crop-ring img');
  const slider = dlg.querySelector('input[type="range"]');

  // The view: k is screen px per image px; (tx, ty) is the image’s top-left corner relative
  // to the circle’s, so both are ≤ 0 while the photo covers the circle.
  let D = 0, k = 1, tx = 0, ty = 0, kMin = 1, kMax = 1;
  const clamp = () => {
    k = Math.min(kMax, Math.max(kMin, k));
    tx = Math.min(0, Math.max(D - W * k, tx));
    ty = Math.min(0, Math.max(D - H * k, ty));
  };
  const draw = () => {
    clamp();
    for (const [el, off] of [[under, CROP_INSET], [top, 0]]) {
      el.style.width = `${W * k}px`;
      el.style.height = `${H * k}px`;
      el.style.transform = `translate(${off + tx}px, ${off + ty}px)`;
    }
    slider.value = kMax > kMin ? String(Math.log(k / kMin) / Math.log(kMax / kMin)) : '0';
  };
  const current = () => ({ x: -tx / (W * k), y: -ty / (H * k), w: D / (W * k), h: D / (H * k) });
  const show = (c) => {
    D = stage.clientWidth - 2 * CROP_INSET;
    kMin = D / Math.min(W, H);
    kMax = kMin * CROP_ZOOM;
    k = D / (c.w * W);
    tx = -c.x * W * k;
    ty = -c.y * H * k;
    draw();
  };
  /** Zoom by `f`, keeping the point (px, py) in the circle still. */
  const zoom = (f, px = D / 2, py = D / 2) => {
    const k2 = Math.min(kMax, Math.max(kMin, k * f));
    tx = px - ((px - tx) * k2) / k;
    ty = py - ((py - ty) * k2) / k;
    k = k2;
    draw();
  };
  const local = (e) => {
    const r = stage.getBoundingClientRect();
    return [e.clientX - r.left - CROP_INSET, e.clientY - r.top - CROP_INSET];
  };

  const pointers = new Map();
  let gesture = null; // the last two-finger midpoint and spread
  const pinch = () => {
    const [a, b] = [...pointers.values()];
    return { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1 };
  };
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    gesture = pointers.size === 2 ? pinch() : null;
    stage.classList.add('dragging');
  });
  stage.addEventListener('pointermove', (e) => {
    const was = pointers.get(e.pointerId);
    if (!was) return;
    const now = local(e);
    pointers.set(e.pointerId, now);
    if (pointers.size === 1) {
      tx += now[0] - was[0];
      ty += now[1] - was[1];
      draw();
    } else if (pointers.size === 2 && gesture) {
      const g = pinch();
      tx += g.x - gesture.x;
      ty += g.y - gesture.y;
      zoom(g.d / gesture.d, g.x, g.y);
      gesture = g;
    }
  });
  const lift = (e) => {
    pointers.delete(e.pointerId);
    gesture = pointers.size === 2 ? pinch() : null;
    if (!pointers.size) stage.classList.remove('dragging');
  };
  stage.addEventListener('pointerup', lift);
  stage.addEventListener('pointercancel', lift);
  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      // A trackpad pinch arrives as a wheel with ctrlKey, in smaller steps.
      zoom(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), ...local(e));
    },
    { passive: false },
  );
  stage.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 40 : 8;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) {
      tx += moves[e.key][0];
      ty += moves[e.key][1];
      draw();
    } else if (e.key === '+' || e.key === '=') zoom(1.1);
    else if (e.key === '-' || e.key === '_') zoom(1 / 1.1);
    else return;
    e.preventDefault();
  });
  slider.addEventListener('input', () => zoom((kMin * (kMax / kMin) ** Number(slider.value)) / k));
  dlg.querySelector('.crop-reset').addEventListener('click', () => show(centredCrop(W, H)));
  const resized = new ResizeObserver(() => D && stage.clientWidth - 2 * CROP_INSET !== D && show(current()));

  dlg.returnValue = '';
  dlg.showModal();
  show(crop ?? centredCrop(W, H));
  resized.observe(stage);
  stage.focus({ focusVisible: false });
  return new Promise((resolve) =>
    dlg.addEventListener(
      'close',
      () => {
        resized.disconnect();
        const out = dlg.returnValue === 'ok' ? current() : null;
        dlg.remove();
        resolve(out);
      },
      { once: true },
    ),
  );
}

/** Crop `original` (a JPEG data URL) and stage the result; nothing changes if you cancel. */
async function cropAndStage(original, crop) {
  const c = await cropDialog(original, crop);
  if (!c || !draft) return;
  draft.photo = { action: 'set', data: await croppedJpeg(original, c), original, crop: c };
  renderDetail();
}

async function stagePhoto(file) {
  try {
    if (!file || !/^image\//.test(file.type)) throw new Error('Choose an image file.');
    await cropAndStage((await originalJpeg(file)).data, null);
  } catch (e) {
    toast(e.message);
  }
}

/** Change the crop of the photo being shown: a new one, or the contact’s current one. */
async function recropPhoto() {
  try {
    if (draft.photo?.action === 'set') return await cropAndStage(draft.photo.original, draft.photo.crop);
    const r = await api(`/contacts/${encodeURIComponent(S.detail.id)}/photo/original`);
    // Kept originals are already JPEG; a photo from Google may not be.
    await cropAndStage(r.crop ? r.image : (await originalJpeg(r.image)).data, r.crop);
  } catch (e) {
    handleError(e);
  }
}

/** Send a staged photo change; returns the updated contact, or null if none. */
async function savePhoto(id, etag) {
  const ph = draft?.photo;
  if (!ph) return null;
  if (ph.action === 'remove') {
    return api(`/contacts/${encodeURIComponent(id)}/photo?etag=${encodeURIComponent(etag)}`, { method: 'DELETE' });
  }
  return api(`/contacts/${encodeURIComponent(id)}/photo`, { method: 'PUT', body: { etag, image: ph.data, original: ph.original, crop: ph.crop } });
}

function editsFromDraft() {
  if (S.mode === 'new') {
    const { accountId, photo, ...edit } = draft;
    void accountId, photo;
    return edit;
  }
  const c = S.detail.card;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const norm = (list) => list.map((x) => ({ value: x.value.trim(), label: x.label.trim() })).filter((x) => x.value);
  const edit = {};
  for (const k of ['givenName', 'familyName', 'organization', 'title', 'notes']) if (draft[k] !== c[k]) edit[k] = draft[k];
  for (const k of ['phones', 'emails', 'urls']) if (!same(norm(draft[k]), norm(c[k]))) edit[k] = norm(draft[k]);
  const addrs = (list) =>
    list
      .map((a) => Object.fromEntries(['label', ...ADDRESS_PARTS].map((p) => [p, (a[p] ?? '').trim()])))
      .filter((a) => ADDRESS_PARTS.some((p) => a[p]));
  const before = c.addresses.map((a) => ({ ...a, street: a.street ?? a.value }));
  if (!same(addrs(draft.addresses), addrs(before))) edit.addresses = addrs(draft.addresses);
  return edit;
}

async function saveEditor() {
  const btn = $('#save-btn');
  if (btn) btn.disabled = true;
  try {
    if (S.mode === 'new') {
      const asDraft = !!draft.asDraft;
      let d = await api('/contacts', { method: 'POST', body: { accountId: draft.accountId, edit: editsFromDraft(), draft: asDraft } });
      let photoError = '';
      d = (await savePhoto(d.id, d.etag).catch((e) => ((photoError = e.message), null))) ?? d;
      S.mode = 'view';
      S.detail = d;
      S.selectedId = d.id;
      await loadContacts();
      markOpen();
      const what = asDraft ? 'Draft saved. It’s only in Ligatures' : 'Contact created in Google';
      toast(photoError ? `${what}, but the photo didn’t save: ${photoError}` : `${what}.`, photoError ? 7000 : 4000);
    } else {
      const edit = editsFromDraft();
      if (!Object.keys(edit).length && !draft.photo) {
        S.mode = 'view';
        draft = null;
        return renderDetail();
      }
      let d = Object.keys(edit).length
        ? await api(`/contacts/${encodeURIComponent(S.detail.id)}`, { method: 'PATCH', body: { etag: S.detail.etag, edit } })
        : S.detail;
      S.detail = d;
      d = (await savePhoto(d.id, d.etag)) ?? d;
      S.mode = 'view';
      S.detail = d;
      await loadContacts();
      toast(d.draft ? 'Saved.' : 'Saved to Google.');
    }
    draft = null;
    renderDetail();
  } catch (e) {
    if (draft) draft.asDraft = false;
    if (e.code === 'conflict' && e.data?.contact) {
      S.mode = 'view';
      S.detail = e.data.contact;
      draft = null;
      renderDetail();
      toast(e.message, 7000);
      loadContacts();
      return;
    }
    if (btn) btn.disabled = false;
    handleError(e);
  }
}

/** Turn a real contact into a draft: kept here, taken out of Google. Offered while editing. */
async function makeDraft() {
  const d = S.detail;
  if (!d || d.draft) return;
  const name = d.card.displayName || 'this contact';
  const ok = await confirmDialog({
    title: `Make ${name} a draft?`,
    body: 'They’re deleted from Google Contacts, so they leave your iPhone and Mac. Everything (details, photo, lists, your fields) stays here as a draft, and you can add them back to Google anytime. Unsaved edits are discarded.',
    action: 'Make Draft',
  });
  if (!ok) return;
  try {
    const next = await api(`/contacts/${encodeURIComponent(d.id)}/demote`, { method: 'POST', body: { etag: d.etag } });
    draft = null;
    S.mode = 'view';
    S.detail = next;
    await loadContacts();
    renderDetail();
    toast(`${name} is now a draft, only in Ligatures.`, 4000);
  } catch (e) {
    handleError(e);
  }
}

/** Make a draft real: create it in Google, with its photo and lists. */
async function promoteDraft() {
  const d = S.detail;
  if (!d?.draft) return;
  const btn = $('[data-action="promote-contact"]');
  if (btn) btn.disabled = true;
  try {
    S.detail = await api(`/contacts/${encodeURIComponent(d.id)}/promote`, { method: 'POST' });
    await loadContacts();
    renderDetail();
    toast(`Added ${d.card.givenName || d.card.displayName || 'them'} to Google Contacts.`, 4000);
  } catch (e) {
    if (btn) btn.disabled = false;
    handleError(e);
  }
}

async function confirmDiscard() {
  if (!draft) return true;
  return window.confirm('Discard your unsaved changes?');
}

// ---------------------------------------------------------------- deleting

/** A yes/no dialog. Resolves true if the destructive button was pressed. */
function confirmDialog({ title, body, action }) {
  const dlg = $('#confirm-dlg');
  dlg.innerHTML = `<form method="dialog" class="dlg">
      <h2 id="confirm-title">${h(title)}</h2>
      <p>${h(body)}</p>
      <div class="dlg-foot">
        <button class="btn" value="cancel" autofocus>Cancel</button>
        <button class="btn destructive" value="ok">${h(action)}</button>
      </div>
    </form>`;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

async function deleteContacts(ids, etags = {}) {
  const names = ids.map((id) => S.contacts.find((c) => c.id === id)?.displayName || 'this contact');
  const one = ids.length === 1;
  const ok = await confirmDialog({
    title: one ? `Delete “${names[0]}”?` : `Delete ${ids.length} contacts?`,
    body: `${one ? 'This deletes the contact' : 'This deletes them'} from Google Contacts, so ${one ? 'it' : 'they'} also disappear${one ? 's' : ''} from your iPhone and Mac. Google Contacts keeps deleted contacts in its Trash for 30 days.`,
    action: one ? 'Delete' : `Delete ${ids.length}`,
  });
  if (!ok) return;
  const deleted = [];
  const changed = [];
  try {
    for (let i = 0; i < ids.length; i += 200) {
      const r = await api('/contacts/delete', { method: 'POST', body: { ids: ids.slice(i, i + 200), etags } });
      deleted.push(...r.deleted, ...r.missing);
      changed.push(...r.changed);
    }
  } catch (e) {
    handleError(e);
  }
  for (const id of deleted) S.selected.delete(id);
  if (S.selectedId && deleted.includes(S.selectedId)) {
    draft = null;
    S.mode = 'view';
    S.detail = null;
    setDrawer(false);
    S.selectedId = null;
  }
  await loadContacts();
  if (changed.length) {
    toast(
      `${deleted.length ? `Deleted ${plural(deleted.length, 'contact')}. ` : ''}${plural(changed.length, 'contact')} ${changed.length === 1 ? 'wasn’t' : 'weren’t'} deleted because ${changed.length === 1 ? 'it' : 'they'} changed in Google since your last sync. Sync and try again.`,
      8000,
    );
  } else if (deleted.length) toast(`Deleted ${plural(deleted.length, 'contact')} from Google.`);
}

// ---------------------------------------------------------------- archive
// Archiving keeps everything Google has on someone (every field, their photo, their lists)
// in Ligature, then deletes them from Google. Restoring puts them back.

async function archiveAction(action, ids, etags = {}) {
  if (!ids.length) return;
  const pool = action === 'archive' ? S.contacts : S.archived;
  const name = (id) => pool.find((c) => c.id === id)?.displayName || 'this contact';
  const one = ids.length === 1;
  if (action === 'forget') {
    const ok = await confirmDialog({
      title: one ? `Delete “${name(ids[0])}” forever?` : `Delete ${ids.length} archived contacts forever?`,
      body: `${one ? 'Their' : 'Their'} details, your fields and relationships are removed from Ligatures. This can’t be undone.`,
      action: 'Delete Forever',
    });
    if (!ok) return;
  }
  const done = [];
  const skipped = [];
  try {
    for (let i = 0; i < ids.length; i += 100) {
      const r = await api('/archive', { method: 'POST', body: { action, ids: ids.slice(i, i + 100), etags } });
      done.push(...r.done);
      skipped.push(...r.skipped);
    }
  } catch (e) {
    handleError(e);
  }
  for (const id of done) S.selected.delete(id);
  if (S.selectedId && done.includes(S.selectedId)) {
    S.mode = 'view';
    S.detail = null;
    setDrawer(false);
    S.selectedId = null;
  }
  await loadContacts();
  const n = plural(done.length, 'contact');
  const verb = { archive: 'Archived', restore: 'Restored', forget: 'Deleted' }[action];
  let msg = done.length
    ? {
        archive: `${verb} ${n}. ${done.length === 1 ? 'They’re' : 'They’re'} out of Google Contacts; find ${done.length === 1 ? 'them' : 'them'} under Archived.`,
        restore: `${verb} ${n} to Google Contacts.`,
        forget: `${verb} ${n} for good.`,
      }[action]
    : '';
  if (skipped.length) {
    const changed = skipped.filter((s) => s.reason === 'changed').length;
    msg += ` ${plural(skipped.length, 'contact')} ${skipped.length === 1 ? 'wasn’t' : 'weren’t'} ${action === 'archive' ? 'archived' : 'restored'}${
      changed ? ' because they changed in Google since your last sync. Sync and try again' : `: ${skipped[0].reason}`
    }.`;
  }
  if (msg) toast(msg.trim(), skipped.length ? 8000 : 5000);
}

// ---------------------------------------------------------------- your fields dialog

function renderFieldsDialog() {
  const dlg = $('#fields-dlg');
  const fields = S.session.fields;
  const typeSelect = (value, attrs) =>
    `<select class="input" ${attrs}>${[
      ['text', 'Text'],
      ['longtext', 'Long text'],
      ['date', 'Date'],
      ['url', 'Link'],
      ['checkbox', 'Checkbox'],
    ]
      .map(([v, l]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${l}</option>`)
      .join('')}</select>`;
  const accounts = S.session.accounts;
  const listSelect = (f, attrs) => {
    const value = f?.listId ? `${f.accountId}|${f.listId}` : '';
    const opts = (a) =>
      nestedLists(a.id)
        .filter(({ g }) => g.id !== 'contactGroups/myContacts')
        .map(({ g, depth }) => `<option value="${h(`${a.id}|${g.id}`)}" ${`${a.id}|${g.id}` === value ? 'selected' : ''}>${h(indentedName(g.name, depth))}</option>`)
        .join('');
    const gone = f?.listId && !fieldList(f) ? `<option value="${h(value)}" selected disabled>${h(fieldListName(f))} (deleted)</option>` : '';
    return `<select class="input" ${attrs}><option value="">Every contact</option>${gone}${
      accounts.length > 1 ? accounts.map((a) => `<optgroup label="${h(a.label)}">${opts(a)}</optgroup>`).join('') : accounts.map(opts).join('')
    }</select>`;
  };
  const viewing = S.filter.type === 'group' && S.filter.id !== 'contactGroups/myContacts' ? { accountId: S.filter.accountId, listId: S.filter.id } : null;
  dlg.innerHTML = `
    <form method="dialog" class="dlg" id="fields-form">
      <h2 id="fields-title">Your fields</h2>
      <p>Extra fields on every contact, or only on people in one list. They’re stored only in Ligatures and never sync to Google, iPhone or Mac.</p>
      ${fields
        .map(
          (f) => `<div class="field-row">
            <input class="input" aria-label="Field name" data-field-label="${h(f.id)}" value="${h(f.label)}">
            ${typeSelect(f.type, `aria-label="Type of ${h(f.label)}" data-field-type="${h(f.id)}"${f.key ? ' disabled' : ''}`)}
            ${listSelect(f, `aria-label="Who has ${h(f.label)}" data-field-list="${h(f.id)}"${f.key ? ' disabled' : ''}`)}
            ${
              f.key
                ? `<span class="field-builtin" title="${f.key === 'signal' ? 'Built in: adds a Signal button' : f.key === 'signal_username' ? 'Built in: the Signal button uses it' : 'Built in: places people on the map'}">${ICON.pin}</span>`
                : `<button type="button" class="icon-btn" data-action="delete-field" data-id="${h(f.id)}" aria-label="Delete ${h(f.label)}">${ICON.x}</button>`
            }
          </div>`,
        )
        .join('')}
      <div class="field-row">
        <input class="input" id="new-field-label" aria-label="New field name" placeholder="New field">
        ${typeSelect('text', 'id="new-field-type" aria-label="New field type"')}
        ${listSelect(viewing, 'id="new-field-list" aria-label="Who has the new field"')}
        <button type="button" class="icon-btn" data-action="add-field" aria-label="Add field">${ICON.plus}</button>
      </div>
      <div class="dlg-foot"><button class="btn primary" value="close">Done</button></div>
    </form>`;
}

async function fieldsChanged() {
  await refreshSession();
  renderFieldsDialog();
  if (S.mode === 'view') renderDetail();
}

// ---------------------------------------------------------------- messaging: picking people

function toggleChecked(id) {
  if (S.selected.has(id)) S.selected.delete(id);
  else S.selected.add(id);
  S.anchorId = id;
}

function selectRange(id) {
  const items = visibleContacts();
  const from = items.findIndex((c) => c.id === (S.anchorId ?? S.selectedId));
  const to = items.findIndex((c) => c.id === id);
  if (from < 0 || to < 0) return toggleChecked(id);
  const [lo, hi] = from < to ? [from, to] : [to, from];
  for (let i = lo; i <= hi; i++) S.selected.add(items[i].id);
  S.anchorId = id;
}

function clearSelection() {
  S.selected.clear();
  S.anchorId = null;
  syncChecks();
}

// ---------------------------------------------------------------- messaging: composer
//
// Steps: compose → review → send (email goes out through Gmail one by one; texts, WhatsApp
// and Signal open in their apps one at a time, and you mark each sent) → done.

let C = null;
const DRAFT_KEY = 'ligature-compose';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const needs = () => CHANNELS[C.channel].needs;
const emailAccounts = () => S.session.accounts.filter((a) => a.provider === 'google');
const sender = () => S.session.accounts.find((a) => a.id === C.accountId);

function recipientLabel(fromSelection) {
  if (fromSelection) return 'Selected people';
  const f = S.filter;
  let base = 'All Contacts';
  if (f.type === 'group') base = S.session.accounts.flatMap((a) => a.groups).find((g) => g.id === f.id)?.name ?? 'List';
  if (f.type === 'account') base = S.session.accounts.find((a) => a.id === f.id)?.label ?? 'Account';
  const q = S.query.trim();
  return q ? `${base} matching “${q}”` : base;
}

async function openComposer() {
  const fromSelection = S.selected.size > 0;
  const ids = (fromSelection ? sortContacts(S.contacts.filter((c) => S.selected.has(c.id))) : visibleContacts()).map((c) => c.id);
  if (!ids.length) return toast('No one to message.');
  const from = S.session.accounts.find((a) => a.canEmail) ?? emailAccounts()[0];
  C = {
    step: 'loading',
    ids,
    label: recipientLabel(fromSelection),
    people: [],
    channel: 'email',
    mode: 'individual',
    groupTo: 'bcc',
    accountId: from?.id ?? '',
    subject: '',
    body: '',
    picks: {},
    skipped: [],
    previewIndex: 0,
    focus: 'body',
    items: [],
    results: {},
    errors: {},
    queueIndex: 0,
    sending: false,
    stopping: false,
  };
  renderComposer();
  $('#compose-dlg').showModal();
  await loadPeople();
}

async function loadPeople(nextStep = 'compose') {
  try {
    const { contacts } = await api('/contacts/lookup', { method: 'POST', body: { ids: C.ids } });
    const byId = new Map(contacts.map((c) => [c.id, c]));
    C.people = C.ids.map((id) => byId.get(id)).filter(Boolean);
    C.step = nextStep;
  } catch (e) {
    handleError(e);
    closeComposer(true);
    return;
  }
  renderComposer();
  $('#c-body')?.focus();
}

/** Returns false if the composer should stay open. */
function closeComposer(force = false) {
  if (!C) return true;
  if (!force) {
    if (C.sending) {
      toast('Sending… press Stop first.');
      return false;
    }
    const unsent = (C.step === 'compose' || C.step === 'review') && (C.body.trim() || C.subject.trim());
    if (unsent && !window.confirm('Discard this message?')) return false;
  }
  const finished = C.step === 'done';
  C = null;
  const dlg = $('#compose-dlg');
  if (dlg?.open) dlg.close();
  if (finished) {
    clearSelection();
  }
  return true;
}

// Keeps a draft across the round trip to Google when connecting Gmail.
function saveDraft() {
  try {
    const { people, items, results, errors, sending, stopping, ...keep } = C;
    void people, items, results, errors, sending, stopping;
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ ...keep, step: 'review', viewFilter: S.filter, viewQuery: S.query }));
  } catch {
    /* storage unavailable: the draft is lost, which only costs retyping */
  }
}

async function resumeComposer() {
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null');
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    return;
  }
  if (!saved?.ids?.length) return;
  // Come back to the list you were looking at.
  if (saved.viewFilter) S.filter = saved.viewFilter;
  if (saved.viewQuery) {
    S.query = saved.viewQuery;
    const q = $('#q');
    if (q) q.value = S.query;
  }
  delete saved.viewFilter;
  delete saved.viewQuery;
  renderSidebar();
  renderGrid();
  C = { ...saved, step: 'loading', people: [], items: [], results: {}, errors: {}, queueIndex: 0, sending: false, stopping: false };
  renderComposer();
  $('#compose-dlg').showModal();
  await loadPeople(saved.step === 'compose' ? 'compose' : 'review');
}

// ---- who can be reached, and at which address

function optionsFor(p) {
  return needs() === 'email' ? p.emails : p.phones;
}

function addressFor(p) {
  const opts = optionsFor(p);
  const picked = C.picks[`${needs()}:${p.id}`];
  if (picked && opts.some((o) => o.value === picked)) return picked;
  return needs() === 'email' ? defaultEmail(opts) : defaultPhone(opts);
}

const reachable = () => C.people.filter((p) => addressFor(p));
const unreachable = () => C.people.filter((p) => !addressFor(p));
const included = () => reachable().filter((p) => !C.skipped.includes(p.id));
const personName = (p) => p.displayName || addressFor(p) || 'No name';

function templateProblems() {
  const texts = needs() === 'email' ? [C.subject, C.body] : [C.body];
  const problems = [];
  const unknown = unknownTags(texts, S.session.fields);
  if (unknown.length) problems.push(`No field called ${unknown.map((u) => `“${u}”`).join(', ')}. Use Insert Field to pick one.`);
  if (C.mode === 'group' && texts.some((t) => findTags(t).length)) problems.push('Fields like {{First name}} only work when sending individually.');
  return problems;
}

function canReview() {
  return C.body.trim() && (needs() !== 'email' || C.subject.trim()) && !templateProblems().length && reachable().length;
}

function buildItems() {
  const fields = S.session.fields;
  const ppl = included();
  if (C.mode === 'group') {
    return [{ ids: ppl.map((p) => p.id), people: ppl, name: plural(ppl.length, 'person', 'people'), subject: C.subject, body: C.body }];
  }
  return ppl.map((p) => ({
    ids: [p.id],
    people: [p],
    name: personName(p),
    subject: render(C.subject, p, fields).text,
    body: render(C.body, p, fields).text,
  }));
}

// ---- rendering

function seg(name, options, value) {
  return `<div class="seg" role="group" aria-label="${h(name)}">${options
    .map(
      ([v, label, disabled]) =>
        `<button type="button" data-seg="${h(name)}" data-value="${h(v)}" aria-pressed="${v === value}" ${disabled ? 'disabled' : ''}>${h(label)}</button>`,
    )
    .join('')}</div>`;
}

function renderComposer() {
  const dlg = $('#compose-dlg');
  if (!dlg || !C) return;
  const views = { loading: viewLoading, compose: viewCompose, review: viewReview, send: viewSend, done: viewDone };
  const [title, body, foot] = views[C.step]();
  dlg.innerHTML = `
    <div class="cmp-head">
      <h2 id="compose-title">${h(title)}</h2>
      <button type="button" class="icon-btn" data-action="compose-close" aria-label="Close">${ICON.x}</button>
    </div>
    <div class="cmp-body">${body}</div>
    <div class="cmp-foot">${foot}</div>`;
}

function viewLoading() {
  return ['New Message', `<p class="muted">Loading ${plural(C.ids.length, 'contact')}…</p>`, ''];
}

/** The parts of the compose step that change as you type. */
function composeLive() {
  const fields = S.session.fields;
  const isEmail = C.channel === 'email';
  const sample = reachable();
  const p = sample.length ? sample[C.previewIndex % sample.length] : null;
  const problems = templateProblems();
  let html = problems.length
    ? `<div></div><div class="cmp-stack">${problems.map((x) => `<p class="note warn" role="alert">${h(x)}</p>`).join('')}</div>`
    : '';
  if (p && C.mode === 'individual' && (C.body.trim() || C.subject.trim())) {
    const subj = render(C.subject, p, fields);
    const body = render(C.body, p, fields);
    const blanks = [...new Set([...(isEmail ? subj.blanks : []), ...body.blanks])];
    html += `<div class="cmp-label">Preview</div>
      <div class="preview">
        <div class="preview-h">
          <span>${h(personName(p))}</span>
          ${
            sample.length > 1
              ? `<span class="preview-nav">
                  <button type="button" class="icon-btn" data-action="preview-prev" aria-label="Previous person">‹</button>
                  <span class="muted">${(C.previewIndex % sample.length) + 1} of ${sample.length}</span>
                  <button type="button" class="icon-btn" data-action="preview-next" aria-label="Next person">›</button>
                </span>`
              : ''
          }
        </div>
        ${isEmail ? `<div class="preview-subj">${subj.text ? h(subj.text) : '<span class="muted">No subject</span>'}</div>` : ''}
        <div class="preview-body">${h(body.text)}</div>
        ${blanks.length ? `<p class="hint warn-text">Blank for ${h(personName(p))}: ${h(blanks.join(', '))}</p>` : ''}
      </div>`;
  }
  return html;
}

function updateComposeLive() {
  const live = $('#c-live');
  if (!live || !C || C.step !== 'compose') return;
  live.innerHTML = composeLive();
  const btn = $('[data-action="compose-review"]');
  if (btn) btn.disabled = !canReview();
}

function viewCompose() {
  const fields = S.session.fields;
  const isEmail = C.channel === 'email';
  const groupOk = CHANNELS[C.channel].group;
  if (!groupOk) C.mode = 'individual';
  const missing = unreachable().length;

  const tagOptions = [...BUILTIN_TAGS, ...fields.map((f) => f.label)];
  const html = `
    <div class="cmp-grid">
      <div class="cmp-label">To</div>
      <div><span><b>${h(C.label)}</b> <span class="muted">· ${plural(C.people.length, 'person', 'people')}${
        missing ? `, ${missing} without ${needs() === 'email' ? 'an email address' : 'a phone number'}` : ''
      }</span></span></div>

      <div class="cmp-label">Send by</div>
      <div>${seg('channel', Object.entries(CHANNELS).map(([k, c]) => [k, c.label]), C.channel)}</div>

      <div class="cmp-label">Send</div>
      <div class="cmp-stack">
        ${seg('mode', [['individual', 'Individually'], ['group', 'As a group', !groupOk]], C.mode)}
        <span class="hint">${
          !groupOk
            ? `${CHANNELS[C.channel].label} can’t start a group chat from a link, so each person gets their own message.`
            : C.mode === 'individual'
              ? 'Each person gets their own copy, with their name and fields filled in.'
              : isEmail
                ? 'One email to everyone.'
                : 'Opens one group conversation in Messages.'
        }</span>
      </div>

      ${
        isEmail && C.mode === 'group'
          ? `<div class="cmp-label">Recipients</div>
             <div class="cmp-stack">${seg('groupTo', [['bcc', 'BCC'], ['to', 'To']], C.groupTo)}
             <span class="hint">${C.groupTo === 'bcc' ? 'Private: nobody sees who else got it.' : 'Everyone sees everyone’s address, and Reply All reaches the group.'}</span></div>`
          : ''
      }

      ${
        isEmail
          ? `<label class="cmp-label" for="c-subject">Subject</label>
             <input class="input" id="c-subject" data-c="subject" value="${h(C.subject)}" autocomplete="off">`
          : ''
      }

      <label class="cmp-label" for="c-body">Message</label>
      <div class="cmp-stack">
        <textarea class="input cmp-text" id="c-body" data-c="body" rows="8">${h(C.body)}</textarea>
        ${
          C.mode === 'individual'
            ? `<div class="tag-row">
                <select class="input tag-select" id="c-tag" aria-label="Insert a field">
                  <option value="">Insert Field…</option>
                  ${tagOptions.map((t) => `<option value="${h(t)}">${h(t)}</option>`).join('')}
                </select>
                <span class="hint">Add a fallback for blanks: <code>{{First name|there}}</code></span>
              </div>`
            : ''
        }
      </div>

      <div id="c-live" class="cmp-live">${composeLive()}</div>
    </div>`;
  const foot = `<button type="button" class="btn" data-action="compose-close">Cancel</button>
    <button type="button" class="btn primary" data-action="compose-review" ${canReview() ? '' : 'disabled'}>Review</button>`;
  return ['New Message', html, foot];
}

function viewReview() {
  const fields = S.session.fields;
  const isEmail = C.channel === 'email';
  const individual = C.mode === 'individual';
  const ppl = reachable();
  const n = included().length;
  const away = unreachable();
  const acct = sender();
  const accounts = emailAccounts();

  const blanksByTag = new Map();
  const rows = ppl
    .map((p) => {
      const on = !C.skipped.includes(p.id);
      const opts = optionsFor(p);
      const addr = addressFor(p);
      const s = individual && isEmail ? render(C.subject, p, fields) : null;
      const b = individual ? render(C.body, p, fields) : null;
      const blanks = [...new Set([...(s?.blanks ?? []), ...(b?.blanks ?? [])])];
      if (on) for (const t of blanks) blanksByTag.set(t, (blanksByTag.get(t) ?? 0) + 1);
      return `<li class="rv-row${on ? '' : ' off'}">
        <label class="rv-who"><input type="checkbox" data-rv="${h(p.id)}" ${on ? 'checked' : ''}> <span>${h(personName(p))}</span></label>
        ${
          opts.length > 1
            ? `<select class="input rv-addr" data-pick="${h(p.id)}" aria-label="Address for ${h(personName(p))}">${opts
                .map((o) => `<option value="${h(o.value)}" ${o.value === addr ? 'selected' : ''}>${h(o.value)}${o.label ? ` · ${h(o.label)}` : ''}</option>`)
                .join('')}</select>`
            : `<span class="rv-addr muted">${h(addr)}</span>`
        }
        ${
          individual
            ? `<details class="rv-msg"><summary>${h((s ? s.text : b.text.split('\n')[0]) || '(empty)')}${
                blanks.length ? ` <span class="warn-text">· blank ${h(blanks.join(', '))}</span>` : ''
              }</summary><div class="preview-body">${h(b.text)}</div></details>`
            : ''
        }
      </li>`;
    })
    .join('');

  const notes = [];
  if (away.length) {
    const names = away.slice(0, 6).map(personName).join(', ') + (away.length > 6 ? `, and ${away.length - 6} more` : '');
    notes.push(`<p class="note">Left out ${plural(away.length, 'person', 'people')} with no ${isEmail ? 'email address' : 'phone number'}: ${h(names)}.</p>`);
  }
  for (const [tag, count] of blanksByTag) {
    notes.push(`<p class="note warn">“${h(tag)}” is blank for ${plural(count, 'person', 'people')}. Add a fallback like <code>{{${h(tag)}|…}}</code>, or open their message below.</p>`);
  }
  if (isEmail && individual && n > 100) notes.push('<p class="note">Gmail lets a personal account send about 500 emails a day.</p>');
  if (isEmail && C.mode === 'group' && n > 100) notes.push('<p class="note warn">Gmail takes at most 100 people on one email. Untick some, or send individually.</p>');

  const fromRow = isEmail
    ? `<div class="cmp-label">From</div>
       <div class="cmp-stack">${
         accounts.length > 1
           ? `<select class="input" id="c-from" aria-label="Send from">${accounts
               .map((a) => `<option value="${h(a.id)}" ${a.id === C.accountId ? 'selected' : ''}>${h(a.label)}${a.canEmail ? '' : ' (not connected)'}</option>`)
               .join('')}</select>`
           : `<span>Your Gmail <span class="muted">· the Google account you signed in with</span></span>`
       }
       ${
         acct && !acct.canEmail
           ? `<p class="note">To send, Ligatures needs your permission to send email from this Gmail account. Google asks once. Ligatures can send email only; it can’t read your mail.</p>`
           : ''
       }</div>`
    : '';

  const html = `
    <div class="cmp-grid">
      <div class="cmp-label">Sending</div>
      <div>${h(CHANNELS[C.channel].label)}, ${individual ? 'individually' : isEmail ? `as one email (${C.groupTo === 'bcc' ? 'BCC' : 'To'})` : 'as a group'}</div>
      ${fromRow}
      ${
        !individual
          ? `<div class="cmp-label">Message</div><div class="preview">${isEmail ? `<div class="preview-subj">${h(C.subject)}</div>` : ''}<div class="preview-body">${h(C.body)}</div></div>`
          : ''
      }
    </div>
    ${notes.join('')}
    <div class="rv-head"><b>${plural(n, 'recipient')}</b>
      <span>${n < ppl.length ? '<button type="button" class="link" data-action="rv-all">Include All</button>' : '<button type="button" class="link" data-action="rv-none">Untick All</button>'}</span></div>
    <ul class="rv-list">${rows}</ul>`;

  const overLimit = isEmail && C.mode === 'group' && n > 100;
  let action;
  if (isEmail && acct && !acct.canEmail) action = `<button type="button" class="btn primary" data-action="connect-gmail">Connect Gmail…</button>`;
  else if (isEmail) action = `<button type="button" class="btn primary" data-action="start-send" ${n && !overLimit ? '' : 'disabled'}>${individual ? `Send ${plural(n, 'Email')}` : `Send to ${plural(n, 'Person', 'People')}`}</button>`;
  else if (individual) action = `<button type="button" class="btn primary" data-action="start-send" ${n ? '' : 'disabled'}>Start (${n})</button>`;
  else action = `<button type="button" class="btn primary" data-action="start-send" ${n ? '' : 'disabled'}>Continue</button>`;

  const foot = `<button type="button" class="btn" data-action="compose-back">Back</button>${action}`;
  return ['Review', html, foot];
}

function viewSend() {
  return C.channel === 'email' ? viewEmailProgress() : viewQueue();
}

function viewEmailProgress() {
  const total = C.items.length;
  const sent = Object.values(C.results).filter((r) => r === 'sent').length;
  const failed = Object.values(C.results).filter((r) => r === 'failed').length;
  const list = C.items
    .map((it, i) => {
      const r = C.results[i];
      const st =
        r === 'sent' ? '<span class="st ok">Sent</span>'
        : r === 'failed' ? `<span class="st err">${h(C.errors[i] || 'Failed')}</span>`
        : r === 'sending' ? '<span class="st">Sending…</span>'
        : '<span class="st muted">Waiting</span>';
      return `<li><span>${h(it.name)}</span>${st}</li>`;
    })
    .join('');
  const html = `
    <p>${sent} of ${total} sent${failed ? `, ${failed} failed` : ''}</p>
    <progress class="bar" max="${total}" value="${sent}" aria-label="Emails sent"></progress>
    <ul class="send-list">${list}</ul>`;
  const foot = C.sending
    ? `<button type="button" class="btn" data-action="stop-send" ${C.stopping ? 'disabled' : ''}>${C.stopping ? 'Stopping…' : 'Stop'}</button>`
    : `${C.needsGmail ? '<button type="button" class="btn" data-action="connect-gmail">Connect Gmail…</button>' : ''}
       ${failed || sent + failed < total ? `<button type="button" class="btn" data-action="retry-send">${failed ? 'Retry Failed' : 'Send the Rest'}</button>` : ''}
       <button type="button" class="btn primary" data-action="finish-send">Done</button>`;
  return ['Sending Email', html, foot];
}

function queueLink(it) {
  const numbers = it.people.map(addressFor);
  if (C.channel === 'text') return { href: smsHref(numbers, it.body), label: 'Open in Messages', external: false };
  if (C.channel === 'whatsapp') return { href: whatsappHref(numbers[0], it.body), label: 'Open in WhatsApp', external: true };
  return { href: signalHref(numbers[0]), label: 'Copy and Open Signal', external: true, copyFirst: true };
}

function viewQueue() {
  const total = C.items.length;
  const it = C.items[C.queueIndex];
  const link = queueLink(it);
  const numbers = it.people.map(addressFor);
  const html = `
    <div class="q-top"><span>${C.mode === 'group' ? 'Group message' : `${C.queueIndex + 1} of ${total}`}</span>
      <progress class="bar" max="${total}" value="${C.queueIndex}" aria-label="Progress"></progress></div>
    <div class="q-card">
      <h3>${h(it.name)}</h3>
      <p class="muted">${h(numbers.join(', '))}</p>
      <div class="bubble">${h(it.body)}</div>
      <div class="q-actions">
        ${
          link.copyFirst
            ? `<button type="button" class="btn primary" data-action="q-signal" data-href="${h(link.href)}">${h(link.label)} ${ICON.open}</button>`
            : `<a class="btn primary" href="${h(link.href)}" ${link.external ? 'target="_blank" rel="noopener noreferrer"' : ''} data-action="q-opened">${h(link.label)} ${ICON.open}</a>`
        }
        <button type="button" class="btn" data-action="q-copy">Copy Message</button>
      </div>
      <p class="hint">${
        C.channel === 'signal'
          ? 'Signal links can’t carry a message, so it’s copied for you. Paste it into the chat, send, then come back here.'
          : `Send it in ${CHANNELS[C.channel].app}, then come back here.`
      }${C.channel === 'text' ? ' Works on Mac and iPhone; other computers may not open Messages.' : ''}</p>
    </div>`;
  const foot = `<button type="button" class="btn" data-action="compose-close">Stop</button>
    <span class="grow"></span>
    <button type="button" class="btn" data-action="q-skip">${C.mode === 'group' ? 'Didn’t Send' : 'Skip'}</button>
    <button type="button" class="btn primary" data-action="q-sent">${C.mode === 'group' || C.queueIndex === total - 1 ? 'Sent' : 'Sent · Next'}</button>`;
  return [CHANNELS[C.channel].label, html, foot];
}

function viewDone() {
  const sent = C.items.filter((_, i) => C.results[i] === 'sent');
  const people = sent.reduce((n, it) => n + it.ids.length, 0);
  const failed = Object.values(C.results).filter((r) => r === 'failed').length;
  const skipped = C.items.length - sent.length - failed;
  const html = `
    <p class="done-big">${
      people ? `Messaged ${plural(people, 'person', 'people')} by ${h(CHANNELS[C.channel].label.toLowerCase())}.` : 'Nothing was sent.'
    }</p>
    ${failed ? `<p>${plural(failed, 'email')} failed.</p>` : ''}
    ${skipped > 0 ? `<p class="muted">${plural(skipped, C.mode === 'group' ? 'message' : 'person', C.mode === 'group' ? 'messages' : 'people')} skipped.</p>` : ''}`;
  return ['Done', html, `<button type="button" class="btn primary" data-action="compose-close">Done</button>`];
}

// ---- actions

function insertTag(label) {
  const el = $(C.focus === 'subject' ? '#c-subject' : '#c-body') ?? $('#c-body');
  const tag = `{{${label}}}`;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  el.setRangeText(tag, start, end, 'end');
  C[el.dataset.c] = el.value;
  const pos = el.selectionEnd;
  renderComposer();
  const again = $(el.id === 'c-subject' ? '#c-subject' : '#c-body');
  again?.focus();
  again?.setSelectionRange(pos, pos);
}

function startSend() {
  C.items = buildItems();
  C.results = {};
  C.errors = {};
  C.queueIndex = 0;
  C.step = 'send';
  if (C.channel === 'email') return runEmail();
  renderComposer();
}

async function runEmail() {
  C.sending = true;
  C.stopping = false;
  C.needsGmail = false;
  renderComposer();
  const acct = sender();
  for (let i = 0; i < C.items.length; i++) {
    if (!C || C.stopping) break;
    if (C.results[i] === 'sent') continue;
    const it = C.items[i];
    C.results[i] = 'sending';
    renderComposer();
    try {
      await api('/messages/email', {
        method: 'POST',
        body: {
          accountId: acct.id,
          mode: C.mode,
          groupTo: C.groupTo,
          recipients: it.people.map((p) => ({ contactId: p.id, email: addressFor(p), name: p.displayName || '' })),
          subject: it.subject,
          body: it.body,
        },
      });
      C.results[i] = 'sent';
    } catch (e) {
      C.results[i] = 'failed';
      C.errors[i] = e.message;
      if (e.code === 'gmail_scope') {
        acct.canEmail = false;
        C.needsGmail = true;
        break;
      }
      if (e.code === 'rate_limited' || e.code === 'signed_out' || e.status >= 500) break;
    }
  }
  if (!C) return;
  C.sending = false;
  C.stopping = false;
  const allDone = C.items.every((_, i) => C.results[i] === 'sent');
  if (allDone) C.step = 'done';
  renderComposer();
}

function queueMark(sent) {
  C.results[C.queueIndex] = sent ? 'sent' : 'skipped';
  C.queueIndex += 1;
  C.step = C.queueIndex >= C.items.length ? 'done' : 'send';
  renderComposer();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Composer clicks. Returns true if handled. */
async function composerClick(t) {
  if (!C && t.dataset.action !== 'compose') return false;
  if (t.dataset.seg) {
    const name = t.dataset.seg;
    C[name] = t.dataset.value;
    if (name === 'channel' && !CHANNELS[C.channel].group) C.mode = 'individual';
    C.previewIndex = 0;
    renderComposer();
    return true;
  }
  switch (t.dataset.action) {
    case 'compose-close':
      closeComposer();
      return true;
    case 'preview-next':
    case 'preview-prev': {
      const n = Math.max(1, reachable().length);
      C.previewIndex = (C.previewIndex + (t.dataset.action === 'preview-next' ? 1 : -1) + n) % n;
      updateComposeLive();
      return true;
    }
    case 'compose-review':
      if (!canReview()) return true;
      C.step = 'review';
      renderComposer();
      return true;
    case 'compose-back':
      C.step = 'compose';
      renderComposer();
      return true;
    case 'rv-all':
      C.skipped = [];
      renderComposer();
      return true;
    case 'rv-none':
      C.skipped = reachable().map((p) => p.id);
      renderComposer();
      return true;
    case 'connect-gmail':
      saveDraft();
      location.href = `/api/auth/google/start?purpose=gmail&account=${encodeURIComponent(C.accountId)}`;
      return true;
    case 'start-send':
      startSend();
      return true;
    case 'stop-send':
      C.stopping = true;
      renderComposer();
      return true;
    case 'retry-send':
      for (const [i, r] of Object.entries(C.results)) if (r === 'failed') delete C.results[i];
      runEmail();
      return true;
    case 'finish-send':
      C.step = 'done';
      renderComposer();
      return true;
    case 'q-copy':
      toast((await copyText(C.items[C.queueIndex].body)) ? 'Message copied.' : 'Couldn’t copy. Select the text and copy it.', 2500);
      return true;
    case 'q-signal': {
      const ok = await copyText(C.items[C.queueIndex].body);
      window.open(t.dataset.href, '_blank', 'noopener');
      toast(ok ? 'Message copied. Paste it into Signal.' : 'Couldn’t copy the message. Copy it from here.', 4000);
      return true;
    }
    case 'q-opened':
      return false; // let the link open
    case 'q-sent':
      await queueMark(true);
      return true;
    case 'q-skip':
      await queueMark(false);
      return true;
  }
  return false;
}

// ---------------------------------------------------------------- events

/** Clicks in the table. Returns true if handled. */
function gridClick(e) {
  const t = e.target;
  if (t.closest('[data-resize]')) return true;
  const remove = t.closest('[data-remove-col]');
  if (remove) {
    hideColumn(remove.dataset.removeCol);
    return true;
  }
  const sortBtn = t.closest('[data-sort]');
  if (sortBtn && suppressHeaderClick) return true;
  if (sortBtn) {
    const id = sortBtn.dataset.sort;
    S.sort = S.sort.id === id ? { id, dir: S.sort.dir === 'asc' ? 'desc' : 'asc' } : { id, dir: 'asc' };
    renderGrid();
    savePrefs();
    $(`[data-sort="${CSS.escape(id)}"]`)?.focus();
    return true;
  }
  if (t.id === 'check-all') {
    for (const c of visibleContacts()) {
      if (t.checked) S.selected.add(c.id);
      else S.selected.delete(c.id);
    }
    syncChecks();
    return true;
  }
  const cb = t.closest('input[data-check]');
  if (cb) {
    const ids = cb.dataset.check.split(' ');
    if (e.shiftKey && S.anchorId) {
      selectRange(ids[0]);
      for (const id of ids) S.selected.add(id);
    } else {
      for (const id of ids) {
        if (cb.checked) S.selected.add(id);
        else S.selected.delete(id);
      }
      S.anchorId = ids[0];
    }
    syncChecks();
    return true;
  }
  if (t.closest('a')) return true; // email, phone and link cells open normally
  if (t.closest('.cell-editor')) return true;
  const tr = t.closest('tbody tr[data-id]');
  if (!tr) return false;
  const id = tr.dataset.id;
  const listsCell = t.closest('td[data-lists]');
  if (listsCell && !inArchive() && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
    openListPicker(listsCell, [id]);
    return true;
  }
  const editable = t.closest('td[data-edit]');
  if (editable && fieldById(editable.dataset.edit)?.type === 'checkbox' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
    // A checkbox column toggles in place.
    const row = S.contacts.find((c) => c.id === id);
    if (!row) return true;
    const fieldId = editable.dataset.edit;
    const original = row.fields?.[fieldId] ?? '';
    const value = original === '1' ? '' : '1';
    row.fields = { ...(row.fields || {}) };
    if (value) row.fields[fieldId] = value;
    else delete row.fields[fieldId];
    renderGrid();
    saveCellValue({ id, fieldId, value, original }, row);
    return true;
  }
  if (editable && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
    startCellEdit(id, editable.dataset.edit);
    return true;
  }
  if (e.shiftKey) {
    selectRange(id);
    syncChecks();
    return true;
  }
  if (e.metaKey || e.ctrlKey) {
    // On the shared name of people shown together, Cmd-click ticks all of them.
    const ids = t.closest('td[data-ids]')?.dataset.ids.split(' ') ?? [id];
    const on = !ids.every((x) => S.selected.has(x));
    for (const x of ids) on ? S.selected.add(x) : S.selected.delete(x);
    S.anchorId = id;
    syncChecks();
    return true;
  }
  // Only the name opens the contact, so the rest of the row is free for editing your fields.
  if (!t.closest('[data-open]')) return true;
  S.anchorId = id;
  select(id);
  return true;
}

// ---------------------------------------------------------------- editing your fields in the table
// Click a cell in one of your own columns to edit it. Enter saves and moves down, Tab moves
// across, Esc cancels. Saved straight away; these fields never go to Google.

let cellEdit = null; // { id, fieldId, value, original }

function fieldById(fieldId) {
  return S.session.fields.find((f) => f.id === fieldId);
}

function startCellEdit(id, fieldId) {
  if (cellEdit && (cellEdit.id !== id || cellEdit.fieldId !== fieldId)) commitCellEdit();
  if (cellEdit) return;
  const row = S.contacts.find((c) => c.id === id);
  if (!row || !fieldById(fieldId)) return;
  const value = row.fields?.[fieldId] ?? '';
  cellEdit = { id, fieldId, value, original: value, fresh: true };
  remountCellEdit();
}

function cellFor(id, fieldId) {
  return document.querySelector(`#grid tr[data-id="${CSS.escape(id)}"] td[data-edit="${CSS.escape(fieldId)}"]`);
}

function remountCellEdit() {
  const ce = cellEdit;
  const td = ce && cellFor(ce.id, ce.fieldId);
  if (!td) return; // scrolled out by a filter or search: the edit stays pending until it’s committed
  const f = fieldById(ce.fieldId);
  const el = document.createElement(f.type === 'longtext' ? 'textarea' : 'input');
  el.className = 'cell-editor';
  el.setAttribute('aria-label', f.label);
  if (f.type === 'date') el.type = 'date';
  else if (f.type !== 'longtext') el.type = 'text';
  if (f.type === 'longtext') el.rows = 4;
  if (f.type === 'url') el.placeholder = 'https://';
  el.value = ce.value;
  td.classList.add('editing');
  td.removeAttribute('title');
  td.replaceChildren(el);
  el.addEventListener('input', () => (ce.value = el.value));
  el.addEventListener('keydown', cellKeydown);
  el.addEventListener('blur', () => {
    // A blur caused by re-rendering the table isn’t the end of the edit.
    setTimeout(() => {
      if (cellEdit === ce && !document.activeElement?.classList.contains('cell-editor')) commitCellEdit();
    }, 0);
  });
  el.focus({ preventScroll: false });
  if (ce.fresh && el.select && f.type !== 'date') el.select();
  ce.fresh = false;
}

function cellKeydown(e) {
  const ce = cellEdit;
  if (!ce) return;
  const long = fieldById(ce.fieldId)?.type === 'longtext';
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    return cancelCellEdit();
  }
  if (e.key === 'Enter' && !(long && (e.shiftKey || e.altKey))) {
    if (e.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    return commitCellEdit(e.shiftKey ? 'up' : 'down');
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    e.stopPropagation();
    return commitCellEdit(e.shiftKey ? 'left' : 'right');
  }
}

function cancelCellEdit() {
  const ce = cellEdit;
  cellEdit = null;
  renderGrid();
  cellFor(ce.id, ce.fieldId)?.focus?.();
}

function commitCellEdit(move) {
  const ce = cellEdit;
  if (!ce) return;
  cellEdit = null;
  const row = S.contacts.find((c) => c.id === ce.id);
  const changed = row && ce.value !== ce.original;
  if (changed) {
    row.fields = { ...(row.fields || {}) };
    if (ce.value.trim()) row.fields[ce.fieldId] = ce.value;
    else delete row.fields[ce.fieldId];
    saveCellValue(ce, row);
  }
  // Work out where Enter or Tab goes before re-rendering (the row may re-sort).
  const next = move && neighbourCell(ce, move);
  renderGrid();
  if (next) startCellEdit(next.id, next.fieldId);
}

/** The editable cell next to this one: down/up in the same column, left/right along the row. */
function neighbourCell(ce, move) {
  const rows = [...document.querySelectorAll('#grid tbody tr[data-id]')].map((tr) => tr.dataset.id);
  const cols = [...document.querySelectorAll('#grid thead th[data-col^="f:"]')].map((th) => th.dataset.col.slice(2));
  let r = rows.indexOf(ce.id);
  let c = cols.indexOf(ce.fieldId);
  if (r < 0 || c < 0) return null;
  if (move === 'down') r += 1;
  else if (move === 'up') r -= 1;
  else if (move === 'right') {
    c += 1;
    if (c >= cols.length) [c, r] = [0, r + 1];
  } else if (move === 'left') {
    c -= 1;
    if (c < 0) [c, r] = [cols.length - 1, r - 1];
  }
  if (r < 0 || r >= rows.length) return null;
  return { id: rows[r], fieldId: cols[c] };
}

async function saveCellValue(ce, row) {
  try {
    const d = await api(`/contacts/${encodeURIComponent(ce.id)}/fields`, { method: 'PUT', body: { values: { [ce.fieldId]: ce.value } } });
    row.fields = d.fields;
    if (d.search) row.search = d.search;
    if (d.etag) row.etag = d.etag;
    if (S.detail?.id === ce.id) {
      S.detail = { ...S.detail, fields: d.fields, linked: d.linked, etag: d.etag, card: d.card };
      // Refresh the open panel unless you’re typing in it.
      if (S.mode === 'view' && !document.activeElement?.closest?.('#detail')) renderDetail();
    }
    if (d.linkError) toast(`Saved. Couldn’t link to Google yet: ${d.linkError}`);
    if (fieldById(ce.fieldId)?.key === 'neighborhood') {
      mapView?.invalidate();
      S.places = null;
    }
    if (!cellEdit) renderGrid();
  } catch (e) {
    // Put the old value back so the table shows what’s actually stored.
    row.fields = { ...(row.fields || {}) };
    if (ce.original) row.fields[ce.fieldId] = ce.original;
    else delete row.fields[ce.fieldId];
    renderGrid();
    handleError(e);
  }
}

/** Clicks in the Columns dialog. Returns true if handled. */
function columnsClick(e) {
  const move = e.target.closest('[data-col-move]');
  if (move) {
    const i = S.cols.findIndex((c) => c.id === move.dataset.id);
    const j = i + Number(move.dataset.colMove);
    if (i > 0 && j > 0 && j < S.cols.length) {
      [S.cols[i], S.cols[j]] = [S.cols[j], S.cols[i]];
      columnsChanged(`[data-col-move="${move.dataset.colMove}"][data-id="${CSS.escape(move.dataset.id)}"]`);
    }
    return true;
  }
  if (e.target.closest('[data-action="cols-reset"]')) {
    S.cols = defaultColumns();
    S.sort = { id: 'name', dir: 'asc' };
    columnsChanged();
    return true;
  }
  return false;
}

document.addEventListener('click', async (e) => {
  if (e.target.closest('#photo-dlg')) return $('#photo-dlg').close(); // a click anywhere closes it
  const copy = e.target.closest('[data-copy]');
  const pick = e.target.closest('.pick-menu');
  if (pick && (copy || e.target.closest('a'))) setTimeout(() => pick.hidePopover(), copy ? 400 : 0);
  if (copy) return copyClick(copy);
  if (e.target.closest('#hero-map')) return openPlaceMap();
  const lp = e.target.closest('[data-lp-group]');
  if (lp) return togglePickerList(lp.dataset.lpAccount, lp.dataset.lpGroup);
  const ns = e.target.closest('[data-name-sort]');
  if (ns) return setNameSort(ns.dataset.nameSort);
  if (e.target.closest('#compose-dlg')) {
    const t = e.target.closest('[data-action], [data-seg]');
    if (t && (await composerClick(t))) e.preventDefault();
    return;
  }
  if (e.target.closest('#columns-dlg') && columnsClick(e)) return;
  if (e.target.closest('#rel-dlg')) return RD && relDialogClick(e);
  const sw = e.target.closest('[data-switch]');
  if (sw) return select(sw.dataset.switch);
  const relEdit = e.target.closest('[data-rel-edit]');
  if (relEdit) return openRelDialog(relEdit.dataset.relEdit);
  if (e.target.closest('#grid') && gridClick(e)) return;

  const lay = e.target.closest('[data-layout]');
  if (lay) return setLayout(lay.dataset.layout);
  const t = e.target.closest('[data-action], [data-filter], [data-theme-set]');
  if (!t) return;

  if (t.dataset.action === 'enlarge-photo') return enlargePhoto();
  if (t.dataset.themeSet) {
    setTheme(t.dataset.themeSet);
    return $('.theme-btn')?.focus();
  }

  if (t.dataset.filter) {
    const type = t.dataset.filter;
    S.filter = type === 'all' || type === 'archive' ? { type } : type === 'account' ? { type, id: t.dataset.id } : { type, id: t.dataset.id, accountId: t.dataset.account };
    clearSelection();
    renderSidebar();
    renderGrid();
    setView('main');
    $('#grid-wrap').scrollTop = 0;
    return;
  }

  switch (t.dataset.action) {
    case 'sync':
      return sync();
    case 'add-rel':
      return openRelDialog();
    case 'shortcuts':
      return openShortcuts();
    case 'font':
      return openFontPicker();
    case 'save-draft':
      if (!draft) return;
      draft.asDraft = true;
      return saveEditor();
    case 'promote-contact':
      return promoteDraft();
    case 'make-draft':
      return makeDraft();
    case 'add-to-list':
      return openAddToList();
    case 'signal-name':
      return signalByName();
    case 'compose':
      return openComposer();
    case 'columns':
      renderColumnsDialog();
      $('#columns-dlg').showModal();
      return;
    case 'clear-select':
      return clearSelection();
    case 'close-detail':
      return closeDrawer();
    case 'close-place':
      return $('#place-dlg')?.close();
    case 'demo-on':
    case 'demo-off':
      setDemo(t.dataset.action === 'demo-on');
      location.href = '/';
      return;
    case 'logout':
      await api('/auth/logout', { method: 'POST' }).catch(() => {});
      location.href = '/';
      return;
    case 'fields':
      renderFieldsDialog();
      $('#fields-dlg').showModal();
      return;
    case 'add-field': {
      const label = $('#new-field-label').value.trim();
      if (!label) return $('#new-field-label').focus();
      try {
        const [accountId, listId] = ($('#new-field-list').value || '|').split('|');
        const f = await api('/fields', {
          method: 'POST',
          body: { label, type: $('#new-field-type').value, list: listId ? { accountId, listId } : null },
        });
        // A list’s field starts out as a column in that list’s table.
        if (listId) {
          const key = viewKey({ type: 'group', id: listId, accountId });
          const saved = S.session.user.prefs?.views?.[key];
          if (key === S.prefsView) {
            S.cols.push({ id: `f:${f.id}` });
            savePrefs();
          } else if (saved?.columns) {
            saved.columns.push({ id: `f:${f.id}` });
            api('/prefs', { method: 'PATCH', body: { set: { views: S.session.user.prefs.views } } }).catch(handleError);
          }
        }
        await fieldsChanged();
        renderGrid();
        $('#new-field-label')?.focus();
      } catch (err) {
        handleError(err);
      }
      return;
    }
    case 'clear-past': {
      const f = fieldById(t.dataset.id);
      if (!S.detail || !f || !window.confirm(`Remove ${S.detail.card.givenName || 'their'}${S.detail.card.givenName ? '’s' : ''} “${f.label}”?`)) return;
      pending.set(t.dataset.id, '');
      await flushFieldSaves();
      return renderDetail();
    }
    case 'delete-field': {
      const f = S.session.fields.find((x) => x.id === t.dataset.id);
      if (!f || !window.confirm(`Delete “${f.label}” and its value on every contact?`)) return;
      try {
        await api(`/fields/${encodeURIComponent(f.id)}`, { method: 'DELETE' });
        await fieldsChanged();
      } catch (err) {
        handleError(err);
      }
      return;
    }
    case 'edit':
      return startEdit(false);
    case 'new':
      if (!(await confirmDiscard())) return;
      return startEdit(true);
    case 'cancel-edit':
      draft = null;
      S.mode = 'view';
      if (!S.detail || S.detail.id !== S.selectedId) setDrawer(false);
      return renderDetail();
    case 'add-row':
      draft[t.dataset.multi].push(t.dataset.multi === 'addresses' ? blankAddress(t.dataset.label) : { label: t.dataset.label, value: '' });
      renderDetail();
      document
        .querySelector(`[data-multi="${t.dataset.multi}"][data-i="${draft[t.dataset.multi].length - 1}"][data-part="${t.dataset.multi === 'addresses' ? 'street' : 'value'}"]`)
        ?.focus();
      return;
    case 'lists-selected':
      return openListPicker(t, [...S.selected]);
    case 'lists-contact':
      return S.detail && openListPicker(t, [S.detail.id]);
    case 'new-list':
      return startListName('create');
    case 'list-menu':
      return openListMenu(t);
    case 'list-pin':
      return togglePin(LM);
    case 'list-rename':
      return startListName('rename', LM);
    case 'list-style':
      return editListStyle(LM);
    case 'list-delete':
      return deleteList(LM);
    case 'list-nest':
      $('#list-menu')?.hidePopover();
      return LM && nestList(LM, t.dataset.parent);
    case 'list-unnest':
      $('#list-menu')?.hidePopover();
      return LM && nestList(LM, null);
    case 'list-toggle':
      return toggleCollapsed(t.dataset.account, t.dataset.id);
    case 'lp-new':
      return showPickerNewList();
    case 'archive-selected':
      return archiveAction('archive', [...S.selected]);
    case 'restore-selected':
      return archiveAction('restore', [...S.selected]);
    case 'forget-selected':
      return archiveAction('forget', [...S.selected]);
    case 'archive-contact':
      return S.detail && archiveAction('archive', [S.detail.id], { [S.detail.id]: S.detail.etag });
    case 'restore-contact':
      return S.detail && archiveAction('restore', [S.detail.id]);
    case 'forget-contact':
      return S.detail && archiveAction('forget', [S.detail.id]);
    case 'delete-selected':
      return deleteContacts(sortContacts(S.contacts.filter((c) => S.selected.has(c.id))).map((c) => c.id));
    case 'delete-contact': {
      if (!S.detail) return;
      const { id, etag } = S.detail;
      return deleteContacts([id], { [id]: etag });
    }
    case 'photo-choose':
      return $('#photo-file')?.click();
    case 'photo-crop':
      return recropPhoto();
    case 'photo-remove':
      draft.photo = { action: 'remove' };
      return renderDetail();
    case 'photo-undo':
      draft.photo = null;
      return renderDetail();
    case 'remove-row':
      draft[t.dataset.multi].splice(Number(t.dataset.i), 1);
      return renderDetail();
    case 'toggle-sidebar':
      return toggleSidebar();
    case 'hide-sidebar':
      return setView('main');
  }
});

// Drag the sidebar’s edge to resize it; double-click to reset.
document.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest?.('#sidebar-resize');
  if (!handle || e.button !== 0) return;
  e.preventDefault();
  const app = $('.app');
  const startX = e.clientX;
  const startW = $('#sidebar').getBoundingClientRect().width;
  handle.setPointerCapture(e.pointerId);
  app.classList.add('resizing-sidebar');
  document.body.classList.add('resizing-sidebar');
  const move = (ev) => setSidebarWidth(startW + ev.clientX - startX, false);
  const up = (ev) => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', up);
    app.classList.remove('resizing-sidebar');
    document.body.classList.remove('resizing-sidebar');
    setSidebarWidth(startW + ev.clientX - startX, true);
    mapView?.map?.resize();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
});

document.addEventListener('dblclick', (e) => {
  if (e.target.closest?.('#sidebar-resize')) {
    setSidebarWidth(SIDEBAR_W.default, true);
    return mapView?.map?.resize();
  }
  const handle = e.target.closest('[data-resize]');
  if (!handle) return;
  const entry = S.cols.find((c) => c.id === handle.dataset.resize);
  if (!entry) return;
  delete entry.w;
  applyWidths();
  savePrefs();
});

// Drag a header’s edge to resize the column.
document.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('[data-resize]');
  if (!handle || e.button !== 0) return;
  e.preventDefault();
  const id = handle.dataset.resize;
  const entry = S.cols.find((c) => c.id === id);
  const current = activeColumns().find((c) => c.id === id);
  if (!entry || !current) return;
  const startX = e.clientX;
  const startW = current.w;
  handle.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing');
  const move = (ev) => {
    entry.w = Math.max(COL_MIN, Math.round(startW + ev.clientX - startX));
    applyWidths();
  };
  const up = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', up);
    document.body.classList.remove('resizing');
    if (entry.w !== startW) savePrefs();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
});

// Drop an image on the photo in the editor.
document.addEventListener('dragover', (e) => {
  if (e.target.closest?.('#photo-drop') && e.dataTransfer?.types.includes('Files')) {
    e.preventDefault();
    e.target.closest('#photo-drop').classList.add('drop');
  }
});
document.addEventListener('dragleave', (e) => {
  e.target.closest?.('#photo-drop')?.classList.remove('drop');
});
document.addEventListener('drop', (e) => {
  const zone = e.target.closest?.('#photo-drop');
  if (!zone || !e.dataTransfer?.files?.length) return;
  e.preventDefault();
  zone.classList.remove('drop');
  stagePhoto(e.dataTransfer.files[0]);
});

// Drag people from the table onto a list in the sidebar to add them to it. Dragging someone
// who’s ticked brings everyone ticked.
let dragPeople = null; // contact ids
document.addEventListener('dragstart', (e) => {
  const btn = e.target.closest?.('#grid .cell-open[draggable="true"]');
  if (!btn) return;
  const ids = btn.closest('td').dataset.ids.split(' ').filter(Boolean);
  dragPeople = ids.some((id) => S.selected.has(id)) ? [...new Set([...S.selected, ...ids])] : ids;
  e.dataTransfer.effectAllowed = 'copy';
  e.dataTransfer.setData('text/plain', dragPeople.map((id) => contactById(id)?.displayName || '').join(', '));
  const chip = document.createElement('div');
  chip.className = 'drag-chip';
  chip.textContent = dragPeople.length === 1 ? contactById(dragPeople[0])?.displayName || 'No name' : `${dragPeople.length} people`;
  document.body.append(chip);
  e.dataTransfer.setDragImage(chip, 12, 14);
  setTimeout(() => chip.remove(), 0);
  document.body.classList.add('dragging-people');
});
const peopleTarget = (e) => (dragPeople ? e.target.closest?.('nav[aria-label="Lists"] .nav-item[data-filter="group"]') : null);
document.addEventListener('dragover', (e) => {
  const item = peopleTarget(e);
  document.querySelectorAll('.nav-item.people-drop').forEach((x) => x !== item && x.classList.remove('people-drop'));
  if (!item || item.dataset.id === 'contactGroups/myContacts') return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  item.classList.add('people-drop');
});
document.addEventListener('drop', (e) => {
  const item = peopleTarget(e);
  if (!item) return;
  e.preventDefault();
  item.classList.remove('people-drop');
  const accountId = item.dataset.account;
  const groupId = item.dataset.id;
  const name = accountById(accountId)?.groups.find((g) => g.id === groupId)?.name ?? 'the list';
  const people = dragPeople.map(contactById).filter((c) => c && c.accountId === accountId);
  const add = people.filter((c) => !c.groups.includes(groupId)).map((c) => c.id);
  if (!add.length) return toast(people.length ? `${people.length === 1 ? 'Already' : 'All already'} in ${name}.` : 'They’re in a different account.', 2500);
  changeMembers({ action: 'members', accountId, groupId, add }, false);
});
document.addEventListener('dragend', () => {
  if (!dragPeople) return;
  dragPeople = null;
  document.body.classList.remove('dragging-people');
  document.querySelectorAll('.nav-item.people-drop').forEach((x) => x.classList.remove('people-drop'));
});

// Drag to reorder in the Columns dialog.
document.addEventListener('dragstart', (e) => {
  const li = e.target.closest?.('#col-shown [data-col-item][draggable="true"]');
  if (!li) return;
  dragCol = li;
  li.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', li.dataset.colItem);
});
document.addEventListener('dragover', (e) => {
  if (!dragCol) return;
  const over = e.target.closest?.('#col-shown [data-col-item]');
  if (!over) return;
  e.preventDefault();
  if (over === dragCol || over.dataset.colItem === 'name') return;
  const r = over.getBoundingClientRect();
  over.parentNode.insertBefore(dragCol, e.clientY > r.top + r.height / 2 ? over.nextSibling : over);
});
document.addEventListener('drop', (e) => {
  if (dragCol) e.preventDefault();
});
document.addEventListener('dragend', () => {
  if (!dragCol) return;
  dragCol.classList.remove('dragging');
  dragCol = null;
  const order = [...document.querySelectorAll('#col-shown [data-col-item]')].map((li) => li.dataset.colItem);
  const byId = new Map(S.cols.map((c) => [c.id, c]));
  S.cols = order.map((id) => byId.get(id)).filter(Boolean);
  columnsChanged();
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (C && t.dataset.c) {
    C[t.dataset.c] = t.value;
    clearTimeout(composeTimer);
    composeTimer = setTimeout(updateComposeLive, 150);
    return;
  }
  if (t.classList.contains('own-input')) {
    if (t.tagName === 'TEXTAREA') autosize(t);
    if (t.type === 'checkbox') {
      queueFieldSave(t, true);
      setTimeout(renderDetailSoon, 300); // the Signal button follows the checkbox
    } else if (t.type !== 'date') queueFieldSave(t, false);
    return;
  }
  if (!draft) return;
  if (t.dataset.multi === 'phones' && t.dataset.part === 'value') formatPhoneInput(t, e);
  if (t.dataset.draft) draft[t.dataset.draft] = t.value;
  if (t.dataset.multi) draft[t.dataset.multi][Number(t.dataset.i)][t.dataset.part] = t.value;
});

let composeTimer;

// Phone fields format US numbers as you type. The value before each edit is kept so
// deleting a “(”, “)”, space or hyphen deletes the digit next to it instead.
document.addEventListener('beforeinput', (e) => {
  const t = e.target;
  if (t.dataset?.multi === 'phones' && t.dataset.part === 'value') t.dataset.before = t.value;
});

function formatPhoneInput(t, e) {
  const raw = t.value;
  if (!/^[\d\s()-]*$/.test(raw)) return; // +, dots, letters: typed their own way, leave it
  const pos = t.selectionStart ?? raw.length;
  let digits = raw.replace(/\D/g, '');
  let before = raw.slice(0, pos).replace(/\D/g, '').length;
  const prev = (t.dataset.before ?? '').replace(/\D/g, '');
  if (digits === prev && /^delete/.test(e.inputType || '')) {
    // Only a separator went; take the digit beside it.
    if (e.inputType === 'deleteContentBackward' && before > 0) {
      digits = digits.slice(0, before - 1) + digits.slice(before);
      before -= 1;
    } else if (e.inputType === 'deleteContentForward') {
      digits = digits.slice(0, before) + digits.slice(before + 1);
    }
  }
  const out = formatPhoneTyping(digits);
  if (out === null || out === raw) return;
  t.value = out;
  // Put the cursor back after the same number of digits.
  let caret = 0;
  for (let seen = 0; caret < out.length && seen < before; caret++) if (/\d/.test(out[caret])) seen++;
  t.setSelectionRange(caret, caret);
}

document.addEventListener('focusin', (e) => {
  if (C && e.target.dataset?.c) C.focus = e.target.dataset.c;
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.matches('[data-hero-pick]') && S.detail) {
    S.heroPlace = { id: S.detail.id, key: t.value };
    return drawHeroMap(S.detail);
  }
  if (t.matches('[data-place-pick]') && S.detail) {
    // The full map moves to that address, and the header’s map follows.
    S.heroPlace = { id: S.detail.id, key: t.value };
    const places = await contactPlaces(S.detail.id);
    const place = renderPlaceCard(places, S.detail);
    PM?.show(place.point);
    return drawHeroMap(S.detail);
  }
  if (C && t.closest('#compose-dlg')) {
    if (t.id === 'c-tag' && t.value) return insertTag(t.value);
    if (t.dataset.rv) {
      C.skipped = t.checked ? C.skipped.filter((id) => id !== t.dataset.rv) : [...C.skipped, t.dataset.rv];
    } else if (t.dataset.pick) {
      C.picks[`${needs()}:${t.dataset.pick}`] = t.value;
    } else if (t.id === 'c-from') {
      C.accountId = t.value;
    } else {
      return;
    }
    const scroll = $('.cmp-body')?.scrollTop;
    renderComposer();
    if (scroll != null) $('.cmp-body').scrollTop = scroll;
    return;
  }
  if (t.id === 'photo-file' && t.files?.[0]) return stagePhoto(t.files[0]);
  if (t.dataset.colToggle) {
    const id = t.dataset.colToggle;
    if (t.checked && !S.cols.some((c) => c.id === id)) S.cols.push({ id });
    if (!t.checked) S.cols = S.cols.filter((c) => c.id !== id);
    return columnsChanged(`[data-col-toggle="${CSS.escape(id)}"]`);
  }
  if (t.classList.contains('own-input')) {
    queueFieldSave(t, true);
    if (fieldById(t.dataset.field)?.key === 'signal_username') setTimeout(renderDetailSoon, 300);
    return;
  }
  if (t.dataset.draft === 'accountId') draft.accountId = t.value;
  if (t.dataset.fieldLabel) {
    try {
      await api(`/fields/${encodeURIComponent(t.dataset.fieldLabel)}`, { method: 'PATCH', body: { label: t.value } });
      await fieldsChanged();
    } catch (err) {
      handleError(err);
    }
  }
  if (t.dataset.fieldType) {
    try {
      await api(`/fields/${encodeURIComponent(t.dataset.fieldType)}`, { method: 'PATCH', body: { type: t.value } });
      await fieldsChanged();
    } catch (err) {
      handleError(err);
    }
  }
  if (t.matches?.('[data-drafts-toggle]')) {
    S.hideDrafts = !t.checked;
    savePrefs();
    clearSelection();
    renderGrid();
    return;
  }
  if (t.matches?.('[data-sub-toggle]')) {
    S.withSub = t.checked;
    savePrefs();
    clearSelection();
    renderGrid();
    return;
  }
  if (t.dataset.fieldList) {
    try {
      const [accountId, listId] = (t.value || '|').split('|');
      await api(`/fields/${encodeURIComponent(t.dataset.fieldList)}`, { method: 'PATCH', body: { list: listId ? { accountId, listId } : null } });
      await fieldsChanged();
      renderGrid();
    } catch (err) {
      handleError(err);
    }
  }
});

document.addEventListener('focusout', (e) => {
  if (e.target.classList?.contains('own-input') && pending.size) flushFieldSaves();
});

document.addEventListener('submit', (e) => {
  if (e.target.id === 'editor') {
    e.preventDefault();
    saveEditor();
  }
  if (e.target.id === 'fields-form' && e.submitter?.dataset.action === 'add-field') e.preventDefault();
});

// ---------------------------------------------------------------- keyboard shortcuts

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? '⌘' : 'Ctrl';

/** Shown in the shortcuts dialog (press ?). The keys themselves are handled below. */
const SHORTCUTS = [
  ['Anywhere', [
    [['?'], 'Show keyboard shortcuts'],
    [['/'], 'Search'],
    [['N'], 'New contact'],
    [['A'], 'Add people to the list you’re viewing'],
    [['M'], 'Switch between table and map'],
    [['['], 'Previous list'],
    [[']'], 'Next list'],
    [['C'], 'Message the people shown, or the ones ticked'],
    [['F'], 'Your fields'],
    [IS_MAC ? ['⌃', '⌘', 'S'] : ['Ctrl', 'Alt', 'S'], 'Show or hide the sidebar'],
  ]],
  ['Table', [
    [['↑'], 'Previous contact'],
    [['↓'], 'Next contact'],
    [['K'], 'Previous contact'],
    [['J'], 'Next contact'],
    [['Return'], 'Open the highlighted contact'],
    [['X'], 'Tick or untick the highlighted contact'],
    [[MOD, 'A'], 'Tick everyone shown'],
    [['Esc'], 'Close the contact, then clear the ticks'],
  ]],
  ['Contact', [
    [['E'], 'Edit the open contact'],
    [[MOD, 'Return'], 'Save your edits'],
    [['Esc'], 'Close'],
  ]],
];

// ---------------------------------------------------------------- font

/** The fonts you can choose; the same list as on the iPhone. Files in fonts/. */
const FONTS = ['Commissioner', 'DM Sans', 'Funnel Sans', 'Geist', 'Golos Text', 'Hanken Grotesk', 'Inclusive Sans', 'Libre Franklin', 'Miranda Sans', 'Public Sans', 'Schibsted Grotesk', 'Strichpunkt Sans', 'Zalando Sans'];
const FONT_KEY = 'ligature-font';

function currentFont() {
  const f = S.session?.user?.prefs?.font;
  return FONTS.includes(f) ? f : 'Commissioner';
}

/** Use a font everywhere, and remember it here so the next visit starts in it. */
function applyFont(font) {
  document.documentElement.style.setProperty('--font', `'${font}'`);
  try {
    localStorage.setItem(FONT_KEY, font);
  } catch {
    /* per-browser convenience only */
  }
}

/** Pick a font: each shown in itself. Saved to your account, so the iPhone follows. */
function openFontPicker() {
  let dlg = $('#font-dlg');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'font-dlg';
    dlg.setAttribute('aria-labelledby', 'font-title');
    document.body.append(dlg);
    dlg.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-font]');
      if (!b) return;
      const font = b.dataset.font;
      applyFont(font);
      if (S.session?.user) S.session.user.prefs = { ...(S.session.user.prefs ?? {}), font };
      for (const x of dlg.querySelectorAll('[data-font]')) {
        x.setAttribute('aria-checked', String(x === b));
        x.querySelector('.menu-check').innerHTML = x === b ? ICON.check : '';
      }
      try {
        await api('/prefs', { method: 'PATCH', body: { set: { font } } });
      } catch (err) {
        handleError(err);
      }
    });
  }
  const now = currentFont();
  dlg.innerHTML = `<form method="dialog" class="dlg">
      <h2 id="font-title">Font</h2>
      <div class="font-list" role="radiogroup" aria-labelledby="font-title">${FONTS.map(
        (f) => `<button type="button" class="font-opt" role="radio" data-font="${h(f)}" aria-checked="${f === now}">
            <span class="font-name">${h(f)}</span><span class="font-sample">Ava Chen · (503) 555-0117</span><span class="menu-check">${f === now ? ICON.check : ''}</span>
          </button>`,
      ).join('')}</div>
      <div class="dlg-foot"><button class="btn primary" value="close">Done</button></div>
    </form>`;
  // Set from here: the security policy doesn’t allow style attributes in the markup.
  for (const b of dlg.querySelectorAll('[data-font]')) b.style.fontFamily = `'${b.dataset.font}'`;
  dlg.showModal();
}

function openShortcuts() {
  const dlg = $('#keys-dlg');
  dlg.innerHTML = `<form method="dialog" class="dlg">
      <h2 id="keys-title">Keyboard Shortcuts</h2>
      ${SHORTCUTS.map(
        ([group, rows]) => `<section class="keys-group"><h3>${h(group)}</h3><dl>${rows
          .map(([keys, label]) => `<dt>${keys.map((k) => `<kbd>${h(k)}</kbd>`).join('')}</dt><dd>${h(label)}</dd>`)
          .join('')}</dl></section>`,
      ).join('')}
      <div class="dlg-foot"><button class="btn primary" value="close">Done</button></div>
    </form>`;
  dlg.showModal();
}

/** The list you’re viewing, if people can be added to it. */
function currentList() {
  const f = S.filter;
  if (f.type !== 'group' || f.id === 'contactGroups/myContacts') return null;
  const g = accountById(f.accountId)?.groups.find((x) => x.id === f.id);
  return g ? { accountId: f.accountId, group: g } : null;
}

function stepList(step) {
  const items = [...document.querySelectorAll('.sidebar .nav-item[data-filter]')];
  if (!items.length) return;
  const i = items.findIndex((b) => b.getAttribute('aria-current') === 'true');
  items[(i + step + items.length) % items.length].click();
}

// ---- add people to the list you’re viewing: search everyone, Return adds the best match

let AD = null; // { accountId, groupId, name, query, hi, added: [] , busy }

/** How well a contact matches what you typed: their name first, then anything else about them. */
function matchScore(c, q) {
  const name = (c.displayName || '').toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const nameWords = name.split(/[\s\-.,]+/).filter(Boolean);
  if (name === q) return 100;
  if (name.startsWith(q)) return 90;
  if (nameWords.some((w) => w.startsWith(q))) return 80;
  if (words.every((w) => nameWords.some((n) => n.startsWith(w)))) return 70;
  if (name.includes(q)) return 60;
  if (words.every((w) => c.search.includes(w))) return 40;
  return 0;
}

function addMatches() {
  const q = AD.query.trim().toLowerCase();
  if (!q) return [];
  return S.contacts
    .filter((c) => c.accountId === AD.accountId)
    .map((c) => ({ c, score: matchScore(c, q), member: c.groups.includes(AD.groupId) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || collator.compare(nameKey(a.c), nameKey(b.c)))
    .slice(0, 8);
}

function openAddToList() {
  const l = currentList();
  if (!l) return toast('Open a list first.');
  AD = { accountId: l.accountId, groupId: l.group.id, name: l.group.name, query: '', hi: 0, added: [] };
  const dlg = $('#add-dlg');
  dlg.innerHTML = `<form class="dlg add-form" id="add-form">
      <h2 id="add-title">Add to ${h(l.group.name)}</h2>
      <input class="input" id="add-q" type="text" placeholder="Search all contacts" autocomplete="off" spellcheck="false"
        role="combobox" aria-expanded="true" aria-controls="add-results" aria-label="Search all contacts">
      <div class="add-results" id="add-results" role="listbox" aria-label="Matches"></div>
      <p class="add-note" id="add-note" role="status" aria-live="polite">Type a name, then press Return to add the highlighted person.</p>
      <div class="dlg-foot"><button type="button" class="btn primary" data-action="add-done">Done</button></div>
    </form>`;
  dlg.showModal();
  $('#add-q').focus();
  fillAddResults();
}

function fillAddResults() {
  if (!AD) return;
  const rows = addMatches();
  // The best match is highlighted, unless they’re already on the list (then arrow down to pick
  // someone else, so Return never adds a weaker match by surprise).
  const pickable = rows.map((x, i) => (x.member ? -1 : i)).filter((i) => i >= 0);
  if (!pickable.includes(AD.hi)) AD.hi = -1;
  const note = $('#add-note');
  const n = AD.added.length;
  if (rows[0]?.member && AD.hi < 0) note.textContent = `${rows[0].c.displayName || 'No name'} is already in ${AD.name}.`;
  else if (n) note.textContent = `Added ${AD.added[n - 1]}${n > 1 ? ` (${n} so far)` : ''}.`;
  else note.textContent = 'Type a name, then press Return to add the highlighted person.';
  $('#add-results').innerHTML = rows
    .map(({ c, member }, i) => {
      const av = c.photoUrl ? `<img src="${h(thumb(c.photoUrl))}" alt="" referrerpolicy="no-referrer">` : h(initials(c));
      const sub = [c.organization, c.email].filter(Boolean).join(' · ');
      return `<button type="button" role="option" class="add-row" data-add-id="${h(c.id)}" aria-selected="${i === AD.hi}"${member ? ' disabled' : ''}>
          <span class="mini-av" aria-hidden="true">${av}</span>
          <span class="add-who"><span class="cell-name">${h(c.displayName || 'No name')}</span>${sub ? `<span class="muted">${h(sub)}</span>` : ''}</span>
          ${member ? '<span class="muted add-tag">In this list</span>' : i === AD.hi ? '<kbd>Return</kbd>' : ''}
        </button>`;
    })
    .join('');
  const sel = $('#add-results [aria-selected="true"]');
  sel?.scrollIntoView({ block: 'nearest' });
}

function moveAddHighlight(step) {
  const rows = addMatches();
  const pickable = rows.map((x, i) => (x.member ? -1 : i)).filter((i) => i >= 0);
  if (!pickable.length) return;
  const at = pickable.indexOf(AD.hi);
  AD.hi = at < 0 ? pickable[0] : pickable[Math.max(0, Math.min(pickable.length - 1, at + step))];
  fillAddResults();
}

async function addHighlighted(id) {
  if (!AD || AD.busy) return;
  const c = contactById(id ?? addMatches()[AD.hi]?.c.id);
  if (!c || c.groups.includes(AD.groupId)) return;
  AD.busy = true;
  const ad = AD;
  try {
    const r = await api('/lists', { method: 'POST', body: { action: 'members', accountId: ad.accountId, groupId: ad.groupId, add: [c.id] } });
    applyListResult(ad.accountId, r);
    if (AD !== ad) return;
    ad.added.push(c.displayName || 'No name');
    ad.query = '';
    $('#add-q').value = '';
    fillAddResults();
    $('#add-q').focus();
  } catch (e) {
    handleError(e);
  } finally {
    ad.busy = false;
  }
}

document.addEventListener('input', (e) => {
  if (e.target.id !== 'add-q' || !AD) return;
  AD.query = e.target.value;
  AD.hi = 0;
  fillAddResults();
});

document.addEventListener('keydown', (e) => {
  if (e.target.id !== 'add-q' || !AD) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    moveAddHighlight(e.key === 'ArrowDown' ? 1 : -1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    addHighlighted();
  }
});

document.addEventListener('click', (e) => {
  const row = e.target.closest?.('[data-add-id]');
  if (row) return addHighlighted(row.dataset.addId);
  if (e.target.closest?.('[data-action="add-done"]')) $('#add-dlg').close();
});

/** Single-key shortcuts, when you’re not typing in a field. */
function handleShortcut(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const open = S.drawer && S.detail && S.mode === 'view';
  switch (k) {
    case '?':
      openShortcuts();
      return true;
    case '/':
      $('#q')?.focus();
      $('#q')?.select();
      return true;
    case 'n':
      $('[data-action="new"]')?.click();
      return true;
    case 'a':
      openAddToList();
      return true;
    case 'm':
      setLayout(S.layout === 'map' ? 'table' : 'map');
      return true;
    case '[':
    case ']':
      stepList(k === ']' ? 1 : -1);
      return true;
    case 'c':
      if (inArchive()) return false;
      $('[data-action="compose"]')?.click();
      return true;
    case 'f':
      $('[data-action="fields"]')?.click();
      return true;
    case 'j':
    case 'k':
      if (S.mode !== 'view') return false;
      moveSelection(k === 'j' ? 1 : -1);
      return true;
    case 'x':
      if (!S.selectedId) return false;
      toggleChecked(S.selectedId);
      syncChecks();
      return true;
    case 'e':
      if (!open || S.detail.archived) return false;
      startEdit(false);
      return true;
    default:
      return false;
  }
}

document.addEventListener('keydown', (e) => {
  // Enter in the new-field box adds it instead of closing the dialog.
  if (e.key === 'Enter' && e.target.id === 'new-field-label') {
    e.preventDefault();
    $('[data-action="add-field"]').click();
    return;
  }
  if (document.querySelector('dialog[open]')) return;
  // Ctrl-Cmd-S (as in Mac apps) or Ctrl-Alt-S shows and hides the sidebar.
  if (e.code === 'KeyS' && e.ctrlKey && (e.metaKey || e.altKey)) {
    e.preventDefault();
    return toggleSidebar();
  }
  const inField = e.target.matches?.('input:not([type="checkbox"]), textarea, select, [contenteditable="true"]');
  if (e.target.classList?.contains('cell-editor')) return; // a table cell being edited keeps its own keys

  // Escape closes the detail panel, then clears the selection.
  if (e.key === 'Escape') {
    if (document.querySelector(':popover-open')) return; // the menu closes itself
    if (S.view === 'sidebar') return setView('main');
    if (S.drawer) {
      e.preventDefault();
      return closeDrawer();
    }
    if (S.selected.size && !inField) return clearSelection();
    return;
  }
  // Cmd/Ctrl-Return saves the contact you’re editing.
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (S.mode === 'edit' || S.mode === 'new')) {
    e.preventDefault();
    return saveEditor();
  }
  if (!inField && !e.repeat && handleShortcut(e)) {
    e.preventDefault();
    return;
  }
  // Cmd/Ctrl-A in the table selects everyone shown.
  if ((e.metaKey || e.ctrlKey) && e.key === 'a' && !inField && e.target.closest?.('#grid')) {
    e.preventDefault();
    for (const c of visibleContacts()) S.selected.add(c.id);
    return syncChecks();
  }
  // Up and down move through the table; with the panel open, it follows.
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && S.mode === 'view') {
    const inGrid = e.target.closest?.('#grid') && !e.target.closest('thead');
    if (inGrid || e.target.id === 'q' || (S.drawer && !inField)) {
      e.preventDefault();
      moveSelection(e.key === 'ArrowDown' ? 1 : -1);
    }
  }
});

window.addEventListener('beforeunload', (e) => {
  if (pending.size) flushFieldSaves();
  if (draft) e.preventDefault();
});

boot();
