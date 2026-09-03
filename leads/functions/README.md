# Calendar service

The small service behind the dashboard's **Find a time** tab. It is the only
place the GoHighLevel token exists.

**Deploying it is a paste job**, like the dashboard itself — see
[Setting it up without a terminal](#setting-it-up-without-a-terminal).

## Why the token can't just go in the dashboard

The dashboard is a block of HTML pasted into a GHL landing page. Everything in
it is readable by anyone who views source — it is a public web page. A GHL
Private Integration Token with `calendars/events.write` and `contacts.write`
can create contacts and appointments across the whole sub-account, so putting
it there would hand that to any visitor. GHL also sends no CORS headers, so a
browser could not call its API directly even if the token were harmless.

So the browser calls this, and this calls GHL. The token stays server-side, as
a secret the service can read and nobody else can. Every request has to carry a
Firebase ID token from someone signed into the dashboard, and that gets checked
*with Google* rather than merely decoded — a forged or expired one is refused
before GHL is touched.

## What you need from GHL

Four things. Only the first is a secret.

| What | Where to find it |
| ---- | ---------------- |
| **Private Integration Token** | Settings → Private Integrations → create one with scopes `calendars.readonly`, `calendars/events.write`, `contacts.readonly`, `contacts.write` |
| Location ID | Usually found for you by the setup page; otherwise the id in any settings-page URL |
| Calendar ID, per rep | The setup page lists these — no need to go looking |
| User ID, per rep | Also listed by the setup page. Decides who an appointment is assigned to |

### Where the token goes

Exactly two places, and neither is a file you edit.

| When | Where it goes | Command |
| ---- | ------------- | ------- |
| Cloudflare | A **Secret** variable — write-only once saved | dashboard → Settings → Variables |
| Firebase | Google Secret Manager | `firebase functions:secrets:set GHL_TOKEN` |

Never a Text variable, and never in a file.

It should **not** go in `config.js`, `.env`, the pasted HTML block, the repo, an
email, or a chat. If it ever lands in one of those, revoke it in GHL and issue a
new one — that takes a minute and costs nothing.

The distinction that matters: `.env` holds ids, and ids are not credentials.
Someone who learns your calendar id can do nothing with it. Someone who learns
the token can create contacts and appointments across your whole sub-account.

## Setting it up without a terminal

The dashboard is pasted into GHL by hand. This is deployed the same way —
paste one file into a browser editor, fill in a few boxes, done. No install,
no command line, no repo clone.

**1. Get the file.** Open
[`cloudflare/worker-paste.js`](cloudflare/worker-paste.js) on GitHub, click
**Raw**, then select all and copy.

**2. Make the Worker.** Sign in at [dash.cloudflare.com](https://dash.cloudflare.com)
→ **Workers & Pages** → **Create** → **Create Worker**. Name it `leads-cal`,
click **Deploy** (it deploys the placeholder — that's fine), then **Edit code**.
Select everything in the editor, paste over it, click **Deploy**.

**3. Fill in the boxes.** **Settings** → **Variables and Secrets** → **Add**:

| Name | Type | Value |
| ---- | ---- | ----- |
| `GHL_TOKEN` | Secret | Your GHL Private Integration Token |
| `FIREBASE_API_KEY` | Text | The `apiKey` from `config.js` — public, not a secret |
| `ALLOWED_ORIGIN` | Text | The page the dashboard sits on, e.g. `https://salesbysummit.com` |
| `SETUP_KEY` | Text | Any phrase you invent, e.g. `open-sesame-42` |
| `CALENDAR_IDS` | Text | Leave blank for now — step 4 gives you it |
| `GHL_LOCATION_ID` | Text | Leave blank — step 4 usually finds it |

Choose **Secret**, not Text, for `GHL_TOKEN`. Secrets are write-only
afterwards; Text values are readable in the dashboard.

**4. Open the setup page.** In a browser:

```
https://leads-cal.<your-subdomain>.workers.dev/setup?key=<your SETUP_KEY>
```

It lists your calendars and your team with their ids, and checks that the
free-slots call actually works against your account. Copy the `CALENDAR_IDS`
line it gives you back into the variables from step 3.

Everything it does is a read — nothing is created, changed or booked — and the
token is never rendered on it, not even inside an error GHL sends back. So the
page is safe to screenshot and send on.

**5. Switch the page off.** Once the ids are in, delete `SETUP_KEY`. The route
returns 404 without it.

**6. Point the dashboard at it.** The Worker's URL goes in `BOOKING.proxy` in
`config.js`, with each rep's `calendarId` and `userId` from step 4. Rebuild the
block and paste it into GHL.

Free tier covers this comfortably — 100,000 requests a day, no card.

## Why not Firebase Functions

`index.js` and `package.json` here still deploy to Firebase, and `handler.js`
is the same file either way. But Cloud Functions can only be deployed from a
command line, and it needs the Blaze plan. Cloudflare's browser editor needs
neither, which matters more than keeping everything in one console.

## Configuration

The same five names wherever it runs — Cloudflare variables, a Firebase `.env`,
or anything else.

| Name | Secret? | What it is |
| ---- | ------- | ---------- |
| `GHL_TOKEN` | **yes** | The Private Integration Token |
| `FIREBASE_API_KEY` | no | The public web key from `config.js`. Identifies the project when checking a caller's sign-in |
| `GHL_LOCATION_ID` | no | The GHL sub-account the calendars belong to |
| `CALENDAR_IDS` | no | Comma-separated allowlist of calendar ids |
| `ALLOWED_ORIGIN` | no | The page the dashboard is embedded on |
| `SETUP_KEY` | no | Switches the setup page on. Clear it when you are done |

`CALENDAR_IDS` is what stops this being a general-purpose way into the GHL
account for anyone holding a dashboard login. A calendar not on that list
cannot be read or booked through here. Keep it to the four.

`GHL_LOCATION_ID` is only needed to create a contact, so `/slots` runs without
it — the grid should not go blank over a variable it never touches.

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
whole grid while somebody is mid-call.

## A caveat worth knowing

The GHL endpoint paths and the `Version: 2021-04-15` header in `handler.js`
were written from documentation, not run against a live token — GHL's hosts
were unreachable from the machine this was built on. The first real call will
confirm them. If GHL has moved something the fix is in that one file, and the
dashboard needs no change at all.

The setup page is how you find out, in a browser, before wiring the dashboard
to it. (`check-ghl.mjs` does the same from a terminal, if you have one.)

Everything either side of those calls **is** tested, with GHL and Google
stubbed:

| Suite | Covers |
| ----- | ------ |
| `test-setup-page.mjs` | the built paste-file, driven as Cloudflare drives it: the key gate, the rendered ids, a rejected token reported once, and that the token never reaches the page |
| `test-proxy.mjs` | the auth gate, the calendar allowlist, end-time arithmetic, and one broken calendar not blanking the grid |
| `test-check-ghl.mjs` | the terminal script, across six GHL response shapes |
