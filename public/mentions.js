// @-mentions: type “@” and part of a name in notes or your text fields to tag another contact.
// They’re stored as plain “@Full Name”, so notes still read naturally in Google and on iPhone,
// and turned into links to that person wherever Ligatures shows the text.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let getContacts = () => [];
let openContact = () => {};
let cache = { list: null, byFirst: new Map() };

/** Names grouped by their first word, longest first, so “@Ann Lee” wins over “@Ann”. */
function index() {
  const list = getContacts();
  if (cache.list === list) return cache.byFirst;
  const byFirst = new Map();
  for (const c of list) {
    const name = (c.displayName || '').trim().replace(/\s+/g, ' ');
    if (!name) continue;
    const lower = name.toLowerCase();
    const first = lower.split(' ')[0];
    if (!byFirst.has(first)) byFirst.set(first, []);
    byFirst.get(first).push({ id: c.id, name, lower });
  }
  for (const v of byFirst.values()) v.sort((a, b) => b.lower.length - a.lower.length);
  cache = { list, byFirst };
  return byFirst;
}

const WORD = /[\p{L}\p{N}]/u;

/** Every “@Name” in the text that names one of your contacts: [{ start, end, id, name }]. */
export function findMentions(text) {
  const out = [];
  const s = String(text ?? '');
  if (!s.includes('@')) return out;
  const byFirst = index();
  for (let i = s.indexOf('@'); i >= 0; i = s.indexOf('@', i + 1)) {
    if (i > 0 && WORD.test(s[i - 1])) continue; // an email address, not a mention
    const rest = s.slice(i + 1);
    const first = (/^[^\s@]+/.exec(rest)?.[0] ?? '').toLowerCase();
    const cands = byFirst.get(first) ?? byFirst.get(first.replace(/[.,;:!?)’'”"]+$/u, '')) ?? [];
    for (const c of cands) {
      // Case-insensitive, and any run of spaces between the words.
      c.re ??= new RegExp(c.lower.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'iuy');
      c.re.lastIndex = i + 1;
      if (!c.re.test(s)) continue;
      const end = c.re.lastIndex;
      if (WORD.test(s[end] ?? '')) continue; // “@Ann” inside “@Annabel”
      out.push({ start: i, end, id: c.id, name: c.name });
      i = end - 1;
      break;
    }
  }
  return out;
}

/** The text as HTML, with each mention a link to that person. */
export function mentionHtml(text) {
  const s = String(text ?? '');
  let html = '';
  let at = 0;
  for (const m of findMentions(s)) {
    html += esc(s.slice(at, m.start));
    html += `<a href="#" class="mention" data-mention="${esc(m.id)}">${esc(s.slice(m.start, m.end))}</a>`;
    at = m.end;
  }
  return html + esc(s.slice(at));
}

/** Links to the people a field’s value mentions, shown under its box. */
export function mentionLinks(text) {
  const seen = new Set();
  const links = findMentions(text)
    .filter((m) => !seen.has(m.id) && seen.add(m.id))
    .map((m) => `<a href="#" class="mention" data-mention="${esc(m.id)}">@${esc(m.name)}</a>`);
  return `<div class="mention-links"${links.length ? '' : ' hidden'}>${links.join('')}</div>`;
}

// ---- Suggestions while typing

const FIELDS = 'textarea[data-draft="notes"], textarea.own-input, input.own-input[type="text"], .cell-editor:not([type="date"])';
let M = null; // { el, start, items, i }

function menu() {
  let m = document.getElementById('mention-menu');
  if (!m) {
    m = document.createElement('div');
    m.id = 'mention-menu';
    m.className = 'menu mention-menu';
    m.setAttribute('popover', 'manual');
    m.setAttribute('role', 'listbox');
    // Keep focus in the field while picking with the mouse.
    m.addEventListener('mousedown', (e) => e.preventDefault());
    m.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]');
      if (b && M) pick(Number(b.dataset.i));
    });
    document.body.append(m);
  }
  return m;
}

function close() {
  M = null;
  const m = document.getElementById('mention-menu');
  if (m?.matches(':popover-open')) m.hidePopover();
}

function suggest(el) {
  if (!el.matches?.(FIELDS) || el.selectionStart !== el.selectionEnd) return close();
  const before = el.value.slice(0, el.selectionStart);
  const q = /(?:^|[^\p{L}\p{N}])@([^@\n]{0,40})$/u.exec(before);
  if (!q || /\s{2}|^\s/.test(q[1]) || q[1].split(' ').length > 3) return close();
  const query = q[1].toLowerCase();
  const seen = new Set();
  const items = getContacts()
    .filter((c) => (c.displayName || '').trim())
    .map((c) => {
      const name = c.displayName.trim().replace(/\s+/g, ' ');
      const lower = name.toLowerCase();
      const rank = !query ? 1 : lower.startsWith(query) ? 0 : lower.split(' ').some((w, k, ws) => ws.slice(k).join(' ').startsWith(query)) ? 1 : -1;
      return { c, name, rank };
    })
    .filter((x) => x.rank >= 0 && !seen.has(x.name) && seen.add(x.name))
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
    .slice(0, 6);
  if (!items.length) return close();
  M = { el, start: before.length - q[1].length - 1, items, i: 0 };
  draw();
}

function draw() {
  const m = menu();
  m.innerHTML = M.items
    .map(
      (x, i) =>
        `<button type="button" role="option" data-i="${i}" aria-selected="${i === M.i}"${i === M.i ? ' class="active"' : ''}>${esc(x.name)}${
          x.c.organization ? `<span class="mention-org">${esc(x.c.organization)}</span>` : ''
        }</button>`,
    )
    .join('');
  if (!m.matches(':popover-open')) m.showPopover();
  const r = M.el.getBoundingClientRect();
  const below = r.bottom + 4 + m.offsetHeight <= window.innerHeight - 8;
  m.style.top = `${Math.round(below ? r.bottom + 4 : Math.max(8, r.top - 4 - m.offsetHeight))}px`;
  m.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8)))}px`;
}

function pick(i) {
  const x = M?.items[i];
  if (!x) return close();
  const { el, start } = M;
  const end = el.selectionStart;
  const insert = `@${x.name} `;
  el.value = el.value.slice(0, start) + insert + el.value.slice(end).replace(/^ /, '');
  const caret = start + insert.length;
  el.setSelectionRange(caret, caret);
  close();
  // Let the app see the change (drafts, field saves, cell edits).
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Refresh the links under a field’s box as you type. */
function refreshLinks(el) {
  if (!el.classList?.contains('own-input')) return;
  const box = el.closest('dd')?.querySelector('.mention-links');
  if (box) box.outerHTML = mentionLinks(el.value);
}

export function initMentions({ contacts, open }) {
  getContacts = contacts;
  openContact = open;
  document.addEventListener('input', (e) => {
    if (!e.target.matches?.(FIELDS)) return;
    suggest(e.target);
    refreshLinks(e.target);
  });
  document.addEventListener(
    'keydown',
    (e) => {
      if (!M || e.target !== M.el || e.isComposing) return;
      const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
      if (step) M.i = (M.i + step + M.items.length) % M.items.length;
      else if (e.key === 'Enter' || e.key === 'Tab') pick(M.i);
      else if (e.key === 'Escape') close();
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (M) draw();
    },
    true,
  );
  document.addEventListener('focusout', (e) => {
    if (M && e.target === M.el) setTimeout(() => document.activeElement !== M?.el && close(), 0);
  });
  document.addEventListener('scroll', () => M && draw(), true);
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a.mention[data-mention]');
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    openContact(a.dataset.mention);
  });
}
