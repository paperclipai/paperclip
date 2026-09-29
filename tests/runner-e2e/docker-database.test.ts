import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const docker = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: Object.assign(() => {}, {
  [Symbol.for("nodejs.util.promisify.custom")]: async (...args: unknown[]) => ({ stdout: await docker(...args) ?? "", stderr: "" }),
}) }));
import { assertDockerTestDatabaseIsolation, cleanupDockerTestDatabase, prepareDockerTestDatabase } from "./docker-database.js";

let root: string;
let owned: { Image: string; Config: { Labels: Record<string, string> }; State: { Running: boolean }; NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[]> } } | null;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paperclip-docker-ownership-")); owned = null;
  docker.mockReset().mockImplementation(async (command, args) => {
    expect(command).toBe("docker");
    if (args[0] === "run") {
      const marker = JSON.parse(await readFile(path.join(root, "docker-postgres.json"), "utf8"));
      expect(args[args.indexOf("--name") + 1]).toBe(marker.name);
      expect(args).toContain(`paperclip.runner-e2e.root=${marker.rootSha256}`);
      expect(args).toContain("127.0.0.1::5432");
      owned = { Image: `sha256:${"a".repeat(64)}`, Config: { Labels: { "paperclip.runner-e2e.root": marker.rootSha256 } },
        State: { Running: true }, NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "15432" }] } } };
    } else if (args[0] === "inspect") {
      if (!owned) throw Object.assign(new Error("not found"), { stderr: "No such object" });
      return JSON.stringify([owned]);
    } else if (args[0] === "rm") owned = null;
    return "";
  });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("persists ownership before creation, verifies loopback, records the image, and cleans only its container", async () => {
  const connection = await prepareDockerTestDatabase(root);
  expect(connection).toBe("postgres://paperclip@127.0.0.1:15432/paperclip");
  const marker = JSON.parse(await readFile(path.join(root, "docker-postgres.json"), "utf8"));
  expect(marker.imageId).toBe(`sha256:${"a".repeat(64)}`);
  await assertDockerTestDatabaseIsolation(root, connection);
  await expect(assertDockerTestDatabaseIsolation(root, "postgres://unrelated/database")).rejects.toThrow("not fixture-owned");
  await cleanupDockerTestDatabase(root);
  expect(docker.mock.calls.filter(call => call[1][0] === "rm").map(call => call[1])).toEqual([["rm", "--force", "--volumes", marker.name]]);
  await cleanupDockerTestDatabase(root);
});

it("refuses to inspect or remove a foreign-root marker or a symlink", async () => {
  await prepareDockerTestDatabase(root);
  const file = path.join(root, "docker-postgres.json");
  const marker = JSON.parse(await readFile(file, "utf8"));
  marker.rootSha256 = "b".repeat(64);
  await writeFile(file, JSON.stringify(marker)); docker.mockClear();
  await expect(cleanupDockerTestDatabase(root)).rejects.toThrow("ownership mismatch");
  expect(docker).not.toHaveBeenCalled();
  const target = path.join(root, "foreign.json");
  await writeFile(target, JSON.stringify(marker)); await rm(file); await symlink(target, file);
  await expect(cleanupDockerTestDatabase(root)).rejects.toThrow();
  expect(docker).not.toHaveBeenCalled();
});

it("refuses cleanup when the container ownership label changes", async () => {
  await prepareDockerTestDatabase(root);
  owned!.Config.Labels["paperclip.runner-e2e.root"] = "unrelated";
  await expect(cleanupDockerTestDatabase(root)).rejects.toThrow("Refusing unrelated");
  expect(docker.mock.calls.some(call => call[1][0] === "rm")).toBe(false);
});

it("rejects an exposed, stopped or rebound database before starting the product", async () => {
  const connection = await prepareDockerTestDatabase(root);
  owned!.NetworkSettings.Ports["5432/tcp"][0].HostIp = "0.0.0.0";
  await expect(assertDockerTestDatabaseIsolation(root, connection)).rejects.toThrow("exclusively to loopback");
  owned!.NetworkSettings.Ports["5432/tcp"][0].HostIp = "127.0.0.1";
  owned!.NetworkSettings.Ports["5432/tcp"][0].HostPort = "15433";
  await expect(assertDockerTestDatabaseIsolation(root, connection)).rejects.toThrow("isolation changed");
  owned!.State.Running = false;
  await expect(assertDockerTestDatabaseIsolation(root, connection)).rejects.toThrow("exclusively to loopback");
});

it("leaves an interrupted creation cleanable and does not create a second resource", async () => {
  const normal = docker.getMockImplementation()!;
  docker.mockImplementation(async (...args) => {
    const result = await normal(...args);
    if (args[1][0] === "run") throw new Error("lost creation reply");
    return result;
  });
  await expect(prepareDockerTestDatabase(root)).rejects.toThrow("lost creation reply");
  await expect(prepareDockerTestDatabase(root)).rejects.toThrow("already prepared");
  await cleanupDockerTestDatabase(root);
  expect(owned).toBeNull();
});
