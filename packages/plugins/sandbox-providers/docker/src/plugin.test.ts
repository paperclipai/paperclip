import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import manifest from "./manifest.js";
import { buildDockerRunArgs, buildLeaseLabels, createDockerSandboxPlugin, healthDockerRuntimeService, parseDockerDriverConfig, startDockerRuntimeService, stopDockerRuntimeService, type DockerRunner } from "./plugin.js";

const config = { image: "paperclip-noble-qa:24.04", timeoutMs: 30_000, memoryMb: 512, cpus: 1, pidsLimit: 128 };

function dockerInspect(labels: Record<string, string>, running = true) {
  return JSON.stringify([{ Id: "container-1", State: { Running: running }, Config: { Labels: labels }, NetworkSettings: { Ports: { "3107/tcp": [{ HostIp: "127.0.0.1", HostPort: "45123" }] } } }]);
}

describe("Docker sandbox provider", () => {
  it("declares the stable first-party provider identity", () => {
    expect(manifest.id).toBe("paperclip.docker-sandbox-provider");
    expect(manifest.environmentDrivers?.[0]).toMatchObject({ driverKey: "docker", kind: "sandbox_provider" });
  });

  it("normalizes bounded configuration", () => {
    expect(parseDockerDriverConfig({ timeoutMs: 99_999_999, memoryMb: 1, cpus: 99, pidsLimit: 1 })).toEqual({
      image: "paperclip-noble-qa:24.04", timeoutMs: 600_000, memoryMb: 256, cpus: 16, pidsLimit: 64,
    });
  });

  it("creates a least-privilege container with only loopback port 3107", () => {
    const labels = buildLeaseLabels({ companyId: "company-1", environmentId: "env-1", executionWorkspaceId: "ws-1", runId: "run-1", leaseNonce: "lease-1", config });
    const args = buildDockerRunArgs({ containerName: "paperclip-run-1", labels, config });
    expect(args).toContain("--cap-drop");
    expect(args).toContain("no-new-privileges");
    expect(args).toContain("127.0.0.1::3107");
    expect(args.join(" ")).not.toMatch(/--privileged|--pid=host|--network=host|docker\.sock|--device|--volume|--mount/);
    expect(labels).toMatchObject({ "com.paperclip.managed": "true", "com.paperclip.provider": "docker" });
  });

  it("keeps untrusted command, argument, and environment values out of a host shell", async () => {
    const runner = vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, stdout: "ok", stderr: "", stdoutTruncated: false, stderrTruncated: false })) satisfies DockerRunner;
    const plugin = createDockerSandboxPlugin(runner);
    const result = await plugin.definition.onEnvironmentExecute?.({
      driverKey: "docker", companyId: "company-1", environmentId: "env-1", issueId: "issue-1", config,
      lease: { providerLeaseId: "container-1" }, command: "printf", args: ["$(not-expanded); --not-option"], env: { MESSAGE: "hello; $(not-expanded)" }, cwd: "/workspace/app",
    });
    expect(result?.exitCode).toBe(0);
    expect(runner).toHaveBeenCalledWith(expect.arrayContaining(["exec", "--workdir", "/workspace/app", "--user", "paperclip", "--env", "MESSAGE=hello; $(not-expanded)", "container-1", "printf", "$(not-expanded); --not-option"]), expect.any(Object));
  });

  it("rejects command execution outside the leased workspace", async () => {
    const runner = vi.fn() as unknown as DockerRunner;
    const plugin = createDockerSandboxPlugin(runner);
    await expect(plugin.definition.onEnvironmentExecute?.({ driverKey: "docker", companyId: "company-1", environmentId: "env-1", config, lease: { providerLeaseId: "container-1" }, command: "pwd", cwd: "/etc" })).rejects.toThrow("inside /workspace");
  });

  it("rejects workspace path traversal before running Docker", async () => {
    const runner = vi.fn() as unknown as DockerRunner;
    const plugin = createDockerSandboxPlugin(runner);
    await expect(plugin.definition.onEnvironmentExecute?.({ driverKey: "docker", companyId: "company-1", environmentId: "env-1", config, lease: { providerLeaseId: "container-1" }, command: "pwd", cwd: "/workspace/../../etc" })).rejects.toThrow("inside /workspace");
    expect(runner).not.toHaveBeenCalled();
  });

  it("refuses cleanup when ownership labels do not exactly match", async () => {
    const runner = vi.fn(async (args: string[]) => {
      if (args[0] === "inspect") return { exitCode: 0, signal: null, timedOut: false, stdout: dockerInspect({ "com.paperclip.managed": "true", "com.paperclip.provider": "docker" }), stderr: "", stdoutTruncated: false, stderrTruncated: false };
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false };
    }) satisfies DockerRunner;
    const plugin = createDockerSandboxPlugin(runner);
    await expect(plugin.definition.onEnvironmentReleaseLease?.({ driverKey: "docker", companyId: "company-1", environmentId: "env-1", config, providerLeaseId: "container-1" })).rejects.toThrow("Refusing to remove");
    expect(runner).not.toHaveBeenCalledWith(expect.arrayContaining(["rm"]), expect.anything());
  });

  it("resumes only a running container with the matching identity fingerprint", async () => {
    const labels = buildLeaseLabels({ companyId: "company-1", environmentId: "env-1", runId: "run-1", leaseNonce: "lease-1", config });
    const runner = vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, stdout: dockerInspect(labels), stderr: "", stdoutTruncated: false, stderrTruncated: false })) satisfies DockerRunner;
    const plugin = createDockerSandboxPlugin(runner);
    const resumed = await plugin.definition.onEnvironmentResumeLease?.({ driverKey: "docker", companyId: "company-1", environmentId: "env-1", config, providerLeaseId: "container-1" });
    expect(resumed?.metadata).toMatchObject({ port3107Url: "http://127.0.0.1:45123", remoteCwd: "/workspace" });
  });

  it("starts and stops a provider-managed service inside the container", async () => {
    const runner = vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, stdout: "exec-1", stderr: "", stdoutTruncated: false, stderrTruncated: false })) satisfies DockerRunner;
    const started = await startDockerRuntimeService(runner, { providerLeaseId: "container-1", serviceName: "web", command: "node server.js", cwd: "/workspace/app", env: { PORT: "3107", FEATURE_FLAG: "enabled" } });
    await stopDockerRuntimeService(runner, { providerLeaseId: "container-1", serviceName: "web" });
    expect(started.providerRef).toBe("container-1:web");
    expect(runner.mock.calls[0]?.[0]).toEqual(expect.arrayContaining(["exec", "--detach", "--workdir", "/workspace/app", "--env", "PORT=3107", "--env", "FEATURE_FLAG=enabled", "container-1"]));
    expect(runner.mock.calls[1]?.[0]).toEqual(expect.arrayContaining(["exec", "container-1", "/bin/sh"]));
  });

  it("exposes provider-managed service lifecycle hooks", async () => {
    const runner = vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, stdout: "exec-1", stderr: "", stdoutTruncated: false, stderrTruncated: false })) satisfies DockerRunner;
    const plugin = createDockerSandboxPlugin(runner);
    const start = await plugin.definition.onEnvironmentStartRuntimeService?.({
      driverKey: "docker", companyId: "company-1", environmentId: "env-1", config,
      lease: { providerLeaseId: "container-1" }, service: { serviceName: "web", command: "node server.js", cwd: "/workspace/app", url: "http://127.0.0.1:45123", env: { PORT: "3107" } },
    });
    await plugin.definition.onEnvironmentStopRuntimeService?.({
      driverKey: "docker", companyId: "company-1", environmentId: "env-1", config,
      lease: { providerLeaseId: "container-1" }, serviceName: "web", providerRef: start?.providerRef,
    });
    expect(start).toMatchObject({ providerRef: "container-1:web", metadata: { provider: "docker" } });
    expect(runner.mock.calls[0]?.[0]).toEqual(expect.arrayContaining(["--env", "PORT=3107"]));
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("health-checks only the loopback managed URL", async () => {
    const request = vi.fn(async () => new Response("ok", { status: 200 }));
    await expect(healthDockerRuntimeService("http://127.0.0.1:45123/health", request)).resolves.toBe(true);
    await expect(healthDockerRuntimeService("http://example.test", request)).resolves.toBe(false);
    expect(request).toHaveBeenCalledOnce();
  });

  it("ships the reproducible Noble image profile and sudo probe prerequisites", async () => {
    const dockerfile = await readFile(new URL("../Dockerfile.noble", import.meta.url), "utf8");
    expect(dockerfile).toContain("FROM ubuntu:24.04");
    expect(dockerfile).toContain("--uid 1000 --gid 1000");
    expect(dockerfile).toContain("/workspace");
    expect(dockerfile).toContain("ca-certificates curl git nodejs npm sudo tini");
    expect(dockerfile).toContain("NOPASSWD");
  });
});
