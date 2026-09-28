# Muse Code remote execution and sandbox login, Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `muse_local` to parity with the other coding adapters. It should run over SSH and in sandbox environments, and support the in-app device login inside a sandbox (Daytona).

**Architecture:**
1. `execute` and `testEnvironment` gain the standard remote lane: sync the workspace with `prepareAdapterExecutionTargetRuntime`, run `muse` on the target, and restore changes. No credential home is shipped, because the key travels as `META_API_KEY`. Sandbox targets install Muse with the official launcher.
2. A strict `parseMuseDeviceLoginPrompt` plus a new closed login-command key `muse` (server, Daytona plugin, plugin SDK) let the sandbox PTY run `muse login`. It runs with an isolated XDG home, the file backend and **stdin from `/dev/null`** (verified: with a TTY on stdin, Muse blocks on "Press Enter to open it in your browser"). It then copies `auth.json` to `<sessionHome>/auth.json`, where the existing descriptor-bound reader expects it.
3. Promotion saves the bare `LLM|` key. It goes into the AI connection for managed sessions, or into the company file `<instance>/companies/<id>/muse-home/api-key` (0600) for unmanaged ones, which `execute` reads into `META_API_KEY`.

**Tech Stack:** TypeScript, Vitest, adapter-utils execution-target API, Daytona plugin, Docker.

**Spec:** `doc/plans/2026-09-26-muse-local-adapter-design.md` (rev 2, "Phase 3"). Builds on Phases 1–2 on this branch.

## Global Constraints

- Login-command key `muse`; command `muse login`. Daytona launch line, exactly:
  `exec env XDG_CONFIG_HOME=<H>/xdg XDG_DATA_HOME=<H>/xdg-data TBH_CREDENTIAL_BACKEND=file MUSE_NO_AUTO_UPDATE=1 sh -c 'muse login </dev/null && install -m 0600 "$XDG_CONFIG_HOME/muse/auth.json" "$0/auth.json"' <H>`
  with every `<H>` passed through `encodePosixShellArg`. `$0` is the session home argument.
- Prompt parser: strip ANSI CSI; normalize `\r\n`; URL origin exactly `https://auth.meta.com`, path exactly `/oauth/device/`, exactly one query key `code`, no fragment or credentials; code `^[A-Z0-9]{4}-[A-Z0-9]{4}$`, equal to the first non-blank line after `confirm this code matches:`. Pure; never logs or throws input.
- Sandbox install command (sandbox transport only): `mkdir -p "$HOME/.local/bin" && curl -fsSL https://api.meta.ai/muse-launcher.sh -o "$HOME/.local/bin/muse" && chmod +x "$HOME/.local/bin/muse" && MUSE_LAUNCHER_INSTALL=1 "$HOME/.local/bin/muse"`; detect command `muse`.
- Remote `XDG_DATA_HOME` = `<remoteCwd>/.paperclip-runtime/muse/data`. Resume works while that directory persists; otherwise Muse starts a new session under the same id, as verified in Phase 1.
- Company key file: `<instanceRoot>/companies/<companyId>/muse-home/api-key`, dir 0700 and file 0600, atomic write, the key only. Precedence: bound `META_API_KEY` (config env or managed connection) > company key file > host `muse login`.
- Runner image: launcher installed to `/usr/local/bin/muse` as root at build time; `muse` added to the PATH check loop.
- UI: `supportsSandboxDeviceLogin` becomes an allowlist `["anthropic", "openai", "xai", "meta"]` (Phase 2 review minor).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A tampered or unexpected login output must never produce a prompt URL outside `https://auth.meta.com/oauth/device/`. Pinned in Task 2 (negative parser cases).
2. An unmanaged sandbox login must not overwrite a different account's company key silently. Last-writer-wins is acceptable (a user-initiated re-login), but the write must be atomic and 0600. Pinned in Task 3 (mode + atomic replace test).
3. A remote run must not leak the host's `~/.config/muse` or keychain login to the remote. Only `META_API_KEY` travels. Pinned in Task 1 (no `XDG_CONFIG_HOME` in the remote env; no home asset).
4. The Daytona launch line must not allow shell injection through the session home. Pinned in Task 5 (exact-string test with a quote-containing home rejected by the home pattern, and encoded path).
5. The company key file must be ignored when a managed connection or explicit `META_API_KEY` is bound. Pinned in Task 3.

---

### Task 1: Remote execution lane (SSH and sandbox)

**Files:**
- Modify: `packages/adapters/muse-local/src/server/execute.ts`, `src/server/test.ts`, `src/index.ts` (export `MUSE_SANDBOX_INSTALL_COMMAND`)
- Modify: `server/src/adapters/registry.ts` (`museLocalAdapter.getRuntimeCommandSpec.installCommand`)
- Modify: `packages/shared/src/environment-support.ts` (`REMOTE_MANAGED_ADAPTERS` add `"muse_local"`)
- Test: `packages/adapters/muse-local/src/server/execute.test.ts`, `test.test.ts`, `packages/shared/src/environment-support.test.ts`

**Interfaces:**
- Produces: `MUSE_SANDBOX_INSTALL_COMMAND: string` (exact Global Constraints string). `execute` on a remote target calls `prepareAdapterExecutionTargetRuntime({ adapterKey: "muse", workspaceLocalDir: cwd, ... })` with no `assets`, runs with `--workspace <remoteCwd>`, and restores through `withWorkspaceRestore`.

- [ ] **Step 1: Failing tests.** In `execute.test.ts`, extend the hoisted mock with `prepareRuntimeMock` (returning `{ workspaceRemoteDir: "/remote/ws", assetDirs: {}, restoreWorkspace: restoreMock }`) and with `adapterExecutionTargetRemoteCwd: (_t, cwd) => mocks.isRemote ? "/remote/ws" : cwd`. Also add `prepareAdapterExecutionTargetRuntime` and `overrideAdapterExecutionTargetRemoteCwd` to the mock factory, following grok's execute.test.ts lines 14–70. Replace the "rejects remote execution targets" test with:
```ts
  it("runs on a remote target with the synced workspace and restores it", async () => {
    const root = await makeTempRoot();
    mocks.isRemote = true;
    mocks.runProcessMock.mockResolvedValue(await okRun());
    const result = await execute(makeCtx(root, { config: { cwd: root, paperclipRuntimeSkills: [], env: { META_API_KEY: "LLM|remote-key-000000000000000000000000000000" } } }));
    expect(mocks.prepareRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({ adapterKey: "muse", workspaceLocalDir: root }));
    expect(mocks.prepareRuntimeMock.mock.calls[0][0].assets).toBeUndefined();
    const [, , , args, options] = mocks.runProcessMock.mock.calls[0]!;
    expect(args[args.indexOf("--workspace") + 1]).toBe("/remote/ws");
    const env = (options as { env: Record<string, string> }).env;
    expect(env.XDG_DATA_HOME).toBe("/remote/ws/.paperclip-runtime/muse/data");
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
    expect(env.META_API_KEY).toBe("LLM|remote-key-000000000000000000000000000000");
    expect(mocks.restoreMock).toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  });
```
The prompt file must reach the remote. Muse reads `--prompt-file` on the target, so on remote targets write the prompt into the synced workspace at `<cwd>/.paperclip-runtime/muse/prompt-<runId>.md` (under the local cwd, before `prepareAdapterExecutionTargetRuntime`), pass the remote path, and delete the local copy in `finally`. Add the assertion `expect(args[args.indexOf("--prompt-file") + 1]).toBe("/remote/ws/.paperclip-runtime/muse/prompt-run-1.md")`.
In `test.test.ts`, replace "reports remote targets as unsupported" with a test that a remote target runs the hello probe (`runProcessMock` called with a `{kind:"remote"}` target) and passes. In `environment-support.test.ts`, add `muse_local` next to `grok_local` in the remote-managed expectations.

- [ ] **Step 2: Run and verify they fail** — `pnpm exec vitest run packages/adapters/muse-local packages/shared/src/environment-support.test.ts`.

- [ ] **Step 3: Implement.** In `execute.ts`:
  - remove the remote rejection;
  - compute `executionTargetIsRemote`;
  - write the prompt file in the local workspace for remote runs (as described above) or in the temp dir for local runs;
  - before running, if remote: `const prepared = await prepareAdapterExecutionTargetRuntime({ runId, target: executionTarget, adapterKey: "muse", workspaceLocalDir: cwd, timeoutSec, installCommand: ctx.runtimeCommandSpec?.installCommand ?? null, detectCommand: ctx.runtimeCommandSpec?.detectCommand ?? command, onProgress: (line) => onLog("stdout", line), onRuntimeProgress: ctx.onRuntimeProgress })`, set `effectiveExecutionCwd = prepared.workspaceRemoteDir ?? adapterExecutionTargetRemoteCwd(executionTarget, cwd)`, then re-run `refreshPaperclipWorkspaceEnvForExecution` with `executionTargetIsRemote: true` and `executionCwd: effectiveExecutionCwd`;
  - set `env.XDG_DATA_HOME` to `path.posix.join(effectiveExecutionCwd, ".paperclip-runtime", "muse", "data")` for remote, or the Phase 1 per-agent dir for local;
  - use `overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd)` for the process target, and `effectiveExecutionCwd` for `--workspace` and the session cwd;
  - wrap the turn in `withWorkspaceRestore(executeTurn, async () => { await restore?.(); })`, as grok does;
  - store `remoteExecution: adapterExecutionTargetSessionIdentity(target)` in `sessionParams` for remote runs and require `adapterExecutionTargetSessionMatches` before resuming.

  In `test.ts`, remove the remote rejection; the probe already goes through `runAdapterExecutionTargetProcess`. In `index.ts`, export `MUSE_SANDBOX_INSTALL_COMMAND`. In `registry.ts`, set `installCommand: MUSE_SANDBOX_INSTALL_COMMAND`. Add `"muse_local"` to `REMOTE_MANAGED_ADAPTERS`.

- [ ] **Step 4: Run tests and typecheck** — the same command plus `pnpm --filter @paperclipai/adapter-muse-local typecheck` and `(cd server && pnpm exec tsc --noEmit)`, plus `pnpm exec vitest run server/src/__tests__/environment-execution-target.test.ts`. Where that test enumerates remote-managed adapters, add `muse_local`.

- [ ] **Step 5: Commit** — `feat(muse-local): run over SSH and in sandboxes`.

---

### Task 2: Device-login prompt parser

**Files:**
- Create: `packages/adapters/muse-local/src/server/device-login-parse.ts`, `device-login-parse.test.ts`, `src/server/__fixtures__/device-login-prompt-pty.txt` (the captured PTY output with `\r\n`, code `QWMM-NVMF`)
- Modify: `src/server/index.ts` (exports)

**Interfaces:**
- Produces: `MUSE_DEVICE_LOGIN_COMMAND = "muse login"`, `MUSE_DEVICE_LOGIN_URL_ORIGIN = "https://auth.meta.com"`, `MUSE_DEVICE_LOGIN_URL_PATH = "/oauth/device/"`, `parseMuseDeviceLoginPrompt(text: string): { url: string; code: string } | null`.

- [ ] **Step 1: Failing tests** covering:
  - (a) the PTY fixture parses to `{ url: "https://auth.meta.com/oauth/device/?code=QWMM-NVMF", code: "QWMM-NVMF" }`;
  - (b) the headless form (`\n`, trailing "Waiting for approval…");
  - (c) ANSI-coloured code (`\x1b[1mQWMM-NVMF\x1b[0m`);
  - (d) partial output (URL only) → null;
  - negatives → null: `http://`, host `auth.meta.com.evil.io`, path `/oauth/device` (no trailing slash) or `/oauth/devicex/`, extra query key `&next=x`, repeated `code`, a fragment `#x`, `user:pass@`, a lowercase or malformed code `qwmm-nvmf` / `QWMM-NVM`, and a line code different from the URL code;
  - non-string input → null.

- [ ] **Step 2: Run and verify they fail.**

- [ ] **Step 3: Implement** by mirroring `packages/adapters/grok-local/src/server/device-login-parse.ts`: the same structure, ANSI regex, URL token regex, trailing-punctuation strip and proximity windows. First normalize `\r\n` and `\r` to `\n`. Use `parsed.host === "auth.meta.com"`, `parsed.pathname === "/oauth/device/"`, the query key `code`, `CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/`, and `CODE_PREAMBLE = "confirm this code matches:"`.

- [ ] **Step 4: Run tests and verify they pass; typecheck.**
- [ ] **Step 5: Commit** — `feat(muse-local): strict Muse device-login prompt parser`.

---

### Task 3: Credential promotion and the company key file

**Files:**
- Create: `packages/adapters/muse-local/src/server/muse-home.ts`, `muse-home.test.ts`
- Modify: `packages/adapters/muse-local/src/server/execute.ts` (read the company key), `index.ts` (exports)
- Test: `execute.test.ts`

**Interfaces:**
- Produces:
  - `resolveManagedMuseHomeDir(env: NodeJS.ProcessEnv, companyId: string): string` → `<instanceRoot>/companies/<companyId>/muse-home`;
  - `checkStagedMuseCredentialReadiness(authBytes: Buffer): { ready: boolean; reason?: string }` → ready iff `parseMuseAuthApiKey` finds a key and the size is ≤ 64 KiB;
  - `promoteMuseDeviceLoginCredential(input: { authBytes: Buffer; companyId: string; userInitiated: boolean; isSoleActiveOwner: () => Promise<boolean> | boolean; log: (line: string) => void | Promise<void>; env?: NodeJS.ProcessEnv }): Promise<"promoted" | "not_sole_owner" | "background_skipped">`;
  - `readCompanyMuseApiKey(env, companyId): Promise<string | null>`.

- [ ] **Step 1: Failing tests** (`muse-home.test.ts`, with `PAPERCLIP_HOME` stubbed to a temp dir):
  - promotes: writes `muse-home/api-key` holding exactly the key, file mode 0600 and dir mode 0700, and `readCompanyMuseApiKey` returns it;
  - a second promotion replaces the first key atomically (no `.tmp` leftovers);
  - a background login returns `background_skipped` and writes nothing;
  - `isSoleActiveOwner` false returns `not_sole_owner` and writes nothing;
  - `companyId` values `""`, `".."` and `"a/b"` throw;
  - readiness rejects `{}`, a keychain-pointer file and a 70 KiB file;
  - log lines contain neither the key nor `@`.

  In `execute.test.ts`:
  - "uses the company Muse key when nothing else is bound": write the file via `promoteMuseDeviceLoginCredential`, run, and assert `env.META_API_KEY` equals it and `billingType === "subscription"`;
  - "prefers a bound META_API_KEY over the company key";
  - "prefers a managed connection's key over the company key" (config env set and `managedAiConnection` set).

- [ ] **Step 2: Run and verify they fail.**

- [ ] **Step 3: Implement** `muse-home.ts`:
  - resolve the instance root the way `resolveMuseDataHome` does;
  - validate `companyId` as grok's `requireSafeCompanyId` does;
  - check readiness, then parse the key, then apply the user-initiated gate, then the sole-owner gate;
  - `mkdir` 0700 plus `chmod`, then write a temp file created with `open(tmp, "wx", 0o600)`, `rename` it over `api-key`, `chmod` 0600, and remove the temp in `finally`;
  - log fixed lines only.

  In `execute.ts`, after building env: if `!hasNonEmptyEnvValue(effectiveEnvCandidate, "META_API_KEY") && !config.managedAiConnection`, read `readCompanyMuseApiKey(process.env, agent.companyId)` and set `env.META_API_KEY` when it's present. Billing is `subscription` for a company-file key (it comes from a device login).

- [ ] **Step 4: Run and verify they pass; typecheck.**
- [ ] **Step 5: Commit** — `feat(muse-local): device-login credential promotion to a company key`.

---

### Task 4: Server device-login wiring

**Files:**
- Modify: `server/src/services/login-command.ts` (key `muse`, map `muse_local: "muse"`, `isLoginCommandKey`), `server/src/services/device-login-service.ts` (`DISPLAYED_CODE_ADAPTER_TYPES` + `DISPLAYED_CODE_PROFILES.muse_local`), `server/src/adapters/registry.ts` (`museLoginCapability`), `server/src/routes/agents.ts` (`promotionByAdapterType.muse_local`)
- Test: `server/src/services/login-command.test.ts`, `server/src/adapters/registry.test.ts`, `server/src/routes/adapters.test.ts` (projection), plus a new promotion test in `server/src/__tests__/ai-legacy-compatibility.test.ts` or the file where the grok promotion is tested (grep `promoteGrokDeviceLoginCredential` in server tests)

- [ ] **Step 1: Failing tests:**
  - `resolveLoginCommandKey("muse_local") === "muse"` and `isLoginCommandKey("muse")`;
  - `requireServerAdapter("muse_local").loginCapability` is `displayed_code` / `caller_bounded` and passes `assertValidAdapterLoginCapability`;
  - `DISPLAYED_CODE_PROFILES.muse_local.parsePrompt(fixture)` returns the code;
  - the adapters route projects `muse_local` `panelMode: "displayed_code"`;
  - managed promotion: with an `adapterAuthSessions` row carrying `aiConnection: { provider: "meta", ... }`, `promote(authBytes)` saves a connection whose credential is the bare key. Model this on the grok managed branch test if one exists; otherwise call `aiConnectionService.save` expectations through the same route module.

- [ ] **Step 2: Run and verify they fail.**

- [ ] **Step 3: Implement.**
  - The profile: `{ command: MUSE_DEVICE_LOGIN_COMMAND, homeEnvVar: "XDG_CONFIG_HOME", parsePrompt: parseMuseDeviceLoginPrompt, timeoutMs: DEVICE_LOGIN_TIMEOUT_MS, promotion: UNCONFIGURED_PROMOTION }`.
  - The capability mirrors `grokLoginCapability`, with `getCommand: () => MUSE_DEVICE_LOGIN_COMMAND`.
  - In `agents.ts`, the `muse_local` promotion is:
```ts
      muse_local: {
        async promote(authBytes, context) {
          const managedSession = await adapterLoginStore.get(context.sessionId);
          if (managedSession?.aiConnection) {
            await adapterLoginStore.withCompanyAdapterPromotionLock(context.companyId, context.startedByUserId, context.adapterType, async () => {
              const key = checkStagedMuseCredentialReadiness(authBytes).ready ? parseMuseAuthApiKey(authBytes.toString("utf8")) : null;
              if (!key) throw new Error("Provider credential is not ready");
              await aiConnectionService(db).save(context.companyId, context.startedByUserId, managedSession.aiConnection!, key, context.sessionId);
            });
            return;
          }
          const outcome = await adapterLoginStore.withCompanyAdapterPromotionLock(context.companyId, context.startedByUserId, context.adapterType, () =>
            promoteMuseDeviceLoginCredential({
              authBytes, companyId: context.companyId, userInitiated: true,
              isSoleActiveOwner: async () => {
                const row = await adapterLoginStore.get(context.sessionId);
                return row?.status === "promoting" && row.companyId === context.companyId;
              },
              log: (line) => logger.info({ sessionId: context.sessionId }, line),
            }));
          if (outcome !== "promoted") throw new Error(`device-login credential promotion rejected: ${outcome}`);
        },
      },
```

- [ ] **Step 4: Run tests and typecheck the server.**
- [ ] **Step 5: Commit** — `feat(server): Muse sandbox device login (command key, profile, capability, promotion)`.

---

### Task 5: Daytona login PTY, plugin SDK key, and runner image

**Files:**
- Modify: `packages/plugins/sandbox-providers/daytona/src/login-pty.ts` (`LoginCommandKey`, `LOGIN_COMMAND_BY_KEY.muse`, `isLoginCommandKey`, `composeLaunchLine`), `packages/plugins/sdk/src/protocol.ts` (`PluginLoginCommandKey`), `docker/daytona-runner/Dockerfile`
- Test: `packages/plugins/sandbox-providers/daytona/src/login-pty.test.ts`

- [ ] **Step 1: Failing test:**
```ts
  it("launches muse login in an isolated XDG home with the file backend and copies the credential into the session home", () => {
    const home = "/tmp/paperclip-adapter-login/11111111-2222-3333-4444-555555555555";
    expect(composeLaunchLine({ loginCommandKey: "muse", sessionHome: home })).toBe(
      `exec env XDG_CONFIG_HOME='${home}/xdg' XDG_DATA_HOME='${home}/xdg-data' TBH_CREDENTIAL_BACKEND=file MUSE_NO_AUTO_UPDATE=1 sh -c 'muse login </dev/null && install -m 0600 "$XDG_CONFIG_HOME/muse/auth.json" "$0/auth.json"' '${home}'`,
    );
    expect(isLoginCommandKey("muse")).toBe(true);
  });
```
Also extend any exhaustive key test in that file. Read the file's tests first; mirror the grok cases, including "exactly once" and "no CODEX_HOME/GROK_HOME leakage".

- [ ] **Step 2: Run and verify it fails** — `pnpm exec vitest run packages/plugins/sandbox-providers/daytona/src/login-pty.test.ts`. If the Daytona plugin is outside the root vitest projects, run it from its package dir with its own vitest config.

- [ ] **Step 3: Implement.** Add `"muse"` to both unions and to `isLoginCommandKey`, and `muse: "muse login"` to the command map. In `composeLaunchLine`:
```ts
  if (descriptor.loginCommandKey === "muse") {
    const xdg = encodePosixShellArg(`${descriptor.sessionHome}/xdg`);
    const xdgData = encodePosixShellArg(`${descriptor.sessionHome}/xdg-data`);
    // stdin from /dev/null: with a TTY on stdin Muse blocks on "Press Enter to
    // open it in your browser". The copy puts the credential where the host's
    // descriptor-bound reader expects it (<sessionHome>/auth.json).
    return `exec env XDG_CONFIG_HOME=${xdg} XDG_DATA_HOME=${xdgData} TBH_CREDENTIAL_BACKEND=file MUSE_NO_AUTO_UPDATE=1 sh -c '${command} </dev/null && install -m 0600 "$XDG_CONFIG_HOME/muse/auth.json" "$0/auth.json"' ${encodedHome}`;
  }
```
Dockerfile, after the npm install block:
```dockerfile
# Muse Code ships as a launcher script plus a native binary installed next to it.
RUN curl -fsSL https://api.meta.ai/muse-launcher.sh -o /usr/local/bin/muse \
    && chmod 0755 /usr/local/bin/muse \
    && MUSE_LAUNCHER_INSTALL=1 /usr/local/bin/muse
```
Add `muse` to the PATH check loop.

- [ ] **Step 4: Run tests; typecheck the plugin and SDK** (`pnpm --filter <daytona plugin name> typecheck`, `pnpm --filter @paperclipai/plugin-sdk typecheck`).
- [ ] **Step 5: Commit** — `feat(daytona): muse login command key and runner image install`.

---

### Task 6: UI

**Files:**
- Modify: `ui/src/adapters/use-adapter-capabilities.ts` (`muse_local.login = { panelMode: "displayed_code", timeoutPolicy: "caller_bounded" }` matching the grok entry), `ui/src/components/ai-connections/AiConnectionCredentialStep.tsx` (allowlist)
- Test: `ui/src/components/ai-connections/AiConnectionCredentialStep.test.ts`

- [ ] **Step 1: Failing test:** change the Phase 2 expectation to `supportsSandboxDeviceLogin("meta") === true`, add `supportsSandboxDeviceLogin("openrouter") === false`, and add `subscriptionLoginAdapterType` throwing for `openrouter`.
- [ ] **Step 2: Run and verify it fails.**
- [ ] **Step 3: Implement.** Use the allowlist `new Set<AiProvider>(["anthropic", "openai", "xai", "meta"])`. Make `subscriptionLoginAdapterType` an exhaustive switch that throws for providers without a subscription login. Add the capabilities `login` entry.
- [ ] **Step 4: UI tests, typecheck, token gates.**
- [ ] **Step 5: Commit** — `feat(ui): Muse sandbox login affordance`.

---

### Task 7: Verification, live SSH smoke test, docs

- [ ] **Step 1: Targeted suites plus typechecks** (muse-local, shared, server AI/login/registry tests, the Daytona plugin, UI ai-connections/adapters).
- [ ] **Step 2: Live SSH smoke test (ask the user first; it touches chaos-srv).**
  1. Generate a throwaway ed25519 key and append its public key to chaos-srv `~/.ssh/authorized_keys` with the comment `paperclip-muse-smoke`.
  2. Install Muse in a throwaway location on chaos-srv (`/tmp/muse-ssh-smoke/bin`, via the launcher with `MUSE_LAUNCHER_INSTALL=1`) and set the agent `command` to that absolute path.
  3. Create a Paperclip SSH environment (host `100.96.203.28`, the user, `remoteWorkspacePath=/tmp/muse-ssh-smoke/ws`, the throwaway private key). Environment test → hello probe passes.
  4. Run the smoke agent on that environment with the Muse AI connection. Expect a file created on the remote that is synced back locally, and the run to succeed.
  5. **Cleanup:** remove the authorized key line, `rm -rf /tmp/muse-ssh-smoke` on chaos-srv, and delete the environment.
- [ ] **Step 3:** Daytona device login can't be live-tested without a Daytona account. State that in the final report. The unit tests cover the parser, launch line, promotion and wiring.
- [ ] **Step 4: Docs.** Update `doc/connections/AI-CONNECTIONS.md` (sandbox device login now available for Muse), the spec status, the vault note and memory. Commit `docs: muse phase 3`.
