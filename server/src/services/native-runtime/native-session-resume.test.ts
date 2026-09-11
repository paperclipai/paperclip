import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  companies,
  completionContracts,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  nativeRunResults,
} from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import {
  CodexAppServerDriver,
  HarnessDriverBackend,
  createCodexTaskEnvelope,
  createRunnerdCodexTransport as createCapabilityRunnerdCodexTransport,
} from "@paperclipai/paperclip-runner";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  canonicalNativeRuntimeContextDigest,
  defaultCapabilityRunnerdBinary,
  executeNativeSession,
  parseNativeExecutionInput,
  type NativeExecutionInput,
  type NativeSession,
} from "../../vendor/paperclip-runner/index.js";
import {
  runnerPrpWebSocketInternals,
  setupRunnerPrpWebSocketServer,
} from "../../realtime/runner-prp-ws.js";
import {
  appendRetainedNativeCleanupEvent,
  createRunnerdBackend,
  retainedNativeCleanupJournalMatches,
} from "./native-session-executor.js";
import * as publicationSignals from "../chat-publication-reconciliation.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import {
  LIST_CHAT_ATTACHMENTS_TOOL_DEFINITION,
  REUSE_CHAT_ATTACHMENT_TOOL_DEFINITION,
} from "./chat-attachment-reuse.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import {
  buildNativeExecutionWithCheckpoint,
  findNativeSessionResumeRun,
  NATIVE_TOOL_CONTRACT_FINGERPRINT,
  isUnusedLegacyNativeRetryReplacement,
  nativeToolContractFingerprintForTarget,
  nativeSessionIdForBootstrapPersistence,
  nativeSessionProviderEvidence,
  prepareNativeSessionBootstrapPersistence,
  rebindNativeSessionCheckpoint,
  selectNativeSessionResumeRun,
} from "./native-session-resume.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";

const companyId = "10000000-0000-4000-8000-000000000001";
const issueId = "20000000-0000-4000-8000-000000000002";
const agentId = "30000000-0000-4000-8000-000000000003";
const previousRunId = "40000000-0000-4000-8000-000000000004";
const currentRunId = "50000000-0000-4000-8000-000000000005";
const normalizedSessionId = "60000000-0000-4000-8000-000000000006";

const CONDITIONAL_READER_TOOL_CONTRACT_FINGERPRINT = `sha256:${createHash(
  "sha256",
)
  .update(
    JSON.stringify({
      schema: "paperclip.native-tool-contract.v1",
      tools: [
        { name: "register_deliverable", version: 1 },
        {
          name: "read_current_wake_comments",
          semanticContract: "paperclip.server-current-wake-comments.v1",
          version: 1,
        },
      ],
    }),
  )
  .digest("hex")}`;

const PRE_CHAT_ATTACHMENT_REUSE_TOOL_CONTRACT_FINGERPRINT = `sha256:${createHash(
  "sha256",
)
  .update(
    JSON.stringify({
      schema: "paperclip.native-tool-contract.v2",
      executionTargetKind: "local",
      advertisementPolicy: {
        readCurrentWakeComments: "always_advertised_binding_gated.v1",
        registerDeliverable: "local_workspace_only.v1",
      },
      tools: [
        { name: "register_deliverable", version: 1 },
        {
          name: "read_current_wake_comments",
          semanticContract: "paperclip.server-current-wake-comments.v1",
          version: 1,
        },
      ],
    }),
  )
  .digest("hex")}`;

const PRE_CHAT_ATTACHMENT_READ_TOOL_CONTRACT_FINGERPRINT = `sha256:${createHash(
  "sha256",
)
  .update(
    JSON.stringify({
      schema: "paperclip.native-tool-contract.v3",
      executionTargetKind: "local",
      advertisementPolicy: {
        readCurrentWakeComments: "always_advertised_binding_gated.v1",
        historicalChatAttachments:
          "always_advertised_conversation_binding_gated.v1",
        registerDeliverable: "local_workspace_only.v1",
      },
      tools: [
        { name: "register_deliverable", version: 1 },
        {
          name: "read_current_wake_comments",
          semanticContract: "paperclip.server-current-wake-comments.v1",
          version: 1,
        },
        {
          name: "list_chat_attachments",
          semanticContract: "paperclip.server-chat-attachment-reuse.v1",
          version: 1,
        },
        {
          name: "reuse_chat_attachment",
          semanticContract: "paperclip.server-chat-attachment-reuse.v1",
          version: 1,
        },
      ],
    }),
  )
  .digest("hex")}`;

const PRE_STRUCTURED_HUMAN_INPUT_TOOL_CONTRACT_FINGERPRINT = `sha256:${createHash(
  "sha256",
)
  .update(
    JSON.stringify({
      schema: "paperclip.native-tool-contract.v4",
      executionTargetKind: "local",
      advertisementPolicy: {
        readCurrentWakeComments: "always_advertised_binding_gated.v1",
        historicalChatAttachments:
          "always_advertised_conversation_binding_gated.v1",
        registerDeliverable: "local_workspace_only.v1",
        readChatAttachment: "always_advertised_run_scope_local_staging.v1",
      },
      tools: [
        { name: "register_deliverable", version: 1 },
        {
          name: "read_current_wake_comments",
          semanticContract: "paperclip.server-current-wake-comments.v1",
          version: 1,
        },
        {
          name: "list_chat_attachments",
          semanticContract: "paperclip.server-chat-attachment-reuse.v1",
          version: 1,
        },
        {
          name: "reuse_chat_attachment",
          semanticContract: "paperclip.server-chat-attachment-reuse.v1",
          version: 1,
        },
        {
          name: "read_chat_attachment",
          semanticContract: "paperclip.server-chat-attachment-read.v1",
          version: 1,
        },
      ],
    }),
  )
  .digest("hex")}`;

const PRE_RESPONSE_WAKE_YIELD_TOOL_CONTRACT_FINGERPRINT = `sha256:${createHash(
  "sha256",
)
  .update(
    JSON.stringify({
      schema: "paperclip.native-tool-contract.v5",
      executionTargetKind: "local",
      advertisementPolicy: {
        readCurrentWakeComments: "always_advertised_binding_gated.v1",
        historicalChatAttachments:
          "always_advertised_conversation_binding_gated.v1",
        registerDeliverable: "local_workspace_only.v1",
        readChatAttachment: "always_advertised_run_scope_local_staging.v1",
        structuredHumanInput:
          "always_advertised_run_issue_agent_binding_gated.v1",
      },
      tools: [
        { name: "register_deliverable", version: 1 },
        {
          name: "read_current_wake_comments",
          semanticContract: "paperclip.server-current-wake-comments.v1",
          version: 1,
        },
        {
          name: "list_chat_attachments",
          semanticContract: "paperclip.server-chat-attachment-reuse.v1",
          version: 1,
        },
        {
          name: "reuse_chat_attachment",
          semanticContract: "paperclip.server-chat-attachment-reuse.v1",
          version: 1,
        },
        {
          name: "read_chat_attachment",
          semanticContract: "paperclip.server-chat-attachment-read.v1",
          version: 1,
        },
        { name: "request_human_input", version: 1 },
      ],
    }),
  )
  .digest("hex")}`;

const PRE_EXPLICIT_CHAT_ATTACHMENT_GUIDANCE_TOOL_CONTRACT_FINGERPRINT = `sha256:${createHash(
  "sha256",
)
  .update(
    JSON.stringify({
      schema: "paperclip.native-tool-contract.v7",
      executionTargetKind: "local",
      advertisementPolicy: {
        readCurrentWakeComments: "always_advertised_binding_gated.v1",
        historicalChatAttachments:
          "always_advertised_conversation_binding_gated.v1",
        registerDeliverable: "local_workspace_only.v1",
        readChatAttachment: "always_advertised_run_scope_local_staging.v1",
        structuredHumanInput:
          "always_advertised_run_issue_agent_binding_gated.v1",
        semanticCompletion: "finish_response_wake_concrete_object.v2",
      },
      tools: [
        { name: "register_deliverable", version: 1 },
        {
          name: "read_current_wake_comments",
          semanticContract: "paperclip.server-current-wake-comments.v1",
          version: 1,
        },
        {
          name: "list_chat_attachments",
          semanticContract: "paperclip.server-chat-attachment-reuse.v1",
          version: 1,
        },
        {
          name: "reuse_chat_attachment",
          semanticContract: "paperclip.server-chat-attachment-reuse.v1",
          version: 1,
        },
        {
          name: "read_chat_attachment",
          semanticContract: "paperclip.server-chat-attachment-read.v1",
          version: 1,
        },
        { name: "request_human_input", version: 1 },
      ],
    }),
  )
  .digest("hex")}`;

function execution(
  runId: string,
  cwd = "/workspace",
  workMode = "standard",
  workspace: {
    id?: string;
    repoUrl?: string | null;
    repoRef?: string | null;
    branchName?: string | null;
  } = {},
) {
  return buildNativeExecutionInput({
    companyId,
    runId,
    issue: {
      id: issueId,
      identifier: "DOT-2",
      title: "Test",
      description: null,
      workMode,
    },
    taskPrompt: "Only the current turn",
    agentId,
    workspace: {
      id: workspace.id ?? runId,
      cwd,
      repoUrl: workspace.repoUrl ?? null,
      repoRef: workspace.repoRef ?? null,
      branchName: workspace.branchName ?? null,
    },
    normalizedSessionId,
    provider: "codex",
    completionContract: {
      id: "70000000-0000-4000-8000-000000000007",
      sha256: `sha256:${"a".repeat(64)}`,
      schemaVersion: "paperclip.run-result.v1",
      contract: {
        revision: "1",
        objective: "Test session resumption",
        criteria: [{ id: "objective", requirement: "Answer the current turn" }],
      },
    },
    runtimeContext: nativeRuntimeContextFixture(),
  });
}

function planningExecution(runId: string, revisionId: string) {
  return buildNativeExecutionInput({
    companyId,
    runId,
    issue: {
      id: issueId,
      identifier: "DOT-2",
      title: "Test",
      description: null,
      workMode: "planning",
    },
    taskPrompt: "Revise the plan",
    agentId,
    workspace: {
      id: runId,
      cwd: "/workspace",
      repoUrl: null,
      repoRef: null,
      branchName: null,
    },
    normalizedSessionId,
    provider: "codex",
    executionMode: "plan",
    planningContext: {
      documentId: "80000000-0000-4000-8000-000000000008",
      baseRevisionId: revisionId,
      baseRevisionNumber: revisionId.endsWith("9") ? 9 : 8,
      markdown: `Plan at ${revisionId}`,
      sha256: `sha256:${"b".repeat(64)}`,
      reviewContext: {},
    },
    completionContract: execution(runId).completionContract,
    runtimeContext: nativeRuntimeContextFixture(),
  });
}

function previousRun(overrides: Record<string, unknown> = {}) {
  return {
    id: previousRunId,
    companyId,
    agentId,
    nativeSessionId: normalizedSessionId,
    runnerProfileJson: {
      nativeToolContractFingerprint: NATIVE_TOOL_CONTRACT_FINGERPRINT,
      nativeExecutionInput: execution(previousRunId),
      sessionCheckpoint: {
        backendKind: "runner",
        driverKind: "codex_app_server",
        sessionId: "provider-thread-123",
        providerSessionId: "provider-thread-123",
        cursor: "42",
        identity: {
          runId: previousRunId,
          sessionId: normalizedSessionId,
          companyId,
          issueId,
          agentId,
        },
        semanticResult: {
          schema: "paperclip.run-result.v1",
          reportedWorkDisposition: "done",
          summary: "old",
        },
        terminal: {
          schema: "paperclip.prp.terminal.v1",
          turnTerminalState: "completed",
          runTerminalState: "succeeded",
          reportedWorkDisposition: "done",
        },
        activeTurnId: "old-turn",
        terminalTurns: [{ turnId: "old-turn", state: "completed" }],
        pendingRuntimeRequests: [{ requestId: "old-request" }],
        lineage: [{ threadId: "provider-thread-123" }],
      },
      ...overrides,
    },
  };
}

it("wires exact-session recovery and guarded selected identity into heartbeat persistence", () => {
  const source = readFileSync(
    new URL("../heartbeat.ts", import.meta.url),
    "utf8",
  );
  expect(source).toContain("await findNativeSessionResumeRun(db,");
  expect(source).toContain(
    "await prepareNativeSessionBootstrapPersistence(tx,",
  );
  expect(source).toContain("nativeSessionId: persistedNativeSessionId,");
  expect(source).toContain("lockedProfile.sessionCheckpoint != null");
  const build = source.slice(
    source.indexOf("const nativeExecutionWithCheckpoint ="),
    source.indexOf("const nativeSandboxLifecycle ="),
  );
  expect(build).toContain("previousRun: previousNativeRun,");
});

const embeddedSupport = await getEmbeddedPostgresTestSupport();
const recoveryFakeCodex = resolve(
  import.meta.dirname,
  "../../../../packages/paperclip-runner/test/fixtures/fake-final-burst-codex-app-server.mjs",
);

(embeddedSupport.supported && existsSync(defaultCapabilityRunnerdBinary())
  ? it
  : it.skip)(
  "keeps actual normalized driver events separate from raw maintenance receipts",
  async () => {
    const database = await startEmbeddedPostgresTestDatabase(
      "native-cleanup-topology-",
    );
    const db = createDb(database.connectionString);
    const scratch = await mkdtemp(join(tmpdir(), "native-cleanup-topology-"));
    const root = join(scratch, "state");
    const home = join(scratch, "home");
    const workspace = join(scratch, "workspace");
    const companyId = randomUUID(),
      agentId = randomUUID(),
      issueId = randomUUID(),
      runId = randomUUID();
    const runnerInstanceId = randomUUID(),
      normalizedSessionId = randomUUID();
    let session: NativeSession | undefined;
    const signal = vi.spyOn(
      publicationSignals,
      "publishChatPublicationCommitSignal",
    );
    let bundle:
      ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
    try {
      await mkdir(home);
      await mkdir(workspace);
      await db
        .insert(companies)
        .values({
          id: companyId,
          name: "Cleanup topology",
          issuePrefix: "NCT",
        });
      await db
        .insert(agents)
        .values({
          id: agentId,
          companyId,
          name: "Fixture",
          status: "active",
          adapterType: "paperclip_runner",
        });
      await db
        .insert(issues)
        .values({
          id: issueId,
          companyId,
          title: "Exact topology",
          assigneeAgentId: agentId,
          status: "in_progress",
        });
      await db
        .insert(heartbeatRuns)
        .values({
          id: runId,
          companyId,
          agentId,
          status: "running",
          runtimeMode: "native",
          nativeIssueId: issueId,
          nativeSessionId: normalizedSessionId,
          runnerInstanceId,
        });
      bundle = createCapabilityRunnerdCodexTransport({
        stateDirectory: root,
        sourceCodexHome: home,
        codexCommand: resolve(
          import.meta.dirname,
          "../../../../packages/paperclip-runner/runner/target/debug/fake-codex-app-server",
        ),
        codexArgs: ["--state-file", join(scratch, "fake.json"), "--hold-turn"],
        prpIdentity: {
          runId,
          runnerInstanceId,
          normalizedSessionId,
          environmentLeaseId: runId,
          turnId: `turn-${runId}`,
          itemId: `item-${runId}`,
        },
      });
      const backend = new HarnessDriverBackend(
        new CodexAppServerDriver({
          runnerInstanceId,
          approvalPolicy: "never",
          taskEnvelope: createCodexTaskEnvelope({
            objective: "Open only the fixture session",
          }),
          transportFactory: () => bundle!.transport,
          environment: { HOME: home, CODEX_HOME: home },
          requireProviderSessionIdentity: true,
        }),
      );
      session = await backend.openSession({
        identity: {
          companyId,
          issueId,
          agentId,
          runId,
          sessionId: normalizedSessionId,
        },
        workingDirectory: workspace,
      });
      const stream = session.events()[Symbol.asyncIterator]();
      const normalized = (await stream.next()).value;
      expect(normalized).toMatchObject({
        sourceInstanceId: runnerInstanceId,
        sourceSeq: 1,
      });
      expect(normalized.sourceEventId).toBe(`${runnerInstanceId}:${runId}:1`);
      expect(normalized.payload).not.toHaveProperty("processId");
      const port = new PaperclipControlPlanePort(db, {
        companyId,
        issueId,
        agentId,
        runId,
        sessionId: normalizedSessionId,
        sourceInstanceId: runnerInstanceId,
        controlPlaneSourceInstanceId: `${runnerInstanceId}:control`,
        completionContractId: randomUUID(),
        completionContractSha256: "fixture-contract",
      });
      await port.appendEvent(normalized);
      const original = await db
        .select()
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, runId));
      expect(original).toHaveLength(1);
      const control = JSON.parse(
        await readFile(
          join(root, "control-plane/control-plane-state.json"),
          "utf8",
        ),
      );
      const raw = control.committedEvents
        .map(
          (entry: { envelope: { payload: Record<string, unknown> } }) =>
            entry.envelope.payload,
        )
        .find((event: Record<string, unknown>) =>
          ["session.started", "session.resumed"].includes(
            String(event.eventType),
          ),
        );
      expect(raw).toMatchObject({
        sourceInstanceId: runnerInstanceId,
        sourceSeq: 1,
        payload: {
          providerSessionId: normalized.payload.driverSessionId,
          providerAccountSessionId: normalized.payload.providerSessionId,
        },
      });
      expect(raw.payload.processId).toBeGreaterThan(0);
      expect(raw.sourceEventId).not.toBe(normalized.sourceEventId);
      // The original normalized seq=1 is already durable. Reusing that
      // namespace for the raw wire seq=1 must remain an integrity violation.
      await expect(port.appendEvent(raw)).rejects.toMatchObject({
        code: "native_event_replay_conflict",
      });
      signal.mockClear();
      const input = {
        companyId,
        agentId,
        runId,
        nativeSessionId: normalizedSessionId,
        runnerInstanceId,
        requestId: `fixture:${randomUUID()}`,
        event: raw,
      };
      await appendRetainedNativeCleanupEvent(db, input);
      await appendRetainedNativeCleanupEvent(db, input);
      const rows = await db
        .select()
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, runId));
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.id === original[0]!.id)).toEqual(
        original[0],
      );
      const receipt = rows.find(
        (row) => row.eventType === "native.cleanup.event",
      )!;
      expect(receipt.sourceSeq).toBe(1);
      expect(receipt.sourceInstanceId).not.toBe(runnerInstanceId);
      expect(receipt.payload).not.toHaveProperty("prpEvent");
      expect(
        Object.keys(
          receipt.payload!.nativeCleanupEvent as Record<string, unknown>,
        ).sort(),
      ).toEqual([
        "rawCanonicalSha256",
        "rawEventType",
        "rawSourceEventId",
        "rawSourceInstanceId",
        "rawSourceSeq",
        "requestId",
        "schema",
      ]);
      await expect(
        appendRetainedNativeCleanupEvent(db, {
          ...input,
          event: {
            ...raw,
            payload: {
              ...raw.payload,
              privateData: "MUST_NOT_REACH_MAINTENANCE_RECEIPTS",
            },
          },
        }),
      ).rejects.toMatchObject({ code: "native_event_replay_conflict" });
      expect(
        await db
          .select()
          .from(heartbeatRunEvents)
          .where(eq(heartbeatRunEvents.runId, runId)),
      ).toHaveLength(2);
      expect(JSON.stringify(receipt.payload)).not.toContain("MUST_NOT_REACH");
      expect(signal).not.toHaveBeenCalled();
    } finally {
      signal.mockRestore();
      await session
        ?.close({ reason: "Dispose exact test session" })
        .catch(() => undefined);
      await bundle?.transport.close().catch(() => undefined);
      await database.cleanup();
      await rm(scratch, { recursive: true, force: true });
    }
  },
  30_000,
);

(embeddedSupport.supported &&
  existsSync(defaultCapabilityRunnerdBinary()) &&
  existsSync(recoveryFakeCodex)
  ? it
  : it.skip)(
  "archives a damaged prior epoch before completing guarded same-task replacement with real runnerd",
  async () => {
    const database = await startEmbeddedPostgresTestDatabase(
      "native-damaged-resume-",
    );
    const db = createDb(database.connectionString);
    const scratch = await mkdtemp(join(tmpdir(), "native-damaged-resume-"));
    const stateBase = join(scratch, "sessions");
    const bin = join(scratch, "bin");
    const workspace = join(scratch, "workspace");
    const sourceHome = join(scratch, "source-home");
    const previousStateBase = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    const server = createServer();
    let firstSession: NativeSession | undefined;
    const runnerDiagnostics: string[] = [];
    const onRunnerLog = async (_stream: "stdout" | "stderr", chunk: string) => {
      runnerDiagnostics.push(chunk.slice(-4_096));
      if (runnerDiagnostics.length > 32) runnerDiagnostics.shift();
    };
    process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
    try {
      await Promise.all(
        [bin, workspace, sourceHome].map((path) =>
          mkdir(path, { recursive: true }),
        ),
      );
      // Only the provider boundary is synthetic; driver, runnerd, authority
      // rotation, prior-owner DB checks and archive/replacement are real.
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const command = join(bin, "codex");
      await writeFile(
        command,
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(recoveryFakeCodex)} "$CODEX_HOME/fake-state.json" 16\n`,
      );
      await chmod(command, 0o700);
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing test listener");
      setupRunnerPrpWebSocketServer(server, {
        apiUrl: `http://127.0.0.1:${address.port}`,
      });
      const makeExecution = (runId: string): NativeExecutionInput => {
        const { runtimeContext: _runtimeContext, ...value } = execution(
          runId,
          workspace,
        );
        return {
          ...value,
          schema: "paperclip.native-execution-input.v2",
          provider: { kind: "codex", model: "gpt-5.6-luna" },
          completionContract: {
            ...value.completionContract,
            contract: {
              revision: "burst-v1",
              objective: "Complete a fresh response after guarded recovery",
              criteria: [
                { id: "burst", requirement: "Complete the new response" },
              ],
            },
          },
        };
      };
      const firstExecution = makeExecution(previousRunId);
      const currentExecution = makeExecution(currentRunId);
      expect(() => parseNativeExecutionInput(firstExecution)).not.toThrow();
      const runnerInstanceId = randomUUID();
      const environment = {
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        HOME: sourceHome,
        CODEX_HOME: sourceHome,
      };
      await db.insert(companies).values({
        id: companyId,
        name: "Damaged recovery",
        issuePrefix: "DNR",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Recovery runner",
        status: "active",
        adapterType: "paperclip_runner",
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Preserve the same task",
        assigneeAgentId: agentId,
        status: "in_progress",
      });
      await db.insert(completionContracts).values({
        id: currentExecution.completionContract.id,
        companyId,
        issueId,
        revision: 1,
        schemaVersion: "paperclip.completion-contract.v1",
        policyVersion: "damaged-recovery-v1",
        risk: "standard",
        completionAuthority: "server_arbiter",
        incompleteCriteriaPolicy: "preserve_non_terminal",
        contractJson: { ...currentExecution.completionContract.contract },
        canonicalSha256: currentExecution.completionContract.sha256,
        createdByActorType: "system",
        createdByActorId: "test",
      });
      await db.insert(heartbeatRuns).values([
        {
          id: previousRunId,
          companyId,
          agentId,
          status: "running",
          runtimeMode: "native",
          nativeIssueId: issueId,
          nativeSessionId: normalizedSessionId,
          runnerInstanceId,
          completionContractId: firstExecution.completionContract.id,
          completionContractSha256: firstExecution.completionContract.sha256,
          runnerProfileJson: { nativeExecutionInput: firstExecution },
        },
        {
          id: currentRunId,
          companyId,
          agentId,
          status: "running",
          runtimeMode: "native",
          nativeIssueId: issueId,
          nativeSessionId: normalizedSessionId,
          runnerInstanceId,
          completionContractId: currentExecution.completionContract.id,
          completionContractSha256: currentExecution.completionContract.sha256,
          runnerProfileJson: { nativeExecutionInput: currentExecution },
        },
      ]);
      const firstBackend = await createRunnerdBackend({
        db,
        execution: firstExecution,
        runnerInstanceId,
        runnerEnvironment: environment,
        onLog: onRunnerLog,
      });
      firstSession = await firstBackend.openSession({
        identity: {
          companyId,
          issueId,
          agentId,
          runId: previousRunId,
          sessionId: normalizedSessionId,
        },
        workingDirectory: workspace,
      });
      const checkpoint = await firstSession.snapshot();
      expect(checkpoint.identity).toEqual({
        companyId,
        issueId,
        agentId,
        runId: previousRunId,
        sessionId: normalizedSessionId,
      });
      await firstSession.close({
        reason: "Establish a suspended test-only historical root",
      });
      firstSession = undefined;
      const [stateKey] = (await readdir(stateBase)).filter((name) =>
        /^[a-f0-9]{64}$/.test(name),
      );
      expect(stateKey).toBeDefined();
      const root = join(stateBase, stateKey!);
      const runnerPath = join(root, "runner", "runner-state.json");
      const providerPath = join(root, "runner", "codex-provider-state.json");
      const runner = JSON.parse(await readFile(runnerPath, "utf8"));
      const provider = JSON.parse(await readFile(providerPath, "utf8"));
      expect(runner.lifecycle).toBe("suspended");

      // Reproduce only in a generated disposable root the historical failure:
      // an unacknowledged input whose digest predates bounded sanitization.
      const badPayload = {
        semantic_tool: {
          schema: "paperclip.prp.semantic_tool.v1",
          schemaVersion: 1,
          phase: "input",
          input: { summary: "bounded historical answer" },
          content: { digest: `sha256:${"0".repeat(64)}` },
        },
      };
      const envelope = {
        protocol: "paperclip.runner",
        version: 1,
        kind: "event",
        runnerInstanceId: runner.runnerInstanceId,
        environmentLeaseId: runner.environmentLeaseId,
        runId: previousRunId,
        normalizedSessionId,
        turnId: runner.turnId,
        itemId: runner.itemId,
        payload: {
          schema: "paperclip.prp.event.v1",
          sourceEventId: "historical-bad-input-44",
          sourceSeq: 44,
          sourceInstanceId: runner.runnerInstanceId,
          sourceKind: "runner",
          runId: previousRunId,
          normalizedSessionId,
          turnId: runner.turnId,
          itemId: runner.itemId,
          eventType: "semantic_tool.input",
          schemaVersion: 1,
          priority: 0,
          emittedAt: "2026-09-08T00:00:00.000Z",
          payload: badPayload,
        },
      };
      runner.ackedSourceSeq = 43;
      runner.nextSourceSeq = 45;
      runner.outbox = [
        {
          sourceSeq: 44,
          priority: 0,
          eventType: "semantic_tool.input",
          envelope,
          byteSize: Buffer.byteLength(JSON.stringify(envelope)),
        },
      ];
      provider.pendingEvents = [
        {
          executorEventId: "codex_provider_0000000000000044",
          eventType: "semantic_tool.input",
          priority: "p0",
          payload: badPayload,
        },
      ];
      provider.nextProviderEventSeq = 45;
      await writeFile(runnerPath, JSON.stringify(runner));
      await writeFile(providerPath, JSON.stringify(provider));
      const damagedRunnerBytes = await readFile(runnerPath);
      const damagedProviderBytes = await readFile(providerPath);
      await expect(
        createRunnerdBackend({
          db,
          execution: currentExecution,
          runnerInstanceId,
          runnerEnvironment: environment,
        }),
      ).rejects.toThrow("runner_state_identity_mismatch");
      expect(await readFile(runnerPath, "utf8")).toBe(
        damagedRunnerBytes.toString(),
      );
      expect(await readdir(root)).not.toContain("authority-epochs");
      const source = previousRun({
        nativeExecutionInput: firstExecution,
        sessionCheckpoint: checkpoint,
      });
      await db
        .update(heartbeatRuns)
        .set({ status: "failed", runnerProfileJson: source.runnerProfileJson })
        .where(eq(heartbeatRuns.id, previousRunId));
      const selected = await findNativeSessionResumeRun(db, {
        companyId,
        agentId,
        issueId,
        normalizedSessionId,
        currentRunId,
        beforeCreatedAt: new Date(),
      });
      expect(selected?.id).toBe(previousRunId);
      const rebound = rebindNativeSessionCheckpoint({
        previousRun: selected!,
        currentExecution,
      });
      expect(rebound).toMatchObject({
        cursor: null,
        semanticResult: null,
        activeTurnId: null,
        providerRecoveryPolicy: "allow_replacement_after_resume_failure",
      });
      expect(rebound?.identity).toEqual({
        companyId,
        issueId,
        agentId,
        runId: currentRunId,
        sessionId: normalizedSessionId,
      });

      const backend = await createRunnerdBackend({
        db,
        execution: currentExecution,
        runnerInstanceId,
        runnerEnvironment: environment,
        onLog: onRunnerLog,
      });
      let continuity: Record<string, unknown> | undefined;
      const controlPlaneInstanceId = randomUUID();
      const port = new PaperclipControlPlanePort(db, {
        companyId,
        issueId,
        runId: currentRunId,
        agentId,
        sessionId: normalizedSessionId,
        completionContractId: currentExecution.completionContract.id,
        completionContractSha256: currentExecution.completionContract.sha256,
        sourceInstanceId: runnerInstanceId,
        controlPlaneSourceInstanceId: controlPlaneInstanceId,
      });
      await expect(
        executeNativeSession({
          input: currentExecution,
          backend,
          persistedSession: rebound!,
          runnerInstanceId,
          controlPlaneInstanceId,
          timeoutMs: 20_000,
          controlPlane: port,
          async onContinuityBreak(value) {
            continuity = value;
          },
        }).catch(async (error: unknown) => {
          const eventRows = await db
            .select({
              eventType: heartbeatRunEvents.eventType,
              payload: heartbeatRunEvents.payload,
            })
            .from(heartbeatRunEvents)
            .where(eq(heartbeatRunEvents.runId, currentRunId));
          const eventCodes = eventRows.slice(-32).map((event) => ({
            eventType: event.eventType,
            code: event.payload?.code ?? null,
          }));
          const fakeProvider = await readFile(
            join(root, "codex-home", "fake-state.json"),
            "utf8",
          ).then(JSON.parse, () => null);
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\nDisposable recovery fixture runner diagnostics:\n${runnerDiagnostics.join("").slice(-12_000)}\nPersisted event codes: ${JSON.stringify(eventCodes)}\nFake provider state: ${JSON.stringify(fakeProvider)}`,
            { cause: error },
          );
        }),
      ).resolves.toMatchObject({
        result: {
          summary: "Fixture complete.",
          reportedWorkDisposition: "done",
        },
        terminal: { runTerminalState: "succeeded" },
        normalizedSessionId,
      });
      expect(continuity).toMatchObject({
        // The daemon can reject the damaged retained input during startup,
        // before attach gets a chance to reject the unsettled provider session.
        // Both refusal paths must preserve the exact archived evidence below.
        reason: expect.stringMatching(
          /run\.attach requires a settled Codex provider session|semantic tool input content digest does not match its transmitted input/,
        ),
        previousDriverSessionId: checkpoint.sessionId,
      });
      const [epoch] = await readdir(join(root, "authority-epochs"));
      const digest = (value: Buffer) =>
        createHash("sha256").update(value).digest("hex");
      expect(
        digest(
          await readFile(
            join(root, "authority-epochs", epoch!, "runner-state.json"),
          ),
        ),
      ).toBe(digest(damagedRunnerBytes));
      const [continuityArchive] = await readdir(
        join(root, "continuity-breaks"),
      );
      const archivedProvider = JSON.parse(
        await readFile(
          join(
            root,
            "continuity-breaks",
            continuityArchive!,
            "runner",
            "codex-provider-state.json",
          ),
          "utf8",
        ),
      );
      // Restoration may append a lifecycle notice, but must neither consume
      // nor rewrite the old semantic input to make attachment succeed.
      expect(
        archivedProvider.pendingEvents.filter(
          (event: { eventType: string }) =>
            event.eventType === "semantic_tool.input",
        ),
      ).toEqual(JSON.parse(damagedProviderBytes.toString()).pendingEvents);
      const completedProvider = JSON.parse(
        await readFile(join(root, "codex-home", "fake-state.json"), "utf8"),
      );
      expect(completedProvider.nextTurn).toBe(1);
      expect(completedProvider.turns["final-burst-turn-1"]).toMatchObject({
        status: "completed",
        deltaCount: 16,
      });
      const priorProvider = JSON.parse(
        await readFile(
          join(
            root,
            "continuity-breaks",
            continuityArchive!,
            "codex-home",
            "fake-state.json",
          ),
          "utf8",
        ),
      );
      expect(priorProvider.nextTurn).toBe(0);
      const results = await db
        .select()
        .from(nativeRunResults)
        .where(eq(nativeRunResults.runId, currentRunId));
      expect(results).toHaveLength(1);
      // Prove the maintenance anchor against an actual completed composition:
      // the DB owns normalized driver events and the accepted result, whereas
      // the retained controller owns distinct raw provider/tool event IDs.
      const [completedRun] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, currentRunId));
      const anchorEvents = await db
        .select()
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, currentRunId));
      const control = JSON.parse(
        await readFile(
          join(root, "control-plane", "control-plane-state.json"),
          "utf8",
        ),
      );
      const rawIdentity = control.committedEvents
        .map(
          (entry: { envelope: { payload: Record<string, unknown> } }) =>
            entry.envelope.payload,
        )
        .find((event: Record<string, unknown>) =>
          ["session.started", "session.resumed"].includes(
            String(event.eventType),
          ),
        );
      expect(rawIdentity).toBeDefined();
      expect(
        retainedNativeCleanupJournalMatches({
          run: completedRun!,
          execution: currentExecution,
          accepted: results[0]!,
          control,
          providerSessionId: rawIdentity.payload.providerSessionId,
          providerAccountSessionId:
            rawIdentity.payload.providerAccountSessionId,
          persistedEvents: anchorEvents,
        }),
      ).toBe(true);
      expect(results[0]).toMatchObject({
        companyId,
        issueId,
        runId: currentRunId,
        schemaStatus: "accepted",
        resultJson: {
          result: { summary: "Fixture complete." },
          terminal: { runTerminalState: "succeeded" },
        },
      });
      const sourceResults = await db
        .select({ id: nativeRunResults.id })
        .from(nativeRunResults)
        .where(eq(nativeRunResults.runId, previousRunId));
      expect(sourceResults).toHaveLength(0);
      const persistedEvents = await db
        .select({ sourceEventId: heartbeatRunEvents.sourceEventId })
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, currentRunId));
      expect(persistedEvents.length).toBeGreaterThan(0);
      expect(persistedEvents.map((event) => event.sourceEventId)).not.toContain(
        "historical-bad-input-44",
      );
      const [task] = await db
        .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(eq(issues.id, issueId));
      expect(task).toEqual({ id: issueId, assigneeAgentId: agentId });
    } finally {
      await firstSession
        ?.close({ reason: "Recovery fixture cleanup" })
        .catch(() => undefined);
      runnerPrpWebSocketInternals.resetForTests();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      if (previousStateBase === undefined)
        delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      else process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateBase;
      await database.cleanup();
      await rm(scratch, { recursive: true, force: true });
    }
  },
  60_000,
);

(embeddedSupport.supported ? describe : describe.skip)(
  "native session recovery database orchestration",
  () => {
    it("uses scoped latest checkpoints, preserves progress barriers, and guards bootstrap persistence after the row lock", async () => {
      const database = await startEmbeddedPostgresTestDatabase(
        "paperclip-native-resume-selection-",
      );
      const db = createDb(database.connectionString);
      try {
        const otherCompany = randomUUID(),
          otherAgent = randomUUID(),
          otherIssue = randomUUID();
        await db.insert(companies).values([
          { id: companyId, name: "Session recovery", issuePrefix: "NRS" },
          { id: otherCompany, name: "Other company", issuePrefix: "OTHER" },
        ]);
        await db.insert(agents).values([
          { id: agentId, companyId, name: "Native runner" },
          { id: otherAgent, companyId: otherCompany, name: "Other agent" },
        ]);
        await db.insert(issues).values([
          { id: issueId, companyId, title: "Retain this task" },
          { id: otherIssue, companyId, title: "Other task" },
        ]);
        const at = (second: number) =>
          new Date(Date.UTC(2026, 8, 8, 0, 0, second));
        const source = {
          ...previousRun(),
          runtimeMode: "native",
          nativeIssueId: issueId,
          status: "failed",
          createdAt: at(0),
          runnerInstanceId: randomUUID(),
        };
        const unused = {
          companyId,
          agentId,
          runtimeMode: "native",
          nativeIssueId: issueId,
          nativeSessionId: normalizedSessionId,
          status: "failed",
          runnerProfileJson: {},
        };
        const bootstrapId = randomUUID();
        const futureId = randomUUID();
        await db.insert(heartbeatRuns).values([
          source,
          { ...unused, id: bootstrapId, createdAt: at(2) },
          {
            ...unused,
            id: currentRunId,
            status: "running",
            createdAt: at(10),
          },
          {
            ...unused,
            id: randomUUID(),
            companyId: otherCompany,
            createdAt: at(3),
            status: "running",
          },
          {
            ...unused,
            id: randomUUID(),
            agentId: otherAgent,
            createdAt: at(4),
            status: "running",
          },
          {
            ...unused,
            id: randomUUID(),
            nativeIssueId: otherIssue,
            createdAt: at(5),
            status: "running",
          },
          {
            ...unused,
            id: randomUUID(),
            nativeSessionId: randomUUID(),
            createdAt: at(6),
            status: "running",
          },
          {
            ...unused,
            id: futureId,
            createdAt: at(11),
          },
        ]);
        const selection = {
          companyId,
          agentId,
          issueId,
          normalizedSessionId,
          currentRunId,
          beforeCreatedAt: at(10),
        };
        expect((await findNativeSessionResumeRun(db, selection))?.id).toBe(
          previousRunId,
        );
        await db
          .update(heartbeatRuns)
          .set({ runnerProfileJson: source.runnerProfileJson })
          .where(eq(heartbeatRuns.id, futureId));
        expect(await findNativeSessionResumeRun(db, selection)).toBeNull();
        await db
          .update(heartbeatRuns)
          .set({ runnerProfileJson: {}, status: "running" })
          .where(eq(heartbeatRuns.id, futureId));
        expect(await findNativeSessionResumeRun(db, selection)).toBeNull();
        await db
          .update(heartbeatRuns)
          .set({ status: "failed" })
          .where(eq(heartbeatRuns.id, futureId));
        expect((await findNativeSessionResumeRun(db, selection))?.id).toBe(
          previousRunId,
        );
        await db.insert(heartbeatRunEvents).values({
          companyId,
          agentId,
          runId: bootstrapId,
          seq: 1,
          eventType: "session.started",
        });
        expect(await findNativeSessionResumeRun(db, selection)).toBeNull();
        const incompatibleId = randomUUID();
        await db.insert(heartbeatRuns).values({
          ...unused,
          id: incompatibleId,
          createdAt: at(7),
          runnerProfileJson: {
            ...source.runnerProfileJson,
            nativeToolContractFingerprint: "stale",
          },
        });
        const incompatible = await findNativeSessionResumeRun(db, selection);
        expect(incompatible?.id).toBe(incompatibleId);
        expect(
          rebindNativeSessionCheckpoint({
            previousRun: incompatible!,
            currentExecution: execution(currentRunId),
          }),
        ).toBeNull();

        const fresh = buildNativeExecutionWithCheckpoint({
          previousRun: null,
          normalizedSessionId,
          buildExecution: ({ normalizedSessionId: selected }) => {
            const current = execution(currentRunId);
            return {
              ...current,
              session: { ...current.session, normalizedSessionId: selected },
            };
          },
        });
        await db.transaction(async (tx) => {
          const [locked] = await tx
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, currentRunId))
            .for("update");
          const selected = await prepareNativeSessionBootstrapPersistence(tx, {
            run: locked,
            selectedSessionId: fresh.normalizedSessionId,
            execution: fresh.execution,
            restoringCheckpoint: false,
          });
          await tx
            .update(heartbeatRuns)
            .set({
              nativeSessionId: selected,
              runnerProfileJson: { nativeExecutionInput: fresh.execution },
            })
            .where(eq(heartbeatRuns.id, locked.id));
        });
        const [persisted] = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, currentRunId));
        expect(persisted.nativeSessionId).toBe(fresh.normalizedSessionId);
        expect(persisted.nativeSessionId).not.toBe(normalizedSessionId);
        await expect(
          db.transaction(async (tx) => {
            const [locked] = await tx
              .select()
              .from(heartbeatRuns)
              .where(eq(heartbeatRuns.id, currentRunId))
              .for("update");
            return prepareNativeSessionBootstrapPersistence(tx, {
              run: locked,
              selectedSessionId: fresh.normalizedSessionId,
              execution: fresh.execution,
              restoringCheckpoint: false,
            });
          }),
        ).resolves.toBe(fresh.normalizedSessionId);
        await expect(
          db.transaction(async (tx) => {
            const [locked] = await tx
              .select()
              .from(heartbeatRuns)
              .where(eq(heartbeatRuns.id, currentRunId))
              .for("update");
            const changedExecution = structuredClone(fresh.execution);
            changedExecution.task.prompt = "Changed admission";
            return prepareNativeSessionBootstrapPersistence(tx, {
              run: locked,
              selectedSessionId: fresh.normalizedSessionId,
              execution: changedExecution,
              restoringCheckpoint: false,
            });
          }),
        ).rejects.toThrow("native_execution_input_persisted_binding_mismatch");
        const [preserved] = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, previousRunId));
        expect(preserved.runnerProfileJson).toEqual(source.runnerProfileJson);

        const lateId = randomUUID();
        await db
          .insert(heartbeatRuns)
          .values({ ...unused, id: lateId, createdAt: at(11) });
        expect((await nativeSessionProviderEvidence(db, [lateId])).size).toBe(
          0,
        );
        let unlock!: () => void;
        let locked!: () => void;
        const lockAcquired = new Promise<void>((resolve) => {
          locked = resolve;
        });
        const release = new Promise<void>((resolve) => {
          unlock = resolve;
        });
        const writer = db.transaction(async (tx) => {
          await tx
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, lateId))
            .for("update");
          locked();
          await release;
          await tx.insert(heartbeatRunEvents).values({
            companyId,
            agentId,
            runId: lateId,
            seq: 1,
            eventType: "session.started",
          });
        });
        let attempt: Promise<unknown> | undefined;
        try {
          await lockAcquired;
          const applicationName = `native-resume-lock-${randomUUID()}`;
          attempt = db
            .transaction(async (tx) => {
              await tx.execute(
                sql`select set_config('application_name', ${applicationName}, true)`,
              );
              const [row] = await tx
                .select()
                .from(heartbeatRuns)
                .where(eq(heartbeatRuns.id, lateId))
                .for("update");
              return prepareNativeSessionBootstrapPersistence(tx, {
                run: row,
                selectedSessionId: randomUUID(),
                execution: execution(lateId),
                restoringCheckpoint: false,
              });
            })
            .then(
              () => null,
              (error: unknown) => error,
            );
          await expect
            .poll(async () => {
              const rows = await db.execute<{ blocked: boolean }>(sql`
                select exists (
                  select 1 from pg_stat_activity
                  where application_name = ${applicationName}
                    and wait_event_type = 'Lock'
                    and cardinality(pg_blocking_pids(pid)) > 0
                ) as blocked
              `);
              return rows[0]?.blocked;
            })
            .toBe(true);
          unlock();
          await writer;
          expect(await attempt).toMatchObject({
            message: "native_session_bootstrap_identity_conflict",
          });
          const [unchanged] = await db
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, lateId));
          expect(unchanged.nativeSessionId).toBe(normalizedSessionId);
        } finally {
          unlock();
          await Promise.all([writer, attempt]);
        }
      } finally {
        await database.cleanup();
      }
    }, 60_000);
  },
);

describe("rebindNativeSessionCheckpoint", () => {
  it("rotates a carried session id when no checkpoint source exists", () => {
    const calls: boolean[] = [];
    const result = buildNativeExecutionWithCheckpoint({
      previousRun: null,
      normalizedSessionId,
      buildExecution: (options) => {
        calls.push(options.resumedSession);
        const current = execution(currentRunId);
        return {
          ...current,
          session: {
            ...current.session,
            normalizedSessionId: options.normalizedSessionId,
          },
          task: {
            ...current.task,
            prompt: options.resumedSession
              ? "Compact delta"
              : "Full task context",
          },
        };
      },
    });
    expect(calls.every((resumed) => !resumed)).toBe(true);
    expect(result.checkpoint).toBeNull();
    expect(result.normalizedSessionId).not.toBe(normalizedSessionId);
    expect(result.execution.session.normalizedSessionId).toBe(
      result.normalizedSessionId,
    );
    expect(result.execution.task.prompt).toBe("Full task context");
    expect(
      nativeSessionIdForBootstrapPersistence({
        run: {
          nativeSessionId: normalizedSessionId,
          processPid: null,
          processGroupId: null,
          processStartedAt: null,
          runnerProfileJson: {},
        },
        selectedSessionId: result.normalizedSessionId,
        hasProviderEvents: false,
      }),
    ).toBe(result.normalizedSessionId);
  });

  it("does not rotate an admitted or authority-bearing session id", () => {
    const unused = {
      nativeSessionId: normalizedSessionId,
      processPid: null,
      processGroupId: null,
      processStartedAt: null,
      runnerProfileJson: {},
    };
    for (const run of [
      {
        ...unused,
        runnerProfileJson: { nativeExecutionInput: execution(currentRunId) },
      },
      { ...unused, runnerProfileJson: { sessionCheckpoint: {} } },
      { ...unused, processPid: 123 },
      { ...unused, processGroupId: 123 },
      { ...unused, processStartedAt: new Date() },
    ]) {
      expect(() =>
        nativeSessionIdForBootstrapPersistence({
          run,
          selectedSessionId: previousRunId,
          hasProviderEvents: false,
        }),
      ).toThrow("native_session_bootstrap_identity_conflict");
    }
    expect(() =>
      nativeSessionIdForBootstrapPersistence({
        run: unused,
        selectedSessionId: previousRunId,
        hasProviderEvents: true,
      }),
    ).toThrow("native_session_bootstrap_identity_conflict");
    expect(
      nativeSessionIdForBootstrapPersistence({
        run: {
          ...unused,
          runnerProfileJson: { nativeExecutionInput: execution(currentRunId) },
        },
        selectedSessionId: normalizedSessionId,
        hasProviderEvents: true,
      }),
    ).toBe(normalizedSessionId);
  });

  it("recovers the latest exact checkpoint past only unused bootstrap failures", () => {
    const source = {
      ...previousRun(),
      nativeIssueId: issueId,
      runtimeMode: "native",
      status: "failed",
      createdAt: new Date(0),
      processPid: null,
      processGroupId: null,
      processStartedAt: null,
    };
    const unusedFailure = {
      ...source,
      id: "failed-bootstrap",
      runnerProfileJson: {
        nativeExecutionInput: execution("failed-bootstrap"),
      },
    };
    const original = structuredClone(source);
    const selected = selectNativeSessionResumeRun({
      runs: [unusedFailure, source],
      companyId,
      agentId,
      issueId,
      normalizedSessionId,
      currentRunId,
      beforeCreatedAt: new Date(100),
      providerEvidenceRunIds: new Set(),
    });
    expect(selected).toBe(source);
    expect(
      rebindNativeSessionCheckpoint({
        previousRun: selected!,
        currentExecution: execution(currentRunId),
      }),
    ).toMatchObject({
      sessionId: "provider-thread-123",
      identity: { runId: currentRunId, sessionId: normalizedSessionId },
    });
    expect(source).toEqual(original);
  });

  it("never skips a newer provider authority or incompatible checkpoint", () => {
    const source = {
      ...previousRun(),
      nativeIssueId: issueId,
      runtimeMode: "native",
      status: "succeeded",
      createdAt: new Date(0),
      processPid: null as number | null,
      processGroupId: null,
      processStartedAt: null,
    };
    const newer = { ...source, id: "newer", runnerProfileJson: {} };
    const select = (
      candidate: typeof source | typeof newer,
      hasEvents = false,
    ) =>
      selectNativeSessionResumeRun({
        runs: [candidate, source],
        companyId,
        agentId,
        issueId,
        normalizedSessionId,
        currentRunId,
        beforeCreatedAt: new Date(100),
        providerEvidenceRunIds: new Set(hasEvents ? [candidate.id] : []),
      });
    expect(select(newer, true)).toBeNull();
    expect(select({ ...newer, processPid: 123 })).toBeNull();
    expect(select({ ...newer, status: "running" })).toBeNull();
    const incompatible = {
      ...source,
      id: "newer",
      runnerProfileJson: {
        ...source.runnerProfileJson,
        nativeToolContractFingerprint: "stale",
      },
    };
    expect(select(incompatible)).toBe(incompatible);
    expect(
      rebindNativeSessionCheckpoint({
        previousRun: select(incompatible)!,
        currentExecution: execution(currentRunId),
      }),
    ).toBeNull();
  });

  it("does not borrow checkpoints across company, agent, issue, or normalized session", () => {
    const source = {
      ...previousRun(),
      nativeIssueId: issueId,
      runtimeMode: "native",
      status: "succeeded",
      createdAt: new Date(0),
      processPid: null,
      processGroupId: null,
      processStartedAt: null,
    };
    for (const changed of [
      { companyId: currentRunId },
      { agentId: currentRunId },
      { nativeIssueId: currentRunId },
      { nativeSessionId: currentRunId },
      { id: currentRunId },
    ]) {
      expect(
        selectNativeSessionResumeRun({
          runs: [{ ...source, ...changed }],
          companyId,
          agentId,
          issueId,
          normalizedSessionId,
          currentRunId,
          beforeCreatedAt: new Date(100),
          providerEvidenceRunIds: new Set(),
        }),
      ).toBeNull();
    }
  });

  it("does not resume across a work-mode tool-surface change", () => {
    expect(
      rebindNativeSessionCheckpoint({
        previousRun: previousRun(),
        currentExecution: execution(currentRunId, "/workspace", "ask"),
      }),
    ).toBeNull();
  });
  it.each(["External chat message received", "issue_comment_added"])(
    "rebuilds full task context when a %s checkpoint is corrupt",
    (reason) => {
      const calls: boolean[] = [];
      const result = buildNativeExecutionWithCheckpoint({
        previousRun: previousRun({ sessionCheckpoint: {} }),
        normalizedSessionId,
        buildExecution: (options) => {
          calls.push(options.resumedSession);
          return buildNativeExecutionInput({
            companyId,
            runId: currentRunId,
            issue: {
              id: issueId,
              identifier: "DOT-2",
              title: "Current task",
              description: "Full task instructions",
              workMode: "standard",
            },
            taskPrompt: options.resumedSession
              ? "Compact context"
              : "Full task instructions",
            wakePayload: {
              reason,
              issue: {
                id: issueId,
                title: "Current task",
                workMode: "standard",
              },
            },
            resumedSession: options.resumedSession,
            agentId,
            workspace: {
              id: currentRunId,
              cwd: "/workspace",
              repoUrl: null,
              repoRef: null,
              branchName: null,
            },
            normalizedSessionId: options.normalizedSessionId,
            provider: "codex",
            completionContract: execution(currentRunId).completionContract,
            runtimeContext: nativeRuntimeContextFixture(),
          });
        },
      });
      expect(calls).toEqual([true, false]);
      expect(result.checkpoint).toBeNull();
      expect(result.execution.session.normalizedSessionId).not.toBe(
        normalizedSessionId,
      );
      expect(result.execution.task.prompt).toContain("Full task instructions");
      expect(result.execution.task.prompt).not.toContain(
        "Paperclip Resume Delta",
      );
      expect(result.execution.task.prompt).not.toContain("Compact context");
    },
  );

  it("keeps a valid checkpoint and does not rebuild the resumed task", () => {
    const calls: boolean[] = [];
    const result = buildNativeExecutionWithCheckpoint({
      previousRun: previousRun(),
      normalizedSessionId,
      buildExecution: (options) => {
        calls.push(options.resumedSession);
        return execution(currentRunId);
      },
    });
    expect(calls).toEqual([true]);
    expect(result.checkpoint?.sessionId).toBe("provider-thread-123");
    expect(result.execution.session.normalizedSessionId).toBe(
      normalizedSessionId,
    );
  });

  it("rebuilds full context when the persisted provider tool contract is stale", () => {
    const calls: boolean[] = [];
    const result = buildNativeExecutionWithCheckpoint({
      previousRun: previousRun({
        nativeToolContractFingerprint: "sha256:stale",
      }),
      normalizedSessionId,
      buildExecution: (options) => {
        calls.push(options.resumedSession);
        const current = execution(currentRunId);
        return {
          ...current,
          session: {
            ...current.session,
            normalizedSessionId: options.normalizedSessionId,
          },
          task: {
            ...current.task,
            prompt: options.resumedSession
              ? "Paperclip Resume Delta"
              : "Full task instructions",
          },
        };
      },
    });

    expect(calls).toEqual([true, false]);
    expect(result.checkpoint).toBeNull();
    expect(result.execution.task.prompt).toBe("Full task instructions");
    expect(result.normalizedSessionId).not.toBe(normalizedSessionId);
  });

  it.each([
    {
      contract: "completion descriptions",
      // Deployed v8 / finish_response_wake_concrete_object.v2 local catalog.
      retainedFingerprint:
        "sha256:5b7b302db36f7ed6686f9ea1ba70bbf79ebd7fabf86953b548d966a2bc38b648",
    },
    {
      contract: "task-bound human-input description",
      // Deployed v9 still advertises the generic mock-task question description.
      retainedFingerprint:
        "sha256:b64efcd063a575925aa95dbd2a20953386eaa760f05b0e0e73b4ae04a97679b0",
    },
  ])(
    "refreshes retained $contract without changing the Paperclip task or prior history",
    ({ retainedFingerprint }) => {
      expect(NATIVE_TOOL_CONTRACT_FINGERPRINT).not.toBe(retainedFingerprint);
      const prior = previousRun({
        nativeToolContractFingerprint: retainedFingerprint,
      });
      const priorSnapshot = structuredClone(prior);
      const modes: boolean[] = [];
      const result = buildNativeExecutionWithCheckpoint({
        previousRun: prior,
        normalizedSessionId,
        buildExecution: (options) => {
          modes.push(options.resumedSession);
          const current = execution(currentRunId);
          return {
            ...current,
            session: {
              ...current.session,
              normalizedSessionId: options.normalizedSessionId,
            },
            task: {
              ...current.task,
              prompt: options.resumedSession
                ? "Paperclip Resume Delta"
                : "Full context for the same Paperclip task",
            },
          };
        },
      });
      expect(modes).toEqual([true, false]);
      expect(result.checkpoint).toBeNull();
      expect(result.normalizedSessionId).not.toBe(normalizedSessionId);
      expect(result.execution.binding).toMatchObject({
        companyId,
        issueId,
        agentId,
        runId: currentRunId,
      });
      expect(result.execution.workspace).toEqual(
        execution(currentRunId).workspace,
      );
      expect(result.execution.task.prompt).toBe(
        "Full context for the same Paperclip task",
      );
      // No deletion/reset of the existing provider checkpoint or Paperclip history.
      expect(prior).toEqual(priorSnapshot);
      expect(prior.runnerProfileJson.sessionCheckpoint.sessionId).toBe(
        "provider-thread-123",
      );
    },
  );

  it("rotates a provider thread created while the current-wake reader was conditionally advertised", () => {
    expect(CONDITIONAL_READER_TOOL_CONTRACT_FINGERPRINT).not.toBe(
      NATIVE_TOOL_CONTRACT_FINGERPRINT,
    );
    expect(
      rebindNativeSessionCheckpoint({
        previousRun: previousRun({
          nativeToolContractFingerprint:
            CONDITIONAL_READER_TOOL_CONTRACT_FINGERPRINT,
        }),
        currentExecution: execution(currentRunId),
      }),
    ).toBeNull();
  });

  it("rotates a provider thread that predates same-conversation attachment reuse", () => {
    expect(PRE_CHAT_ATTACHMENT_REUSE_TOOL_CONTRACT_FINGERPRINT).not.toBe(
      NATIVE_TOOL_CONTRACT_FINGERPRINT,
    );
    expect(
      rebindNativeSessionCheckpoint({
        previousRun: previousRun({
          nativeToolContractFingerprint:
            PRE_CHAT_ATTACHMENT_REUSE_TOOL_CONTRACT_FINGERPRINT,
        }),
        currentExecution: execution(currentRunId),
      }),
    ).toBeNull();
  });

  it("binds the provider tool catalog to the local or remote execution target", () => {
    const remoteFingerprint = nativeToolContractFingerprintForTarget("remote");
    expect(remoteFingerprint).not.toBe(NATIVE_TOOL_CONTRACT_FINGERPRINT);
    expect(
      rebindNativeSessionCheckpoint({
        previousRun: previousRun(),
        currentExecution: execution(currentRunId),
        executionTargetKind: "remote",
      }),
    ).toBeNull();
    expect(
      rebindNativeSessionCheckpoint({
        previousRun: previousRun({
          nativeToolContractFingerprint: remoteFingerprint,
        }),
        currentExecution: execution(currentRunId),
        executionTargetKind: "remote",
      }),
    ).not.toBeNull();
  });

  it("rotates provider threads whose retained catalog cannot inspect historical files", () => {
    expect(PRE_CHAT_ATTACHMENT_READ_TOOL_CONTRACT_FINGERPRINT).not.toBe(
      NATIVE_TOOL_CONTRACT_FINGERPRINT,
    );
    expect(
      rebindNativeSessionCheckpoint({
        previousRun: previousRun({
          nativeToolContractFingerprint:
            PRE_CHAT_ATTACHMENT_READ_TOOL_CONTRACT_FINGERPRINT,
        }),
        currentExecution: execution(currentRunId),
      }),
    ).toBeNull();
  });

  it("rotates direct provider threads whose retained catalog cannot ask structured questions", () => {
    expect(PRE_STRUCTURED_HUMAN_INPUT_TOOL_CONTRACT_FINGERPRINT).not.toBe(
      NATIVE_TOOL_CONTRACT_FINGERPRINT,
    );
    expect(
      rebindNativeSessionCheckpoint({
        previousRun: previousRun({
          nativeToolContractFingerprint:
            PRE_STRUCTURED_HUMAN_INPUT_TOOL_CONTRACT_FINGERPRINT,
        }),
        currentExecution: execution(currentRunId),
      }),
    ).toBeNull();
  });

  it("rotates direct provider threads whose retained completion tool cannot yield for a response", () => {
    expect(PRE_RESPONSE_WAKE_YIELD_TOOL_CONTRACT_FINGERPRINT).not.toBe(
      NATIVE_TOOL_CONTRACT_FINGERPRINT,
    );
    expect(
      rebindNativeSessionCheckpoint({
        previousRun: previousRun({
          nativeToolContractFingerprint:
            PRE_RESPONSE_WAKE_YIELD_TOOL_CONTRACT_FINGERPRINT,
        }),
        currentExecution: execution(currentRunId),
      }),
    ).toBeNull();
  });

  it("rotates provider threads whose retained attachment tools lack explicit invocation guidance", () => {
    expect(LIST_CHAT_ATTACHMENTS_TOOL_DEFINITION.description).toContain(
      "Call with {}",
    );
    expect(LIST_CHAT_ATTACHMENTS_TOOL_DEFINITION.description).toContain(
      "1 through 50",
    );
    expect(REUSE_CHAT_ATTACHMENT_TOOL_DEFINITION.description).toContain(
      "All four arguments are required",
    );
    expect(REUSE_CHAT_ATTACHMENT_TOOL_DEFINITION.description).toContain(
      "same key unchanged on every retry",
    );
    expect(
      PRE_EXPLICIT_CHAT_ATTACHMENT_GUIDANCE_TOOL_CONTRACT_FINGERPRINT,
    ).not.toBe(NATIVE_TOOL_CONTRACT_FINGERPRINT);
    expect(
      rebindNativeSessionCheckpoint({
        previousRun: previousRun({
          nativeToolContractFingerprint:
            PRE_EXPLICIT_CHAT_ATTACHMENT_GUIDANCE_TOOL_CONTRACT_FINGERPRINT,
        }),
        currentExecution: execution(currentRunId),
      }),
    ).toBeNull();
  });

  it("permits legacy retry rebinding only before the replacement acquired authority", () => {
    const source = {
      runtimeMode: "native",
      status: "interrupted",
      nativeSessionId: normalizedSessionId,
    };
    const replacement = {
      processPid: null,
      processGroupId: null,
      processStartedAt: null,
      runnerProfileJson: {},
    };
    expect(
      isUnusedLegacyNativeRetryReplacement({
        source,
        replacement,
        hasProviderEvents: false,
      }),
    ).toBe(true);
    expect(
      isUnusedLegacyNativeRetryReplacement({
        source,
        replacement: { ...replacement, processPid: 123 },
        hasProviderEvents: false,
      }),
    ).toBe(false);
    expect(
      isUnusedLegacyNativeRetryReplacement({
        source,
        replacement,
        hasProviderEvents: true,
      }),
    ).toBe(false);
    expect(
      isUnusedLegacyNativeRetryReplacement({
        source,
        replacement: {
          ...replacement,
          runnerProfileJson: {
            sessionCheckpoint: { providerSessionId: "claimed" },
          },
        },
        hasProviderEvents: false,
      }),
    ).toBe(false);
  });

  it("retains provider identity but clears prior turn and event state", () => {
    const rebound = rebindNativeSessionCheckpoint({
      previousRun: previousRun(),
      currentExecution: execution(currentRunId),
    });
    expect(rebound).toMatchObject({
      sessionId: "provider-thread-123",
      providerSessionId: "provider-thread-123",
      driverKind: "codex_app_server",
      cursor: null,
      semanticResult: null,
      terminal: null,
      activeTurnId: null,
      terminalTurns: [],
      pendingRuntimeRequests: [],
      providerRecoveryPolicy: "allow_replacement_after_resume_failure",
      identity: {
        runId: currentRunId,
        sessionId: normalizedSessionId,
        companyId,
        issueId,
        agentId,
      },
    });
  });

  it("allows a provider replacement only after a durable response wake", () => {
    const source = previousRun();
    const profile = source.runnerProfileJson as Record<string, unknown>;
    const checkpoint = profile.sessionCheckpoint as Record<string, unknown>;
    checkpoint.semanticResult = {
      schema: "paperclip.run_result.v1",
      reportedWorkDisposition: "yielded",
      summary: "Waiting for a response.",
      continuation: {
        kind: "response_wake",
        idempotencyKey: "interaction-response:one",
      },
    };

    expect(
      rebindNativeSessionCheckpoint({
        previousRun: source,
        currentExecution: execution(currentRunId),
      }),
    ).toMatchObject({
      providerRecoveryPolicy: "allow_replacement_after_governed_wait",
      semanticResult: null,
      activeTurnId: null,
    });
  });

  it("requires exact provider continuity for an unfinished session goal", () => {
    const source = previousRun();
    const profile = source.runnerProfileJson as Record<string, unknown>;
    const checkpoint = profile.sessionCheckpoint as Record<string, unknown>;
    checkpoint.goal = {
      threadId: "provider-thread-123",
      objective: "Keep this paused goal on its original provider session.",
      status: "paused",
      tokenBudget: null,
      tokensUsed: 321,
      timeUsedSeconds: 12,
    };
    checkpoint.semanticResult = {
      schema: "paperclip.run_result.v1",
      reportedWorkDisposition: "yielded",
      summary: "Paused at a quiescent boundary.",
      continuation: {
        kind: "same_agent",
        idempotencyKey: "goal:paused:one",
      },
    };

    expect(
      rebindNativeSessionCheckpoint({
        previousRun: source,
        currentExecution: execution(currentRunId),
      }),
    ).toMatchObject({
      providerRecoveryPolicy: "same_session_only",
      semanticResult: null,
      activeTurnId: null,
      goal: {
        objective: "Keep this paused goal on its original provider session.",
        status: "paused",
      },
    });
  });

  it("refuses to resume when the workspace changes", () => {
    expect(
      rebindNativeSessionCheckpoint({
        previousRun: previousRun(),
        currentExecution: execution(currentRunId, "/different-workspace"),
      }),
    ).toBeNull();
  });

  it("requires the exact managed execution-workspace identity", () => {
    const managedWorkspaceId = "90000000-0000-4000-8000-000000000009";
    const source = previousRun({
      nativeExecutionInput: execution(
        previousRunId,
        "/shared-workspace",
        "standard",
        { id: managedWorkspaceId },
      ),
    });
    expect(
      rebindNativeSessionCheckpoint({
        previousRun: source,
        currentExecution: execution(
          currentRunId,
          "/shared-workspace",
          "standard",
          { id: managedWorkspaceId },
        ),
      }),
    ).not.toBeNull();
    expect(
      rebindNativeSessionCheckpoint({
        previousRun: source,
        currentExecution: execution(
          currentRunId,
          "/shared-workspace",
          "standard",
          { id: "a0000000-0000-4000-8000-00000000000a" },
        ),
      }),
    ).toBeNull();
  });

  it("permits per-run projectless placeholders only for an identical workspace descriptor", () => {
    const source = previousRun({
      nativeExecutionInput: execution(
        previousRunId,
        "/projectless",
        "standard",
        {
          repoUrl: "https://example.test/repo.git",
          repoRef: "refs/heads/main",
          branchName: "main",
        },
      ),
    });
    const matching = execution(currentRunId, "/projectless", "standard", {
      repoUrl: "https://example.test/repo.git",
      repoRef: "refs/heads/main",
      branchName: "main",
    });
    expect(
      rebindNativeSessionCheckpoint({
        previousRun: source,
        currentExecution: matching,
      }),
    ).not.toBeNull();
    expect(
      rebindNativeSessionCheckpoint({
        previousRun: source,
        currentExecution: {
          ...matching,
          workspace: { ...matching.workspace, repoRef: "refs/heads/next" },
        },
      }),
    ).toBeNull();
    expect(
      rebindNativeSessionCheckpoint({
        previousRun: source,
        currentExecution: execution(currentRunId, "/projectless", "standard", {
          id: "b0000000-0000-4000-8000-00000000000b",
          repoUrl: "https://example.test/repo.git",
          repoRef: "refs/heads/main",
          branchName: "main",
        }),
      }),
    ).toBeNull();
  });

  it("rotates when assigned context changes but permits a fresh run-scoped MCP binding", () => {
    const reboundCredential = execution(currentRunId);
    reboundCredential.runtimeContext.mcp.bindingId = "native-mcp:fresh-run";
    expect(
      rebindNativeSessionCheckpoint({
        previousRun: previousRun(),
        currentExecution: reboundCredential,
      }),
    ).not.toBeNull();

    const changedAssignment = execution(currentRunId);
    const withoutAggregate = {
      prompt: changedAssignment.runtimeContext.prompt,
      instructions: changedAssignment.runtimeContext.instructions,
      skills: changedAssignment.runtimeContext.skills,
      mcp: {
        assignmentSetId: `sha256:${"1".repeat(64)}`,
        digest: "1".repeat(64),
        bindingId: "native-mcp:fresh-run",
      },
    };
    changedAssignment.runtimeContext = {
      ...withoutAggregate,
      aggregateDigest: canonicalNativeRuntimeContextDigest(withoutAggregate),
    };
    expect(
      rebindNativeSessionCheckpoint({
        previousRun: previousRun(),
        currentExecution: changedAssignment,
      }),
    ).toBeNull();
  });

  it("refuses a checkpoint whose prior-run binding was rewritten", () => {
    const source = previousRun();
    const profile = source.runnerProfileJson as Record<string, unknown>;
    const checkpoint = profile.sessionCheckpoint as Record<string, unknown>;
    checkpoint.identity = {
      ...(checkpoint.identity as Record<string, unknown>),
      runId: currentRunId,
    };
    expect(
      rebindNativeSessionCheckpoint({
        previousRun: source,
        currentExecution: execution(currentRunId),
      }),
    ).toBeNull();
  });

  it("reuses plan mode across canonical revisions but never across a mode change", () => {
    const source = previousRun({
      nativeExecutionInput: planningExecution(previousRunId, "revision-8"),
    });
    expect(
      rebindNativeSessionCheckpoint({
        previousRun: source,
        currentExecution: planningExecution(currentRunId, "revision-9"),
      }),
    ).not.toBeNull();
    expect(
      rebindNativeSessionCheckpoint({
        previousRun: source,
        currentExecution: execution(currentRunId),
      }),
    ).toBeNull();
  });
});

describe("buildNativeExecutionInput wake projection", () => {
  it("uses a neutral turn title for authenticated external-chat follow-ups", () => {
    const staleRootTitle = "Reply with exactly STALE-ROOT-MARKER";
    const input = buildNativeExecutionInput({
      companyId,
      runId: currentRunId,
      issue: {
        id: issueId,
        identifier: "CHAT-4",
        title: staleRootTitle,
        description: "Started from Telegram.",
        workMode: "standard",
      },
      taskPrompt: [
        "Paperclip task context:",
        `- Title: ${JSON.stringify(staleRootTitle)}`,
        "Latest wake comment:",
        "```text",
        "Quick question: what is 55 + 8?",
        "```",
      ].join("\n"),
      wakePayload: {
        reason: "External chat message received",
        externalChatProvider: "telegram",
        checkedOutByHarness: true,
        issue: {
          id: issueId,
          identifier: "CHAT-4",
          title: staleRootTitle,
          description: "Started from Telegram.",
          descriptionTruncated: false,
          status: "in_progress",
          workMode: "standard",
        },
        commentWindow: {
          requestedCount: 1,
          includedCount: 1,
          missingCount: 0,
        },
        commentIds: ["comment-current"],
        latestCommentId: "comment-current",
        comments: [
          {
            id: "comment-current",
            issueId,
            body: "Quick question: what is 55 + 8?",
            bodyTruncated: false,
            authorType: "user",
          },
        ],
        fallbackFetchNeeded: false,
      },
      agentId,
      workspace: {
        id: currentRunId,
        cwd: "/workspace",
        repoUrl: null,
        repoRef: null,
        branchName: null,
      },
      normalizedSessionId,
      provider: "codex",
      completionContract: {
        id: "70000000-0000-4000-8000-000000000007",
        sha256: `sha256:${"a".repeat(64)}`,
        schemaVersion: "paperclip.run-result.v1",
        contract: {
          revision: "2",
          objective: "Respond to the latest comment",
          criteria: [
            {
              id: "objective",
              requirement: "Quick question: what is 55 + 8?",
            },
          ],
        },
      },
      runtimeContext: nativeRuntimeContextFixture(),
    });

    expect(input.task.title).toBe("External chat follow-up");
    expect(input.task.description).toBeNull();
    expect(input.task.prompt).toContain(staleRootTitle);
    expect(input.task.prompt).toContain("Quick question: what is 55 + 8?");
    expect(input.completionContract.contract).toMatchObject({
      objective: "Respond to the latest comment",
      criteria: [
        {
          id: "objective",
          requirement: "Quick question: what is 55 + 8?",
        },
      ],
    });
  });

  it("preserves the canonical task title outside the authenticated chat shortcut", () => {
    const input = execution(currentRunId);

    expect(input.task.title).toBe("Test");
  });

  it("writes native v4 and pins every provider's complete effective configuration", () => {
    const common = {
      companyId,
      runId: currentRunId,
      issue: {
        id: issueId,
        identifier: "DOT-4",
        title: "Permissions",
        description: null,
        workMode: "standard",
      },
      taskPrompt: "Verify permissions",
      agentId,
      workspace: {
        id: currentRunId,
        cwd: "/workspace",
        repoUrl: null,
        repoRef: null,
        branchName: null,
      },
      normalizedSessionId,
      completionContract: execution(currentRunId).completionContract,
      runtimeContext: nativeRuntimeContextFixture(),
    } as const;
    const codex = buildNativeExecutionInput({
      ...common,
      provider: "codex",
      codexApprovalPolicy: "on-request",
    });
    const opencode = buildNativeExecutionInput({
      ...common,
      provider: "opencode",
      model: "openrouter/z-ai/glm-5.2",
      opencodePermissionMode: "ask",
    });
    const acpx = buildNativeExecutionInput({
      ...common,
      provider: "acpx",
      acpxAgent: "claude",
      model: "claude-sonnet-5",
      acpxPermissionMode: "deny-all",
    });
    const claudeManaged = buildNativeExecutionInput({
      ...common,
      provider: "claude_managed",
      model: "claude-sonnet-5",
      managedProfile: {
        profileId: "managed-profile",
        anthropicAgentId: "agent-remote",
        agentVersion: "7",
        environmentId: "environment-remote",
        betaVersion: "managed-agents-2026-04-01",
      },
      maxSessionListCostUsd: 0.75,
    });
    const agentCore = buildNativeExecutionInput({
      ...common,
      provider: "aws_agentcore",
      model: "global.anthropic.claude-sonnet-4-6",
      agentCoreProfile: {
        profileId: "agentcore-profile",
        region: "us-east-1",
        accountId: "123456789012",
        harnessArn:
          "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/h-1",
        harnessVersion: "3",
        endpointArn:
          "arn:aws:bedrock-agentcore:us-east-1:123456789012:endpoint/e-1",
        endpointQualifier: "prod",
        agentRuntimeArn:
          "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/r-1",
        memoryArn:
          "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/m-1",
        memoryId: "m-1",
        invocationRoleArn: "arn:aws:iam::123456789012:role/invoke",
        contextBucket: "paperclip-context",
        contextPrefix: "runner/",
        contextKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/key-1",
        qualificationRevision: "aws-agentcore-harness-context-v2",
        eventExpiryDays: 90,
      },
      maxEstimatedSessionCostUsd: 1.25,
      invocationLimits: {
        maxIterations: 8,
        maxOutputTokens: 4_096,
        timeoutSeconds: 300,
      },
    });
    const defaultOpenCode = buildNativeExecutionInput({
      ...common,
      provider: "opencode",
      model: "openrouter/z-ai/glm-5.2",
    });
    const defaultAcpx = buildNativeExecutionInput({
      ...common,
      provider: "acpx",
      model: "gpt-5.6-sol",
    });

    expect(codex).toMatchObject({
      schema: "paperclip.native-execution-input.v4",
      provider: { kind: "codex", approvalPolicy: "on-request" },
    });
    expect(opencode).toMatchObject({
      schema: "paperclip.native-execution-input.v4",
      provider: { kind: "opencode", permissionMode: "ask" },
    });
    expect(acpx).toMatchObject({
      schema: "paperclip.native-execution-input.v4",
      provider: { kind: "acpx", permissionMode: "deny-all" },
    });
    expect(claudeManaged).toMatchObject({
      session: { driverKind: "claude_managed_agents_api" },
      provider: {
        kind: "claude_managed",
        managedProfile: { profileId: "managed-profile" },
        maxSessionListCostUsd: 0.75,
      },
    });
    expect(agentCore).toMatchObject({
      session: { driverKind: "aws_agentcore_harness_api" },
      provider: {
        kind: "aws_agentcore",
        agentCoreProfile: {
          profileId: "agentcore-profile",
          eventExpiryDays: 90,
        },
        maxEstimatedSessionCostUsd: 1.25,
      },
    });
    expect(defaultOpenCode).toMatchObject({
      provider: { kind: "opencode", permissionMode: "ask" },
    });
    expect(defaultAcpx).toMatchObject({
      provider: {
        kind: "acpx",
        agent: "codex",
        permissionMode: "approve-reads",
      },
    });
    expect(
      JSON.stringify([codex, opencode, claudeManaged, agentCore, acpx]),
    ).not.toMatch(
      /OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_SECRET_ACCESS_KEY|PAPERCLIP_API_KEY/,
    );
  });

  it("places child completion summaries in the closed provider prompt", () => {
    const input = buildNativeExecutionInput({
      companyId,
      runId: currentRunId,
      issue: {
        id: issueId,
        identifier: "DOT-146",
        title: "Finish after child handoff",
        description: "Use the child result.",
        workMode: "standard",
      },
      taskPrompt: "Paperclip task context:\n- Issue: DOT-146",
      wakePayload: {
        reason: "issue_children_completed",
        issue: {
          id: issueId,
          identifier: "DOT-146",
          title: "Finish after child handoff",
          description: "Use the child result.",
          status: "in_progress",
          priority: "medium",
          workMode: "standard",
        },
        childIssueSummaries: [
          {
            id: "child-147",
            identifier: "DOT-147",
            title: "Build utility",
            status: "done",
            summary: "Created three files and passed 7/7 tests.",
          },
        ],
        childIssueSummaryTruncated: false,
        checkedOutByHarness: true,
      },
      resumedSession: true,
      agentId,
      workspace: {
        id: currentRunId,
        cwd: "/workspace",
        repoUrl: null,
        repoRef: null,
        branchName: null,
      },
      normalizedSessionId,
      provider: "opencode",
      model: "openrouter/z-ai/glm-5.2",
      completionContract: {
        id: "70000000-0000-4000-8000-000000000007",
        sha256: `sha256:${"a".repeat(64)}`,
        schemaVersion: "paperclip.run-result.v1",
        contract: {
          revision: "1",
          objective: "Finish after the child",
          criteria: [
            { id: "objective", requirement: "Report the child result" },
          ],
        },
      },
      runtimeContext: nativeRuntimeContextFixture(),
    });

    expect(input.task.prompt).toContain("## Paperclip Resume Delta");
    expect(input.task.prompt).toContain("reason: issue_children_completed");
    expect(input.task.prompt).toContain("DOT-147 Build utility (done)");
    expect(input.task.prompt).toContain(
      "Created three files and passed 7/7 tests.",
    );
    expect(input.task.prompt).toContain(
      "Paperclip task context:\n- Issue: DOT-146",
    );
    expect(input.task.prompt).not.toContain("Use the child result.");
  });
});
