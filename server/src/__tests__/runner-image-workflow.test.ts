import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RUNNER_IMAGE_CONTEXT_INPUTS } from "../../../scripts/runner-image-identity.mjs";

/**
 * Security properties of the Runner image workflow. The build runs dependency
 * lifecycle scripts and the workflow publishes a signed image, so what each
 * job may do matters more than how its steps are worded: these tests pin
 * permissions, credentials and gating, not step names or order.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "runner-image.yml"), "utf8");
const mergeReview = readFileSync(path.join(repoRoot, ".github", "workflows", "pr-merge-review.yml"), "utf8");
const smoke = readFileSync(path.join(repoRoot, "docker", "runner-image", "Dockerfile.smoke"), "utf8");

/** Each job's text, by name. */
const jobs = Object.fromEntries(workflow.slice(workflow.indexOf("\njobs:\n")).split(/\n(?= {2}[a-z_-]+:\n)/).slice(1)
  .map((text) => [/^ {2}([a-z_-]+):/.exec(text)![1], text]));
const permissions = (job: string) =>
  [.../\n {4}permissions:\n((?: {6}.+\n)+)/.exec(job)![1].matchAll(/^ {6}([a-z-]+): (\w+)/gm)].map((match) => `${match[1]}: ${match[2]}`);
/** The shell of every `run:`, block or single line. */
const scripts = [...workflow.matchAll(/^( +)run: (\|\n((?:\1 {2,}.*\n|\n)+)|.+\n)/gm)].map((match) => match[3] ?? match[2]);

describe("Runner image workflow", () => {
  const repository = "github.repository == 'paperclipai/paperclip' && github.repository_id == '1170821064'";
  const canonical = `${repository} && github.event_name == 'push' && github.ref == 'refs/heads/master'`;
  const jobCondition = (job: string) => /^ {4}if: (.+)$/m.exec(job)?.[1] ?? "";
  /** The steps of a job, without the job's own header. */
  const steps = (job: string) => job.slice(job.indexOf("\n    steps:\n")).split(/\n(?= {6}- )/).slice(1);
  const credential = /github\.token|secrets\.|GITHUB_TOKEN|REGISTRY_PASSWORD/;

  it("lets only the publish job write images or sign, and only the cache job write the build cache, never the Actions cache", () => {
    expect(workflow).toMatch(/^permissions: \{\}$/m);
    expect(Object.keys(jobs)).toEqual(["identity", "build", "publish", "cache"]);
    expect(permissions(jobs.identity)).toEqual(["contents: read", "packages: read"]);
    expect(permissions(jobs.build)).toEqual(["contents: read", "packages: read"]);
    expect(permissions(jobs.publish)).toEqual(["contents: read", "packages: write", "id-token: write", "attestations: write"]);
    expect(permissions(jobs.cache)).toEqual(["contents: read", "packages: write"]);
    for (const job of [jobs.identity, jobs.build]) {
      expect(job).not.toMatch(/docker\/login-action|skopeo|imagetools create|actions\/attest|secrets\.|--push|push=true|cache-to/);
    }
    expect(Object.keys(jobs).filter((name) => jobs[name].includes("cache-to"))).toEqual(["cache"]);
    expect(jobs.cache).not.toMatch(/skopeo|imagetools|actions\/attest|--push|push=true|type=image|type=oci|upload-artifact/);
    expect(workflow).not.toMatch(/type=gha|actions\/cache/);
    expect(workflow).not.toMatch(/pull_request_target|workflow_run/);
  });

  it("writes the build cache only for a master push in the canonical repository, never on the way to publication, with the token in the login step alone and no stage past the daemon", () => {
    for (const job of [jobs.publish, jobs.cache]) {
      expect(jobCondition(job).startsWith(`${canonical} && `)).toBe(true);
      expect(jobCondition(job)).not.toContain("||");
    }
    expect(jobCondition(jobs.cache)).toContain("needs.identity.outputs.lock == 'current'");
    for (const job of Object.values(jobs)) expect(/^ {4}needs: (.+)$/m.exec(job)?.[1] ?? "").not.toMatch(/\bcache\b/);
    const withCredential = steps(jobs.cache).filter((step) => credential.test(step));
    expect(withCredential).toHaveLength(1);
    expect(withCredential[0]).toContain("docker/login-action@");
    const building = steps(jobs.cache).filter((step) => step.includes("docker buildx build"));
    expect(building).toHaveLength(1);
    expect([...building[0].matchAll(/--target (\S+)/g)].map((match) => match[1])).toEqual(["runner-artifacts-runnerd"]);
    expect(jobs.cache).not.toMatch(/pnpm|setup-node|node scripts/);
  });

  it("neither publishes nor writes the cache from a scheduled run, and runs nothing on a fork's schedule", () => {
    expect(workflow).toMatch(/^ {2}schedule:\n {4}- cron: /m);
    expect(canonical).toContain("github.event_name == 'push'");
    expect(jobs.build).toContain(`KEEP_IMAGE: \${{ ${canonical} }}`);
    expect(jobCondition(jobs.identity)).toBe(`(github.event_name != 'push' && github.event_name != 'schedule') || (${repository})`);
  });

  const imageBuild = scripts.find((script) => script.includes('--target "$target"'))!;
  const bashExpandsEmptyArrays = spawnSync("bash", ["-uc", 'empty=(); : "${empty[@]}"']).status === 0;
  function imageBuildCommands(event: string) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "runner-image-build-"));
    try {
      writeFileSync(path.join(directory, "docker"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$RUNNER_TEMP/docker.log"\n`, { mode: 0o755 });
      const run = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", imageBuild], {
        cwd: directory,
        encoding: "utf8",
        env: { PATH: `${directory}${path.delimiter}${process.env.PATH}`, RUNNER_TEMP: directory, GITHUB_EVENT_NAME: event, GITHUB_SHA: "a".repeat(40),
          BUILD_CACHE: "registry.invalid/buildcache", ARCH: "amd64", PLATFORM: "linux/amd64" },
      });
      expect(run.status, run.stderr).toBe(0);
      return readFileSync(path.join(directory, "docker.log"), "utf8").trimEnd().split("\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it("replaces the cache read of the image build with --no-cache when the event is a schedule", () => {
    expect(imageBuild).toContain('cache=(--cache-from "type=registry,ref=$BUILD_CACHE:$ARCH")\n          if [ "$GITHUB_EVENT_NAME" = schedule ]; then cache=(--no-cache); fi\n');
    expect(imageBuild).toContain('"${cache[@]}"');
  });

  it.skipIf(!bashExpandsEmptyArrays)("runs the image build step: a scheduled run builds with --no-cache and no cache read, any other run reads the cache (needs bash 4.4)", () => {
    const cacheRead = "--cache-from type=registry,ref=registry.invalid/buildcache:amd64";
    const scheduled = imageBuildCommands("schedule");
    expect(scheduled.map((command) => /--target (\S+)/.exec(command)?.[1])).toEqual(["runner-artifacts", "runner-artifacts-slim"]);
    expect(scheduled[0]).toContain(" --no-cache ");
    for (const command of scheduled) expect(command).not.toContain("--cache-from");
    for (const event of ["pull_request", "push", "workflow_dispatch"]) {
      const commands = imageBuildCommands(event);
      expect(commands).toHaveLength(2);
      expect(commands[0]).toContain(` ${cacheRead} `);
      expect(commands[1]).not.toContain("--cache-from");
      for (const command of commands) expect(command).not.toContain("--no-cache");
    }
  });

  const buildSteps = steps(jobs.build);
  function stepWith(text: string) {
    const found = buildSteps.filter((step) => step.includes(text));
    expect(found, text).toHaveLength(1);
    return found[0];
  }
  const stepScript = (step: string) => /\n {8}run: \|\n((?: {10}.*\n|\n)+)/.exec(`${step}\n`)![1];
  const basePull = stepWith("--target smoke-bases");
  const smokeRun = stepWith('--build-context "runner-artifacts=');
  const hasTimeout = spawnSync("timeout", ["5", "true"]).status === 0;
  function runSmokeSteps({ pull, matrix }: { pull: number; matrix: number }) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "runner-image-smoke-"));
    const shell = (script: string) => spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", script], {
      cwd: directory,
      encoding: "utf8",
      env: { PATH: `${directory}${path.delimiter}${process.env.PATH}`, RUNNER_TEMP: directory, PLATFORM: "linux/amd64",
        PULL_STATUS: String(pull), MATRIX_STATUS: String(matrix) },
    });
    try {
      writeFileSync(path.join(directory, "docker"), [
        "#!/bin/sh",
        'case " $* " in',
        '  *" --target smoke-bases "*) i=0; while [ ! -e "$RUNNER_TEMP/release" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done',
        '    sleep 1; echo "background pull output"',
        '    printf \'pull %s\\n\' "$*" >> "$RUNNER_TEMP/docker.log"; exit "$PULL_STATUS" ;;',
        '  *) mkdir -p "$RUNNER_TEMP/runner-image/smoke"; printf \'matrix %s\\n\' "$*" >> "$RUNNER_TEMP/docker.log"; exit "$MATRIX_STATUS" ;;',
        "esac",
        "",
      ].join("\n"), { mode: 0o755 });
      if (!hasTimeout) {
        writeFileSync(path.join(directory, "timeout"), '#!/bin/sh\nwhile [ "$1" != docker ]; do shift; done\nexec "$@"\n', { mode: 0o755 });
      }
      const started = shell(stepScript(basePull));
      expect(started.status, started.stderr).toBe(0);
      expect(started.stdout).toBe("");
      const pullWasRunning = !existsSync(path.join(directory, "docker.log"));
      writeFileSync(path.join(directory, "release"), "");
      const smokeStep = shell(stepScript(smokeRun));
      return { status: smokeStep.status, output: smokeStep.stdout, pullWasRunning,
        commands: readFileSync(path.join(directory, "docker.log"), "utf8").trimEnd().split(directory).join("RUNNER_TEMP").split("\n") };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  const pullCommand = "pull buildx build --file docker/runner-image/Dockerfile.smoke --target smoke-bases --platform linux/amd64 --output type=cacheonly docker/runner-image";
  const matrixCommand = "matrix buildx build --file docker/runner-image/Dockerfile.smoke --platform linux/amd64"
    + " --build-context runner-artifacts=RUNNER_TEMP/runner-image/slim --output type=local,dest=RUNNER_TEMP/runner-image/smoke docker/runner-image";

  it("pulls the smoke bases in the background, with a time limit, no credential, no Runner image and no registry write", () => {
    expect(basePull).not.toMatch(credential);
    expect(basePull).toMatch(/^ {8}if: steps\.published\.outputs\.exists != 'true'$/m);
    const script = stepScript(basePull);
    expect(script).toMatch(/^ +timeout --kill-after=\d+ \d+ docker buildx build \\$/m);
    expect(script.match(/docker /g)).toHaveLength(1);
    expect(script).toMatch(/\) > "\$RUNNER_TEMP\/smoke-bases\.log" 2>&1 < \/dev\/null &\n/);
    const run = runSmokeSteps({ pull: 0, matrix: 0 });
    expect(run.pullWasRunning).toBe(true);
    expect(run.status, run.output).toBe(0);
    expect(run.commands).toEqual([pullCommand, matrixCommand]);
    expect(run.output).toContain("background pull output\n");
    expect(run.output).not.toContain("::warning");
  });

  it("runs the whole smoke matrix itself, and passes on its result, when the background pull did not pass", () => {
    const run = runSmokeSteps({ pull: 124, matrix: 0 });
    expect(run.status, run.output).toBe(0);
    expect(run.commands).toEqual([pullCommand, matrixCommand]);
    expect(run.output).toContain("::warning title=Smoke base images::The background pull ended with status 124.");
  });

  it("fails the smoke step when the matrix fails, and writes the record that publication needs only after that step", () => {
    const run = runSmokeSteps({ pull: 0, matrix: 1 });
    expect(run.status).toBe(1);
    expect(run.commands).toEqual([pullCommand, matrixCommand]);
    const record = stepWith("runner-image-publish.mjs record");
    const order = [stepWith("docker/setup-buildx-action@"), basePull, stepWith('--target "$target"'), smokeRun, record, stepWith("upload-artifact@")]
      .map((step) => buildSteps.indexOf(step));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const step of [smokeRun, record]) expect(step).toMatch(/^ {8}if: steps\.published\.outputs\.exists != 'true'$/m);
    expect(jobs.publish).toContain("runner-image-publish.mjs verify-legs");
  });

  it("publishes, and keeps the images for publication, only for a master push in the canonical repository", () => {
    expect(jobCondition(jobs.publish).startsWith(`${canonical} && `)).toBe(true);
    expect(jobs.publish).toContain("    needs: [identity, build]\n");
    expect(jobs.build).toContain(`KEEP_IMAGE: \${{ ${canonical} }}`);
    // The one step that hands the images to the publish job is behind that switch.
    const uploading = steps(jobs.build).filter((step) => step.includes("upload-artifact"));
    expect(uploading).toHaveLength(1);
    expect(uploading[0]).toMatch(/^ {8}if: env\.KEEP_IMAGE == 'true' && /m);
    // The record is written on every event, so a pull request exercises it. It needs no credential.
    const recording = steps(jobs.build).filter((step) => step.includes("runner-image-publish.mjs record"));
    expect(recording).toHaveLength(1);
    expect(recording[0]).not.toMatch(/KEEP_IMAGE/);
    expect(recording[0]).not.toMatch(credential);
    // A fork's own pushes run nothing; no job overrides a skipped or failed dependency.
    expect(jobCondition(jobs.identity)).toContain(`github.event_name != 'push' && `);
    expect(workflow).not.toMatch(/always\(\)|!cancelled\(\)|failure\(\)|continue-on-error/);
  });

  it("keeps the build legs free of credentials, and lets them read the build cache but not write it", () => {
    // No job-level token: the block before the steps holds none, in any job.
    for (const job of Object.values(jobs)) expect(job.slice(0, job.indexOf("\n    steps:\n"))).not.toMatch(credential);
    // The steps that build, check and smoke the image never receive one.
    const working = steps(jobs.build).filter((step) => /docker buildx build|runner-image-layout\.mjs|pnpm |upload-artifact/.test(step));
    expect(working.length).toBeGreaterThanOrEqual(4);
    for (const step of working) expect(step).not.toMatch(credential);
    // The one token the legs can see only reads packages, and only a lookup gets it.
    for (const step of steps(jobs.build).filter((entry) => credential.test(entry))) {
      expect(step).toContain("runner-image-publish.mjs publication-state");
      expect(step).not.toContain("--strict");
    }
    expect(jobs.build).toContain('--cache-from "type=registry,ref=$BUILD_CACHE:$ARCH"');
    expect(jobs.build).not.toMatch(/cache-to|docker login|docker\/login-action/);
  });

  it("writes the full tag last, after a strict lookup and after both images are attested", () => {
    // The full tag marks a complete publication, so nothing may follow it
    // that can fail to write a tag, and no tag is written on a guess.
    const publish = jobs.publish;
    const order = [
      "publication-state --inputs-digest \"$DIGEST\" --strict\n",
      "subject-digest: ${{ steps.slim.outputs.digest }}",
      "subject-digest: ${{ steps.full.outputs.digest }}",
      'imagetools create -t "$IMAGE:inputs-$DIGEST-slim" "$IMAGE@$SLIM_INDEX"',
      'imagetools create -t "$IMAGE:inputs-$DIGEST" "$IMAGE@$FULL_INDEX"',
    ].map((text) => publish.indexOf(text));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The final tags are written in one place each; every other tag is a candidate.
    expect([...workflow.matchAll(/-t "\$IMAGE:([a-z]+)-/g)].map((match) => match[1])).toEqual(["candidate", "candidate", "inputs", "inputs"]);
    // Every step that writes a tag or signs runs only after the strict lookup allowed it.
    const writing = steps(publish).filter((step) => /imagetools create|actions\/attest/.test(step));
    expect(writing).toHaveLength(5);
    for (const step of writing) expect(step).toMatch(/^ {8}if: steps\.gate\.outputs\.publish == 'true'$/m);
    expect(publish).toContain("group: runner-image-publish-${{ needs.identity.outputs.digest }}\n      cancel-in-progress: false");
  });

  it("never resolves the lockfile on a master push, and neither builds nor publishes when it is behind", () => {
    const resolving = steps(jobs.identity).filter((step) => step.includes("pnpm install"));
    expect(resolving).toHaveLength(1);
    expect(resolving[0]).toMatch(/^ {8}if: github\.event_name != 'push'$/m);
    expect(workflow.match(/pnpm install/g)).toHaveLength(1);
    expect(jobCondition(jobs.build).startsWith("needs.identity.outputs.lock == 'current' && ")).toBe(true);
    expect(jobCondition(jobs.publish)).toContain("needs.identity.outputs.lock == 'current'");
    // Pull requests and manual runs always build; only a push skips an image that exists.
    expect(jobCondition(jobs.build)).toContain("github.event_name != 'push' || (");
  });

  it("pins every action by commit and keeps expressions out of shell scripts", () => {
    const uses = [...workflow.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map((match) => match[1]);
    expect(uses.length).toBeGreaterThan(5);
    for (const action of uses) expect(action).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    // An expression in a script is substituted before the shell parses it.
    expect(scripts.length).toBeGreaterThan(5);
    for (const script of scripts) expect(script).not.toContain("${{");
  });

  it("gives every image build one export and a time limit", () => {
    // A command with two exports stalled on the hosted runners until the job
    // was cancelled. One export for each command, and a limit on each step,
    // so a stall fails in minutes.
    const building = workflow.split(/\n(?= {6}- name: )/).filter((step) => step.includes("docker buildx build"));
    expect(building.length).toBeGreaterThanOrEqual(4);
    for (const step of building) {
      expect(step).toMatch(/^ {8}timeout-minutes: \d+$/m);
      for (const command of step.split("docker buildx build").slice(1)) expect(command.match(/--output /g) ?? []).toHaveLength(1);
    }
    // The trees the checks read come from the archives, not from a second export.
    expect(workflow).toContain("node scripts/runner-image-oci.mjs unpack");
    expect(workflow.match(/type=local/g)).toHaveLength(3);
  });

  it("passes the image build exactly two build arguments", () => {
    // Build arguments are not part of the image identity, so a new one would
    // change what is published under an unchanged digest.
    const image = steps(jobs.build).filter((step) => step.includes("--target \"$target\""));
    expect(image).toHaveLength(1);
    expect([...image[0].matchAll(/--build-arg (\S+)/g)].map((match) => match[1])).toEqual([
      '"PAPERCLIP_RUNNER_SOURCE_REVISION=$GITHUB_SHA"',
      "PAPERCLIP_RUNNER_IMAGE_PUBLICATION=1",
    ]);
    expect(image[0]).toContain("target=runner-artifacts\n");
    expect(image[0]).toContain('if [ "$variant" = slim ]; then target=runner-artifacts-slim; fi');
    // No other command passes a build argument, and the identity is computed without one.
    expect(workflow.match(/--build-arg /g)).toHaveLength(2);
    expect(workflow).not.toMatch(/build-args:|BUILDX_BUILD_ARG|--build-arg-file/);
  });

  it("runs for a pull request that changes any input of the image identity", () => {
    const paths = [...workflow.matchAll(/^ {6}- (\S+)$/gm)].map((match) => match[1]);
    const covered = (file: string) => paths.some((pattern) => pattern === file
      || (pattern.endsWith("/**") && (file === pattern.slice(0, -3) || file.startsWith(pattern.slice(0, -2)))));
    // .dockerignore is not in the identity, but it decides which files the build receives.
    for (const input of ["Dockerfile", ".dockerignore", ".github/workflows/runner-image.yml", "docker/runner-image/Dockerfile.smoke",
      "scripts/runner-image-oci.mjs", "scripts/runner-image-publish.mjs", "scripts/standard-image-contract.mjs", ...RUNNER_IMAGE_CONTEXT_INPUTS]) {
      expect(covered(input), input).toBe(true);
    }
  });

  it("is registered with the merge-review notifier under its own name", () => {
    const name = /^name: (.+)$/m.exec(workflow)![1];
    const listed = /workflow_run:\n {4}workflows:\n((?: {6}- .+\n)+)/.exec(mergeReview)![1].split("\n").filter(Boolean).map((line) => line.trim().slice(2));
    expect(listed).toContain(name);
  });
});

describe("Runner image smoke matrix", () => {
  const bases = [...smoke.matchAll(/^FROM (\S+) AS base-(\S+)$/gm)].map((match) => ({ image: match[1], name: match[2] }));
  const stage = (name: string) => new RegExp(`^FROM \\S+ AS ${name.replace(/\./g, "\\.")}\\n(?:(?!FROM ).*\\n?)*`, "m").exec(smoke)![0].replace(/^#.*\n/gm, "");

  it("runs the daemon on every consumer base, each pinned by digest", () => {
    expect(bases.map((base) => base.image.slice(0, base.image.indexOf("@")))).toEqual([
      "debian:bookworm-slim",
      "debian:trixie-slim",
      "node:24-trixie-slim",
      "python:3.13-slim-trixie",
      "daytonaio/sandbox:0.8.0",
    ]);
    for (const base of bases) {
      expect(base.image).toMatch(/@sha256:[0-9a-f]{64}$/);
      expect(stage(`smoke-${base.name}`)).toMatch(new RegExp(`^FROM base-${base.name.replace(/\./g, "\\.")} AS \\S+\\nCOPY --from=runner-artifacts .+\\nRUN paperclip-runnerd --build-metadata `));
    }
    expect([...smoke.matchAll(/^FROM (\S+) /gm)].map((match) => match[1]).filter((source) => source !== "scratch" && !source.startsWith("base-")))
      .toEqual(bases.map((base) => base.image));
    const stages = [...smoke.matchAll(/^FROM \S+ AS (\S+)$/gm)].map((match) => match[1]);
    expect(stages).toEqual([...bases.flatMap((base) => [`base-${base.name}`, `smoke-${base.name}`]), "smoke-bases", "smoke"]);
    expect(stage("smoke")).toMatch(/^FROM scratch AS smoke\n/);
    expect([...stage("smoke").matchAll(/^COPY --from=(\S+) /gm)].map((match) => match[1])).toEqual(bases.map((base) => `smoke-${base.name}`));
  });

  it("pulls every base, and nothing of the Runner image, in the target the background pull builds", () => {
    const pulling = stage("smoke-bases");
    expect(pulling.trimEnd().split("\n")).toEqual(["FROM scratch AS smoke-bases", ...bases.map((base) => `COPY --from=base-${base.name} /bin/sh /${base.name}`)]);
  });

  it("reads the Runner image only the way a consumer may", () => {
    const copies = [...smoke.matchAll(/^COPY --from=runner-artifacts (.+)$/gm)].map((match) => match[1]);
    expect(new Set(copies)).toEqual(new Set(["/paperclip-runnerd /usr/local/bin/paperclip-runnerd"]));
    expect(smoke).not.toMatch(/^FROM runner-artifacts/m);
  });
});
