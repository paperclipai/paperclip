import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChaosApi } from "./api.js";
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
let baseUrl: string;

beforeAll(async () => {
  server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? "/", "http://x");
    if (url.pathname === "/api/issues/i1/file-resources/content" && url.searchParams.get("download") === "true") {
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
    } as unknown as ChaosApi;
    const observer = new TaskObserver(plan, api, lab, new Timeline(null), { serverReady: true, faultInProgress: false });
    await observer.launch();
    const artifacts = await observer.collectArtifacts();
    expect(artifacts.files).toEqual(remoteFiles);
    expect(artifacts.commands.node_test).toMatchObject({ exitCode: 0 });
    expect(artifacts.commands.slug?.stdout).toContain("hello-chaos-world");
  }, 60_000);
});
