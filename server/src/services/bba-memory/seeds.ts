/**
 * BBA Memory — initial seed data for `selectors_observed`.
 *
 * Pulled from the existing OVERLAY_SELECTORS catalog in
 * `services/bba-session-keepalive.ts` plus the login form selectors
 * discovered by `scripts/bba-probe-login.mjs`.
 *
 * Seeded with `source = 'seeded'` so they're distinguishable from
 * runtime-discovered ones. Priority preserves the order the keepalive
 * already uses (lower = tried first); JOACĂ ÎN CONTINUARE stays at #1
 * because clicking it triggers Casa's server-side re-auth.
 */
import type { SelectorPurpose, SelectorSource } from "./types.js";

export interface SeedSelector {
  purpose: SelectorPurpose;
  selector: string;
  label: string;
  priority: number;
  source: SelectorSource;
  notes?: string;
}

export const SEED_SELECTORS: SeedSelector[] = [
  // ---- overlays / popups (ordered as in keepalive's OVERLAY_SELECTORS) ----
  {
    purpose: "overlay",
    selector: "button:has-text('JOACĂ ÎN CONTINUARE')",
    label: "Joacă în continuare (re-auth trigger)",
    priority: 1,
    source: "seeded",
    notes: "Clicking this triggers site-side re-auth — must be tried FIRST.",
  },
  {
    purpose: "overlay",
    selector: "button:has-text('ACCEPT TOATE')",
    label: "Cookie banner — Accept all (uppercase)",
    priority: 10,
    source: "seeded",
  },
  {
    purpose: "overlay",
    selector: "button:has-text('Accept toate')",
    label: "Cookie banner — Accept all (mixed case)",
    priority: 11,
    source: "seeded",
  },
  {
    purpose: "overlay",
    selector: "button:has-text('DOAR CELE NECESARE')",
    label: "Cookie banner — Only necessary",
    priority: 12,
    source: "seeded",
    notes: "Privacy-preserving fallback if Accept toate not available.",
  },
  {
    purpose: "overlay",
    selector: "button:has-text('Romanian')",
    label: "Language picker — Romanian (English label)",
    priority: 20,
    source: "seeded",
  },
  {
    purpose: "overlay",
    selector: "button:has-text('Română')",
    label: "Language picker — Română",
    priority: 21,
    source: "seeded",
  },
  {
    purpose: "overlay",
    selector: "[class*='popup'] [class*='close']",
    label: "Generic popup close",
    priority: 30,
    source: "seeded",
  },
  {
    purpose: "overlay",
    selector: "[class*='modal'] [class*='close']",
    label: "Generic modal close",
    priority: 31,
    source: "seeded",
  },
  {
    purpose: "overlay",
    selector: ".modal-close",
    label: "Bootstrap-style modal close",
    priority: 32,
    source: "seeded",
  },
  {
    purpose: "overlay",
    selector: "button[aria-label='Close']",
    label: "ARIA Close button",
    priority: 33,
    source: "seeded",
  },
  {
    purpose: "overlay",
    selector: "button[aria-label='Inchide']",
    label: "ARIA Închide button",
    priority: 34,
    source: "seeded",
  },
  {
    purpose: "overlay",
    selector: "[class*='promo'] button[class*='close']",
    label: "Promo banner close",
    priority: 40,
    source: "seeded",
  },
  {
    purpose: "overlay",
    selector: "button:has-text('Sunt major')",
    label: "Age gate — Sunt major",
    priority: 50,
    source: "seeded",
  },
  {
    purpose: "overlay",
    selector: "button:has-text('Am peste 18 ani')",
    label: "Age gate — Am peste 18 ani",
    priority: 51,
    source: "seeded",
  },

  // ---- login flow selectors ----
  {
    purpose: "login-button",
    selector: ".header-login-wrapper.user-box-link",
    label: "CONECTARE header button",
    priority: 1,
    source: "seeded",
    notes: "Visible only when logged out — drives the session-active heuristic.",
  },
  {
    purpose: "login-button",
    selector: "a:has-text('CONECTARE')",
    label: "CONECTARE link (text fallback)",
    priority: 5,
    source: "seeded",
  },
  {
    purpose: "login-button",
    selector: "button:has-text('CONECTARE')",
    label: "CONECTARE button (text fallback)",
    priority: 6,
    source: "seeded",
  },
  {
    purpose: "username-input",
    selector: "input[type='text']",
    label: "Username — generic text input",
    priority: 50,
    source: "seeded",
    notes: "Loose fallback. Prefer name/placeholder-based selectors when known.",
  },
  {
    purpose: "username-input",
    selector: "input[placeholder*='utilizator' i]",
    label: "Username — placeholder utilizator",
    priority: 10,
    source: "seeded",
  },
  {
    purpose: "username-input",
    selector: "input[name*='user' i]",
    label: "Username — name attribute",
    priority: 20,
    source: "seeded",
  },
  {
    purpose: "password-input",
    selector: "input[type='password']",
    label: "Password input",
    priority: 1,
    source: "seeded",
  },
  {
    purpose: "submit-login",
    selector: "button[class*='user-box-form-button']",
    label: "Login submit — Casa class",
    priority: 1,
    source: "seeded",
  },
  {
    purpose: "submit-login",
    selector: "form button[type='submit']",
    label: "Login submit — generic form button",
    priority: 10,
    source: "seeded",
  },
  {
    purpose: "submit-login",
    selector: "button:has-text('CONECTARE')",
    label: "Login submit — CONECTARE text (in modal)",
    priority: 20,
    source: "seeded",
  },
  {
    purpose: "submit-login",
    selector: ".modal button[type='submit']",
    label: "Login submit — modal scoped",
    priority: 30,
    source: "seeded",
  },

  // ---- session state heuristics ----
  {
    purpose: "session-expired",
    selector: ".header-login-wrapper.user-box-link",
    label: "CONECTARE visible = expired",
    priority: 1,
    source: "seeded",
    notes: "Same selector as login-button. Visibility = logged out.",
  },
  {
    purpose: "session-active",
    selector: ".user-balance",
    label: "User balance widget visible",
    priority: 1,
    source: "seeded",
  },
  {
    purpose: "session-active",
    selector: "[class*='user-balance']",
    label: "User balance — class fuzzy match",
    priority: 10,
    source: "seeded",
  },
  {
    purpose: "session-active",
    selector: "[class*='logged-in']",
    label: "Logged-in container",
    priority: 11,
    source: "seeded",
  },

  // ---- captcha heuristics (visibility = failure signal, NOT something to click) ----
  {
    purpose: "captcha-detected",
    selector: "iframe[src*='recaptcha']",
    label: "reCAPTCHA iframe",
    priority: 1,
    source: "seeded",
    notes: "Detection only. Never auto-click. Triggers CAPTCHA_VISIBLE failure class.",
  },
  {
    purpose: "captcha-detected",
    selector: "iframe[src*='hcaptcha']",
    label: "hCaptcha iframe",
    priority: 2,
    source: "seeded",
    notes: "Detection only.",
  },
  {
    purpose: "captcha-detected",
    selector: "[class*='captcha']",
    label: "Captcha class fuzzy match",
    priority: 10,
    source: "seeded",
    notes: "Detection only.",
  },
  {
    purpose: "captcha-detected",
    selector: "[class*='challenge']",
    label: "Challenge class fuzzy match",
    priority: 11,
    source: "seeded",
    notes: "Detection only.",
  },
];
