import { access, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunnerApi } from "./api.js";
import { collectAttemptFeedback, emptyFeedbackSummary, type FeedbackEvidence, type FeedbackSummary } from "./feedback.js";
import { assertSecretFree, sanitizeJson } from "./redaction.js";

export interface FeedbackRecoveryIdentity {
  campaignId: string;
  attemptId: string;
  executionId: string;
}

const exists = (file: string) => access(file).then(() => true, () => false);

export async function recoverInterruptedFeedback(input: {
  identity: FeedbackRecoveryIdentity;
  caseDirectory: string;
  api: Pick<RunnerApi, "get">;
  secrets: readonly string[];
  deadlineAt: number;
}) {
  const deadline = AbortSignal.timeout(Math.max(1, input.deadlineAt - Date.now()));
  if (await exists(path.join(input.caseDirectory, "result.json"))) return;
  const snapshots = path.join(input.caseDirectory, "snapshots");
  let fixture: { executionId?: string; companyId?: string };
  try { fixture = JSON.parse(await readFile(path.join(snapshots, "fixtures.json"), { encoding: "utf8", signal: deadline })); }
  catch { return; }
  if (fixture.executionId !== input.identity.executionId || !/^[a-f0-9-]{36}$/i.test(fixture.companyId ?? "")) return;
  const companyId = fixture.companyId!;
  let summary = emptyFeedbackSummary();
  let checkpoint: FeedbackEvidence | undefined;
  const recoveryReceipt = (summary: FeedbackSummary) => ({ version: 1, ...input.identity, companyId,
    reason: "worker_exited_without_result", summary });
  const save = async (name: string, value: unknown, signal: AbortSignal = deadline) => {
    const text = JSON.stringify(sanitizeJson(value, input.secrets), null, 2) + "\n";
    assertSecretFree(text, input.secrets, name);
    await writeFile(path.join(snapshots, `${name}.pending`), text, { mode: 0o600, signal });
    signal.throwIfAborted();
    await rename(path.join(snapshots, `${name}.pending`), path.join(snapshots, name));
  };
  const saveCheckpoint = (evidence: FeedbackEvidence, signal: AbortSignal = deadline) =>
    save("agent-feedback-recovered.json", { ...evidence, recovery: recoveryReceipt({ ...evidence.summary,
      collection: evidence.summary.bodiesCollected ? "partial" : "unavailable",
      invocationCollection: evidence.invocations.length ? "partial" : "unavailable" }) }, signal);
  try {
    const original = JSON.parse(await readFile(path.join(snapshots, "agent-feedback.json"), { encoding: "utf8", signal: deadline }));
    if (original.version === 1 && original.companyId === companyId && original.summary?.version === 1
      && Array.isArray(original.entries) && Array.isArray(original.invocations)
      && original.summary.bodiesCollected === original.entries.length) {
      await saveCheckpoint(original);
      checkpoint = original;
      summary = structuredClone(original.summary);
    }
  } catch {}
  try {
    const collected = await collectAttemptFeedback({ api: input.api, companyId, deadlineAt: input.deadlineAt,
      persist: async (evidence, signal) => {
        if (checkpoint && (!checkpoint.entries.every(entry => evidence.entries.some(next => next.id === entry.id))
          || !checkpoint.invocations.every(call => evidence.invocations.some(next => next.runId === call.runId && next.callId === call.callId)))) return;
        await saveCheckpoint(evidence, signal);
        checkpoint = structuredClone(evidence);
        summary = structuredClone(evidence.summary);
      },
    });
    summary.collection = summary.bodiesCollected ? "partial" : collected.collection;
    summary.invocationCollection = summary.invocations.completed + summary.invocations.failed + summary.invocations.unknown
      ? "partial" : collected.invocationCollection;
  } catch {
    summary.collection = summary.bodiesCollected ? "partial" : "unavailable";
    summary.invocationCollection = "unavailable";
  }
  await save("feedback-recovery.json", recoveryReceipt(summary));
}

export async function readRecoveredFeedback(caseDirectory: string, identity: FeedbackRecoveryIdentity): Promise<FeedbackSummary | undefined> {
  try {
    const snapshots = path.join(caseDirectory, "snapshots");
    const evidence = JSON.parse(await readFile(path.join(snapshots, "agent-feedback-recovered.json"), "utf8"));
    let receipt = evidence.recovery;
    try { receipt = JSON.parse(await readFile(path.join(snapshots, "feedback-recovery.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return; }
    if (receipt?.version !== 1 || evidence.version !== 1 || receipt.reason !== "worker_exited_without_result"
      || !receipt.companyId || receipt.companyId !== evidence.companyId
      || Object.entries(identity).some(([key, value]) => receipt[key] !== value)) return;
    const summary = evidence.summary as FeedbackSummary;
    const statuses = ["complete", "partial", "unavailable", "not_started"];
    if (summary?.version !== 1 || !Array.isArray(evidence.entries) || !Array.isArray(evidence.invocations)
      || summary.bodiesCollected !== evidence.entries.length || !Array.isArray(summary.review)
      || ![summary.complaints, summary.suggestions, summary.bodiesCollected, summary.runsInspected,
        summary.invocations?.completed, summary.invocations?.failed, summary.invocations?.unknown]
        .every(value => Number.isSafeInteger(value) && value >= 0)
      || !["observed", "unknown"].includes(summary.toolAvailability)
      || !["collection", "invocationCollection"].every(key => {
        const original = summary[key as "collection" | "invocationCollection"];
        const recovered = receipt.summary?.[key];
        return statuses.includes(original) && statuses.includes(recovered)
          && (recovered === original || recovered === "partial" || recovered === "unavailable");
      })) return;
    return { ...summary, collection: receipt.summary.collection, invocationCollection: receipt.summary.invocationCollection };
  } catch { return; }
}
