import { describe, expect, it, vi, beforeEach } from "vitest";
import { createDockerDriver, type DockerDriverOpts } from "../services/container-docker-driver.js";

describe("createDockerDriver — basic configuration", () => {
  it("constructs without errors with default options", () => {
    const driver = createDockerDriver({});
    expect(driver).toBeDefined();
    expect(typeof driver.start).toBe("function");
    expect(typeof driver.stop).toBe("function");
    expect(typeof driver.kill).toBe("function");
    expect(typeof driver.exec).toBe("function");
    expect(typeof driver.list).toBe("function");
    expect(typeof driver.inspect).toBe("function");
    expect(typeof driver.onStartup).toBe("function");
    expect(typeof driver.dispose).toBe("function");
  });

  it("uses docker as the default CLI command", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: "abc123def456", stderr: "", exitCode: 0 });
    const driver = createDockerDriver({ cliRunner: runner });
    await driver.start({
      image: "alpine:latest",
      labels: { "paperclip.plugin-id": "test-plugin" },
    });
    expect(runner).toHaveBeenCalledWith(
      expect.arrayContaining(["run", "-d"]),
      expect.any(Object),
    );
  });

  it("strips DOCKER_HOST from child process env before spawning", async () => {
    process.env.DOCKER_HOST = "unix:///run/docker.sock";
    const runner = vi.fn().mockResolvedValue({ stdout: "engine-id-1", stderr: "", exitCode: 0 });
    const driver = createDockerDriver({ cliRunner: runner });
    await driver.start({ image: "alpine:latest", labels: {} });
    const callArgs = runner.mock.calls[0];
    const envArg = callArgs?.[1]?.env as Record<string, string> | undefined;
    expect(envArg?.["DOCKER_HOST"]).toBeUndefined();
    delete process.env.DOCKER_HOST;
  });

  it("start applies mandatory hardening flags", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: "engine-id-1", stderr: "", exitCode: 0 });
    const driver = createDockerDriver({ cliRunner: runner });
    await driver.start({ image: "alpine:latest", labels: {} });
    const args = runner.mock.calls[0][0] as string[];
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--security-opt=no-new-privileges:true");
    expect(args).toContain("--network=none");
    expect(args).toContain("--pids-limit=256");
  });

  it("start applies user-supplied memory limit", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: "engine-id-1", stderr: "", exitCode: 0 });
    const driver = createDockerDriver({ cliRunner: runner });
    await driver.start({ image: "alpine:latest", labels: {}, memoryMb: 256 });
    const args = runner.mock.calls[0][0] as string[];
    expect(args.some((a) => a.includes("256m"))).toBe(true);
  });

  it("stop calls docker stop with the engine container ID", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const driver = createDockerDriver({ cliRunner: runner });
    await driver.stop("engine-id-abc");
    const args = runner.mock.calls[0][0] as string[];
    expect(args[0]).toBe("stop");
    expect(args).toContain("engine-id-abc");
  });

  it("kill calls docker rm -f with the engine container ID", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const driver = createDockerDriver({ cliRunner: runner });
    await driver.kill("engine-id-abc");
    const args = runner.mock.calls[0][0] as string[];
    expect(args[0]).toBe("rm");
    expect(args).toContain("-f");
    expect(args).toContain("engine-id-abc");
  });
});

describe("createDockerDriver — argument injection hardening", () => {
  it("rejects image names that look like CLI flags", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: "engine-id-1", stderr: "", exitCode: 0 });
    const driver = createDockerDriver({ cliRunner: runner });
    await expect(driver.start({ image: "--privileged", labels: {} })).rejects.toThrow(/invalid image/i);
    await expect(driver.start({ image: "--network=host", labels: {} })).rejects.toThrow(/invalid image/i);
  });

  it("inserts -- separator before image name in run args", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: "engine-id-1", stderr: "", exitCode: 0 });
    const driver = createDockerDriver({ cliRunner: runner });
    await driver.start({ image: "alpine:latest", labels: {} });
    const args = runner.mock.calls[0][0] as string[];
    const imageIdx = args.indexOf("alpine:latest");
    expect(imageIdx).toBeGreaterThan(0);
    expect(args[imageIdx - 1]).toBe("--");
  });

  it("rejects label keys containing = sign", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: "engine-id-1", stderr: "", exitCode: 0 });
    const driver = createDockerDriver({ cliRunner: runner });
    await expect(driver.start({ image: "alpine:latest", labels: { "bad=key": "val" } })).rejects.toThrow(/invalid label key/i);
  });

  it("rejects env keys containing = sign", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: "engine-id-1", stderr: "", exitCode: 0 });
    const driver = createDockerDriver({ cliRunner: runner });
    await expect(driver.start({ image: "alpine:latest", labels: {}, env: { "BAD=KEY": "val" } })).rejects.toThrow(/invalid env key/i);
  });

  it("truncates stdout at MAX_OUTPUT_BYTES during streaming, not after", async () => {
    const MAX = 10 * 1024 * 1024; // 10MB
    const bigChunk = "x".repeat(MAX + 100);
    const runner = vi.fn().mockImplementation((args: string[]) => {
      if (args[0] === "exec") {
        return Promise.resolve({ stdout: bigChunk, stderr: "", exitCode: 0 });
      }
      return Promise.resolve({ stdout: "engine-id-1", stderr: "", exitCode: 0 });
    });
    const driver = createDockerDriver({ cliRunner: runner });
    const result = await driver.exec("engine-id-1", ["cat", "/dev/zero"]);
    expect(result.stdout.length).toBeLessThanOrEqual(MAX);
    expect(result.truncated).toBe(true);
  });
});

describe("createDockerDriver — kill failure handling", () => {
  it("throws when docker rm -f exits non-zero", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: "", stderr: "No such container", exitCode: 1 });
    const driver = createDockerDriver({ cliRunner: runner });
    await expect(driver.kill("missing-id")).rejects.toThrow();
  });
});

describe("createDockerDriver — networkMode and allowRootUser", () => {
  it("passes --network=bridge when networkMode is bridge", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: "engine-id-1", stderr: "", exitCode: 0 });
    const driver = createDockerDriver({ cliRunner: runner, networkMode: "bridge" });
    await driver.start({ image: "alpine:latest", labels: {} });
    const args = runner.mock.calls[0][0] as string[];
    expect(args).toContain("--network=bridge");
    expect(args).not.toContain("--network=none");
  });

  it("does not override --user when allowRootUser is true", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: "engine-id-1", stderr: "", exitCode: 0 });
    const driver = createDockerDriver({ cliRunner: runner, allowRootUser: true });
    await driver.start({ image: "alpine:latest", labels: {} });
    const args = runner.mock.calls[0][0] as string[];
    expect(args).not.toContain("--user=65534:65534");
  });
});

describe("createDockerDriver — exec env forwarding", () => {
  it("forwards env vars as -e flags to docker exec", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const driver = createDockerDriver({ cliRunner: runner });
    await driver.exec("engine-id-1", ["env"], { env: { MY_VAR: "hello", OTHER: "world" } });
    const args = runner.mock.calls[0][0] as string[];
    expect(args[0]).toBe("exec");
    expect(args).toContain("-e");
    // Both env vars should appear as -e KEY=VAL pairs
    const pairs = args.filter((_, i) => args[i - 1] === "-e");
    expect(pairs).toContain("MY_VAR=hello");
    expect(pairs).toContain("OTHER=world");
  });

  it("emits no -e flags when env is absent", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const driver = createDockerDriver({ cliRunner: runner });
    await driver.exec("engine-id-1", ["ls"]);
    const args = runner.mock.calls[0][0] as string[];
    expect(args).not.toContain("-e");
  });
});

describe("createDockerDriver — list label value parsing", () => {
  it("preserves label values containing = signs", async () => {
    const labelString = "build-arg=cmake=-DFOO=1,paperclip.plugin-id=test-plugin";
    const psLine = JSON.stringify({
      ID: "abc123",
      Image: "alpine:latest",
      State: "running",
      CreatedAt: "2026-01-01T00:00:00Z",
      Labels: labelString,
    });
    const runner = vi.fn().mockResolvedValue({ stdout: psLine, stderr: "", exitCode: 0 });
    const driver = createDockerDriver({ cliRunner: runner });
    const containers = await driver.list();
    expect(containers[0].labels["build-arg"]).toBe("cmake=-DFOO=1");
    expect(containers[0].labels["paperclip.plugin-id"]).toBe("test-plugin");
  });
});

describe("createDockerDriver — exec env-key validation", () => {
  it("rejects env keys containing = in exec() just as start() does", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const driver = createDockerDriver({ cliRunner: runner });
    await expect(
      driver.exec("engine-id-1", ["env"], { env: { "BAD=KEY": "val" } })
    ).rejects.toThrow(/invalid env key/i);
  });
});

describe("createDockerDriver — probe endpoint helper", () => {
  it("probe returns ok:true when docker info succeeds", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: '{"ServerVersion":"24.0.0"}', stderr: "", exitCode: 0 });
    const driver = createDockerDriver({ cliRunner: runner }) as ReturnType<typeof createDockerDriver> & { probe(): Promise<{ ok: boolean; summary?: string }> };
    const result = await driver.probe();
    expect(result.ok).toBe(true);
  });

  it("probe returns ok:false when docker info fails", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: "", stderr: "Cannot connect to Docker daemon", exitCode: 1 });
    const driver = createDockerDriver({ cliRunner: runner }) as ReturnType<typeof createDockerDriver> & { probe(): Promise<{ ok: boolean; summary?: string }> };
    const result = await driver.probe();
    expect(result.ok).toBe(false);
  });
});
