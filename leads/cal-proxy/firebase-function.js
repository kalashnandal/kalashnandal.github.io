/* Firebase Functions (2nd gen) entry point — the alternative to worker.js if
   you would rather keep everything inside the Firebase project. Needs the
   Blaze plan; at this volume the bill is effectively zero, but a card has to
   be on file.

   Deploy:
     cd functions && npm i firebase-functions
     firebase deploy --only functions:cal
     firebase functions:secrets:set GHL_TOKEN

   The handler speaks the Web Fetch API, and Cloud Functions gives Express-style
   (req, res), so this translates between the two. */

import { onRequest } from "firebase-functions/v2/https";
import { handle } from "./handler.js";

export const cal = onRequest(
  { secrets: ["GHL_TOKEN"], cors: false },
  async (req, res) => {
    const url = `https://${req.headers.host}${req.originalUrl || req.url}`;
    const request = new Request(url, {
      method: req.method,
      headers: new Headers(req.headers),
      body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body ?? {}),
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
