/* Runs check-ghl.mjs against a stubbed GHL so the script itself is verified,
   even though the real API is unreachable from here. Chiefly: it must never
   print the token, and it must survive every failure shape. */
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "ghlcheck-"));

const TOKEN = "pit-SUPERSECRET-abc123";
let failures = 0;
const t = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : "\n    " + detail}`);
};

/* A fetch stub injected via --import, so the script under test is unmodified. */
const stub = (mode) => `
const day = new Date(Date.now() + 864e5).toISOString().slice(0,10);
globalThis.fetch = async (url) => {
  const u = String(url);
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
  const mode = ${JSON.stringify(mode)};
  if (mode === "unauthorized") return J({ message: "Invalid token ${TOKEN}" }, 401);
  if (u.includes("/locations/search")) {
    if (mode === "two-locations") return J({ locations: [{ id: "loc_1", name: "Summit Sales" }, { id: "loc_2", name: "Other Co" }] });
    if (mode === "no-discovery") return J({ message: "forbidden" }, 403);
    return J({ locations: [{ id: "loc_1", name: "Summit Sales" }] });
  }
  if (u.includes("/locations/")) return J({ location: { name: "Summit Sales" } });
  if (u.includes("/calendars/") && u.includes("free-slots")) {
    if (mode === "slots-fail") return J({ message: "calendar not found" }, 404);
    if (mode === "slots-shape") return J({ traceId: "x", weird: true });
    return J({ [day]: { slots: [day + "T12:00:00-04:00", day + "T12:30:00-04:00"] }, traceId: "x" });
  }
  if (u.includes("/calendars/")) return J({ calendars: [{ id: "cal_melton", name: "Melton Weaver" }, { id: "cal_two", name: "Rep Two" }] });
  if (u.includes("/users/")) {
    if (mode === "no-users") return J({ message: "forbidden" }, 403);
    return J({ users: [{ id: "usr_1", firstName: "Melton", lastName: "Weaver" }] });
  }
  return J({ message: "unexpected " + u }, 500);
};
`;

const run = (mode, env = {}) => {
  const f = join(TMP, `stub-${mode}.mjs`);
  writeFileSync(f, stub(mode));
  const r = spawnSync("node", [`--import=file://${f}`, new URL("./check-ghl.mjs", import.meta.url).pathname], {
    env: { ...process.env, GHL_TOKEN: TOKEN, GHL_LOCATION_ID: "loc_1", ...env },
    encoding: "utf8",
  });
  return (r.stdout || "") + (r.stderr || "");
};

const happy = run("happy");
t("never prints the token", !happy.includes(TOKEN), happy.slice(0, 300));
t("confirms the token works", /Token works/.test(happy));
t("lists calendars with their ids", /cal_melton/.test(happy) && /Melton Weaver/.test(happy));
t("hands over a ready-made CALENDAR_IDS line", /CALENDAR_IDS=cal_melton,cal_two/.test(happy));
t("lists team members with their ids", /usr_1/.test(happy));
t("confirms free slots come back", /free slots on/.test(happy));
t("says the shape matches handler.js", /shape matches/.test(happy));

const unauth = run("unauthorized");
t("a 401 is reported plainly", /token was rejected/i.test(unauth));
t("a 401 does not leak the token echoed back by GHL", !unauth.includes(TOKEN), unauth.slice(0, 300));

const slotsFail = run("slots-fail");
t("a free-slots failure is called out as the critical one", /free-slots failed/.test(slotsFail));
t("and says the fix lands in handler.js", /handler\.js/.test(slotsFail));
t("but earlier steps still printed their ids", /cal_melton/.test(slotsFail));

const shape = run("slots-shape");
t("an unexpected response shape is diagnosed, not crashed on", /shape is not what handler\.js reads/.test(shape));

const noUsers = run("no-users");
t("a users failure is non-fatal", /Could not list users/.test(noUsers) && /free slots on/.test(noUsers));

/* With no token AND no terminal to prompt on — a pipe, a CI job — it must
   fail clearly rather than hang waiting for input nobody can give. */
const noToken = run("happy", { GHL_TOKEN: "" });
t("fails clearly when there is no token and no terminal", /nothing to prompt on/.test(noToken), noToken.slice(0, 200));
t("and says how to pass one anyway", /GHL_TOKEN=/.test(noToken));

/* Nobody should have to dig a location id out of a GHL URL — the script goes
   and finds it. */
const noLoc = run("happy", { GHL_LOCATION_ID: "" });
t("discovers the location id when none is given", /Found it/.test(noLoc) && /loc_1/.test(noLoc), noLoc.slice(0, 300));
t("and still completes every later check", /free slots on/.test(noLoc) && /cal_melton/.test(noLoc));

const twoLoc = run("two-locations", { GHL_LOCATION_ID: "" });
t("lists them and stops when the token sees several sub-accounts",
  /2 sub-accounts/.test(twoLoc) && /loc_2/.test(twoLoc), twoLoc.slice(0, 300));

const noDisc = run("no-discovery", { GHL_LOCATION_ID: "" });
t("explains where to find it by hand if discovery fails",
  /Could not discover it automatically/.test(noDisc) && /address bar/.test(noDisc));

console.log(failures ? `\n${failures} FAILED` : "\nall check-ghl checks passed");
process.exit(failures ? 1 : 0);
