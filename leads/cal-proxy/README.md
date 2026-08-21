# Calendar service

The small server that stands between the dashboard and GoHighLevel, so that
**Find a time** can show all four reps' availability at once and book on the
right calendar.

## Why it has to exist

The dashboard is a block of HTML pasted into a GHL page. Everything in it is
readable by anyone who views source. GHL's API needs a Private Integration
Token, and a token with `calendars/events.write` and `contacts.write` can
create contacts and appointments across the whole sub-account — so it cannot
go in the page. GHL also sends no CORS headers, so a browser could not call it
directly even if the token were harmless.

So the browser calls this, and this calls GHL. The token stays here. Every
request has to carry a Firebase ID token from someone signed into the
dashboard, and that token is checked with Google rather than just decoded.

## What you need from GHL

1. **Private Integration Token** — Settings → Private Integrations → create
   one with scopes `calendars.readonly`, `calendars/events.write`,
   `contacts.readonly`, `contacts.write`.
2. **Location ID** — the sub-account id, in the URL of any settings page.
3. **Calendar ID for each rep** — Calendars → open the calendar → the id in
   the URL.
4. **User ID for each rep** — Settings → Team → open the person → the id in
   the URL. This is who the appointment gets assigned to.

## Deploying it — Cloudflare Workers

Free tier, no card, no change to the Firebase plan.

```bash
cd leads/cal-proxy
npx wrangler login
# fill in the [vars] block in wrangler.toml first
npx wrangler deploy
npx wrangler secret put GHL_TOKEN      # paste the Private Integration Token
```

Wrangler prints a `https://leads-cal.<subdomain>.workers.dev` URL. Put it in
`BOOKING.proxy` in `../config.js`, fill in each rep's `calendarId` and
`userId`, then rebuild the block with `node build-ghl.mjs`.

## Deploying it — Firebase Functions

Keeps everything in one project, but needs the **Blaze** plan (a card on file;
the actual cost at this volume rounds to nothing).

```bash
firebase deploy --only functions:cal
firebase functions:secrets:set GHL_TOKEN
```

Then set `GHL_LOCATION_ID`, `FIREBASE_API_KEY`, `CALENDAR_IDS` and
`ALLOWED_ORIGIN` as function environment variables, and use the function's URL
as `BOOKING.proxy`.

Either way `handler.js` is the same file — only the four-line wrapper differs,
so moving from one to the other later costs nothing.

## Configuration

| Name                | Secret? | What it is                                              |
| ------------------- | ------- | -------------------------------------------------------- |
| `GHL_TOKEN`         | **yes** | GHL Private Integration Token. Never put this in config.js |
| `GHL_LOCATION_ID`   | no      | The GHL sub-account the calendars belong to                |
| `FIREBASE_API_KEY`  | no      | Same public web key as in config.js — identifies the project |
| `CALENDAR_IDS`      | no      | Comma-separated allowlist of calendar ids                  |
| `ALLOWED_ORIGIN`    | no      | The page the dashboard is embedded on                      |

`CALENDAR_IDS` is the thing that stops this being a general-purpose way into
the GHL account. A calendar not on that list cannot be read or booked through
here, regardless of who is signed in. Keep it tight.

## The two endpoints

Both POST, both requiring `Authorization: Bearer <firebase id token>`.

```
POST /slots
  { "date": "2026-08-27", "timezone": "America/New_York",
    "calendarIds": ["cal_a", "cal_b"] }
→ { "slots": { "cal_a": [{ "t": "12:00", "iso": "2026-08-27T12:00:00-04:00" }] } }

POST /book
  { "calendarId": "cal_a", "userId": "usr_1",
    "startTime": "2026-08-27T12:00:00-04:00", "minutes": 30,
    "timezone": "America/New_York", "title": "Discovery call", "notes": "",
    "contact": { "firstName": "Dana", "lastName": "Reyes",
                 "email": "dana@example.com", "phone": "+15551234567" } }
→ { "ok": true, "contactId": "...", "appointmentId": "..." }
```

`t` is the wall-clock time to show the caller; `iso` is the exact instant to
book. Splitting them here is what keeps timezone arithmetic out of the browser.

If one rep's calendar errors, that rep comes back with an empty list and the
reason under `problems` — a single misconfigured calendar should not blank the
whole grid while someone is on a call.

## A caveat worth knowing

The GHL endpoints and the `Version: 2021-04-15` header in `handler.js` were
written from documentation, not verified against a live token — GHL's hosts
were unreachable from the machine this was built on. The first real call will
confirm them. If GHL has moved something, the fix lands in this one file and
the dashboard needs no change at all.
