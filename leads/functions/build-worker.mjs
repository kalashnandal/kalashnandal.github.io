/* ============================================================================
   build-worker.mjs — produces ONE file to paste into Cloudflare's browser
   editor.

   The dashboard is pasted into GHL by hand; the service behind it should be
   deployable the same way. Cloudflare's editor takes a single file with no
   imports, so this concatenates the modules and strips the plumbing — exactly
   what build-ghl.mjs does for the dashboard, and for the same reason.

   Run:  node build-worker.mjs
   Out:  cloudflare/worker-paste.js
   ========================================================================== */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(HERE, f), "utf8");

const stripImports = (s) =>
  s.replace(/^import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?[ \t]*$/gm, "")
   .replace(/^import\s+[\w*\s{},]+\s*from\s*["'][^"']+["'];?[ \t]*$/gm, "");

const stripExports = (s) =>
  s.replace(/^export\s+(?=(const|let|var|function|async|class)\b)/gm, "")
   .replace(/^export\s*\{[^}]*\}\s*;?[ \t]*$/gm, "");

const mod = (f) =>
  `\n/* ===== ${f} ${"=".repeat(Math.max(0, 58 - f.length))} */\n` +
  stripExports(stripImports(read(f))).trim() + "\n";

const header = `/* ============================================================================
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
`;

const entry = `
/* ===== Cloudflare entry point ============================================ */
export default {
  fetch: (request, env) => handle(request, env),
};
`;

const js = header + mod("setup-page.js") + mod("handler.js") + entry;

for (const [label, re] of [["static import", /^import\s*[{\w*]/m], ["export", /^export\s+(?!default)/m]]) {
  const m = js.match(re);
  if (m) throw new Error(`${label} survived stripping: ${JSON.stringify(m[0])}`);
}

mkdirSync(join(HERE, "cloudflare"), { recursive: true });
const out = join(HERE, "cloudflare", "worker-paste.js");
writeFileSync(out, js);
console.log(`wrote ${out} — ${(js.length / 1024).toFixed(1)} KB`);
