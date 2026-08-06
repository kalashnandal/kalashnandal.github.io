# LinkedIn Leads Dashboard

Replaces the two spreadsheets and the WhatsApp handover with one tracked
system: the LinkedIn team logs a lead, it is visibly handed to the US sales
partner (or delivered to a client), and every comment, stage change and export
is recorded. Built for the Tuesday/Thursday review calls — the **Review** tab
is the agenda.

Static page, no build step, no server. Firebase Auth for logins, Firestore for
data. Deploys with the rest of the site to GitHub Pages.

```
leads/
├── index.html              app shell
├── style.css               design system — slate + indigo, stage colours in config.js
├── config.js               ← the file you edit: Firebase keys, fields, stages
├── store.js                all database access (Firebase + demo fallback)
├── app.js                  UI and behaviour
├── xlsx.js                 dependency-free Excel writer
├── firestore.rules         access control — deploy this, it is the real boundary
└── firestore.indexes.json  composite indexes the queries need
```

---

## Try it before setting anything up

Open `leads/` in a browser. With no Firebase keys in `config.js` it runs in
**demo mode**: the full UI, sample leads, stored in that browser only. Good for
walking the team through it. Nothing is shared and nothing leaves the machine.

To reset the demo data, clear the site's localStorage.

---

## Going live — one-time setup

### 1. Create the Firebase project

1. <https://console.firebase.google.com> → **Add project**.
2. **Build → Authentication → Get started → Email/Password → Enable.**
3. **Build → Firestore Database → Create database → Production mode.**
   Pick a region close to the team.

### 2. Paste the config

**Project settings → Your apps → Web app (`</>`)** → register the app → copy
the `firebaseConfig` object into the top of `config.js`.

These values are not secrets — a web Firebase config is public by design, and
committing it is expected. Access is enforced by `firestore.rules`, not by
hiding the keys.

### 3. Restrict the API key (do not skip)

The config is public, so lock the key to your own domains:
**Google Cloud console → APIs & Services → Credentials →** the *Browser key
(auto created by Firebase)* → **Website restrictions** → add:

```
https://kalashnandal.co.in/*
https://kalashnandal.github.io/*
```

Without this, anyone who copies the key can point their own page at your
project and hammer it with sign-in attempts.

### 4. Deploy the rules and indexes

The rules are what actually stop a sales user reading client leads. Until they
are deployed, the default production rules block everything and the dashboard
will show empty tables.

```bash
npm install -g firebase-tools
firebase login
cd leads
firebase init firestore     # point it at firestore.rules and firestore.indexes.json
firebase deploy --only firestore:rules,firestore:indexes
```

Index builds take a few minutes. Until they finish, some views log a
"query requires an index" error in the browser console.

### 5. Add the first admin

1. **Authentication → Users → Add user** — email + a temporary password.
2. Copy the generated **User UID**.
3. **Firestore → Start collection → `users`** → document ID = that UID:

| Field    | Type   | Value                |
| -------- | ------ | -------------------- |
| `name`   | string | `Kalash Nandal`      |
| `email`  | string | their email          |
| `role`   | string | `admin`              |
| `active` | bool   | `true`               |

Sign in. Everything else can be done from the **Admin** tab.

### 6. Invite everyone else

From here on, use the dashboard. **Admin → Invite someone**: enter their name,
their work email, and the role you want them to have. They get an email link,
sign in with one click, pick a password from *Forgot your password*, and land
with exactly the role you chose.

This needs one switch flipped first:
**Authentication → Sign-in method → Email link (passwordless sign-in) → Enable.**
Also check your domains are listed under **Authentication → Settings →
Authorised domains**, or the link will refuse to send.

Roles:

| Role     | Sees                          | Can do                                                        |
| -------- | ----------------------------- | ------------------------------------------------------------- |
| `admin`  | everything                    | everything, plus manage clients, invite people, see all exports |
| `ops`    | everything                    | add and edit leads, comment, export — the LinkedIn team        |
| `sales`  | Summit Sales leads only       | move stages, set sales owner / GHL link / deal value, comment  |
| `client` | only their own client's leads | read and comment only                                          |

Pick `client` and the form asks which client accounts they may see.

Pending invites are listed under the form, where you can resend or revoke them.
A revoked invite's link stops working immediately.

**The role is decided by you, never by them.** The invite record carries it, and
`firestore.rules` copies it across verbatim when they first sign in — the rule
refuses any profile whose role doesn't match the invite. Nobody can sign
themselves up as an admin, and someone with no invite gets nothing.

---

## How the team uses it

**LinkedIn team** — add each lead as it comes in, on the *Summit Sales* or
*Clients* tab. Fill in what you have; only name, company and LinkedIn URL are
required. When you hand it over, move the stage to **Shared** — that stamps the
handover date, which is what makes "when did we give you this?" answerable.

**Summit Sales** — work the deal in GHL as usual, then keep this in sync:
move the stage, paste the GHL link, add a comment when something happens. This
is the internal record, not a second CRM.

**On the Tuesday/Thursday call** — open **Review**. It answers, in order:

- how many leads did the team create since the last call
- what is sitting in each stage
- **which open leads have had no activity for 7+ days** — the "needs attention"
  list is the dropped-lead problem, made visible
- how many each team member created
- how the client accounts are doing

Change the 7-day threshold with `STALE_DAYS` in `config.js`, and the call days
with `REVIEW_DAYS` (`0` = Sunday, so `[2,4]` is Tuesday and Thursday).

---

## Copying and exporting

There is deliberately no copy button, and copy / cut / right-click are
suppressed across the data views. The only sanctioned way data leaves the
dashboard is **Export to Excel**, and every export is written to history
*before* the file is generated — who, their email, when, the filters they had
applied, the row count, and the exact lead IDs. The spreadsheet carries the
same record on its own *Export Info* tab, so it stays attributable after it is
forwarded.

Users see their own exports; admins see everyone's. Export records cannot be
edited or deleted by anyone through the app — an export log you can edit is not
a log.

**Be straight with the team about what this is.** Blocking copy is a speed bump
that makes the tracked export the path of least resistance. It is not a
security control: anyone can retype what is on screen, screenshot it, or read
the page source. It changes the default, not what is possible.

---

## Changing the fields

`config.js` is the single source of truth. Add an entry to `LEAD_FIELDS` and it
appears in the add/edit form, the detail view and the Excel export
automatically:

```js
{ key: "timezone", label: "Time Zone", type: "text", group: "Person", width: 14 }
```

- `type` — `text` `email` `tel` `url` `date` `number` `textarea` `select`
  (a `select` also needs `options: [...]`)
- `group` — which fieldset it sits in (`FIELD_GROUPS`)
- `table: true` — also show it as a table column
- `required: true` — enforced on save
- `width` — Excel column width

Pipeline stages live in `STAGES` in the same file. If you add a stage, also add
it to `salesEditable()` considerations in `firestore.rules` only if it changes
who may set it — otherwise nothing else needs touching.

---

## Notes and limits

- **Deleting a lead** is admin-only and removes the lead row, but its activity
  entries stay in the audit trail by design. Prefer marking a lead **Lost**
  with a reason.
- **`clientAccess` is capped at 30 clients per user** — Firestore's `in` query
  takes at most 30 values. Well beyond the current n, but it is a real ceiling.
- **The activity feed loads the 120 most recent entries.** Per-lead history is
  complete; only the global *Activity* tab is capped.
- **Queries are scoped by role in `store.js` to mirror `firestore.rules`.**
  Firestore validates a query against its *potential* result set, so a rule
  like `stream == 'sales_partner'` needs a matching `where` clause or the whole
  query is rejected. If you change one, change the other — and add the matching
  composite index.
- **Excel export is written by `xlsx.js`, not a library.** No CDN at click
  time, so it keeps working on restricted office networks and offline.
- **Free Spark plan is fine** at this volume; Firestore's free tier covers
  50k reads/day.
