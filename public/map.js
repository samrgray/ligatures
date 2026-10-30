// The map: everyone in the list you’re viewing, at each of their addresses. People without a
// street address sit on their neighborhood (if you’ve filled it in) or their city. Vector
// OpenStreetMap tiles from OpenFreeMap, drawn with MapLibre (bundled in /vendor).

const STYLES = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};
const LABEL_ORDER = ['home', 'work', 'other'];
const FACE = 34; // face diameter, px

const thumb = (url) => (/googleusercontent\.com/.test(url) ? url.replace(/=s\d+(-c)?$/, '') + '=s96-c' : url);

/**
 * Spread overlapping markers apart. Markers closer than `d` join a group (and groups whose
 * spread would touch join too); each group is laid out as a honeycomb around its middle, with
 * each marker in the cell nearest its real position. Returns a pixel offset per point.
 */
export function spread(pts, d) {
  const cells = (n) => {
    // Rings of a hexagonal honeycomb: 1, 6, 12, 18…
    let k = 0;
    while (1 + 3 * k * (k + 1) < n) k++;
    return k;
  };
  let groups = pts.map((p, i) => ({ members: [i], x: p.x, y: p.y, r: 0 }));
  for (let pass = 0; pass < 12; pass++) {
    groups.sort((a, b) => a.x - b.x);
    const maxR = Math.max(...groups.map((g) => g.r));
    const gone = new Set();
    let merged = false;
    for (let i = 0; i < groups.length; i++) {
      if (gone.has(i)) continue;
      const a = groups[i];
      for (let j = i + 1; j < groups.length; j++) {
        const b = groups[j];
        if (b.x - a.x > a.r + maxR + d) break;
        if (gone.has(j)) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r + d * 0.98) {
          a.members.push(...b.members);
          a.x = a.members.reduce((s, m) => s + pts[m].x, 0) / a.members.length;
          a.y = a.members.reduce((s, m) => s + pts[m].y, 0) / a.members.length;
          a.r = cells(a.members.length) * d;
          gone.add(j);
          merged = true;
        }
      }
    }
    groups = groups.filter((_, i) => !gone.has(i));
    if (!merged) break;
  }
  const out = pts.map(() => ({ dx: 0, dy: 0 }));
  for (const g of groups) {
    if (g.members.length === 1) continue;
    for (const m of g.members) out[m].grouped = true;
    const k = cells(g.members.length);
    const slots = [];
    for (let q = -k; q <= k; q++) {
      for (let r = Math.max(-k, -q - k); r <= Math.min(k, -q + k); r++) {
        slots.push({ x: d * (q + r / 2), y: d * r * (Math.sqrt(3) / 2) });
      }
    }
    slots.sort((s1, s2) => Math.hypot(s1.x, s1.y) - Math.hypot(s2.x, s2.y) || Math.atan2(s1.y, s1.x) - Math.atan2(s2.y, s2.x));
    const left = new Set(g.members);
    for (const s of slots.slice(0, g.members.length)) {
      let best = null;
      let bestD = Infinity;
      for (const m of left) {
        const dd = Math.hypot(pts[m].x - (g.x + s.x), pts[m].y - (g.y + s.y));
        if (dd < bestD) [best, bestD] = [m, dd];
      }
      left.delete(best);
      out[best] = { dx: g.x + s.x - pts[best].x, dy: g.y + s.y - pts[best].y, grouped: true };
    }
  }
  return out;
}

let lib = null;
function loadLib() {
  if (lib) return lib;
  lib = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/vendor/maplibre/maplibre-gl.css';
    // Ligature’s own map styles come after MapLibre’s, so load it before app.css.
    document.head.prepend(css);
    const cssReady = new Promise((r) => {
      css.onload = r;
      css.onerror = r;
    });
    const s = document.createElement('script');
    s.src = '/vendor/maplibre/maplibre-gl-csp.js';
    s.onload = async () => {
      await cssReady;
      window.maplibregl.setWorkerUrl('/vendor/maplibre/maplibre-gl-csp-worker.js');
      resolve(window.maplibregl);
    };
    s.onerror = () => {
      lib = null;
      reject(new Error('The map couldn’t load.'));
    };
    document.head.append(s);
  });
  return lib;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);


export class PeopleMap {
  /**
   * ctx: { people() → contacts shown, selected() → Set of ids, setSelected(ids, on), open(id),
   *        api(path, opts), dark() → bool, error(e) }
   */
  constructor(host, ctx) {
    this.host = host;
    this.ctx = ctx;
    this.points = null; // from the server: { id, label, precision, lat, lng, text }
    this.failed = [];
    this.pending = 0;
    this.labels = new Set(); // address types to show; empty = all
    this.visible = false;
    this.fittedFor = null;
    this.looking = false;
    this.pins = null; // your own pins: { id, label, address, lat, lng }
    this.markers = new Map();
    this.search = null; // the Add Pin panel: { q, results, picked, busy, error }
    this.render();
  }

  render() {
    this.host.innerHTML = `
      <div class="map" id="map-canvas"></div>
      <div class="map-bar">
        <div class="map-types" id="map-types" role="group" aria-label="Address types"></div>
        <span class="grow"></span>
        <button type="button" class="btn map-btn" data-map-action="add-pin">Add Pin</button>
        <button type="button" class="btn map-btn" data-map-action="select-view" title="Select everyone in view">Select in View</button>
      </div>
      <div class="map-search" id="map-search" hidden></div>
      <div class="map-status" id="map-status" role="status" aria-live="polite"></div>
      <div class="map-box" id="map-box" hidden></div>`;
    this.host.addEventListener('click', (e) => this.click(e));
    this.host.addEventListener('submit', (e) => {
      e.preventDefault();
      if (e.target.id === 'pin-search-form') this.runSearch();
      if (e.target.id === 'pin-label-form') this.savePin();
    });
    this.host.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.search) {
        e.stopPropagation();
        this.closeSearch();
      }
    });
  }

  async show() {
    this.visible = true;
    if (!this.map) await this.mount();
    else this.map.resize();
    if (!this.pins) this.loadPins();
    if (!this.points) await this.reload();
    else this.update();
  }

  hide() {
    this.visible = false;
    this.popup?.remove();
  }

  /** Something changed (addresses, neighborhoods, contacts): fetch the points again. */
  invalidate() {
    this.points = this.visible ? this.points : null;
    if (this.visible) this.reload();
  }

  async mount() {
    let ml;
    try {
      ml = await loadLib();
    } catch (e) {
      this.status(e.message);
      return;
    }
    this.ml = ml;
    this.theme = this.ctx.dark() ? 'dark' : 'light';
    this.map = new ml.Map({
      container: this.host.querySelector('#map-canvas'),
      style: window.LIGATURE_MAP_STYLE ?? STYLES[this.theme], // tests use a blank local style
      center: [-98.6, 39.8],
      zoom: 3,
      boxZoom: false,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    this.map.touchZoomRotate.disableRotation();
    this.host.mapInstance = this.map; // for tests
    this.map.addControl(new ml.NavigationControl({ showCompass: false }), 'bottom-right');
    this.map.on('style.load', () => this.addLayers());
    // Once you’ve moved the map yourself, new points don’t reframe it.
    this.map.on('movestart', (e) => {
      if (e.originalEvent) this.userMoved = true;
    });
    this.map.on('click', (e) => this.mapClick(e));
    // Faces near each other spread apart; how far depends on the zoom.
    this.map.on('zoom', () => this.scheduleLayout());
    this.map.on('zoomend', () => this.layout());
    this.boxSelect();
    this.drawPins();
  }

  setTheme() {
    const t = this.ctx.dark() ? 'dark' : 'light';
    if (!this.map || t === this.theme) return;
    this.theme = t;
    this.map.setStyle(STYLES[t]);
  }

  colors() {
    const css = getComputedStyle(document.documentElement);
    const v = (n) => css.getPropertyValue(n).trim();
    return { accent: v('--accent'), bg: v('--bg'), text: v('--text'), onAccent: v('--accent-text') || '#fff' };
  }

  /** Faces are DOM markers, so a new map style needs nothing re-added. */
  addLayers() {
    this.fittedFor = null;
    this.map.resize();
    this.update();
  }

  // ---- data

  async reload() {
    try {
      const r = await this.ctx.api('/map');
      this.take(r);
    } catch (e) {
      this.ctx.error(e);
    }
    this.update();
    if (this.pending) this.lookUp();
  }

  take(r) {
    this.points = r.points;
    this.failed = r.failed;
    this.pending = r.pending;
  }

  /** Look up the remaining places a few at a time while the map is open. */
  async lookUp() {
    if (this.looking) return;
    this.looking = true;
    try {
      while (this.visible && this.pending) {
        const r = await this.ctx.api('/map/geocode', { method: 'POST' });
        this.take(r);
        this.update();
        if (r.stalled) {
          this.status(this.summary() + ' · OpenStreetMap isn’t answering. Try again later.');
          break;
        }
        if (r.busy) await new Promise((res) => setTimeout(res, 3000));
      }
    } catch (e) {
      this.ctx.error(e);
    } finally {
      this.looking = false;
    }
  }

  shownPoints() {
    const people = new Map(this.ctx.people().map((c) => [c.id, c]));
    return (this.points ?? []).filter((p) => people.has(p.id) && (!this.labels.size || this.labels.has(this.typeOf(p))));
  }

  typeOf(p) {
    return p.label || 'other';
  }

  /** Redraw for the current list, search, address types and selection. */
  update() {
    if (!this.visible) return;
    this.renderTypes();
    this.status();
    if (!this.map) return;
    const shown = this.shownPoints();
    this.drawFaces(shown);
    // Frame everyone when the list changes, not on every selection or lookup.
    const view = this.ctx.people().map((c) => c.id).join() + '|' + [...this.labels].join();
    if (view !== this.fittedFor) this.userMoved = false;
    if (shown.length && (view !== this.fittedFor || (!this.userMoved && shown.length !== this.fittedCount))) {
      this.fittedFor = view;
      this.fittedCount = shown.length;
      this.fit(shown);
    }
    this.layout();
  }

  /** One round marker per person per address: their photo, or their initials. */
  drawFaces(shown) {
    const people = new Map(this.ctx.people().map((c) => [c.id, c]));
    const sel = this.ctx.selected();
    this.faces ??= new Map();
    const keep = new Set();
    for (const p of shown) {
      const key = `${p.id}|${p.lat}|${p.lng}|${p.label}`;
      keep.add(key);
      const c = people.get(p.id);
      let f = this.faces.get(key);
      if (!f) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'face';
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          if (e.shiftKey || e.metaKey || e.ctrlKey) return this.ctx.setSelected([p.id], !this.ctx.selected().has(p.id));
          this.openPopup([p.lng, p.lat], [p]);
        });
        const marker = new this.ml.Marker({ element: el, anchor: 'center' }).setLngLat([p.lng, p.lat]).addTo(this.map);
        f = { el, marker, point: p, photo: null };
        this.faces.set(key, f);
      }
      f.point = p;
      const photo = c.photoUrl ? thumb(c.photoUrl) : '';
      if (f.photo !== photo || f.name !== c.displayName) {
        f.photo = photo;
        f.name = c.displayName;
        const initials = ((c.givenName?.[0] ?? '') + (c.familyName?.[0] ?? '')).toUpperCase() || (c.displayName?.[0] ?? '?').toUpperCase();
        f.el.innerHTML = `<span class="face-img">${
          photo ? `<img src="${esc(photo)}" alt="" referrerpolicy="no-referrer" loading="lazy">` : `<span>${esc(initials)}</span>`
        }</span><span class="face-name">${esc(c.displayName || 'No name')}</span>`;
        f.el.setAttribute('aria-label', c.displayName || 'No name');
      }
      f.el.classList.toggle('exact', p.precision === 'address');
      f.el.classList.toggle('photo', Boolean(photo));
      f.el.classList.toggle('sel', sel.has(p.id));
      f.el.title = [c.displayName, p.label, p.text].filter(Boolean).join(' · ');
    }
    for (const [key, f] of this.faces) {
      if (!keep.has(key)) {
        f.marker.remove();
        this.faces.delete(key);
      }
    }
  }

  scheduleLayout() {
    if (this.layoutQueued) return;
    this.layoutQueued = true;
    requestAnimationFrame(() => {
      this.layoutQueued = false;
      this.layout();
    });
  }

  /** Spread out faces that overlap so everyone shows. */
  layout() {
    if (!this.map || !this.faces?.size) return;
    const faces = [...this.faces.values()];
    const pts = faces.map((f) => this.map.project([f.point.lng, f.point.lat]));
    const offsets = spread(pts, FACE + 4);
    faces.forEach((f, i) => {
      f.marker.setOffset([offsets[i].dx, offsets[i].dy]);
      // Spread-out faces are too close for their names; hovering still shows one.
      f.el.classList.toggle('grouped', Boolean(offsets[i].dx || offsets[i].dy) || offsets[i].grouped);
    });
    this.host.classList.toggle('show-names', this.map.getZoom() >= 13.5);
  }

  refreshSelection() {
    if (!this.visible || !this.faces) return this.fillPopup();
    const sel = this.ctx.selected();
    for (const f of this.faces.values()) f.el.classList.toggle('sel', sel.has(f.point.id));
    this.fillPopup();
  }

  fit(points) {
    const b = new this.ml.LngLatBounds();
    for (const p of points) b.extend([p.lng, p.lat]);
    this.map.fitBounds(b, { padding: { top: 90, bottom: 80, left: 70, right: 150 }, maxZoom: 13, duration: 0 });
  }

  renderTypes() {
    const el = this.host.querySelector('#map-types');
    const people = new Set(this.ctx.people().map((c) => c.id));
    const counts = new Map();
    for (const p of this.points ?? []) {
      if (!people.has(p.id)) continue;
      const t = this.typeOf(p);
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    for (const t of [...this.labels]) if (!counts.has(t)) this.labels.delete(t);
    const types = [...counts.keys()].sort((a, b) => {
      const ia = LABEL_ORDER.indexOf(a), ib = LABEL_ORDER.indexOf(b);
      return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib) || a.localeCompare(b);
    });
    const chip = (id, label, on) => `<button type="button" class="map-chip" data-map-type="${esc(id)}" aria-pressed="${on}">${esc(label)}</button>`;
    el.innerHTML = types.length > 1
      ? chip('', 'All', !this.labels.size) + types.map((t) => chip(t, t[0].toUpperCase() + t.slice(1), this.labels.has(t))).join('')
      : '';
  }

  summary() {
    const shown = new Set(this.shownPoints().map((p) => p.id));
    const people = this.ctx.people();
    const placed = new Set((this.points ?? []).map((p) => p.id));
    const failedIds = new Set(this.failed.map((f) => f.id));
    const without = people.filter((c) => !placed.has(c.id) && !failedIds.has(c.id)).length;
    const notFound = people.filter((c) => failedIds.has(c.id) && !placed.has(c.id)).length;
    const parts = [`${shown.size} ${shown.size === 1 ? 'person' : 'people'} on the map`];
    if (without && !this.pending) parts.push(`${without} without an address`);
    if (notFound) parts.push(`${notFound} with an address OpenStreetMap couldn’t find`);
    return parts.join(' · ');
  }

  status(msg) {
    const el = this.host.querySelector('#map-status');
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      return;
    }
    if (!this.points) {
      el.textContent = 'Loading…';
      return;
    }
    el.textContent = this.summary() + (this.pending ? ` · Finding ${this.pending} ${this.pending === 1 ? 'place' : 'places'} on the map…` : '');
  }

  // ---- your own pins

  async loadPins() {
    try {
      this.pins = (await this.ctx.api('/pins')).pins;
    } catch (e) {
      this.pins = [];
      return this.ctx.error(e);
    }
    this.drawPins();
  }

  drawPins() {
    if (!this.map || !this.pins) return;
    const ids = new Set(this.pins.map((p) => p.id));
    for (const [id, m] of this.markers) {
      if (!ids.has(id)) {
        m.remove();
        this.markers.delete(id);
      }
    }
    for (const p of this.pins) {
      let m = this.markers.get(p.id);
      if (!m) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'map-pin';
        el.innerHTML = `<svg width="22" height="28" viewBox="0 0 22 28" aria-hidden="true"><path d="M11 27s9-9.1 9-15.5A9 9 0 0 0 2 11.5C2 17.9 11 27 11 27z"/><circle cx="11" cy="11.5" r="3.5"/></svg><span class="map-pin-label"></span>`;
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          this.openPin(p.id);
        });
        m = new this.ml.Marker({ element: el, anchor: 'bottom' }).setLngLat([p.lng, p.lat]).addTo(this.map);
        this.markers.set(p.id, m);
      }
      const el = m.getElement();
      el.querySelector('.map-pin-label').textContent = p.label;
      el.setAttribute('aria-label', `Pin: ${p.label}`);
    }
  }

  openPin(id) {
    const p = this.pins.find((x) => x.id === id);
    if (!p) return;
    this.popup?.remove();
    const el = document.createElement('form');
    el.className = 'map-pop pin-pop';
    el.innerHTML = `<label class="pin-pop-label">Label<input class="input" maxlength="100" value="${esc(p.label)}" autocomplete="off"></label>
      ${p.address ? `<div class="map-pop-sub">${esc(p.address)}</div>` : ''}
      <div class="pin-pop-foot"><button type="button" class="btn danger" data-pin-remove>Remove Pin</button><span class="grow"></span><button type="submit" class="btn primary">Save</button></div>`;
    const input = el.querySelector('input');
    const save = async () => {
      const label = input.value.trim();
      if (!label || label === p.label) return;
      try {
        const r = await this.ctx.api(`/pins/${encodeURIComponent(p.id)}`, { method: 'PATCH', body: { label } });
        Object.assign(p, r.pin);
        this.drawPins();
      } catch (e) {
        this.ctx.error(e);
      }
    };
    el.addEventListener('submit', async (e) => {
      e.preventDefault();
      await save();
      this.popup?.remove();
    });
    el.querySelector('[data-pin-remove]').addEventListener('click', async () => {
      try {
        await this.ctx.api(`/pins/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
      } catch (e) {
        return this.ctx.error(e);
      }
      this.pins = this.pins.filter((x) => x.id !== p.id);
      this.popup?.remove();
      this.drawPins();
    });
    this.popup = new this.ml.Popup({ closeButton: true, maxWidth: '300px', offset: [0, -30] }).setLngLat([p.lng, p.lat]).setDOMContent(el).addTo(this.map);
    input.focus();
    input.select();
  }

  openSearch() {
    this.popup?.remove();
    this.search = { q: '', results: null, picked: null, busy: false, error: '' };
    this.renderSearch();
    this.host.querySelector('#pin-q')?.focus();
  }

  closeSearch() {
    this.search = null;
    this.renderSearch();
  }

  renderSearch() {
    const el = this.host.querySelector('#map-search');
    const s = this.search;
    el.hidden = !s;
    if (!s) return (el.innerHTML = '');
    if (s.picked) {
      el.innerHTML = `<form id="pin-label-form" class="map-search-form">
          <div class="map-search-h">Pin “${esc(s.picked.name || s.picked.address)}”</div>
          <div class="map-pop-sub">${esc(s.picked.address)}</div>
          <label class="pin-pop-label">Label<input class="input" id="pin-label" maxlength="100" value="${esc(s.picked.name)}" autocomplete="off"></label>
          <div class="pin-pop-foot"><button type="button" class="btn" data-map-action="pin-back">Back</button><span class="grow"></span>
            <button type="submit" class="btn primary"${s.busy ? ' disabled' : ''}>Add Pin</button></div>
        </form>`;
      return;
    }
    const results = s.results
      ? s.results.length
        ? `<ul class="map-results">${s.results
            .map((r, i) => `<li><button type="button" data-pin-pick="${i}"><strong>${esc(r.name)}</strong><span>${esc(r.address)}</span></button></li>`)
            .join('')}</ul>`
        : '<div class="map-pop-sub">No places found.</div>'
      : '';
    el.innerHTML = `<form id="pin-search-form" class="map-search-form">
        <div class="map-search-row">
          <input class="input" id="pin-q" type="search" placeholder="Search for an address or place" value="${esc(s.q)}" autocomplete="off" aria-label="Search for an address or place">
          <button type="submit" class="btn primary"${s.busy ? ' disabled' : ''}>${s.busy ? 'Searching…' : 'Search'}</button>
          <button type="button" class="icon-btn" data-map-action="pin-cancel" aria-label="Cancel">✕</button>
        </div>
        ${s.error ? `<div class="map-pop-sub">${esc(s.error)}</div>` : ''}
        ${results}
      </form>`;
  }

  async runSearch() {
    const s = this.search;
    if (!s || s.busy) return;
    s.q = this.host.querySelector('#pin-q').value.trim();
    if (s.q.length < 3) return;
    s.busy = true;
    s.error = '';
    this.renderSearch();
    try {
      s.results = (await this.ctx.api(`/places?q=${encodeURIComponent(s.q)}`)).places;
    } catch (e) {
      s.error = e.message;
    }
    s.busy = false;
    if (this.search !== s) return;
    this.renderSearch();
    this.host.querySelector('#pin-q')?.focus();
  }

  async savePin() {
    const s = this.search;
    if (!s?.picked || s.busy) return;
    const label = this.host.querySelector('#pin-label').value.trim();
    if (!label) return this.host.querySelector('#pin-label').focus();
    s.busy = true;
    this.renderSearch();
    try {
      const { pin } = await this.ctx.api('/pins', { method: 'POST', body: { label, lat: s.picked.lat, lng: s.picked.lng, address: s.picked.address } });
      this.pins = [...(this.pins ?? []), pin];
      this.closeSearch();
      this.drawPins();
      this.userMoved = true;
      this.map.easeTo({ center: [pin.lng, pin.lat], zoom: Math.max(this.map.getZoom(), 13) });
    } catch (e) {
      s.busy = false;
      this.renderSearch();
      this.ctx.error(e);
    }
  }

  // ---- interaction

  click(e) {
    const t = e.target;
    const action = t.closest('[data-map-action]')?.dataset.mapAction;
    if (action === 'add-pin') return this.search ? this.closeSearch() : this.openSearch();
    if (action === 'pin-cancel') return this.closeSearch();
    if (action === 'pin-back') {
      this.search.picked = null;
      this.renderSearch();
      return this.host.querySelector('#pin-q')?.focus();
    }
    const pick = t.closest('[data-pin-pick]');
    if (pick && this.search) {
      this.search.picked = this.search.results[Number(pick.dataset.pinPick)];
      this.renderSearch();
      const input = this.host.querySelector('#pin-label');
      input?.focus();
      input?.select();
      return;
    }
    const type = t.closest('[data-map-type]');
    if (type) {
      const id = type.dataset.mapType;
      if (!id) this.labels.clear();
      else if (this.labels.has(id)) this.labels.delete(id);
      else this.labels.add(id);
      return this.update();
    }
    if (t.closest('[data-map-action="select-view"]')) {
      const bounds = this.map?.getBounds();
      if (!bounds) return;
      const ids = this.shownPoints().filter((p) => bounds.contains([p.lng, p.lat])).map((p) => p.id);
      return this.ctx.setSelected([...new Set(ids)], true);
    }
  }

  mapClick() {
    this.popup?.remove();
  }

  openPopup(lngLat, points) {
    this.popup?.remove();
    const el = document.createElement('div');
    el.className = 'map-pop';
    const people = new Map(this.ctx.people().map((c) => [c.id, c]));
    this.popItems = points.map((p) => ({ id: p.id, name: people.get(p.id)?.displayName || 'No name', label: p.label, precision: p.precision, text: p.text }));
    el.addEventListener('click', (e) => {
      const check = e.target.closest('[data-pop-check]');
      if (check) return this.ctx.setSelected([check.dataset.popCheck], check.checked);
      const all = e.target.closest('[data-pop-all]');
      if (all) {
        const ids = [...new Set(this.popItems.map((x) => x.id))];
        const sel = this.ctx.selected();
        return this.ctx.setSelected(ids, !ids.every((id) => sel.has(id)));
      }
      const open = e.target.closest('[data-pop-open]');
      if (open) this.ctx.open(open.dataset.popOpen);
    });
    this.popEl = el;
    this.fillPopup();
    this.popup = new this.ml.Popup({ closeButton: true, maxWidth: '300px', offset: 14 }).setLngLat(lngLat).setDOMContent(el).addTo(this.map);
    this.popup.on('close', () => {
      this.popEl = null;
    });
  }

  fillPopup() {
    const el = this.popEl;
    if (!el) return;
    const sel = this.ctx.selected();
    const items = [...this.popItems].sort((a, b) => a.name.localeCompare(b.name));
    const ids = [...new Set(items.map((x) => x.id))];
    const allOn = ids.every((id) => sel.has(id));
    el.innerHTML = `
      ${ids.length > 1 ? `<div class="map-pop-h"><span>${ids.length} people</span><button type="button" class="link" data-pop-all>${allOn ? 'Deselect All' : 'Select All'}</button></div>` : ''}
      <ul>${items
        .map((x) => {
          const where = [x.label, x.text].filter(Boolean).join(' · ');
          return `<li><input type="checkbox" data-pop-check="${esc(x.id)}" aria-label="Select ${esc(x.name)}" ${sel.has(x.id) ? 'checked' : ''}>
            <div><button type="button" class="link" data-pop-open="${esc(x.id)}">${esc(x.name)}</button>
            <div class="map-pop-sub">${esc(where)}</div></div></li>`;
        })
        .join('')}</ul>`;
  }

  /** Shift-drag draws a box; everyone inside is selected. */
  boxSelect() {
    const canvas = this.map.getCanvasContainer();
    const boxEl = this.host.querySelector('#map-box');
    let start = null;
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return new this.ml.Point(e.clientX - r.left - canvas.clientLeft, e.clientY - r.top - canvas.clientTop);
    };
    const move = (e) => {
      const p = pos(e);
      const [x1, x2] = [Math.min(start.x, p.x), Math.max(start.x, p.x)];
      const [y1, y2] = [Math.min(start.y, p.y), Math.max(start.y, p.y)];
      boxEl.hidden = false;
      boxEl.style.transform = `translate(${x1}px, ${y1}px)`;
      boxEl.style.width = `${x2 - x1}px`;
      boxEl.style.height = `${y2 - y1}px`;
    };
    const up = async (e) => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      boxEl.hidden = true;
      this.map.dragPan.enable();
      const end = pos(e);
      if (Math.abs(end.x - start.x) < 4 && Math.abs(end.y - start.y) < 4) return;
      const a = this.map.unproject(start);
      const b = this.map.unproject(end);
      const bounds = new this.ml.LngLatBounds(a, a).extend(b);
      const ids = this.shownPoints().filter((p) => bounds.contains([p.lng, p.lat])).map((p) => p.id);
      if (ids.length) this.ctx.setSelected([...new Set(ids)], true);
    };
    canvas.addEventListener(
      'mousedown',
      (e) => {
        if (!e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        this.map.dragPan.disable();
        start = pos(e);
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      },
      true,
    );
  }
}

// ---------------------------------------------------------------- behind a contact’s name

const HERO_ZOOM = { address: 13.5, neighborhood: 12.5, postal: 11.5, city: 10.5 };
let hero = null; // one small map, moved into each contact’s header as it’s drawn

/**
 * A faint, still map behind a contact’s photo and name: their place centred vertically and
 * three quarters of the way across (the left half is padding, so the centre lands there).
 */
export async function heroMap(host, point, dark) {
  const ml = await loadLib();
  const theme = dark ? 'dark' : 'light';
  if (!hero) {
    const el = document.createElement('div');
    el.className = 'hero-map-canvas';
    const map = new ml.Map({
      container: el,
      style: window.LIGATURE_MAP_STYLE ?? STYLES[theme],
      center: [point.lng, point.lat],
      zoom: HERO_ZOOM[point.precision] ?? 6.5,
      interactive: false,
      attributionControl: false,
    });
    hero = { el, map, theme };
  }
  if (!host.isConnected) return;
  host.prepend(hero.el);
  if (hero.theme !== theme && !window.LIGATURE_MAP_STYLE) {
    hero.theme = theme;
    hero.map.setStyle(STYLES[theme]);
  }
  hero.map.resize();
  hero.map.jumpTo({
    center: [point.lng, point.lat],
    zoom: HERO_ZOOM[point.precision] ?? 6.5,
    padding: { left: host.clientWidth * 0.5, top: 0, right: 0, bottom: 0 },
  });
}

// ---------------------------------------------------------------- one contact, full screen

/**
 * One contact’s place on a full map you can move around: their face, and your pins, but no
 * one else. `show(point)` moves to another of their places. `bottom` keeps the place clear of
 * the panel along the bottom.
 */
export async function placeMap(container, { person, point, pins, dark, bottom = 0 }) {
  const ml = await loadLib();
  const zoom = (p) => (HERO_ZOOM[p.precision] ?? 6.5) + 1.5;
  const map = new ml.Map({
    container,
    style: window.LIGATURE_MAP_STYLE ?? STYLES[dark ? 'dark' : 'light'],
    center: [point.lng, point.lat],
    zoom: zoom(point),
    attributionControl: { compact: true },
    dragRotate: false,
    pitchWithRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new ml.NavigationControl({ showCompass: false }), 'top-right');
  map.setPadding({ top: 0, left: 0, right: 0, bottom });
  container.mapInstance = map; // for tests

  const photo = person.photoUrl ? thumb(person.photoUrl) : '';
  const initials =
    ((person.givenName?.[0] ?? '') + (person.familyName?.[0] ?? '')).toUpperCase() || (person.displayName?.[0] ?? '?').toUpperCase();
  const face = document.createElement('div');
  face.className = `face${photo ? ' photo' : ''}`;
  face.innerHTML = `<span class="face-img">${
    photo ? `<img src="${esc(photo)}" alt="" referrerpolicy="no-referrer">` : `<span>${esc(initials)}</span>`
  }</span><span class="face-name">${esc(person.displayName || 'No name')}</span>`;
  const marker = new ml.Marker({ element: face, anchor: 'center' }).setLngLat([point.lng, point.lat]).addTo(map);

  for (const p of pins) {
    const el = document.createElement('div');
    el.className = 'map-pin';
    el.innerHTML = `<svg width="22" height="28" viewBox="0 0 22 28" aria-hidden="true"><path d="M11 27s9-9.1 9-15.5A9 9 0 0 0 2 11.5C2 17.9 11 27 11 27z"/><circle cx="11" cy="11.5" r="3.5"/></svg><span class="map-pin-label">${esc(p.label)}</span>`;
    el.setAttribute('aria-label', `Pin: ${p.label}`);
    new ml.Marker({ element: el, anchor: 'bottom' }).setLngLat([p.lng, p.lat]).addTo(map);
  }

  const show = (p, animate = true) => {
    face.classList.toggle('exact', p.precision === 'address');
    marker.setLngLat([p.lng, p.lat]);
    map[animate ? 'easeTo' : 'jumpTo']({ center: [p.lng, p.lat], zoom: zoom(p) });
  };
  show(point, false);
  return { show, remove: () => map.remove() };
}
