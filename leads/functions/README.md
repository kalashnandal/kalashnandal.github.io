# Calendar service

The Cloud Function behind the dashboard's **Find a time** tab. It is the only
place the GoHighLevel token exists.

## Why the token can't just go in the dashboard

The dashboard is a block of HTML pasted into a GHL landing page. Everything in
it is readable by anyone who views source — it is a public web page. A GHL
Private Integration Token with `calendars/events.write` and `contacts.write`
can create contacts and appointments across the whole sub-account, so putting
it there would hand that to any visitor. GHL also sends no CORS headers, so a
browser could not call its API directly even if the token were harmless.

So the browser calls this, and this calls GHL. The token stays in Google's
Secret Manager. Every request has to carry a Firebase ID token from someone
signed into the dashboard, and that gets checked *with Google* rather than
merely decoded — a forged or expired one is refused before GHL is touched.

## What you need from GHL

Four things. Only the first is a secret.

| What | Where to find it |
| ---- | ---------------- |
| **Private Integration Token** | Settings → Private Integrations → create one with scopes `calendars.readonly`, `calendars/events.write`, `contacts.readonly`, `contacts.write` |
| Location ID | The sub-account id, in the URL of any settings page |
| Calendar ID, per rep | Calendars → open the calendar → the id in the URL |
| User ID, per rep | Settings → Team → open the person → the id in the URL. This is who the appointment gets assigned to |

### Where the token goes

Exactly two places, and neither is a file you edit.

| When | Where it goes | Command |
| ---- | ------------- | ------- |
| Checking your setup | Nowhere. Typed at a prompt, held in memory, gone when the script exits | `node check-ghl.mjs` |
| Running the function | Google Secret Manager, encrypted, readable only by this function | `firebase functions:secrets:set GHL_TOKEN` |

Both prompt for it, so it never reaches your shell history.

It should **not** go in `config.js`, `.env`, the pasted HTML block, the repo, an
email, or a chat. If it ever lands in one of those, revoke it in GHL and issue a
new one — that takes a minute and costs nothing.

The distinction that matters: `.env` holds ids, and ids are not credentials.
Someone who learns your calendar id can do nothing with it. Someone who learns
the token can create contacts and appointments across your whole sub-account.

## Check it before you deploy anything

`check-ghl.mjs` does the tedious part for you. It proves the token works,
**lists your calendars and your team with their ids** so you never have to dig
them out of GHL's URLs, and then makes the one call nobody has been able to
verify — real free slots on a real calendar.

```bash
cd leads/functions
GHL_LOCATION_ID='...' node check-ghl.mjs
```

It prompts for the token and hides what you paste. Putting it on the command
line instead would write it into your shell history, where it would sit in
plain text long after you had forgotten about it.

Every request it makes is a read: nothing is created, changed or booked. The
token is never written to a file and never echoed back — not partially, and not
even if GHL quotes it inside an error. So the whole output is safe to paste into
a chat if something looks wrong.

It tries each known API version in turn, so a stale version header shows up as
a diagnosis rather than a mystery.

## Deploying

Cloud Functions needs the **Blaze** plan — a card on file. At four calendars
and a handful of bookings a day the bill rounds to nothing, but the upgrade is
a real step: Firebase console → ⚙ → Usage and billing → Modify plan.

```bash
cd leads/functions
cp .env.example .env          # then fill it in — none of it is secret
npm install

cd ../..
firebase functions:secrets:set GHL_TOKEN     # paste the PIT at the prompt
firebase deploy --only functions:cal
```

Deploy prints a URL like

```
https://us-central1-leads-dashboard-9d76f.cloudfunctions.net/cal
```

Put that in `BOOKING.proxy` in `../config.js`, fill in each rep's `calendarId`
and `userId` in the same block, then rebuild the pasteable file:

```bash
node build-ghl.mjs
```

Paste the new `linkedin-leads-ghl.html` into the GHL block. The **Find a time**
tab appears as soon as `BOOKING.proxy` is set; until then it stays hidden
rather than offering a button that cannot work.

## Configuration

`.env` (gitignored, not secret):

| Name | What it is |
| ---- | ---------- |
| `FIREBASE_API_KEY` | Same public web key as in `config.js`. Identifies the project when checking a caller's sign-in |
| `GHL_LOCATION_ID` | The GHL sub-account the calendars belong to |
| `CALENDAR_IDS` | Comma-separated allowlist of calendar ids |
| `ALLOWED_ORIGIN` | The page the dashboard is embedded on |

Secret Manager:

| Name | What it is |
| ---- | ---------- |
| `GHL_TOKEN` | The Private Integration Token. Never in a file |

`CALENDAR_IDS` is what stops this being a general-purpose way into the GHL
account for anyone holding a dashboard login. A calendar not on that list
cannot be read or booked through here. Keep it to the four.

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

## Running it without Blaze

`cloudflare/` holds a Cloudflare Workers wrapper around the same `handler.js`.
Free tier, no card, no change to the Firebase plan. Useful if the billing
upgrade is a blocker; the dashboard cannot tell the difference, and moving
between the two later is a four-line change.

```bash
cd leads/functions/cloudflare
npx wrangler deploy
npx wrangler secret put GHL_TOKEN
```

## A caveat worth knowing

The GHL endpoint paths and the `Version: 2021-04-15` header in `handler.js`
were written from documentation, not run against a live token — GHL's hosts
were unreachable from the machine this was built on. The first real call will
confirm them. If GHL has moved something the fix is in that one file, and the
dashboard needs no change at all.

`check-ghl.mjs` is how you find out, in one command, without deploying first.

Everything either side of those calls **is** tested: run `test-proxy.mjs`,
which drives the handler with GHL and Google stubbed and checks the auth gate,
the calendar allowlist, that the token never reaches the browser, the end-time
arithmetic, and that one broken calendar doesn't blank the grid.
