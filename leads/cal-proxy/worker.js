/* Cloudflare Worker entry point. All the logic is in handler.js; this exists
   only to hand Cloudflare's (request, env) to it.

   Deploy:
     npx wrangler deploy
     npx wrangler secret put GHL_TOKEN
   Then paste the printed https://…workers.dev URL into BOOKING.proxy in
   ../config.js and rebuild the GHL block. */

import { handle } from "./handler.js";

export default {
  fetch: (request, env) => handle(request, env),
};
