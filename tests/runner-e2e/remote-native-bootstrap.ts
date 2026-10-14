import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ObservedStateTimeout, RemoteAdmissionReadError, RunnerApiHttpError, pollUntil } from "./api.js";
import { classifyFailure } from "./failure-classifier.js";
import { REMOTE_FIXTURE_MIN_SETUP_BUDGET_MS, bindRemoteNativeFixture, remoteNativeFixtureDiagnostics, type RemoteFixtureApi, type RemoteFixtureDaytona, type RemoteNativeFixture } from "./remote-native-fixtures.js";

type AdmissionEndpoint = "issue" | "run" | "leases";

function admissionReadError(endpoint: AdmissionEndpoint, error: unknown): RemoteAdmissionReadError {
  let failureClass: RemoteAdmissionReadError["failureClass"] = "candidate_failure";
  // Only typed status or transport diagnostics classify the failure. In
  // particular, an HTTP body must not supply classification keywords.
  try {
    if (error instanceof RunnerApiHttpError) {
      if (error.status === 408 || error.status === 429 || (error.status >= 500 && error.status <= 599)) failureClass = "transient_infrastructure";
      else if (error.status === 401 || error.status === 403) failureClass = "permanent_infrastructure";
    } else if (error instanceof Error) {
      const message = error.message.slice(0, 256);
      if (error.name === "TimeoutError" || /^(?:apiRequestContext\.get: )?Timeout \d+ms exceeded\b/u.test(message)
        || /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up)\b/iu.test(message)) failureClass = "transient_infrastructure";
    }
  } catch { /* Unknown rejection values remain a bounded candidate failure. */ }
  return new RemoteAdmissionReadError(endpoint, failureClass);
}

function admissionJson(endpoint: AdmissionEndpoint, value: unknown): boolean {
  const record = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item);
  return endpoint === "leases" ? Array.isArray(value) && value.every(record) : record(value);
}

export interface RemoteNativeBootstrap {
  prompt(nonce: string): string;
  bindAndRelease(input: {
    issueId: string; runId: string; targets: readonly string[]; crossRoot?: { initialText: string };
    actionPrompt(fixture: RemoteNativeFixture): string | Promise<string>;
  }): Promise<RemoteNativeFixture>;
}

/** Use the repository's pinned SDK, never an ambient CLI, SDK or credential. */
export async function createRemoteFixtureClient(apiKey: string): Promise<RemoteFixtureDaytona> {
  if (!apiKey.trim()) throw new Error("Remote native qualification requires an explicitly bound Daytona credential");
  const require = createRequire(new URL("../../packages/plugins/sandbox-providers/daytona/package.json", import.meta.url));
  const entry = require.resolve("@daytonaio/sdk");
  let directory = dirname(entry), version: string | undefined;
  for (let i = 0; i < 4; i++, directory = dirname(directory)) {
    try {
      const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (pkg.name === "@daytonaio/sdk") { version = pkg.version; break; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (version !== "0.203.0") throw new Error("Remote native qualification requires Daytona SDK 0.203.0");
  const sdk = await import(pathToFileURL(entry).href);
  return new sdk.Daytona({ apiKey, apiUrl: "https://app.daytona.io/api" }) as RemoteFixtureDaytona;
}

/** The tested action is withheld until its observer is armed. The initial
 * provider prompt only reads this one operator-published instruction file.
 * No production hook, steering support or remote setup-command execution is
 * assumed. Bootstrap reads are distinct from the native action under test. */
export function createRemoteNativeBootstrap(input: {
  api: RemoteFixtureApi; daytona: RemoteFixtureDaytona; companyId: string; environmentId: string;
  agentId: string; image: string; nodeSha256: string; runnerdSha256: string; deadlineAt: number;
  evidence(name: string, data: unknown): Promise<void>;
}, bind = bindRemoteNativeFixture): RemoteNativeBootstrap {
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.nodeSha256) || !/^sha256:[a-f0-9]{64}$/u.test(input.runnerdSha256) || !/@sha256:[a-f0-9]{64}$/u.test(input.image)) {
    throw new Error("Remote native qualification requires immutable image and interpreter digests");
  }
  const bindings = new Map<string, { path: string; consumed: boolean }>();
  return {
    prompt(nonce) {
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(nonce) || bindings.has(nonce)) throw new Error("Invalid or reused remote bootstrap nonce");
      const path = `.paperclip-eval-action-${randomBytes(18).toString("hex")}.txt`;
      bindings.set(nonce, { path, consumed: false });
      return [
        `Your task instructions will be published by the operator in the workspace file ${path}.`,
        "Use your native file-read tool to read that exact relative file in the current execution workspace. If it is not present yet, retry the read for up to 20 seconds, then report the setup failure.",
        "Before reading those instructions: do not infer the task. Do not run shell commands. Do not create or modify any file.",
        "Do not ask replacement questions. Do not mark work complete. Do not create the missing instruction file.",
        "After reading the complete file, perform precisely the supplied task. Treat it as the operator's continuation of this task.",
      ].join("\n");
    },
    async bindAndRelease(request) {
      const pending = [...bindings.values()].filter(value => !value.consumed);
      if (pending.length !== 1) throw new Error("Remote bootstrap requires one unconsumed instruction delivery");
      const setup = pending[0]!; setup.consumed = true;
      if (![request.issueId, request.runId].every(id => /^[A-Za-z0-9_-]{1,128}$/u.test(id))) throw new Error("Invalid bootstrap task/run identity");
      // Provisioning consumes the authored case deadline. A cold snapshot need
      // not produce a lease in 20 seconds; a terminal or foreign run never waits.
      let lastState: Record<string, string | number | boolean> = { observed: false };
      const admissionDeadlineAt = input.deadlineAt - REMOTE_FIXTURE_MIN_SETUP_BUDGET_MS;
      let fixture: RemoteNativeFixture;
      let lastReadError: RemoteAdmissionReadError | undefined;
      try {
        const ready = await pollUntil({
          label: "owned native qualification lease", deadlineAt: admissionDeadlineAt, intervalMs: 100,
          load: async () => {
            type Read<T> = { status: "fulfilled"; value: T } | { status: "rejected"; reason: RemoteAdmissionReadError } | { status: "pending" };
            let issueRead: Read<Record<string, any>> = { status: "pending" };
            let runRead: Read<Record<string, any>> = { status: "pending" };
            let leasesRead: Read<Array<Record<string, any>>> = { status: "pending" };
            const snapshot = () => {
              const issue = issueRead.status === "fulfilled" ? issueRead.value : undefined;
              const run = runRead.status === "fulfilled" ? runRead.value : undefined;
              const rows = leasesRead.status === "fulfilled" ? leasesRead.value : undefined;
              const issueOwned = issue?.id === request.issueId && issue.companyId === input.companyId
                && issue.assigneeAgentId === input.agentId;
              const runOwned = run?.companyId === input.companyId && run.agentId === input.agentId && run.id === request.runId;
              const owned = issueOwned && runOwned;
              const runLeases = Array.isArray(rows) ? rows.filter(row => row?.heartbeatRunId === request.runId) : undefined;
              const active = runLeases?.filter(row => row.issueId === request.issueId && row.status === "active" && row.providerLeaseId);
              // A failed endpoint cannot discard a successful read proving that
              // ownership changed or the run stopped. Missing reads never admit.
              const rejection = (issueRead.status === "fulfilled" && !issueOwned) || (runRead.status === "fulfilled" && !runOwned)
                ? "Remote bootstrap task/run ownership is unproven"
                : runRead.status === "fulfilled" && !["queued", "running"].includes(run?.status) ? "Native qualification run stopped before observer setup"
                : runLeases && runLeases.length > 1 ? "Ambiguous native qualification lease" : undefined;
              // Fixed keys and allowlisted enum values only: no provider IDs,
              // errors, prompts or arbitrary API strings enter startup evidence.
              const readError = [issueRead, runRead, leasesRead].find(read => read.status === "rejected");
              const evidence = {
                observed: true, owned, phase: "lease_admission",
                issueRead: issueRead.status, runRead: runRead.status, leasesRead: leasesRead.status,
                runStatus: ["queued", "running", "succeeded", "failed", "cancelled", "timed_out"].includes(run?.status) ? run!.status : "unknown",
                executionStage: ["queued", "preparing", "executing", "finalizing"].includes(run?.executionStage) ? run!.executionStage : "unknown",
                ...(runLeases ? { runLeaseCount: runLeases.length, activeOwnedLeaseCount: active!.length } : {}),
                ...(readError?.status === "rejected" ? { readFailureClass: classifyFailure(readError.reason) } : {}),
                deadlineReached: Date.now() >= input.deadlineAt,
              };
              return { run, owned, lease: active?.[0], rejection, evidence,
                readError: readError?.status === "rejected" ? readError.reason : undefined };
            };
            // At most three in-flight reads. Each has a transport deadline no
            // later than admission; terminal/ownership proof need not await it.
            const remainingMs = Math.max(1, admissionDeadlineAt - Date.now());
            const timeout = Math.min(30_000, remainingMs);
            const state = await new Promise<ReturnType<typeof snapshot>>(resolve => {
              let finished = false;
              const finish = (state: ReturnType<typeof snapshot>) => {
                if (finished) return;
                finished = true; clearTimeout(timer); resolve(state);
              };
              const timer = setTimeout(() => {
                const failure = (endpoint: AdmissionEndpoint) => ({ status: "rejected" as const, reason: new RemoteAdmissionReadError(endpoint, "transient_infrastructure") });
                if (issueRead.status === "pending") issueRead = failure("issue");
                if (runRead.status === "pending") runRead = failure("run");
                if (leasesRead.status === "pending") leasesRead = failure("leases");
                finish(snapshot());
              }, remainingMs);
              function read<T>(endpoint: AdmissionEndpoint, path: string, save: (result: Read<T>) => void) {
                // Both handlers are installed before dispatch. Late completion
                // is consumed but cannot mutate saved evidence or start a poll.
                void Promise.resolve().then(() => input.api.get<T>(path, { timeout })).then(
                  value => settled(admissionJson(endpoint, value) ? { status: "fulfilled", value }
                    : { status: "rejected", reason: admissionReadError(endpoint, undefined) }),
                  reason => settled({ status: "rejected", reason: admissionReadError(endpoint, reason) }),
                );
                function settled(result: Read<T>) {
                  if (finished) return;
                  save(result);
                  const state = snapshot();
                  if (state.rejection || [issueRead, runRead, leasesRead].every(read => read.status !== "pending")) finish(state);
                }
              }
              read<Record<string, any>>("issue", `/api/issues/${request.issueId}`, result => { issueRead = result; });
              read<Record<string, any>>("run", `/api/heartbeat-runs/${request.runId}`, result => { runRead = result; });
              read<Array<Record<string, any>>>("leases", `/api/environments/${input.environmentId}/leases`, result => { leasesRead = result; });
            });
            lastState = state.evidence;
            lastReadError = state.rejection ? undefined : state.readError;
            if (lastReadError !== undefined) throw lastReadError;
            return state;
          },
          // Native runs can retain the legacy "preparing" stage. The observer's
          // runtime-ready RPC proves the actual pinned daemon before installation.
          accept: state => !state.rejection && state.owned && state.run?.status === "running" && Boolean(state.lease)
            && Date.now() < admissionDeadlineAt,
          reject: state => state.rejection,
          timeoutDetail: () => JSON.stringify(lastState),
        });
        const lease = ready.lease!;
        lastState = { ...lastState, phase: "observer_setup" };
        fixture = await bind({ api: input.api, daytona: input.daytona, sdkVersion: "0.203.0", nodeSha256: input.nodeSha256, runnerdSha256: input.runnerdSha256,
          authority: { companyId: input.companyId, environmentId: input.environmentId, runId: request.runId, leaseId: lease.id, sandboxId: lease.providerLeaseId, image: input.image },
          targets: [...request.targets], crossRoot: request.crossRoot, actionFile: setup.path, deadlineAt: input.deadlineAt,
        });
      } catch (error) {
        if (lastReadError !== undefined && lastState.phase === "lease_admission") {
          if (classifyFailure(lastReadError) === "transient_infrastructure") {
            const timeout = new ObservedStateTimeout("owned native qualification lease", "transient_infrastructure", JSON.stringify(lastState));
            // The safe read classification is already in the bounded state.
            // Do not expose the rejected transport value through a cause chain.
            error = timeout;
          } else error = lastReadError;
        }
        try {
          await input.evidence(`remote-native-bootstrap-startup-${request.runId}.json`, {
            ...lastState, fixtureDiagnostics: remoteNativeFixtureDiagnostics(error), deadlineReached: Date.now() >= input.deadlineAt,
            admissionDeadlineReached: Date.now() >= admissionDeadlineAt,
          });
        } catch (evidenceError) {
          throw new AggregateError([error, evidenceError], "Remote bootstrap startup failed and state evidence could not be saved");
        }
        throw error;
      }
      try {
        const action = await request.actionPrompt(fixture);
        if (!action.trim() || Buffer.byteLength(action) > 16 * 1024) throw new Error("Remote bootstrap action is empty or too large");
        await input.evidence(`remote-native-bootstrap-${request.runId}.json`, { binding: fixture.binding, setupPath: setup.path, baseline: fixture.baseline });
        await fixture.publishAction(setup.path, action);
        return fixture;
      } catch (error) {
        try { await fixture.close(); } catch { throw new AggregateError([error], "Remote bootstrap failed and observer cleanup is unproven"); }
        throw error;
      }
    },
  };
}
