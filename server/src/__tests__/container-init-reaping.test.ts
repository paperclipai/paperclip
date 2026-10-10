import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Drift guard for container init (PID 1) wiring.
 *
 * The entrypoint ends in `exec`, so whatever the ENTRYPOINT names becomes PID 1.
 * With node there, orphans the kernel re-parents onto PID 1 are never wait()ed:
 * agent runs spawn git/claude/esbuild/sh descendants that outlive their leader,
 * and those pin as zombies at ~79/h until the cgroup pid limit is exhausted and
 * every fork() in the container fails (git and gh dying with "pthread_create
 * failed: Resource temporarily unavailable").
 *
 * tini reaps adopted orphans and forwards signals, so it must stay PID 1 ahead
 * of the entrypoint. This guard fails if a refactor drops the tini install or
 * unwraps the ENTRYPOINT back to a bare `docker-entrypoint.sh`.
 *
 * The behavioural half of this -- proving a real orphan is actually reaped
 * rather than merely configured to be -- lives in scripts/assert-orphan-reaping.sh.
 * It needs a container runtime, so it cannot run here: the Docker workflow runs
 * it against the pushed image, and scripts/docker-build-test.sh runs it against
 * a local build. This file guards the config those depend on.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (...segments: string[]) => readFileSync(path.join(repoRoot, ...segments), "utf8");

const dockerfile = read("Dockerfile");
const agentRuntimeBase = read("docker", "agent-runtime", "Dockerfile.base");
const compose = read("docker", "docker-compose.yml");
const quickstartCompose = read("docker", "docker-compose.quickstart.yml");
const ecsTaskDefinition = JSON.parse(read("docker", "ecs-task-definition.json")) as {
  containerDefinitions: { name: string; image: string; linuxParameters?: { initProcessEnabled?: boolean } }[];
};
const reapingProbe = read("scripts", "assert-orphan-reaping.sh");
const buildTest = read("scripts", "docker-build-test.sh");
const dockerWorkflow = read(".github", "workflows", "docker.yml");

/** Every `ENTRYPOINT [...]` line in a Dockerfile, in order. */
function entrypoints(source: string): string[] {
  return [...source.matchAll(/^ENTRYPOINT .*$/gm)].map((m) => m[0]);
}

/**
 * The packages every `apt-get install` line in the named stage asks for. Read
 * from the install lines themselves rather than by searching the whole file, so
 * a passing mention of a package name in a comment cannot stand in for actually
 * installing it.
 */
function aptPackages(source: string, stageName: string): string[] {
  const froms = [...source.matchAll(/^FROM .*$/gm)];
  const startIdx = froms.findIndex((m) => new RegExp(`\\bAS ${stageName}\\b`).test(m[0]));
  expect(startIdx, `Dockerfile must declare a '${stageName}' stage`).toBeGreaterThanOrEqual(0);
  const stage = source.slice(froms[startIdx].index ?? 0, froms[startIdx + 1]?.index ?? source.length);
  return [...stage.matchAll(/apt-get install[^\n]*/g)].flatMap((m) =>
    m[0]
      .replace(/apt-get install/, "")
      .split(/\s+/)
      .filter((token) => token.length > 0 && !token.startsWith("-") && token !== "\\"),
  );
}

describe("server image init", () => {
  it("installs tini in the base stage that every later stage inherits", () => {
    expect(
      aptPackages(dockerfile, "base"),
      "the base stage must apt-get install tini so /usr/bin/tini exists in the image",
    ).toContain("tini");
  });

  it("makes tini PID 1 ahead of the entrypoint", () => {
    const lines = entrypoints(dockerfile);
    expect(lines.length, "Dockerfile must declare an ENTRYPOINT").toBeGreaterThan(0);
    for (const line of lines) {
      expect(
        line,
        "node must not inherit PID 1: wrap the entrypoint in tini so adopted orphans are reaped",
      ).toBe('ENTRYPOINT ["/usr/bin/tini", "--", "docker-entrypoint.sh"]');
    }
  });

  it("keeps the entrypoint in the exec chain so UID remapping and gosu still run", () => {
    // tini must wrap docker-entrypoint.sh, not replace it -- the entrypoint is
    // what remaps the node UID/GID and repairs volume ownership before exec'ing.
    for (const line of entrypoints(dockerfile)) {
      expect(line).toContain("docker-entrypoint.sh");
    }
  });

  it("keeps the agent-runtime image's init, which the server image mirrors", () => {
    expect(entrypoints(agentRuntimeBase)).toContain('ENTRYPOINT ["/usr/bin/tini", "--"]');
  });
});

describe("deployment manifest parity", () => {
  it.each([
    ["docker-compose.yml", compose],
    ["docker-compose.quickstart.yml", quickstartCompose],
  ])("caps pids in %s", (_name, source) => {
    expect(
      /^\s{4}pids_limit:\s*\d+\s*$/m.test(source),
      "the compose server service must set pids_limit so a future leak dies visibly " +
        "instead of starving the host of pids",
    ).toBe(true);
  });

  it.each([
    ["docker-compose.yml", compose],
    ["docker-compose.quickstart.yml", quickstartCompose],
  ])("does not also set init in %s, which would nest docker-init around tini", (_name, source) => {
    // The image owns PID 1, so no per-orchestrator lever is needed. Setting
    // `init: true` here as well makes tini warn it is not PID 1 on every boot.
    expect(/^\s*init:\s*true\s*$/m.test(source)).toBe(false);
  });

  it("leaves ECS to inherit the image's init rather than enabling its own", () => {
    // Same reasoning as compose `init: true`: initProcessEnabled would put the
    // ECS-managed init in front of tini. Asserted rather than merely reviewed so
    // the parity decision survives the next edit to the task definition.
    const server = ecsTaskDefinition.containerDefinitions.find((c) => c.name === "paperclip-server");
    expect(server, "the task definition must define a paperclip-server container").toBeDefined();
    expect(server?.linuxParameters?.initProcessEnabled).toBeUndefined();
  });
});

describe("orphan-reaping probe", () => {
  it.each([
    ["the docker build test", buildTest],
    ["the Docker publish workflow", dockerWorkflow],
  ])("is exercised against a real image by %s", (_name, source) => {
    // A probe nothing runs proves nothing. The static assertions above only
    // check configuration; this is what keeps the behavioural check wired up.
    expect(source).toContain("scripts/assert-orphan-reaping.sh");
  });

  it("fails closed when the orphan is never adopted by PID 1", () => {
    // A probe whose grandchild is not reparented onto PID 1 proves nothing, so
    // it must error rather than report a pass it did not observe.
    expect(reapingProbe).toContain("the probe proved nothing");
  });

  it("polls for adoption rather than sampling the ppid once", () => {
    // Re-parenting lags the leader's exit, so a single sample reads a slow
    // leader as a failure and flakes the Docker publish workflow.
    expect(reapingProbe).toContain('if [ "$ppid" = "1" ]; then');
    expect(reapingProbe).toMatch(/while :; do\n\s+ppid=/);
  });

  it("asserts on the reaped pid rather than on PID 1's name alone", () => {
    expect(reapingProbe).toContain('if [ ! -e "/proc/$gpid" ]; then');
  });
});
