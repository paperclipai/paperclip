import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosApi } from "./api.js";
import { TaskObserver } from "./observer.js";
import type { ChaosLab } from "./seed.js";
import { Timeline } from "./timeline.js";
import type { TaskPlan } from "./types.js";

const nonce = "abcd1234";
const modulePath = `packages/shared/src/chaos/slug-${nonce}.ts`;
const testPath = `packages/shared/src/chaos/slug-${nonce}.test.ts`;
const remoteFiles: Record<string, string> = {
  [modulePath]: `export function chaosSlug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
`,
  [testPath]: `import { test } from "node:test";
import assert from "node:assert/strict";
import { chaosSlug } from "./slug-${nonce}.ts";
test("slug", () => {
  assert.equal(chaosSlug("Hello Chaos World"), "hello-chaos-world");
  assert.equal(chaosSlug("  a__b  "), "a-b");
  assert.equal(chaosSlug("x"), "x");
});
`,
};
const lab = { companyId: "c1", projectId: "p1", environmentId: "e1", environmentKind: "daytona", fixtureRepositoryPath: "/x",
  agents: { codex: { id: "a1", name: "Chaos codex" }, claude: { id: "a2", name: "Chaos claude" } } } as unknown as ChaosLab;
const plan: TaskPlan = { taskId: "t01", index: 0, workload: "R1", adapter: "codex", fault: "K1", fireAfterMs: 999_999,
  holdMs: 0, followUpAfterMs: null, nonce };
let server: Server;
let sandboxReleased = false;
let unavailableReads = 0;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? "/", "http://x");
    if (url.pathname === "/api/issues/i1/file-resources/content" && url.searchParams.get("download") === "true") {
      if (url.searchParams.get("workspace") !== "execution") { outgoing.writeHead(422, { "content-type": "application/json" }).end(JSON.stringify({ code: "no_local_workspace" })); return; }
      if (incoming.headers.origin !== baseUrl) { outgoing.writeHead(403).end(); return; }
      if (unavailableReads > 0) { unavailableReads -= 1; outgoing.writeHead(422, { "content-type": "application/json" }).end(JSON.stringify({ code: "workspace_unavailable" })); return; }
      if (sandboxReleased) { outgoing.writeHead(422, { "content-type": "application/json" }).end(JSON.stringify({ code: "workspace_unavailable" })); return; }
      const body = remoteFiles[url.searchParams.get("path") ?? ""];
      outgoing.writeHead(body ? 200 : 404, { "content-type": "text/plain" }).end(body ?? "");
      return;
    }
    outgoing.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); server.close(); });

describe("oracle for a remote workspace", () => {
  it("reads the task's files through the board API and runs the oracle commands on a local copy", async () => {
    const api = {
      baseUrl,
      async get(route: string) {
        if (route.endsWith("/comments")) return [];
        return { id: "i1", status: "done", currentExecutionWorkspace: { cwd: "/home/daytona/workspaces/not-on-this-host" } };
      },
      async post() { return { id: "i1", identifier: "CHA-1" }; },
      getText: (route: string) => new ChaosApi(baseUrl).getText(route),
    } as unknown as ChaosApi;
    const observer = new TaskObserver(plan, api, lab, new Timeline(null), { serverReady: true, faultInProgress: false });
    await observer.launch();
    sandboxReleased = false;
    const artifacts = await observer.collectArtifacts();
    expect(artifacts.files).toEqual(remoteFiles);
    expect(artifacts.commands.node_test).toMatchObject({ exitCode: 0 });
    expect(artifacts.commands.slug?.stdout).toContain("hello-chaos-world");
  }, 60_000);

  it("skips the local pre-fault listing for a workspace that lives in the sandbox, instead of failing R2", async () => {
    const api = {
      baseUrl,
      async get(route: string) { return route.endsWith("/runs") ? [] : { id: "i1", status: "in_progress", currentExecutionWorkspace: { cwd: "/home/daytona/workspaces/not-on-this-host" } }; },
      async post() { return { id: "i1", identifier: "CHA-1" }; },
    } as unknown as ChaosApi;
    const observer = new TaskObserver(plan, api, lab, new Timeline(null), { serverReady: true, faultInProgress: false });
    await observer.launch();
    await observer.poll(observer.record.createdAt! + 1_000);
    await observer.snapshotBeforeFault();
    expect(observer.record).toMatchObject({ preFaultFiles: null, remoteWorkspace: true });
    expect(observer.record.preFaultSnapshotError).toBeUndefined();
  });

  it("captures the task's files when it first sees the task done, before the sandbox is released", async () => {
    const api = {
      baseUrl,
      async get(route: string) {
        if (route.endsWith("/runs") || route.endsWith("/comments")) return [];
        return { id: "i1", status: "done", currentExecutionWorkspace: { cwd: "/home/daytona/workspaces/not-on-this-host" } };
      },
      async post() { return { id: "i1", identifier: "CHA-1" }; },
      getText: (route: string) => new ChaosApi(baseUrl).getText(route),
    } as unknown as ChaosApi;
    const observer = new TaskObserver(plan, api, lab, new Timeline(null), { serverReady: true, faultInProgress: false });
    await observer.launch();
    sandboxReleased = false;
    await observer.poll(observer.record.createdAt! + 1_000);
    sandboxReleased = true;
    try {
      const artifacts = await observer.collectArtifacts();
      expect(artifacts.files).toEqual(remoteFiles);
      expect(artifacts.commands.node_test).toMatchObject({ exitCode: 0 });
    } finally { sandboxReleased = false; }
  }, 60_000);

  it("waits for the closing save to make a remote workspace readable again before grading its files", async () => {
    const api = {
      baseUrl,
      async get(route: string) {
        if (route.endsWith("/comments")) return [];
        return { id: "i1", status: "done", currentExecutionWorkspace: { cwd: "/home/daytona/workspaces/not-on-this-host" } };
      },
      async post() { return { id: "i1", identifier: "CHA-1" }; },
      getText: (route: string) => new ChaosApi(baseUrl).getText(route),
    } as unknown as ChaosApi;
    const observer = new TaskObserver(plan, api, lab, new Timeline(null), { serverReady: true, faultInProgress: false });
    await observer.launch();
    sandboxReleased = false;
    unavailableReads = 2;
    const artifacts = await observer.collectArtifacts();
    expect(unavailableReads).toBe(0);
    expect(artifacts.files).toEqual(remoteFiles);
  }, 60_000);

  it("does not wait on a file the agent never wrote", async () => {
    const api = {
      baseUrl,
      async get(route: string) {
        if (route.endsWith("/comments")) return [];
        return { id: "i1", status: "done", currentExecutionWorkspace: { cwd: "/home/daytona/workspaces/not-on-this-host" } };
      },
      async post() { return { id: "i1", identifier: "CHA-1" }; },
      getText: (route: string) => new ChaosApi(baseUrl).getText(route.replace(/slug-/g, "missing-")),
    } as unknown as ChaosApi;
    const observer = new TaskObserver(plan, api, lab, new Timeline(null), { serverReady: true, faultInProgress: false });
    await observer.launch();
    const started = Date.now();
    const artifacts = await observer.collectArtifacts();
    expect(Object.values(artifacts.files)).toEqual([null, null]);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 60_000);

  it("records why a remote file could not be read", async () => {
    const api = {
      baseUrl,
      async get(route: string) {
        if (route.endsWith("/comments") || route.endsWith("/runs")) return [];
        return { id: "i1", status: "done", currentExecutionWorkspace: { cwd: "/home/daytona/workspaces/not-on-this-host" } };
      },
      async post() { return { id: "i1", identifier: "CHA-1" }; },
      getText: (route: string) => new ChaosApi(baseUrl).getText(route),
    } as unknown as ChaosApi;
    const timeline = new Timeline(null);
    const observer = new TaskObserver(plan, api, lab, timeline, { serverReady: true, faultInProgress: false });
    await observer.launch();
    sandboxReleased = true;
    try {
      await observer.poll(observer.record.createdAt! + 1_000);
      await observer.poll(observer.record.createdAt! + 5_000);
    } finally { sandboxReleased = false; }
    expect(observer.record.remoteFileErrors?.[modulePath]).toMatch(/422.*workspace_unavailable/);
    expect(timeline.entries.filter(entry => entry.kind === "remote_file_read_failed" && entry.path === modulePath)).toHaveLength(1);
    await observer.poll(observer.record.createdAt! + 9_000);
    expect(observer.record.remoteFiles?.[modulePath]).toBe(remoteFiles[modulePath]);
    const artifacts = await observer.collectArtifacts();
    expect(artifacts.files[modulePath]).toBe(remoteFiles[modulePath]);
    expect(observer.record.remoteFileErrors?.[modulePath]).toBeUndefined();
  }, 60_000);
});

