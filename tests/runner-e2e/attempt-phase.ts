import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { EvalChargeIdentity } from "./cost-ledger.js";

type Identity = Pick<EvalChargeIdentity, "executionId" | "attemptId">;
interface Checkpoint extends Identity { version: 1; phase: "setup" | "agent" }

export async function createEvalAttemptPhase(file: string, identity: Identity) {
  await writeFile(file, JSON.stringify({ version: 1, ...identity, phase: "setup" }), { mode: 0o600, flag: "wx" });
}

export async function readEvalAttemptPhase(file: string, expected: Identity): Promise<EvalChargeIdentity> {
  const text = await readFile(file, "utf8");
  if (text.length > 4096) throw new Error("Invalid eval phase checkpoint");
  const value = JSON.parse(text) as Checkpoint;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => !["version", "executionId", "attemptId", "phase"].includes(key))
      || value.version !== 1 || value.executionId !== expected.executionId || value.attemptId !== expected.attemptId
      || !["setup", "agent"].includes(value.phase)) throw new Error("Invalid eval phase checkpoint");
  return { ...expected, phase: value.phase };
}

export async function beginEvalAgentPhase(executionId: string, env: NodeJS.ProcessEnv = process.env) {
  const file = env.PAPERCLIP_E2E_GATEWAY_PHASE_PATH;
  if (!file && !env.PAPERCLIP_E2E_GATEWAY_BASE_URL) return;
  if (!file || !env.PAPERCLIP_E2E_ACCOUNTING_ATTEMPT_ID) throw new Error("Missing eval phase checkpoint");
  const identity = await readEvalAttemptPhase(file, { executionId, attemptId: env.PAPERCLIP_E2E_ACCOUNTING_ATTEMPT_ID });
  if (identity.phase === "agent") return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, ...identity, phase: "agent" }), { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
