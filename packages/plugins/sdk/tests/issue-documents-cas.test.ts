import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { createTestHarness } from "../src/testing.js";
import { definePlugin } from "../src/define-plugin.js";
import { createHostClientHandlers, type HostServices } from "../src/host-client-factory.js";
import {
  createRequest,
  createSuccessResponse,
  isJsonRpcRequest,
  isJsonRpcResponse,
  parseMessage,
  serializeMessage,
  type JsonRpcResponse,
} from "../src/protocol.js";
import { startWorkerRpcHost } from "../src/worker-rpc-host.js";
import type { PaperclipPluginManifestV1 } from "../src/types.js";

const manifest = {
  id: "paperclip.test-issue-documents-cas",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Issue Documents CAS Test",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["issue.documents.read", "issue.documents.write"],
  entrypoints: {},
} satisfies PaperclipPluginManifestV1;

const issue = { id: "issue-a", companyId: "company-a" } as import("@paperclipai/shared").Issue;

function createDocumentHarness() {
  const harness = createTestHarness({ manifest });
  harness.seed({ issues: [issue] });
  return harness;
}

describe("issue document CAS in the SDK testing harness", () => {
  it("requires the current revision for updates and rejects base revisions on creates", async () => {
    const harness = createDocumentHarness();

    const created = await harness.ctx.issues.documents.upsert({
      issueId: issue.id,
      key: "plan",
      body: "v1",
      companyId: issue.companyId!,
      baseRevisionId: null,
    });
    expect(created.latestRevisionNumber).toBe(1);

    await expect(harness.ctx.issues.documents.upsert({
      issueId: issue.id,
      key: "plan",
      body: "blind update",
      companyId: issue.companyId!,
    })).rejects.toThrow("Document update requires baseRevisionId");

    const afterBlindUpdate = await harness.ctx.issues.documents.get(issue.id, "plan", issue.companyId!);
    expect(afterBlindUpdate).toMatchObject({
      body: "v1",
      latestRevisionId: created.latestRevisionId,
      latestRevisionNumber: 1,
    });

    await expect(harness.ctx.issues.documents.upsert({
      issueId: issue.id,
      key: "plan",
      body: "stale update",
      companyId: issue.companyId!,
      baseRevisionId: "stale-revision",
    })).rejects.toThrow("Document was updated by someone else");

    const afterStaleUpdate = await harness.ctx.issues.documents.get(issue.id, "plan", issue.companyId!);
    expect(afterStaleUpdate).toMatchObject({
      body: "v1",
      latestRevisionId: created.latestRevisionId,
      latestRevisionNumber: 1,
    });

    const updated = await harness.ctx.issues.documents.upsert({
      issueId: issue.id,
      key: "plan",
      body: "v2",
      companyId: issue.companyId!,
      baseRevisionId: created.latestRevisionId,
    });
    expect(updated.latestRevisionNumber).toBe(2);
    expect(updated.body).toBe("v2");

    await expect(harness.ctx.issues.documents.upsert({
      issueId: issue.id,
      key: "missing",
      body: "must not create",
      companyId: issue.companyId!,
      baseRevisionId: updated.latestRevisionId,
    })).rejects.toThrow("Document does not exist yet");
    await expect(harness.ctx.issues.documents.get(issue.id, "missing", issue.companyId!)).resolves.toBeNull();
  });

  it("preserves capability and company-scope enforcement", async () => {
    const noWriteHarness = createTestHarness({
      manifest: { ...manifest, capabilities: ["issue.documents.read"] },
    });
    noWriteHarness.seed({ issues: [issue] });
    await expect(noWriteHarness.ctx.issues.documents.upsert({
      issueId: issue.id,
      key: "plan",
      body: "denied",
      companyId: issue.companyId!,
    })).rejects.toThrow("issue.documents.write");

    const harness = createDocumentHarness();
    await expect(harness.ctx.issues.documents.upsert({
      issueId: issue.id,
      key: "plan",
      body: "wrong company",
      companyId: "company-b",
    })).rejects.toThrow(`Issue not found: ${issue.id}`);
  });
});

describe("worker issue document RPC forwarding", () => {
  it("forwards baseRevisionId unchanged to the host", async () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    let nextRequestId = 1;
    const forwarded: Array<Record<string, unknown>> = [];

    const plugin = definePlugin({
      async setup(ctx) {
        ctx.data.register("upsert", async (params) => ctx.issues.documents.upsert({
          issueId: issue.id,
          key: "plan",
          body: "v2",
          companyId: issue.companyId!,
          title: "Plan",
          format: "markdown",
          changeSummary: "advance",
          baseRevisionId: params.baseRevisionId as string | null,
        }));
      },
    });
    const worker = startWorkerRpcHost({
      plugin,
      stdin: hostToWorker,
      stdout: workerToHost,
    });

    const callWorker = (method: string, params: unknown) => {
      const id = `host-${nextRequestId++}`;
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) {
            reject(new Error(response.error.message));
            return;
          }
          resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage(createRequest(method, params, id)));
      return result;
    };

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (isJsonRpcResponse(message)) {
        pending.get(String(message.id))?.(message);
        pending.delete(String(message.id));
        return;
      }
      if (!isJsonRpcRequest(message) || message.method !== "issues.documents.upsert") return;
      forwarded.push(message.params as Record<string, unknown>);
      hostToWorker.write(serializeMessage(createSuccessResponse(message.id, {
        id: "document-a",
        companyId: issue.companyId,
        issueId: issue.id,
        key: "plan",
        title: "Plan",
        format: "markdown",
        body: "v2",
        latestRevisionId: "revision-2",
        latestRevisionNumber: 2,
      })));
    });

    try {
      await expect(callWorker("initialize", {
        manifest,
        config: {},
        databaseNamespace: null,
      })).resolves.toMatchObject({ ok: true });
      await expect(callWorker("getData", {
        key: "upsert",
        companyId: issue.companyId,
        params: { baseRevisionId: "revision-1" },
      })).resolves.toMatchObject({ latestRevisionId: "revision-2" });
      await expect(callWorker("getData", {
        key: "upsert",
        companyId: issue.companyId,
        params: { baseRevisionId: null },
      })).resolves.toMatchObject({ latestRevisionId: "revision-2" });
      expect(forwarded).toEqual([
        {
          issueId: issue.id,
          key: "plan",
          body: "v2",
          companyId: issue.companyId,
          title: "Plan",
          format: "markdown",
          changeSummary: "advance",
          baseRevisionId: "revision-1",
        },
        {
          issueId: issue.id,
          key: "plan",
          body: "v2",
          companyId: issue.companyId,
          title: "Plan",
          format: "markdown",
          changeSummary: "advance",
          baseRevisionId: null,
        },
      ]);
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });
});

describe("plugin host client issue document forwarding", () => {
  it("passes baseRevisionId through capability-gated host handlers", async () => {
    const upsert = vi.fn(async (params: Record<string, unknown>) => params);
    const handlers = createHostClientHandlers({
      pluginId: manifest.id,
      capabilities: ["issue.documents.write"],
      services: {
        issueDocuments: { upsert },
      } as unknown as HostServices,
    });
    const params = {
      issueId: issue.id,
      key: "plan",
      body: "v2",
      companyId: issue.companyId!,
      title: "Plan",
      format: "markdown",
      changeSummary: "advance",
      baseRevisionId: "revision-1",
    };

    await expect(handlers["issues.documents.upsert"](
      params,
      { invocationScope: { companyId: issue.companyId! } },
    )).resolves.toEqual(params);
    expect(upsert).toHaveBeenCalledWith(params);
  });
});
