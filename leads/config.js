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
  apiKey:            "PASTE_YOUR_API_KEY",
  authDomain:        "PASTE_YOUR_PROJECT.firebaseapp.com",
  projectId:         "PASTE_YOUR_PROJECT_ID",
  storageBucket:     "PASTE_YOUR_PROJECT.appspot.com",
  messagingSenderId: "PASTE_YOUR_SENDER_ID",
  appId:             "PASTE_YOUR_APP_ID",
};

export const isConfigured = () => !firebaseConfig.apiKey.startsWith("PASTE_");

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
   its row stripe and its funnel bar, over a matching `tint`. The five pipeline
   stages walk an ordinal ramp from cool grey into deepening gold, so a lead
   getting further along *looks* further along at a glance — that is the whole
   point on a review call. Won and Lost break out of the ramp into reserved
   semantic green and red, because they are outcomes rather than progress, and
   Nurture sits outside it entirely as an outline.

   Every pill carries its text label too, so colour is never the only signal.
   Text contrast on tint was checked: all pass 4.5:1 or better.
--------------------------------------------------------------------------- */
export const STAGES = [
  { key: "new",       label: "New Lead",        funnel: true,  ink: "#52525b", tint: "#f4f4f5", line: "#e4e4e7", blurb: "Logged by the LinkedIn team. Not handed over yet." },
  { key: "shared",    label: "Shared",          funnel: true,  ink: "#7a5f14", tint: "#fdf9ec", line: "#f0e4c0", blurb: "Handed to Summit Sales / delivered to the client.", marksHandoff: true },
  { key: "contacted", label: "Contacted",       funnel: true,  ink: "#6f5610", tint: "#fbf6e6", line: "#ecdfb4", blurb: "Summit has made first contact." },
  { key: "meeting",   label: "Meeting Booked",  funnel: true,  ink: "#5e480d", tint: "#f8f1dd", line: "#e5d5a3", blurb: "A call is on the calendar." },
  { key: "proposal",  label: "Proposal Sent",   funnel: true,  ink: "#54410c", tint: "#f2e9d2", line: "#dcc98f", blurb: "Commercials are out." },
  { key: "won",       label: "Won",             funnel: false, ink: "#14663c", tint: "#e8f4ee", line: "#bcdfcc", blurb: "Closed. Revenue booked." },
  { key: "lost",      label: "Lost",            funnel: false, ink: "#8f1e18", tint: "#fbecea", line: "#f0c9c5", blurb: "Dead. Reason required." },
  { key: "nurture",   label: "Nurture / Later", funnel: false, ink: "#6b6b73", tint: "#ffffff", line: "#d4d4d8", blurb: "Real, but not now. Revisit later.", outline: true },
];

export const stage = (key) => STAGES.find((s) => s.key === key) || STAGES[0];
export const OPEN_STAGES = STAGES.filter((s) => !["won", "lost"].includes(s.key)).map((s) => s.key);

/* How many days a lead can sit in one stage with no activity before the
   dashboard flags it. This is the number that answers "which lead got
   dropped?" on the Tuesday/Thursday call. */
export const STALE_DAYS = 7;

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
