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
export async function verifyFirebaseToken(idToken, apiKey) {
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
async function ghl(env, path, { method = "GET", body, query } = {}) {
  const url = new URL(`${GHL}${path}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${env.GHL_TOKEN}`,
      Version: GHL_VERSION,
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
    throw Object.assign(new Error(Array.isArray(msg) ? msg.join(", ") : msg), { status: res.status });
  }
  return data;
}

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

export async function handle(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });
  if (request.method !== "POST") return json(env, { error: "POST only" }, 405);

  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  const route = path.endsWith("/slots") ? "slots" : path.endsWith("/book") ? "book" : "";
  if (!route) return json(env, { error: "Unknown endpoint" }, 404);

  for (const name of ["GHL_TOKEN", "GHL_LOCATION_ID", "FIREBASE_API_KEY", "CALENDAR_IDS"]) {
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
