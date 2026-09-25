import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NATIVE_RUNTIME_ASSET_SCHEMA,
  PAPERCLIP_EXECUTION_PROMPT,
  PAPERCLIP_EXECUTION_PROMPT_REVISION,
  canonicalNativeRuntimeContextDigest,
  nativeRuntimePromptDigest,
  type NativeRuntimeContextSnapshot,
} from "../../contracts/runtime-context.js";
import { releaseMaterializedNativeRuntimeSkills } from "../runtime-context-materializer.js";
import { openCodexAcpxRuntime } from "./codex-runtime-adapter.js";
import { stageManagedCodexCredential } from "./codex-credentials.js";
import type {
  VerifiedAcpxCommandLease,
  VerifiedAcpxInstallation,
} from "./installation-integrity.js";
import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import {
  prepareAcpxRuntimeSandbox,
  type AcpxRuntimeSandbox,
} from "./runtime-sandbox.js";
import {
  AcpxRuntimeHost,
  type AcpxRuntimeHostDependencies,
  type AcpxRuntimePort,
  type AcpxRuntimePortOpenOptions,
  type AcpxRuntimeTurn,
} from "./runtime-host.js";

const temporaryDirectories: string[] = [];
// A published skill snapshot is sealed read-only by `protectStagedTree`
// (runtime-context-materializer.ts:125, :133). Only
// `releaseMaterializedNativeRuntimeSkills` restores write permission before
// removal. `hostFixture` records every sandbox's skills home here as soon as
// the sandbox exists, before the materialize step that seals it and before
// any later step in the same open() call can fail or stall past this file's
// per-test timeout. `afterEach` releases every recorded home first, so a
// forced-open directory removal never has to unlink inside a sealed tree.
const materializedSkillsHomes: string[] = [];
const admissionControllers: AbortController[] = [];
const pendingAdmissionOpenings = new Set<Promise<void>>();
const pendingAdmissionCleanups = new Set<Promise<void>>();

// A credential or sandbox poll in this file can run behind a real retry
// envelope, not a mocked one. `stageManagedCodexCredential` first joins any
// in-flight quarantine recovery (codex-credentials.ts:183, :610-625). That
// recovery makes up to `MAX_AUTONOMOUS_CREDENTIAL_CLEANUP_ATTEMPTS` (8)
// attempts (codex-credentials.ts:19). The backoff between attempts is 10,
// 20, 40, 80, 160, 320, and 640 ms — 1,270 ms in total
// (codex-credentials.ts:558, :578-582). Each attempt can also run one real
// directory fsync. `DIRECTORY_SYNC_OPERATION_TIMEOUT_MS` (1,000 ms,
// codex-credentials.ts:18, :569, :1304) bounds that fsync. So one full
// recovery pass can cost up to 1,270 ms of backoff plus 8,000 ms of bounded
// fsync waits.
//
// When a pass does not clear the quarantine,
// `recoverQuarantinedCredentialCleanup` joins one more bounded attempt (up
// to 1,000 ms) before it gives up (codex-credentials.ts:616-619). So the
// full documented recovery path costs at least 8,000 + 1,270 + 1,000 =
// 10,270 ms. The vitest default `vi.waitFor` deadline is 1,000 ms, smaller
// than a single one of those inner bounds. So a poll can time out even
// though the call is still in progress.
//
// The helper deadline below adds margin on top of the 10,270 ms documented
// floor for the real filesystem work each attempt also does (two file
// removals and an intent-file delete, none of them bounded by
// `DIRECTORY_SYNC_OPERATION_TIMEOUT_MS`) and for this helper's own 50 ms
// poll granularity and Node event-loop scheduling jitter. A 30-second
// per-test budget keeps this wait reachable under the vitest per-test
// timeout, even for a test that runs the helper more than once.
const ACPX_OPERATION_WAIT_DEADLINE_MS = 15_000;
const ACPX_LONG_WAIT_TEST_TIMEOUT_MS = 30_000;

/**
 * Poll a credential or sandbox operation. Use a deadline derived from the
 * real retry envelope described above. Unlike a bare `vi.waitFor`, report
 * the last observed error when the deadline expires. Each attempt of
 * `callback` is itself bounded by the remaining deadline, so a callback
 * that stays pending cannot outlast the helper deadline and reach the
 * enclosing vitest per-test timeout instead.
 */
async function waitForAcpxOperation<T>(
  callback: () => T | Promise<T>,
): Promise<T> {
  const deadline = Date.now() + ACPX_OPERATION_WAIT_DEADLINE_MS;
  let lastError: unknown = new Error(
    "no attempt of this ACPX operation settled before the deadline",
  );
  for (;;) {
    try {
      return await runAcpxOperationAttempt(callback, deadline);
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const detail =
        lastError instanceof Error
          ? (lastError.stack ?? lastError.message)
          : String(lastError);
      throw new Error(
        `ACPX operation did not settle within ${ACPX_OPERATION_WAIT_DEADLINE_MS}ms. Last observed error: ${detail}`,
        { cause: lastError },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Run one attempt of `callback`, bounded by the time remaining until
 * `deadline`. A callback that is still pending when the remaining time
 * runs out rejects with a timeout error instead of blocking the retry
 * loop past the helper deadline.
 *
 * A rejected attempt does not cancel `callback`. If `callback` later
 * resolves to a `ManagedCodexCredentialLease`, close that lease so its
 * kernel lock and active lease generation do not stay allocated for the
 * rest of the test run.
 */
async function runAcpxOperationAttempt<T>(
  callback: () => T | Promise<T>,
  deadline: number,
): Promise<T> {
  const remainingMs = Math.max(0, deadline - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const callbackResult = Promise.resolve().then(callback);
  void callbackResult.then(
    (value) => {
      if (timedOut) void closeLateCredentialLease(value);
    },
    () => undefined,
  );
  try {
    return await Promise.race([
      callbackResult,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(
            new Error(
              `ACPX operation attempt did not settle within the remaining ${remainingMs}ms of the helper deadline`,
            ),
          );
        }, remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Close `value` if it is a `ManagedCodexCredentialLease` (or another lease
 * with the same `close()` shape). Swallow a close failure so cleanup of one
 * late lease cannot mask the original test failure.
 */
async function closeLateCredentialLease(value: unknown): Promise<void> {
  if (
    typeof value === "object" &&
    value !== null &&
    "close" in value &&
    typeof (value as { close: unknown }).close === "function"
  ) {
    await (value as { close(): Promise<void> }).close().catch(() => undefined);
  }
}

afterEach(async () => {
  for (const controller of admissionControllers.splice(0)) {
    if (!controller.signal.aborted) {
      controller.abort(new Error("ACPX runtime host test cleanup"));
    }
  }
  await Promise.all([...pendingAdmissionOpenings]);
  await Promise.all([...pendingAdmissionCleanups]);
  // Release every sealed skills tree before the plain `rm` below. `rm` does
  // not restore write permission, so a tree still sealed at this point would
  // otherwise fail with EACCES and hide the real test failure.
  await Promise.all(
    materializedSkillsHomes
      .splice(0)
      .map((skillsHome) => releaseMaterializedNativeRuntimeSkills(skillsHome)),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("ACPX runtime host", () => {
  it.each([
    { PAPERCLIP_NATIVE_MCP_NAME: "paperclip-assigned" },
    { PAPERCLIP_NATIVE_MCP_NAME: "paperclip", PAPERCLIP_NATIVE_MCP_URL: "http://127.0.0.1:3211/mcp", PAPERCLIP_NATIVE_MCP_TOKEN: "x".repeat(40) },
    { PAPERCLIP_NATIVE_MCP_NAME: "paperclip-assigned", PAPERCLIP_NATIVE_MCP_URL: "http://external.example/mcp", PAPERCLIP_NATIVE_MCP_TOKEN: "x".repeat(40) },
  ])("rejects invalid assigned connection bindings before runtime launch", async (environment) => {
    const fixture = await hostFixture();
    const openRuntime = vi.fn();
    await expect(AcpxRuntimeHost.open({ ...fixture.options, environment }, fixture.dependencies({ openRuntime }))).rejects.toThrow(/assigned native MCP/);
    expect(openRuntime).not.toHaveBeenCalled();
  });

  it("registers the assigned connection gateway alongside the Claude task bridge", async () => {
    const fixture = await hostFixture();
    let servers: AcpxRuntimePortOpenOptions["mcpServers"] = [];
    const host = await AcpxRuntimeHost.open({
      ...fixture.options,
      agent: "claude", model: "claude-sonnet-5",
      environment: { ...fixture.options.environment,
        PAPERCLIP_NATIVE_MCP_NAME: "paperclip-assigned",
        PAPERCLIP_NATIVE_MCP_URL: "http://127.0.0.1:3211/mcp/gateway",
        PAPERCLIP_NATIVE_MCP_TOKEN: "fixture-gateway-token-".repeat(3),
      },
      semanticTools: { tools: [], handler: async () => ({}) },
    }, fixture.dependencies({ openRuntime: async (options) => {
      servers = options.mcpServers;
      return runtimePort({ getStatus: async () => ({ models: { currentModelId: "claude-sonnet-5" } }) });
    } }));
    try {
      expect(servers.map(server => server.name)).toEqual(["paperclip", "paperclip-assigned"]);
      expect(servers[1]).toEqual({ name: "paperclip-assigned", url: "http://127.0.0.1:3211/mcp/gateway",
        bearerToken: "fixture-gateway-token-".repeat(3), runnerOwned: true });
    } finally { await host.close({ reason: "gateway test complete" }); }
  });

  it.each([
    ["approve-reads", ["mcp__paperclip__get_task_context"]],
    ["approve-paperclip", ["mcp__paperclip__create_task", "mcp__paperclip__get_task_context", "mcp__paperclip__reassign_task", "mcp__paperclip__write_document"]],
    ["deny-all", undefined],
  ] as const)("binds exact assigned Claude tools to %s before provider launch", async (permissionMode, allow) => {
    const fixture = await hostFixture();
    const dependencies = fixture.dependencies({
      openRuntime: async (options) => {
        const settings = JSON.parse(await readFile(
          join(options.launchEnvironment.CLAUDE_CONFIG_DIR!, "settings.json"),
          "utf8",
        ));
        expect(settings.permissions).toEqual(allow ? { allow } : undefined);
        expect(options.mcpServers).toMatchObject([
          { name: "paperclip", runnerOwned: true },
        ]);
        return runtimePort({
          getStatus: async () => ({ models: { currentModelId: "claude-sonnet-5" } }),
        });
      },
    });
    const host = await AcpxRuntimeHost.open({
      ...fixture.options,
      agent: "claude",
      model: "claude-sonnet-5",
      permissionMode,
      semanticTools: {
        tools: ["get_task_context", "write_document", "create_task", "reassign_task", "unknown_read"].map((name) => ({
          name,
          inputSchema: { type: "object" },
          // Supplied hints cannot grant write or unknown operations read access.
          annotations: { readOnlyHint: true, effect: "read" },
        })),
        handler: async () => ({}),
      },
    }, dependencies);
    await host.close({ reason: "read permission verified" });
  });

  it("loads assigned Claude skills before launch and refreshes them when reopening", async () => {
    const fixture = await hostFixture();
    const skillRoot = join(fixture.root, "assigned-source");
    await mkdir(join(skillRoot, "references"), { recursive: true });
    await writeFile(join(skillRoot, "SKILL.md"), "---\nname: assigned\ndescription: Read the reference.\n---\nRead references/answer.txt.");
    await writeFile(join(skillRoot, "references", "answer.txt"), "ASSIGNED_SKILL_MARKER");
    const digest = "0".repeat(64);
    const bundle = {
      schema: NATIVE_RUNTIME_ASSET_SCHEMA,
      digest,
      manifestDigest: digest,
      rootPath: skillRoot,
      fileCount: 2,
      totalBytes: 100,
    };
    const snapshot = {
      prompt: {
        revision: PAPERCLIP_EXECUTION_PROMPT_REVISION,
        text: PAPERCLIP_EXECUTION_PROMPT,
        digest: nativeRuntimePromptDigest(),
      },
      instructions: { entryPath: "AGENTS.md", bundle },
      skills: [{ key: "assigned", runtimeName: "assigned", versionId: "v1", bundle }],
      mcp: { assignmentSetId: "none", digest, bindingId: null },
    } satisfies Omit<NativeRuntimeContextSnapshot, "aggregateDigest">;
    const context = {
      ...snapshot,
      aggregateDigest: canonicalNativeRuntimeContextDigest(snapshot),
    };
    let skillsHome = "";
    const providerStartTurn = vi.fn(() => runtimeTurn());
    let assigned = true;
    let expectedReference = "ASSIGNED_SKILL_MARKER";
    // Prepare the real sandbox once. Each reopen still exercises the host's
    // real skill refresh, including changed references and removed assignments,
    // without repeating unrelated durable directory and file writes. Sandbox
    // preparation itself also has dedicated runtime-sandbox coverage.
    const dependencies = fixture.dependencies({
      reuseSandbox: true,
      openRuntime: async (options) => {
        skillsHome = join(options.launchEnvironment.CLAUDE_CONFIG_DIR!, "skills");
        expect(await readdir(skillsHome)).toEqual(assigned ? ["assigned"] : []);
        if (assigned) {
          const reference = join(skillsHome, "assigned", "references", "answer.txt");
          expect(await readFile(reference, "utf8")).toBe(expectedReference);
          expect(await readFile(join(skillsHome, "assigned", "SKILL.md"), "utf8"))
            .toBe(await readFile(join(skillRoot, "SKILL.md"), "utf8"));
          expect((await stat(reference)).mode & 0o222).toBe(0);
        }
        return runtimePort({
          startTurn: providerStartTurn,
          getStatus: async () => ({ models: { currentModelId: "claude-sonnet-5" } }),
        });
      },
    });
    const options = {
      ...fixture.options,
      agent: "claude" as const,
      model: "claude-sonnet-5",
      permissionMode: "deny-all" as const,
    };
    try {
      // Fresh open and a provider reopen both have the complete bundle.
      for (let index = 0; index < 2; index += 1) {
        const host = await AcpxRuntimeHost.open(
          { ...options, runtimeContext: context },
          dependencies,
        );
        let message = JSON.stringify({
          schema: "paperclip.native-model-envelope.v2",
          task: { description: "Use /assigned", prompt: "A new direct user request" },
          interactionResponses: index ? [{ response: { status: "accepted" } }] : [],
        });
        if (index === 1) {
          // The provider command is internal overhead, not part of the caller's
          // 1 MiB allowance. Keep the exact envelope even at that boundary.
          message += " ".repeat(1024 * 1024 - Buffer.byteLength(message));
          expect(() => host.startTurn({ text: `${message} `, requestId: "oversized" }))
            .toThrow("turn text exceeds its bounded size");
        }
        host.startTurn({ text: message, requestId: `skill-turn-${index}` });
        expect(providerStartTurn).toHaveBeenLastCalledWith({
          text: `/assigned ${message}`, requestId: `skill-turn-${index}`,
        });
        await host.close({ reason: "reopen test" });
        // A changed source must replace the prior materialized revision on resume.
        expectedReference = "UPDATED_ASSIGNED_SKILL_MARKER";
        await writeFile(join(skillRoot, "references", "answer.txt"), expectedReference);
        await writeFile(join(skillRoot, "SKILL.md"), "---\nname: assigned\ndescription: Updated instructions.\n---\nRead references/answer.txt before responding.");
      }
      // The prepared native envelope v3 carries the selected skill explicitly;
      // its task object intentionally has no internal description field. Keep
      // this boundary covered across a fresh open and a provider reopen.
      for (let index = 0; index < 2; index += 1) {
        const host = await AcpxRuntimeHost.open(
          { ...options, runtimeContext: context },
          dependencies,
        );
        const message = JSON.stringify({
          schema: "paperclip.native-model-envelope.v3",
          requestedSkills: ["assigned"],
          task: {
            identifier: "PAP-1",
            title: "Assigned task",
            prompt: "A prepared direct user request",
            workMode: "standard",
          },
          interactionResponses: index ? [{ response: { status: "accepted" } }] : [],
        });
        host.startTurn({ text: message, requestId: `prepared-skill-turn-${index}` });
        expect(providerStartTurn).toHaveBeenLastCalledWith({
          text: `/assigned ${message}`,
          requestId: `prepared-skill-turn-${index}`,
        });
        await host.close({ reason: "prepared envelope reopen test" });
      }
      // The same agent's next ordinary task must not inherit the command.
      const ordinary = await AcpxRuntimeHost.open(
        { ...options, runtimeContext: context }, dependencies,
      );
      const ordinaryMessage = JSON.stringify({
        schema: "paperclip.native-model-envelope.v2",
        task: { description: "An ordinary task", prompt: "Mention /assigned in a note" },
      });
      ordinary.startTurn({ text: ordinaryMessage, requestId: "ordinary-task" });
      expect(providerStartTurn).toHaveBeenLastCalledWith({
        text: ordinaryMessage, requestId: "ordinary-task",
      });
      await ordinary.close({ reason: "ordinary task verified" });
      const ordinaryPrepared = await AcpxRuntimeHost.open(
        { ...options, runtimeContext: context }, dependencies,
      );
      const ordinaryPreparedMessage = JSON.stringify({
        schema: "paperclip.native-model-envelope.v3",
        requestedSkills: [],
        task: {
          identifier: "PAP-2",
          title: "An ordinary task",
          prompt: "Mention /assigned in a note",
          workMode: "standard",
        },
      });
      ordinaryPrepared.startTurn({ text: ordinaryPreparedMessage, requestId: "ordinary-prepared-task" });
      expect(providerStartTurn).toHaveBeenLastCalledWith({
        text: ordinaryPreparedMessage,
        requestId: "ordinary-prepared-task",
      });
      await ordinaryPrepared.close({ reason: "ordinary prepared task verified" });
      // No stale assignment survives a later launch without runtime context.
      assigned = false;
      const host = await AcpxRuntimeHost.open(options, dependencies);
      await host.close({ reason: "test complete" });
    } finally {
      if (skillsHome) await releaseMaterializedNativeRuntimeSkills(skillsHome);
    }
  });

  it("rejects a pre-aborted admission before acquiring provider resources", async () => {
    const fixture = await hostFixture();
    const controller = trackedAdmissionController();
    const cancellation = new Error("admission cancelled before start");
    controller.abort(cancellation);
    const openRuntime = vi.fn(async () => runtimePort());
    const verifyInstallation = vi.fn(
      fixture.dependencies({ openRuntime }).verifyInstallation!,
    );

    await expect(
      AcpxRuntimeHost.open(
        {
          ...fixture.options,
          agent: "claude",
          model: "claude-sonnet-5",
          permissionMode: "deny-all",
          signal: controller.signal,
        },
        {
          ...fixture.dependencies({ openRuntime }),
          verifyInstallation,
        },
      ),
    ).rejects.toBe(cancellation);

    expect(verifyInstallation).not.toHaveBeenCalled();
    expect(openRuntime).not.toHaveBeenCalled();
    expect(fixture.commandClose).not.toHaveBeenCalled();
  });

  it("retains aborted sandbox preparation until its filesystem work settles", async () => {
    const fixture = await hostFixture();
    const controller = trackedAdmissionController();
    const cancellation = new Error("sandbox admission cancelled");
    const sandboxStarted = deferred<void>();
    const finishSandbox = deferred<void>();
    const retainedCleanups: Promise<void>[] = [];
    const stageCredential = vi.fn(async () => {
      throw new Error("credential staging must not start");
    });
    const openRuntime = vi.fn(async () => runtimePort());
    const dependencies = fixture.dependencies({ openRuntime });
    dependencies.stageCredential = stageCredential;
    dependencies.prepareSandbox = async (input) => {
      sandboxStarted.resolve(undefined);
      await finishSandbox.promise;
      return await prepareAcpxRuntimeSandbox(input);
    };
    dependencies.retainAdmissionCleanup = (cleanup) => {
      retainedCleanups.push(cleanup);
      trackAdmissionCleanup(cleanup);
    };
    const opening = trackAdmissionOpening(
      AcpxRuntimeHost.open(
        {
          ...fixture.options,
          agent: "codex",
          model: "gpt-5.6-sol",
          permissionMode: "deny-all",
          signal: controller.signal,
        },
        dependencies,
      ),
    );
    await sandboxStarted.promise;

    controller.abort(cancellation);
    await expect(opening).rejects.toBe(cancellation);
    expect(retainedCleanups).toHaveLength(2);
    let sandboxCleanupSettled = false;
    void retainedCleanups[0]!.then(
      () => {
        sandboxCleanupSettled = true;
      },
      () => {
        sandboxCleanupSettled = true;
      },
    );
    await Promise.resolve();
    expect(sandboxCleanupSettled).toBe(false);

    finishSandbox.resolve(undefined);
    await expect(retainedCleanups[0]).resolves.toBeUndefined();
    expect(sandboxCleanupSettled).toBe(true);
    expect(stageCredential).not.toHaveBeenCalled();
    expect(openRuntime).not.toHaveBeenCalled();
    expect(fixture.commandClose).not.toHaveBeenCalled();
  });

  it("settles retained admission work when aborted sandbox preparation rejects", async () => {
    const fixture = await hostFixture();
    const controller = trackedAdmissionController();
    const cancellation = new Error("sandbox admission cancelled");
    const sandboxStarted = deferred<void>();
    const finishSandbox = deferred<void>();
    const retainedCleanups: Promise<void>[] = [];
    const stageCredential = vi.fn(async () => {
      throw new Error("credential staging must not start");
    });
    const openRuntime = vi.fn(async () => runtimePort());
    const dependencies = fixture.dependencies({ openRuntime });
    dependencies.stageCredential = stageCredential;
    dependencies.prepareSandbox = async (input) => {
      sandboxStarted.resolve(undefined);
      await finishSandbox.promise;
      return await prepareAcpxRuntimeSandbox(input);
    };
    dependencies.retainAdmissionCleanup = (cleanup) => {
      retainedCleanups.push(cleanup);
      trackAdmissionCleanup(cleanup);
    };
    const opening = trackAdmissionOpening(
      AcpxRuntimeHost.open(
        {
          ...fixture.options,
          agent: "codex",
          model: "gpt-5.6-sol",
          permissionMode: "deny-all",
          signal: controller.signal,
        },
        dependencies,
      ),
    );
    await sandboxStarted.promise;

    controller.abort(cancellation);
    await expect(opening).rejects.toBe(cancellation);
    expect(retainedCleanups).toHaveLength(2);

    finishSandbox.reject(new Error("sandbox preparation failed after abort"));
    await expect(retainedCleanups[0]).resolves.toBeUndefined();
    expect(stageCredential).not.toHaveBeenCalled();
    expect(openRuntime).not.toHaveBeenCalled();
    expect(fixture.commandClose).not.toHaveBeenCalled();
  });

  it("scrubs credentials when abort wins before the adapter body starts", async () => {
    const fixture = await hostFixture();
    const controller = trackedAdmissionController();
    const cancellation = new Error("runtime admission cancelled before entry");
    const createRuntime = vi.fn();
    let credentialHome = "";
    const openRuntime = vi.fn((options: AcpxRuntimePortOpenOptions) => {
      credentialHome = options.launchEnvironment.CODEX_HOME!;
      // The host has scheduled its openRuntime callback and transferred the
      // staged credential to that pending admission. Abort before entering the
      // adapter so its pre-entry path must publish a completed cleanup proof.
      controller.abort(cancellation);
      return openCodexAcpxRuntime(options, { createRuntime });
    });

    await expect(
      AcpxRuntimeHost.open(
        {
          ...fixture.options,
          agent: "codex",
          model: "gpt-5.6-sol",
          permissionMode: "deny-all",
          environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}" },
          signal: controller.signal,
        },
        fixture.dependencies({ openRuntime }),
      ),
    ).rejects.toBe(cancellation);

    expect(openRuntime).toHaveBeenCalledOnce();
    expect(createRuntime).not.toHaveBeenCalled();
    expect(fixture.commandClose).toHaveBeenCalledOnce();
    const authPath = join(credentialHome, "auth.json");
    const contender = await waitForAcpxOperation(() =>
      stageManagedCodexCredential({
        agentHomeDirectory: credentialHome,
        environment: {
          PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"contender"}',
        },
      }),
    );
    await contender.close();
    await expect(readFile(authPath)).rejects.toMatchObject({ code: "ENOENT" });

    const retryRuntime = runtimePort();
    const retryHost = await AcpxRuntimeHost.open(
      {
        ...fixture.options,
        agent: "codex",
        model: "gpt-5.6-sol",
        permissionMode: "deny-all",
        environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}" },
      },
      fixture.dependencies({ openRuntime: async () => retryRuntime }),
    );
    await retryHost.close({ reason: "retry admission complete" });
    expect(retryRuntime.close).toHaveBeenCalledOnce();
  }, ACPX_LONG_WAIT_TEST_TIMEOUT_MS);

  it("composes admission, isolation, model verification, and cleanup", async () => {
    const fixture = await hostFixture();
    let capturedEnvironment: Readonly<NodeJS.ProcessEnv> = {};
    const runtime = runtimePort({
      onClose: vi.fn(async () => undefined),
    });
    const dependencies = fixture.dependencies({
      openRuntime: async (options) => {
        capturedEnvironment = options.launchEnvironment;
        await writeFile(
          join(options.launchEnvironment.CODEX_HOME!, "auth.json"),
          '{"provider_generated":true}',
        );
        return runtime;
      },
    });

    const host = await AcpxRuntimeHost.open(
      {
        ...fixture.options,
        agent: "codex",
        model: "gpt-5.6-sol",
        permissionMode: "approve-reads",
        environment: {
          PATH: process.env.PATH,
          OPENAI_API_KEY: "launch-secret",
          HTTPS_PROXY: "https://proxy-user:proxy-secret@example.test",
        },
        systemInstructions: "Use the supplied runtime context.",
      },
      dependencies,
    );
    expect(host.identity()).toMatchObject({
      schema: "paperclip.runner.acpx-identity.v2",
      acpxRecordId: "record-1",
      requestedModel: "gpt-5.6-sol",
      permissionMode: "approve-reads",
    });
    const lifetimeFenceCandidates =
      host.identity().providerLifetimeFenceCandidates;
    expect(lifetimeFenceCandidates).toHaveLength(3);
    expect(new Set(lifetimeFenceCandidates).size).toBe(3);
    expect(
      lifetimeFenceCandidates.every((port) => port >= 49_152 && port <= 65_535),
    ).toBe(true);
    expect(capturedEnvironment.OPENAI_API_KEY).toBe("launch-secret");
    expect(host.persistedEnvironment().OPENAI_API_KEY).toBeUndefined();
    expect(host.persistedEnvironment().HTTPS_PROXY).toBeUndefined();
    const authPath = join(host.runtimeRoot(), "codex-home", "auth.json");
    await expect(readFile(authPath, "utf8")).resolves.toContain(
      "provider_generated",
    );

    await host.close({ reason: "test complete" });
    await expect(readFile(authPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(fixture.commandClose).toHaveBeenCalledOnce();
  });

  it("revalidates a pinned workspace at the runtime-open boundary", async () => {
    const fixture = await hostFixture();
    const openRuntime = vi.fn(async () => runtimePort());
    const workspaceSubstituted = new Error("recovered workspace substituted");
    let assertions = 0;
    const assertWorkspaceHeld = vi.fn(() => {
      assertions += 1;
      if (assertions === 2) throw workspaceSubstituted;
    });

    await expect(
      AcpxRuntimeHost.open(
        {
          ...fixture.options,
          agent: "codex",
          model: "gpt-5.6-sol",
          permissionMode: "approve-reads",
          environment: {
            PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}",
          },
          assertWorkspaceHeld,
        },
        fixture.dependencies({ openRuntime }),
      ),
    ).rejects.toBe(workspaceSubstituted);

    expect(assertWorkspaceHeld).toHaveBeenCalledTimes(2);
    expect(openRuntime).not.toHaveBeenCalled();
    expect(fixture.commandClose).toHaveBeenCalledOnce();
  });

  it("owns an authenticated semantic bridge without persisting its secret", async () => {
    const fixture = await hostFixture();
    const handler = vi.fn(async ({ tool }) => ({ tool, ok: true }));
    let bridge:
      | { url: string; bearerToken: string; name: string; runnerOwned: boolean }
      | undefined;
    const host = await AcpxRuntimeHost.open(
      {
        ...fixture.options,
        agent: "codex",
        model: "gpt-5.6-sol",
        permissionMode: "deny-all",
        environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}" },
        semanticTools: {
          tools: [
            {
              name: "documents.read",
              description: "Read one document.",
              inputSchema: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
                additionalProperties: false,
              },
            },
          ],
          handler,
        },
      },
      fixture.dependencies({
        openRuntime: async (options) => {
          bridge = options.mcpServers[0];
          return runtimePort();
        },
      }),
    );

    expect(bridge).toMatchObject({
      name: "paperclip",
      runnerOwned: true,
    });
    expect(new URL(bridge!.url).hostname).toBe("127.0.0.1");
    const response = await fetch(bridge!.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bridge!.bearerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "call-1",
        method: "tools/call",
        params: { name: "documents.read", arguments: { id: "doc-1" } },
      }),
    });
    expect(await response.json()).toMatchObject({
      result: { content: [{ text: '{"tool":"documents.read","ok":true}' }] },
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(JSON.stringify(host.persistedEnvironment())).not.toContain(
      bridge!.bearerToken,
    );

    await host.close({ reason: "complete" });
    await expect(
      fetch(bridge!.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${bridge!.bearerToken}` },
      }),
    ).rejects.toThrow();
  });

  it("rejects Pi before installation or runtime launch", async () => {
    const fixture = await hostFixture();
    const verifyInstallation = vi.fn();
    const openRuntime = vi.fn();
    await expect(
      AcpxRuntimeHost.open(
        {
          ...fixture.options,
          agent: "pi" as never,
          model: "openrouter/deepseek/deepseek-v4-flash-0731",
          permissionMode: "approve-reads",
        },
        {
          verifyInstallation,
          openRuntime,
          reportRetainedCleanupFailure: vi.fn(),
        },
      ),
    ).rejects.toThrow("descriptor-confined verified launch");
    expect(verifyInstallation).not.toHaveBeenCalled();
    expect(openRuntime).not.toHaveBeenCalled();
  });

  it("selects and verifies Claude's qualified reported model", async () => {
    const fixture = await hostFixture();
    let selected = false;
    const setModel = vi.fn(async (model: string) => {
      expect(model).toBe("claude-sonnet-5");
      selected = true;
    });
    const runtime = runtimePort({
      getStatus: async () => ({
        models: {
          currentModelId: selected ? "claude-sonnet-5" : "default",
          availableModelIds: ["default", "claude-sonnet-5"],
        },
      }),
      setModel,
    });
    const host = await AcpxRuntimeHost.open(
      {
        ...fixture.options,
        agent: "claude",
        model: "claude-sonnet-5",
        permissionMode: "deny-all",
      },
      fixture.dependencies({ openRuntime: async () => runtime }),
    );

    expect(setModel).toHaveBeenCalledOnce();
    expect(host.identity().effectiveModel).toBe("claude-sonnet-5");
    await host.close({ reason: "verified" });
  });

  it("rejects recovery drift before opening the provider", async () => {
    const fixture = await hostFixture();
    const openRuntime = vi.fn(async () => runtimePort());

    await expect(
      AcpxRuntimeHost.open(
        {
          ...fixture.options,
          agent: "claude",
          model: "claude-sonnet-5",
          permissionMode: "approve-reads",
          expectedIdentity: {
            kind: "acpx",
            normalizedSessionId: fixture.options.normalizedSessionId,
            acpxRecordId: "record-1",
            backendSessionId: "backend-1",
            agentSessionId: "agent-1",
            profileDigest: resolveQualifiedAcpxProfile(
              "claude",
              "claude-sonnet-5",
            ).commandDigest,
            workspaceDigest: `sha256:${"0".repeat(64)}`,
            requestedModel: "claude-sonnet-5",
            effectiveModel: "claude-sonnet-5",
            permissionMode: "approve-reads",
            providerLifetimeFenceCandidates: [60_001, 60_002, 60_003],
          },
        },
        fixture.dependencies({ openRuntime }),
      ),
    ).rejects.toThrow(/immutable session configuration/);
    expect(openRuntime).not.toHaveBeenCalled();
  });

  it("rejects an injected installation that does not match the profile", async () => {
    const fixture = await hostFixture();
    const openRuntime = vi.fn(async () => runtimePort());
    const dependencies = fixture.dependencies({ openRuntime });
    dependencies.verifyInstallation = async () => ({
      commandDigest: `sha256:${"f".repeat(64)}`,
      agentServerPackageJsonPath: join(fixture.root, "package.json"),
      agentRuntimePackageJsonPath: null,
      openCommand: async () => {
        throw new Error("mismatched installation must not open");
      },
    });

    await expect(
      AcpxRuntimeHost.open(
        {
          ...fixture.options,
          agent: "claude",
          model: "claude-sonnet-5",
          permissionMode: "approve-all",
        },
        dependencies,
      ),
    ).rejects.toThrow(/does not match its profile/);
    expect(openRuntime).not.toHaveBeenCalled();
  });

  it("cleans credentials and command leases when provider open fails", async () => {
    const fixture = await hostFixture();
    let authPath = "";
    await expect(
      AcpxRuntimeHost.open(
        {
          ...fixture.options,
          agent: "codex",
          model: "gpt-5.6-sol",
          permissionMode: "approve-all",
          environment: {
            PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET:
              '{"tokens":{"access_token":"canary"}}',
          },
        },
        fixture.dependencies({
          openRuntime: async (options) => {
            authPath = join(options.launchEnvironment.CODEX_HOME!, "auth.json");
            throw new Error("provider failed");
          },
        }),
      ),
    ).rejects.toThrow("provider failed");
    await expect(readFile(authPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fixture.commandClose).toHaveBeenCalledOnce();
  });

  it("retains failed admission cleanup until provider shutdown permits credential scrub", async () => {
    const fixture = await hostFixture();
    let authPath = "";
    let credentialHome = "";
    let resolveRetryClose!: () => void;
    const retryClose = new Promise<void>((resolve) => {
      resolveRetryClose = resolve;
    });
    const runtime = runtimePort({
      getStatus: async () => ({
        models: {
          currentModelId: "wrong-model",
          availableModelIds: ["wrong-model"],
        },
      }),
      onClose: vi
        .fn()
        .mockRejectedValueOnce(new Error("first admission cleanup failed"))
        .mockImplementationOnce(() => retryClose),
    });
    await expect(
      AcpxRuntimeHost.open(
        {
          ...fixture.options,
          agent: "codex",
          model: "gpt-5.6-sol",
          permissionMode: "approve-all",
          environment: {
            PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET:
              '{"owner":"failed-admission"}',
          },
        },
        fixture.dependencies({
          openRuntime: async (options) => {
            credentialHome = options.launchEnvironment.CODEX_HOME!;
            authPath = join(credentialHome, "auth.json");
            return runtime;
          },
        }),
      ),
    ).rejects.toThrow(/initialization and cleanup failed/);

    await waitForAcpxOperation(() => expect(runtime.close).toHaveBeenCalledTimes(2));
    await expect(readFile(authPath, "utf8")).resolves.toContain(
      "failed-admission",
    );
    await expect(
      stageManagedCodexCredential({
        agentHomeDirectory: credentialHome,
        environment: {
          PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"contender"}',
        },
      }),
    ).rejects.toThrow("already has an active lease");

    resolveRetryClose();
    await waitForAcpxOperation(async () => {
      await expect(readFile(authPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
    // File removal precedes kernel lease release. Wait for the lease itself so
    // this assertion cannot race between those two ordered cleanup steps.
    const contender = await waitForAcpxOperation(() =>
      stageManagedCodexCredential({
        agentHomeDirectory: credentialHome,
        environment: {
          PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"contender"}',
        },
      }),
    );
    await contender.close();
  }, ACPX_LONG_WAIT_TEST_TIMEOUT_MS);

  it("bounds post-handshake model verification and cleans the runtime", async () => {
    const fixture = await hostFixture();
    const runtime = runtimePort({
      getStatus: () => new Promise<never>(() => undefined),
    });
    const dependencies = fixture.dependencies({
      openRuntime: async () => runtime,
    });
    dependencies.admissionVerificationTimeoutMs = 1;

    await expect(
      AcpxRuntimeHost.open(
        {
          ...fixture.options,
          agent: "codex",
          model: "gpt-5.6-sol",
          permissionMode: "approve-all",
          environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}" },
        },
        dependencies,
      ),
    ).rejects.toThrow("admission verification exceeded its deadline");
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(fixture.commandClose).toHaveBeenCalledOnce();
  });

  it("bounds post-handshake cleanup while retaining its exact owner", async () => {
    const fixture = await hostFixture();
    let finishRuntimeClose!: () => void;
    const runtimeClose = new Promise<void>((resolve) => {
      finishRuntimeClose = resolve;
    });
    const runtime = runtimePort({
      getStatus: () => new Promise<never>(() => undefined),
      onClose: () => runtimeClose,
    });
    const dependencies = fixture.dependencies({
      openRuntime: async () => runtime,
    });
    let retainedAdmissionCleanup: Promise<void> | null = null;
    dependencies.retainAdmissionCleanup = (cleanup) => {
      retainedAdmissionCleanup = cleanup;
    };
    dependencies.admissionVerificationTimeoutMs = 1;
    dependencies.admissionCleanupTimeoutMs = 1;

    await expect(
      AcpxRuntimeHost.open(
        {
          ...fixture.options,
          agent: "codex",
          model: "gpt-5.6-sol",
          permissionMode: "approve-all",
          environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}" },
        },
        dependencies,
      ),
    ).rejects.toThrow("initialization and cleanup failed");
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(fixture.commandClose).toHaveBeenCalledOnce();
    expect(retainedAdmissionCleanup).not.toBeNull();
    let cleanupSettled = false;
    void retainedAdmissionCleanup!.finally(() => {
      cleanupSettled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    expect(cleanupSettled).toBe(false);

    finishRuntimeClose();
    await retainedAdmissionCleanup;
    expect(cleanupSettled).toBe(true);
  });

  it("retains credential ownership when runtime shutdown fails until retry succeeds", async () => {
    const fixture = await hostFixture();
    let failClose = true;
    const runtime = runtimePort({
      onClose: vi.fn(async () => {
        if (failClose) throw new Error("runtime close failed");
      }),
    });
    const host = await AcpxRuntimeHost.open(
      {
        ...fixture.options,
        agent: "codex",
        model: "gpt-5.6-sol",
        permissionMode: "approve-all",
        environment: {
          PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}",
        },
      },
      fixture.dependencies({ openRuntime: async () => runtime }),
    );
    const authPath = join(host.runtimeRoot(), "codex-home", "auth.json");

    await expect(host.close({ reason: "first close" })).rejects.toThrow(
      /cleanup failed/,
    );
    await expect(readFile(authPath, "utf8")).resolves.toBe("{}");
    await expect(
      stageManagedCodexCredential({
        agentHomeDirectory: join(host.runtimeRoot(), "codex-home"),
        environment: {
          PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"contender"}',
        },
      }),
    ).rejects.toThrow("already has an active lease");
    expect(fixture.commandClose).toHaveBeenCalledOnce();
    failClose = false;
    await expect(
      host.close({ reason: "retry close" }),
    ).resolves.toBeUndefined();
    await expect(readFile(authPath)).rejects.toMatchObject({ code: "ENOENT" });
    const contender = await waitForAcpxOperation(() =>
      stageManagedCodexCredential({
        agentHomeDirectory: join(host.runtimeRoot(), "codex-home"),
        environment: {
          PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"contender"}',
        },
      }),
    );
    await contender.close();
  }, ACPX_LONG_WAIT_TEST_TIMEOUT_MS);

  it("scrubs credentials only after the exact pending runtime close resolves", async () => {
    const fixture = await hostFixture();
    let resolveRuntimeClose!: () => void;
    const runtimeClose = new Promise<void>((resolve) => {
      resolveRuntimeClose = resolve;
    });
    const runtime = runtimePort({
      onClose: vi.fn(() => runtimeClose),
    });
    const host = await AcpxRuntimeHost.open(
      {
        ...fixture.options,
        agent: "codex",
        model: "gpt-5.6-sol",
        permissionMode: "approve-all",
        environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}" },
      },
      fixture.dependencies({ openRuntime: async () => runtime }),
    );
    const credentialHome = join(host.runtimeRoot(), "codex-home");
    const authPath = join(credentialHome, "auth.json");

    const first = host.close({ reason: "runtime close pending" });
    await waitForAcpxOperation(() => expect(runtime.close).toHaveBeenCalledOnce());
    await waitForAcpxOperation(() => expect(fixture.commandClose).toHaveBeenCalledOnce());
    const second = host.close({ reason: "same exact close" });
    await expect(readFile(authPath, "utf8")).resolves.toBe("{}");
    await expect(
      stageManagedCodexCredential({
        agentHomeDirectory: credentialHome,
        environment: {
          PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"contender"}',
        },
      }),
    ).rejects.toThrow("already has an active lease");
    expect(runtime.close).toHaveBeenCalledOnce();

    resolveRuntimeClose();
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    await expect(readFile(authPath)).rejects.toMatchObject({ code: "ENOENT" });
    const contender = await waitForAcpxOperation(() =>
      stageManagedCodexCredential({
        agentHomeDirectory: credentialHome,
        environment: {
          PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"contender"}',
        },
      }),
    );
    await contender.close();
  }, ACPX_LONG_WAIT_TEST_TIMEOUT_MS);

  it("retains the exact pending cleanup while independent resources close", async () => {
    const fixture = await hostFixture();
    const firstClose = new Promise<void>(() => undefined);
    const runtime = runtimePort({
      onClose: vi
        .fn()
        .mockImplementationOnce(() => firstClose)
        .mockResolvedValueOnce(undefined),
    });
    const host = await AcpxRuntimeHost.open(
      {
        ...fixture.options,
        agent: "codex",
        model: "gpt-5.6-sol",
        permissionMode: "approve-all",
        environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}" },
      },
      fixture.dependencies({ openRuntime: async () => runtime }),
    );

    const first = host.close({ reason: "first close stalls" });
    await waitForAcpxOperation(() => expect(runtime.close).toHaveBeenCalledOnce());
    const second = host.close({ reason: "same pending owner" });
    let settled = false;
    void Promise.all([first, second]).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(fixture.commandClose).toHaveBeenCalledOnce();
  }, ACPX_LONG_WAIT_TEST_TIMEOUT_MS);

  it("retries only after the exact close outcome settles with failure", async () => {
    const fixture = await hostFixture();
    const runtime = runtimePort({
      onClose: vi
        .fn()
        .mockRejectedValueOnce(new Error("runtime close failed"))
        .mockResolvedValueOnce(undefined),
    });
    const host = await AcpxRuntimeHost.open(
      {
        ...fixture.options,
        agent: "codex",
        model: "gpt-5.6-sol",
        permissionMode: "approve-all",
        environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}" },
      },
      fixture.dependencies({ openRuntime: async () => runtime }),
    );

    await expect(host.close({ reason: "first close" })).rejects.toThrow(
      /cleanup failed/,
    );
    await expect(
      host.close({ reason: "fresh attempt" }),
    ).resolves.toBeUndefined();
    await expect(
      host.close({ reason: "ownership released" }),
    ).resolves.toBeUndefined();
    expect(runtime.close).toHaveBeenCalledTimes(2);
  });

  it("admits one bounded turn and cancels it before shutdown", async () => {
    const fixture = await hostFixture();
    const turn = runtimeTurn();
    const startTurn = vi.fn(() => turn);
    const onElicitation = vi.fn();
    const runtime = runtimePort({ startTurn });
    const host = await AcpxRuntimeHost.open(
      {
        ...fixture.options,
        agent: "codex",
        model: "gpt-5.6-sol",
        permissionMode: "approve-reads",
        environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}" },
      },
      fixture.dependencies({ openRuntime: async () => runtime }),
    );

    expect(
      host.startTurn({
        text: "Complete the task.",
        requestId: "turn-1",
        onElicitation,
      }),
    ).toBe(turn);
    expect(startTurn).toHaveBeenCalledWith({
      text: "Complete the task.",
      requestId: "turn-1",
      onElicitation,
    });
    expect(() =>
      host.startTurn({ text: "Concurrent", requestId: "turn-2" }),
    ).toThrow("already has an active turn");

    await host.interruptActiveTurn("user interrupt");
    expect(turn.cancel).toHaveBeenCalledWith({ reason: "user interrupt" });

    await host.close({ reason: "shutdown" });
    expect(turn.cancel).toHaveBeenCalledWith({ reason: "shutdown" });
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(() => host.startTurn({ text: "Late", requestId: "turn-3" })).toThrow(
      "is closing",
    );
  });

  it("rejects oversized turn inputs before calling the runtime", async () => {
    const fixture = await hostFixture();
    const runtime = runtimePort();
    const host = await AcpxRuntimeHost.open(
      {
        ...fixture.options,
        agent: "codex",
        model: "gpt-5.6-sol",
        permissionMode: "approve-reads",
        environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}" },
      },
      fixture.dependencies({ openRuntime: async () => runtime }),
    );

    expect(() => host.startTurn({ text: "ok", requestId: " " })).toThrow(
      "request id",
    );
    expect(() =>
      host.startTurn({ text: "x".repeat(1024 * 1024 + 1), requestId: "turn" }),
    ).toThrow("turn text");
    expect(runtime.startTurn).not.toHaveBeenCalled();
    await host.close({ reason: "complete" });
  });

  it("cleans runtime resources after a turn cancellation timeout", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await hostFixture();
      const turn = runtimeTurn();
      turn.cancel.mockImplementation(() => new Promise(() => undefined));
      const runtime = runtimePort({ startTurn: () => turn });
      const host = await AcpxRuntimeHost.open(
        {
          ...fixture.options,
          agent: "codex",
          model: "gpt-5.6-sol",
          permissionMode: "approve-reads",
          environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}" },
        },
        fixture.dependencies({ openRuntime: async () => runtime }),
      );
      host.startTurn({ text: "Complete the task.", requestId: "turn-1" });

      const closing = host.close({ reason: "shutdown" });
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(closing).rejects.toThrow(/cleanup failed/);
      expect(turn.cancel).toHaveBeenCalledOnce();
      expect(runtime.close).toHaveBeenCalledOnce();
      expect(fixture.commandClose).toHaveBeenCalledOnce();
      await expect(
        host.close({ reason: "observe completed cleanup" }),
      ).resolves.toBeUndefined();
      expect(turn.cancel).toHaveBeenCalledOnce();
      expect(runtime.close).toHaveBeenCalledOnce();
      expect(fixture.commandClose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains the cancellation handle while runtime cleanup remains retryable", async () => {
    const fixture = await hostFixture();
    const turn = runtimeTurn();
    let failRuntimeClose = true;
    const runtime = runtimePort({
      startTurn: () => turn,
      onClose: async () => {
        if (failRuntimeClose) throw new Error("runtime cleanup failed");
      },
    });
    const host = await AcpxRuntimeHost.open(
      {
        ...fixture.options,
        agent: "codex",
        model: "gpt-5.6-sol",
        permissionMode: "approve-reads",
        environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}" },
      },
      fixture.dependencies({ openRuntime: async () => runtime }),
    );
    host.startTurn({ text: "Complete the task.", requestId: "turn-1" });
    const credentialHome = join(host.runtimeRoot(), "codex-home");
    const authPath = join(credentialHome, "auth.json");

    await expect(host.close({ reason: "first shutdown" })).rejects.toThrow(
      /cleanup failed/,
    );
    expect(turn.cancel).toHaveBeenCalledOnce();
    await expect(readFile(authPath, "utf8")).resolves.toBe("{}");
    await expect(
      stageManagedCodexCredential({
        agentHomeDirectory: credentialHome,
        environment: {
          PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"contender"}',
        },
      }),
    ).rejects.toThrow("already has an active lease");

    failRuntimeClose = false;
    await expect(
      host.close({ reason: "retry shutdown" }),
    ).resolves.toBeUndefined();
    expect(turn.cancel).toHaveBeenCalledTimes(2);
    expect(runtime.close).toHaveBeenCalledTimes(2);
    await expect(readFile(authPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a settled turn when shutdown cleanup must be retried", async () => {
    const fixture = await hostFixture();
    let settleTurn!: (value: { stopReason: string }) => void;
    const turn = {
      ...runtimeTurn(),
      result: new Promise<{ stopReason: string }>((resolve) => {
        settleTurn = resolve;
      }),
    };
    let failRuntimeClose = true;
    const runtime = runtimePort({
      startTurn: () => turn,
      onClose: async () => {
        if (failRuntimeClose) throw new Error("runtime cleanup failed");
      },
    });
    const host = await AcpxRuntimeHost.open(
      {
        ...fixture.options,
        agent: "codex",
        model: "gpt-5.6-sol",
        permissionMode: "approve-reads",
        environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}" },
      },
      fixture.dependencies({ openRuntime: async () => runtime }),
    );
    host.startTurn({ text: "Complete the task.", requestId: "turn-1" });

    const firstClose = host.close({ reason: "first shutdown" });
    settleTurn({ stopReason: "end_turn" });
    await expect(firstClose).rejects.toThrow(/cleanup failed/);
    expect(turn.cancel).toHaveBeenCalledOnce();

    failRuntimeClose = false;
    await expect(
      host.close({ reason: "retry shutdown" }),
    ).resolves.toBeUndefined();
    expect(turn.cancel).toHaveBeenCalledTimes(2);
    expect(runtime.close).toHaveBeenCalledTimes(2);
  });

  it("closes a command lease that resolves after admission is aborted", async () => {
    const fixture = await hostFixture();
    const commandAdmission = deferred<VerifiedAcpxCommandLease>();
    const commandAdmissionStarted = deferred<void>();
    const lateCommandClose = vi.fn(async () => undefined);
    const openCommand = vi.fn(() => {
      commandAdmissionStarted.resolve(undefined);
      return commandAdmission.promise;
    });
    const openRuntime = vi.fn(async () => runtimePort());
    const controller = trackedAdmissionController();
    const cancellation = new Error("command admission cancelled");
    const profile = resolveQualifiedAcpxProfile("claude", "claude-sonnet-5");
    const opening = trackAdmissionOpening(
      AcpxRuntimeHost.open(
        {
          ...fixture.options,
          agent: "claude",
          model: "claude-sonnet-5",
          permissionMode: "deny-all",
          signal: controller.signal,
        },
        {
          verifyInstallation: async () => ({
            commandDigest: profile.commandDigest,
            agentServerPackageJsonPath: join(fixture.root, "package.json"),
            agentRuntimePackageJsonPath: null,
            openCommand,
          }),
          // This test builds its own dependency object instead of
          // `fixture.dependencies()`, so it must record the skills home
          // itself. Command admission starts after the sandbox exists and
          // Claude's skills are already materialized and sealed, and abort
          // can land right there — before this test's own cleanup runs.
          prepareSandbox: async (sandboxInput) => {
            const sandbox = await prepareAcpxRuntimeSandbox(sandboxInput);
            materializedSkillsHomes.push(join(sandbox.agentHomeDirectory, "skills"));
            return sandbox;
          },
          openRuntime,
          retainAdmissionCleanup: trackAdmissionCleanup,
          reportRetainedCleanupFailure: vi.fn(),
        },
      ),
    );
    await commandAdmissionStarted.promise;

    controller.abort(cancellation);
    await expect(opening).rejects.toBe(cancellation);
    commandAdmission.resolve({
      spawn: () => {
        throw new Error("late command must not spawn");
      },
      close: lateCommandClose,
    });

    await waitForAcpxOperation(() => expect(lateCommandClose).toHaveBeenCalledOnce());
    expect(openRuntime).not.toHaveBeenCalled();
  }, ACPX_LONG_WAIT_TEST_TIMEOUT_MS);

  it("closes a credential lease that resolves after admission is aborted", async () => {
    const fixture = await hostFixture();
    const lateCredentialPath = join(fixture.root, "late-auth.json");
    await writeFile(lateCredentialPath, '{"access_token":"canary"}');
    const credentialAdmission = deferred<{
      path: string;
      mode: "inline_json";
      lifetimeFenceFds: readonly [number, number];
      lifetimeFenceCandidates: readonly [number, number, number];
      activateLifetimeOwner(pid: number): Promise<void>;
      close(): Promise<void>;
    }>();
    const cleanupFailure = new Error("transient credential cleanup failure");
    let cleanupAttempts = 0;
    const lateCredentialClose = vi.fn(async () => {
      cleanupAttempts += 1;
      if (cleanupAttempts === 1) throw cleanupFailure;
      await rm(lateCredentialPath);
    });
    const reportRetainedCleanupFailure = vi.fn();
    const credentialAdmissionStarted = deferred<void>();
    const stageCredential = vi.fn(() => {
      credentialAdmissionStarted.resolve(undefined);
      return credentialAdmission.promise;
    });
    const openRuntime = vi.fn(async () => runtimePort());
    const controller = trackedAdmissionController();
    const cancellation = new Error("credential admission cancelled");
    const opening = trackAdmissionOpening(
      AcpxRuntimeHost.open(
        {
          ...fixture.options,
          agent: "codex",
          model: "gpt-5.6-sol",
          permissionMode: "deny-all",
          signal: controller.signal,
        },
        {
          ...fixture.dependencies({
            openRuntime,
            reportRetainedCleanupFailure,
          }),
          stageCredential,
        },
      ),
    );
    await credentialAdmissionStarted.promise;

    controller.abort(cancellation);
    await expect(opening).rejects.toBe(cancellation);
    credentialAdmission.resolve({
      path: lateCredentialPath,
      mode: "inline_json",
      lifetimeFenceFds: [42, 43],
      lifetimeFenceCandidates: [60_001, 60_002, 60_003],
      activateLifetimeOwner: async () => undefined,
      close: lateCredentialClose,
    });

    await waitForAcpxOperation(() =>
      expect(lateCredentialClose).toHaveBeenCalledTimes(2),
    );
    await waitForAcpxOperation(async () =>
      expect(readFile(lateCredentialPath)).rejects.toMatchObject({
        code: "ENOENT",
      }),
    );
    expect(reportRetainedCleanupFailure).toHaveBeenCalledOnce();
    expect(reportRetainedCleanupFailure).toHaveBeenCalledWith({
      resource: "credential",
      attempt: 1,
      error: cleanupFailure,
    });
    expect(openRuntime).not.toHaveBeenCalled();
    expect(fixture.commandClose).not.toHaveBeenCalled();
  }, ACPX_LONG_WAIT_TEST_TIMEOUT_MS);

  it("retains managed credentials until an aborted late runtime is closed", async () => {
    const fixture = await hostFixture();
    const runtimeAdmission = deferred<AcpxRuntimePort>();
    const runtimeAdmissionStarted = deferred<void>();
    const retryClose = deferred<void>();
    const lateRuntime = runtimePort({
      onClose: vi
        .fn()
        .mockRejectedValueOnce(new Error("late runtime close failed"))
        .mockImplementationOnce(() => retryClose.promise),
    });
    let receivedSignal: AbortSignal | undefined;
    let credentialHome = "";
    let bridgeUrl = "";
    const openRuntime = vi.fn((options) => {
      receivedSignal = options.signal;
      credentialHome = options.launchEnvironment.CODEX_HOME!;
      bridgeUrl = options.mcpServers[0]!.url;
      runtimeAdmissionStarted.resolve(undefined);
      return runtimeAdmission.promise;
    });
    const controller = trackedAdmissionController();
    const cancellation = new Error("runtime admission cancelled");
    const opening = trackAdmissionOpening(
      AcpxRuntimeHost.open(
        {
          ...fixture.options,
          agent: "codex",
          model: "gpt-5.6-sol",
          permissionMode: "deny-all",
          environment: {
            PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}",
          },
          signal: controller.signal,
          semanticTools: {
            tools: [],
            handler: async () => ({ ok: true }),
          },
        },
        fixture.dependencies({ openRuntime }),
      ),
    );
    await runtimeAdmissionStarted.promise;
    expect(receivedSignal).toBe(controller.signal);

    controller.abort(cancellation);
    await expect(opening).rejects.toBe(cancellation);
    expect(fixture.commandClose).toHaveBeenCalledOnce();
    await expect(fetch(bridgeUrl)).rejects.toThrow();
    const authPath = join(credentialHome, "auth.json");
    await expect(readFile(authPath, "utf8")).resolves.toBe("{}");
    await expect(
      stageManagedCodexCredential({
        agentHomeDirectory: credentialHome,
        environment: {
          PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"contender"}',
        },
      }),
    ).rejects.toThrow("already has an active lease");

    runtimeAdmission.resolve(lateRuntime);
    await waitForAcpxOperation(() => expect(lateRuntime.close).toHaveBeenCalledTimes(2));
    expect(lateRuntime.close).toHaveBeenNthCalledWith(1, {
      reason: "ACPX runtime admission aborted",
    });
    await expect(readFile(authPath, "utf8")).resolves.toBe("{}");
    await expect(
      stageManagedCodexCredential({
        agentHomeDirectory: credentialHome,
        environment: {
          PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"contender"}',
        },
      }),
    ).rejects.toThrow("already has an active lease");

    retryClose.resolve(undefined);
    await waitForAcpxOperation(async () => {
      await expect(readFile(authPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
    // File removal precedes kernel lease release. Wait for the lease itself so
    // this assertion cannot race between those two ordered cleanup steps.
    const contender = await waitForAcpxOperation(() =>
      stageManagedCodexCredential({
        agentHomeDirectory: credentialHome,
        environment: {
          PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"contender"}',
        },
      }),
    );
    await contender.close();
  }, ACPX_LONG_WAIT_TEST_TIMEOUT_MS);

  it("scrubs credentials after rejected runtime cleanup is proven", async () => {
    const fixture = await hostFixture();
    const runtimeAdmission = deferred<AcpxRuntimePort>();
    const runtimeAdmissionStarted = deferred<void>();
    const providerCleanup = deferred<void>();
    const credentialClose = vi.fn(async () => undefined);
    const controller = trackedAdmissionController();
    const cancellation = new Error("runtime admission cancelled");
    const openRuntime = vi.fn((options: AcpxRuntimePortOpenOptions) => {
      options.retainFailedAdmissionCleanup(providerCleanup.promise);
      runtimeAdmissionStarted.resolve(undefined);
      return runtimeAdmission.promise;
    });
    const opening = trackAdmissionOpening(
      AcpxRuntimeHost.open(
        {
          ...fixture.options,
          agent: "codex",
          model: "gpt-5.6-sol",
          permissionMode: "deny-all",
          signal: controller.signal,
        },
        {
          ...fixture.dependencies({ openRuntime }),
          stageCredential: async () => ({
            path: join(fixture.root, "auth.json"),
            mode: "inline_json",
            lifetimeFenceFds: [42, 43],
            lifetimeFenceCandidates: [60_001, 60_002, 60_003],
            activateLifetimeOwner: async () => undefined,
            close: credentialClose,
          }),
        },
      ),
    );
    await runtimeAdmissionStarted.promise;

    controller.abort(cancellation);
    await expect(opening).rejects.toBe(cancellation);
    const cleanupFailure = new Error("provider survived forced cleanup");
    runtimeAdmission.reject(new AggregateError([cancellation, cleanupFailure]));
    await new Promise((resolve) => setImmediate(resolve));

    expect(credentialClose).not.toHaveBeenCalled();
    expect(fixture.commandClose).toHaveBeenCalledOnce();

    providerCleanup.resolve(undefined);
    await waitForAcpxOperation(() => expect(credentialClose).toHaveBeenCalledOnce());
  }, ACPX_LONG_WAIT_TEST_TIMEOUT_MS);
});

function runtimePort(
  input: {
    getStatus?: AcpxRuntimePort["getStatus"];
    setModel?: NonNullable<AcpxRuntimePort["setModel"]>;
    startTurn?: AcpxRuntimePort["startTurn"];
    onClose?: AcpxRuntimePort["close"];
  } = {},
): AcpxRuntimePort & { close: ReturnType<typeof vi.fn> } {
  return {
    identity: async () => ({
      acpxRecordId: "record-1",
      backendSessionId: "backend-1",
      agentSessionId: "agent-1",
    }),
    getStatus:
      input.getStatus ??
      (async () => ({
        models: {
          currentModelId: "gpt-5.6-sol",
          availableModelIds: ["gpt-5.6-sol"],
        },
      })),
    ...(input.setModel ? { setModel: input.setModel } : {}),
    startTurn: vi.fn(input.startTurn ?? (() => runtimeTurn())),
    close: vi.fn(input.onClose ?? (async () => undefined)),
  };
}

function runtimeTurn(): AcpxRuntimeTurn & {
  cancel: ReturnType<typeof vi.fn>;
} {
  return {
    requestId: "turn-1",
    promptStarted: Promise.resolve(),
    events: {
      async *[Symbol.asyncIterator]() {
        yield { type: "text_delta" as const, text: "done" };
      },
    },
    result: new Promise(() => undefined),
    cancel: vi.fn(async () => undefined),
    closeStream: vi.fn(async () => undefined),
  };
}

async function hostFixture() {
  const root = await mkdtemp(join(tmpdir(), "paperclip-acpx-host-"));
  temporaryDirectories.push(root);
  const runtimeDirectory = join(root, "runtime");
  const workingDirectory = join(root, "workspace");
  await Promise.all([mkdir(runtimeDirectory), mkdir(workingDirectory)]);
  const commandClose = vi.fn(async () => undefined);
  const command: VerifiedAcpxCommandLease = {
    spawn: () => {
      throw new Error("test command is not spawnable");
    },
    close: commandClose,
  };
  return {
    root,
    commandClose,
    options: {
      runtimeDirectory,
      normalizedSessionId: "normalized-session-1",
      workingDirectory,
    },
    dependencies(
      input: Pick<AcpxRuntimeHostDependencies, "openRuntime"> &
        Partial<
          Pick<AcpxRuntimeHostDependencies, "reportRetainedCleanupFailure">
        > & {
          // Opt-in only. When true, `prepareSandbox` runs the real
          // preparation once, then returns that same sandbox for every
          // later open in the test. Every other test omits this flag, so
          // the file still proves that a reopen re-prepares the sandbox.
          reuseSandbox?: boolean;
        },
    ): AcpxRuntimeHostDependencies {
      let reusedSandbox: AcpxRuntimeSandbox | null = null;
      return {
        verifyInstallation: async (profile) =>
          ({
            commandDigest: profile.commandDigest,
            agentServerPackageJsonPath: join(root, "package.json"),
            agentRuntimePackageJsonPath: null,
            openCommand: async () => command,
          }) satisfies VerifiedAcpxInstallation,
        openRuntime: input.openRuntime,
        // Record the skills home the instant the sandbox exists, ahead of
        // the materialize call that seals it. A test that overrides
        // `prepareSandbox` for a non-Claude agent replaces this wrapper, but
        // those agents never materialize skills, so nothing is lost.
        prepareSandbox: async (sandboxInput) => {
          if (input.reuseSandbox && reusedSandbox) return reusedSandbox;
          const sandbox = await prepareAcpxRuntimeSandbox(sandboxInput);
          if (sandboxInput.agent === "claude") {
            materializedSkillsHomes.push(join(sandbox.agentHomeDirectory, "skills"));
          }
          if (input.reuseSandbox) reusedSandbox = sandbox;
          return sandbox;
        },
        retainAdmissionCleanup: trackAdmissionCleanup,
        reportRetainedCleanupFailure:
          input.reportRetainedCleanupFailure ?? vi.fn(),
      };
    },
  };
}

function trackedAdmissionController(): AbortController {
  const controller = new AbortController();
  admissionControllers.push(controller);
  return controller;
}

function trackAdmissionOpening<T>(opening: Promise<T>): Promise<T> {
  trackSettledPromise(pendingAdmissionOpenings, opening);
  return opening;
}

function trackAdmissionCleanup(cleanup: Promise<void>): void {
  trackSettledPromise(pendingAdmissionCleanups, cleanup);
}

function trackSettledPromise<T>(
  pending: Set<Promise<void>>,
  promise: Promise<T>,
): void {
  const observed = promise.then(
    () => undefined,
    () => undefined,
  );
  pending.add(observed);
  void observed.finally(() => pending.delete(observed));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}
