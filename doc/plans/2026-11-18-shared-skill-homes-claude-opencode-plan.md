# Shared Skill Homes for Claude (ACPX) and OpenCode — Implementation Plan

> Delivery (2026-11-19): shipped as one standalone pull request from `master` (branch `perf/shared-skill-homes`), independent of PR #22152. References to #22152 below record how the work started; this branch does not contain or need its commits.

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** ACPX Claude and OpenCode launches on Mac/Linux read assigned skills from the shared, sealed skill home instead of copying them per launch.

**Architecture:** The skill home gains `.agents/.claude-plugin/plugin.json` (layout v2). A provider-neutral helper publishes/reuses a home for a provider home and writes the reference marker there. ACPX passes the home to Claude as a local plugin through an environment variable read by the patched `claude-agent-acp`; OpenCode lists it in `skills.paths`. The server passes the store root for these providers too, and the sweep reads their markers.

**Tech Stack:** TypeScript, Vitest, pnpm patches.

**Spec:** `doc/plans/2026-11-18-shared-skill-homes-claude-opencode.md` (approved 2026-11-18).

## Global Constraints

- Same branch and PR as before: `fix/expire-local-provider-homes` (#22152). No stacked PRs.
- Store root, marker file name and schema stay as in the Codex implementation; layout becomes `paperclip.codex-skill-home.v2`.
- Shared skill homes only on Mac/Linux, isolated (not preconfigured) homes, local runner (no `runnerFilesystemRoot`). Grok, Kimi and Windows keep copying.
- Claude plugin name: `paperclip` (skills appear as `paperclip:<skill>`).
- Tests that seal files run in the WSL worktree, one file at a time.

## Review Focus

1. A resumed ACPX Claude session (`session/load`) still gets the plugin option, since the patched agent applies options for every session it creates or loads.
2. An ACPX Claude home that still has an old `claude-home/skills` copy: the launch removes it and Claude does not list a skill twice.
3. OpenCode's per-launch `HOME` is deleted after each launch; the marker must live in its stable state, or the sweep would free a home in use.
4. A v1 home and a v2 home for the same skills coexist until the sweep removes the unreferenced v1 home.
5. The plugin directory path must be absolute and inside the store root before it is passed to Claude.

---

### Task 1: Layout v2 and a provider-neutral preparation helper

**Files:** `packages/paperclip-runner/src/drivers/codex-skill-home.ts`, `runtime-context-materializer.ts`; tests in `codex-skill-home.test.ts`, `codex-skill-home-launch.test.ts`.

**Produces:**
- `CODEX_SKILL_HOME_LAYOUT = "paperclip.codex-skill-home.v2"`; every published home contains `.agents/.claude-plugin/plugin.json` = `{"name":"paperclip","version":"2.0.0","description":"Skills assigned by Paperclip"}` (covered by manifest and stat record).
- `prepareSharedSkillHome(input: { providerHome: string; storeRoot: string; context: NativeRuntimeContextSnapshot; skillsDirectory?: string }): Promise<{ home: string; digest: string }>`: releases `<providerHome>/<skillsDirectory ?? "skills">`, removes abandoned staging in `providerHome`, writes the marker into `providerHome`, ensures the home, touches it. `prepareIsolatedCodexHome` uses it.
- `claudeSkillPluginDirectory(home: string): string` = `<home>/.agents`.

- [ ] Failing tests: a published home has the plugin manifest; tampering with it is detected; `prepareSharedSkillHome` on a provider home with an old `skills/` copy removes it and writes the marker.
- [ ] Implement; run `codex-skill-home*.test.ts` and `runtime-context-materializer.test.ts` (WSL). Commit.

### Task 2: Claude reads the skill home as a local plugin

**Files:** `patches/@agentclientprotocol__claude-agent-acp@0.73.0.patch`, `packages/paperclip-runner/src/drivers/acpx/runtime-host.ts`, `packages/paperclip-runner/src/live/runnerd-codex-transport.ts` (ACPX environment), tests next to them.

- [ ] Patch: in isolated mode, when `PAPERCLIP_CLAUDE_SKILL_PLUGIN_DIR` is an absolute path, add `plugins: [{ type: "local", path }]` to the SDK options (next to `settingSources: ["user"]`). Update the hunk header counts; reinstall in WSL and confirm with the SDK spike that a session lists `paperclip:alpha`.
- [ ] Runtime host (Claude only, not preconfigured, not prepared home): when `options.environment.PAPERCLIP_SKILL_HOME_STORE_ROOT` is set and the platform is not Windows, call `prepareSharedSkillHome({ providerHome: sandbox.agentHomeDirectory, storeRoot, context })` instead of materializing into `<agent home>/skills`, and add `PAPERCLIP_CLAUDE_SKILL_PLUGIN_DIR = claudeSkillPluginDirectory(home)` to the launch environment. Failing test first in the runtime-host tests: no `skills/` copy, environment carries the plugin directory; without the store root, today's copy.
- [ ] Transport: the ACPX provider environment carries `PAPERCLIP_SKILL_HOME_STORE_ROOT` when `codexSkillHomeStoreRoot` is set, the ACPX agent is `claude`, there is no `runnerFilesystemRoot`, and the platform is not Windows. Failing test first. Commit.

### Task 3: OpenCode lists the skill home in `skills.paths`

**Files:** `packages/paperclip-runner/src/drivers/opencode/opencode-server-driver.ts` and its tests.

- [ ] Failing test: with a store root, the generated `opencode.json` has `skills.paths = ["<home>/.agents/skills"]`, the per-launch `HOME/.claude/skills` is not created, and the marker is written to OpenCode's stable session state directory (the directory that holds its XDG data), not the per-launch `HOME`.
- [ ] Implement with `prepareSharedSkillHome`; pass the store root from the transport like for ACPX. Commit.

### Task 4: Server and sweep

**Files:** `server/src/services/native-runtime/native-session-executor.ts`, `codex-skill-home-retention.ts`, `native-harness-backup-expiration.ts`, tests.

- [ ] Failing tests: the sweep keeps a home referenced only by `acpx/acpx/<session>/claude-home/paperclip-skill-home.json` and by an OpenCode marker; the executor passes the store root for local ACPX Claude and OpenCode runs.
- [ ] Implement: `sweepCodexSkillHomes` takes `markerRoots: Array<{ root: string; homes: string[] }>` (Codex `durable-sessions/*/codex-home`, ACPX `acpx/acpx/*/claude-home`, OpenCode state). Commit.

### Task 5: Real turns, measurement, PR

- [ ] With the user's OK, copy the Claude login into a temporary WSL `CLAUDE_CONFIG_DIR`, run one Claude turn through the patched `claude-agent-acp` with the plugin directory: Claude invokes `paperclip:alpha` and reads `scripts/run.sh`; nothing in the skill home changes. Run one OpenCode turn with `skills.paths` if an OpenCode login is available; otherwise record that it was not run.
- [ ] Measure an ACPX Claude launch before/after (disk and skill preparation time) on WSL; add to `doc/benchmarks/2026-11-18-shared-codex-skill-homes.md`; update `doc/recoverable-disk-cleanup.md`.
- [ ] Re-run all affected test files in WSL at the final commit (verify the WSL tree is at that commit), push to `fix/expire-local-provider-homes`, update the #22152 description.
