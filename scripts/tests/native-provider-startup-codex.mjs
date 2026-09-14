// Opt-in real Codex qualification. No model turn, credentials or live history.
// node --import ./server/node_modules/tsx/dist/loader.mjs \
//   scripts/tests/native-provider-startup-codex.mjs --run \
//   --codex-binary /absolute/path/to/codex --expected-runner-sha256 <staged-hash>
// Fresh 0700 fixture directories and their synthetic evidence are retained.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  DurablePrpControlPlane,
  spawnRunner,
} from "../../packages/paperclip-runner/src/control-plane/durable-prp-control-plane.ts";
import {
  createRunnerdCodexAppServerArgs,
  defaultCapabilityRunnerdBinary,
} from "../../packages/paperclip-runner/src/live/runnerd-codex-transport.ts";

const args = process.argv.slice(2);
if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
  console.log(
    "Opt-in only: --run --codex-binary ABSOLUTE_CODEX --expected-runner-sha256 STAGED_SHA256. Creates retained synthetic fixtures; never sends turn/start.",
  );
} else {
  let fixture;
  try {
    assert.equal(args.length, 5, "invalid_arguments");
    assert.equal(args[0], "--run", "explicit_run_required");
    assert.equal(args[1], "--codex-binary", "explicit_codex_binary_required");
    assert.ok(isAbsolute(args[2]), "absolute_codex_binary_required");
    assert.equal(
      args[3],
      "--expected-runner-sha256",
      "expected_staged_digest_required",
    );
    assert.match(args[4], /^[a-f0-9]{64}$/u, "invalid_expected_digest");
    const codexBinary = await realpath(args[2]);
    const runnerBinary = await realpath(defaultCapabilityRunnerdBinary());
    // Never silently qualify a debug fallback or a caller-selected alternate runner.
    assert.match(
      runnerBinary,
      /\/dist\/bin\/paperclip-runnerd$/u,
      "normal_staged_runner_required",
    );
    const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const runnerSha256 = digest(await readFile(runnerBinary));
    assert.equal(runnerSha256, args[4], "staged_runner_digest_changed");
    const codexSha256 = digest(await readFile(codexBinary));
    fixture = await realpath(
      await mkdtemp(join(tmpdir(), "paperclip-real-startup-")),
    );
    const home = join(fixture, "empty-codex-home");
    const workspace = join(fixture, "workspace");
    const controlDirectory = join(fixture, "control-plane");
    const runnerDirectory = join(fixture, "runner");
    const snapshots = join(fixture, "before-reopen");
    for (const directory of [home, workspace, snapshots])
      await mkdir(directory, { mode: 0o700 });
    // Pin file-only auth storage: this fixture must not consult a shared keychain.
    await writeFile(
      join(home, "config.toml"),
      'cli_auth_credentials_store = "file"\n',
      { flag: "wx", mode: 0o600 },
    );
    const environment = {
      PATH: `${dirname(codexBinary)}:/usr/bin:/bin`,
      HOME: home,
      CODEX_HOME: home,
      LC_ALL: "C",
    };
    const version = execFileSync(codexBinary, ["--version"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    assert.equal(
      version,
      "codex-cli 0.153.4",
      "qualified_codex_version_required",
    );
    const ledger = join(fixture, "provider-process-starts.txt");
    const identityLedger = join(fixture, "provider-process-identities.txt");
    const trace = join(fixture, "provider-trace.jsonl");
    const shim = join(fixture, "record-and-exec-codex");
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(
      shim,
      `#!/bin/sh\nset -eu\nprintf '%s\\n' "$$" >> ${quote(ledger)}\nLC_ALL=C /bin/ps -p "$$" -o pid= -o pgid= -o lstart= >> ${quote(identityLedger)}\nexec ${quote(codexBinary)} "$@"\n`,
      { flag: "wx", mode: 0o700 },
    );
    environment.PAPERCLIP_PROVIDER_TRACE_PATH = trace;
    environment.PAPERCLIP_PROVIDER_TRACE_MAX_BYTES = "1048576";
    const identity = {
      runnerInstanceId: `runner-${randomUUID()}`,
      environmentLeaseId: `lease-${randomUUID()}`,
      runId: randomUUID(),
      normalizedSessionId: randomUUID(),
      turnId: randomUUID(),
      itemId: randomUUID(),
    };
    const missingThread = randomUUID();
    const events = [];
    const startupCommandStatuses = [];
    const startupEvents = () =>
      events.filter(
        (event) =>
          event.eventType === "harness.diagnostic" &&
          event.payload.code === "provider_startup_ownership",
      );
    const makeCore = () =>
      new DurablePrpControlPlane({
        stateDirectory: controlDirectory,
        identity,
        expectedRunnerVersion: "0.3.0",
        expectedRunnerDigest: `sha256:${runnerSha256}`,
        onCommittedEvent: async (event) => {
          events.push(structuredClone(event));
          if (
            event.eventType === "harness.diagnostic" &&
            event.payload.code === "provider_startup_ownership"
          ) {
            startupCommandStatuses.push(
              core.store.state.commands.find(
                (command) => command.commandId === "startup-open",
              )?.status,
            );
          }
        },
      });
    const readProvider = async () =>
      JSON.parse(
        await readFile(
          join(runnerDirectory, "codex-provider-state.json"),
          "utf8",
        ),
      );
    const readStarts = async () =>
      (await readFile(ledger, "utf8")).trim().split("\n").map(Number);
    const waitUntil = async (predicate, milliseconds = 20_000) => {
      const deadline = performance.now() + milliseconds;
      while (!(await predicate())) {
        if (performance.now() >= deadline)
          throw new Error("fixture_condition_timeout");
        await delay(10);
      }
    };
    const launch = (core, iteration) =>
      spawnRunner({
        connectUrl: core.connectUrl,
        stateDirectory: runnerDirectory,
        identity,
        ticket: core.issueBootstrapTicket(60_000),
        maxOutboxBytes: 16 * 1024 * 1024,
        p0ReserveBytes: 1024 * 1024,
        maxRuntimeMs: 10_000,
        reconnectGraceMs: 1_000,
        runnerBinaryPath: runnerBinary,
        runnerVersion: "0.3.0",
        runnerDigest: `sha256:${runnerSha256}`,
        environment,
        diagnosticsDirectory: join(fixture, `runner-diagnostics-${iteration}`),
      });
    // Join the exact ChildProcess on all paths. Signalling alone is never proof.
    const stopAndJoin = async (handle) => {
      if (!handle) return null;
      let terminateTimer;
      let killTimer;
      let finalTimer;
      try {
        terminateTimer = setTimeout(() => handle.child.kill("SIGTERM"), 12_000);
        killTimer = setTimeout(() => handle.child.kill("SIGKILL"), 14_000);
        const finished = handle.completion;
        const deadline = new Promise((_, reject) => {
          finalTimer = setTimeout(() => {
            reject(new Error("fixture_runner_exit_not_joined"));
          }, 17_000);
        });
        return await Promise.race([finished, deadline]);
      } finally {
        clearTimeout(terminateTimer);
        clearTimeout(killTimer);
        clearTimeout(finalTimer);
      }
    };
    // This is emergency hygiene for this fixture's recorded direct child only.
    // A PID absence check is not wait(2), and never proves whole-tree retirement.
    const retireRecordedProvider = async () => {
      const unproven = () => new Error("fixture_provider_cleanup_unproven");
      let recordedPids;
      let recordedIdentities;
      try {
        recordedPids = await readStarts();
      } catch {
        throw unproven();
      }
      try {
        recordedIdentities = (await readFile(identityLedger, "utf8"))
          .trim()
          .split("\n");
      } catch {
        throw unproven();
      }
      if (
        recordedPids.length !== recordedIdentities.length ||
        new Set(recordedPids).size !== recordedPids.length
      )
        throw unproven();
      const normalize = (value) => value.trim().replaceAll(/\s+/gu, " ");
      for (const [index, pid] of recordedPids.entries()) {
        if (!Number.isSafeInteger(pid) || pid <= 1) throw unproven();
        const expected = normalize(recordedIdentities[index]);
        const [recordedPid, pgid, ...birth] = expected.split(" ");
        if (
          recordedPid !== String(pid) ||
          pgid !== String(pid) ||
          !/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/u.test(
            birth.join(" "),
          )
        )
          throw unproven();
        const stillOwned = () => {
          let output;
          try {
            output = execFileSync(
              "/bin/ps",
              [
                "-ww",
                "-p",
                String(pid),
                "-o",
                "pid=",
                "-o",
                "pgid=",
                "-o",
                "lstart=",
                "-o",
                "command=",
              ],
              {
                env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
                encoding: "utf8",
                timeout: 1_000,
                stdio: ["ignore", "pipe", "pipe"],
              },
            );
          } catch (error) {
            if (error?.status === 1 && String(error.stdout ?? "").trim() === "")
              return false;
            throw unproven();
          }
          const line = normalize(output);
          if (!line.startsWith(`${expected} `)) throw unproven();
          const command = line.slice(expected.length + 1);
          if (
            !(
              command.startsWith(`${normalize(codexBinary)} `) ||
              command.startsWith(`/bin/sh ${normalize(shim)} `)
            ) ||
            !command.includes(`--cd ${normalize(workspace)} `)
          )
            throw unproven();
          return true;
        };
        if (!stillOwned()) continue;
        for (const signal of ["SIGTERM", "SIGKILL"]) {
          if (!stillOwned()) break;
          try {
            process.kill(pid, signal);
          } catch (error) {
            if (error?.code !== "ESRCH") throw unproven();
          }
          const deadline = performance.now() + 2_000;
          while (stillOwned() && performance.now() < deadline) await delay(25);
        }
        if (stillOwned()) throw unproven();
      }
    };
    const finishIteration = async (activeCore, activeHandle) => {
      try {
        return await stopAndJoin(activeHandle);
      } finally {
        try {
          await activeCore.stop();
        } finally {
          if (activeHandle) await retireRecordedProvider();
        }
      }
    };
    let core = makeCore();
    let handle;
    let firstExit;
    const prepare = core.queueCommand(
      "run.prepare",
      {
        provider: {
          kind: "codex",
          provider: "codex",
          driver: "codex_app_server",
          providerVersion: "0.153.4",
          command: shim,
          args: [
            "--cd",
            workspace,
            ...createRunnerdCodexAppServerArgs({
              environment,
              codexHome: home,
            }),
          ],
          cwd: workspace,
          model: null,
          providerSessionId: missingThread,
          instructions:
            "Synthetic startup qualification only. No model turn is authorized.",
          approvalPolicy: "never",
          externallySandboxed: false,
        },
      },
      "startup-prepare",
    );
    const open = core.queueCommand("session.open", {}, "startup-open");
    try {
      await core.start();
      handle = launch(core, 1);
      // Atomic controller commits publish new snapshots. Observe commands by
      // stable ID instead of waiting on the original queueCommand object.
      await waitUntil(
        () =>
          (core.getCommand(open.commandId)?.status ?? "pending") !== "pending",
      );
      assert.equal(
        core.getCommand(prepare.commandId)?.status,
        "completed",
        "prepare_must_succeed",
      );
      assert.equal(
        core.getCommand(open.commandId)?.status,
        "failed",
        "missing_thread_must_fail",
      );
      assert.ok(
        core
          .getCommand(open.commandId)
          ?.result?.result?.message?.includes(
            `no rollout found for thread id ${missingThread}`,
          ),
        "exact_missing_rollout_required",
      );
      // The callback completed each durable event commit before failed-command receipt.
      assert.deepEqual(
        startupEvents().map((event) => event.payload.startup.phase),
        ["intent", "spawned", "initialization_failed"],
      );
      assert.deepEqual(startupCommandStatuses, [
        "pending",
        "pending",
        "pending",
      ]);
    } finally {
      firstExit = await finishIteration(core, handle);
    }
    const providerBefore = await readProvider();
    const facts = startupEvents().map((event) => event.payload.startup);
    const [intent, spawned, failed] = facts;
    const starts = await readStarts();
    assert.equal(starts.length, 1, "exactly_one_real_provider_process");
    assert.ok(
      Number.isInteger(starts[0]) && starts[0] > 0,
      "valid_recorded_pid_required",
    );
    for (const fact of facts) {
      assert.equal(fact.schema, "paperclip.provider_startup.v1");
      assert.equal(fact.launchId, intent.launchId);
      assert.equal(fact.requestedThreadId, missingThread);
      assert.equal(fact.authenticatedThreadId, null);
      assert.equal(fact.processTreeRetired, false);
      assert.equal(fact.origin.runId, identity.runId);
      assert.equal(fact.origin.runnerInstanceId, identity.runnerInstanceId);
      assert.equal(fact.command.commandId, open.commandId);
      assert.equal(fact.command.controllerSeq, open.controllerSeq);
      assert.equal(
        fact.configurationFingerprint,
        intent.configurationFingerprint,
      );
    }
    assert.equal(spawned.processId, starts[0]);
    assert.equal(spawned.processGroupId, starts[0]);
    assert.equal(spawned.directChildExitObserved, false);
    assert.equal(failed.processId, starts[0]);
    assert.equal(failed.failedStage, "thread_open");
    assert.equal(failed.directChildExitObserved, true);
    assert.notEqual(failed.exitCode === null, failed.signal === null);
    assert.deepEqual(providerBefore.startupAttempt, failed);
    assert.equal(providerBefore.providerProcessGeneration, 0);
    const traceBefore = await readFile(trace);
    const traceRows = traceBefore
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      traceRows.at(-1)?.kind,
      "trace_status",
      "trace_terminal_status_required",
    );
    assert.equal(
      traceRows.at(-1)?.status,
      "complete",
      "complete_provider_trace_required",
    );
    assert.deepEqual(
      traceRows.map((row) => row.debugSequence),
      traceRows.map((_, index) => index + 1),
      "complete_trace_sequence_required",
    );
    const sent = traceRows
      .filter(
        (row) => row.kind === "frame" && row.direction === "client_to_provider",
      )
      .map((row) =>
        JSON.parse(Buffer.from(row.rawBase64, "base64").toString("utf8")),
      );
    assert.deepEqual(
      sent.map((frame) => frame.method),
      ["initialize", "initialized", "thread/resume"],
    );
    assert.equal(sent[2].params.threadId, missingThread);
    await assert.rejects(access(join(home, "auth.json")), { code: "ENOENT" });
    for (const [source, name] of [
      [
        join(controlDirectory, "control-plane-state.json"),
        "control-plane-state.json",
      ],
      [join(runnerDirectory, "runner-state.json"), "runner-state.json"],
      [
        join(runnerDirectory, "codex-provider-state.json"),
        "codex-provider-state.json",
      ],
    ])
      await copyFile(source, join(snapshots, name));
    const firstFailure = structuredClone(
      core.getCommand(open.commandId)?.result,
    );
    const ledgerBefore = await readFile(ledger);
    const identityLedgerBefore = await readFile(identityLedger);
    core = makeCore();
    const snapshot = core.queueCommand(
      "session.snapshot",
      {},
      "reopened-snapshot",
    );
    const reopen = core.queueCommand("session.open", {}, "reopened-open");
    handle = null;
    let secondExit;
    try {
      await core.start();
      handle = launch(core, 2);
      await waitUntil(
        () =>
          (core.getCommand(snapshot.commandId)?.status ?? "pending") !==
            "pending" &&
          (core.getCommand(reopen.commandId)?.status ?? "pending") !==
            "pending",
      );
      for (const queued of [snapshot, reopen]) {
        const command = core.getCommand(queued.commandId);
        assert.ok(command, "reopened_command_must_exist");
        assert.equal(command.status, "failed");
        assert.ok(
          command.result?.result?.message?.includes(
            "provider startup ownership remains unadmitted",
          ),
          "persisted_startup_fence_required",
        );
      }
    } finally {
      secondExit = await finishIteration(core, handle);
    }
    assert.deepEqual(
      await readFile(ledger),
      ledgerBefore,
      "reopen_started_another_provider_process",
    );
    assert.deepEqual(
      await readFile(identityLedger),
      identityLedgerBefore,
      "reopen_changed_process_identity_ledger",
    );
    assert.deepEqual(
      await readFile(trace),
      traceBefore,
      "reopen_sent_provider_rpc",
    );
    assert.deepEqual(
      (await readProvider()).startupAttempt,
      failed,
      "original_startup_receipt_changed",
    );
    assert.deepEqual(
      core.store.state.commands.find(
        (command) => command.commandId === open.commandId,
      ).result,
      firstFailure,
    );
    assert.ok(
      core.store.state.commands.every(
        (command) => !command.type.startsWith("turn."),
      ),
      "no_turn_command_authorized",
    );
    assert.equal(startupEvents().length, 3);
    assert.equal(
      digest(await readFile(codexBinary)),
      codexSha256,
      "codex_binary_changed",
    );
    assert.equal(
      digest(await readFile(runnerBinary)),
      runnerSha256,
      "runner_binary_changed",
    );
    const summary = {
      outcome: "passed",
      fixture,
      codexVersion: version,
      codexSha256,
      runnerSha256,
      realCodexBehindRecordingExecShim: true,
      providerProcessId: starts[0],
      phases: facts.map((fact) => fact.phase),
      requestedThreadId: missingThread,
      authenticatedThreadId: null,
      directChildExitObserved: true,
      processTreeRetired: false,
      providerMethods: sent.map((frame) => frame.method),
      providerProcesses: starts.length,
      reopenDeniedBeforeProviderLaunch: true,
      originalReceiptPreserved: true,
      startupFactsCommittedBeforeFailure: true,
      runnerExits: [firstExit, secondExit].map((exit) => ({
        code: exit.code,
        signal: exit.signal,
      })),
      noHistoricalRecoveryAuthority: true,
    };
    await writeFile(
      join(fixture, "qualification-summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    console.log(JSON.stringify(summary));
  } catch (error) {
    // Never print raw Codex/runner frames, command output or provider error prose.
    console.error(
      JSON.stringify({
        outcome: "failed",
        fixture: fixture ?? null,
        code:
          error instanceof Error &&
          [
            "fixture_runner_exit_not_joined",
            "fixture_provider_cleanup_unproven",
          ].includes(error.message)
            ? error.message
            : error instanceof assert.AssertionError
              ? "qualification_assertion_failed"
              : "qualification_failed",
      }),
    );
    process.exitCode = 1;
  }
}
