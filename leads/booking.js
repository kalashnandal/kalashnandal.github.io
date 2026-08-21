/* ============================================================================
   booking.js — "Find a time" across the US sales team's GHL calendars.

   Written for one moment: a caller in India has a prospect on the phone, the
   prospect says "I'm free at twelve", and the caller has seconds to answer.
   So the screen is a list of times, biggest thing on the page, each with the
   reps who are actually free next to it. One click books, and GHL sends the
   invite while the prospect is still on the line.

   Everything here is deliberately timezone-dumb. The proxy returns each slot
   as a wall-clock time in the prospect's zone plus the exact instant to book;
   this file renders the first and posts back the second. No date arithmetic,
   which is where this kind of feature normally goes wrong.
   ========================================================================== */

import { BOOKING, TIMEZONES, TZ_BY_COUNTRY } from "./config.js";
import { $, esc } from "./dom.js";

/* Module state. `slots` is keyed by calendar id, exactly as it comes back. */
const B = {
  store: null,
  toast: () => {},
  onBooked: () => {},
  leads: () => [],
  date: "",
  timezone: TIMEZONES[0].id,
  slots: null,
  loading: false,
  error: "",
  lead: null,          // the lead being booked for, if any
  picked: null,        // { rep, slot } awaiting confirmation
};

/* Two different questions, deliberately kept apart.

   `bookingEnabled` — can this actually load availability? Needs a deployed
   calendar service, or the demo standing in for one.

   `bookingVisible` — should the tab appear at all? An admin sees it either
   way, because a tab that hides itself when unconfigured is indistinguishable
   from a feature nobody built; they get a panel telling them what is missing.
   Everyone else only sees it once it works, so callers are never handed a
   dead tab. */
export const bookingEnabled = (store) => Boolean(BOOKING.proxy) || store?.mode === "demo";
export const bookingVisible = (store, role) => bookingEnabled(store) || role === "admin";

/* ---------------------------------------------------------------------------
   Dates. Kept as plain YYYY-MM-DD strings — a Date object here would only
   invite a timezone bug.
--------------------------------------------------------------------------- */
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const addDays = (iso, n) => {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
};

const prettyDate = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    weekday: "long", day: "numeric", month: "long", timeZone: "UTC",
  });
};

/* 24h "14:30" → "2:30 PM". US prospects hear it this way, so the caller should
   read it this way. */
const pretty = (t) => {
  const [h, m] = t.split(":").map(Number);
  const ap = h < 12 ? "AM" : "PM";
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${ap}`;
};

export const guessTimezone = (lead) =>
  TZ_BY_COUNTRY[lead?.country] || TIMEZONES[0].id;

/* ---------------------------------------------------------------------------
   Wiring. Called once, from app.js, after the shell exists.
--------------------------------------------------------------------------- */
export function initBooking({ store, toast, onBooked, leads }) {
  B.store = store;
  B.toast = toast || B.toast;
  B.onBooked = onBooked || B.onBooked;
  B.leads = leads || B.leads;
  B.date = todayISO();

  const host = $("#bookPanel");
  if (!host) return;

  $("#bkTz").innerHTML = TIMEZONES
    .map((t) => `<option value="${esc(t.id)}">${esc(t.label)}</option>`).join("");
  $("#bkTz").value = B.timezone;
  $("#bkDate").value = B.date;
  $("#bkDate").min = todayISO();
  $("#bkDate").max = addDays(todayISO(), BOOKING.daysAhead);

  $("#bkDate").addEventListener("change", (e) => { B.date = e.target.value; load(); });
  $("#bkTz").addEventListener("change", (e) => { B.timezone = e.target.value; load(); });
  $("#bkPrev").addEventListener("click", () => shiftDay(-1));
  $("#bkNext").addEventListener("click", () => shiftDay(1));
  $("#bkReload").addEventListener("click", () => load());

  /* Click anywhere in the grid: a free rep chip picks that rep and slot. */
  $("#bkGrid").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-rep][data-slot]");
    if (!chip || chip.disabled) return;
    const rep = BOOKING.reps.find((r) => r.id === chip.dataset.rep);
    const slot = JSON.parse(chip.dataset.slot);
    B.picked = { rep, slot };
    renderConfirm();
  });

  $("#bkConfirmBody").addEventListener("click", (e) => {
    if (e.target.id === "bkCancel") { B.picked = null; renderConfirm(); }
    if (e.target.id === "bkBook") confirmBooking();
  });

  renderRepLegend();
  load();
}

function shiftDay(n) {
  const next = addDays(B.date, n);
  if (next < todayISO()) return;
  B.date = next;
  $("#bkDate").value = next;
  load();
}

/* Open the tab with a lead already attached — used by the drawer's
   "Find a time" button, which is how most bookings will actually start. */
export function bookingForLead(lead) {
  B.lead = lead || null;
  if (lead) {
    B.timezone = guessTimezone(lead);
    const sel = $("#bkTz");
    if (sel) sel.value = B.timezone;
  }
  B.picked = null;
  renderWho();
  load();
}

/* ---------------------------------------------------------------------------
   Loading availability
--------------------------------------------------------------------------- */
async function load() {
  /* Nothing deployed yet: say so properly instead of firing a request that
     can only fail and reporting the failure as an error. */
  if (!bookingEnabled(B.store)) {
    B.loading = false;
    B.slots = null;
    B.error = "";
    return renderSetup();
  }

  const configured = BOOKING.reps.filter((r) => r.calendarId);
  const reps = configured.length ? configured : BOOKING.reps;

  B.loading = true;
  B.error = "";
  B.picked = null;
  render();

  try {
    const res = await B.store.freeSlots({
      date: B.date,
      timezone: B.timezone,
      calendarIds: reps.map((r) => r.calendarId || r.id),
    });
    B.slots = res.slots || {};
  } catch (ex) {
    B.slots = null;
    B.error = ex?.message === "no-proxy"
      ? "No calendar service configured yet — set BOOKING.proxy in config.js."
      : (ex?.message || "Could not reach the calendar service.");
  } finally {
    B.loading = false;
    render();
  }
}

/* Every distinct start time across all four calendars, in order. Reps rarely
   share slot boundaries exactly, so the rows come from the union, not from
   any one rep's calendar. */
function slotRows() {
  const seen = new Map();
  for (const rep of BOOKING.reps) {
    for (const s of B.slots?.[rep.calendarId || rep.id] || []) {
      if (!seen.has(s.t)) seen.set(s.t, { t: s.t, free: [] });
      seen.get(s.t).free.push({ rep, slot: s });
    }
  }
  return [...seen.values()].sort((a, b) => a.t.localeCompare(b.t));
}

/* ---------------------------------------------------------------------------
   Rendering
--------------------------------------------------------------------------- */
function renderRepLegend() {
  const host = $("#bkReps");
  if (!host) return;

  /* Only worth flagging once there is a real service behind the tab. In the
     demo every calendar is unlinked by definition, and striking all four
     through while they are plainly bookable just reads as broken. */
  const live = Boolean(BOOKING.proxy);
  const unset = live ? BOOKING.reps.filter((r) => !r.calendarId).length : 0;

  host.innerHTML = BOOKING.reps.map((r) => `
    <span class="bk-rep${live && !r.calendarId ? " unset" : ""}">
      <span class="bk-dot" style="background:${esc(repInk(r))}"></span>${esc(r.name)}
    </span>`).join("")
    + (unset
        ? `<span class="muted">${unset} calendar${unset > 1 ? "s" : ""} not linked yet — set calendarId in config.js</span>`
        : "");
}

/* Reps get their own hues so the same person is the same colour on every row.
   Availability itself is never carried by colour alone — a free rep is a
   filled chip with their name in it, a busy one simply is not there. */
const REP_INK = ["#3d52d5", "#136c3e", "#8f5108", "#6d3bb5", "#0f6f77", "#a3241b"];
const repInk = (rep) => REP_INK[Math.max(0, BOOKING.reps.findIndex((r) => r.id === rep.id)) % REP_INK.length];

function renderWho() {
  const host = $("#bkWho");
  if (!host) return;
  const l = B.lead;
  host.innerHTML = l
    ? `<div class="bk-who">
         <div>
           <div class="eyebrow">Booking for</div>
           <b>${esc(`${l.firstName || ""} ${l.lastName || ""}`.trim() || l.company || "this lead")}</b>
           <span class="muted">${esc([l.company, l.email].filter(Boolean).join(" · "))}</span>
         </div>
         <button class="btn btn-xs btn-ghost" id="bkClearLead">Clear</button>
       </div>`
    : `<div class="bk-who">
         <div>
           <div class="eyebrow">Booking for</div>
           <span class="muted">No lead attached — open a lead and press <b>Find a time</b>, or fill in the details when you book.</span>
         </div>
       </div>`;
  const clear = $("#bkClearLead");
  if (clear) clear.addEventListener("click", () => { B.lead = null; B.picked = null; renderWho(); renderConfirm(); });
}

/* What an admin sees before the calendar service exists. It is a setup screen,
   not an error — nothing has gone wrong, a step is simply outstanding, and the
   screen should say which one. */
function renderSetup() {
  const grid = $("#bkGrid");
  if (!grid) return;

  $("#bkDay").textContent = "";
  renderWho();
  ["#bkPrev", "#bkNext", "#bkDate", "#bkTz", "#bkReload"].forEach((sel) => {
    const el = $(sel);
    if (el) el.disabled = true;
  });

  grid.innerHTML = `
    <div class="bk-setup">
      <b>Not connected to the sales calendars yet.</b>
      <p class="muted">
        This screen shows every free slot across all ${BOOKING.reps.length} calendars at once,
        so a caller can book while the prospect is still on the phone. It needs one
        thing first: GoHighLevel's API requires a token, and a token in this page
        would be readable by anyone who views source on the site — so it lives in a
        small service instead.
      </p>
      <ol class="bk-steps">
        <li>Deploy the calendar service — <code>leads/functions/README.md</code> has the steps.</li>
        <li>Put its URL in <code>BOOKING.proxy</code> in <code>config.js</code>, along with each rep's calendar and user id.</li>
        <li>Run <code>node build-ghl.mjs</code> and paste the rebuilt file into the GHL block.</li>
      </ol>
      <p class="muted">
        Want to see it working first? Add <code>?demo=1</code> to this page's address —
        same screen, invented availability, nothing written anywhere.
      </p>
    </div>`;

  renderConfirm();
}

function render() {
  const grid = $("#bkGrid");
  if (!grid) return;

  $("#bkDay").textContent = prettyDate(B.date);
  renderWho();

  if (B.loading) {
    grid.innerHTML = `<div class="bk-empty">Checking all ${BOOKING.reps.length} calendars…</div>`;
    return renderConfirm();
  }
  if (B.error) {
    grid.innerHTML = `<div class="bk-empty bad">${esc(B.error)}</div>`;
    return renderConfirm();
  }

  const rows = slotRows();
  if (!rows.length) {
    grid.innerHTML = `<div class="bk-empty">Nobody is free on ${esc(prettyDate(B.date))}. Try the next day.</div>`;
    return renderConfirm();
  }

  grid.innerHTML = rows.map((row) => `
    <div class="bk-row${row.free.length ? "" : " none"}">
      <div class="bk-time">${esc(pretty(row.t))}</div>
      <div class="bk-free">
        ${row.free.map(({ rep, slot }) => `
          <button class="bk-chip" data-rep="${esc(rep.id)}"
                  data-slot="${esc(JSON.stringify(slot))}"
                  style="--rep:${esc(repInk(rep))}">
            ${esc(rep.name)}
          </button>`).join("")}
      </div>
      <div class="bk-count">${row.free.length} free</div>
    </div>`).join("");

  renderConfirm();
}

/* The confirm step exists because booking is irreversible from the prospect's
   point of view — they get an email the moment it lands. One glance at who,
   when, and with whom before that happens. */
function renderConfirm() {
  const host = $("#bkConfirmBody");
  const card = $("#bkConfirm");
  if (!host || !card) return;

  if (!B.picked) {
    card.classList.add("hide");
    host.innerHTML = "";
    return;
  }
  card.classList.remove("hide");

  const { rep, slot } = B.picked;
  const l = B.lead || {};
  const tzLabel = TIMEZONES.find((t) => t.id === B.timezone)?.label || B.timezone;

  host.innerHTML = `
    <div class="bk-confirm-line">
      <b>${esc(pretty(slot.t))}</b> ${esc(tzLabel)} · ${esc(prettyDate(B.date))}
      with <b style="color:${esc(repInk(rep))}">${esc(rep.name)}</b>
    </div>
    <div class="grid-2 mt-12">
      <div class="fld">
        <label for="bkFirst">First name <span class="req">*</span></label>
        <input class="inp" id="bkFirst" value="${esc(l.firstName || "")}">
      </div>
      <div class="fld">
        <label for="bkLast">Last name</label>
        <input class="inp" id="bkLast" value="${esc(l.lastName || "")}">
      </div>
      <div class="fld">
        <label for="bkEmail">Email <span class="req">*</span></label>
        <input class="inp" id="bkEmail" type="email" value="${esc(l.email || "")}">
      </div>
      <div class="fld">
        <label for="bkPhone">Phone</label>
        <input class="inp" id="bkPhone" type="tel" value="${esc(l.phone || "")}">
      </div>
    </div>
    <div class="fld mt-12">
      <label for="bkNotes">Note for the rep <span class="muted">(optional)</span></label>
      <textarea class="inp" id="bkNotes" rows="2" placeholder="What the prospect asked about"></textarea>
    </div>
    <p class="muted mt-8">The invite goes to this email from GHL as soon as you book.</p>
    <div class="mt-12 row-8">
      <button class="btn btn-primary" id="bkBook">Book with ${esc(rep.name.split(" ")[0])}</button>
      <button class="btn btn-ghost" id="bkCancel">Cancel</button>
    </div>`;
}

/* ---------------------------------------------------------------------------
   Booking
--------------------------------------------------------------------------- */
async function confirmBooking() {
  const { rep, slot } = B.picked || {};
  if (!rep) return;

  const first = $("#bkFirst").value.trim();
  const email = $("#bkEmail").value.trim();
  if (!first) return B.toast("Add the prospect's first name.", "warn");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return B.toast("A real email address is needed for the invite.", "warn");

  const btn = $("#bkBook");
  btn.disabled = true;
  btn.textContent = "Booking…";

  try {
    const res = await B.store.book({
      calendarId: rep.calendarId || rep.id,
      userId: rep.userId || "",
      startTime: slot.iso,
      timezone: B.timezone,
      minutes: BOOKING.slotMinutes,
      title: BOOKING.title,
      notes: $("#bkNotes").value.trim(),
      contact: {
        firstName: first,
        lastName: $("#bkLast").value.trim(),
        email,
        phone: $("#bkPhone").value.trim(),
      },
      leadId: B.lead?.id || "",
    });

    B.toast(`Booked with ${rep.name} — the invite is on its way.`, "good");
    await B.onBooked({
      lead: B.lead,
      rep,
      slot,
      date: B.date,
      timezone: B.timezone,
      result: res,
    });

    B.picked = null;
    load();
  } catch (ex) {
    B.toast(ex?.message || "The booking did not go through. Nothing was sent.", "bad");
    btn.disabled = false;
    btn.textContent = `Book with ${rep.name.split(" ")[0]}`;
  }
}
