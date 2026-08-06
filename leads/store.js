/* ============================================================================
   store.js — the only file that talks to a database.

   Exposes one interface used by app.js. Behind it sit two implementations:

     firebaseStore  real Firebase Auth + Firestore (once config.js is filled in)
     demoStore      localStorage, seeded with sample rows, so the UI can be
                    demoed to the team before the Firebase project exists

   Both are live: every watch* function takes a callback, fires immediately
   with current data, and re-fires on every change.

   ── A note on the queries ────────────────────────────────────────────────
   Firestore evaluates security rules against a query's POTENTIAL result set,
   not the documents it happens to return. A rule like
   `resource.data.stream == 'sales_partner'` therefore requires the query to
   carry a matching `where` clause, or the whole request is rejected. So the
   watch* functions below narrow their queries by role to exactly mirror
   firestore.rules. Change one, change the other.

   For the same reason `activity` documents carry a denormalised copy of the
   parent lead's `stream` and `clientId`: it lets the rules authorise an
   activity read without a get() on the lead (which would cost an extra
   document read per entry).
   ========================================================================== */

import { firebaseConfig, isConfigured } from "./config.js";

const SDK = "https://www.gstatic.com/firebasejs/10.14.1";

/* ==========================================================================
   FIREBASE IMPLEMENTATION
   ========================================================================== */
async function firebaseStore() {
  const [{ initializeApp }, auth, fs] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);

  const app = initializeApp(firebaseConfig);
  const A = auth.getAuth(app);
  const D = fs.getFirestore(app);

  const {
    collection, doc, addDoc, setDoc, updateDoc, deleteDoc, getDoc,
    onSnapshot, query, where, orderBy, limit, serverTimestamp,
  } = fs;

  /* Firestore Timestamps -> plain ISO strings the UI can sort and format. */
  const norm = (snap) => {
    const o = { id: snap.id, ...snap.data() };
    for (const k of Object.keys(o)) {
      if (o[k] && typeof o[k].toDate === "function") o[k] = o[k].toDate().toISOString();
    }
    return o;
  };
  const live = (q, cb) =>
    onSnapshot(
      q,
      (snap) => cb(snap.docs.map(norm)),
      (err) => { console.error("[firestore]", err); cb([], err); }
    );

  let profile = null;

  /* The where() clause that makes a query provably safe for this user's role.
     null means "no clause needed" (staff see everything);
     false means "this user can see nothing". */
  const scopeClause = () => {
    const r = profile?.role;
    if (r === "admin" || r === "ops") return null;
    if (r === "sales") return where("stream", "==", "sales_partner");
    if (r === "client") {
      const ids = (profile.clientAccess || []).slice(0, 30);
      return ids.length ? where("clientId", "in", ids) : false;
    }
    return false;
  };

  const scoped = (col, ...tail) => {
    const clause = scopeClause();
    if (clause === false) return false;
    return clause
      ? query(collection(D, col), clause, ...tail)
      : query(collection(D, col), ...tail);
  };

  const store = {
    mode: "firebase",

    /* ---- auth ---------------------------------------------------------- */
    onAuth(cb) {
      return auth.onAuthStateChanged(A, async (user) => {
        if (!user) { profile = null; return cb(null); }
        // The users/{uid} document carries the role and client scoping. No
        // document means the login exists but access hasn't been granted.
        try {
          const snap = await getDoc(doc(D, "users", user.uid));
          if (snap.exists()) {
            profile = { uid: user.uid, email: user.email, ...snap.data() };
          } else {
            // No profile yet — this may be an invited person signing in for the
            // first time. Turn their pending invite into a real profile.
            const claimed = await store.claimInvite(user).catch(() => null);
            profile = claimed
              ? { uid: user.uid, email: user.email, ...claimed }
              : { uid: user.uid, email: user.email, name: user.email, role: null, pending: true };
          }
        } catch {
          profile = { uid: user.uid, email: user.email, name: user.email, role: null, pending: true };
        }
        cb(profile);
      });
    },
    signIn: (email, password) => auth.signInWithEmailAndPassword(A, email, password),
    signOut: () => auth.signOut(A),
    resetPassword: (email) => auth.sendPasswordResetEmail(A, email),
    me: () => profile,

    /* ---- leads --------------------------------------------------------- */
    watchLeads(cb) {
      const q = scoped("leads", orderBy("createdAt", "desc"));
      if (!q) { cb([]); return () => {}; }
      return live(q, cb);
    },

    async createLead(data) {
      const ref = await addDoc(collection(D, "leads"), {
        ...data,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        lastActivityAt: serverTimestamp(),
        createdBy: profile.uid,
        createdByName: profile.name || profile.email,
      });
      await store.logActivity(
        { id: ref.id, stream: data.stream, clientId: data.clientId || "" },
        { type: "created", text: `Lead created — ${data.firstName || ""} ${data.lastName || ""}`.trim() }
      );
      return ref.id;
    },

    async updateLead(lead, patch, activity) {
      await updateDoc(doc(D, "leads", lead.id), {
        ...patch,
        updatedAt: serverTimestamp(),
        lastActivityAt: serverTimestamp(),
      });
      // The patch may itself move the lead between streams/clients, so stamp
      // activity with where the lead ends up, not where it started.
      const ctx = {
        id: lead.id,
        stream: patch.stream ?? lead.stream,
        clientId: patch.clientId ?? lead.clientId ?? "",
      };
      for (const a of activity || []) await store.logActivity(ctx, a);
    },

    deleteLead: (id) => deleteDoc(doc(D, "leads", id)),

    /* ---- activity ------------------------------------------------------ */
    logActivity(lead, entry) {
      return addDoc(collection(D, "activity"), {
        leadId: lead.id,
        stream: lead.stream || "",
        clientId: lead.clientId || "",
        ...entry,
        at: serverTimestamp(),
        by: profile.uid,
        byName: profile.name || profile.email,
      });
    },

    watchActivity(leadId, cb) {
      const q = scoped("activity", where("leadId", "==", leadId), orderBy("at", "desc"));
      if (!q) { cb([]); return () => {}; }
      return live(q, cb);
    },

    watchRecentActivity(cb, n = 120) {
      const q = scoped("activity", orderBy("at", "desc"), limit(n));
      if (!q) { cb([]); return () => {}; }
      return live(q, cb);
    },

    /* ---- clients ------------------------------------------------------- */
    watchClients: (cb) => live(query(collection(D, "clients"), orderBy("name")), cb),
    saveClient: (id, data) =>
      id
        ? updateDoc(doc(D, "clients", id), data)
        : addDoc(collection(D, "clients"), { ...data, createdAt: serverTimestamp() }),

    /* ---- people -------------------------------------------------------- */
    watchUsers: (cb) => live(query(collection(D, "users"), orderBy("name")), cb),
    saveUser: (uid, data) => setDoc(doc(D, "users", uid), data, { merge: true }),

    /* ---- invites -------------------------------------------------------
       An invite is keyed by the person's email, so it can be looked up
       before they have a uid. The admin decides the role here; when the
       invitee signs in, their users/{uid} document is created from this
       record, and firestore.rules enforces that the role they end up with is
       exactly the one the admin wrote. Nobody can invite themselves upward.
    --------------------------------------------------------------------- */
    watchInvites: (cb) => live(query(collection(D, "invites"), orderBy("createdAt", "desc")), cb),

    createInvite(email, data) {
      const key = email.trim().toLowerCase();
      return setDoc(doc(D, "invites", key), {
        ...data,
        email: key,
        status: "pending",
        createdAt: serverTimestamp(),
        invitedBy: profile.uid,
        invitedByName: profile.name || profile.email,
      });
    },

    revokeInvite: (email) => deleteDoc(doc(D, "invites", email.trim().toLowerCase())),

    /* Emails a passwordless sign-in link. Requires "Email link (passwordless
       sign-in)" to be enabled in Firebase console -> Authentication. */
    async sendInviteLink(email) {
      const key = email.trim().toLowerCase();
      await auth.sendSignInLinkToEmail(A, key, {
        url: location.href.split("?")[0].split("#")[0],
        handleCodeInApp: true,
      });
      await updateDoc(doc(D, "invites", key), { status: "sent", sentAt: serverTimestamp() });
      // Lets the invitee's browser skip re-typing their address on return.
      try { localStorage.setItem("leads:inviteEmail", key); } catch {}
    },

    /* True when the current URL is a sign-in link the user just clicked. */
    isInviteLink: () => auth.isSignInWithEmailLink(A, location.href),

    signInWithLink(email) {
      return auth.signInWithEmailLink(A, email.trim().toLowerCase(), location.href);
    },

    /* Called after sign-in when the user has no users/{uid} document yet.
       Turns a pending invite into a real profile. */
    async claimInvite(user) {
      const key = (user.email || "").toLowerCase();
      if (!key) return null;
      const snap = await getDoc(doc(D, "invites", key));
      if (!snap.exists()) return null;
      const inv = snap.data();
      if (inv.status === "revoked") return null;

      const profileDoc = {
        name: inv.name || user.email,
        email: key,
        role: inv.role,
        active: true,
        ...(inv.role === "client" ? { clientAccess: inv.clientAccess || [] } : {}),
      };
      await setDoc(doc(D, "users", user.uid), profileDoc);
      await updateDoc(doc(D, "invites", key), { status: "accepted", acceptedAt: serverTimestamp(), uid: user.uid });
      return profileDoc;
    },

    /* ---- export history ------------------------------------------------ */
    logExport(rec) {
      return addDoc(collection(D, "exports"), {
        ...rec,
        count: Number(rec.count) || 0,
        at: serverTimestamp(),
        by: profile.uid,
        byName: profile.name || profile.email,
        byEmail: profile.email,
      });
    },

    watchExports(cb) {
      const base = collection(D, "exports");
      const q = profile?.role === "admin"
        ? query(base, orderBy("at", "desc"), limit(300))
        : query(base, where("by", "==", profile.uid), orderBy("at", "desc"), limit(300));
      return live(q, cb);
    },
  };

  return store;
}

/* ==========================================================================
   DEMO IMPLEMENTATION — localStorage, same interface
   ========================================================================== */
function demoStore() {
  const KEY = "linkedin-leads-demo-v1";
  const listeners = new Set();

  const blank = () => ({ leads: [], activity: [], clients: [], users: [], exports: [] });
  const read = () => {
    try { return { ...blank(), ...JSON.parse(localStorage.getItem(KEY) || "{}") }; }
    catch { return blank(); }
  };
  const write = (db) => {
    localStorage.setItem(KEY, JSON.stringify(db));
    listeners.forEach((fn) => fn());
  };
  const uid = () => Math.random().toString(36).slice(2, 11);
  const now = () => new Date().toISOString();

  /* A watcher re-runs its selector whenever anything changes. */
  const watch = (select, cb) => {
    const run = () => cb(select(read()));
    listeners.add(run);
    run();
    return () => listeners.delete(run);
  };

  const profile = { uid: "demo-user", email: "demo@local", name: "Demo User", role: "admin", demo: true };

  seed();
  function seed() {
    if (localStorage.getItem(KEY + ":seeded")) return;
    localStorage.setItem(KEY + ":seeded", "1");
    const db = read();
    if (db.leads.length) return;

    const c1 = uid(), c2 = uid();
    db.clients = [
      { id: c1, name: "Northwind Capital", active: true, createdAt: now() },
      { id: c2, name: "Beacon Health", active: true, createdAt: now() },
    ];
    const rows = [
      ["Priya", "Menon", "VP Operations", "Aurora Logistics", "meeting", "sales_partner", "", 12],
      ["Daniel", "Reyes", "Head of Growth", "Vertex Software", "shared", "sales_partner", "", 9],
      ["Sarah", "Whitfield", "COO", "Lakeside Manufacturing", "contacted", "sales_partner", "", 21],
      ["Tom", "Okafor", "Founder", "Bright Yard", "new", "sales_partner", "", 2],
      ["Amara", "Singh", "CFO", "Helio Ventures", "won", "sales_partner", "", 40],
      ["James", "Delaney", "Director of IT", "Corfield Group", "lost", "sales_partner", "", 33],
      ["Nina", "Kowalski", "Marketing Lead", "Pinehurst Retail", "shared", "client", c1, 6],
      ["Owen", "Baptiste", "Practice Manager", "Cedar Clinic", "new", "client", c2, 1],
      ["Ravi", "Iyer", "Procurement Head", "Trellis Foods", "proposal", "client", c1, 15],
    ];
    const team = ["Aisha", "Rohit", "Meera"];
    db.leads = rows.map(([f, l, t, co, st, stream, clientId, age], i) => {
      const created = new Date(Date.now() - age * 864e5).toISOString();
      const touched = new Date(Date.now() - Math.max(0, age - 4) * 864e5).toISOString();
      return {
        id: uid(),
        firstName: f, lastName: l, jobTitle: t, company: co,
        linkedinUrl: `https://linkedin.com/in/${f.toLowerCase()}-${l.toLowerCase()}`,
        email: `${f.toLowerCase()}@${co.toLowerCase().replace(/\W/g, "")}.com`,
        country: ["United States", "United Kingdom", "Canada"][i % 3],
        industry: ["Logistics", "Software", "Manufacturing", "Retail", "Healthcare"][i % 5],
        source: "LinkedIn Outreach",
        status: st,
        stream,
        clientId,
        sharedOn: st === "new" ? "" : created.slice(0, 10),
        salesOwner: stream === "sales_partner" && st !== "new" ? "Mark Ellison" : "",
        dealValue: st === "won" ? 18000 : st === "proposal" ? 24000 : "",
        lostReason: st === "lost" ? "Went with an incumbent vendor" : "",
        commentCount: 0,
        createdAt: created,
        updatedAt: touched,
        lastActivityAt: touched,
        createdBy: "demo-user",
        createdByName: team[i % team.length],
      };
    });
    db.activity = db.leads.map((ld) => ({
      id: uid(), leadId: ld.id, stream: ld.stream, clientId: ld.clientId,
      type: "created", text: `Lead created — ${ld.firstName} ${ld.lastName}`,
      at: ld.createdAt, by: "demo-user", byName: ld.createdByName,
    }));
    write(db);
  }

  const store = {
    mode: "demo",

    onAuth(cb) { setTimeout(() => cb(profile), 0); return () => {}; },
    signIn: async () => profile,
    signOut: async () => { location.reload(); },
    resetPassword: async () => {},
    me: () => profile,

    watchLeads: (cb) =>
      watch((db) => [...db.leads].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")), cb),

    async createLead(data) {
      const db = read();
      const id = uid();
      db.leads.push({
        ...data, id, commentCount: 0,
        createdAt: now(), updatedAt: now(), lastActivityAt: now(),
        createdBy: profile.uid, createdByName: profile.name,
      });
      db.activity.push({
        id: uid(), leadId: id, stream: data.stream, clientId: data.clientId || "",
        type: "created", text: `Lead created — ${data.firstName || ""} ${data.lastName || ""}`.trim(),
        at: now(), by: profile.uid, byName: profile.name,
      });
      write(db);
      return id;
    },

    async updateLead(lead, patch, activity) {
      const db = read();
      const i = db.leads.findIndex((l) => l.id === lead.id);
      if (i < 0) return;
      db.leads[i] = { ...db.leads[i], ...patch, updatedAt: now(), lastActivityAt: now() };
      const stream = patch.stream ?? lead.stream;
      const clientId = patch.clientId ?? lead.clientId ?? "";
      for (const a of activity || []) {
        db.activity.push({
          id: uid(), leadId: lead.id, stream, clientId, ...a,
          at: now(), by: profile.uid, byName: profile.name,
        });
      }
      write(db);
    },

    async deleteLead(id) {
      const db = read();
      db.leads = db.leads.filter((l) => l.id !== id);
      write(db);
    },

    async logActivity(lead, entry) {
      const db = read();
      db.activity.push({
        id: uid(), leadId: lead.id, stream: lead.stream || "", clientId: lead.clientId || "",
        ...entry, at: now(), by: profile.uid, byName: profile.name,
      });
      write(db);
    },

    watchActivity: (leadId, cb) =>
      watch((db) => db.activity
        .filter((a) => a.leadId === leadId)
        .sort((a, b) => (b.at || "").localeCompare(a.at || "")), cb),

    watchRecentActivity: (cb, n = 120) =>
      watch((db) => [...db.activity]
        .sort((a, b) => (b.at || "").localeCompare(a.at || ""))
        .slice(0, n), cb),

    watchClients: (cb) => watch((db) => [...db.clients].sort((a, b) => a.name.localeCompare(b.name)), cb),

    async saveClient(id, data) {
      const db = read();
      if (id) {
        const i = db.clients.findIndex((c) => c.id === id);
        if (i >= 0) db.clients[i] = { ...db.clients[i], ...data };
      } else db.clients.push({ id: uid(), ...data, createdAt: now() });
      write(db);
    },

    watchUsers: (cb) => watch((db) => db.users, cb),

    async saveUser(id, data) {
      const db = read();
      const i = db.users.findIndex((u) => u.id === id);
      if (i >= 0) db.users[i] = { ...db.users[i], ...data };
      else db.users.push({ id: id || uid(), ...data });
      write(db);
    },

    /* Invites — same shape as Firebase, minus the actual email. */
    watchInvites: (cb) =>
      watch((db) => [...(db.invites || [])].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")), cb),

    async createInvite(email, data) {
      const db = read();
      db.invites = db.invites || [];
      const key = email.trim().toLowerCase();
      const rec = {
        id: key, email: key, ...data, status: "pending",
        createdAt: now(), invitedBy: profile.uid, invitedByName: profile.name,
      };
      const i = db.invites.findIndex((v) => v.id === key);
      if (i >= 0) db.invites[i] = rec; else db.invites.push(rec);
      write(db);
    },

    async revokeInvite(email) {
      const db = read();
      db.invites = (db.invites || []).filter((v) => v.id !== email.trim().toLowerCase());
      write(db);
    },

    async sendInviteLink(email) {
      const db = read();
      const key = email.trim().toLowerCase();
      const i = (db.invites || []).findIndex((v) => v.id === key);
      if (i >= 0) { db.invites[i].status = "sent"; db.invites[i].sentAt = now(); }
      write(db);
    },

    isInviteLink: () => false,
    signInWithLink: async () => profile,
    claimInvite: async () => null,

    async logExport(rec) {
      const db = read();
      db.exports.push({
        id: uid(), ...rec, count: Number(rec.count) || 0,
        at: now(), by: profile.uid, byName: profile.name, byEmail: profile.email,
      });
      write(db);
    },

    watchExports: (cb) =>
      watch((db) => [...db.exports].sort((a, b) => (b.at || "").localeCompare(a.at || "")), cb),
  };

  return store;
}

/* ==========================================================================
   PICKER
   ========================================================================== */
export async function openStore() {
  if (!isConfigured()) return demoStore();
  try {
    return await firebaseStore();
  } catch (err) {
    console.error("Firebase failed to start; falling back to demo mode.", err);
    return demoStore();
  }
}
