/**
 * HEB Grocery Plugin — Auth Setup Script
 *
 * Run this once to obtain your HEB bearer tokens via the PKCE OAuth flow.
 * The tokens you get here go into the HEB Grocery plugin settings.
 *
 * Usage:
 *   node packages/plugins/examples/plugin-heb-grocery/scripts/setup-auth.mjs
 */

import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const rl = readline.createInterface({ input, output });

console.log("=".repeat(60));
console.log("HEB Grocery Plugin — Bearer Token Setup");
console.log("=".repeat(60));
console.log();

// Dynamically import so this runs from any CWD
const { buildAuthUrl, createOAuthContext, exchangeCode } = await import(
  "heb-auth-unofficial"
);

const context = createOAuthContext();
const authUrl = buildAuthUrl(context).toString();

console.log("Step 1: Open this URL in a web browser and log in to your HEB account:");
console.log();
console.log("  " + authUrl);
console.log();
console.log("Step 2: After logging in, your browser will try to open a URL that");
console.log("        starts with:  com.heb.myheb://oauth2redirect?code=...");
console.log();
console.log("  - If Chrome shows 'This site can't be reached' — copy the full URL");
console.log("    from the address bar.");
console.log("  - If the page redirects silently, open DevTools → Network tab,");
console.log("    look for a request to 'oauth2redirect', and copy its full URL.");
console.log("  - On macOS you may see a dialog asking to open the HEB app —");
console.log("    dismiss it and copy the URL from the address bar.");
console.log();

const redirectUrl = await rl.question("Paste the full redirect URL here: ");
console.log();

let code;
try {
  const parsed = new URL(redirectUrl.trim());
  code = parsed.searchParams.get("code");
  if (!code) throw new Error("no 'code' param found");
} catch {
  console.error("Could not parse a 'code' from that URL.");
  console.error("Make sure you pasted the full redirect URL including ?code=...");
  process.exit(1);
}

console.log("Exchanging code for tokens...");
let tokens;
try {
  tokens = await exchangeCode({ code, codeVerifier: context.codeVerifier });
} catch (err) {
  console.error("Token exchange failed:", err.message);
  process.exit(1);
}

rl.close();

console.log();
console.log("=".repeat(60));
console.log("SUCCESS — paste these values into the HEB Grocery plugin settings:");
console.log("=".repeat(60));
console.log();
console.log("  HEB Access Token (Bearer):  " + tokens.accessToken);
console.log();
console.log("  HEB Refresh Token:          " + (tokens.refreshToken ?? "(none)"));
console.log();
console.log("  HEB ID Token:               " + (tokens.idToken ?? "(none)"));
console.log();
console.log("Access tokens expire in ~30 minutes. Set the Refresh Token in plugin");
console.log("settings so the plugin can renew it automatically.");
console.log();
console.log("Next: follow the Cookie setup instructions to enable cart operations.");
