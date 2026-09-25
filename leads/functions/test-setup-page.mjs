/* Drives the built paste-file exactly as Cloudflare would: import its default
   export and hand it a Request. GHL is stubbed, so the routing, the key gate
   and the rendered page are all checked without a token or a network. */
import assert from "node:assert";

const TOKEN = "pit-SUPERSECRET-abc123";
const day = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
let mode = "happy";
const seen = [];

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  seen.push(u);
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s });

  if (u.includes("identitytoolkit")) {
    const { idToken } = JSON.parse(opts.body);
    return idToken === "good"
      ? J({ users: [{ localId: "u1", email: "a@b.com" }] })
      : J({ error: { message: "INVALID_ID_TOKEN" } }, 400);
  }
  if (mode === "unauthorized") return J({ message: `bad token ${TOKEN}` }, 401);
  if (u.includes("/locations/search")) return J({ locations: [{ id: "loc_1", name: "Summit Sales" }] });
  if (u.includes("/locations/")) return J({ location: { name: "Summit Sales" } });
  if (u.includes("free-slots")) {
    if (mode === "slots-fail") return J({ message: "calendar not found" }, 404);
    return J({ [day]: { slots: [`${day}T12:00:00-04:00`, `${day}T12:30:00-04:00`] }, traceId: "x" });
  }
  if (u.includes("/calendars/")) return J({ calendars: [
    { id: "cal_melton", name: "Melton Weaver" }, { id: "cal_two", name: "Rep Two" }] });
  if (u.includes("/users/")) return J({ users: [{ id: "usr_1", firstName: "Melton", lastName: "Weaver" }] });
  return J({ message: "unexpected " + u }, 500);
};

const { default: worker } = await import("./cloudflare/worker-paste.js");

const env = {
  GHL_TOKEN: TOKEN, GHL_LOCATION_ID: "", CALENDAR_IDS: "cal_melton,cal_two",
  FIREBASE_API_KEY: "pubkey", ALLOWED_ORIGIN: "https://example.com", SETUP_KEY: "letmein",
};

const get = (path, e = env) => worker.fetch(new Request(`https://w.test${path}`), e);

let failures = 0;
const t = async (name, fn) => {
  seen.length = 0; mode = "happy";
  try { await fn(); console.log("✓ " + name); }
  catch (e) { failures++; console.log("✗ " + name + "\n    " + e.message); }
};

await t("the setup page renders in a browser", async () => {
  const r = await get("/setup?key=letmein");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("Content-Type"), /text\/html/);
  const html = await r.text();
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Calendar service — setup/);
});

await t("it lists the calendars with their ids", async () => {
  const html = await (await get("/setup?key=letmein")).text();
  assert.match(html, /Melton Weaver/);
  assert.match(html, /cal_melton/);
  assert.match(html, /Rep Two/);
});

await t("it hands over a ready-made CALENDAR_IDS line", async () => {
  const html = await (await get("/setup?key=letmein")).text();
  assert.match(html, /cal_melton,cal_two/);
});

await t("it lists the team with their ids", async () => {
  const html = await (await get("/setup?key=letmein")).text();
  assert.match(html, /usr_1/);
});

await t("it finds the sub-account without being told", async () => {
  const html = await (await get("/setup?key=letmein")).text();
  assert.match(html, /Summit Sales/);
  assert.ok(seen.some((u) => u.includes("/locations/")), "never looked one up");
});

await t("it confirms the free-slots call works", async () => {
  const html = await (await get("/setup?key=letmein")).text();
  assert.match(html, /free slots tomorrow/);
  assert.match(html, /shape is what the service expects/);
});

await t("the page never contains the token", async () => {
  const html = await (await get("/setup?key=letmein")).text();
  assert.ok(!html.includes(TOKEN), "token rendered into the page");
});

await t("nor when GHL echoes it back in an error", async () => {
  mode = "unauthorized";
  const html = await (await get("/setup?key=letmein")).text();
  assert.ok(!html.includes(TOKEN), "token leaked through an error body");
  assert.match(html, /rejected the token/i);
});

await t("a broken free-slots call is named as the critical one", async () => {
  mode = "slots-fail";
  const html = await (await get("/setup?key=letmein")).text();
  assert.match(html, /free-slots call failed/);
  assert.match(html, /cal_melton/, "earlier sections should still render");
});

await t("the wrong key is refused", async () => {
  const r = await get("/setup?key=nope");
  assert.equal(r.status, 401);
  assert.equal(seen.filter((u) => u.includes("leadconnector")).length, 0, "must not reach GHL");
});

await t("no key at all is refused", async () => {
  const r = await get("/setup");
  assert.equal(r.status, 401);
});

await t("the page is off entirely when SETUP_KEY is unset", async () => {
  const r = await get("/setup?key=letmein", { ...env, SETUP_KEY: "" });
  assert.equal(r.status, 404);
  assert.equal(seen.filter((u) => u.includes("leadconnector")).length, 0);
});

await t("it asks not to be indexed", async () => {
  const r = await get("/setup?key=letmein");
  assert.match(r.headers.get("X-Robots-Tag") || "", /noindex/);
  assert.match(await r.text(), /name="robots"/);
});

await t("the real endpoints still work through the built file", async () => {
  const r = await worker.fetch(new Request("https://w.test/slots", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer good" },
    body: JSON.stringify({ date: day, timezone: "America/New_York", calendarIds: ["cal_melton"] }),
  }), env);
  assert.equal(r.status, 200);
  const { slots } = await r.json();
  assert.equal(slots.cal_melton.length, 2);
  assert.equal(slots.cal_melton[0].t, "12:00");
});

await t("and still refuse an unsigned caller", async () => {
  const r = await worker.fetch(new Request("https://w.test/slots", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  }), env);
  assert.equal(r.status, 401);
});

console.log(failures ? `\n${failures} FAILED` : "\nall setup-page checks passed");
process.exit(failures ? 1 : 0);
