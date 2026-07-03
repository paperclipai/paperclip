import { readFileSync } from "node:fs";

const DEFAULT_TARGET =
  "/usr/local/lib/node_modules/paperclipai/node_modules/@paperclipai/adapter-openclaw-gateway/dist/server/execute.js";

const target = process.argv[2] || DEFAULT_TARGET;
const source = readFileSync(target, "utf8");

const requiredMarkers = [
  ["claimed API key path override", /claimedApiKeyPathOverride/],
  ["env API key path assignment", /PAPERCLIP_API_KEY_PATH\s*=\s*claimedApiKeyPathOverride/],
  ["wake text API key path", /nonEmpty\(paperclipEnv\.PAPERCLIP_API_KEY_PATH\)/],
  ["ordered env key", /["']PAPERCLIP_API_KEY_PATH["']/],
  ["standard payload API key path", /apiKeyPath\s*:\s*paperclipEnv\.PAPERCLIP_API_KEY_PATH\s*\?\?\s*null/],
  ["challenge rejection guard", /this\.challengePromise\.catch\(\(\)\s*=>\s*\{\s*\}\)/],
  ["request rejection guard", /requestPromise\.catch\(\(\)\s*=>/],
];

const missing = requiredMarkers
  .filter(([, matcher]) => !matcher.test(source))
  .map(([label]) => label);

if (missing.length > 0) {
  throw new Error(`OpenClaw gateway dist patch incomplete in ${target}: missing ${missing.join(", ")}`);
}

console.log(`verified OpenClaw gateway dist patch in ${target}`);
