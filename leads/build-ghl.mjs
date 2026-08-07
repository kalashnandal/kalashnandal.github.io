/* ============================================================================
   build-ghl.mjs — produces ONE file to paste into a GHL custom-HTML block.

   Differences from a normal standalone page, all of them because the markup
   lands inside somebody else's document:

   1. Everything is wrapped in #llb-root, and every CSS selector is rewritten
      to sit under it. GHL themes style bare elements (button, input, h1) and
      common class names (.card, .btn, .nav) aggressively. An ID + class
      selector outranks anything they are likely to have, so our rules win
      inside the block, and none of our rules escape it.
   2. No <html>, <head> or <body> — a fragment, which is what the block wants.
   3. Modules are concatenated and the import/export plumbing stripped, since
      one inline script has no module boundaries to cross.
   ========================================================================== */

import { readFileSync, writeFileSync } from "fs";

const SRC = "/home/user/kalashnandal.github.io/leads";
const read = (f) => readFileSync(`${SRC}/${f}`, "utf8");
const ROOT = "#llb-root";

/* ---------------------------------------------------------------------------
   JS: concatenate in dependency order, drop the module plumbing
--------------------------------------------------------------------------- */
const stripImports = (s) =>
  s.replace(/^import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?[ \t]*$/gm, "")
   .replace(/^import\s+[\w*\s{},]+\s*from\s*["'][^"']+["'];?[ \t]*$/gm, "");
const stripExports = (s) => s.replace(/^export\s+(?=(const|let|var|function|async|class)\b)/gm, "");

const mod = (f) => `\n/* ===== ${f} ${"=".repeat(Math.max(0, 60 - f.length))} */\n` +
  stripExports(stripImports(read(f))).trim() + "\n";

const js = [mod("config.js"), mod("xlsx.js"), mod("store.js"), mod("app.js")].join("\n");
for (const [label, re] of [["static import", /^import\s*[{\w*]/m], ["export", /^export\s/m]]) {
  const m = js.match(re);
  if (m) throw new Error(`${label} survived stripping: ${JSON.stringify(m[0])}`);
}

/* ---------------------------------------------------------------------------
   CSS: scope every selector under #llb-root

   Walks the stylesheet brace by brace so at-rules are handled properly:
   @media / @supports bodies get scoped, @keyframes bodies must NOT (their
   "0%" and "from" are keyframe selectors, not element selectors).
--------------------------------------------------------------------------- */
function scopeSelector(sel) {
  return sel.split(",").map((raw) => {
    const s = raw.trim();
    if (!s) return s;
    // :root and body both mean "the app container" once embedded.
    if (s === ":root" || s === "body" || s === "html") return ROOT;
    if (s.startsWith(ROOT)) return s;
    // Leading pseudo-elements/classes on the root itself.
    if (s.startsWith(":focus-visible")) return `${ROOT} ${s}`;
    return `${ROOT} ${s}`;
  }).join(", ");
}

function scopeCss(css) {
  let out = "", i = 0;

  while (i < css.length) {
    // Emit leading whitespace and comments before reading the selector, so a
    // comment above a rule can't end up folded into that rule's prelude.
    let moved = true;
    while (moved && i < css.length) {
      moved = false;
      const ws = css.slice(i).match(/^\s+/);
      if (ws) { out += ws[0]; i += ws[0].length; moved = true; }
      if (css.startsWith("/*", i)) {
        const end = css.indexOf("*/", i + 2);
        const stop = end === -1 ? css.length : end + 2;
        out += css.slice(i, stop); i = stop; moved = true;
      }
    }
    if (i >= css.length) break;

    const braceAt = css.indexOf("{", i);
    if (braceAt === -1) { out += css.slice(i); break; }

    const prelude = css.slice(i, braceAt);
    const trimmed = prelude.trim();

    // Find the matching close brace for this block.
    let depth = 0, j = braceAt;
    for (; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") { depth--; if (depth === 0) break; }
    }
    const body = css.slice(braceAt + 1, j);

    if (/^@(media|supports|container)/i.test(trimmed)) {
      // Scope the rules inside, keep the condition as-is.
      out += `${prelude}{${scopeCss(body)}}`;
    } else if (/^@(keyframes|font-face|import|charset|page)/i.test(trimmed)) {
      // Keyframe stops and descriptors are not selectors — leave untouched.
      out += `${prelude}{${body}}`;
    } else {
      out += `${prelude.replace(trimmed, scopeSelector(trimmed))}{${body}}`;
    }
    i = j + 1;
  }
  return out;
}

/* ---------------------------------------------------------------------------
   Armour against the host's !important

   Scoping wins on specificity, but specificity loses to !important, and page
   builders reset button/input/heading/table styles with it routinely. So the
   rules covering those elements get !important too.

   Deliberately NOT armoured: .pill, .pipe-step, .bar-fill, .outcome and table
   rows. Those carry inline styles written by app.js (stage colours, the row
   stripe, bar widths) and an !important stylesheet declaration would beat the
   inline style and flatten every stage to one colour.
--------------------------------------------------------------------------- */
const ARMOUR = [
  /^\S+ \*(,|$| )/,                       // the box-sizing reset
  /\.btn\b/, /\.inp\b/, /\.tab\b/, /\.nav\b/,
  /\.icon-btn\b/, /\.dr-close\b/, /\.link-btn\b/, /\.dr-tab\b/,
  /\.side\b/, /\.side-/, /\.brandmark\b/, /\.avatar\b/,
  /\.hero\b/, /\.hero-/, /\.card\b/, /\.card-head\b/, /\.card-body\b/,
  /\.page-head\b/, /\.page-sub\b/, /\.stat\b/, /\.stats\b/,
  /\.fld\b/, /\.frm\b/, /\.toolbar\b/, /\.tbl-wrap\b/,
  /table\.leads/, /\.drawer\b/, /\.dr-/, /\.list\b/, /\.li\b/,
  /\.feed\b/, /\.fe\b/, /\.fe-/, /\.toast\b/, /\.login-/, /#login\b/,
  /\bh[1-4]\b/, /\ba\b(?![\w-])/, /\bp\b(?![\w-])/,
  /\bbutton\b/, /\binput\b/, /\bselect\b/, /\btextarea\b/,
  /:focus-visible/,
  /#llb-root\{/, /#llb-root$/,
];

/* Custom properties only. Everything app.js styles inline lives on selectors
   that are absent from ARMOUR above, so no property-level exclusion is needed
   — and excluding `background` here was what let the host's red button
   through. */
const NEVER = /^--/;

function important(body) {
  return body.split(";").map((decl) => {
    const d = decl.trim();
    if (!d || d.includes("!important")) return decl;
    const prop = d.split(":")[0].trim().toLowerCase();
    if (NEVER.test(prop)) return decl;
    return decl.replace(/\s*$/, " !important");
  }).join(";");
}

function armour(css) {
  let out = "", i = 0;
  while (i < css.length) {
    if (css.startsWith("/*", i)) {
      const e = css.indexOf("*/", i + 2), stop = e === -1 ? css.length : e + 2;
      out += css.slice(i, stop); i = stop; continue;
    }
    const braceAt = css.indexOf("{", i);
    if (braceAt === -1) { out += css.slice(i); break; }
    const prelude = css.slice(i, braceAt);
    const trimmed = prelude.trim();
    let depth = 0, j = braceAt;
    for (; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") { depth--; if (depth === 0) break; }
    }
    const body = css.slice(braceAt + 1, j);

    if (/^@(media|supports|container)/i.test(trimmed)) out += `${prelude}{${armour(body)}}`;
    else if (/^@/.test(trimmed)) out += `${prelude}{${body}}`;
    else out += `${prelude}{${ARMOUR.some((re) => re.test(trimmed)) ? important(body) : body}}`;
    i = j + 1;
  }
  return out;
}

/* `body{margin:0}` exists to kill the browser's default body margin. Scoped
   to #llb-root it becomes a margin reset on an ordinary div, and armoured it
   becomes `margin:0 !important` — which outranks the full-bleed margins and
   even inline styles, pinning the block inside the host's column. Drop it
   before scoping; a div has no default margin to reset. */
const baseCss = read("style.css").replace(/(\bbody\{[^}]*?)margin:0;\s*/, "$1");

let css = armour(scopeCss(baseCss));

/* ---------------------------------------------------------------------------
   Keep .hide winning

   Armouring turned rules like `#llb-root #login{display:grid}` into
   `!important`. Among !important declarations specificity still decides, and
   an ID beats a class — so `.hide` silently stopped hiding the login panel.

   Rather than special-case it, find every ID rule that sets `display` and
   emit a matching `#id.hide` override, which outranks it by one class.
--------------------------------------------------------------------------- */
const hidden = new Set();
for (const m of css.matchAll(/#llb-root\s+#([\w-]+)[^{},]*\{[^}]*\bdisplay\s*:/g)) hidden.add(m[1]);
const hideRule = [...hidden].map((id) => `${ROOT} #${id}.hide`).concat(`${ROOT} .hide`).join(",\n");
css += `\n\n/* .hide must outrank the ID rules armoured above. */\n${hideRule}{display:none !important}\n`;

/* Neutralise the host's own element styles before ours land. `revert` returns
   these to browser defaults rather than to whatever the theme decided. */
css = `${ROOT} button, ${ROOT} input, ${ROOT} select, ${ROOT} textarea,
${ROOT} table, ${ROOT} th, ${ROOT} td, ${ROOT} h1, ${ROOT} h2, ${ROOT} h3,
${ROOT} h4, ${ROOT} p, ${ROOT} a, ${ROOT} ul, ${ROOT} li, ${ROOT} fieldset,
${ROOT} legend, ${ROOT} label, ${ROOT} section, ${ROOT} aside, ${ROOT} header,
${ROOT} nav, ${ROOT} main, ${ROOT} div, ${ROOT} span{
  all:revert;
}
${ROOT} *, ${ROOT} *::before, ${ROOT} *::after{
  box-sizing:border-box !important; float:none !important;
  text-transform:none !important; text-shadow:none !important;
  outline:0 !important;
}
` + css;

/* The container has to carry what `body` used to: it is the app's own ground,
   and a stacking context so the fixed drawer and toasts behave. */
css = `${ROOT}{position:relative; isolation:isolate;}\n` + css;

/* Break out of the page builder's centred column.

   The classic full-bleed trick: pull the element back to the viewport edge by
   half the difference between its container and the window. 100vw includes the
   scrollbar, so the negative margin uses 50% of the parent to compensate
   rather than a bare -50vw, which would overshoot by the scrollbar width and
   add a horizontal scrollbar of its own. */
const fullBleed = /FULL_BLEED\s*=\s*true/.test(read("config.js"));
if (fullBleed) {
  css = css.replace(`${ROOT}{`, `${ROOT}{
  width:100vw; max-width:100vw;
  margin-left:calc(50% - 50vw) !important; margin-right:calc(50% - 50vw) !important;
`);
}

/* One knob for how tall the app sits inside the GHL page. */
css = css.replace(`${ROOT} .shell{display:grid;`, `${ROOT} .shell{min-height:var(--app-height,100dvh); display:grid;`)
         .replace(/min-height:100dvh; ?/g, "");
css = css.replace(`${ROOT}{position:relative;`, `${ROOT}{--app-height:100dvh; position:relative;`);

/* ---------------------------------------------------------------------------
   HTML: body content only, wrapped in the scoping container
--------------------------------------------------------------------------- */
const html = read("index.html");
let body = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>")).trim();
body = body.replace(/<script[^>]*src="app\.js"[^>]*><\/script>/, "").trim();

// Pull the Cal embed out of the body so it can sit with the app script.
const calMatch = body.match(/<!-- Cal element-click embed[\s\S]*?<\/script>/);
const cal = calMatch ? calMatch[0] : "";
body = body.replace(cal, "").trim();

body = body.replace(
  /(<div id="demobar" class="hide">)[\s\S]*?(<\/div>)/,
  `$1
        Demo data — stored in this browser only. Remove <code>?demo=1</code> from the address to use the live project.
      $2`
);

const out = `<!-- ==========================================================================
     LinkedIn Leads dashboard — paste this whole block into a GHL custom HTML
     element. It is self-contained: no build step, no files to upload.

     Everything is scoped to #llb-root, so GHL's page styles cannot reach in
     and these styles cannot leak out.

     LIVE: wired to Firebase project leads-dashboard-9d76f. Sign in with
     Google, an emailed sign-in link, or an SMS code. Add ?demo=1 to the page
     URL to show sample data instead of the live project.

     Height: the app fills the viewport by default. To fit it inside a GHL
     page that has its own header and footer, change --app-height on the
     first CSS rule (e.g. --app-height:900px).
     ========================================================================== -->

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700&family=Inter:wght@400;450;500;600;700&display=swap" rel="stylesheet">

<style>
${css}
</style>

<div id="llb-root">
${body}
</div>

${cal}

<script type="module">
${js}
</script>
`;

writeFileSync(`${SRC}/linkedin-leads-ghl.html`, out);
console.log("wrote linkedin-leads-ghl.html —", (out.length / 1024).toFixed(1), "KB");
