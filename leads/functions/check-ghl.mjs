#!/usr/bin/env node
/* ============================================================================
   check-ghl.mjs — run this once, before deploying anything.

   It does three jobs, in order:

     1. Proves the token works at all.
     2. LISTS your calendars and your team, with their ids — so you do not have
        to dig them out of GHL's URLs by hand. Copy them straight into
        config.js and .env.
     3. Asks for real free slots on a real calendar, which is the one thing
        nobody has been able to verify: the endpoint paths and API version in
        handler.js were written from documentation, never run.

   Everything it prints is safe to paste back into a chat. The token is read
   from the environment, never written to a file, and never echoed — not even
   partially.

   Usage, from leads/functions/:

     GHL_TOKEN='pit-...' GHL_LOCATION_ID='...' node check-ghl.mjs

   Nothing is created, changed or booked. Every request here is a read.
   ========================================================================== */

const GHL = "https://services.leadconnectorhq.com";
const VERSIONS = ["2021-04-15", "2021-07-28"];

const TOKEN = process.env.GHL_TOKEN || "";
const LOCATION = process.env.GHL_LOCATION_ID || "";

const c = {
  ok:   (s) => `\x1b[32m${s}\x1b[0m`,
  bad:  (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim:  (s) => `\x1b[2m${s}\x1b[0m`,
  b:    (s) => `\x1b[1m${s}\x1b[0m`,
};

if (!TOKEN) {
  console.error(c.bad("No GHL_TOKEN in the environment."));
  console.error("\nRun it like this, with your Private Integration Token:\n");
  console.error("  GHL_TOKEN='pit-...' GHL_LOCATION_ID='...' node check-ghl.mjs\n");
  console.error(c.dim("Use single quotes so the shell doesn't eat anything in the token."));
  process.exit(1);
}

/* Redact anything token-shaped before printing, belt and braces — a GHL error
   body could echo the credential back at us. */
const safe = (s) => String(s).split(TOKEN).join("«token»");

async function call(path, { query, version } = {}) {
  const url = new URL(GHL + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Version: version || VERSIONS[0],
      Accept: "application/json",
    },
  });

  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 400) }; }
  return { status: res.status, ok: res.ok, body, url: url.toString() };
}

/* Try each known API version before giving up — if the documented one is stale,
   this is what tells us so, and the fix is a one-line change in handler.js. */
async function callAnyVersion(path, query) {
  let last;
  for (const version of VERSIONS) {
    const r = await call(path, { query, version });
    if (r.ok) return { ...r, version };
    last = { ...r, version };
    // A version mismatch is a 4xx; a 5xx is GHL's problem, stop retrying.
    if (r.status >= 500) break;
  }
  return last;
}

const err = (r) => {
  const m = r.body?.message || r.body?.error || r.body?.raw || "";
  return safe(Array.isArray(m) ? m.join(", ") : m) || `HTTP ${r.status}`;
};

const line = () => console.log(c.dim("─".repeat(72)));

console.log();
console.log(c.b("Checking your GoHighLevel setup"));
console.log(c.dim("Nothing is created or booked. Read-only, every step."));
line();

/* ---------------------------------------------------------------------------
   1. Does the token work, and can we see the location?
--------------------------------------------------------------------------- */
let locationOk = false;

if (!LOCATION) {
  console.log(c.warn("• No GHL_LOCATION_ID given — skipping the location check."));
  console.log(c.dim("  It is the sub-account id, visible in the URL of any GHL settings page."));
} else {
  const r = await callAnyVersion(`/locations/${encodeURIComponent(LOCATION)}`);
  if (r.ok) {
    locationOk = true;
    const name = r.body?.location?.name || r.body?.name || "(unnamed)";
    console.log(`${c.ok("✓")} Token works. Sub-account: ${c.b(name)}`);
    console.log(c.dim(`  API version accepted: ${r.version}`));
  } else if (r.status === 401) {
    console.log(`${c.bad("✗")} The token was rejected (401).`);
    console.log(c.dim("  Check it was copied whole, and that the integration is still active."));
    process.exit(1);
  } else {
    console.log(`${c.bad("✗")} Could not read that location: ${err(r)}`);
    console.log(c.dim("  Either the location id is wrong, or the token belongs to a different sub-account."));
  }
}

/* ---------------------------------------------------------------------------
   2. The ids you need — listed, so nobody has to dig them out of URLs.
--------------------------------------------------------------------------- */
line();
console.log(c.b("Calendars"));

const cals = await callAnyVersion("/calendars/", { locationId: LOCATION });
const calList = cals.ok ? (cals.body?.calendars || cals.body?.data || []) : [];

if (!cals.ok) {
  console.log(`${c.bad("✗")} Could not list calendars: ${err(cals)}`);
  console.log(c.dim(`  ${cals.url}`));
} else if (!calList.length) {
  console.log(c.warn("• The call worked but returned no calendars."));
  console.log(c.dim("  Check the location id, and that the token has the calendars.readonly scope."));
} else {
  console.log(c.dim("Paste these into BOOKING.reps in config.js as calendarId:\n"));
  for (const cal of calList) {
    const id = cal.id || cal._id || "";
    console.log(`  ${c.b((cal.name || "(unnamed)").padEnd(34))} ${id}`);
  }
  console.log();
  console.log(c.dim("And into CALENDAR_IDS in .env, comma-separated:\n"));
  console.log("  CALENDAR_IDS=" + calList.map((x) => x.id || x._id).filter(Boolean).join(","));
}

line();
console.log(c.b("Team"));

const users = await callAnyVersion("/users/", { locationId: LOCATION });
const userList = users.ok ? (users.body?.users || users.body?.data || []) : [];

if (!users.ok) {
  console.log(`${c.warn("•")} Could not list users: ${err(users)}`);
  console.log(c.dim("  Not fatal — userId only decides who the appointment is assigned to."));
} else if (!userList.length) {
  console.log(c.warn("• No users returned."));
} else {
  console.log(c.dim("Paste these into BOOKING.reps in config.js as userId:\n"));
  for (const u of userList) {
    const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.name || u.email || "(unnamed)";
    console.log(`  ${c.b(name.padEnd(34))} ${u.id || u._id || ""}`);
  }
}

/* ---------------------------------------------------------------------------
   3. The unverified part: do free slots actually come back?
--------------------------------------------------------------------------- */
line();
console.log(c.b("Free slots"));

const target = calList[0];
if (!target) {
  console.log(c.warn("• No calendar to try — skipping."));
} else {
  const id = target.id || target._id;
  const day = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  const startDate = Date.parse(`${day}T00:00:00Z`) - 24 * 3600e3;
  const endDate = Date.parse(`${day}T00:00:00Z`) + 48 * 3600e3;

  const slots = await callAnyVersion(`/calendars/${encodeURIComponent(id)}/free-slots`, {
    startDate, endDate, timezone: "America/New_York",
  });

  if (!slots.ok) {
    console.log(`${c.bad("✗")} free-slots failed: ${err(slots)}`);
    console.log(c.dim(`  ${slots.url}`));
    console.log(c.dim("  This is the call the whole feature rests on. Paste this output back"));
    console.log(c.dim("  and the fix goes into handler.js — the dashboard needs no change."));
  } else {
    const forDay = slots.body?.[day]?.slots;
    const keys = Object.keys(slots.body || {}).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k));

    if (Array.isArray(forDay) && forDay.length) {
      console.log(`${c.ok("✓")} ${forDay.length} free slots on ${day} for ${c.b(target.name || id)}`);
      console.log(c.dim(`  first: ${forDay[0]}`));
      console.log(c.dim(`  API version accepted: ${slots.version}`));
      console.log();
      console.log(c.ok("  The shape matches what handler.js expects. Nothing to change."));
    } else if (keys.length) {
      console.log(`${c.warn("•")} Slots came back, but not under ${day}.`);
      console.log(c.dim(`  Dates present: ${keys.join(", ")}`));
      console.log(c.dim("  Probably just a quiet day. Try a weekday, or paste this back."));
    } else {
      console.log(`${c.warn("•")} The call worked but the shape is not what handler.js reads.`);
      console.log(c.dim("  Response keys: " + Object.keys(slots.body || {}).join(", ")));
      console.log(c.dim("  Paste this back — it is a small change in handler.js."));
    }
  }
}

line();
console.log(c.dim("Done. Nothing was created, changed or booked."));
console.log();
