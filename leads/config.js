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
  admin:  { label: "Admin",            blurb: "Full access. Manages people, clients and sees every export." },
  ops:    { label: "LinkedIn Team",    blurb: "Creates and edits leads, comments, exports." },
  sales:  { label: "Sales Partner",    blurb: "Sees leads shared with sales. Updates stage, comments, exports." },
  client: { label: "Client",           blurb: "Read-only, and only the leads for their own client account." },
};

/* ---------------------------------------------------------------------------
   3. STREAMS — the two spreadsheets this dashboard replaces
--------------------------------------------------------------------------- */
export const STREAMS = {
  sales_partner: {
    label: "Sales Partner (US)",
    short: "Sales Partner",
    blurb: "Leads our LinkedIn team hands to the US sales partner. These are the ones that used to get lost in WhatsApp.",
    handoffLabel: "Shared with sales on",
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

   `tone` drives the status pill. Only won / lost / at-risk get a semantic
   colour; every pill also carries its text label, so colour is never the only
   signal.
--------------------------------------------------------------------------- */
export const STAGES = [
  { key: "new",       label: "New Lead",         tone: "neutral", funnel: true,  blurb: "Logged by the LinkedIn team. Not handed over yet." },
  { key: "shared",    label: "Shared",           tone: "neutral", funnel: true,  blurb: "Handed to the sales partner / delivered to the client.", marksHandoff: true },
  { key: "contacted", label: "Contacted",        tone: "neutral", funnel: true,  blurb: "Sales has made first contact." },
  { key: "meeting",   label: "Meeting Booked",   tone: "accent",  funnel: true,  blurb: "A call is on the calendar." },
  { key: "proposal",  label: "Proposal Sent",    tone: "accent",  funnel: true,  blurb: "Commercials are out." },
  { key: "won",       label: "Won",              tone: "good",    funnel: false, blurb: "Closed. Revenue booked." },
  { key: "lost",      label: "Lost",             tone: "bad",     funnel: false, blurb: "Dead. Reason required." },
  { key: "nurture",   label: "Nurture / Later",  tone: "neutral", funnel: false, blurb: "Real, but not now. Revisit later." },
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
    placeholder: "Who at the sales partner owns this" },
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
   6. CHART COLOURS
   The dashboard is monochrome + gold, so every chart is single-series and
   magnitude is carried by bar length, not hue. These values were checked with
   the palette validator against a white surface.
--------------------------------------------------------------------------- */
export const VIZ = {
  mark:     "#a8801a",  // single-series bar fill — 3.6:1 on white
  ordinal:  ["#d4b455", "#c9a227", "#b8901f", "#a8801a", "#9a7415"], // funnel steps, light -> dark
};

/* Where the weekly review starts. The team reviews on Tuesday and Thursday, so
   "since the last review" means since the most recent Tue or Thu that passed. */
export const REVIEW_DAYS = [2, 4]; // 0 = Sunday
