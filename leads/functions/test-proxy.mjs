/* Exercises the proxy handler with GHL and Google both stubbed out, so the
   routing, auth gate, allowlist and time maths are all checked without a
   token or a network. */
import assert from "node:assert";

const HANDLER = new URL("./handler.js", import.meta.url).href;

const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push({ url: u, opts });

  if (u.includes("identitytoolkit")) {
    const { idToken } = JSON.parse(opts.body);
    if (idToken === "good") return new Response(JSON.stringify({ users: [{ localId: "u1", email: "a@b.com" }] }), { status: 200 });
    return new Response(JSON.stringify({ error: { message: "INVALID_ID_TOKEN" } }), { status: 400 });
  }
  if (u.includes("/free-slots")) {
    const date = new URL(u).searchParams.get("timezone") ? "2026-08-27" : "2026-08-27";
    return new Response(JSON.stringify({
      [date]: { slots: ["2026-08-27T12:00:00-04:00", "2026-08-27T12:30:00-04:00"] },
      traceId: "x",
    }), { status: 200 });
  }
  if (u.includes("/contacts/upsert")) {
    return new Response(JSON.stringify({ contact: { id: "c1" } }), { status: 200 });
  }
  if (u.includes("/calendars/events/appointments")) {
    return new Response(JSON.stringify({ id: "appt1" }), { status: 200 });
  }
  return new Response(JSON.stringify({ message: "unexpected " + u }), { status: 500 });
};

const { handle } = await import(HANDLER);

const env = {
  GHL_TOKEN: "secret", GHL_LOCATION_ID: "loc1",
  FIREBASE_API_KEY: "pubkey", CALENDAR_IDS: "cal_a, cal_b",
  ALLOWED_ORIGIN: "https://example.com",
};

const post = (path, body, token = "good") =>
  handle(new Request(`https://proxy.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);

let failures = 0;
const t = async (name, fn) => {
  calls.length = 0;
  try { await fn(); console.log("✓ " + name); }
  catch (e) { failures++; console.log("✗ " + name + "\n    " + e.message); }
};

await t("rejects a request with no sign-in token", async () => {
  const r = await post("/slots", { date: "2026-08-27", timezone: "America/New_York", calendarIds: ["cal_a"] }, "");
  assert.equal(r.status, 401);
  assert.equal(calls.filter((c) => c.url.includes("leadconnector")).length, 0, "must not reach GHL");
});

await t("rejects a forged sign-in token", async () => {
  const r = await post("/slots", { date: "2026-08-27", timezone: "America/New_York", calendarIds: ["cal_a"] }, "forged");
  assert.equal(r.status, 401);
  assert.match((await r.json()).error, /not valid/i);
  assert.equal(calls.filter((c) => c.url.includes("leadconnector")).length, 0, "must not reach GHL");
});

await t("never leaks the GHL token to the browser", async () => {
  const r = await post("/slots", { date: "2026-08-27", timezone: "America/New_York", calendarIds: ["cal_a"] });
  const text = await r.text();
  assert.ok(!text.includes("secret"), "token appeared in the response body");
  for (const [k, v] of r.headers) assert.ok(!String(v).includes("secret"), "token appeared in a header");
});

await t("returns wall-clock plus bookable instant", async () => {
  const r = await post("/slots", { date: "2026-08-27", timezone: "America/New_York", calendarIds: ["cal_a"] });
  assert.equal(r.status, 200);
  const { slots } = await r.json();
  assert.deepEqual(slots.cal_a, [
    { t: "12:00", iso: "2026-08-27T12:00:00-04:00" },
    { t: "12:30", iso: "2026-08-27T12:30:00-04:00" },
  ]);
});

await t("refuses a calendar that is not on the allowlist", async () => {
  const r = await post("/slots", { date: "2026-08-27", timezone: "America/New_York", calendarIds: ["cal_stranger"] });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /not one this service may touch/i);
  assert.equal(calls.filter((c) => c.url.includes("free-slots")).length, 0, "must not query an unlisted calendar");
});

await t("books: upserts the contact, then creates the appointment", async () => {
  const r = await post("/book", {
    calendarId: "cal_a", userId: "usr1",
    startTime: "2026-08-27T12:00:00-04:00", minutes: 30,
    timezone: "America/New_York", title: "Discovery call",
    contact: { firstName: "Dana", email: "dana@example.com" },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, contactId: "c1", appointmentId: "appt1" });

  const appt = JSON.parse(calls.find((c) => c.url.includes("appointments")).opts.body);
  assert.equal(appt.startTime, "2026-08-27T12:00:00-04:00");
  assert.equal(appt.endTime, "2026-08-27T12:30:00-04:00", "end time must stay in the prospect's offset");
  assert.equal(appt.contactId, "c1");
  assert.equal(appt.assignedUserId, "usr1");
});

await t("30 minutes across an hour boundary", async () => {
  await post("/book", {
    calendarId: "cal_b", startTime: "2026-08-27T12:45:00-07:00", minutes: 30,
    contact: { firstName: "X", email: "x@y.com" },
  });
  const appt = JSON.parse(calls.find((c) => c.url.includes("appointments")).opts.body);
  assert.equal(appt.endTime, "2026-08-27T13:15:00-07:00");
});

await t("refuses to book without an email to invite", async () => {
  const r = await post("/book", { calendarId: "cal_a", startTime: "2026-08-27T12:00:00-04:00", contact: { firstName: "X" } });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /email/i);
  assert.equal(calls.filter((c) => c.url.includes("appointments")).length, 0);
});

await t("one broken calendar does not blank the others", async () => {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("cal_b") && String(url).includes("free-slots")) {
      return new Response(JSON.stringify({ message: "calendar not found" }), { status: 404 });
    }
    return prev(url, opts);
  };
  const r = await post("/slots", { date: "2026-08-27", timezone: "America/New_York", calendarIds: ["cal_a", "cal_b"] });
  globalThis.fetch = prev;
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.slots.cal_a.length, 2);
  assert.deepEqual(out.slots.cal_b, []);
  assert.match(out.problems.cal_b, /not found/i);
});

await t("unknown endpoints and non-POST are refused", async () => {
  assert.equal((await handle(new Request("https://proxy.test/anything", { method: "POST", body: "{}" }), env)).status, 404);
  assert.equal((await handle(new Request("https://proxy.test/slots"), env)).status, 405);
  assert.equal((await handle(new Request("https://proxy.test/slots", { method: "OPTIONS" }), env)).status, 204);
});

await t("missing configuration is reported, not ignored", async () => {
  const r = await handle(new Request("https://proxy.test/slots", { method: "POST", body: "{}" }), { ...env, GHL_TOKEN: "" });
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /GHL_TOKEN/);
});

globalThis.fetch = realFetch;
console.log(failures ? `\n${failures} FAILED` : "\nall proxy checks passed");
process.exit(failures ? 1 : 0);
