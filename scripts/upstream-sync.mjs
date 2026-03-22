#!/usr/bin/env node
/**
 * upstream-sync.mjs
 *
 * Keeps the wopr-network/paperclip fork rebased on paperclipai/paperclip upstream
 * and ensures all upstream UI additions are gated behind hostedMode.
 *
 * In hosted mode, the platform controls inference — users never see adapter
 * selection, model picking, or infrastructure details. This script:
 *
 *   1. Fetches upstream and checks for new commits
 *   2. Rebases our hosted-mode commits on top
 *   3. Resolves any rebase conflicts (via Agent SDK)
 *   4. Scans for new UI elements that leak infra without hostedMode guards
 *   5. Fixes gaps (via Agent SDK)
 *   6. Runs a build check
 *   7. Pushes or creates a PR
 *
 * Usage:
 *   node scripts/upstream-sync.mjs [options]
 *
 * Options:
 *   --dry-run   Report gaps but don't fix or push
 *   --push      Force-push master after sync
 *   --pr        Create a PR instead of pushing
 *   --scan-only Just scan for hostedMode gaps, no rebase
 *
 * Requires:
 *   - ANTHROPIC_API_KEY env var
 *   - @anthropic-ai/claude-agent-sdk (npm install)
 *   - git remotes: origin (wopr-network), upstream (paperclipai)
 */

import { execSync } from "node:child_process";
import { existsSync, appendFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const CWD = process.cwd();
const DRY_RUN = process.argv.includes("--dry-run");
const AUTO_PUSH = process.argv.includes("--push");
const CREATE_PR = process.argv.includes("--pr");
const SCAN_ONLY = process.argv.includes("--scan-only");

// Agent event log — saved as CI artifact
// Write to /tmp first, copy to CWD at end (avoid dirtying the working tree before git status check)
const AGENT_LOG_TMP = join("/tmp", `agent-events-${Date.now()}.log`);
const AGENT_LOG_PATH = join(CWD, "agent-events.log");
writeFileSync(AGENT_LOG_TMP, `=== upstream-sync agent log — ${new Date().toISOString()} ===\n`);

function logEvent(phase, event) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${phase}] ${JSON.stringify(event)}\n`;
  appendFileSync(AGENT_LOG_TMP, line);
}

function flushLog() {
  try {
    copyFileSync(AGENT_LOG_TMP, AGENT_LOG_PATH);
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

function run(cmd) {
  return execSync(cmd, { cwd: CWD, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function tryRun(cmd) {
  try {
    return { ok: true, output: run(cmd) };
  } catch (e) {
    return { ok: false, output: (e.stderr || e.message || "").trim() };
  }
}

function log(msg) {
  console.log(`[upstream-sync] ${msg}`);
}

function die(msg) {
  flushLog();
  console.error(`[upstream-sync] FATAL: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Agent SDK wrapper
// ---------------------------------------------------------------------------

let _query;

async function loadSdk() {
  if (_query) return;

  // Try local, then global (with explicit ESM entry point)
  const globalRoot = execSync("npm root -g", { encoding: "utf-8" }).trim();
  const candidates = [
    "@anthropic-ai/claude-agent-sdk",
    `${globalRoot}/@anthropic-ai/claude-agent-sdk/sdk.mjs`,
  ];

  for (const candidate of candidates) {
    try {
      const sdk = await import(candidate);
      _query = sdk.query;
      return;
    } catch {
      // try next
    }
  }

  die(
    "@anthropic-ai/claude-agent-sdk not installed.\n" +
      "  npm install -g @anthropic-ai/claude-agent-sdk\n" +
      "  npm install -g @anthropic-ai/claude-code",
  );
}

async function runAgent(prompt, opts = {}) {
  await loadSdk();
  const phase = opts.phase ?? "unknown";
  const tools = opts.tools ?? ["Read", "Edit", "Write", "Bash", "Glob", "Grep"];
  let result = "";
  let turnCount = 0;

  log(`Agent [${phase}] starting (model: ${opts.model ?? "claude-sonnet-4-6"}, maxTurns: ${opts.maxTurns ?? 60})`);
  logEvent(phase, { type: "agent_start", model: opts.model, maxTurns: opts.maxTurns ?? 60 });

  for await (const message of _query({
    prompt,
    options: {
      cwd: CWD,
      allowedTools: tools,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: opts.maxTurns ?? 60,
      model: opts.model ?? "claude-sonnet-4-6",
    },
  })) {
    // Log every event type from the SDK
    if (message.type === "tool_use") {
      turnCount++;
      logEvent(phase, { type: "tool_use", turn: turnCount, tool: message.tool, input_preview: JSON.stringify(message.input).slice(0, 200) });
    } else if (message.type === "text") {
      logEvent(phase, { type: "text", preview: (message.text || "").slice(0, 300) });
    } else if ("result" in message) {
      result = message.result;
      logEvent(phase, { type: "result", preview: result.slice(0, 500) });
    } else {
      // Log any other event types we haven't explicitly handled
      logEvent(phase, { type: message.type || "unknown", keys: Object.keys(message) });
    }
  }

  log(`Agent [${phase}] finished after ${turnCount} tool calls`);
  logEvent(phase, { type: "agent_done", turnCount });

  return result;
}

// ---------------------------------------------------------------------------
// Hosted-mode context (shared across agent prompts)
// ---------------------------------------------------------------------------

const HOSTED_MODE_CONTEXT = `
## Context: Hosted Mode

This is a fork of Paperclip (paperclipai/paperclip) maintained by wopr-network.
The fork adds "hosted mode" — when enabled, the platform controls all inference.
Users should NEVER see:

- Adapter type selection (Claude Local, Codex, Gemini, OpenCode, Pi, Cursor, OpenClaw Gateway)
- Model selection / model dropdowns
- Thinking effort controls
- Runtime/heartbeat configuration
- Provider settings or API key fields
- CLI command configuration
- "Advanced configuration" that exposes adapter internals
- Instance Settings page (heartbeat toggles)

## The Guard Pattern (already used in 30+ places)

\`\`\`tsx
import { healthApi } from "../api/health";
import { queryKeys } from "../lib/queryKeys";

// Inside the component:
const healthQuery = useQuery({
  queryKey: queryKeys.health,
  queryFn: () => healthApi.get(),
  retry: false,
});
const isHosted = healthQuery.data?.hostedMode === true;

// Guard render:
{!isHosted && <InfraComponent />}

// Or for props:
hostedMode={isHosted}
\`\`\`

## Files Already Guarded (reference examples)
- ui/src/components/AgentConfigForm.tsx — hides Adapter + Permissions sections
- ui/src/components/Layout.tsx — skips onboarding trigger
- ui/src/components/NewAgentDialog.tsx — hides "advanced configuration" link
- ui/src/components/NewIssueDialog.tsx — suppresses assignee overrides
- ui/src/components/SidebarAgents.tsx — hides "+" new agent button
- ui/src/components/CommandPalette.tsx — hides "Create new agent" command
- ui/src/pages/Agents.tsx — hides "New Agent" button
- ui/src/pages/AgentDetail.tsx — passes hostedMode to config form
- ui/src/pages/NewAgent.tsx — checks isHosted
- ui/src/pages/InstanceSettings.tsx — redirects to / in hosted mode
- ui/src/App.tsx — suppresses OnboardingWizard

## Important: What NOT to guard
- Adapter config field files (ui/src/adapters/*) — these render inside AgentConfigForm which is already guarded
- Type definitions, API clients, context providers, lib utilities
- Test files
- Components that only appear as children of already-guarded parents
`;

// ---------------------------------------------------------------------------
// Rebase
// ---------------------------------------------------------------------------

async function rebase() {
  log("Fetching upstream...");
  run("git fetch upstream");

  const behind = parseInt(run("git rev-list HEAD..upstream/master --count"), 10);
  const ahead = parseInt(run("git rev-list upstream/master..HEAD --count"), 10);

  if (behind === 0) {
    log("Already up to date with upstream.");
    return { rebased: false, behind: 0, ahead };
  }

  log(`Behind upstream by ${behind} commits, ahead by ${ahead} commits.`);

  // Backup
  const datestamp = new Date().toISOString().slice(0, 10);
  const backupBranch = `backup/pre-sync-${datestamp}`;
  tryRun(`git branch -D ${backupBranch}`);
  run(`git branch ${backupBranch}`);
  log(`Backup: ${backupBranch}`);

  // Attempt rebase
  log("Rebasing onto upstream/master...");
  const rebaseResult = tryRun("git rebase upstream/master");

  if (rebaseResult.ok) {
    log("Rebase succeeded cleanly.");
    return { rebased: true, behind, ahead };
  }

  // Conflicts — invoke agent
  log("Rebase has conflicts. Invoking agent to resolve...");

  const conflicting = tryRun("git diff --name-only --diff-filter=U");
  const conflictFiles = conflicting.ok ? conflicting.output : "unknown";

  await runAgent(
    `You are resolving git rebase conflicts in a Paperclip fork.

${HOSTED_MODE_CONTEXT}

## Conflict Resolution Rules

1. TAKE all of upstream's functional changes (new features, bug fixes, refactors, new data models)
2. REAPPLY our hostedMode guards on top of upstream's changes
3. If upstream refactored a data model we were guarding (e.g. renamed a variable), adapt our guard to the new model
4. Never drop upstream functionality — only add hosted-mode conditionals around infra UI

## Current Conflicts

These files have conflicts:
${conflictFiles}

## Steps

1. For each conflicting file, read it and find the conflict markers (<<<<<<< / ======= / >>>>>>>)
2. Resolve each conflict following the rules above
3. Run: git add <resolved-file>
4. After ALL conflicts are resolved, run: git rebase --continue
5. If new conflicts appear, repeat
6. Continue until the rebase completes

IMPORTANT: Do NOT use git rebase --abort. Resolve all conflicts.`,
    { model: "claude-sonnet-4-6", maxTurns: 80, phase: "rebase-conflicts" },
  );

  // Verify rebase completed
  const status = tryRun("git rebase --show-current-patch");
  if (status.ok) {
    die("Rebase still in progress after agent intervention. Manual resolution needed.");
  }

  log("Rebase completed after conflict resolution.");
  return { rebased: true, behind, ahead };
}

// ---------------------------------------------------------------------------
// Hosted-mode gap scanner
// ---------------------------------------------------------------------------

function scanForHostedModeGaps() {
  // Find component/page .tsx files that reference infra keywords
  // but don't have hostedMode/isHosted guards
  const infraKeywords = [
    "adapterType",
    "AdapterType",
    "ADAPTER_OPTIONS",
    "adapter_type",
    "modelOverride",
    "ModelSelect",
    "thinkingEffort",
    "ThinkingEffort",
    "heartbeatEnabled",
    "heartbeat.*toggle",
    "runtimeConfig",
    "runtime_config",
    "deploymentMode.*local",
    "initializeBoardClaim",
    "CompanySettings",
    "CompanySwitcher",
    "InviteLanding",
    "createInvite",
    "inviteLink",
    "joinRequest",
    "boardClaim",
    "BoardClaim",
    "manageMembers",
  ];

  const pattern = infraKeywords.join("|");
  const searchDirs = ["ui/src/components", "ui/src/pages"];

  const gaps = [];

  for (const dir of searchDirs) {
    if (!existsSync(`${CWD}/${dir}`)) continue;

    // Find files with infra patterns
    const infraResult = tryRun(
      `grep -rl --include="*.tsx" -E '(${pattern})' ${dir}`,
    );
    if (!infraResult.ok || !infraResult.output) continue;

    const infraFiles = infraResult.output.split("\n").filter(Boolean);

    for (const file of infraFiles) {
      // Skip test files
      if (file.includes("__tests__") || file.includes(".test.")) continue;

      // Skip files that are children of guarded parents (adapter config fields)
      if (file.includes("/adapters/")) continue;
      if (file.includes("/transcript/")) continue;

      // Skip non-component files (primitives, defaults, help text)
      if (file.includes("primitives")) continue;
      if (file.includes("defaults")) continue;

      // Skip components whose parent already guards them
      if (file.includes("OnboardingWizard")) continue; // suppressed by App.tsx
      if (file.includes("LiveRunWidget")) continue;    // passes adapterType as data, doesn't render it

      // Check if file has hostedMode guard
      const hasGuard = tryRun(`grep -l 'hostedMode\\|isHosted' ${file}`);
      if (!hasGuard.ok) {
        gaps.push(file);
      }
    }
  }

  return gaps;
}

// ---------------------------------------------------------------------------
// Fix hosted-mode gaps
// ---------------------------------------------------------------------------

async function fixHostedModeGaps(gaps) {
  if (gaps.length === 0) return;

  const fileList = gaps.map((f) => `- ${f}`).join("\n");

  await runAgent(
    `You need to add hostedMode guards to UI components in a Paperclip fork.

${HOSTED_MODE_CONTEXT}

## Files With Missing Guards

These files reference adapter/model/infra elements but have NO hostedMode guard:

${fileList}

## Your Task

For each file:
1. Read the file
2. Identify which elements expose infra to the user (adapter pickers, model selectors, settings controls, "new agent" buttons, etc.)
3. Add the hostedMode guard following the exact pattern shown above
4. If the file is a page that should be entirely hidden in hosted mode (like InstanceSettings), add a redirect: \`if (isHosted) return <Navigate to="/" replace />;\`
5. If the file has buttons/links that let users create agents manually, hide them in hosted mode
6. If the file is a component that only renders inside an already-guarded parent, note it and SKIP — don't add redundant guards

After fixing all files, verify no TypeScript imports are missing.
Do NOT modify files that don't need changes.`,
    { model: "claude-sonnet-4-6", phase: "hostedmode-fix" },
  );
}

// ---------------------------------------------------------------------------
// Build check
// ---------------------------------------------------------------------------

async function buildCheck() {
  log("Running build check...");

  // Check if there's a tsconfig in ui/
  const hasTsconfig = existsSync(`${CWD}/ui/tsconfig.json`);

  // Ensure dependencies are installed (CI has no node_modules after rebase)
  if (hasTsconfig) {
    log("Installing UI dependencies...");
    const install = tryRun("cd ui && npm install --ignore-scripts 2>&1");
    if (!install.ok) {
      log(`Warning: npm install failed: ${install.output.slice(0, 500)}`);
    }
  }

  const buildCmd = hasTsconfig
    ? "cd ui && npx tsc --noEmit 2>&1"
    : "npx tsc --noEmit 2>&1";

  const result = tryRun(buildCmd);

  if (result.ok) {
    log("Build check passed.");
    return true;
  }

  log("Build check failed. Invoking agent to fix type errors...");

  await runAgent(
    `The TypeScript build is failing after an upstream sync + hostedMode guard additions.

Fix the type errors. The build output:

\`\`\`
${result.output.slice(0, 3000)}
\`\`\`

Common issues:
- Missing imports (healthApi, queryKeys, Navigate, useQuery)
- Type mismatches from upstream refactors
- JSX conditional rendering syntax errors

Fix each error. Do NOT remove hostedMode guards to fix errors — fix the guard implementation instead.`,
    { model: "claude-sonnet-4-6", phase: "build-fix" },
  );

  // Re-check
  const recheck = tryRun(buildCmd);
  if (!recheck.ok) {
    log("Build still failing after agent fix. Manual intervention needed.");
    log(recheck.output.slice(0, 1000));
    return false;
  }

  log("Build check passed after fixes.");
  return true;
}

// ---------------------------------------------------------------------------
// Push / PR
// ---------------------------------------------------------------------------

function pushOrPr() {
  if (DRY_RUN) {
    log("Dry run — skipping push.");
    return;
  }

  // Configure git to use GH_TOKEN for push auth (self-hosted runners have stale cached creds)
  const ghToken = process.env.GH_TOKEN;
  if (ghToken) {
    // Disable any credential helper that might override URL-embedded token
    tryRun("git config --local --unset-all credential.helper");
    tryRun("git config --local credential.helper ''");
    run(`git remote set-url origin https://x-access-token:${ghToken}@github.com/wopr-network/paperclip.git`);
    log("Configured origin remote with GH_TOKEN for push auth.");
  }

  if (AUTO_PUSH) {
    log("Force-pushing to origin/master...");
    run("git push --force-with-lease origin master");
    log("Pushed successfully.");
  } else if (CREATE_PR) {
    const datestamp = new Date().toISOString().slice(0, 10);
    const branch = `sync/upstream-${datestamp}`;
    tryRun(`git branch -D ${branch}`);
    run(`git checkout -b ${branch}`);
    run(`git push -u origin ${branch} --force-with-lease`);

    const prBody = [
      "## Automated upstream sync",
      "",
      `Rebased our hosted-mode commits onto upstream/master.`,
      "",
      "### What this does",
      "- Pulls in latest upstream changes (features, bug fixes, refactors)",
      "- Resolves any rebase conflicts (preserving hostedMode guards)",
      "- Scans for new UI elements that leak infra without hostedMode guards",
      "- Fixes any gaps found",
      "",
      "### Verify",
      "- [ ] Build passes",
      "- [ ] hostedMode still hides all infra UI",
      "- [ ] No adapter/model selection visible in hosted mode",
    ].join("\n");

    const pr = tryRun(
      `gh pr create --title "sync: rebase on upstream (${datestamp})" --body "${prBody.replace(/"/g, '\\"')}" --base master`,
    );
    if (pr.ok) {
      log(`PR created: ${pr.output}`);
    } else {
      log(`PR creation failed: ${pr.output}`);
    }

    // Switch back to master
    run("git checkout master");
  } else {
    log("Sync complete. Use --push to force-push or --pr to create a PR.");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Verify we're in the right repo
  const remotes = tryRun("git remote -v");
  if (!remotes.output.includes("paperclip")) {
    die("Not in a paperclip repo. Run from ~/paperclip.");
  }

  if (!tryRun("git remote get-url upstream").ok) {
    die("No 'upstream' remote. Add with: git remote add upstream https://github.com/paperclipai/paperclip.git");
  }

  // Ensure clean working tree (skip for scan-only which doesn't modify git)
  if (!SCAN_ONLY) {
    const status = run("git status --porcelain");
    if (status) {
      die("Working tree is dirty. Commit or stash changes first.");
    }
  }

  if (!SCAN_ONLY) {
    // Rebase
    const { rebased, behind } = await rebase();

    if (!rebased && behind === 0) {
      // Still scan for gaps even if up to date
      log("Checking for hostedMode gaps anyway...");
    }
  }

  // Scan
  const gaps = scanForHostedModeGaps();

  if (gaps.length > 0) {
    log(`Found ${gaps.length} file(s) with potential hostedMode gaps:`);
    for (const gap of gaps) log(`  ${gap}`);

    if (!DRY_RUN) {
      await fixHostedModeGaps(gaps);

      // Re-scan to verify
      const remaining = scanForHostedModeGaps();
      if (remaining.length > 0) {
        log(`${remaining.length} gap(s) remain after fix:`);
        for (const r of remaining) log(`  ${r}`);
      } else {
        log("All gaps fixed.");
      }
    }
  } else {
    log("No hostedMode gaps detected.");
  }

  // Build check
  if (!DRY_RUN && !SCAN_ONLY) {
    const buildOk = await buildCheck();
    if (!buildOk) {
      die("Build failed. Not pushing.");
    }
  }

  // Generate changelogs
  if (!DRY_RUN && !SCAN_ONLY) {
    log("Generating changelogs...");
    const changelogResult = tryRun("node scripts/generate-changelog.mjs");
    if (changelogResult.ok) {
      log("Changelog generation succeeded.");
    } else {
      log(`Changelog generation failed (non-fatal): ${changelogResult.output.slice(0, 500)}`);
    }
  }

  // Commit any gap fixes + changelogs
  if (!DRY_RUN && !SCAN_ONLY) {
    const fixedFiles = run("git status --porcelain");
    if (fixedFiles) {
      log("Committing hostedMode gap fixes and changelogs...");
      run("git add ui/src/");
      run("git add changelogs/");
      tryRun(
        `git commit -m "fix: add hostedMode guards for new upstream UI elements"`,
      );
    }

    pushOrPr();
  }

  // Copy agent log to CWD for artifact upload
  flushLog();

  log("Done.");
}

main().catch((err) => {
  flushLog();
  console.error(err);
  process.exit(1);
});
