import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_TARGET =
  "/usr/local/lib/node_modules/paperclipai/node_modules/@paperclipai/adapter-openclaw-gateway/dist/server/execute.js";

const target = process.argv[2] || DEFAULT_TARGET;

function replaceRequired(text, label, matcher, replacement) {
  if (typeof matcher === "string") {
    if (!text.includes(matcher)) {
      throw new Error(`Patch anchor not found (${label}) in ${target}`);
    }
    return text.replace(matcher, replacement);
  }
  if (!matcher.test(text)) {
    throw new Error(`Patch anchor not found (${label}) in ${target}`);
  }
  return text.replace(matcher, replacement);
}

function patchClaimedApiKeyPathEnv(text) {
  if (!text.includes("claimedApiKeyPathOverride")) {
    text = replaceRequired(
      text,
      "paperclip API URL override",
      /(const\s+paperclipApiUrlOverride\s*=\s*resolvePaperclipApiUrlOverride\(ctx\.config\.paperclipApiUrl\);?\s*)/,
      "$1    const claimedApiKeyPathOverride = nonEmpty(ctx.config.claimedApiKeyPath);\n",
    );
  }

  if (!/paperclipEnv\.PAPERCLIP_API_KEY_PATH\s*=\s*claimedApiKeyPathOverride/.test(text)) {
    text = replaceRequired(
      text,
      "paperclip env API URL block",
      /(if\s*\(\s*paperclipApiUrlOverride\s*\)\s*\{\s*paperclipEnv\.PAPERCLIP_API_URL\s*=\s*paperclipApiUrlOverride;\s*\})/,
      "$1\n    if (claimedApiKeyPathOverride) {\n        paperclipEnv.PAPERCLIP_API_KEY_PATH = claimedApiKeyPathOverride;\n    }",
    );
  }

  return text;
}

function patchWakeTextClaimedApiKeyPath(text) {
  if (/const\s+claimedApiKeyPath\s*=\s*nonEmpty\(paperclipEnv\.PAPERCLIP_API_KEY_PATH\)/.test(text)) {
    return text;
  }

  return replaceRequired(
    text,
    "wake text claimed API key path",
    /const\s+claimedApiKeyPath\s*=\s*["']~\/\.openclaw\/workspace\/paperclip-claimed-api-key\.json["'];?/,
    'const claimedApiKeyPath = nonEmpty(paperclipEnv.PAPERCLIP_API_KEY_PATH) ?? "~/.openclaw/workspace/paperclip-claimed-api-key.json";',
  );
}

function patchOrderedEnvKeys(text) {
  const orderedKeysPattern = /const\s+orderedKeys\s*=\s*\[([\s\S]*?)\];/;
  const match = orderedKeysPattern.exec(text);
  if (!match) {
    throw new Error(`Patch anchor not found (ordered env keys) in ${target}`);
  }
  if (match[1].includes("PAPERCLIP_API_KEY_PATH")) {
    return text;
  }
  const patchedBlock = match[0].replace(
    /(["']PAPERCLIP_API_URL["']\s*,)/,
    "$1\n        \"PAPERCLIP_API_KEY_PATH\",",
  );
  if (patchedBlock === match[0]) {
    throw new Error(`Patch anchor not found (PAPERCLIP_API_URL ordered key) in ${target}`);
  }
  return text.slice(0, match.index) + patchedBlock + text.slice(match.index + match[0].length);
}

function patchStandardPaperclipPayload(text) {
  if (/apiKeyPath\s*:\s*paperclipEnv\.PAPERCLIP_API_KEY_PATH\s*\?\?\s*null/.test(text)) {
    return text;
  }

  return replaceRequired(
    text,
    "standard paperclip payload apiUrl",
    /(apiUrl\s*:\s*paperclipEnv\.PAPERCLIP_API_URL\s*\?\?\s*null)\s*,?/,
    "$1,\n        apiKeyPath: paperclipEnv.PAPERCLIP_API_KEY_PATH ?? null,",
  );
}

function patchChallengePromiseRejection(text) {
  if (/this\.challengePromise\.catch\(\(\)\s*=>\s*\{\s*\}\)/.test(text)) {
    return text;
  }

  return replaceRequired(
    text,
    "gateway challenge promise rejection guard",
    /(this\.challengePromise\s*=\s*new Promise[^{]*\(\s*\(\s*resolve\s*,\s*reject\s*\)\s*=>\s*\{[\s\S]*?this\.rejectChallenge\s*=\s*reject;\s*\}\s*\);)/,
    "$1\n        this.challengePromise.catch(() => {});",
  );
}

function patchUnhandledRequestRejection(text) {
  if (/requestPromise\.catch\(\(\)\s*=>/.test(text)) {
    return text;
  }

  return replaceRequired(
    text,
    "gateway request send",
    /(\s*)this\.ws\.send\(payload\);/,
    '$1requestPromise.catch(() => {\n$1    // WebSocket close can reject pending requests from an event callback\n$1    // before the caller has attached its await/catch chain.\n$1});\n$1this.ws.send(payload);',
  );
}

export function patchOpenClawGatewayDist(sourceText) {
  let text = sourceText;
  text = patchClaimedApiKeyPathEnv(text);
  text = patchWakeTextClaimedApiKeyPath(text);
  text = patchOrderedEnvKeys(text);
  text = patchStandardPaperclipPayload(text);
  text = patchChallengePromiseRejection(text);
  text = patchUnhandledRequestRejection(text);
  return text;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const source = readFileSync(target, "utf8");
  const patched = patchOpenClawGatewayDist(source);

  if (patched !== source) {
    writeFileSync(target, patched);
    console.log(`patched ${target}`);
  } else {
    console.log(`already patched ${target}`);
  }
}
