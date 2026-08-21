/* ============================================================================
   dom.js — the three helpers every view needs.

   Their own file because app.js and booking.js both need them, and the GHL
   build concatenates every module into one scope: two files each declaring
   `const $` would be a syntax error the moment they were joined.
   ========================================================================== */

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* Escape before interpolating into HTML. Everything in this app that reaches
   innerHTML goes through here — lead names and comments are user input, and a
   company whose name contains angle brackets should render, not run. Note the
   GHL build inlines all of this into one script tag, so a literal closing tag
   anywhere in this file — even inside a comment — would end it early. */
export const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
