/* ============================================================================
   Calendar service for the LinkedIn Leads dashboard.

   PASTE THIS WHOLE FILE into the Cloudflare Workers editor, then set these
   under Settings → Variables:

     GHL_TOKEN         secret   your GHL Private Integration Token
     GHL_LOCATION_ID   text     the GHL sub-account id (optional — /setup finds it)
     CALENDAR_IDS      text     comma-separated ids of the calendars to allow
     FIREBASE_API_KEY  text     the public web key from the dashboard's config.js
     ALLOWED_ORIGIN    text     the page the dashboard is embedded on
     SETUP_KEY         text     any phrase you choose — switches the setup page on

   Then open  https://<your-worker>.workers.dev/setup?key=<SETUP_KEY>  in a
   browser. It lists your calendars and team with their ids, and checks that
   the free-slots call works. Clear SETUP_KEY when you are done to switch it
   off again.

   GENERATED FILE — do not edit here. Edit handler.js / setup-page.js and run
   node build-worker.mjs.
   ========================================================================== */

/* ===== setup-page.js ============================================= */
/* ============================================================================
   setup-page.js — the browser-visitable replacement for running a script.

   The dashboard gets pasted into a GHL page by someone who does not open a
   terminal, and there is no reason the setup step should be different. So
   instead of a Node script that lists your calendars, the service itself
   serves a page that does it: deploy, open the URL, read the ids off the
   screen, copy them out.

   It is behind SETUP_KEY. Without one the route is off entirely, because a
   page that lists every calendar in a sub-account is not something to leave
   open on a public URL.

   Every call it makes is a read. Nothing is created, changed or booked.
   ========================================================================== */

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const page = (body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Calendar service — setup</title>
<style>
  :root{ --ink:#0e1116; --ink-2:#39424e; --ink-3:#68717e; --line:#e4e7ec; --line-3:#f6f8fa;
         --bg:#f7f8fa; --card:#fff; --accent:#3d52d5; --good:#136c3e; --bad:#a3241b; --warn:#8f5108; }
  *{box-sizing:border-box}
  body{margin:0;padding:28px 20px;background:var(--bg);color:var(--ink);
       font:15px/1.6 'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
  .wrap{max-width:860px;margin:0 auto}
  h1{font-size:22px;margin:0 0 4px}
  .sub{color:var(--ink-3);font-size:13.5px;margin:0 0 24px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:8px;margin-bottom:16px;overflow:hidden}
  .card h2{font-size:13.5px;margin:0;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--line-3)}
  .card .body{padding:16px}
  table{width:100%;border-collapse:collapse;font-size:14px}
  td{padding:7px 0;border-bottom:1px solid var(--line-3);vertical-align:top}
  tr:last-child td{border-bottom:0}
  td.n{font-weight:600;padding-right:16px;white-space:nowrap}
  code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--line-3);
       border:1px solid var(--line);border-radius:4px;padding:2px 6px;word-break:break-all}
  .ok{color:var(--good)} .bad{color:var(--bad)} .warn{color:var(--warn)}
  .muted{color:var(--ink-3);font-size:13px}
  .copy{background:var(--line-3);border:1px solid var(--line);border-radius:6px;padding:12px;
        font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-all;margin-top:10px}
  .note{border-left:3px solid var(--accent);padding-left:12px;margin-top:14px;font-size:13.5px;color:var(--ink-2)}
</style></head>
<body><div class="wrap">
  <h1>Calendar service — setup</h1>
  <p class="sub">Read-only. Nothing here creates, changes or books anything.</p>
  ${body}
</div></body></html>`;

/* --------------------------------------------------------------------------
   The page itself. `api` is a bound caller supplied by the handler so this
   file never touches the token.
-------------------------------------------------------------------------- */
async function setupPage(env, api) {
  const out = [];
  let rejected = null;   // the first 401 seen, whichever call hit it

  /* A dead token fails every call, so watch for it once here rather than
     letting four sections each report their own downstream symptom. */
  const call = async (path, query) => {
    const r = await api(path, query);
    if (!r.ok && r.status === 401 && !rejected) rejected = r;
    return r;
  };

  /* ---- 1. token + location ---- */
  let location = env.GHL_LOCATION_ID || "";
  let locName = "";

  if (!location) {
    for (const path of ["/locations/search", "/locations/"]) {
      const r = await call(path, { limit: 20 });
      const found = r.ok ? (r.body?.locations || r.body?.data || []) : [];
      if (!found.length) continue;
      if (found.length === 1) {
        location = found[0].id || found[0]._id || "";
        locName = found[0].name || "";
      } else {
        out.push(`<div class="card"><h2>Which sub-account?</h2><div class="body">
          <p class="warn">This token can see ${found.length}. Set <code>GHL_LOCATION_ID</code> to the right one and reload.</p>
          <table>${found.map((l) => `<tr><td class="n">${esc(l.name || "(unnamed)")}</td><td><code>${esc(l.id || l._id || "")}</code></td></tr>`).join("")}</table>
        </div></div>`);
      }
      break;
    }
  }

  const loc = location ? await call(`/locations/${encodeURIComponent(location)}`) : null;
  if (loc?.ok) locName = loc.body?.location?.name || loc.body?.name || locName;

  out.push(`<div class="card"><h2>Connection</h2><div class="body">
    ${loc?.ok
      ? `<p class="ok">Token works. Sub-account: <b>${esc(locName || location)}</b></p>
         <p class="muted">API version accepted: <code>${esc(loc.version || "")}</code></p>`
      : location
        ? `<p class="bad">Could not read that sub-account: ${esc(loc?.error || "unknown error")}</p>`
        : `<p class="warn">No sub-account id yet. Set <code>GHL_LOCATION_ID</code> and reload.</p>`}
  </div></div>`);

  /* Nothing below can succeed on a rejected token, so stop here and say the
     one thing that actually needs fixing. */
  if (rejected) {
    return page(`<div class="card"><h2>Connection</h2><div class="body">
      <p class="bad">GHL rejected the token (401).</p>
      <p class="muted">Check it was pasted whole into <code>GHL_TOKEN</code>, with no
      stray spaces, and that the integration is still active in
      GHL → Settings → Private Integrations.</p>
      <p class="muted">GHL said: ${esc(rejected.error || "")}</p>
    </div></div>`);
  }

  /* ---- 2. calendars ---- */
  const cals = await call("/calendars/", { locationId: location });
  const calList = cals.ok ? (cals.body?.calendars || cals.body?.data || []) : [];
  const calIds = calList.map((x) => x.id || x._id).filter(Boolean);

  out.push(`<div class="card"><h2>Calendars</h2><div class="body">
    ${!cals.ok
      ? `<p class="bad">Could not list them: ${esc(cals.error || "")}</p>`
      : !calList.length
        ? `<p class="warn">The call worked but returned none. Check the token has the
           <code>calendars.readonly</code> scope.</p>`
        : `<table>${calList.map((cal) => `<tr>
             <td class="n">${esc(cal.name || "(unnamed)")}</td>
             <td><code>${esc(cal.id || cal._id || "")}</code></td></tr>`).join("")}</table>
           <div class="note">Paste this line into the service's <code>CALENDAR_IDS</code> variable:</div>
           <div class="copy">${esc(calIds.join(","))}</div>`}
  </div></div>`);

  /* ---- 3. team ---- */
  const users = await call("/users/", { locationId: location });
  const userList = users.ok ? (users.body?.users || users.body?.data || []) : [];

  out.push(`<div class="card"><h2>Team</h2><div class="body">
    ${!users.ok
      ? `<p class="warn">Could not list them: ${esc(users.error || "")}</p>
         <p class="muted">Not fatal — the user id only decides who an appointment is assigned to.</p>`
      : !userList.length
        ? `<p class="warn">None returned.</p>`
        : `<table>${userList.map((u) => `<tr>
             <td class="n">${esc([u.firstName, u.lastName].filter(Boolean).join(" ") || u.name || u.email || "(unnamed)")}</td>
             <td><code>${esc(u.id || u._id || "")}</code></td></tr>`).join("")}</table>`}
  </div></div>`);

  /* ---- 4. the call the whole feature rests on ---- */
  const first = calList[0];
  let slotsHtml;

  if (!first) {
    slotsHtml = `<p class="muted">No calendar to try yet.</p>`;
  } else {
    const id = first.id || first._id;
    const day = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    const r = await call(`/calendars/${encodeURIComponent(id)}/free-slots`, {
      startDate: Date.parse(`${day}T00:00:00Z`) - 24 * 3600e3,
      endDate: Date.parse(`${day}T00:00:00Z`) + 48 * 3600e3,
      timezone: "America/New_York",
    });

    const forDay = r.ok ? r.body?.[day]?.slots : null;
    const dateKeys = r.ok ? Object.keys(r.body || {}).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)) : [];

    slotsHtml = !r.ok
      ? `<p class="bad">The free-slots call failed: ${esc(r.error || "")}</p>
         <p class="muted">This is the call the whole feature rests on. Send this page's
         contents over and the fix goes into the service — the dashboard needs no change.</p>`
      : Array.isArray(forDay) && forDay.length
        ? `<p class="ok"><b>${forDay.length}</b> free slots tomorrow on ${esc(first.name || id)}.</p>
           <p class="muted">First: <code>${esc(forDay[0])}</code></p>
           <p class="ok">The shape is what the service expects. Nothing to change.</p>`
        : dateKeys.length
          ? `<p class="warn">Slots came back, but not for tomorrow. Dates present:
             ${dateKeys.map((k) => `<code>${esc(k)}</code>`).join(" ")}</p>
             <p class="muted">Probably just a quiet day — try again on a weekday.</p>`
          : `<p class="warn">The call worked, but the response is not the shape the service reads.</p>
             <p class="muted">Keys returned: ${esc(Object.keys(r.body || {}).join(", "))}. Send this over.</p>`;
  }

  out.push(`<div class="card"><h2>Free slots</h2><div class="body">${slotsHtml}</div></div>`);

  out.push(`<div class="card"><h2>What to do with this</h2><div class="body">
    <p class="muted">Send this page over — a screenshot or the text, either is fine. The
    calendar and user ids above go into the dashboard's config; nothing on this page is
    a secret, and the token is never shown here.</p>
    <p class="muted">When you are done setting up, clear <code>SETUP_KEY</code> to switch
    this page off.</p>
  </div></div>`);

  return page(out.join(""));
}

/* ===== handler.js ================================================ */
/* ============================================================================
   handler.js — the only thing that ever holds the GoHighLevel token.

   Why this file exists at all. The dashboard is a block of HTML pasted into a
   GHL page, so everything it contains is readable by anyone who views source.
   A GHL Private Integration Token with calendars/events.write and
   contacts.write can create contacts and appointments across the whole
   sub-account, so it cannot live there. GHL's API also sends no CORS headers,
   so the browser could not call it directly even if the token were harmless.

   So: the browser asks this, this asks GHL. The token stays server-side, and
   every request has to carry a Firebase ID token from a signed-in dashboard
   user, which is checked with Google rather than merely decoded.

   Two endpoints, both POST:
     /slots  { date, timezone, calendarIds }  → { slots: { <calId>: [{t,iso}] } }
     /book   { calendarId, userId, startTime, timezone, minutes, title,
               notes, contact:{firstName,lastName,email,phone} }
             → { ok, appointmentId, contactId }

   Runtime-agnostic: nothing but fetch and the standard Request/Response, so
   the same file runs unchanged on Cloudflare Workers and on Node 18+ (Firebase
   Functions). See worker.js and firebase-function.js.
   ========================================================================== */



const GHL = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-04-15";

/* ---------------------------------------------------------------------------
   Who is calling?

   Decoding the JWT locally would prove nothing — anyone can write one. Rather
   than hand-roll RS256 verification against Google's rotating X.509 certs,
   hand the token to Google and let them answer. One request, no crypto, and
   nothing here to get subtly wrong: an expired, forged or foreign-project
   token comes back as an error, not a user.

   FIREBASE_API_KEY is the same public web key that is already in config.js —
   it identifies the project, it is not a secret. The actual secret in this
   file is GHL_TOKEN, and that one never leaves the server.
--------------------------------------------------------------------------- */
async function verifyFirebaseToken(idToken, apiKey) {
  if (!idToken) throw new Error("Sign in to the dashboard first");

  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    },
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = data?.error?.message || "";
    if (/EXPIRED/i.test(code)) throw new Error("Your session has expired — reload the page and sign in again");
    if (/INVALID/i.test(code)) throw new Error("That sign-in is not valid for this dashboard");
    throw new Error("Could not confirm your sign-in");
  }

  const user = data?.users?.[0];
  if (!user) throw new Error("Could not confirm your sign-in");
  if (user.disabled) throw new Error("That account has been disabled");

  return { sub: user.localId, email: user.email || "" };
}

/* ---------------------------------------------------------------------------
   Time helpers.

   GHL answers free-slots in the timezone you ask for, as ISO strings with an
   offset. The dashboard wants the wall-clock time to show the caller, so split
   that out here rather than making the browser do timezone arithmetic.
--------------------------------------------------------------------------- */
const wallClock = (iso) => {
  const m = String(iso).match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : "";
};

/* Add the call length to a start time, keeping the answer in the same offset
   the start came in. Date.parse gives a UTC instant; shifting that instant by
   the offset and rendering it as if it were UTC yields the local wall clock,
   which is what gets the offset re-attached. */
const addMinutes = (iso, minutes) => {
  const ms = Date.parse(iso);
  if (isNaN(ms)) throw new Error("Unusable start time");

  const offset = String(iso).match(/([+-]\d{2}:\d{2})$/)?.[1] || "Z";
  const shift = offset === "Z" ? 0
    : (offset[0] === "-" ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));

  const wall = new Date(ms + (minutes + shift) * 60000);
  return wall.toISOString().slice(0, 19) + offset;
};

/* ---------------------------------------------------------------------------
   GHL calls
--------------------------------------------------------------------------- */
async function ghl(env, path, { method = "GET", body, query, version } = {}) {
  const url = new URL(`${GHL}${path}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${env.GHL_TOKEN}`,
      Version: version || GHL_VERSION,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    const msg = data?.message || data?.error || `GHL returned ${res.status}`;
    const text2 = redact(env, Array.isArray(msg) ? msg.join(", ") : msg);
    throw Object.assign(new Error(text2), { status: res.status });
  }
  return data;
}

/* Try each known API version before giving up. If the documented one is stale
   this is what finds that out, and the fix is one line here. */
const GHL_VERSIONS = ["2021-04-15", "2021-07-28"];

async function callAnyVersion(env, path, query) {
  let last;
  for (const version of GHL_VERSIONS) {
    try {
      const body = await ghl(env, path, { query, version });
      return { ok: true, body, version };
    } catch (ex) {
      last = { ok: false, status: ex.status || 0, message: ex.message, version };
      if ((ex.status || 0) >= 500) break;
    }
  }
  return last || { ok: false, status: 0, message: "No response" };
}

/* GHL can quote the credential back inside an error body — an invalid-token
   response is the obvious case. Nothing derived from a GHL response reaches a
   browser without passing through here first. */
const redact = (env, s) =>
  env.GHL_TOKEN ? String(s ?? "").split(env.GHL_TOKEN).join("«token»") : String(s ?? "");

const errText = (env, r) => redact(env, r.message || `HTTP ${r.status}`);

/* The allowlist is what stops this being an open proxy into the GHL account
   for anyone who happens to hold a dashboard login. */
const allowedCalendars = (env) =>
  String(env.CALENDAR_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);

function assertAllowed(env, calendarId) {
  const allowed = allowedCalendars(env);
  if (!allowed.length) throw new Error("No calendars are configured on the calendar service");
  if (!allowed.includes(calendarId)) throw new Error("That calendar is not one this service may touch");
}

/* ---------------------------------------------------------------------------
   /slots
--------------------------------------------------------------------------- */
async function handleSlots(env, body) {
  const { date, timezone, calendarIds } = body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) throw new Error("A date of the form YYYY-MM-DD is required");
  if (!timezone) throw new Error("A timezone is required");
  const ids = (Array.isArray(calendarIds) ? calendarIds : []).filter(Boolean);
  if (!ids.length) throw new Error("No calendars asked for");

  // GHL takes epoch milliseconds. Bracket the requested day generously and let
  // the timezone parameter decide what "that day" means.
  const startDate = Date.parse(`${date}T00:00:00Z`) - 24 * 3600e3;
  const endDate = Date.parse(`${date}T00:00:00Z`) + 48 * 3600e3;

  const results = await Promise.all(ids.map(async (id) => {
    /* Deliberately outside the try below: a calendar that is not on the
       allowlist is a misconfiguration, and should fail the whole request
       loudly rather than quietly showing that rep as busy all day. */
    assertAllowed(env, id);
    try {
      const data = await ghl(env, `/calendars/${encodeURIComponent(id)}/free-slots`, {
        query: { startDate, endDate, timezone },
      });

      /* The response is keyed by date, with a `slots` array of ISO strings
         under each — plus some non-date bookkeeping keys, so read only the
         day asked for rather than everything returned. */
      const raw = data?.[date]?.slots || [];
      return [id, raw.map((iso) => ({ t: wallClock(iso), iso })).filter((s) => s.t)];
    } catch (ex) {
      // One rep's calendar being misconfigured must not blank the whole grid.
      return [id, [], ex.message];
    }
  }));

  const slots = {};
  const problems = {};
  for (const [id, list, err] of results) {
    slots[id] = list;
    if (err) problems[id] = err;
  }
  return { slots, ...(Object.keys(problems).length ? { problems } : {}) };
}

/* ---------------------------------------------------------------------------
   /book — upsert the contact, then put the appointment on the rep's calendar.
   GHL emails the invite off the back of the appointment.
--------------------------------------------------------------------------- */
async function handleBook(env, body, claims) {
  const { calendarId, userId, startTime, timezone, minutes, title, notes, contact } = body || {};
  if (!calendarId) throw new Error("Which calendar?");
  assertAllowed(env, calendarId);
  if (!startTime) throw new Error("No start time");
  if (!contact?.email) throw new Error("An email address is needed to send the invite");

  const upserted = await ghl(env, "/contacts/upsert", {
    method: "POST",
    body: {
      locationId: env.GHL_LOCATION_ID,
      firstName: contact.firstName || "",
      lastName: contact.lastName || "",
      email: contact.email,
      ...(contact.phone ? { phone: contact.phone } : {}),
      source: "LinkedIn Leads dashboard",
    },
  });

  const contactId = upserted?.contact?.id || upserted?.id;
  if (!contactId) throw new Error("GHL did not return a contact to book against");

  const appt = await ghl(env, "/calendars/events/appointments", {
    method: "POST",
    body: {
      calendarId,
      locationId: env.GHL_LOCATION_ID,
      contactId,
      startTime,
      endTime: addMinutes(startTime, Number(minutes) || 30),
      title: title || "Discovery call",
      appointmentStatus: "confirmed",
      ...(userId ? { assignedUserId: userId } : {}),
      ...(timezone ? { ignoreDateRange: false } : {}),
      ...(notes ? { notes } : {}),
      meta: { bookedBy: claims.email || claims.sub },
    },
  });

  return {
    ok: true,
    contactId,
    appointmentId: appt?.id || appt?.appointment?.id || "",
  };
}

/* ---------------------------------------------------------------------------
   Entry point. One function, two runtimes.
--------------------------------------------------------------------------- */
const cors = (env) => ({
  "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
});

const json = (env, obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors(env) },
  });

async function handle(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");

  /* The setup page: a browser-visitable stand-in for running a script, for
     whoever is wiring this up. Off unless SETUP_KEY is set, and gated on it —
     a page listing every calendar in a sub-account does not belong on an open
     URL. Read-only, and it never renders the token. */
  if (path.endsWith("/setup")) {
    if (!env.SETUP_KEY) {
      return new Response("Setup page is off. Set SETUP_KEY to switch it on.", {
        status: 404, headers: { "Content-Type": "text/plain" },
      });
    }
    if (url.searchParams.get("key") !== env.SETUP_KEY) {
      return new Response("Wrong or missing ?key=", {
        status: 401, headers: { "Content-Type": "text/plain" },
      });
    }
    if (!env.GHL_TOKEN) {
      return new Response("The service has no GHL_TOKEN yet.", {
        status: 500, headers: { "Content-Type": "text/plain" },
      });
    }

    /* Hand the page a bound caller rather than the token itself. */
    const api = async (p, query) => {
      const r = await callAnyVersion(env, p, query);
      return { ...r, error: r.ok ? "" : errText(env, r) };
    };
    const html = await setupPage(env, api);
    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex, nofollow" },
    });
  }

  if (request.method !== "POST") return json(env, { error: "POST only" }, 405);
  const route = path.endsWith("/slots") ? "slots" : path.endsWith("/book") ? "book" : "";
  if (!route) return json(env, { error: "Unknown endpoint" }, 404);

  /* Only what this route actually uses. GHL_LOCATION_ID is needed to create a
     contact, not to read availability — refusing /slots for want of it would
     block the grid over a variable it never touches. */
  const needed = ["GHL_TOKEN", "FIREBASE_API_KEY", "CALENDAR_IDS"];
  if (route === "book") needed.push("GHL_LOCATION_ID");
  for (const name of needed) {
    if (!env[name]) return json(env, { error: `The calendar service is missing ${name}` }, 500);
  }

  let claims;
  try {
    const auth = request.headers.get("Authorization") || "";
    claims = await verifyFirebaseToken(auth.replace(/^Bearer\s+/i, ""), env.FIREBASE_API_KEY);
  } catch (ex) {
    return json(env, { error: ex.message }, 401);
  }

  try {
    const body = await request.json();
    const out = route === "slots"
      ? await handleSlots(env, body)
      : await handleBook(env, body, claims);
    return json(env, out);
  } catch (ex) {
    return json(env, { error: ex.message || "Calendar request failed" }, ex.status || 400);
  }
}

/* ===== Cloudflare entry point ============================================ */
export default {
  fetch: (request, env) => handle(request, env),
};
