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

1. **Get a Google Maps API key** — <https://console.cloud.google.com/google/maps-apis>
   Enable these two APIs on the project:
   - **Maps JavaScript API**
   - **Places API (New)**
   The app also uses the Geocoding service exposed through the Maps JS SDK for
   reverse-geocoding dropped pins; enable **Geocoding API** if you want that path.

2. **Paste the key** into `index.html`, replacing `YOUR_GOOGLE_MAPS_API_KEY` in
   the loader `<script>`.

3. **Restrict the key** (Cloud console → Credentials → your key):
   - Application restriction: *HTTP referrers*, e.g. `https://yourname.github.io/*`
   - API restriction: only the APIs listed above.
   The key ships in client-side JS and is publicly visible — referrer
   restriction is what keeps it from being used elsewhere. Set a billing quota
   cap too.

4. *(Optional)* **Create a Map ID** (Cloud console → Maps → Map management,
   type: JavaScript) and set `CONFIG.MAP_ID` in `app.js`. The default
   `DEMO_MAP_ID` renders fine but is unstyled and meant for development. A Map
   ID is required for Advanced Markers, which is what draws the 💀 pins.

5. **Serve over HTTPS.** Geolocation, notifications and service workers all
   require a secure context. GitHub Pages gives you that; `localhost` also
   counts for local testing.

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
