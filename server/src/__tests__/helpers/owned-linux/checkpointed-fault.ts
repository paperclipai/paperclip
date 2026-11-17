// PRIVATE UNRUN fixture-only fault. No outcome, grant or lifecycle row writes.
import path from "node:path";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { environmentLeases, type Db } from "@paperclipai/db";
import type { PluginWorkerManager } from "../../../services/plugin-worker-manager.js";
import { nativeProviderRecoveryEvidence } from "../../../services/native-runtime/native-session-executor.js";

export async function stopCheckpointedOwnedRun(input: { db: Db; workerManager: PluginWorkerManager;
  runId: string; companyId: string; environmentId: string; providerRoot: string }) {
  // Uses the actual current remote checkpoint/header classifier. An offered
  // assignment alone is insufficient. This helper never creates a checkpoint.
  const evidence = await nativeProviderRecoveryEvidence({ db: input.db, runId: input.runId,
    sourceFailureCode: "native_session_interrupted", executionTargetKind: "remote" });
  if (evidence.recoveryMode !== "exact_checkpoint_resume" || !evidence.checkpointExists || !evidence.providerSessionEstablished)
    throw new Error("owned_fault_checkpoint_frontier_not_ready");
  const candidates = (await input.db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, input.runId)))
    .filter(row => row.companyId === input.companyId && row.environmentId === input.environmentId && row.status === "active");
  if (candidates.length !== 1) throw new Error("owned_fault_current_lease_ambiguous");
  const lease = candidates[0];
  const id = z.string().regex(/^dot-linux-[a-f0-9]{24}$/).parse(lease.providerLeaseId);
  const pluginId = z.string().min(1).parse(lease.metadata?.pluginId);
  const root = path.join(input.providerRoot, id);
  const resource = z.object({ id: z.literal(id), companyId: z.literal(input.companyId),
    environmentId: z.literal(input.environmentId), runId: z.literal(input.runId),
    containerId: z.string().regex(/^[a-f0-9]{64}$/), status: z.literal("active") }).passthrough()
    .parse(JSON.parse(await readFile(path.join(root, "resource.json"), "utf8")));
  const custody = path.join(root, "workspace/.paperclip-runtime/.qualification-custody");
  const names = (await readdir(custody)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
  if (names.length > 128) throw new Error("owned_fault_custody_inventory_overflow");
  const journals = await Promise.all(names.map(async name => JSON.parse(await readFile(path.join(custody, name), "utf8"))));
  const proofs = journals.filter(row => row.joined === true && !row.timedOut && !row.overflow && !row.spawnError && row.verifiedNativeKernel);
  if (!proofs.length) throw new Error("owned_fault_original_kernel_witness_missing");
  const kernel = z.object({ pid: z.number().int().positive(), group: z.number().int().positive(),
    fingerprint: z.string().regex(/^linux:[a-f0-9-]+:[0-9]+$/) }).passthrough().parse(proofs.at(-1).verifiedNativeKernel);
  const intent = { runId: input.runId, providerLeaseId: id, containerId: resource.containerId,
    kernel, checkpoint: evidence, namespaceTerminationOnly: true };
  const faultFile = path.join(input.providerRoot, "first-native-stop.json");
  await writeFile(faultFile, JSON.stringify({ status: "stop_intent", ...intent }), { flag: "wx", mode: 0o600 });
  // Real verified SDK owner terminates the exact container, then joins actual
  // WSS/relay close events. DB lease/Native failure state remain normal owners'.
  const stopStarted = performance.now();
  let stage: "stop_rpc" | "validate_stop_result" | "persist_stop_receipt" = "stop_rpc";
  try {
    const stopped = await input.workerManager.call(pluginId, "environmentStopLease", {
      driverKey: "dot-linux-qualification", config: { qualificationId: "dot-owned-linux" },
      companyId: input.companyId, environmentId: input.environmentId, providerLeaseId: id,
      resourceDisposition: "stop_and_retain", leaseMetadata: lease.metadata ?? undefined,
    });
    stage = "validate_stop_result";
    const termination = z.object({ providerLeaseId: z.literal(id), state: z.literal("stopped") }).strict().parse(stopped);
    const receipt = { status: "stopped", ...intent, termination };
    stage = "persist_stop_receipt";
    await writeFile(faultFile, JSON.stringify(receipt), { mode: 0o600 });
    return receipt;
  } catch (primary) {
    // One failure-only, credential-free witness. It never proves termination,
    // changes the stop result, retries a call, or replaces the original error.
    const allowedFailures = new Set([
      "owned_ingress_closure_unknown_retained", "owned_stop_unknown_retained",
      "owned_stop_not_observed_retained", "owned_calls_or_outcomes_unknown_retained",
      "owned_resource_retiring", "owned_provider_closing", "owned_linux_shutdown_failed_retained",
    ]);
    const fixedFailure = primary instanceof Error && allowedFailures.has(primary.message)
      ? primary.message : "unclassified";
    const exception = primary instanceof JsonRpcCallError
      ? primary.code === PLUGIN_RPC_ERROR_CODES.TIMEOUT ? "rpc_timeout"
        : primary.code === PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE ? "rpc_worker_unavailable" : "rpc_error"
      : primary instanceof z.ZodError ? "result_schema" : primary instanceof Error ? "error" : "non_error";
    const osCode = z.object({ code: z.enum([
      "EACCES", "EPERM", "ENOENT", "ENOTDIR", "EISDIR", "EROFS", "ENOSPC", "EEXIST", "EINVAL", "EMFILE", "ENFILE",
    ]) }).safeParse(primary);
    try {
      await writeFile(path.join(root, "first-stop-failure.json"), JSON.stringify({
        version: 1, stage, exception, fixedFailure, osCode: osCode.success ? osCode.data.code : "none",
        elapsedMs: Math.max(0, performance.now() - stopStarted), originalFailureRethrown: true,
        noRawErrorOrPayload: true, noAdditionalObservationCalls: true,
      }) + "\n", { flag: "wx", mode: 0o600 });
    } catch {
      process.stderr.write("owned_stop_failure_witness_unwritten\n");
    }
    throw primary;
  }
}
