# Re-port the claude-agent-acp isolation patch to 0.85.1

Date: 2026-10-03
Status: implemented. The re-port, the 0.85.1 bump, and the three verification
layers described in this plan's Verification section (options-capture vitest,
the installation-integrity check, and the opt-in live canary at
`packages/paperclip-runner/src/drivers/acpx/claude-acp-isolation-live-canary.test.ts`)
have shipped. The "Open questions" section below was not fully re-resolved
against the shipped state — treat answers there as still open unless a
follow-up confirms them.
Scope: move `@agentclientprotocol/claude-agent-acp` from 0.73.0 to 0.85.1 and
carry forward `patches/@agentclientprotocol__claude-agent-acp@0.73.0.patch`.

How this was researched: I ran `npm pack` on both versions, diffed
`dist/acp-agent.js`, dry-ran the current patch against 0.85.1, read the
upstream release notes and PRs #1208 and #1216, read issue #1193, and grepped
this repo for every pin.

## TL;DR

1. **Blind re-application is already partly unsafe.** Running `patch -p1` on
   0.85.1 applies 2 of the 4 hunks with fuzz and fails the other 2. The hunks
   that fail are the `settingSources: ["user"]` override and the usage `_meta`
   hunk. Any workflow that accepts fuzzy or partial application therefore
   produces this result: MCP servers are stripped and `allowedTools` is gated,
   **but project and local settings still load.** That is the silent
   half-isolation failure we are guarding against. pnpm's own patch applier
   is strict and should hard-fail in this case. The danger is a human
   re-porting by hand or with `patch --fuzz`, not pnpm itself.
2. **0.85.1 probably does not fix #1193.** In the issue body, the reporter
   (us) bisected 0.75.0, 0.78.0, 0.81.0 and 0.84.0. **All of them hit the same
   "Query closed before response received".** The 0.85.0 and 0.85.1 release
   notes contain nothing aimed at it. The issue is still open with no
   maintainer response. 0.85.1 itself is untested, so validate it before
   paying for the upgrade (see section b).
3. **The upgrade is much larger than re-patching.** The bundled agent SDK
   moves to 0.3.286 (we override it to 0.3.280 today), and Claude Code moves
   to 2.1.286. `@agentclientprotocol/sdk` moves from 1.4.0 to 1.6.0, zod moves
   to 4.6.5, and a new runtime dependency, `diff` 9.0.0, is added. The runner
   pins all of these by version and by sha256 in roughly 8 places (section d).
4. **A correction to the threat model.** In the SDK, `allowedTools` is an
   *auto-approve* list, not a restriction. The SDK's own docs say "To restrict
   which tools are available, use the `tools` option instead." Forcing it to
   `[]` means "auto-approve nothing", so everything else still goes through
   `canUseTool`. It does not mean "no tools". The patch's own comment
   ("Exempt only task delivery/control tools") matches this. Our description
   of hunk 3 should say the same. This is unchanged between SDK 0.3.257 and
   0.3.286.

## (a) What changed upstream in the regions the patch touches

Everything below was checked against the published `dist/`.

| Patch hunk | 0.73.0 location | 0.85.1 location | What changed | Dry-run result |
|---|---|---|---|---|
| 1. usage `_meta` | ~L2922, inline `sendUpdate({ ... })` | ~L4106, now wrapped as `sendUpdate({ update: attachUsageModel({ ... }) })` | Indentation and wrapper changed. The `...(message.origin && { _meta: ... })` line is the same. | **FAILED** |
| 2. `settingSources: ["user"]` | L5311 | L6827 | New lines after `...userProvidedOptions`: `...(fileChangeReporter ? { enableFileCheckpointing: true } : {})` | **FAILED** |
| 3. strip `userProvidedOptions.mcpServers` | L5321 | L6841 | The `FILE_CHANGE_AUDIT_SERVER_NAME` MCP server spread is **gone**, replaced by native `fileChangeReporter`. The `mcpServers` object is now just `{...userProvidedOptions.mcpServers, ...mcpServers}`. | applied with fuzz 2 |
| 4. `allowedTools` gate | after `canUseTool` | same spot | `ALLOW_BYPASS` became the local `allowBypass`, which also respects `disableBypassPermissionsMode` and `_meta...allowDangerouslySkipPermissions === false`. | applied with fuzz 1 |

What did not change and still holds:

- The ACP `mcpServers` → SDK map conversion (`const mcpServers = {}` with
  `type: "http"` and `url`) is byte-for-byte the same, so the
  `mcpServers.paperclip?.type === "http" && .url === BRIDGE_URL` guard still
  works.
- There is still **exactly one `query({ options })` call site** (L6985). Every
  entry path reaches it through `createSession`: new, load, resume, fork,
  reuse-id, provider-change rebuild, and the new `v2/agent.js` wrapper, which
  wraps `ClaudeAcpAgent`. So the patch still covers one choke point.
- `userProvidedOptions` still comes only from `_meta.claudeCode.options`.
  acpx 0.13.1 (`buildClaudeCodeOptionsMeta`) sets only `settingSources`,
  `model`, `allowedTools` and `maxTurns`. Our overrides still spread *after*
  `...userProvidedOptions`.

New in 0.85.1 and relevant to isolation (review these, not covered by the
patch today):

- **`managed-policy.js` / `applyManagedPolicyEnv()`** runs at process start.
  It copies the host's managed-policy tier env (`/etc/claude-code`, MDM,
  registry) into `process.env` **before** our env check runs. A host-managed
  policy could therefore set or clear `PAPERCLIP_ACPX_ISOLATED_CONTEXT`. The
  host admin is arguably trusted, but this is a new input that can change the
  gate. Option: snapshot the env var at module load before
  `applyManagedPolicyEnv`, or have the runner sandbox mask the managed-policy
  path. Also, `settingSources: ["user"]` never blocked the managed tier; that
  was already true in 0.73.0.
- **Rebuild-on-resume** (`OPTION_REBUILDS_SESSION`): load and resume now
  rebuild the Query, still through `createSession`, so the patch applies.
  This needs test coverage because it is a new path.
- The SDK `Options` surface grew: `plugins`, `pluginDelivery`, `skills`,
  `projectConfigRoot`, `managedSettings`, `strictMcpConfig`, and others. All
  of them can arrive through `...userProvidedOptions`. acpx does not forward
  them today, so the risk is low. Still, if the isolated path should be
  fail-closed, consider deleting `plugins`, `projectConfigRoot` and
  `managedSettings` from `userProvidedOptions` too. This is a
  defence-in-depth decision for whoever owns the boundary.

## (b) Does 0.85.1 fix #1193?

**Unknown, and probably not on its own.**

- Issue #1193 (opened 2026-09-29 by us, still open, no maintainer reply)
  reports the same crash on 0.75.0, 0.78.0, 0.81.0 and 0.84.0. Only 0.73.0
  showed a different symptom ("terminal access failure").
- 0.85.0 and 0.85.1 ship these changes:
  - the SDK 0.3.286 bump
  - #1208, which adapts to SDK 0.3.284 replay and ultracode changes after the
    CLI 2.1.284 bump
  - #1216, so that `session/close` no longer awaits the interrupt reply
  - #1212, which fails turns with unfinished tools
  - #1205, a replay fix

  None of them targets a query closing right after `sdk-initialize`.
- **Hypothesis, unverified:** the issue notes the host CLI reporting
  2.1.280 / 2.1.282 / 2.1.284 run-to-run, against a bundled SDK of 0.3.280.
  0.85.x is the first line that is built and tested against CLI 2.1.284+
  (#1189/#1208). If the crash comes from SDK↔CLI version skew, aligning the
  SDK (0.3.286) with a pinned CLI could help. The fix would come from that
  alignment, not from an adapter change.
- **Cheap test before committing to the full re-port:** run Jarvis's failing
  task once against stock 0.85.1 by pointing the `claude_local` adapter's
  `agentCommand` at a scratch install (`npx
  @agentclientprotocol/claude-agent-acp@0.85.1`) with `CLAUDE_CODE_EXECUTABLE`
  set to a pinned CLI. **Use a non-isolated, throwaway agent and company only.**
  Stock 0.85.1 has no isolation gate, so never point it at the runner's
  isolated path. If it still dies, the upgrade does not buy #1193, and the
  re-port can be scheduled on its own merits.

## (c) Re-port plan

### Procedure

1. On a branch, bump the 4 manifest pins together with everything listed in
   section d.
2. `pnpm patch @agentclientprotocol/claude-agent-acp@0.85.1`, then
   **re-implement each hunk by hand from its intent**. Do not apply the old
   diff with `patch`, `--fuzz` or `git apply --3way`.
   - Hunk 1: wrap the `_meta` inside the `attachUsageModel({...})` argument.
   - Hunk 2: put the `settingSources` override immediately after
     `...userProvidedOptions` and before the `enableFileCheckpointing`
     spread.
   - Hunk 3: drop the old `FILE_CHANGE_AUDIT` context. The new block is
     `{ ...(ISOLATED ? {} : userProvidedOptions?.mcpServers || {}), ...mcpServers }`.
   - Hunk 4: keep it after `canUseTool`, with context on `allowBypass`.
3. `pnpm patch-commit`, which writes `patches/@agentclientprotocol__claude-agent-acp@0.85.1.patch`.
   Delete the 0.73.0 patch and its `patchedDependencies` entries **in the
   same commit**.
4. **Do not set `ignorePatchFailures` or `allowUnusedPatches`.** Today neither
   is set, so pnpm hard-fails on a bad hunk and on a patch key that matches
   nothing. Add a contract assertion that they stay unset.
5. Decide the managed-policy question and the extra-option stripping question
   from section a.

### Verification: prove the gate, not that it compiles

Today's only guard (`acpx-codex-package-contract.test.mjs` → "the Claude
patch removes ambient project and local configuration") greps the **patch
file text**. It would pass on the half-applied output from the dry run.
Replace or augment it with three layers.

1. **Static check on the installed artifact.** This is a new node test in the
   runner. Resolve the *installed*
   `@agentclientprotocol/claude-agent-acp/dist/acp-agent.js`, then assert:
   - `package.json.version === "0.85.1"`.
   - The `const options = {` … `const q = query({` slice inside
     `createSession` contains each of the three gates. For each one, assert
     its position relative to the anchors: the `settingSources: ["user"]`
     override comes after `...userProvidedOptions,`, the `mcpServers` strip
     comes inside `mcpServers: {`, and `allowedTools` comes after
     `...userProvidedOptions`.
   - The file has exactly one `query({` call site. If upstream adds a second
     one, the test fails and forces a review.

2. **Behavioural test with options capture (the key one).** This is a vitest
   in `packages/paperclip-runner`. It runs against the real patched package
   with `vi.mock("@anthropic-ai/claude-agent-sdk")`, so that `query()`
   records its `options` and then throws. Instantiate `ClaudeAcpAgent`, which
   is exported from `lib.js`, with a stub ACP client, and call `newSession`.
   The matrix:

   | Isolation env | ACP `mcpServers` | `_meta.claudeCode.options` | Expected `options` |
   |---|---|---|---|
   | `=1` | paperclip http, URL == `BRIDGE_URL` | `settingSources:["user","project","local"]`, `mcpServers:{canary}`, `allowedTools:["Bash"]` | `settingSources` deep-equals `["user"]`; no `canary` key; `allowedTools` deep-equals the 4 `mcp__paperclip__*` |
   | `=1` | paperclip http, URL ≠ `BRIDGE_URL` | same | `allowedTools` deep-equals `[]` |
   | `=1` | paperclip stdio | same | `allowedTools` deep-equals `[]` |
   | `=1` | none, `BRIDGE_URL` unset | same | `allowedTools` deep-equals `[]` (no `undefined === undefined` pass) |
   | unset | any | same | upstream behaviour: `canary` present, `settingSources` from meta. This proves the test discriminates. |

   Repeat row 1 through `loadSession` and `resumeSession`, which take the
   rebuild path.

   **Mutation check:** run the suite once against an *unpatched* 0.85.1 (or
   with the patch reverted) and confirm that every isolated row fails. A
   gate test that passes on unpatched code is worthless.

3. **Live canary smoke.** This is opt-in, like the existing local-provider
   smoke. In a runner sandbox, plant the following in the task cwd:
   - `.claude/settings.local.json` declaring a canary stdio MCP server and a
     canary hook
   - `.claude/skills/canary/SKILL.md`
   - `CLAUDE.md` containing a canary string

   Run one isolated turn and check the SDK `system/init` message and the run
   log. Neither the canary MCP server nor the canary skill should appear, and
   the prompt should not contain the canary string. I have not verified which
   fields `system/init` exposes in SDK 0.3.286. Confirm that before relying
   on it.

## (d) Other call sites that must move with the upgrade

These are in addition to `package.json:112`, `pnpm-workspace.yaml:23`,
`packages/paperclip-runner/package.json:166` and
`packages/adapters/claude-local/package.json:56`.

- `package.json:124` and `pnpm-workspace.yaml:36` hold the SDK override keyed
  `claude-agent-acp@0.73.0>…`. After a version bump this key **silently stops
  matching**, so the SDK resolves to 0.85.1's own `0.3.286`. Decide on
  purpose: drop the override, or re-key it.
- `packages/paperclip-runner/src/drivers/acpx/installation-integrity.ts`:
  - L47–70: SDK version and per-platform `executableDigest` sha256s for the
    `claude` binary. All three need new digests for 0.3.286.
  - L87–110: `QUALIFIED_CLAUDE_PROVIDER_DEPENDENCIES` lists exactly
    `@agentclientprotocol/sdk@1.4.0`, the SDK (`dependencyDeclaration:
    "0.3.257"`) and `zod@4.4.3`. 0.85.1 needs sdk 1.6.0, `dependencyDeclaration`
    0.3.286, zod 4.6.5 (exact, no longer `^4.0.0`), and **a new `diff@9.0.0`
    entry**. Without it, the provider either fails to resolve `diff` under
    the pinned graph or needs ambient `node_modules` access.
- `packages/paperclip-runner/src/drivers/acpx/qualified-profiles.ts:65-68`:
  `agentServerVersion` and `agentRuntimeVersion`.
- `packages/paperclip-runner/runner/crates/runner-core/src/acpx_provider_backend.rs:151-156`
  and `:1860-1863`: the version tuple plus the profile digest
  `sha256:9d73d1f0…`, which must be regenerated.
- `server/src/services/native-runtime/native-session-executor.ts:9266`: the
  `REMOTE_PROVIDER_PACK_PINS.claudeAcp` value, plus the `claude` profile
  digest at about L9276.
- `docker/daytona-runner/Dockerfile:140,143` (`claude --version`,
  `claude-agent-acp --version` assertions) and `docker/daytona-runner/README.md:18`.
- `packages/paperclip-runner/scripts/build-provider-pack.mjs:177-194`: check
  that the pack copies `diff`.
- Tests that hard-code 0.3.280, 2.1.280 or 0.73.0:
  - `installation-integrity.test.ts`
  - `native-backend-factory.test.ts`
  - `test/acpx-codex-package-contract.test.mjs` (L31, 63, 120–137)
  - claude-local's `execute.remote.test.ts`, `test.*.test.ts` and
    `index.test.ts`, but only if the minimum CLI changes. The Opus 5.5
    minimum of 2.1.280 can stay.
- `packages/paperclip-runner/src/drivers/acpx/usage-accounting.ts` reads
  `input_tokens`, `output_tokens` and the cache fields. Keep hunk 1's field
  names identical. Upstream 0.85.1 still does not emit the input/output split
  in `_meta`, so hunk 1 is still needed.
- **No code reads claude-agent-acp's internal exports.** The repo only
  resolves its `bin` and `package.json` and spawns it over ACP. Its
  `exports` and `bin` are the same in 0.85.1.

### acpx coupling

- `acpx@0.13.1` speaks ACP through `@agentclientprotocol/sdk` (`^1.3.0`,
  resolved 1.4.0). 0.85.1 uses 1.6.0. They are the same major version and
  v1 wire protocol, so this should be compatible, but **I have not verified
  it**. Exercise it in the behavioural and live tests.
- acpx's patch and `buildClaudeCodeOptionsMeta` depend only on
  `_meta.claudeCode.options` (`settingSources`, `model`, `allowedTools`,
  `maxTurns`) and `isClaudeAcpCommand`. Both still exist and behave the same
  in 0.85.1.
- acpx's version is pinned at `REMOTE_PROVIDER_PACK_PINS.acpx`. It does not
  need to move for this upgrade.

## Open questions

- Does `pnpm@9.15.4` apply patches strictly, with no fuzz? I believe so, but
  confirm by checking that `pnpm install` fails with the old patch keyed to
  0.85.1.
- Should host managed-policy env be able to influence the isolation gate?
- Should the isolated path also strip `plugins`, `projectConfigRoot` and
  `managedSettings` from `userProvidedOptions`?
- Is 0.85.1 worth the upgrade cost if the stock-0.85.1 #1193 test still
  fails?
