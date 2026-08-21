/* ============================================================================
   index.js — the Cloud Function the dashboard talks to.

   All the logic is in handler.js, which speaks the Web Fetch API. Cloud
   Functions hands us Express-style (req, res), so this translates between the
   two and supplies the configuration. Nothing else lives here.

   The GHL token arrives as a Secret Manager secret — never a file, never the
   repo, never the pasted HTML block. Everything else is ordinary config and
   is not sensitive.

   Deploy:
     firebase functions:secrets:set GHL_TOKEN     # paste the PIT when prompted
     firebase deploy --only functions:cal

   The URL it prints is what goes in BOOKING.proxy in ../config.js.
   ========================================================================== */

import { onRequest } from "firebase-functions/v2/https";
import { handle } from "./handler.js";

export const cal = onRequest(
  {
    /* Bound at deploy time; readable only by this function at runtime. */
    secrets: ["GHL_TOKEN"],

    /* handler.js sets its own CORS headers, so that Cloud Functions does not
       add a second, conflicting set. */
    cors: false,

    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 30,

    /* The four calendars are read on every page of the slot grid. One warm
       instance keeps that under a second instead of paying a cold start while
       somebody is mid-call. Costs a few pence a month. */
    minInstances: 0,
    maxInstances: 5,
  },
  async (req, res) => {
    const request = new Request(`https://${req.headers.host}${req.originalUrl || req.url}`, {
      method: req.method,
      headers: new Headers(req.headers),
      body: ["GET", "HEAD", "OPTIONS"].includes(req.method) ? undefined : JSON.stringify(req.body ?? {}),
    });

    const env = {
      GHL_TOKEN: process.env.GHL_TOKEN,
      GHL_LOCATION_ID: process.env.GHL_LOCATION_ID,
      FIREBASE_API_KEY: process.env.FIREBASE_API_KEY,
      CALENDAR_IDS: process.env.CALENDAR_IDS,
      ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || "*",
    };

    const out = await handle(request, env);
    out.headers.forEach((v, k) => res.set(k, v));
    res.status(out.status).send(await out.text());
  },
);
