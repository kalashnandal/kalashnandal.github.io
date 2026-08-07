/* ============================================================================
   app.js — UI and behaviour for the LinkedIn Leads dashboard.
   ========================================================================== */

import {
  LEAD_FIELDS, FIELD_GROUPS, STAGES, stage, OPEN_STAGES, STALE_DAYS,
  STREAMS, ROLES, REVIEW_DAYS, field, CAL, calUrl, AUTH, NOINDEX, FULL_BLEED,
} from "./config.js";
import { openStore } from "./store.js";
import { downloadXlsx } from "./xlsx.js";

/* ==========================================================================
   TINY HELPERS
   ========================================================================== */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const DAY = 864e5;
const asDate = (v) => (v ? new Date(v) : null);
const daysSince = (v) => (v ? Math.floor((Date.now() - new Date(v)) / DAY) : Infinity);

const fmtDate = (v) => {
  const d = asDate(v);
  if (!d || isNaN(d)) return "";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};
const fmtWhen = (v) => {
  const d = asDate(v);
  if (!d || isNaN(d)) return "";
  const mins = Math.round((Date.now() - d) / 6e4);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  const days = Math.round(mins / 1440);
  if (days < 7) return `${days}d ago`;
  return fmtDate(v);
};
const fullName = (l) => `${l.firstName || ""} ${l.lastName || ""}`.trim() || "(no name)";
const initials = (s) =>
  (s || "?").split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

function toast(msg, kind = "") {
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => {
    t.style.transition = "opacity .3s, transform .3s";
    t.style.opacity = "0";
    t.style.transform = "translateY(8px)";
    setTimeout(() => t.remove(), 320);
  }, 3200);
}

/* The most recent Tuesday or Thursday boundary — "since the last review call". */
function lastReviewStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  for (let i = 0; i < 8; i++) {
    if (REVIEW_DAYS.includes(d.getDay()) && d.getTime() < Date.now()) return d;
    d.setDate(d.getDate() - 1);
  }
  return d;
}

/* ==========================================================================
   PERMISSIONS
   Mirrors firestore.rules. The rules are what actually enforce this — these
   checks only keep the UI honest.
   ========================================================================== */
const SALES_EDITABLE = ["status", "salesOwner", "ghlUrl", "dealValue", "nextFollowUp", "lostReason", "notes", "sharedOn"];

const can = {
  create:  (r) => ["admin", "ops"].includes(r),
  editAll: (r) => ["admin", "ops"].includes(r),
  edit:    (r) => ["admin", "ops", "sales"].includes(r),
  remove:  (r) => r === "admin",
  admin:   (r) => r === "admin",
  comment: (r) => r !== null,
  editable(r, key) {
    if (this.editAll(r)) return true;
    if (r === "sales") return SALES_EDITABLE.includes(key);
    return false;
  },
};

/* ==========================================================================
   STATE
   ========================================================================== */
const S = {
  store: null,
  me: null,
  leads: [],
  clients: [],
  users: [],
  invites: [],
  exports: [],
  feed: [],
  tab: "review",
  /* per-stream filter + sort state */
  view: {
    sales_partner: { q: "", status: "", owner: "", client: "", attn: false, sort: "createdAt", dir: -1 },
    client:        { q: "", status: "", owner: "", client: "", attn: false, sort: "createdAt", dir: -1 },
  },
  drawer: { leadId: null, mode: null, tab: "details" },
  bookingFor: null,   // lead the Cal modal was opened for
  unsubActivity: null,
  drawerActivity: [],
};

const clientName = (id) => S.clients.find((c) => c.id === id)?.name || "";

/* ==========================================================================
   COPY GUARD
   Copy / cut / right-click are suppressed on data surfaces so the tracked
   Excel export is the only sanctioned way data leaves this dashboard. Form
   controls stay untouched so people can still type and paste.
   ========================================================================== */
function installCopyGuard() {
  const inField = (t) => t && t.closest && t.closest("input, textarea, select, [contenteditable]");
  const guard = (e) => {
    if (inField(e.target)) return;
    if (!e.target.closest || !e.target.closest(".noselect, .drawer")) return;
    e.preventDefault();
    toast("Copying is off. Use Export to Excel — every export is logged.", "warn");
  };
  document.addEventListener("copy", guard);
  document.addEventListener("cut", guard);
  document.addEventListener("contextmenu", (e) => {
    if (inField(e.target)) return;
    if (e.target.closest && e.target.closest(".noselect, .drawer")) e.preventDefault();
  });
  document.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && ["c", "x"].includes(k) && !inField(e.target)) {
      e.preventDefault();
      toast("Copying is off. Use Export to Excel — every export is logged.", "warn");
    }
  });
}

/* ==========================================================================
   BOOT
   ========================================================================== */
/* Embedded in a page builder there is no <head> of ours to carry a robots
   meta, so it is added at runtime. See NOINDEX in config.js for the two
   caveats: it applies to the whole host page, and a JS-injected tag is
   honoured by Google but not by every crawler. */
/* Pin the embedded block to the window's edges.

   The CSS in the GHL build does this with calc(50% - 50vw), which gets it
   right immediately but is off by the scrollbar width — 100vw counts the
   scrollbar, the usable width doesn't, and the difference shows up as a
   horizontal scrollbar on mobile. Measuring gives the exact number, so the
   CSS handles the first paint and this corrects it. No-ops on the standalone
   page, which has no #llb-root to break out of. */
function applyFullBleed() {
  const root = document.getElementById("llb-root");
  if (!root) return;

  const fit = () => {
    // Measure where the block would naturally sit, with the overrides off.
    const set = (prop, val) => root.style.setProperty(prop, val, "important");
    set("width", "auto"); set("margin-left", "0"); set("margin-right", "0");
    const { left, width: hostWidth } = root.getBoundingClientRect();
    const docWidth = document.documentElement.clientWidth;

    // The two margins have to add back to the host's content width, or the
    // host box itself overflows by its own padding and the page scrolls
    // sideways — which is exactly what a bare -50vw on both sides gets wrong.
    set("width", docWidth + "px");
    set("margin-left", -left + "px");
    set("margin-right", hostWidth - docWidth + left + "px");
  };

  fit();
  addEventListener("resize", fit, { passive: true });
}

function applyNoindex() {
  if (!NOINDEX || document.getElementById("llb-robots")) return;
  const m = document.createElement("meta");
  m.id = "llb-robots";
  m.name = "robots";
  m.content = "noindex, nofollow, noarchive, nosnippet";
  (document.head || document.documentElement).appendChild(m);
}

(async function boot() {
  applyNoindex();
  if (FULL_BLEED) applyFullBleed();
  installCopyGuard();

  try {
    S.store = await openStore();
  } catch (ex) {
    // Never leave a blank page. Say what happened and offer the one useful
    // action, rather than silently degrading to sample data.
    showLogin(ex?.message || "Couldn't start. Reload and try again.");
    $("#liGoogle")?.classList.add("hide");
    $("#loginForm")?.classList.add("hide");
    $("#liPhoneBlock")?.classList.add("hide");
    $("#liOr")?.classList.add("hide");
    return;
  }

  if (S.store.mode === "demo") $("#demobar").classList.remove("hide");

  // Someone arriving from an invite email lands here with a sign-in link in
  // the URL. Complete that before deciding whether to show the login form.
  await S.store.resolveRedirect?.();
  if (S.store.isInviteLink()) await completeInviteSignIn();

  S.store.onAuth((profile) => {
    S.me = profile;
    if (!profile) return showLogin();
    if (profile.pending) {
      showLogin("You're signed in, but nobody has given you access yet. Ask an admin to invite you.");
      S.store.signOut();
      return;
    }
    showApp();
  });

  wireLogin();
  wireChrome();
  wireCalBookings();
})();

/* ==========================================================================
   LOGIN
   ========================================================================== */
function showLogin(msg) {
  $("#login").classList.remove("hide");
  $("#app").classList.add("hide");
  if (msg) {
    $("#loginErr").textContent = msg;
    $("#loginErr").classList.remove("hide");
  }
}

/* Finishes an invite: exchanges the emailed link for a session. The address is
   normally remembered from the browser that requested it; if they opened the
   link on a different device we have to ask, because Firebase requires the
   email to match the one the link was issued for. */
async function completeInviteSignIn() {
  let email = "";
  try { email = localStorage.getItem("leads:inviteEmail") || ""; } catch {}
  if (!email) email = prompt("Confirm the email address this invite was sent to:") || "";
  if (!email) return;

  try {
    await S.store.signInWithLink(email);
    try { localStorage.removeItem("leads:inviteEmail"); } catch {}
    // Drop the one-time link from the address bar so a refresh doesn't retry it.
    history.replaceState(null, "", location.pathname);
    toast("You're in. Set a password any time from Forgot your password.", "good");
  } catch (ex) {
    console.error(ex);
    showLogin(
      ex?.code?.includes("invalid-action-code")
        ? "That invite link has already been used or has expired. Ask an admin to resend it."
        : "We couldn't complete that invite link. Ask an admin to resend it."
    );
  }
}

function wireLogin() {
  const err = $("#loginErr");
  const ok = $("#loginOk");
  const say = (el, msg) => { el.textContent = msg; el.classList.remove("hide"); };
  const clear = () => { err.classList.add("hide"); ok.classList.add("hide"); };

  /* Only show the methods that are switched on in config.js. Password and
     email link are independent — with both on you get a password form plus a
     "send me a link instead" button, not one or the other. */
  const on = (sel, yes) => $(sel)?.classList.toggle("hide", !yes);
  on("#liMicrosoft", AUTH.microsoft);
  on("#liGoogle", AUTH.google);
  on("#loginForm", AUTH.emailLink || AUTH.password);
  on("#liPhoneBlock", AUTH.phone);
  on("#liOr", (AUTH.microsoft || AUTH.google) && (AUTH.emailLink || AUTH.password));
  on("#liPassWrap", AUTH.password);
  on("#liForgot", AUTH.password);
  on("#liLinkBtn", AUTH.emailLink && AUTH.password);
  if (!AUTH.password) $("#liBtn").textContent = "Email me a sign-in link";

  const sendLink = async (btn) => {
    clear();
    const email = $("#liEmail").value.trim();
    if (!email) { say(err, "Enter your email first."); return; }
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Sending…";
    try {
      await S.store.sendSignInLink(email);
      say(ok, `Link sent to ${email}. Open it on this device. If it hasn't arrived in a minute, check spam.`);
    } catch (ex) {
      say(err, loginError(ex));
    } finally { btn.disabled = false; btn.textContent = label; }
  };
  $("#liLinkBtn")?.addEventListener("click", (e) => sendLink(e.currentTarget));

  /* ---- Microsoft and Google ---- */
  const federated = (sel, kind) => $(sel)?.addEventListener("click", async (e) => {
    clear();
    const b = e.currentTarget;
    b.disabled = true;
    try {
      await S.store.signInWithProvider(kind);
    } catch (ex) {
      // Closing the window is a decision, not an error worth shouting about.
      if (!/popup-closed|cancelled/.test(ex?.code || "")) say(err, loginError(ex));
    } finally { b.disabled = false; }
  });
  federated("#liMicrosoft", "microsoft");
  federated("#liGoogle", "google");

  /* ---- Email: link, or password when that is the configured method ---- */
  $("#loginForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    clear();
    const email = $("#liEmail").value.trim();
    const btn = $("#liBtn");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Working…";
    try {
      if (AUTH.password) {
        await S.store.signIn(email, $("#liPass").value);
      } else {
        await S.store.sendSignInLink(email);
        say(ok, `Link sent to ${email}. Open it on this device. If it hasn't arrived in a minute, check spam.`);
      }
    } catch (ex) {
      say(err, loginError(ex));
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  /* ---- Phone OTP: one button that sends, then confirms ---- */
  const phoneBtn = $("#liPhoneBtn");
  phoneBtn?.addEventListener("click", async () => {
    clear();
    const sending = $("#liCodeWrap").classList.contains("hide");
    phoneBtn.disabled = true;
    const label = phoneBtn.textContent;
    phoneBtn.textContent = sending ? "Sending…" : "Checking…";
    try {
      if (sending) {
        const raw = $("#liPhone").value.trim();
        if (!/^\+[1-9]\d{7,14}$/.test(raw.replace(/[\s()-]/g, ""))) {
          throw new Error("Include the country code, like +91 98765 43210.");
        }
        await S.store.sendPhoneCode(raw.replace(/[\s()-]/g, ""), "recaptcha");
        $("#liCodeWrap").classList.remove("hide");
        $("#liCode").focus();
        say(ok, `Code sent to ${raw}.`);
        phoneBtn.textContent = "Sign in";
      } else {
        await S.store.confirmPhoneCode($("#liCode").value.trim());
      }
    } catch (ex) {
      say(err, loginError(ex));
      phoneBtn.textContent = label;
    } finally { phoneBtn.disabled = false; }
  });

  $("#liForgot")?.addEventListener("click", async () => {
    const email = $("#liEmail").value.trim();
    if (!email) return toast("Type your email above first.", "warn");
    try {
      await S.store.resetPassword(email);
      toast("Password reset email sent.", "good");
    } catch (ex) { toast(loginError(ex), "bad"); }
  });
}

function loginError(ex) {
  const code = ex?.code || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found"))
    return "That email and password don't match.";
  if (code.includes("too-many-requests")) return "Too many attempts. Wait a few minutes, then try again.";
  if (code.includes("network")) return "Can't reach the server. Check your connection.";
  if (code.includes("popup-blocked")) return "Your browser blocked the Google window. Allow popups for this site, or use the email link instead.";
  if (code.includes("account-exists-with-different-credential"))
    return "That address is already signed up with a different method. Use the one you used originally.";
  if (code.includes("unauthorized-domain"))
    return "This site isn't on the Firebase authorised-domains list yet. An admin needs to add it.";
  if (code.includes("operation-not-allowed"))
    return "That sign-in method isn't switched on in Firebase yet. An admin needs to enable it.";
  if (code.includes("invalid-phone-number")) return "That number doesn't look right. Include the country code, like +91.";
  if (code.includes("invalid-verification-code")) return "That code isn't right. Check it and try again.";
  if (code.includes("code-expired")) return "That code has expired. Ask for a new one.";
  if (code.includes("missing-phone-number")) return "Enter your mobile number first.";
  if (code.includes("captcha-check-failed")) return "The robot check failed. Reload the page and try again.";
  if (code.includes("quota-exceeded")) return "The SMS quota for today is used up. Use Google or the email link instead.";
  return ex?.message || "Something went wrong. Try again.";
}

/* ==========================================================================
   APP SHELL
   ========================================================================== */
function showApp() {
  $("#login").classList.add("hide");
  $("#app").classList.remove("hide");

  const name = S.me.name || S.me.email;
  $("#meName").textContent = name;
  $("#meRole").textContent = ROLES[S.me.role]?.label || "No role";
  $("#meAvatar").textContent = initials(name);
  $("#tabAdmin").classList.toggle("hide", !can.admin(S.me.role));

  // Live subscriptions. Each fires immediately with current data.
  S.store.watchLeads((rows) => { S.leads = rows; renderAll(); });
  S.store.watchClients((rows) => { S.clients = rows; renderAll(); });
  S.store.watchExports((rows) => { S.exports = rows; renderExports(); });
  S.store.watchRecentActivity((rows) => { S.feed = rows; renderFeed(); });
  if (can.admin(S.me.role)) {
    wireInvites();
    S.store.watchUsers((rows) => { S.users = rows; renderUsers(); });
    S.store.watchInvites((rows) => { S.invites = rows; renderInvites(); });
  }
}

function wireChrome() {
  $("#signOut").addEventListener("click", () => S.store.signOut());

  $("#tabs").addEventListener("click", (e) => {
    const t = e.target.closest(".tab");
    if (!t) return;
    S.tab = t.dataset.tab;
    $$(".tab").forEach((x) => x.classList.toggle("on", x === t));
    $$(".panel").forEach((p) => p.classList.toggle("on", p.dataset.panel === S.tab));
  });

  $("#drClose").addEventListener("click", closeDrawer);
  $("#scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

  $("#addClient").addEventListener("click", async () => {
    const name = $("#newClient").value.trim();
    if (!name) return;
    await S.store.saveClient(null, { name, active: true });
    $("#newClient").value = "";
    toast("Client added.", "good");
  });
}

function renderAll() {
  renderReview();
  renderClients();
  renderFeed();
  if (can.admin(S.me?.role)) renderInvites();
  renderStream("sales_partner");
  renderStream("client");
  $("#cntSales").textContent = S.leads.filter((l) => l.stream === "sales_partner").length;
  $("#cntClient").textContent = S.leads.filter((l) => l.stream === "client").length;
  if (S.drawer.leadId) renderDrawer();
}

/* ==========================================================================
   REVIEW TAB
   ========================================================================== */
function isStale(l) {
  return OPEN_STAGES.includes(l.status) && daysSince(l.lastActivityAt || l.updatedAt || l.createdAt) >= STALE_DAYS;
}

function renderReview() {
  const since = lastReviewStart();
  const L = S.leads;
  const newSince = L.filter((l) => asDate(l.createdAt) >= since);
  const stale = L.filter(isStale);
  const open = L.filter((l) => OPEN_STAGES.includes(l.status));

  $("#reviewHint").textContent =
    `Since the last review call — ${since.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" })}`;

  const meetings = L.filter((l) => ["meeting", "proposal"].includes(l.status)).length;
  const won = L.filter((l) => l.status === "won").length;

  $("#reviewLine").innerHTML = heroSentence(L, newSince.length, stale.length, meetings);

  /* Plain counts. Every one of these is just "how many leads are in this
     state" — nothing averaged, nothing derived. The label carries its own
     timeframe, since "new" alone reads as all-time at a glance. */
  $("#statTiles").innerHTML = [
    { k: "New since last call", v: newSince.length, d: `${L.length} leads all time` },
    { k: "Open pipeline", v: open.length, d: "not won or lost" },
    { k: "Meetings booked", v: meetings, d: "meeting or proposal", cls: meetings ? "good" : "" },
    { k: "Won", v: won, d: "closed and won", cls: won ? "good" : "" },
    { k: "Needs attention", v: stale.length, d: `no activity in ${STALE_DAYS}+ days`, cls: stale.length ? "alert" : "" },
  ].map((t) => `
    <div class="stat ${t.cls || ""}">
      <div class="k" title="${esc(t.k)}">${esc(t.k)}</div>
      <div class="v">${t.v}</div>
      <div class="d">${esc(t.d)}</div>
    </div>`).join("");

  /* ---- pipeline strip: stages left to right, with the conversion between
         each pair in the gap ---- */
  const fs = STAGES.filter((s) => s.funnel);
  const counts = fs.map((s) => L.filter((l) => l.status === s.key).length);
  const openTotal = counts.reduce((a, b) => a + b, 0);

  const blocks = fs.map((s, i) => {
    const n = counts[i];
    const pct = openTotal ? Math.round((n / openTotal) * 100) : 0;
    return `<div class="pipe-step${n ? "" : " is-empty"}" style="--step:${s.ink}">
      <div class="n">${n}</div>
      <div class="k">${esc(s.short || s.label)}</div>
      <div class="p">${pct}% of open</div>
    </div>`;
  });

  /* Between two stages, show how many of everything that reached the earlier
     stage is now at or beyond the later one — the "did it actually move?"
     number, not a raw ratio of two snapshots. */
  const reached = (i) => counts.slice(i).reduce((a, b) => a + b, 0);
  const arrows = fs.slice(0, -1).map((_, i) => {
    const from = reached(i), to = reached(i + 1);
    const pct = from ? Math.round((to / from) * 100) : 0;
    return `<div class="pipe-arrow" title="${to} of ${from} moved past ${esc(fs[i].short)}">
      <div class="g">›</div><div class="c">${from ? pct + "%" : "—"}</div>
    </div>`;
  });

  $("#pipeChart").innerHTML = openTotal || L.length
    ? blocks.map((b, i) => b + (arrows[i] || "")).join("")
    : emptyChart("No leads yet.");

  $("#outcomeChart").innerHTML = STAGES.filter((s) => !s.funnel).map((s) => {
    const n = L.filter((l) => l.status === s.key).length;
    return `<span class="outcome" style="border-color:${s.line};background:${s.outline ? "transparent" : s.tint}">
      <span class="n" style="color:${s.ink}">${n}</span>
      <span class="k">${esc(s.label)}</span>
    </span>`;
  }).join("") + `<span class="outcome" style="border-style:dashed">
      <span class="k">${esc(winRateLabel(L))}</span></span>`;

  /* ---- needs attention ---- */
  const attn = [...stale].sort(
    (a, b) => daysSince(b.lastActivityAt || b.createdAt) - daysSince(a.lastActivityAt || a.createdAt)
  ).slice(0, 12);

  const card = $("#attnCard");
  
  $("#attnIcon").textContent = stale.length ? "!" : "\u2713";
  card.classList.toggle("clear", stale.length === 0);
  $("#attnTitle").textContent = stale.length
    ? `${stale.length} lead${stale.length > 1 ? "s" : ""} going cold`
    : "Nothing is slipping";
  $("#attnHint").textContent = stale.length
    ? `No activity in ${STALE_DAYS}+ days. Work down this list on the call.`
    : `Every open lead has been touched in the last ${STALE_DAYS} days.`;

  $("#attnList").innerHTML = attn.length
    ? `<div class="list">${attn.map((l) => `
        <div class="li" data-openlead="${esc(l.id)}" style="cursor:pointer">
          <div class="grow">
            <div class="t">${esc(fullName(l))} <span class="muted" style="font-weight:600">· ${esc(l.company || "")}</span></div>
            <div class="s">${esc(streamLabel(l))} · owner ${esc(l.salesOwner || l.createdByName || "unassigned")}</div>
          </div>
          ${pill(l.status)}
          <span class="pill pill-warn"><span class="dot"></span>${daysSince(l.lastActivityAt || l.createdAt)}d idle</span>
        </div>`).join("")}</div>`
    : `<div class="card-body"><p class="muted">Every open lead has been touched in the last ${STALE_DAYS} days.</p></div>`;

  $("#attnList").onclick = (e) => {
    const row = e.target.closest("[data-openlead]");
    if (row) openDrawer(row.dataset.openlead);
  };

  /* ---- created by team member ---- */
  const byWho = tally(L, (l) => l.createdByName || "Unknown");
  $("#byWhoChart").innerHTML = barChart(byWho);
  $("#byWhoHint").textContent = `${L.length} leads all time`;

  /* ---- by client ---- */
  const clientLeads = L.filter((l) => l.stream === "client");
  const byClient = tally(clientLeads, (l) => clientName(l.clientId) || "Unassigned");
  $("#byClientChart").innerHTML = barChart(byClient, "No client leads yet.");

  /* ---- per week, last 8 weeks ---- */
  $("#byWeekChart").innerHTML = weekChart(L);
}

/* One plain sentence naming the thing that most deserves attention right now.
   Ordered by what would actually change the conversation on the call. */
function heroSentence(L, created, stale, meetings) {
  if (!L.length) return "No leads yet — add the first one from the Summit Sales tab.";
  if (stale) {
    return `<b>${stale}</b> open lead${stale > 1 ? "s have" : " has"} gone quiet for ${STALE_DAYS}+ days.`;
  }
  if (created && meetings) {
    return `<b>${created}</b> new lead${created > 1 ? "s" : ""} since the last call, and <b>${meetings}</b> in play.`;
  }
  if (created) return `<b>${created}</b> new lead${created > 1 ? "s" : ""} logged since the last call.`;
  if (meetings) return `Nothing new since the last call, but <b>${meetings}</b> still in play.`;
  return "Nothing new since the last call.";
}

function winRateLabel(L) {
  const closed = L.filter((l) => ["won", "lost"].includes(l.status)).length;
  const won = L.filter((l) => l.status === "won").length;
  return closed ? `${Math.round((won / closed) * 100)}% of closed leads` : "No closed leads yet";
}

function tally(rows, keyFn) {
  const m = new Map();
  rows.forEach((r) => { const k = keyFn(r); m.set(k, (m.get(k) || 0) + 1); });
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function emptyChart(msg) { return `<div class="empty-chart">${esc(msg)}</div>`; }

/* Single-series magnitude bars: length carries the value, every bar is
   directly labelled, so no legend and no colour encoding is needed. */
function barChart(pairs, emptyMsg = "Nothing to show yet.") {
  if (!pairs.length) return emptyChart(emptyMsg);
  const top = Math.max(...pairs.map((p) => p[1]), 1);
  return pairs.slice(0, 10).map(([label, n]) => `
    <div class="bar-row${n === 0 ? " is-zero" : ""}">
      <div class="bar-lab" title="${esc(label)}">${esc(label)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(n / top) * 100}%"></div></div>
      <div class="bar-val num">${n}</div>
    </div>`).join("");
}

function weekChart(L) {
  const weeks = [];
  const monday = new Date();
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7)); // this week's Monday
  for (let i = 7; i >= 0; i--) {
    const start = new Date(monday.getTime() - i * 7 * DAY);
    const end = new Date(start.getTime() + 7 * DAY);
    const n = L.filter((l) => { const d = asDate(l.createdAt); return d >= start && d < end; }).length;
    weeks.push([start.toLocaleDateString(undefined, { day: "numeric", month: "short" }), n]);
  }
  if (!weeks.some((w) => w[1] > 0)) return emptyChart("No leads created in the last 8 weeks.");
  const top = Math.max(...weeks.map((w) => w[1]), 1);
  return weeks.map(([label, n]) => `
    <div class="bar-row${n === 0 ? " is-zero" : ""}">
      <div class="bar-lab">w/c ${esc(label)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(n / top) * 100}%"></div></div>
      <div class="bar-val num">${n}</div>
    </div>`).join("");
}

/* ==========================================================================
   PILLS
   ========================================================================== */
/* Each stage owns one ink and one tint (see STAGES in config.js), applied
   inline so the pill, the dot, the row stripe and the funnel bar can never
   drift apart into separate colour systems. */
function pill(statusKey) {
  const s = stage(statusKey);
  const bg = s.outline ? "transparent" : s.tint;
  const dash = s.outline ? "border-style:dashed;" : "";
  return `<span class="pill" style="color:${s.ink};background:${bg};border-color:${s.line};${dash}">
    <span class="dot"></span>${esc(s.label)}</span>`;
}
function streamLabel(l) {
  if (l.stream === "client") {
    const c = clientName(l.clientId);
    return c ? `Client · ${c}` : "Client · unassigned";
  }
  return STREAMS.sales_partner.short;
}

/* ==========================================================================
   LEAD STREAM (table + toolbar) — one function drives both tabs
   ========================================================================== */
const COLUMNS = {
  sales_partner: [
    { key: "name",      label: "Lead",          sort: "firstName" },
    { key: "company",   label: "Company",       sort: "company" },
    { key: "status",    label: "Stage",         sort: "status" },
    { key: "salesOwner",label: "Sales Owner",   sort: "salesOwner" },
    { key: "sharedOn",  label: "Shared",        sort: "sharedOn" },
    { key: "createdByName", label: "Added By",  sort: "createdByName" },
    { key: "activity",  label: "Last Activity", sort: "lastActivityAt" },
  ],
  client: [
    { key: "name",      label: "Lead",          sort: "firstName" },
    { key: "company",   label: "Company",       sort: "company" },
    { key: "clientId",  label: "Client",        sort: "clientId" },
    { key: "status",    label: "Stage",         sort: "status" },
    { key: "sharedOn",  label: "Delivered",     sort: "sharedOn" },
    { key: "createdByName", label: "Added By",  sort: "createdByName" },
    { key: "activity",  label: "Last Activity", sort: "lastActivityAt" },
  ],
};

function filteredLeads(streamKey) {
  const v = S.view[streamKey];
  const q = v.q.trim().toLowerCase();
  let rows = S.leads.filter((l) => l.stream === streamKey);

  if (q) {
    rows = rows.filter((l) =>
      LEAD_FIELDS.some((f) => String(l[f.key] ?? "").toLowerCase().includes(q)) ||
      String(l.createdByName ?? "").toLowerCase().includes(q) ||
      clientName(l.clientId).toLowerCase().includes(q));
  }
  if (v.status) rows = rows.filter((l) => l.status === v.status);
  if (v.owner)  rows = rows.filter((l) => (l.createdByName || "Unknown") === v.owner);
  if (v.client) rows = rows.filter((l) => l.clientId === v.client);
  if (v.attn)   rows = rows.filter(isStale);

  const dir = v.dir;
  rows.sort((a, b) => {
    let x = a[v.sort] ?? "", y = b[v.sort] ?? "";
    if (v.sort === "status") { x = STAGES.findIndex((s) => s.key === x); y = STAGES.findIndex((s) => s.key === y); }
    if (v.sort === "clientId") { x = clientName(x); y = clientName(y); }
    if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
    return String(x).localeCompare(String(y), undefined, { numeric: true }) * dir;
  });
  return rows;
}

function renderStream(streamKey) {
  const v = S.view[streamKey];
  const rows = filteredLeads(streamKey);
  const owners = [...new Set(S.leads.filter((l) => l.stream === streamKey).map((l) => l.createdByName || "Unknown"))].sort();

  /* ---- toolbar ---- */
  $(`#toolbar_${streamKey}`).innerHTML = `
    <div class="toolbar">
      <div class="fld search">
        <label for="q_${streamKey}">Search</label>
        <input class="inp" id="q_${streamKey}" placeholder="Name, company, title, email, notes…" value="${esc(v.q)}">
      </div>
      <div class="fld">
        <label for="st_${streamKey}">Stage</label>
        <select class="inp" id="st_${streamKey}">
          <option value="">All stages</option>
          ${STAGES.map((s) => `<option value="${s.key}"${v.status === s.key ? " selected" : ""}>${esc(s.label)}</option>`).join("")}
        </select>
      </div>
      <div class="fld">
        <label for="ow_${streamKey}">Added by</label>
        <select class="inp" id="ow_${streamKey}">
          <option value="">Everyone</option>
          ${owners.map((o) => `<option value="${esc(o)}"${v.owner === o ? " selected" : ""}>${esc(o)}</option>`).join("")}
        </select>
      </div>
      ${streamKey === "client" ? `
      <div class="fld">
        <label for="cl_${streamKey}">Client</label>
        <select class="inp" id="cl_${streamKey}">
          <option value="">All clients</option>
          ${S.clients.map((c) => `<option value="${esc(c.id)}"${v.client === c.id ? " selected" : ""}>${esc(c.name)}</option>`).join("")}
        </select>
      </div>` : ""}
      <div class="fld">
        <label>&nbsp;</label>
        <button class="btn btn-sm ${v.attn ? "btn-dark" : "btn-ghost"}" id="attn_${streamKey}">
          Needs attention${v.attn ? " ✓" : ""}
        </button>
      </div>
      <div class="spacer"></div>
      <div class="fld">
        <label>&nbsp;</label>
        <div style="display:flex; gap:8px">
          <button class="btn btn-sm btn-ghost" id="exp_${streamKey}">Export to Excel</button>
          ${can.create(S.me.role)
            ? `<button class="btn btn-sm btn-primary" id="add_${streamKey}">+ Add Lead</button>` : ""}
        </div>
      </div>
    </div>`;

  const bind = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
  bind(`#q_${streamKey}`, "input", (e) => {
    v.q = e.target.value;
    const pos = e.target.selectionStart;
    renderStream(streamKey);
    const again = $(`#q_${streamKey}`);
    again.focus();
    again.setSelectionRange(pos, pos);
  });
  bind(`#st_${streamKey}`, "change", (e) => { v.status = e.target.value; renderStream(streamKey); });
  bind(`#ow_${streamKey}`, "change", (e) => { v.owner = e.target.value; renderStream(streamKey); });
  bind(`#cl_${streamKey}`, "change", (e) => { v.client = e.target.value; renderStream(streamKey); });
  bind(`#attn_${streamKey}`, "click", () => { v.attn = !v.attn; renderStream(streamKey); });
  bind(`#exp_${streamKey}`, "click", () => exportLeads(streamKey, rows));
  bind(`#add_${streamKey}`, "click", () => openDrawer(null, streamKey));

  /* ---- table ---- */
  const cols = COLUMNS[streamKey];
  const host = $(`#table_${streamKey}`);

  if (!rows.length) {
    const anyInStream = S.leads.some((l) => l.stream === streamKey);
    host.innerHTML = `<div class="tbl-wrap"><div class="tbl-empty">
      <div class="big">${anyInStream ? "No leads match these filters" : "No leads here yet"}</div>
      <div style="font-size:13px">${anyInStream
        ? "Clear the search or filters above."
        : can.create(S.me.role) ? "Add the first one with the button above." : "Nothing has been added to this stream."}</div>
    </div></div>`;
    return;
  }

  host.innerHTML = `
    <div class="tbl-wrap">
      <table class="leads">
        <thead><tr>${cols.map((c) => `
          <th data-sort="${c.sort}">${esc(c.label)}
            <span class="arw">${v.sort === c.sort ? (v.dir === 1 ? "▲" : "▼") : ""}</span>
          </th>`).join("")}</tr></thead>
        <tbody>${rows.map((l) => `
          <tr data-id="${esc(l.id)}" style="--stripe:${stage(l.status).ink}"${isStale(l) ? ' class="stale"' : ""}>
            ${cols.map((c) => `<td>${cellHtml(c.key, l)}</td>`).join("")}</tr>`).join("")}
        </tbody>
      </table>
    </div>
    <p class="tbl-note">${rows.length} lead${rows.length === 1 ? "" : "s"} · click a row to open it</p>`;

  host.querySelector("thead").addEventListener("click", (e) => {
    const th = e.target.closest("th");
    if (!th) return;
    const key = th.dataset.sort;
    if (v.sort === key) v.dir *= -1; else { v.sort = key; v.dir = 1; }
    renderStream(streamKey);
  });
  host.querySelector("tbody").addEventListener("click", (e) => {
    const tr = e.target.closest("tr");
    if (tr) openDrawer(tr.dataset.id);
  });
}

function cellHtml(key, l) {
  switch (key) {
    case "name":
      return `<div class="cell-name">${esc(fullName(l))}</div>
              <div class="cell-sub">${esc(l.jobTitle || "—")}</div>`;
    case "company":
      return `<div style="font-weight:600">${esc(l.company || "—")}</div>
              <div class="cell-sub">${esc(l.industry || l.country || "")}</div>`;
    case "status":
      return pill(l.status);
    case "clientId":
      return `<span class="pill pill-stream">${esc(clientName(l.clientId) || "Unassigned")}</span>`;
    case "sharedOn":
      return `<span class="${l.sharedOn ? "" : "cell-dim"}">${esc(l.sharedOn ? fmtDate(l.sharedOn) : "not yet")}</span>`;
    case "activity": {
      const d = daysSince(l.lastActivityAt || l.createdAt);
      const late = OPEN_STAGES.includes(l.status) && d >= STALE_DAYS;
      return `<span class="${late ? "" : "cell-dim"}" style="${late ? "color:var(--warn);font-weight:700" : ""}">
                ${esc(fmtWhen(l.lastActivityAt || l.createdAt))}</span>`;
    }
    default:
      return `<span class="${l[key] ? "" : "cell-dim"}">${esc(l[key] || "—")}</span>`;
  }
}

/* ==========================================================================
   DRAWER — lead detail, edit, comments
   ========================================================================== */
function openDrawer(leadId, streamKey) {
  S.drawer = { leadId, mode: leadId ? "read" : "new", tab: "details", stream: streamKey || "sales_partner" };
  S.drawerActivity = [];
  if (S.unsubActivity) { S.unsubActivity(); S.unsubActivity = null; }
  if (leadId) {
    S.unsubActivity = S.store.watchActivity(leadId, (rows) => {
      S.drawerActivity = rows;
      if (S.drawer.leadId === leadId) renderDrawer();
    });
  }
  $("#drawer").classList.add("on");
  $("#drawer").setAttribute("aria-hidden", "false");
  $("#scrim").classList.add("on");
  renderDrawer();
}

function closeDrawer() {
  $("#drawer").classList.remove("on");
  $("#drawer").setAttribute("aria-hidden", "true");
  $("#scrim").classList.remove("on");
  if (S.unsubActivity) { S.unsubActivity(); S.unsubActivity = null; }
  S.drawer = { leadId: null, mode: null, tab: "details" };
}

function renderDrawer() {
  const d = S.drawer;
  const isNew = d.mode === "new";
  const lead = isNew ? null : S.leads.find((l) => l.id === d.leadId);
  if (!isNew && !lead) return closeDrawer();

  $("#drTitle").textContent = isNew ? "New lead" : fullName(lead);
  $("#drSub").innerHTML = isNew
    ? esc(STREAMS[d.stream].label)
    : `${esc(lead.jobTitle || "")}${lead.jobTitle && lead.company ? " · " : ""}${esc(lead.company || "")}
       <span style="opacity:.6"> — added by ${esc(lead.createdByName || "?")} ${esc(fmtWhen(lead.createdAt))}</span>`;

  if (isNew || d.mode === "edit") return renderForm(lead, d.stream);

  /* ---- read view ---- */
  const body = $("#drBody");
  body.innerHTML = `
    <div class="dr-tabs">
      <button class="dr-tab ${d.tab === "details" ? "on" : ""}" data-drtab="details">Details</button>
      <button class="dr-tab ${d.tab === "activity" ? "on" : ""}" data-drtab="activity">
        Activity${S.drawerActivity.length ? ` (${S.drawerActivity.length})` : ""}
      </button>
    </div>
    ${d.tab === "details" ? detailsHtml(lead) : activityHtml(lead)}`;

  body.querySelectorAll("[data-drtab]").forEach((b) =>
    b.addEventListener("click", () => { S.drawer.tab = b.dataset.drtab; renderDrawer(); }));

  if (d.tab === "activity") wireCommentBox(lead);

  /* ---- footer ---- */
  const canEdit = can.edit(S.me.role);
  $("#drFoot").innerHTML = `
    ${canEdit ? bookButton(lead) : ""}
    ${canEdit ? `<button class="btn btn-sm btn-ghost" id="drEdit">Edit lead</button>` : ""}
    ${canEdit ? `<select class="inp" id="drStage" style="max-width:190px">
        ${STAGES.map((s) => `<option value="${s.key}"${lead.status === s.key ? " selected" : ""}>${esc(s.label)}</option>`).join("")}
      </select>` : ""}
    <div style="flex:1"></div>
    ${can.remove(S.me.role) ? `<button class="btn btn-sm btn-danger" id="drDel">Delete</button>` : ""}`;

  if (canEdit) {
    $("#drEdit").addEventListener("click", () => { S.drawer.mode = "edit"; renderDrawer(); });
    $("#drStage").addEventListener("change", (e) => changeStage(lead, e.target.value));
    // Remember which lead the booking modal was opened for, so the completed
    // booking can be attached to the right record.
    $("#drBook")?.addEventListener("click", () => { S.bookingFor = lead.id; });
  }
  if (can.remove(S.me.role)) {
    $("#drDel").addEventListener("click", async () => {
      if (!confirm(`Delete ${fullName(lead)} for everyone?\n\nThe lead row goes; its activity entries stay in the audit trail. Consider marking it Lost instead.`)) return;
      await S.store.deleteLead(lead.id);
      closeDrawer();
      toast("Lead deleted.", "bad");
    });
  }
}

function detailsHtml(lead) {
  const groups = FIELD_GROUPS.map((g) => {
    const fields = LEAD_FIELDS.filter((f) => f.group === g && lead[f.key] !== undefined && lead[f.key] !== "");
    if (!fields.length) return "";
    return `<fieldset class="grp">
      <legend>${esc(g)}</legend>
      <div class="kv">${fields.map((f) => `
        <div class="row">
          <div class="k">${esc(f.label)}</div>
          <div class="v">${valueHtml(f, lead[f.key])}</div>
        </div>`).join("")}</div>
    </fieldset>`;
  }).join("");

  return `
    <fieldset class="grp">
      <legend>Status</legend>
      <div class="kv">
        <div class="row"><div class="k">Stage</div><div class="v">${pill(lead.status)}</div></div>
        <div class="row"><div class="k">Stream</div><div class="v">${esc(streamLabel(lead))}</div></div>
        <div class="row"><div class="k">Added by</div><div class="v">${esc(lead.createdByName || "—")}</div></div>
        <div class="row"><div class="k">Last activity</div><div class="v">${esc(fmtWhen(lead.lastActivityAt || lead.createdAt))}</div></div>
      </div>
    </fieldset>
    ${groups || `<p class="muted" style="font-size:13px">No other details filled in yet.</p>`}`;
}

function valueHtml(f, v) {
  if (v === "" || v == null) return `<span class="blank">—</span>`;
  if (f.type === "url") return `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer">${esc(shortUrl(v))} ↗</a>`;
  if (f.type === "email") return `<a href="mailto:${esc(v)}">${esc(v)}</a>`;
  if (f.type === "tel") return `<a href="tel:${esc(v)}">${esc(v)}</a>`;
  if (f.type === "date") return esc(fmtDate(v));
  if (f.key === "dealValue") return esc(`$${Number(v).toLocaleString()}`);
  return esc(v);
}
const shortUrl = (u) => String(u).replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "").slice(0, 42);

/* ---- activity + comments ---- */
function activityHtml(lead) {
  const rows = S.drawerActivity;
  return `
    <div class="feed">${rows.length
      ? rows.map(feedItem).join("")
      : `<p class="muted" style="padding:6px 0">No activity yet. Add the first comment below.</p>`}
    </div>
    ${can.comment(S.me.role) ? `
    <div class="cbox">
      <div class="fld" style="flex:1">
        <label for="cmt">Add a comment</label>
        <textarea class="inp" id="cmt" placeholder="What happened with this lead?"></textarea>
      </div>
      <button class="btn btn-sm btn-dark" id="cmtBtn">Post</button>
    </div>` : ""}`;
}

function feedItem(a, subtitle = "") {
  const icon = a.type === "comment" ? "C" : a.type === "stage" ? "→" : "+";
  const cls  = a.type === "comment" ? "comment" : a.type === "stage" ? "stage" : "";
  return `<div class="fe" data-leadid="${esc(a.leadId || "")}">
    <div class="fe-ic ${cls}">${icon}</div>
    <div style="min-width:0">
      <div class="fe-top">
        <span class="fe-who">${esc(a.byName || "Someone")}</span>
        <span class="fe-when">${esc(fmtWhen(a.at))}</span>
      </div>
      <div class="fe-txt">${esc(a.text || "")}</div>
      ${subtitle}
    </div>
  </div>`;
}

function wireCommentBox(lead) {
  const btn = $("#cmtBtn");
  if (!btn) return;
  const post = async () => {
    const box = $("#cmt");
    const text = box.value.trim();
    if (!text) return;
    btn.disabled = true;
    await S.store.logActivity(lead, { type: "comment", text });
    await S.store.updateLead(lead, { commentCount: (lead.commentCount || 0) + 1 });
    box.value = "";
    btn.disabled = false;
    toast("Comment added.", "good");
  };
  btn.addEventListener("click", post);
  $("#cmt").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") post();
  });
}

/* ---------------------------------------------------------------------------
   CAL BOOKING
   The button is an ordinary link to the booking page carrying Cal's data
   attributes. Cal's script intercepts the click and opens its modal; if that
   script is blocked or slow, the link simply opens the page in a new tab. The
   feature degrades instead of breaking.
--------------------------------------------------------------------------- */
function bookButton(lead) {
  if (!CAL.enabled) return "";
  const name = `${lead.firstName || ""} ${lead.lastName || ""}`.trim();
  const cfg = JSON.stringify({
    layout: CAL.layout,
    ...(name ? { name } : {}),
    ...(lead.email ? { email: lead.email } : {}),
    ...(lead.company ? { notes: `${name || "Lead"} — ${lead.company}` } : {}),
  });
  const booked = lead.callBookedFor;
  return `<a class="btn btn-sm ${booked ? "btn-ghost" : "btn-primary"}" id="drBook"
      href="${esc(calUrl(lead))}" target="_blank" rel="noopener noreferrer"
      data-cal-link="${esc(CAL.link)}"
      data-cal-namespace="${esc(CAL.namespace)}"
      data-cal-config='${esc(cfg)}'
      title="${booked ? "Call booked for " + esc(fmtDate(booked)) + " — book another" : "Open the Summit discovery-call calendar"}">
      ${booked ? "Call " + esc(fmtDate(booked)) : "Book discovery call"}</a>`;
}

/* Cal fires this once a booking completes. Without it a booked call would be
   invisible here, which is the gap this whole dashboard exists to close. */
function wireCalBookings() {
  if (!CAL.enabled || typeof window.Cal !== "function") return;
  try {
    window.Cal.ns?.[CAL.namespace]?.("on", {
      action: "bookingSuccessful",
      callback: (e) => onBookingSuccess(e?.detail?.data || {}),
    });
  } catch (ex) {
    console.warn("Cal booking listener could not be attached.", ex);
  }
}

async function onBookingSuccess(data) {
  const lead = S.leads.find((l) => l.id === S.bookingFor);
  S.bookingFor = null;
  if (!lead) return;   // booked from somewhere else — nothing to attach it to

  // Cal's payload shape varies by version; read defensively rather than assume.
  const booking = data.booking || data;
  const startsAt = booking.startTime || booking.start || data.date || null;
  const when = startsAt ? new Date(startsAt) : null;
  const valid = when && !isNaN(when);

  const patch = { callBookedFor: valid ? when.toISOString().slice(0, 10) : "" };
  const notes = [{
    type: "comment",
    text: valid
      ? `Discovery call booked for ${when.toLocaleString()} via Cal.`
      : "Discovery call booked via Cal.",
  }];

  // Only ever move a lead forward. A booking shouldn't drag a lead that's
  // already at proposal back to meeting.
  const order = STAGES.findIndex((s) => s.key === lead.status);
  const meetingIdx = STAGES.findIndex((s) => s.key === "meeting");
  if (order >= 0 && order < meetingIdx) {
    patch.status = "meeting";
    notes.push({
      type: "stage",
      text: `Stage moved: ${stage(lead.status).label} → Meeting Booked`,
      from: lead.status, to: "meeting",
    });
  }

  try {
    await S.store.updateLead(lead, patch, notes);
    toast(valid ? `Call booked — ${fmtDate(patch.callBookedFor)}. Lead updated.` : "Call booked. Lead updated.", "good");
  } catch (ex) {
    console.error(ex);
    toast("Call was booked, but the lead couldn't be updated. Set the stage by hand.", "bad");
  }
}

async function changeStage(lead, next) {
  if (next === lead.status) return;
  const from = stage(lead.status).label, to = stage(next).label;
  const patch = { status: next };
  // Moving to "Shared" stamps the handover date if it isn't already set.
  if (stage(next).marksHandoff && !lead.sharedOn) patch.sharedOn = new Date().toISOString().slice(0, 10);
  await S.store.updateLead(lead, patch, [{ type: "stage", text: `Stage moved: ${from} → ${to}`, from: lead.status, to: next }]);
  toast(`Moved to ${to}.`, "good");
}

/* ---- add / edit form ---- */
function renderForm(lead, streamKey) {
  const isNew = !lead;
  const stream = isNew ? streamKey : lead.stream;
  const role = S.me.role;

  const control = (f) => {
    const val = lead?.[f.key] ?? "";
    const locked = !isNew && !can.editable(role, f.key);
    const dis = locked ? " disabled" : "";
    const wide = ["notes", "linkedinUrl", "companyLinkedin", "companyWebsite", "lostReason"].includes(f.key) ? " wide" : "";
    let input;
    if (f.type === "textarea")
      input = `<textarea class="inp" id="f_${f.key}"${dis} placeholder="${esc(f.placeholder || "")}">${esc(val)}</textarea>`;
    else if (f.type === "select")
      input = `<select class="inp" id="f_${f.key}"${dis}>
        ${f.options.map((o) => `<option value="${esc(o)}"${val === o ? " selected" : ""}>${esc(o || "—")}</option>`).join("")}
      </select>`;
    else
      input = `<input class="inp" type="${f.type}" id="f_${f.key}" value="${esc(val)}"${dis} placeholder="${esc(f.placeholder || "")}">`;

    return `<div class="fld${wide}">
      <label for="f_${f.key}">${esc(f.label)}${f.required ? ` <span class="req">*</span>` : ""}${locked ? ` <span class="muted">(locked)</span>` : ""}</label>
      ${input}
      <div class="err-msg hide" id="e_${f.key}"></div>
    </div>`;
  };

  $("#drBody").innerHTML = `
    <fieldset class="grp">
      <legend>Routing</legend>
      <div class="frm">
        <div class="fld">
          <label for="f_stream">Stream <span class="req">*</span></label>
          <select class="inp" id="f_stream"${can.editAll(role) ? "" : " disabled"}>
            ${Object.entries(STREAMS).map(([k, s]) => `<option value="${k}"${stream === k ? " selected" : ""}>${esc(s.label)}</option>`).join("")}
          </select>
        </div>
        <div class="fld" id="clientWrap">
          <label for="f_clientId">Client</label>
          <select class="inp" id="f_clientId"${can.editAll(role) ? "" : " disabled"}>
            <option value="">— select client —</option>
            ${S.clients.map((c) => `<option value="${esc(c.id)}"${lead?.clientId === c.id ? " selected" : ""}>${esc(c.name)}</option>`).join("")}
          </select>
          <div class="err-msg hide" id="e_clientId"></div>
        </div>
        <div class="fld">
          <label for="f_status">Stage</label>
          <select class="inp" id="f_status">
            ${STAGES.map((s) => `<option value="${s.key}"${(lead?.status || "new") === s.key ? " selected" : ""}>${esc(s.label)}</option>`).join("")}
          </select>
        </div>
      </div>
    </fieldset>
    ${FIELD_GROUPS.map((g) => `
      <fieldset class="grp">
        <legend>${esc(g)}</legend>
        <div class="frm">${LEAD_FIELDS.filter((f) => f.group === g).map(control).join("")}</div>
      </fieldset>`).join("")}`;

  const syncClient = () => $("#clientWrap").classList.toggle("hide", $("#f_stream").value !== "client");
  $("#f_stream").addEventListener("change", syncClient);
  syncClient();

  $("#drFoot").innerHTML = `
    <button class="btn btn-sm btn-primary" id="frmSave">${isNew ? "Create lead" : "Save changes"}</button>
    <button class="btn btn-sm btn-ghost" id="frmCancel">Cancel</button>
    <div style="flex:1"></div>
    <span class="muted" style="font-size:11.5px; font-weight:600">* required</span>`;

  $("#frmCancel").addEventListener("click", () => {
    if (isNew) closeDrawer();
    else { S.drawer.mode = "read"; renderDrawer(); }
  });
  $("#frmSave").addEventListener("click", () => saveForm(lead));
}

async function saveForm(lead) {
  const isNew = !lead;
  const role = S.me.role;
  const data = {};
  let bad = null;

  $$(".err-msg").forEach((e) => e.classList.add("hide"));
  $$(".inp").forEach((e) => e.classList.remove("err"));

  const fail = (key, msg) => {
    const e = $(`#e_${key}`), i = $(`#f_${key}`);
    if (e) { e.textContent = msg; e.classList.remove("hide"); }
    if (i) i.classList.add("err");
    bad = bad || i;
  };

  data.stream = $("#f_stream").value;
  data.status = $("#f_status").value;
  data.clientId = data.stream === "client" ? $("#f_clientId").value : "";
  if (data.stream === "client" && !data.clientId) fail("clientId", "Pick which client this lead is for.");

  for (const f of LEAD_FIELDS) {
    const el = $(`#f_${f.key}`);
    if (!el) continue;
    if (!isNew && !can.editable(role, f.key)) continue; // never send locked fields
    let v = el.value.trim();
    if (f.required && !v) { fail(f.key, `${f.label} is required.`); continue; }
    if (v && f.type === "url" && !/^https?:\/\//i.test(v)) v = "https://" + v;
    if (v && f.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { fail(f.key, "That doesn't look like an email."); continue; }
    if (f.type === "number") v = v === "" ? "" : Number(v);
    data[f.key] = v;
  }

  if (bad) {
    bad.scrollIntoView({ behavior: "smooth", block: "center" });
    return toast("Fix the highlighted fields.", "bad");
  }

  const btn = $("#frmSave");
  btn.disabled = true;
  btn.textContent = "Saving…";

  try {
    if (isNew) {
      if (stage(data.status).marksHandoff && !data.sharedOn) data.sharedOn = new Date().toISOString().slice(0, 10);
      data.commentCount = 0;
      const id = await S.store.createLead(data);
      toast("Lead created.", "good");
      S.drawer = { ...S.drawer, leadId: id, mode: "read" };
      openDrawer(id);
    } else {
      const notes = [];
      if (data.status !== lead.status) {
        notes.push({
          type: "stage",
          text: `Stage moved: ${stage(lead.status).label} → ${stage(data.status).label}`,
          from: lead.status, to: data.status,
        });
      }
      const changed = Object.keys(data).filter(
        (k) => k !== "status" && String(data[k] ?? "") !== String(lead[k] ?? "")
      );
      if (changed.length) {
        notes.push({
          type: "edit",
          text: `Updated ${changed.map((k) => field(k)?.label || k).join(", ")}`,
        });
      }
      await S.store.updateLead(lead, data, notes);
      toast("Saved.", "good");
      S.drawer.mode = "read";
      renderDrawer();
    }
  } catch (ex) {
    console.error(ex);
    toast(ex?.message || "Could not save. Try again.", "bad");
  } finally {
    btn.disabled = false;
    btn.textContent = isNew ? "Create lead" : "Save changes";
  }
}

/* ==========================================================================
   EXPORT — Excel only, and every download is written to history first
   ========================================================================== */
function filterSummary(streamKey) {
  const v = S.view[streamKey];
  const bits = [];
  if (v.q) bits.push(`search "${v.q}"`);
  if (v.status) bits.push(`stage ${stage(v.status).label}`);
  if (v.owner) bits.push(`added by ${v.owner}`);
  if (v.client) bits.push(`client ${clientName(v.client)}`);
  if (v.attn) bits.push("needs attention only");
  return bits.length ? bits.join(" · ") : "no filters — everything in this stream";
}

async function exportLeads(streamKey, rows) {
  if (!rows.length) return toast("Nothing to export with these filters.", "warn");

  const btn = $(`#exp_${streamKey}`);
  btn.disabled = true;
  btn.textContent = "Preparing…";

  try {
    /* --- build the sheet --- */
    const cols = [
      { label: "Lead ID", width: 14, get: (l) => l.id },
      { label: "Stream", width: 20, get: (l) => STREAMS[l.stream]?.label || l.stream },
      { label: "Client", width: 22, get: (l) => clientName(l.clientId) },
      { label: "Stage", width: 18, get: (l) => stage(l.status).label },
      ...LEAD_FIELDS.map((f) => ({
        label: f.label,
        width: f.width || 18,
        get: (l) => (f.type === "date" ? (l[f.key] ? fmtDate(l[f.key]) : "") : l[f.key] ?? ""),
      })),
      { label: "Added By", width: 20, get: (l) => l.createdByName || "" },
      { label: "Created On", width: 18, get: (l) => fmtDate(l.createdAt) },
      { label: "Last Activity", width: 18, get: (l) => fmtDate(l.lastActivityAt || l.createdAt) },
      { label: "Days Idle", width: 12, get: (l) => (OPEN_STAGES.includes(l.status) ? daysSince(l.lastActivityAt || l.createdAt) : "") },
      { label: "Comments", width: 12, get: (l) => l.commentCount || 0 },
    ];

    const aoa = [cols.map((c) => c.label), ...rows.map((l) => cols.map((c) => c.get(l)))];

    const when = new Date();
    const scope = STREAMS[streamKey].label;
    const filters = filterSummary(streamKey);

    /* --- a second sheet, so the file carries its own audit trail even after
           it has been emailed on to someone else --- */
    const info = [
      ["LinkedIn Leads — export record"],
      [],
      ["Exported by", S.me.name || S.me.email],
      ["Email", S.me.email],
      ["Role", ROLES[S.me.role]?.label || S.me.role || ""],
      ["Exported at", when.toLocaleString()],
      ["Stream", scope],
      ["Filters applied", filters],
      ["Rows", rows.length],
      [],
      ["This export is logged in the dashboard's Export History with the exporter's name,"],
      ["the time, the filters used and the exact leads included. Treat it as confidential."],
    ];

    const stamp = when.toISOString().slice(0, 16).replace("T", "_").replace(":", "");
    const filename = `linkedin-leads_${streamKey}_${stamp}.xlsx`;

    /* --- write the history record BEFORE handing over the file, so nothing
           reaches someone's disk without leaving a trace --- */
    await S.store.logExport({
      scope,
      stream: streamKey,
      filters,
      count: rows.length,
      filename,
      leadIds: rows.map((l) => l.id),
    });

    downloadXlsx(
      [
        { name: "Leads", aoa, cols: cols.map((c) => c.width) },
        { name: "Export Info", aoa: info, cols: [20, 74] },
      ],
      filename
    );

    toast(`Exported ${rows.length} lead${rows.length === 1 ? "" : "s"} — logged in Export History.`, "good");
  } catch (ex) {
    console.error(ex);
    toast("Export failed — nothing was downloaded. Try again.", "bad");
  } finally {
    btn.disabled = false;
    btn.textContent = "Export to Excel";
  }
}

/* ==========================================================================
   EXPORT HISTORY / ACTIVITY / ADMIN PANELS
   ========================================================================== */
function renderExports() {
  const mine = !can.admin(S.me.role);
  $("#expHint").textContent = mine
    ? "Your downloads. Admins can see everyone's."
    : "Every download across the team — who, when, which leads.";

  $("#expList").innerHTML = S.exports.length
    ? S.exports.map((e) => `
      <div class="exp-row">
                <div style="min-width:0">
          <div class="exp-t">${esc(e.byName || e.byEmail || "Someone")} exported ${esc(e.scope || "leads")}</div>
          <div class="exp-s">${esc(fmtWhen(e.at))} · ${esc(e.filters || "no filters")}</div>
          <div class="exp-s" style="opacity:.75">${esc(e.filename || "")}</div>
        </div>
        <div class="exp-n">${e.count ?? 0} rows</div>
      </div>`).join("")
    : `<p class="muted" style="font-size:13px">No exports yet. Every download will appear here.</p>`;
}

function renderFeed() {
  const byLead = new Map(S.leads.map((l) => [l.id, l]));
  const host = $("#globalFeed");

  host.innerHTML = S.feed.length
    ? S.feed.map((a) => {
        const l = byLead.get(a.leadId);
        const tag = l
          ? `<div class="fe-when" style="margin-top:3px; cursor:pointer">
               on <b style="color:var(--ink-2)">${esc(fullName(l))}</b> · ${esc(l.company || "")}</div>`
          : `<div class="card-body"><p class="muted">Every open lead has been touched in the last ${STALE_DAYS} days.</p></div>`;
        return feedItem(a, tag);
      }).join("")
    : `<p class="muted" style="font-size:13px">Nothing has happened yet.</p>`;

  host.onclick = (e) => {
    const row = e.target.closest(".fe");
    if (row?.dataset.leadid && byLead.has(row.dataset.leadid)) openDrawer(row.dataset.leadid);
  };
}

function renderUsers() {
  $("#userList").innerHTML = S.users.length
    ? S.users.map((u) => `
      <div class="li">
        <div class="avatar" style="width:30px;height:30px;font-size:11px">${esc(initials(u.name || u.email))}</div>
        <div class="grow">
          <div class="t">${esc(u.name || u.email)}</div>
          <div class="s">${esc(u.email || "")} · ${esc(ROLES[u.role]?.label || "no role")}</div>
        </div>
        ${u.active === false ? `<span class="pill" style="color:#6b6b73;border-color:#d4d4d8">Disabled</span>` : ""}
      </div>`).join("")
    : `<p class="muted" style="font-size:13px">Nobody yet. Invite your first person below.</p>`;
}

/* ---------------------------------------------------------------------------
   INVITES
   The admin picks the role here; the invitee never chooses their own. The
   matching rule in firestore.rules copies that role across verbatim when they
   sign in, so this dropdown is the only place a role is decided.
--------------------------------------------------------------------------- */
function wireInvites() {
  const roleSel = $("#invRole");
  if (!roleSel || roleSel.dataset.wired) return;
  roleSel.dataset.wired = "1";

  roleSel.innerHTML = Object.entries(ROLES)
    .map(([k, r]) => `<option value="${k}"${k === "ops" ? " selected" : ""}>${esc(r.label)}</option>`)
    .join("");

  const sync = () => {
    const r = roleSel.value;
    $("#invRoleBlurb").textContent = ROLES[r]?.blurb || "";
    $("#invClientWrap").classList.toggle("hide", r !== "client");
  };
  roleSel.addEventListener("change", sync);
  sync();

  $("#invSend").addEventListener("click", sendInvite);
}

async function sendInvite() {
  const name = $("#invName").value.trim();
  const email = $("#invEmail").value.trim().toLowerCase();
  const role = $("#invRole").value;
  const clientAccess = [...$("#invClients").selectedOptions].map((o) => o.value);
  const phone = $("#invPhone").value.trim().replace(/[\s()-]/g, "");

  if (!name) return toast("Add their name so people know who this is.", "warn");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast("That email doesn't look right.", "warn");
  if (role === "client" && !clientAccess.length) return toast("Pick which clients they can see.", "warn");
  if (phone && !/^\+[1-9]\d{7,14}$/.test(phone))
    return toast("Include the country code on the mobile, like +91 98765 43210.", "warn");
  if (S.users.some((u) => (u.email || "").toLowerCase() === email)) {
    return toast("That person already has access.", "warn");
  }

  const btn = $("#invSend");
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    await S.store.createInvite(email, { name, role, clientAccess, phone });
    await S.store.sendInviteLink(email);
    $("#invName").value = "";
    $("#invEmail").value = "";
    $("#invPhone").value = "";
    toast(
      S.store.mode === "demo"
        ? "Invite recorded. In demo mode no email is actually sent."
        : `Invite sent to ${email}.`,
      "good"
    );
  } catch (ex) {
    console.error(ex);
    toast(inviteError(ex), "bad");
  } finally {
    btn.disabled = false;
    btn.textContent = "Send invite";
  }
}

function inviteError(ex) {
  const code = ex?.code || "";
  if (code.includes("operation-not-allowed"))
    return "Email link sign-in isn't switched on yet. Enable it in Firebase → Authentication → Sign-in method.";
  if (code.includes("unauthorized-continue-uri") || code.includes("invalid-continue-uri"))
    return "This site's domain isn't authorised in Firebase → Authentication → Settings → Authorised domains.";
  if (code.includes("permission-denied")) return "Only admins can invite people.";
  return ex?.message || "Could not send the invite. Try again.";
}

function renderInvites() {
  const host = $("#invList");
  if (!host) return;

  const opts = S.clients.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
  const sel = $("#invClients");
  if (sel && sel.innerHTML !== opts) sel.innerHTML = opts;

  const open = S.invites.filter((i) => i.status !== "accepted");
  host.innerHTML = open.length
    ? `<div class="eyebrow" style="margin-bottom:8px">Waiting to be accepted</div>
       <div class="list">${open.map((i) => `
        <div class="li">
          <div class="grow">
            <div class="t">${esc(i.name || i.email)}</div>
            <div class="s">${esc(i.email)} · ${esc(ROLES[i.role]?.label || i.role)} · invited ${esc(fmtWhen(i.createdAt))}</div>
          </div>
          <span class="pill" style="color:#7a5f14;background:#fdf9ec;border-color:#f0e4c0">
            <span class="dot"></span>${i.status === "sent" ? "Link sent" : "Not sent"}
          </span>
          <button class="btn btn-xs btn-ghost" data-resend="${esc(i.email)}">Resend</button>
          <button class="btn btn-xs btn-danger" data-revoke="${esc(i.email)}">Revoke</button>
        </div>`).join("")}</div>`
    : `<p class="muted" style="font-size:12.5px">No invites waiting.</p>`;

  host.onclick = async (e) => {
    const resend = e.target.closest("[data-resend]");
    const revoke = e.target.closest("[data-revoke]");
    if (resend) {
      try {
        await S.store.sendInviteLink(resend.dataset.resend);
        toast("Invite resent.", "good");
      } catch (ex) { toast(inviteError(ex), "bad"); }
    }
    if (revoke) {
      const email = revoke.dataset.revoke;
      if (!confirm(`Revoke the invite for ${email}? Their link stops working.`)) return;
      await S.store.revokeInvite(email, S.invites.find((i) => i.email === email)?.phone);
      toast("Invite revoked.", "bad");
    }
  };
}

function renderClients() {
  const host = $("#clientList");
  if (!host) return;
  host.innerHTML = S.clients.length
    ? S.clients.map((c) => {
        const n = S.leads.filter((l) => l.clientId === c.id).length;
        return `<div class="li">
          <div class="grow">
            <div class="t">${esc(c.name)}</div>
            <div class="s">${n} lead${n === 1 ? "" : "s"}</div>
          </div>
          <span class="pill ${c.active === false ? "pill-neutral" : "pill-accent"}">
            <span class="dot"></span>${c.active === false ? "Inactive" : "Active"}
          </span>
        </div>`;
      }).join("")
    : `<p class="muted" style="font-size:13px">No clients yet. Add the first one below.</p>`;
}
