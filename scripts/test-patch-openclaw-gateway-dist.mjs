import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { patchOpenClawGatewayDist } from "./patch-openclaw-gateway-dist.mjs";

const oldCompiledShape = `
function buildPaperclipEnvForWake(ctx, wakePayload) {
    const paperclipApiUrlOverride = resolvePaperclipApiUrlOverride(ctx.config.paperclipApiUrl);
    const paperclipEnv = {
        ...buildPaperclipEnv(ctx.agent),
        PAPERCLIP_RUN_ID: ctx.runId,
    };
    if (paperclipApiUrlOverride) {
        paperclipEnv.PAPERCLIP_API_URL = paperclipApiUrlOverride;
    }
    return paperclipEnv;
}
function buildWakeText(payload, paperclipEnv) {
    const claimedApiKeyPath = "~/.openclaw/workspace/paperclip-claimed-api-key.json";
    const orderedKeys = [
        "PAPERCLIP_RUN_ID",
        "PAPERCLIP_AGENT_ID",
        "PAPERCLIP_COMPANY_ID",
        "PAPERCLIP_API_URL",
        "PAPERCLIP_TASK_ID",
    ];
}
function buildStandardPaperclipPayload(ctx, wakePayload, paperclipEnv, payloadTemplate) {
    const standardPaperclip = {
        approvalStatus: wakePayload.approvalStatus,
        apiUrl: paperclipEnv.PAPERCLIP_API_URL ?? null,
    };
    return standardPaperclip;
}
class GatewayClient {
    constructor(opts) {
        this.opts = opts;
        this.challengePromise = new Promise((resolve, reject) => {
            this.resolveChallenge = resolve;
            this.rejectChallenge = reject;
        });
    }
    async request(method, params, opts) {
        const requestPromise = new Promise((resolve, reject) => {
            this.pending.set(id, {
                resolve: (value) => resolve(value),
                reject,
                expectFinal: opts.expectFinal === true,
                timer,
            });
        });
        this.ws.send(payload);
        return requestPromise;
    }
}
`;

const driftedCompiledShape = `
function buildPaperclipEnvForWake(ctx,wakePayload) {
    const paperclipApiUrlOverride = resolvePaperclipApiUrlOverride(ctx.config.paperclipApiUrl)
    const paperclipEnv = { ...buildPaperclipEnv(ctx.agent), PAPERCLIP_RUN_ID: ctx.runId };
    if (paperclipApiUrlOverride) { paperclipEnv.PAPERCLIP_API_URL = paperclipApiUrlOverride; }
    return paperclipEnv;
}
function buildWakeText(payload,paperclipEnv) {
    const claimedApiKeyPath = "~/.openclaw/workspace/paperclip-claimed-api-key.json"
    const orderedKeys = ["PAPERCLIP_RUN_ID", "PAPERCLIP_AGENT_ID", "PAPERCLIP_COMPANY_ID", "PAPERCLIP_API_URL", "PAPERCLIP_TASK_ID"];
}
function buildStandardPaperclipPayload(ctx,wakePayload,paperclipEnv,payloadTemplate) {
    return { approvalStatus: wakePayload.approvalStatus, apiUrl: paperclipEnv.PAPERCLIP_API_URL ?? null };
}
class GatewayClient {
    constructor(opts) { this.opts = opts; this.challengePromise = new Promise((resolve, reject) => { this.resolveChallenge = resolve; this.rejectChallenge = reject; }); }
    async request(method, params, opts) {
        const requestPromise = new Promise((resolve, reject) => {
            this.pending.set(id, { resolve: (value) => resolve(value), reject, expectFinal: opts.expectFinal === true, timer });
        });
        this.ws.send(payload);
        return requestPromise;
    }
}
`;

function assertPatched(source) {
  const patched = patchOpenClawGatewayDist(source);
  assert.match(patched, /claimedApiKeyPathOverride/);
  assert.match(patched, /PAPERCLIP_API_KEY_PATH\s*=\s*claimedApiKeyPathOverride/);
  assert.match(patched, /nonEmpty\(paperclipEnv\.PAPERCLIP_API_KEY_PATH\)/);
  assert.match(patched, /"PAPERCLIP_API_KEY_PATH"/);
  assert.match(patched, /apiKeyPath\s*:\s*paperclipEnv\.PAPERCLIP_API_KEY_PATH\s*\?\?\s*null/);
  assert.match(patched, /this\.challengePromise\.catch/);
  assert.match(patched, /requestPromise\.catch/);
  assert.equal(patchOpenClawGatewayDist(patched), patched);
}

assertPatched(oldCompiledShape);
assertPatched(driftedCompiledShape);

const tempDir = mkdtempSync(join(tmpdir(), "paperclip-openclaw-patch-"));
try {
  const target = join(tempDir, "execute.js");
  writeFileSync(target, oldCompiledShape);
  const result = spawnSync(process.execPath, [new URL("./patch-openclaw-gateway-dist.mjs", import.meta.url).pathname, target], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(readFileSync(target, "utf8"), /PAPERCLIP_API_KEY_PATH/);

  const verifyResult = spawnSync(
    process.execPath,
    [new URL("./verify-openclaw-gateway-dist-patch.mjs", import.meta.url).pathname, target],
    { encoding: "utf8" },
  );
  assert.equal(verifyResult.status, 0, verifyResult.stderr || verifyResult.stdout);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log("patch-openclaw-gateway-dist tests passed");
