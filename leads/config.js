/* ============================================================================
   config.js — the single source of truth for the LinkedIn Leads dashboard.

   Everything downstream (the add/edit form, the table columns, the Excel
   export, the filters) is generated from LEAD_FIELDS and STAGES below. Add a
   field here once and it shows up everywhere.
   ========================================================================== */

/* ---------------------------------------------------------------------------
   1. FIREBASE
   Replace the placeholder values with the config from:
   Firebase console -> Project settings -> Your apps -> Web app -> SDK setup.

   These values are NOT secrets — a web Firebase config is public by design.
   Access is enforced by firestore.rules, not by hiding this object.

   While apiKey is still "PASTE_...", the app runs in DEMO MODE: the same UI
   backed by localStorage with seeded sample data, so you can walk the team
   through it before the Firebase project exists.
--------------------------------------------------------------------------- */
export const firebaseConfig = {
  apiKey:            "AIzaSyCSnCg1B-zdrCKE44PPBHf177P8KLPVZR0",
  authDomain:        "leads-dashboard-9d76f.firebaseapp.com",
  projectId:         "leads-dashboard-9d76f",
  storageBucket:     "leads-dashboard-9d76f.firebasestorage.app",
  messagingSenderId: "1008363923882",
  appId:             "1:1008363923882:web:7a973ea7a7146ad55863d3",
  measurementId:     "G-6R90ZXWJXY",
};

export const isConfigured = () => !firebaseConfig.apiKey.startsWith("PASTE_");

/* ---------------------------------------------------------------------------
   1b. SIGN-IN METHODS

   Turn a method off here and its button disappears from the sign-in screen.
   Each one still has to be enabled in Firebase console → Authentication →
   Sign-in method, or it will fail at the point of use.

   A NOTE ON EMAIL OTP: Firebase Auth has no email one-time-code provider.
   It ships email/password, email *link* (a magic link, no code to type),
   phone OTP, and OAuth. A six-digit code by email needs a Cloud Function to
   generate it, send it, and mint a custom token — server-side work that a
   pasted HTML block cannot do on its own. `emailLink` below is the closest
   thing available client-side.
--------------------------------------------------------------------------- */
export const AUTH = {
  microsoft: true,   // imarkinfotech.com runs on Microsoft 365 — the main route in
  google:    true,   // kept for anyone on a Google account, e.g. at Summit
  emailLink: true,   // magic link — Firebase's passwordless email method
  phone:     true,   // SMS one-time code, needs reCAPTCHA
  password:  true,   // classic email + password
};

/* Leave blank to accept any Microsoft account the app registration allows.
   Put your Entra directory (tenant) ID here to refuse everyone outside it —
   worth doing once it is live, since it stops a personal outlook.com account
   from even reaching the sign-in screen. */
export const MS_TENANT = "";

/* Break the dashboard out of a page builder's centred column so it uses the
   whole window. Set false if you would rather it sit inside the container.

   If this leaves a horizontal scrollbar, the host row has padding that cannot
   be reached from here — set that GHL section/row to full width as well. */
export const FULL_BLEED = true;

/* Whoever holds this address can bootstrap themselves as the first admin the
   first time they sign in, so the project does not need a hand-made Firestore
   document to get started. The same address is pinned in firestore.rules —
   change it in BOTH places or the rules will reject the profile.

   Only ever grants admin to a VERIFIED email, so an unverified sign-in
   claiming this address gets nothing. */
export const BOOTSTRAP_ADMIN = "kalash.nandal@imarkinfotech.com";

/* ---------------------------------------------------------------------------
   1c. KEEPING THE PAGE OUT OF SEARCH

   The dashboard is internal. When embedded in a page builder there is no
   <head> to put a robots meta in, so it is injected at runtime instead.

   TWO THINGS TO KNOW:

   1. It is a PAGE-level directive. It de-indexes the whole page the block is
      pasted into, not just the block. That is right for a dedicated dashboard
      page and wrong for a marketing page — set this to false if the block ever
      shares a page you want found.

   2. A meta tag added by JavaScript is honoured by Google, which renders
      pages before indexing, but not by every crawler. The reliable control is
      your page builder's own SEO setting. Use that as well, not instead.
--------------------------------------------------------------------------- */
export const NOINDEX = true;

/* ---------------------------------------------------------------------------
   2. ROLES
   Set on each user's document in the `users` collection (see README).
--------------------------------------------------------------------------- */
export const ROLES = {
  admin:  { label: "Admin",         blurb: "Full access. Manages people, clients and sees every export." },
  ops:    { label: "LinkedIn Team", blurb: "Creates and edits leads, comments, exports." },
  sales:  { label: "Summit Sales",  blurb: "Sees leads shared with Summit. Updates stage, comments, exports." },
  client: { label: "Client",        blurb: "Read-only, and only the leads for their own client account." },
};

/* ---------------------------------------------------------------------------
   3. STREAMS — the two spreadsheets this dashboard replaces
--------------------------------------------------------------------------- */
/* The `sales_partner` key is deliberately unchanged — it is written into every
   existing lead and into firestore.rules. Only the labels say "Summit Sales". */
export const STREAMS = {
  sales_partner: {
    label: "Summit Sales",
    short: "Summit",
    blurb: "Leads our LinkedIn team hands to Summit Sales in the US. These are the ones that used to get lost in WhatsApp.",
    handoffLabel: "Shared with Summit on",
  },
  client: {
    label: "Client Delivery",
    short: "Client",
    blurb: "Leads generated for clients whose LinkedIn we run. One line per client, delivered and acknowledged.",
    handoffLabel: "Delivered to client on",
  },
};

/* ---------------------------------------------------------------------------
   4. PIPELINE STAGES
   Ordered. `funnel: true` means the stage counts as a step in the funnel chart
   (won/lost/nurture are outcomes, not steps).

   COLOUR — each stage owns exactly one `ink`, used for its pill text, its dot,
   its row stripe and its pipeline block, over a matching `tint`.

   The five pipeline stages walk an ordinal indigo ramp that gets darker at
   every step, so a lead further along *looks* further along at a glance —
   which is the whole job on a review call. The ramp's lightness was checked to
   fall monotonically; that depth, not hue, is what carries progress.

   Green and red are held back exclusively for Won and Lost, so an outcome can
   never be mistaken for a step. Nurture sits outside the system entirely as an
   outline — parked, not progressing.

   Every pill carries its text label too, so colour is never the only signal,
   and text contrast on every tint clears 4.5:1.
--------------------------------------------------------------------------- */
export const STAGES = [
  { key: "new",       label: "New Lead",        short: "New",      funnel: true,  ink: "#5a6473", tint: "#f1f3f6", line: "#dfe3e9", blurb: "Logged by the LinkedIn team. Not handed over yet." },
  { key: "shared",    label: "Shared",          short: "Shared",   funnel: true,  ink: "#4a56bd", tint: "#eef0fc", line: "#d3d8f5", blurb: "Handed to Summit Sales / delivered to the client.", marksHandoff: true },
  { key: "contacted", label: "Contacted",       short: "Contacted",funnel: true,  ink: "#3b45a4", tint: "#e9ecfa", line: "#c7cdf1", blurb: "Summit has made first contact." },
  { key: "meeting",   label: "Meeting Booked",  short: "Meeting",  funnel: true,  ink: "#2e3688", tint: "#e4e7f7", line: "#bcc3ee", blurb: "A call is on the calendar." },
  { key: "proposal",  label: "Proposal Sent",   short: "Proposal", funnel: true,  ink: "#232969", tint: "#dfe3f4", line: "#b0b8e8", blurb: "Commercials are out." },
  { key: "won",       label: "Won",             short: "Won",      funnel: false, ink: "#15703f", tint: "#e7f3ec", line: "#b9dcc7", blurb: "Closed. Revenue booked." },
  { key: "lost",      label: "Lost",            short: "Lost",     funnel: false, ink: "#a8271d", tint: "#fbeae8", line: "#eec6c2", blurb: "Dead. Reason required." },
  { key: "nurture",   label: "Nurture / Later", short: "Nurture",  funnel: false, ink: "#6b7684", tint: "#ffffff", line: "#d6dbe1", blurb: "Real, but not now. Revisit later.", outline: true },
];

export const stage = (key) => STAGES.find((s) => s.key === key) || STAGES[0];
export const OPEN_STAGES = STAGES.filter((s) => !["won", "lost"].includes(s.key)).map((s) => s.key);

/* How many days a lead can sit in one stage with no activity before the
   dashboard flags it. This is the number that answers "which lead got
   dropped?" on the Tuesday/Thursday call. */
export const STALE_DAYS = 7;

/* ---------------------------------------------------------------------------
   4b. CAL BOOKING
   The "Book discovery call" button on a lead. Clicking it opens Cal's booking
   modal, pre-filled with that lead's name and email so nobody retypes them.

   When the booking completes, the dashboard moves the lead to Meeting Booked
   and writes it to the activity trail by itself — the point of wiring this up
   rather than just linking out is that a booked call stops being invisible to
   the review.

   The button is a real link underneath, pointing at the same booking page. If
   Cal's script is blocked or fails to load, the click just opens that page in
   a new tab instead of doing nothing.
--------------------------------------------------------------------------- */
export const CAL = {
  enabled:   true,
  origin:    "https://cal.id",
  namespace: "default",
  link:      "summit-sales-and-marketing/discovery-call",
  layout:    "month_view",
  brand:     "#3b45a4",   // matches --accent so the modal doesn't look bolted on
};

export const calUrl = (lead) => {
  const u = new URL(`${CAL.origin}/${CAL.link}`);
  const name = `${lead?.firstName || ""} ${lead?.lastName || ""}`.trim();
  if (name) u.searchParams.set("name", name);
  if (lead?.email) u.searchParams.set("email", lead.email);
  return u.toString();
};

/* ---------------------------------------------------------------------------
   5. LEAD FIELDS
   type:     text | email | tel | url | date | number | textarea | select
   group:    which fieldset it sits in on the form
   table:    show as a column in the leads table
   required: enforced on save
   export:   included in the Excel export (defaults to true)
--------------------------------------------------------------------------- */
export const LEAD_FIELDS = [
  /* --- The person ------------------------------------------------------- */
  { key: "firstName",     label: "First Name",        type: "text",     group: "Person",  required: true, table: true, width: 16 },
  { key: "lastName",      label: "Last Name",         type: "text",     group: "Person",  table: true, width: 16 },
  { key: "jobTitle",      label: "Job Title",         type: "text",     group: "Person",  table: true, width: 26 },
  { key: "linkedinUrl",   label: "LinkedIn Profile",  type: "url",      group: "Person",  required: true, width: 40, placeholder: "https://linkedin.com/in/..." },
  { key: "email",         label: "Email",             type: "email",    group: "Person",  table: true, width: 30 },
  { key: "phone",         label: "Phone",             type: "tel",      group: "Person",  width: 18 },
  { key: "whatsapp",      label: "WhatsApp",          type: "tel",      group: "Person",  width: 18 },
  { key: "city",          label: "City",              type: "text",     group: "Person",  width: 16 },
  { key: "country",       label: "Country",           type: "text",     group: "Person",  table: true, width: 16 },

  /* --- The company ------------------------------------------------------ */
  { key: "company",        label: "Company",          type: "text",     group: "Company", required: true, table: true, width: 26 },
  { key: "companyWebsite", label: "Company Website",  type: "url",      group: "Company", width: 32 },
  { key: "companyLinkedin",label: "Company LinkedIn", type: "url",      group: "Company", width: 36 },
  { key: "industry",       label: "Industry",         type: "text",     group: "Company", table: true, width: 22 },
  { key: "companySize",    label: "Company Size",     type: "select",   group: "Company", width: 14,
    options: ["", "1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5000+"] },
  { key: "revenue",        label: "Est. Revenue",     type: "text",     group: "Company", width: 16 },

  /* --- Where it came from ----------------------------------------------- */
  { key: "source",        label: "Source",            type: "select",   group: "Source",  table: true, width: 20,
    options: ["LinkedIn Outreach", "LinkedIn Inbound", "Content / Post", "Referral", "Event", "Other"] },
  { key: "campaign",      label: "Campaign",          type: "text",     group: "Source",  width: 22 },
  { key: "connectedOn",   label: "Connected On",      type: "date",     group: "Source",  width: 14 },
  { key: "repliedOn",     label: "Replied On",        type: "date",     group: "Source",  width: 14 },
  { key: "intent",        label: "Intent",            type: "select",   group: "Source",  width: 14,
    options: ["", "Hot", "Warm", "Cold"] },

  /* --- Handover & deal -------------------------------------------------- */
  { key: "sharedOn",      label: "Shared On",         type: "date",     group: "Handover", table: true, width: 14 },
  { key: "callBookedFor", label: "Discovery Call",    type: "date",     group: "Handover", width: 16,
    placeholder: "Set automatically when a call is booked" },
  { key: "salesOwner",    label: "Sales Owner",       type: "text",     group: "Handover", table: true, width: 20,
    placeholder: "Who at Summit owns this" },
  { key: "ghlUrl",        label: "GHL Record",        type: "url",      group: "Handover", width: 36,
    placeholder: "Paste the GHL opportunity link" },
  { key: "dealValue",     label: "Deal Value (USD)",  type: "number",   group: "Handover", width: 16 },
  { key: "nextFollowUp",  label: "Next Follow-up",    type: "date",     group: "Handover", table: true, width: 16 },
  { key: "lostReason",    label: "Lost Reason",       type: "text",     group: "Handover", width: 30 },
  { key: "notes",         label: "Notes",             type: "textarea", group: "Handover", width: 50 },
];

export const FIELD_GROUPS = ["Person", "Company", "Source", "Handover"];
export const field = (key) => LEAD_FIELDS.find((f) => f.key === key);

/* ---------------------------------------------------------------------------
   6. CHART COLOUR
   Counts-by-person, by-client and by-week are single-series charts: bar length
   carries the magnitude, so they need one hue and no legend. Mirrored in
   style.css as --viz; checked at 3.6:1 against a white surface.

   The pipeline funnel is the exception — it is ordinal, so each bar takes its
   own stage's `ink` from STAGES above rather than a colour from here.
--------------------------------------------------------------------------- */
export const VIZ = { mark: "#a8801a" };

/* Where the weekly review starts. The team reviews on Tuesday and Thursday, so
   "since the last review" means since the most recent Tue or Thu that passed. */
export const REVIEW_DAYS = [2, 4]; // 0 = Sunday
