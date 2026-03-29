import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertRootGateSafety,
  collectVerificationMetadata,
  resolveCandidateCommit,
  writeVerificationMetadata,
} from "./verification-gate.mjs";

function parseArgs(argv) {
  const args = {
    repoRoot: null,
    candidateRef: "HEAD",
    reportFile: null,
    keepWorktree: false,
    skipInstall: false,
    commands: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case "--repo-root":
        args.repoRoot = argv[i + 1] ?? "";
        i += 1;
        break;
      case "--candidate-ref":
        args.candidateRef = argv[i + 1] ?? "";
        i += 1;
        break;
      case "--report-file":
        args.reportFile = argv[i + 1] ?? "";
        i += 1;
        break;
      case "--keep-worktree":
        args.keepWorktree = true;
        break;
      case "--skip-install":
        args.skipInstall = true;
        break;
      case "--command":
        args.commands.push(argv[i + 1] ?? "");
        i += 1;
        break;
      case "-h":
      case "--help":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return args;
}

function printUsage() {
  process.stdout.write(`Usage:\n  node scripts/candidate-gate-runner.mjs [options] --command "<cmd>" [--command "<cmd>" ...]\n\nOptions:\n  --repo-root <path>       Repository root (defaults to script parent)\n  --candidate-ref <ref>    Candidate git ref/commit to verify (default: HEAD)\n  --report-file <path>     Metadata output path (default: report/verification-substrate.json)\n  --skip-install           Skip \"pnpm install --frozen-lockfile\" in candidate worktree\n  --keep-worktree          Keep candidate worktree for debugging\n  -h, --help               Show this help\n`);
}

function runOrThrow(command, args, cwd) {
  const status = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  if (status.error) throw status.error;
  if (status.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${status.status ?? "unknown"}`);
  }
}

function runShellOrThrow(command, cwd, extraEnv) {
  const status = spawnSync(command, {
    cwd,
    shell: true,
    stdio: "inherit",
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
  if (status.error) throw status.error;
  if (status.status !== 0) {
    throw new Error(`Command failed (${status.status ?? "unknown"}): ${command}`);
  }
}

function runGit(repoRoot, args) {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(cli.repoRoot || path.join(scriptDir, ".."));
  const candidateRef = cli.candidateRef || "HEAD";
  const reportFile = path.resolve(cli.reportFile || path.join(repoRoot, "report", "verification-substrate.json"));

  if (cli.commands.length === 0) {
    throw new Error("At least one --command is required.");
  }

  const rootSafety = assertRootGateSafety({
    repoRoot,
    candidateRef,
  });

  const candidateCommit = resolveCandidateCommit(repoRoot, candidateRef);
  const candidateParent = path.join(repoRoot, ".paperclip", "candidate-worktrees");
  await fs.mkdir(candidateParent, { recursive: true });
  const candidateWorktree = await fs.mkdtemp(path.join(candidateParent, "gate-"));

  let worktreeCreated = false;

  try {
    runOrThrow("git", ["-C", repoRoot, "worktree", "add", "--detach", candidateWorktree, candidateCommit], repoRoot);
    worktreeCreated = true;

    if (!cli.skipInstall) {
      runOrThrow("pnpm", ["install", "--frozen-lockfile"], candidateWorktree);
    }

    const gateEnv = {
      PAPERCLIP_VERIFICATION_GATE: "1",
      PAPERCLIP_VERIFICATION_REF: candidateRef,
      PAPERCLIP_VERIFICATION_COMMIT: candidateCommit,
      PAPERCLIP_VERIFICATION_ROOT_DIRTY: rootSafety.rootDirty ? "true" : "false",
      PAPERCLIP_VERIFICATION_PATH: candidateWorktree,
    };

    for (const command of cli.commands) {
      runShellOrThrow(command, candidateWorktree, gateEnv);
    }

    const metadata = collectVerificationMetadata({
      repoRoot,
      verificationPath: candidateWorktree,
      candidateRef,
      rootSafety,
    });

    const metadataWithCommands = {
      ...metadata,
      commands: cli.commands,
      candidateCommit,
      candidateWorktree,
    };

    const writtenPath = await writeVerificationMetadata(reportFile, metadataWithCommands);

    process.stdout.write(`Verification candidate ref: ${candidateRef}\n`);
    process.stdout.write(`Verification candidate commit: ${candidateCommit}\n`);
    process.stdout.write(`Verification worktree: ${candidateWorktree}\n`);
    process.stdout.write(`Verification report: ${writtenPath}\n`);
  } finally {
    if (!cli.keepWorktree && worktreeCreated) {
      try {
        runGit(repoRoot, ["worktree", "remove", "--force", candidateWorktree]);
      } catch {
        // Keep cleanup best-effort so original error remains visible.
      }
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
