import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { signInPublicFixturePerson } from "../public-mcp-flow.js";
import { readValidatedPublicOriginReceipt, PUBLIC_ORIGIN_RECEIPT_ENV } from "../chat-public-origin.js";
import { selectedRuntimeInputs } from "./runtime-private.js";
import { grokOperatorInputMatches, grokOperatorReceiptMatches, type GrokOperatorInput, type GrokOperatorReceipt } from "./runtime-grok-operator-contract.js";
export async function runPrivateGrokOperator(input: GrokOperatorInput, secrets: string[]) {
 for (const c of input.publicSession.cookies) secrets.push(c.value); for (const o of input.publicSession.origins) for (const item of o.localStorage) secrets.push(item.value); if (input.webhookKey) secrets.push(input.webhookKey); if (input.webhookUrl) secrets.push(input.webhookUrl);
 if (!grokOperatorInputMatches(input)) throw new Error("Setup blocker: selected authorized Grok operator/private public-session scope is unavailable");
 const directory = await mkdtemp(path.join(tmpdir(), "paperclip-grok-operator-")); await chmod(directory, 0o700);
 try { const filename = path.join(directory, "request.json"); await writeFile(filename, JSON.stringify(input), { mode: 0o600, flag: "wx" }); const loader = fileURLToPath(new URL("../../../server/node_modules/tsx/dist/loader.mjs", import.meta.url)), worker = fileURLToPath(new URL("./runtime-grok-operator-worker.ts", import.meta.url));
  let output: string; try { output = (await promisify(execFile)(process.execPath, ["--import", loader, worker, filename], { timeout: input.operation === "availability" ? 45000 : 420000, maxBuffer: 32768, env: { PATH: process.env.PATH ?? "", HOME: directory, TMPDIR: directory, NODE_ENV: "test", DO_NOT_TRACK: "1" } })).stdout; } catch { throw new Error(input.operation === "availability" ? "Setup blocker: explicitly selected Grok operator did not confirm availability within its bounded private UI; diagnostics withheld" : "Actual Grok human handoff failed; private pairing, OAuth and browser diagnostics withheld"); }
  if (secrets.some(secret => secret && [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64")].some(v => output.includes(v)))) throw new Error("Grok private child exceeded its closed secret-free receipt"); let receipt: GrokOperatorReceipt; try { receipt = JSON.parse(output); } catch { throw new Error("Grok operator returned no closed receipt"); } if (!grokOperatorReceiptMatches(receipt, { operation: input.operation, executionId: input.executionId, attemptId: input.attemptId, companyId: input.companyId, personId: input.personId, operatorRef: input.operatorRef, botAuthorizationRef: input.botAuthorizationRef })) throw new Error("Grok operator closed receipt identity mismatch"); return receipt;
 } finally { await rm(directory, { recursive: true, force: true }); }
}
export async function privateGrokOperator(ctx: ChatCatalogContext, operation: GrokOperatorInput["operation"], existingAgentId?: string) {
 const selected = selectedRuntimeInputs(ctx, "agents.existing-grok-bot"), p = selected.values, secrets = ctx.input.privateSecrets;
 if (!secrets || p.operatorMode !== "interactive-private-ui" || !p.operatorRef || !p.botAuthorizationRef || !selected.resourceIds.includes(p.botAuthorizationRef)) throw new Error("Setup blocker: explicitly selected available human operator and authorized existing Grok Bot reference are required; no desktop driver or ambient session is inferred");
 await signInPublicFixturePerson(ctx.input.api, ctx.input.page.context()); const receiptPath = process.env[PUBLIC_ORIGIN_RECEIPT_ENV], attemptId = process.env.PAPERCLIP_E2E_ACCOUNTING_ATTEMPT_ID; if (!receiptPath || !attemptId) throw new Error("Selected Grok operator requires its actual validated public origin");
 const origin = await readValidatedPublicOriginReceipt({ receiptPath, attemptId, executionId: ctx.input.execution.id, backendOrigin: ctx.input.api.baseURL }), person = await ctx.input.api.get<{ user: { id: string; name: string } }>("/api/auth/get-session"), storage = await ctx.input.page.context().storageState(), hostname = new URL(origin.publicOrigin).hostname;
 return runPrivateGrokOperator({ operation, receiptPath, attemptId, executionId: ctx.input.execution.id, backendOrigin: ctx.input.api.baseURL, publicOrigin: origin.publicOrigin, companyId: ctx.input.fixtures.company.id, companyName: ctx.input.fixtures.company.name, prefix: ctx.input.fixtures.company.issuePrefix!, personId: person.user.id, personName: person.user.name, leadId: ctx.input.fixtures.agent.id, botName: p.botId, operatorRef: p.operatorRef, botAuthorizationRef: p.botAuthorizationRef, operatorMode: "interactive-private-ui", publicSession: { cookies: storage.cookies.filter(c => c.domain.replace(/^\./, "") === hostname), origins: storage.origins.filter(o => o.origin === origin.publicOrigin) }, ...(operation === "setup" ? { existingAgentId, webhookUrl: p.endpoint, webhookKey: selected.reference(p.credentialEnvName) } : {}) }, secrets);
}
