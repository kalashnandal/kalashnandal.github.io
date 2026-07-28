/* ═══════════════════════════════════════════════════════════════════════════
   Never Again — personal restaurant blacklist PWA
   ---------------------------------------------------------------------------
   Vanilla ES6. No build step, no backend. Everything lives in localStorage.

   Modules, top to bottom:
     1.  Config & constants
     2.  Tiny DOM/utility helpers
     3.  Storage (localStorage repository for the blacklist)
     4.  App state
     5.  Google Maps bootstrap (maps / places / marker / geometry)
     6.  Markers
     7.  Place selection (map taps, POI taps, autocomplete)
     8.  Bottom sheet (details view + block form)
     9.  Blacklist panel
     10. Geolocation watcher + proximity/geofence engine
     11. Notifications
     12. Onboarding & permissions
     13. Service worker registration + bootstrapping

   NOTE ON BACKGROUND TRACKING: mobile browsers suspend timers and geolocation
   watches once the tab is backgrounded for a while. Proximity warnings are
   reliable while the app is open or freshly minimised; they are not a
   replacement for a native background-geolocation plugin. See README.
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

/* ─────────────────────────────────────────────────────────────────────────
   1. CONFIG
   ───────────────────────────────────────────────────────────────────────── */

const CONFIG = {
  /* Replace with your own Map ID (Google Cloud → Maps → Map management) to
     control map styling. DEMO_MAP_ID works out of the box but is watermarked
     and unstyled — it exists so Advanced Markers can render during dev. */
  MAP_ID: 'DEMO_MAP_ID',

  DEFAULT_CENTER: { lat: 28.6139, lng: 77.2090 }, // fallback until we get a fix
  DEFAULT_ZOOM: 15,
  FOCUS_ZOOM: 17,

  /* Geofence. EXIT is deliberately larger than ENTER so a jittery GPS fix
     sitting right on the boundary can't rapid-fire enter/exit events. */
  GEOFENCE_ENTER_M: 100,
  GEOFENCE_EXIT_M: 160,

  /* Ignore wildly imprecise fixes (usually IP-based geolocation). */
  MAX_ACCURACY_M: 500,

  /* Even after leaving and re-entering, don't re-warn about the same place
     more often than this. */
  NOTIFY_COOLDOWN_MS: 30 * 60 * 1000, // 30 minutes

  TOAST_MS: 2600,
};

/* Quick-select reasons. `id` is what gets stored, `label` is what's shown. */
const TAGS = [
  { id: 'overpriced',     label: 'Overpriced' },
  { id: 'bad-food',       label: 'Bad Food' },
  { id: 'rude-staff',     label: 'Rude Staff' },
  { id: 'food-poisoning', label: 'Food Poisoning' },
  { id: 'noisy',          label: 'Loud / Noisy' },
];

const TAG_LABEL = Object.fromEntries(TAGS.map((t) => [t.id, t.label]));

const KEYS = {
  BLACKLIST: 'neverAgain.blacklist.v1',
  ONBOARDED: 'neverAgain.onboarded.v1',
  NOTIFIED: 'neverAgain.notified.v1', // { [placeId]: lastNotifiedEpochMs }
};


/* ─────────────────────────────────────────────────────────────────────────
   2. HELPERS
   ───────────────────────────────────────────────────────────────────────── */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Element factory: el('div', { class: 'x' }, [child, 'text']) */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** "3.2 km" / "180 m" */
function formatDistance(metres) {
  if (!Number.isFinite(metres)) return '';
  return metres < 1000
    ? `${Math.round(metres)} m`
    : `${(metres / 1000).toFixed(metres < 10000 ? 1 : 0)} km`;
}

/** "today" / "3 days ago" / "12 Mar 2025" */
function formatWhen(iso) {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const days = Math.floor((Date.now() - then.getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

let toastTimer;
function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.hidden = false;
  node.classList.remove('is-leaving');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.classList.add('is-leaving');
    setTimeout(() => { node.hidden = true; }, 250);
  }, CONFIG.TOAST_MS);
}

/** Short haptic tick where supported — makes the app feel native. */
function buzz(pattern = 12) {
  if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch { /* ignore */ } }
}


/* ─────────────────────────────────────────────────────────────────────────
   3. STORAGE
   Entry shape:
     { id, name, address, lat, lng, tags: string[], note, createdAt, updatedAt }
   ───────────────────────────────────────────────────────────────────────── */

const Store = {
  read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (err) {
      console.warn('[NeverAgain] could not read', key, err);
      return fallback;
    }
  },

  write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      // Quota exceeded, or Safari private mode.
      console.error('[NeverAgain] could not save', key, err);
      toast('Could not save — storage is full or blocked.');
      return false;
    }
  },

  /** All blacklisted places, newest first. */
  all() {
    const list = Store.read(KEYS.BLACKLIST, []);
    return Array.isArray(list) ? list.filter((p) => p && p.id && Number.isFinite(p.lat)) : [];
  },

  get(id) {
    return Store.all().find((p) => p.id === id) || null;
  },

  has(id) {
    return Store.all().some((p) => p.id === id);
  },

  /** Insert or update; returns the saved entry. */
  save(entry) {
    const list = Store.all();
    const i = list.findIndex((p) => p.id === entry.id);
    const now = new Date().toISOString();
    const saved = i >= 0
      ? { ...list[i], ...entry, updatedAt: now }
      : { ...entry, createdAt: now, updatedAt: now };
    if (i >= 0) list[i] = saved; else list.unshift(saved);
    Store.write(KEYS.BLACKLIST, list);
    return saved;
  },

  remove(id) {
    Store.write(KEYS.BLACKLIST, Store.all().filter((p) => p.id !== id));
    const notified = Store.read(KEYS.NOTIFIED, {});
    delete notified[id];
    Store.write(KEYS.NOTIFIED, notified);
  },

  clear() {
    Store.write(KEYS.BLACKLIST, []);
    Store.write(KEYS.NOTIFIED, {});
  },
};


/* ─────────────────────────────────────────────────────────────────────────
   4. STATE
   ───────────────────────────────────────────────────────────────────────── */

const state = {
  map: null,
  maps: null,          // google.maps namespace shortcuts, filled on init
  AdvancedMarker: null,
  PinLibReady: false,

  /** id -> AdvancedMarkerElement for blacklisted places */
  markers: new Map(),
  /** transient marker for a searched/tapped place that isn't blocked yet */
  tempMarker: null,
  /** blue dot */
  meMarker: null,

  /** The place currently shown in the bottom sheet (normalised shape). */
  selected: null,

  /** Latest geolocation fix: { lat, lng, accuracy } */
  me: null,
  watchId: null,

  /** Ids currently inside the geofence — the debounce flag from the spec. */
  inside: new Set(),

  /** Panel sort mode: 'recent' | 'near' */
  sort: 'recent',
  /** Expanded entry in the blacklist panel */
  expandedId: null,

  swRegistration: null,
  /** Which tags are toggled in the open form */
  formTags: new Set(),
  /** The place being edited/blocked in the form */
  formPlace: null,
};


/* ─────────────────────────────────────────────────────────────────────────
   5. GOOGLE MAPS BOOTSTRAP
   ───────────────────────────────────────────────────────────────────────── */

async function initMap() {
  if (!window.google || !google.maps || !google.maps.importLibrary) {
    mapFailed('Google Maps failed to load. Check your API key in index.html.');
    return;
  }

  let Map, AdvancedMarkerElement;
  try {
    // Libraries load in parallel; geometry powers computeDistanceBetween.
    [{ Map }, { AdvancedMarkerElement }] = await Promise.all([
      google.maps.importLibrary('maps'),
      google.maps.importLibrary('marker'),
      google.maps.importLibrary('places'),
      google.maps.importLibrary('geometry'),
    ]);
  } catch (err) {
    console.error(err);
    mapFailed('Google Maps failed to load. Check the API key, its referrer restrictions, and that Maps JavaScript API + Places API (New) are enabled.');
    return;
  }

  state.AdvancedMarker = AdvancedMarkerElement;

  state.map = new Map($('#map'), {
    center: CONFIG.DEFAULT_CENTER,
    zoom: CONFIG.DEFAULT_ZOOM,
    mapId: CONFIG.MAP_ID,          // required for Advanced Markers
    disableDefaultUI: true,        // we supply our own floating controls
    gestureHandling: 'greedy',     // one-finger pan inside a full-screen map
    clickableIcons: true,          // lets users tap Google's own POIs
    keyboardShortcuts: false,
  });

  /* Map taps: a POI tap carries a placeId, anything else is a raw lat/lng
     which we reverse-geocode so users can still block unlisted spots. */
  state.map.addListener('click', (event) => {
    if (event.placeId) {
      event.stop(); // suppress Google's own info window
      selectByPlaceId(event.placeId);
    } else if (event.latLng) {
      selectByLatLng(event.latLng);
    }
  });

  renderMarkers();
  initAutocomplete();
  startWatchingLocation();
  centerOnMe({ silent: true });
}

function mapFailed(message) {
  $('#map').append(el('p', {
    class: 'empty',
    style: 'position:absolute;inset:0;display:grid;align-content:center;',
    text: message,
  }));
  toast('Map unavailable');
}


/* ─────────────────────────────────────────────────────────────────────────
   6. MARKERS
   ───────────────────────────────────────────────────────────────────────── */

/** Builds the DOM used as an Advanced Marker's content. */
function markerContent(className, glyph, title) {
  return el('div', { class: `pin ${className}`, title: title || '' }, glyph ? [glyph] : []);
}

/** Rebuild every blacklist marker from storage. */
function renderMarkers() {
  if (!state.map) return;

  const list = Store.all();
  const seen = new Set();

  for (const place of list) {
    seen.add(place.id);
    if (state.markers.has(place.id)) continue;

    const marker = new state.AdvancedMarker({
      map: state.map,
      position: { lat: place.lat, lng: place.lng },
      title: place.name,
      content: markerContent('pin--blocked', '💀', place.name),
      zIndex: 10,
    });
    marker.addListener('gmp-click', () => selectStored(place.id));
    // Older builds emit a plain 'click' instead of 'gmp-click'.
    marker.addListener('click', () => selectStored(place.id));

    state.markers.set(place.id, marker);
  }

  // Drop markers for entries that were forgiven.
  for (const [id, marker] of state.markers) {
    if (seen.has(id)) continue;
    marker.map = null;
    state.markers.delete(id);
  }

  updateBadge();
}

function updateBadge() {
  const count = Store.all().length;
  const badge = $('#list-badge');
  badge.textContent = String(count);
  badge.hidden = count === 0;
  $('#hint').hidden = count !== 0;
}

/** The white pin for a place that's selected but not blocked (yet). */
function showTempMarker(lat, lng) {
  clearTempMarker();
  if (!state.map) return;
  state.tempMarker = new state.AdvancedMarker({
    map: state.map,
    position: { lat, lng },
    content: markerContent('pin--search pin--selected', '📍'),
    zIndex: 20,
  });
}

function clearTempMarker() {
  if (state.tempMarker) {
    state.tempMarker.map = null;
    state.tempMarker = null;
  }
}

function renderMeMarker() {
  if (!state.map || !state.me) return;
  const position = { lat: state.me.lat, lng: state.me.lng };
  if (state.meMarker) {
    state.meMarker.position = position;
    return;
  }
  state.meMarker = new state.AdvancedMarker({
    map: state.map,
    position,
    content: markerContent('pin--me', '', 'You are here'),
    zIndex: 5,
  });
}

/** Pan/zoom to a coordinate, leaving room for the bottom sheet. */
function focusOn(lat, lng, zoom = CONFIG.FOCUS_ZOOM) {
  if (!state.map) return;
  state.map.panTo({ lat, lng });
  if (state.map.getZoom() < zoom) state.map.setZoom(zoom);
  // Nudge the target above the sheet so it isn't hidden behind it.
  requestAnimationFrame(() => state.map.panBy(0, Math.round(window.innerHeight * 0.16)));
}


/* ─────────────────────────────────────────────────────────────────────────
   7. PLACE SELECTION
   Every path normalises into: { id, name, address, lat, lng }
   ───────────────────────────────────────────────────────────────────────── */

/** Select something already on the blacklist (marker tap, list tap, notification). */
function selectStored(id) {
  const place = Store.get(id);
  if (!place) return;
  clearTempMarker();
  state.selected = { id: place.id, name: place.name, address: place.address, lat: place.lat, lng: place.lng };
  focusOn(place.lat, place.lng);
  openSheet();
}

/** Fetch details for a Google place id, then select it. */
async function selectByPlaceId(placeId) {
  if (Store.has(placeId)) { selectStored(placeId); return; }

  try {
    const { Place } = await google.maps.importLibrary('places');
    const place = new Place({ id: placeId });
    await place.fetchFields({ fields: ['id', 'displayName', 'formattedAddress', 'location'] });
    selectPlaceObject(place);
  } catch (err) {
    console.error('[NeverAgain] place details failed', err);
    toast('Could not load that place.');
  }
}

/** Normalise a Places API `Place` (new API) into our shape and open the sheet. */
function selectPlaceObject(place) {
  const location = place.location;
  if (!location) { toast('That place has no coordinates.'); return; }

  const lat = typeof location.lat === 'function' ? location.lat() : location.lat;
  const lng = typeof location.lng === 'function' ? location.lng() : location.lng;

  state.selected = {
    id: place.id,
    name: place.displayName || place.name || 'Unnamed place',
    address: place.formattedAddress || '',
    lat,
    lng,
  };

  if (Store.has(state.selected.id)) clearTempMarker();
  else showTempMarker(lat, lng);

  focusOn(lat, lng);
  openSheet();
}

/** Long-tail case: user tapped empty map. Reverse-geocode for a usable label. */
async function selectByLatLng(latLng) {
  const lat = latLng.lat();
  const lng = latLng.lng();

  // If they tapped near something they already blocked, open that instead.
  const near = nearestStored({ lat, lng }, 40);
  if (near) { selectStored(near.place.id); return; }

  state.selected = {
    id: `custom:${lat.toFixed(6)},${lng.toFixed(6)}`,
    name: 'Dropped pin',
    address: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
    lat,
    lng,
  };
  showTempMarker(lat, lng);
  openSheet();

  try {
    const { Geocoder } = await google.maps.importLibrary('geocoding');
    const { results } = await new Geocoder().geocode({ location: { lat, lng } });
    const best = results && results[0];
    if (best && state.selected && state.selected.lat === lat) {
      state.selected.name = (best.address_components?.[0]?.long_name) || best.formatted_address.split(',')[0];
      state.selected.address = best.formatted_address;
      if (!$('#view-form').hidden) $('#form-name').textContent = state.selected.name;
      renderDetails();
    }
  } catch (err) {
    console.warn('[NeverAgain] reverse geocode failed', err);
  }
}

/** Closest blacklisted place to a coordinate within `withinM`, or null. */
function nearestStored(coords, withinM = Infinity) {
  let best = null;
  for (const place of Store.all()) {
    const d = distanceBetween(coords, place);
    if (d <= withinM && (!best || d < best.distance)) best = { place, distance: d };
  }
  return best;
}


/* ── Places Autocomplete ─────────────────────────────────────────────────
   Uses PlaceAutocompleteElement (Places API New). The legacy
   google.maps.places.Autocomplete widget is deprecated for new API
   consumers, so it's only wired up as a fallback for older keys.
   ───────────────────────────────────────────────────────────────────────── */
async function initAutocomplete() {
  const host = $('#autocomplete-host');

  try {
    const { PlaceAutocompleteElement } = await google.maps.importLibrary('places');

    if (PlaceAutocompleteElement) {
      const widget = new PlaceAutocompleteElement();
      // Not all builds expose these; assigning is harmless when they don't.
      try { widget.placeholder = 'Search for a place'; } catch { /* ignore */ }
      host.append(widget);
      // The inner input renders asynchronously; patch its placeholder once there.
      setTimeout(() => {
        const input = widget.querySelector('input');
        if (input && !input.placeholder) input.placeholder = 'Search for a place';
      }, 400);

      const onSelect = async (event) => {
        const prediction = event.placePrediction || event.detail?.placePrediction;
        let place = event.place || event.detail?.place;
        if (!place && prediction) place = prediction.toPlace();
        if (!place) return;

        try {
          await place.fetchFields({ fields: ['id', 'displayName', 'formattedAddress', 'location'] });
          if (Store.has(place.id)) selectStored(place.id);
          else selectPlaceObject(place);
        } catch (err) {
          console.error('[NeverAgain] autocomplete details failed', err);
          toast('Could not load that place.');
        }
        blurSearch();
      };

      // Event name differs across API versions — listen for both.
      widget.addEventListener('gmp-select', onSelect);
      widget.addEventListener('gmp-placeselect', onSelect);
      return;
    }
  } catch (err) {
    console.warn('[NeverAgain] PlaceAutocompleteElement unavailable, falling back', err);
  }

  // ── Fallback: legacy Autocomplete on a plain input ──
  const input = el('input', {
    type: 'search',
    class: 'searchbar__input',
    placeholder: 'Search for a place',
    'aria-label': 'Search for a place',
  });
  host.append(input);

  try {
    const { Autocomplete } = await google.maps.importLibrary('places');
    if (!Autocomplete) return;
    const legacy = new Autocomplete(input, { fields: ['place_id', 'name', 'formatted_address', 'geometry'] });
    legacy.addListener('place_changed', () => {
      const place = legacy.getPlace();
      if (!place || !place.geometry) { toast('Pick a place from the list.'); return; }
      selectPlaceObject({
        id: place.place_id,
        displayName: place.name,
        formattedAddress: place.formatted_address,
        location: place.geometry.location,
      });
      blurSearch();
    });
  } catch (err) {
    console.warn('[NeverAgain] no autocomplete available', err);
  }
}

function blurSearch() {
  const active = document.activeElement;
  if (active && typeof active.blur === 'function') active.blur();
}


/* ─────────────────────────────────────────────────────────────────────────
   8. BOTTOM SHEET
   ───────────────────────────────────────────────────────────────────────── */

function openSheet() {
  renderDetails();
  showSheetView('details');
  $('#sheet').hidden = false;
  $('#sheet').setAttribute('aria-hidden', 'false');
  $('#sheet-scrim').hidden = false;
  $('#sheet').classList.remove('is-leaving');
  $('#sheet-scrim').classList.remove('is-leaving');
}

function closeSheet() {
  const sheet = $('#sheet');
  const scrim = $('#sheet-scrim');
  if (sheet.hidden) return;
  sheet.classList.add('is-leaving');
  scrim.classList.add('is-leaving');
  setTimeout(() => {
    sheet.hidden = true;
    scrim.hidden = true;
    sheet.setAttribute('aria-hidden', 'true');
  }, 230);
  clearTempMarker();
  state.selected = null;
  state.formPlace = null;
}

function showSheetView(which) {
  $('#view-details').hidden = which !== 'details';
  $('#view-form').hidden = which !== 'form';
  $('#sheet').scrollTop = 0;
}

/** Paint the details view from `state.selected` + storage. */
function renderDetails() {
  const selected = state.selected;
  if (!selected) return;

  $('#sheet-name').textContent = selected.name;
  $('#sheet-addr').textContent = selected.address || '';

  const stored = Store.get(selected.id);
  const blockedCard = $('#blocked-card');
  const blockedActions = $('#blocked-actions');
  const blockBtn = $('[data-action="block"]');

  if (stored) {
    blockedCard.hidden = false;
    blockedActions.hidden = false;
    blockBtn.hidden = true;

    const when = formatWhen(stored.createdAt);
    const distance = state.me ? ` · ${formatDistance(distanceBetween(state.me, stored))} away` : '';
    $('#blocked-when').textContent = `Blocked ${when}${distance}`;

    const tagList = $('#blocked-tags');
    tagList.replaceChildren(...stored.tags.map((t) => el('li', { text: TAG_LABEL[t] || t })));
    $('#blocked-note').textContent = stored.note || '';
  } else {
    blockedCard.hidden = true;
    blockedActions.hidden = true;
    blockBtn.hidden = false;
  }
}


/* ── The blocking form ───────────────────────────────────────────────────── */

function openForm(place, existing) {
  state.formPlace = place;
  state.formTags = new Set(existing ? existing.tags : []);
  $('#form-name').textContent = place.name;
  $('#note').value = existing ? existing.note : '';
  renderTagChips();
  showSheetView('form');
}

function renderTagChips() {
  const grid = $('#tags-grid');
  grid.replaceChildren(...TAGS.map((tag) => el('button', {
    type: 'button',
    class: 'chip',
    'data-tag': tag.id,
    'aria-pressed': state.formTags.has(tag.id) ? 'true' : 'false',
    text: tag.label,
    onclick(event) {
      const id = event.currentTarget.dataset.tag;
      if (state.formTags.has(id)) state.formTags.delete(id);
      else state.formTags.add(id);
      event.currentTarget.setAttribute('aria-pressed', state.formTags.has(id) ? 'true' : 'false');
      buzz();
    },
  })));
}

function submitForm(event) {
  event.preventDefault();
  const place = state.formPlace;
  if (!place) return;

  const note = $('#note').value.trim();
  const tags = [...state.formTags];

  if (!tags.length && !note) {
    toast('Pick a reason or leave a note.');
    return;
  }

  const saved = Store.save({
    id: place.id,
    name: place.name,
    address: place.address,
    lat: place.lat,
    lng: place.lng,
    tags,
    note,
    ...(Store.has(place.id) ? {} : { createdAt: new Date().toISOString() }),
  });

  clearTempMarker();
  renderMarkers();
  renderPanel();

  state.selected = { id: saved.id, name: saved.name, address: saved.address, lat: saved.lat, lng: saved.lng };
  renderDetails();
  showSheetView('details');
  buzz([14, 40, 14]);
  toast(`${saved.name} is blocked.`);

  // Re-run the proximity check: they might be standing there right now.
  if (state.me) checkProximity(state.me);
}

function forgive(id) {
  const place = Store.get(id);
  if (!place) return;
  Store.remove(id);
  state.inside.delete(id);
  renderMarkers();
  renderPanel();
  if (state.selected && state.selected.id === id) renderDetails();
  toast(`${place.name} forgiven.`);
}


/* ─────────────────────────────────────────────────────────────────────────
   9. BLACKLIST PANEL
   ───────────────────────────────────────────────────────────────────────── */

function openPanel() {
  renderPanel();
  $('#panel').hidden = false;
  $('#panel').setAttribute('aria-hidden', 'false');
  $('#panel-scrim').hidden = false;
  $('#panel').classList.remove('is-leaving');
  $('#panel-scrim').classList.remove('is-leaving');
}

function closePanel() {
  const panel = $('#panel');
  const scrim = $('#panel-scrim');
  if (panel.hidden) return;
  panel.classList.add('is-leaving');
  scrim.classList.add('is-leaving');
  setTimeout(() => {
    panel.hidden = true;
    scrim.hidden = true;
    panel.setAttribute('aria-hidden', 'true');
  }, 230);
}

function renderPanel() {
  const list = Store.all();
  const listNode = $('#places');

  $('#panel-count').textContent = list.length
    ? `${list.length} place${list.length === 1 ? '' : 's'}`
    : '';
  $('#panel-empty').hidden = list.length > 0;

  const sorted = [...list];
  if (state.sort === 'near' && state.me) {
    sorted.sort((a, b) => distanceBetween(state.me, a) - distanceBetween(state.me, b));
  } else {
    sorted.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  listNode.replaceChildren(...sorted.map(renderPlaceRow));
}

function renderPlaceRow(place) {
  const isOpen = state.expandedId === place.id;
  const distance = state.me ? formatDistance(distanceBetween(state.me, place)) : '';
  const meta = [distance, formatWhen(place.createdAt), place.address]
    .filter(Boolean)
    .join(' · ');

  const row = el('li', { class: `place${isOpen ? ' is-open' : ''}` }, [
    el('div', { class: 'place__top' }, [
      el('span', { class: 'blockmark', style: 'width:22px;height:22px;border-width:3px' }),
      el('button', {
        class: 'place__body',
        type: 'button',
        style: 'background:none;border:0;padding:0',
        'aria-expanded': isOpen ? 'true' : 'false',
        onclick() {
          state.expandedId = isOpen ? null : place.id;
          renderPanel();
        },
      }, [
        el('p', { class: 'place__name', text: place.name }),
        el('p', { class: 'place__meta', text: meta }),
      ]),
      el('span', { class: 'place__chev', 'aria-hidden': 'true', text: '▶' }),
    ]),
  ]);

  if (isOpen) {
    row.append(el('div', { class: 'place__detail' }, [
      el('ul', { class: 'tagrow' }, place.tags.map((t) => el('li', { text: TAG_LABEL[t] || t }))),
      place.note ? el('p', { class: 'place__note', text: place.note }) : null,
      el('div', { class: 'place__actions' }, [
        el('button', {
          class: 'btn btn--ghost', type: 'button', text: 'Show on map',
          onclick() { closePanel(); selectStored(place.id); },
        }),
        el('button', {
          class: 'btn btn--ghost', type: 'button', text: 'Edit',
          onclick() {
            closePanel();
            state.selected = { id: place.id, name: place.name, address: place.address, lat: place.lat, lng: place.lng };
            openSheet();
            openForm(state.selected, place);
          },
        }),
        el('button', {
          class: 'btn btn--ghost btn--warn', type: 'button', text: 'Forgive',
          onclick() { if (confirm(`Remove ${place.name} from your blacklist?`)) forgive(place.id); },
        }),
      ]),
    ]));
  }

  return row;
}

function exportJson() {
  const blob = new Blob([JSON.stringify(Store.all(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: `never-again-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}


/* ─────────────────────────────────────────────────────────────────────────
   10. GEOLOCATION + PROXIMITY ENGINE
   ───────────────────────────────────────────────────────────────────────── */

/** Great-circle metres between two {lat,lng}. Uses the Maps geometry library
    when available, with a Haversine fallback so the engine still works if the
    map itself failed to load. */
function distanceBetween(a, b) {
  const spherical = window.google?.maps?.geometry?.spherical;
  if (spherical) {
    return spherical.computeDistanceBetween(
      new google.maps.LatLng(a.lat, a.lng),
      new google.maps.LatLng(b.lat, b.lng),
    );
  }
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function startWatchingLocation() {
  if (!('geolocation' in navigator)) {
    setStatus('Location not supported on this device', 'off');
    return;
  }
  if (state.watchId !== null) return;

  setStatus('Finding you…');

  state.watchId = navigator.geolocation.watchPosition(
    (position) => {
      state.me = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
      };
      renderMeMarker();
      checkProximity(state.me);
      if (!$('#panel').hidden && state.sort === 'near') renderPanel();
    },
    (error) => {
      console.warn('[NeverAgain] geolocation error', error);
      if (error.code === error.PERMISSION_DENIED) {
        setStatus('Location off — warnings paused', 'off');
      } else {
        setStatus('Waiting for a location fix…', 'off');
      }
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 },
  );
}

function stopWatchingLocation() {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
}

/**
 * The core loop. For every blacklisted place, compare the user's distance
 * against the geofence and fire (at most) one notification per entry.
 *
 * Debounce strategy, three layers deep:
 *   1. `state.inside` flags a place as "already warned about"; it's only
 *      cleared once the user is past GEOFENCE_EXIT_M (hysteresis, so GPS
 *      jitter on the boundary can't re-trigger).
 *   2. A persisted cooldown stops a re-entry within NOTIFY_COOLDOWN_MS from
 *      warning again — and survives a page reload.
 *   3. Fixes with terrible accuracy are ignored entirely.
 */
function checkProximity(me) {
  if (!me || (Number.isFinite(me.accuracy) && me.accuracy > CONFIG.MAX_ACCURACY_M)) {
    setStatus('Location too imprecise to warn you', 'off');
    return;
  }

  const list = Store.all();
  const cooldowns = Store.read(KEYS.NOTIFIED, {});
  const now = Date.now();
  let closest = null;
  let cooldownsChanged = false;

  for (const place of list) {
    const distance = distanceBetween(me, place);
    if (!closest || distance < closest.distance) closest = { place, distance };

    const wasInside = state.inside.has(place.id);

    if (distance <= CONFIG.GEOFENCE_ENTER_M) {
      if (wasInside) continue; // layer 1: already warned for this visit

      state.inside.add(place.id);

      const last = cooldowns[place.id] || 0;
      if (now - last < CONFIG.NOTIFY_COOLDOWN_MS) continue; // layer 2

      cooldowns[place.id] = now;
      cooldownsChanged = true;
      warn(place, distance);
    } else if (wasInside && distance > CONFIG.GEOFENCE_EXIT_M) {
      // Left the fence (with hysteresis) — re-arm this place.
      state.inside.delete(place.id);
    }
  }

  if (cooldownsChanged) Store.write(KEYS.NOTIFIED, cooldowns);

  // Status pill: nearest blocked place, or a plain "watching" state.
  if (!list.length) {
    setStatus('Watching your location');
  } else if (state.inside.size) {
    setStatus(`🛑 You're at ${Store.get([...state.inside][0])?.name || 'a blocked place'}`, 'warning');
  } else if (closest && closest.distance < 1000) {
    setStatus(`Nearest blocked: ${closest.place.name} · ${formatDistance(closest.distance)}`);
  } else {
    setStatus(`Watching ${list.length} blocked place${list.length === 1 ? '' : 's'}`);
  }
}

function setStatus(text, tone = 'ok') {
  const pill = $('#statuspill');
  $('#statuspill-text').textContent = text;
  pill.hidden = false;
  pill.classList.toggle('is-warning', tone === 'warning');
  pill.classList.toggle('is-off', tone === 'off');
}

/** Recenter the map on the user. */
function centerOnMe({ silent = false } = {}) {
  if (state.me) {
    state.map?.panTo({ lat: state.me.lat, lng: state.me.lng });
    state.map?.setZoom(Math.max(state.map.getZoom(), CONFIG.FOCUS_ZOOM));
    return;
  }
  if (!('geolocation' in navigator)) return;
  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.me = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
      };
      renderMeMarker();
      state.map?.panTo({ lat: state.me.lat, lng: state.me.lng });
      state.map?.setZoom(CONFIG.FOCUS_ZOOM);
      checkProximity(state.me);
    },
    () => { if (!silent) toast('Could not get your location.'); },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
  );
}


/* ─────────────────────────────────────────────────────────────────────────
   11. NOTIFICATIONS
   ───────────────────────────────────────────────────────────────────────── */

function notificationBody(place) {
  const reasons = place.tags.map((t) => TAG_LABEL[t] || t).join(', ');
  const parts = [];
  if (reasons) parts.push(`Reason: ${reasons}`);
  if (place.note) parts.push(`"${place.note}"`);
  return parts.length
    ? `You blocked this place. ${parts.join(' — ')}`
    : 'You blocked this place. Walk away.';
}

/** Fire the proximity warning: notification + in-app fallback. */
async function warn(place, distance) {
  buzz([80, 60, 80, 60, 160]);

  const title = `🛑 Avoid ${place.name}!`;
  const body = notificationBody(place);

  const options = {
    body,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: `never-again:${place.id}`,   // replaces an older warning for the same place
    renotify: true,
    requireInteraction: true,
    vibrate: [100, 60, 100, 60, 200],
    data: { placeId: place.id, url: './' },
  };

  let shown = false;
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      // Service-worker notifications are the only kind Android Chrome allows,
      // and they survive the tab being backgrounded.
      const registration = state.swRegistration
        || (navigator.serviceWorker && await navigator.serviceWorker.ready.catch(() => null));
      if (registration) {
        await registration.showNotification(title, options);
        shown = true;
      } else {
        new Notification(title, options);
        shown = true;
      }
    } catch (err) {
      console.warn('[NeverAgain] notification failed', err);
    }
  }

  // In-app fallback / reinforcement when the app is in the foreground.
  if (!shown || document.visibilityState === 'visible') {
    toast(`🛑 Avoid ${place.name} — ${formatDistance(distance)} away`);
  }
}

async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    toast('This browser has no notification support.');
    return 'unsupported';
  }
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}


/* ─────────────────────────────────────────────────────────────────────────
   12. ONBOARDING & PERMISSIONS
   ───────────────────────────────────────────────────────────────────────── */

function markPerm(id, granted) {
  const node = $(`#perm-${id}`);
  if (!node) return;
  node.classList.toggle('is-granted', granted === true);
  node.classList.toggle('is-denied', granted === false);
  const button = $('.perm__btn', node);
  if (granted === true) button.textContent = 'Allowed';
  if (granted === false) button.textContent = 'Blocked';
}

/** Reflect already-decided permissions so returning users see the truth. */
async function syncPermissionUi() {
  if ('Notification' in window && Notification.permission !== 'default') {
    markPerm('notifications', Notification.permission === 'granted');
  }
  if (navigator.permissions?.query) {
    try {
      const status = await navigator.permissions.query({ name: 'geolocation' });
      if (status.state !== 'prompt') markPerm('location', status.state === 'granted');
    } catch { /* Safari may reject the query — ignore */ }
  }
}

function enterApp() {
  Store.write(KEYS.ONBOARDED, true);
  const splash = $('#splash');
  splash.classList.add('is-leaving');
  setTimeout(() => { splash.hidden = true; }, 250);
  $('#app').hidden = false;
  // The map must be created after its container is visible, or it renders 0×0.
  if (!state.map) initMap();
  else google.maps.event.trigger(state.map, 'resize');
}


/* ─────────────────────────────────────────────────────────────────────────
   13. EVENT WIRING, SERVICE WORKER, BOOT
   ───────────────────────────────────────────────────────────────────────── */

function wireEvents() {
  // Delegated clicks for every [data-action] button in the document.
  document.addEventListener('click', async (event) => {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;

    switch (trigger.dataset.action) {
      case 'grant-location': {
        if (!('geolocation' in navigator)) { toast('No geolocation on this device.'); return; }
        navigator.geolocation.getCurrentPosition(
          (position) => {
            state.me = {
              lat: position.coords.latitude,
              lng: position.coords.longitude,
              accuracy: position.coords.accuracy,
            };
            markPerm('location', true);
            renderMeMarker();
          },
          (error) => markPerm('location', error.code !== error.PERMISSION_DENIED ? null : false),
          { enableHighAccuracy: true, timeout: 15000 },
        );
        break;
      }

      case 'grant-notifications': {
        const result = await requestNotificationPermission();
        markPerm('notifications', result === 'granted');
        break;
      }

      case 'enter-app':
        enterApp();
        break;

      case 'locate':
        buzz();
        centerOnMe();
        break;

      case 'open-list':
        buzz();
        openPanel();
        break;

      case 'close-panel':
        closePanel();
        break;

      case 'close-sheet':
        closeSheet();
        break;

      case 'block':
        if (state.selected) openForm(state.selected, null);
        break;

      case 'edit':
        if (state.selected) openForm(state.selected, Store.get(state.selected.id));
        break;

      case 'forgive':
        if (state.selected && confirm(`Remove ${state.selected.name} from your blacklist?`)) {
          forgive(state.selected.id);
          closeSheet();
        }
        break;

      case 'cancel-form':
        if (state.selected && Store.has(state.selected.id)) showSheetView('details');
        else closeSheet();
        break;

      case 'export':
        exportJson();
        break;

      case 'clear-all':
        if (Store.all().length && confirm('Delete every blocked place? This cannot be undone.')) {
          Store.clear();
          state.inside.clear();
          renderMarkers();
          renderPanel();
          toast('Blacklist cleared.');
        }
        break;
    }
  });

  $('#view-form').addEventListener('submit', submitForm);
  $('#sheet-scrim').addEventListener('click', closeSheet);
  $('#panel-scrim').addEventListener('click', closePanel);

  // Panel sort toggle
  $$('.segmented__btn').forEach((button) => {
    button.addEventListener('click', () => {
      state.sort = button.dataset.sort;
      if (state.sort === 'near' && !state.me) toast('Waiting for your location…');
      $$('.segmented__btn').forEach((b) => b.classList.toggle('is-active', b === button));
      renderPanel();
    });
  });

  // Escape closes whatever is on top.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!$('#panel').hidden) closePanel();
    else if (!$('#sheet').hidden) closeSheet();
  });

  // Coming back to the foreground: re-arm the watch (mobile browsers often
  // suspend it) and refresh anything distance-dependent.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (state.watchId === null) startWatchingLocation();
    if (state.me) checkProximity(state.me);
    renderPanel();
  });

  // Keep multiple tabs of the app in sync.
  window.addEventListener('storage', (event) => {
    if (event.key !== KEYS.BLACKLIST) return;
    renderMarkers();
    renderPanel();
    if (state.selected) renderDetails();
  });

  window.addEventListener('pagehide', stopWatchingLocation);
}

/** Register the service worker and listen for notification taps. */
function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then((registration) => { state.swRegistration = registration; })
      .catch((err) => console.warn('[NeverAgain] SW registration failed', err));
  });

  // sw.js posts this when the user taps a warning notification.
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'open-place' && event.data.placeId) {
      openPlaceFromNotification(event.data.placeId);
    }
  });
}

/** Deep-link into a place's card (notification tap, or ?place=… on cold start). */
function openPlaceFromNotification(placeId) {
  if (!Store.has(placeId)) return;
  if (!$('#splash').hidden) enterApp();
  closePanel();
  const open = () => selectStored(placeId);
  if (state.map) open(); else setTimeout(open, 1200);
}

function boot() {
  wireEvents();
  renderTagChips();
  updateBadge();
  syncPermissionUi();
  initServiceWorker();

  // Returning users skip the splash entirely.
  if (Store.read(KEYS.ONBOARDED, false)) {
    $('#splash').hidden = true;
    $('#app').hidden = false;
    initMap();
  }

  const params = new URLSearchParams(location.search);

  // Cold start from a notification tap: ?place=<id>
  const requested = params.get('place');
  if (requested) openPlaceFromNotification(requested);

  // Cold start from the manifest shortcut: ?view=list
  if (params.get('view') === 'list' && Store.read(KEYS.ONBOARDED, false)) openPanel();
}

document.addEventListener('DOMContentLoaded', boot);
