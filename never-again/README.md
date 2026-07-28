# Never Again

A personal restaurant blacklist. Block the places that let you down, and get a
proximity warning before you walk back in.

Pure frontend — vanilla HTML/CSS/JS, no build step, no backend. Everything is
stored in `localStorage` on the device. Deploys as-is to GitHub Pages.

```
never-again/
├── index.html        app shell
├── style.css         mobile-first dark UI
├── app.js            all logic (map, blocking, geofence, panel)
├── sw.js             service worker: offline shell + notification taps
├── manifest.json     PWA manifest
└── icons/            192/512 + maskable PNGs
```

## Setup

The API key is already in `index.html` and the app is wired up. What follows is
the state it's in and what to change if you move it.

### Current key configuration

The key in `index.html` is restricted to the HTTP referrer
`https://kalashnandal.co.in/*`. Verified working against it:

| API | State |
| --- | --- |
| Maps JavaScript API | enabled ✅ |
| Places API (New) | enabled ✅ |
| Geocoding API | untested — see below |

Requests from `*.github.io`, `localhost`, and anywhere else are rejected with
`API_KEY_HTTP_REFERRER_BLOCKED`. That's deliberate and it's what makes it
acceptable to commit the key to a public repo.

**Geocoding** is only used for one path: tapping empty map to drop a pin, which
reverse-geocodes the coordinate into a street name. If the Geocoding API isn't
enabled on the project that call fails softly — the pin keeps the label
"Dropped pin" and its lat/lng, and everything else works. Enable **Geocoding
API** in the Cloud console if you want real names on dropped pins.

### Two things worth doing

1. **Set a billing quota cap.** Referrer restriction stops a browser on another
   origin, but `Referer` is just a request header and any non-browser client can
   forge it. A daily quota cap is what actually bounds your exposure.

2. **Add `http://localhost:*/*` as an allowed referrer** if you want to run the
   app locally — right now local testing gets a blocked-referrer error and a
   blank map.

### If you move the app to a different domain

Add that origin to the key's referrer list (Cloud console → Credentials → the
key → Application restrictions → Website restrictions). Nothing in the code
needs to change.

### Optional: your own Map ID

`CONFIG.MAP_ID` in `app.js` is `DEMO_MAP_ID`, which renders fine but is unstyled
and meant for development. Create your own (Cloud console → Maps → Map
management, type: JavaScript) for custom map styling. A Map ID is required
either way — it's what enables Advanced Markers, which is what draws the 💀
pins.

### HTTPS is required

Geolocation, notifications and service workers all need a secure context.
GitHub Pages gives you that; `localhost` also counts.

## How it works

**Blocking.** Tap a POI on the map, tap empty map (reverse-geocoded to a
dropped pin), or search via Places Autocomplete. A bottom sheet slides up with
the name and address, then *Block This Place* opens the form: quick-select
reason chips plus a free-text note. Saving writes
`{ id, name, address, lat, lng, tags, note, createdAt, updatedAt }` to
`localStorage` under `neverAgain.blacklist.v1` and swaps the location's pin for
a red skull marker.

**Proximity warnings.** `navigator.geolocation.watchPosition` feeds every fix
into `checkProximity()`, which measures the distance to each blacklisted place
with `google.maps.geometry.spherical.computeDistanceBetween`. Crossing inside
100 m fires a Web Notification titled `🛑 Avoid <name>!` whose body carries the
tags and the note. Tapping it opens the app straight to that place's card.

Anti-spam is three layers deep:

| Layer | Mechanism |
| --- | --- |
| Per-visit flag | `state.inside` marks a place as warned; only cleared past the exit radius |
| Hysteresis | Enter at 100 m, exit at 160 m, so GPS jitter on the boundary can't re-fire |
| Cooldown | A persisted 30-minute floor per place, surviving reloads |

Fixes with accuracy worse than 500 m are ignored rather than trusted.

Tune all of it in `CONFIG` at the top of `app.js`.

**Managing the list.** The 🚫 button opens a panel of every blocked place,
sortable by recency or by distance from where you are. Expand an entry to read
the note, edit it, show it on the map, or forgive it (which deletes it and
re-renders the markers). There's also JSON export and a clear-all.

## The background-tracking caveat

Mobile browsers throttle and eventually suspend `watchPosition` once the tab is
backgrounded — this is an OS/browser policy, not something the code can opt out
of. In practice warnings are reliable while the app is open or was recently
minimised, and unreliable after the phone has been locked for a while.

Web push can't fix this either: the geofence check needs the device's position,
and there's no server here to push from.

For genuine 24/7 tracking, wrap this same codebase with
[Capacitor](https://capacitorjs.com/) and swap `startWatchingLocation()` for a
native background-geolocation plugin. The rest of the app — storage, geofence
math, UI — carries over unchanged.

## Privacy

No backend, no analytics, no network calls except to Google Maps for tiles,
place details and geocoding. The blacklist never leaves the device; clearing
browser data for the site erases it, so use *Export JSON* if you want a backup.
