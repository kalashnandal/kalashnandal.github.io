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
export async function setupPage(env, api) {
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

export { page as setupShell };
