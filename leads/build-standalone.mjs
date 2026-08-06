/* Inline the five-file dashboard into one self-contained page for publishing.
   Concatenates the ES modules in dependency order and strips the import/export
   plumbing, since a single script has no module boundaries to cross. */

import { readFileSync, writeFileSync } from "fs";

const SRC = "/home/user/kalashnandal.github.io/leads";
const read = (f) => readFileSync(`${SRC}/${f}`, "utf8");

/* Remove static import statements (single- and multi-line). Dynamic import()
   calls are left alone — store.js uses one to load Firebase at runtime. */
const stripImports = (s) =>
  s.replace(/^import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?[ \t]*$/gm, "")
   .replace(/^import\s+[\w*\s{},]+\s*from\s*["'][^"']+["'];?[ \t]*$/gm, "");

/* `export const X` -> `const X`, `export function f` -> `function f` */
const stripExports = (s) => s.replace(/^export\s+(?=(const|let|var|function|async|class)\b)/gm, "");

const mod = (f) => `\n/* ===== ${f} ${"=".repeat(Math.max(0, 62 - f.length))} */\n` +
  stripExports(stripImports(read(f))).trim() + "\n";

const js = [mod("config.js"), mod("xlsx.js"), mod("store.js"), mod("app.js")].join("\n");

/* Sanity: no module syntax should survive into the bundle. */
for (const [label, re] of [
  ["static import", /^import\s*[{\w*]/m],
  ["export", /^export\s/m],
]) {
  const m = js.match(re);
  if (m) throw new Error(`${label} survived stripping: ${JSON.stringify(m[0])}`);
}

/* ---- CSS: swap the webfont stacks for chosen system equivalents ---------- */
let css = read("style.css");

css = css.replace(
  /--sans:[^;]+;/,
  `--sans:system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;`
).replace(
  /--serif:[^;]+;/,
  // Georgia stands in for Fraunces: warm, high-contrast, strong old-style
  // numerals — which is exactly the job the display face does in the tiles.
  `--serif:Georgia, 'Iowan Old Style', 'Times New Roman', serif;`
);

/* Georgia sets larger on the body than Fraunces at the same px, so ease the
   display sizes back a touch to keep the original optical weight. */
css = css.replace(/(\.stat \.v\{font-family:var\(--serif\); font-size:)32px/, "$130px")
         .replace(/(\.login-card h1\{[^}]*font-size:)26px/, "$124px");

/* Single-theme by choice — mirrors the deployed dashboard, which is light-only
   to match the other dashboards on the site. Declared so form controls follow. */
css = css.replace(":root{", ":root{\n  color-scheme:light;");

/* ---- HTML: take the body content only; the publisher supplies the shell --- */
const html = read("index.html");
let body = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>")).trim();

// Drop the module script tag — the JS is inlined below instead.
body = body.replace(/<script[^>]*src="app\.js"[^>]*><\/script>/, "").trim();

// Retarget the demo banner: there is no config.js to edit in a standalone page.
body = body.replace(
  /(<div id="demobar" class="hide">)[\s\S]*?(<\/div>)/,
  `$1
    Preview build — sample leads, stored in this browser only. Nothing here is shared with anyone else.
  $2`
);

const out = `<title>LinkedIn Leads · Internal Dashboard</title>
<style>
${css}
</style>

${body}

<script type="module">
${js}
</script>
`;

writeFileSync("/home/user/kalashnandal.github.io/leads/standalone-preview.html", out);
console.log("wrote standalone-preview.html —", (out.length / 1024).toFixed(1), "KB");
