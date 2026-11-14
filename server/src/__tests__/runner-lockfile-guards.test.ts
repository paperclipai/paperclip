import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  LOCKFILE_REFRESH_COMMAND,
  runReleaseRunnerLockfileCheck,
  runnerLockStateAtCommit,
} from "../../../scripts/check-release-runner-lockfile.mjs";
import { RUNNER_IMAGE_CONTEXT_INPUTS } from "../../../scripts/runner-image-identity.mjs";
import { runnerLockState } from "../../../scripts/runner-image-publish.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (...segments: string[]) => readFileSync(path.join(repoRoot, ...segments), "utf8");
const dockerfile = read("Dockerfile");
const scratch = mkdtempSync(path.join(tmpdir(), "runner-lockfile-guards-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function stageBody(name: string): string {
  const froms = [...dockerfile.matchAll(/^FROM .*$/gm)];
  const start = froms.findIndex((match) => match[0].endsWith(` AS ${name}`));
  expect(start, name).toBeGreaterThanOrEqual(0);
  return dockerfile.slice(froms[start].index, froms[start + 1]?.index ?? dockerfile.length);
}

function pnpmArguments(): string[] {
  const context = path.join(scratch, "arguments");
  mkdirSync(path.join(context, "packages", "paperclip-runner"), { recursive: true });
  writeFileSync(path.join(context, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(path.join(context, "packages", "paperclip-runner", "package.json"), "{}\n");
  let seen: string[] = [];
  runnerLockState(context, {
    run: (_command: string, args: string[]) => {
      seen = args;
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  return seen;
}

describe("application image lockfile check", () => {
  const stage = stageBody("runner-lockfile");

  it("runs before the dependency install, which starts from it", () => {
    expect(stage).toContain("FROM base AS runner-lockfile\n");
    expect(stageBody("deps")).toContain("FROM runner-lockfile AS deps\n");
  });

  it("asks pnpm the question the release and publication checks ask", () => {
    const args = pnpmArguments();
    expect(args.at(-1)).toBe("@paperclipai/paperclip-runner...");
    const command = ["pnpm", ...args.slice(0, -1), `'${args.at(-1)}'`].join(" ");
    expect(stage).toContain(`RUN ${command} > /tmp/runner-lockfile.log 2>&1 \\\n`);
    expect(stageBody("runner-artifacts-build")).toContain(`pnpm install --frozen-lockfile --filter '${args.at(-1)}'`);
  });

  it("reads only manifests the Runner build reads", () => {
    const sources = [...stage.matchAll(/^COPY (.+)$/gm)].flatMap((match) => match[1].split(/\s+/).slice(0, -1));
    expect([...sources].sort()).toEqual([
      ".npmrc",
      "package.json",
      "packages/paperclip-eval-kernel/package.json",
      "packages/paperclip-runner/package.json",
      "patches/",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
    ]);
    for (const source of sources) {
      const file = source.replace(/\/$/, "");
      expect(RUNNER_IMAGE_CONTEXT_INPUTS.some((input: string) => file === input || file.startsWith(`${input}/`)), source).toBe(true);
    }
    const manifests = RUNNER_IMAGE_CONTEXT_INPUTS
      .filter((input: string) => existsSync(path.join(repoRoot, input, "package.json")))
      .map((input: string) => `${input}/package.json`);
    expect(sources.filter((source) => source.includes("/") && source.endsWith("package.json")).sort()).toEqual(manifests.sort());
  });

  it("names the stale lockfile and the command that refreshes it", () => {
    expect(stage).toContain("grep -Eq 'ERR_PNPM_OUTDATED_LOCKFILE|ERR_PNPM_LOCKFILE_CONFIG_MISMATCH' /tmp/runner-lockfile.log");
    expect(stage).toContain("ERROR: pnpm-lock.yaml is behind the manifests the Runner is installed from");
    expect(stage).toContain(`Run this command in the checkout, then build again: ${LOCKFILE_REFRESH_COMMAND}" >&2;`);
    expect(stage).toMatch(/exit 1; \}\n/);
    for (const workflow of ["docker.yml", "docker-merge-group.yml", "docker-app-check.yml"]) {
      expect(read(".github", "workflows", workflow), workflow).toContain(`          ${LOCKFILE_REFRESH_COMMAND}\n`);
    }
  });
});

describe("beta and stable release lockfile check", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

  function repository(lockfile = "lockfileVersion: '9.0'\n") {
    const root = mkdtempSync(path.join(scratch, "repository-"));
    for (const input of RUNNER_IMAGE_CONTEXT_INPUTS as readonly string[]) {
      const file = input === "patches" ? "patches/a.patch" : input.startsWith("packages/paperclip-") ? `${input}/package.json` : input;
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), file === "pnpm-lock.yaml" ? lockfile : `${file}\n`);
    }
    mkdirSync(path.join(root, "server"));
    writeFileSync(path.join(root, "server", "index.ts"), "export {};\n");
    git(root, "init", "--quiet");
    git(root, "add", "--all");
    git(root, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "--message", "inputs");
    return root;
  }

  it("checks the Runner inputs of the commit, not the working tree, and removes its copy", () => {
    const root = repository("committed\n");
    writeFileSync(path.join(root, "pnpm-lock.yaml"), "edited after the commit\n");
    writeFileSync(path.join(root, "packages", "paperclip-runner", "untracked.txt"), "untracked\n");
    let context = "";
    const result = runnerLockStateAtCommit({
      repoRoot: root,
      lockState: (directory: string) => {
        context = directory;
        expect(readFileSync(path.join(directory, "pnpm-lock.yaml"), "utf8")).toBe("committed\n");
        expect(existsSync(path.join(directory, "packages", "paperclip-runner", "package.json"))).toBe(true);
        expect(existsSync(path.join(directory, "server"))).toBe(false);
        expect(existsSync(path.join(directory, ".git"))).toBe(false);
        expect(existsSync(path.join(directory, "packages", "paperclip-runner", "untracked.txt"))).toBe(false);
        return runnerLockState(directory, { run: () => ({ status: 1, stdout: "", stderr: " ERR_PNPM_OUTDATED_LOCKFILE  Cannot install" }) });
      },
    });
    expect(result.state).toBe("behind");
    expect(context).not.toBe("");
    expect(existsSync(context)).toBe(false);
  });

  it("fails when the commit lacks an input instead of calling the lockfile current", () => {
    const root = repository();
    git(root, "rm", "--quiet", "pnpm-lock.yaml");
    git(root, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "--message", "no lockfile");
    expect(() => runnerLockStateAtCommit({ repoRoot: root, lockState: () => ({ state: "current" as const, detail: "" }) }))
      .toThrow(/Could not export the Runner's inputs at HEAD/);
    expect(runnerLockStateAtCommit({ repoRoot: root, commit: "HEAD~1", lockState: () => ({ state: "current" as const, detail: "" }) }).state)
      .toBe("current");
  });

  it.each<["current" | "behind", number, RegExp]>([
    ["current", 0, /^pnpm-lock\.yaml at abc123 matches the Runner's manifests\.$/],
    ["behind", 1, /^pnpm-lock\.yaml at abc123 is behind the Runner's manifests \(detail\)\. .*: pnpm install --resolution-only --ignore-scripts --no-frozen-lockfile$/],
  ])("exits for a %s lockfile with %i", (state, status, message) => {
    const lines: string[] = [];
    const checked: { repoRoot: string; commit?: string }[] = [];
    expect(runReleaseRunnerLockfileCheck(["--commit", "abc123"], {
      repoRoot: "/repo",
      check: (input: { repoRoot: string; commit?: string }) => {
        checked.push(input);
        return { state, detail: "detail" };
      },
      log: (line: string) => lines.push(line),
    })).toBe(status);
    expect(checked).toEqual([{ repoRoot: "/repo", commit: "abc123" }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(message);
  });

  it.each([[["--commit"]], [["--ref", "HEAD"]], [["--commit", "HEAD", "extra"]]])("refuses the arguments %j", (argv) => {
    const check = () => {
      throw new Error("must not run");
    };
    expect(runReleaseRunnerLockfileCheck(argv, { check, log: () => {} })).toBe(2);
  });

  it("stops a beta and a stable release, and no other, after the version is printed", () => {
    const release = read("scripts", "release.sh");
    const guard = 'if [ "$channel" = "beta" ] || [ "$channel" = "stable" ]; then\n  require_runner_lockfile_current\nfi\n';
    expect(release.split("require_runner_lockfile_current")).toHaveLength(2);
    const at = release.indexOf(guard);
    expect(at).toBeGreaterThan(release.indexOf('if [ "$print_version_only" = true ]; then'));
    expect(at).toBeGreaterThan(release.indexOf("require_clean_worktree\n"));
    expect(at).toBeLessThan(release.indexOf("==> Step 1/7"));
  });

  it.each([
    ["publish_beta", "needs.select_beta.outputs.sha", "args=(beta --skip-verify)"],
    ["preview_stable", "needs.preflight_stable.outputs.sha", "args=(stable --skip-verify --dry-run)"],
    ["publish_stable", "needs.preflight_stable.outputs.sha", "args=(stable --skip-verify)"],
  ])("runs in %s at the commit the release is built from", (job, sha, args) => {
    const workflow = read(".github", "workflows", "release.yml");
    const start = workflow.indexOf(`\n  ${job}:\n`);
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = workflow.slice(start + 1);
    const body = rest.slice(0, /\n {2}[a-z_]+:\n/.exec(rest)?.index ?? rest.length);
    expect(body.match(/^ {10}ref: .+$/gm)).toEqual([`          ref: \${{ ${sha} }}`]);
    expect(body).toContain(`          ${args}\n`);
    expect(body).toContain('          ./scripts/release.sh "${args[@]}"\n');
  });

  it.each([[0, 0], [1, 1], [2, 1]])("turns exit %i of the check into exit %i of the release", (checkStatus, releaseStatus) => {
    const root = mkdtempSync(path.join(scratch, "release-"));
    mkdirSync(path.join(root, "scripts"));
    writeFileSync(path.join(root, "scripts", "check-release-runner-lockfile.mjs"), `process.exit(${checkStatus});\n`);
    const result = spawnSync("bash", ["-c", 'source "$1"; require_runner_lockfile_current; echo released', "guard", path.join(repoRoot, "scripts", "release-lib.sh")], {
      encoding: "utf8",
      env: { ...process.env, REPO_ROOT: root },
    });
    expect(result.status).toBe(releaseStatus);
    expect(result.stdout.includes("released")).toBe(releaseStatus === 0);
    if (releaseStatus !== 0) expect(result.stderr).toContain("Error: a beta or stable release needs a pnpm-lock.yaml that matches the Runner's manifests at HEAD.");
  });
});
