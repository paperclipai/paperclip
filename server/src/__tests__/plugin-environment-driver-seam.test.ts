import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  PLUGIN_RPC_ERROR_CODES,
  createRequest,
  isJsonRpcErrorResponse,
  isJsonRpcSuccessResponse,
  parseMessage,
  serializeMessage,
} from "../../../packages/plugins/sdk/src/protocol.js";
import type { PluginEnvironmentTaskParams } from "../../../packages/plugins/sdk/src/environment-tasks.js";
import { definePlugin } from "../../../packages/plugins/sdk/src/define-plugin.js";
import { startWorkerRpcHost } from "../../../packages/plugins/sdk/src/worker-rpc-host.js";
import { pluginManifestV1Schema, type PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { pluginCapabilityValidator } from "../services/plugin-capability-validator.js";

const baseManifest: PaperclipPluginManifestV1 = {
  id: "test.environment-driver",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Environment Driver",
  description: "Test environment driver plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: { worker: "dist/worker.js" },
  environmentDrivers: [
    {
      driverKey: "fake-plugin",
      displayName: "Fake plugin",
      supportsInteractiveSetup: true,
      interactiveSetupConnectionTypes: ["ssh"],
      supportsTemplateCapture: true,
      templateRefKind: "snapshot",
      supportsTemplateDelete: true,
      configSchema: {
        type: "object",
        properties: {
          template: { type: "string" },
        },
        required: ["template"],
      },
    },
  ],
};

describe("plugin environment driver seam", () => {
  it("validates environment driver manifest declarations", () => {
    expect(pluginManifestV1Schema.safeParse(baseManifest).success).toBe(true);

    const missingCapability = pluginManifestV1Schema.safeParse({
      ...baseManifest,
      capabilities: ["http.outbound"],
    });
    expect(missingCapability.success).toBe(false);
    expect(JSON.stringify(missingCapability.error?.issues)).toContain(
      "environment.drivers.register",
    );

    const duplicateDriver = pluginManifestV1Schema.safeParse({
      ...baseManifest,
      environmentDrivers: [
        baseManifest.environmentDrivers![0],
        { ...baseManifest.environmentDrivers![0], displayName: "Duplicate" },
      ],
    });
    expect(duplicateDriver.success).toBe(false);
    expect(JSON.stringify(duplicateDriver.error?.issues)).toContain(
      "Duplicate environment driver keys",
    );
  });

  it("enforces environment driver capability requirements", () => {
    const validator = pluginCapabilityValidator();
    expect(validator.getRequiredCapabilities("environment.acquireLease")).toEqual([
      "environment.drivers.register",
    ]);
    expect(validator.getRequiredCapabilities("environment.captureTemplate")).toEqual([
      "environment.drivers.register",
    ]);
    expect(validator.checkOperation(baseManifest, "environment.execute").allowed).toBe(true);

    const withoutCapability = {
      ...baseManifest,
      capabilities: ["http.outbound"],
    } satisfies PaperclipPluginManifestV1;

    expect(validator.checkOperation(withoutCapability, "environment.execute")).toMatchObject({
      allowed: false,
      missing: ["environment.drivers.register"],
    });
    expect(validator.validateManifestCapabilities(withoutCapability)).toMatchObject({
      allowed: false,
      missing: ["environment.drivers.register"],
    });
  });

  it("negotiates and validates plugin-provided Runner execution RPCs", async () => {
    const calls: unknown[] = [];
    const plugin = definePlugin({
      async setup() {},
      async onEnvironmentTask(input) {
        calls.push(input);
        return { kind: "accepted", taskId: input.taskId };
      },
    });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const host = startWorkerRpcHost({ plugin, stdin, stdout });
    const responses: unknown[] = [];
    stdout.on("data", chunk => {
      for (const line of String(chunk).split("\n").filter(Boolean)) responses.push(parseMessage(line));
    });
    try {
      const manifest = { ...baseManifest, environmentDrivers: [{ ...baseManifest.environmentDrivers![0], supportsTasks: true }] };
      expect(pluginManifestV1Schema.parse(manifest).environmentDrivers![0].supportsTasks).toBe(true);
      stdin.write(serializeMessage(createRequest("initialize", {
        manifest, config: {}, instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" }, apiVersion: 1,
      }, 1)));
      await waitForResponses(responses, 1);
      const initialized = responses[0];
      expect(isJsonRpcSuccessResponse(initialized)).toBe(true);
      if (!isJsonRpcSuccessResponse(initialized)) return;
      expect(initialized.result.supportedMethods).toContain("environmentTask");
      const projectIds = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002"];
      const params: PluginEnvironmentTaskParams = { driverKey: "fake-plugin", companyId: "company", environmentId: "environment", config: {},
        taskId: "attempt", runId: "run", agentId: "agent", projectIds, lease: { providerLeaseId: "attempt" },
        operation: { kind: "submit", projectIds, bootstrapTicket: "transient-test-ticket", runner: {
          protocolMin: 1, protocolMax: 2, harness: "codex", runnerId: "runner", leaseId: "lease", runId: "run", sessionId: "session:part.1", turnId: "turn", itemId: "item",
        } } };

      stdin.write(serializeMessage(createRequest("environmentTask", params, 2)));
      await waitForResponses(responses, 2);
      expect(responses[1]).toMatchObject({ result: { kind: "accepted", taskId: "attempt" } });
      expect(calls[0]).toMatchObject({ projectIds, operation: { kind: "submit", projectIds } });
      stdin.write(serializeMessage(createRequest("environmentTask", { ...params, operation: { kind: "status" } }, 3)));
      await waitForResponses(responses, 3);
      expect(isJsonRpcErrorResponse(responses[2])).toBe(true); // Wrong response kind.
      stdin.write(serializeMessage(createRequest("environmentTask", { ...params, operation: { kind: "shell", command: "echo test" } }, 4)));
      await waitForResponses(responses, 4);
      expect(isJsonRpcErrorResponse(responses[3])).toBe(true);
      expect(calls).toHaveLength(2); // Invalid operation did not reach the plugin.
    } finally { host.stop(); }
  });

  it("dispatches environment driver worker hooks and reports support", async () => {
    const plugin = definePlugin({
      async setup() {},
      async onEnvironmentProbe(params) {
        return {
          ok: true,
          summary: `probed ${params.driverKey}`,
          metadata: { environmentId: params.environmentId },
        };
      },
      async onEnvironmentStartInteractiveSetup(params) {
        return {
          providerLeaseId: `setup-${params.sessionId}`,
          status: "waiting_for_user",
          connectionSummary: {
            type: "ssh",
            username: "sandbox",
            hostRedacted: true,
            portRedacted: true,
          },
          connectionPayload: null,
          metadata: { environmentId: params.environmentId },
        };
      },
    });

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const host = startWorkerRpcHost({ plugin, stdin, stdout });
    const responses: unknown[] = [];
    stdout.on("data", (chunk) => {
      const lines = String(chunk).split("\n").filter(Boolean);
      for (const line of lines) {
        responses.push(parseMessage(line));
      }
    });

    stdin.write(serializeMessage(createRequest("initialize", {
      manifest: baseManifest,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
    }, 1)));
    await waitForResponses(responses, 1);

    const initializeResponse = responses[0];
    expect(isJsonRpcSuccessResponse(initializeResponse)).toBe(true);
    if (!isJsonRpcSuccessResponse(initializeResponse)) return;
    expect(initializeResponse.result.supportedMethods).toContain("environmentProbe");
    expect(initializeResponse.result.supportedMethods).toContain("environmentStartInteractiveSetup");

    stdin.write(serializeMessage(createRequest("environmentProbe", {
      driverKey: "fake-plugin",
      companyId: "company-1",
      environmentId: "environment-1",
      config: { template: "base" },
    }, 2)));
    await waitForResponses(responses, 2);

    const probeResponse = responses[1];
    expect(isJsonRpcSuccessResponse(probeResponse)).toBe(true);
    if (!isJsonRpcSuccessResponse(probeResponse)) return;
    expect(probeResponse.result).toMatchObject({
      ok: true,
      summary: "probed fake-plugin",
      metadata: { environmentId: "environment-1" },
    });

    stdin.write(serializeMessage(createRequest("environmentStartInteractiveSetup", {
      driverKey: "fake-plugin",
      companyId: "company-1",
      environmentId: "environment-1",
      sessionId: "session-1",
      config: { template: "base" },
    }, 3)));
    await waitForResponses(responses, 3);

    const setupResponse = responses[2];
    expect(isJsonRpcSuccessResponse(setupResponse)).toBe(true);
    if (!isJsonRpcSuccessResponse(setupResponse)) return;
    expect(setupResponse.result).toMatchObject({
      providerLeaseId: "setup-session-1",
      status: "waiting_for_user",
      connectionSummary: {
        type: "ssh",
        hostRedacted: true,
        portRedacted: true,
      },
    });

    stdin.write(serializeMessage(createRequest("environmentExecute", {
      driverKey: "fake-plugin",
      companyId: "company-1",
      environmentId: "environment-1",
      config: { template: "base" },
      lease: { providerLeaseId: "lease-1" },
      command: "echo",
    }, 4)));
    await waitForResponses(responses, 4);

    const executeResponse = responses[3];
    expect(isJsonRpcErrorResponse(executeResponse)).toBe(true);
    if (!isJsonRpcErrorResponse(executeResponse)) return;
    expect(executeResponse.error.code).toBe(PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED);
    expect(executeResponse.error.message).toContain("environmentExecute");

    host.stop();
  });
});

const objectReferenceManifest: PaperclipPluginManifestV1 = {
  id: "test.external-object-provider",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "External Object Provider",
  description: "Test external object provider plugin",
  author: "Paperclip",
  categories: ["connector"],
  capabilities: ["external.objects.detect", "external.objects.read"],
  entrypoints: { worker: "dist/worker.js" },
  objectReferences: [
    {
      providerKey: "mocktracker",
      displayName: "Mock Tracker",
      objectTypes: ["ticket"],
      urlPatterns: ["https://mock.example/tickets/:id"],
      refreshPolicy: { defaultTtlSeconds: 300, staleAfterSeconds: 1800 },
    },
  ],
};

describe("plugin external object provider seam", () => {
  it("validates provider manifest declarations and capabilities", () => {
    expect(pluginManifestV1Schema.safeParse(objectReferenceManifest).success).toBe(true);

    const missingCapability = pluginManifestV1Schema.safeParse({
      ...objectReferenceManifest,
      capabilities: ["external.objects.detect"],
    });
    expect(missingCapability.success).toBe(false);
    expect(JSON.stringify(missingCapability.error?.issues)).toContain("external.objects.read");

    const duplicateProvider = pluginManifestV1Schema.safeParse({
      ...objectReferenceManifest,
      objectReferences: [
        objectReferenceManifest.objectReferences![0],
        { ...objectReferenceManifest.objectReferences![0], displayName: "Duplicate" },
      ],
    });
    expect(duplicateProvider.success).toBe(false);
    expect(JSON.stringify(duplicateProvider.error?.issues)).toContain(
      "Duplicate object reference provider keys",
    );
  });

  it("enforces provider capability requirements", () => {
    const validator = pluginCapabilityValidator();
    expect(validator.getRequiredCapabilities("external.objects.detect")).toEqual([
      "external.objects.detect",
    ]);
    expect(validator.getRequiredCapabilities("external.objects.read")).toEqual([
      "external.objects.read",
    ]);
    expect(validator.checkOperation(objectReferenceManifest, "external.objects.read").allowed).toBe(true);

    const withoutCapability = {
      ...objectReferenceManifest,
      capabilities: ["external.objects.detect"],
    } satisfies PaperclipPluginManifestV1;

    expect(validator.checkOperation(withoutCapability, "external.objects.read")).toMatchObject({
      allowed: false,
      missing: ["external.objects.read"],
    });
    expect(validator.validateManifestCapabilities(withoutCapability)).toMatchObject({
      allowed: false,
      missing: ["external.objects.read"],
    });
  });

  it("dispatches provider detection and resolution worker hooks", async () => {
    const plugin = definePlugin({
      async setup() {},
      async onDetectExternalObjects(params) {
        return {
          detections: params.urls.map((url) => ({
            urlIdentityHash: url.canonicalIdentityHash,
            providerKey: "mocktracker",
            objectType: "ticket",
            externalId: "MOCK-123",
            displayTitle: "Mock ticket",
            confidence: "exact",
          })),
        };
      },
      async onResolveExternalObject(params) {
        return {
          ok: true,
          snapshot: {
            displayTitle: `Resolved ${params.externalId}`,
            statusKey: "ready",
            statusLabel: "Ready",
            statusCategory: "succeeded",
            statusTone: "success",
            isTerminal: true,
            ttlSeconds: 600,
          },
        };
      },
    });

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const host = startWorkerRpcHost({ plugin, stdin, stdout });
    const responses: unknown[] = [];
    stdout.on("data", (chunk) => {
      const lines = String(chunk).split("\n").filter(Boolean);
      for (const line of lines) {
        responses.push(parseMessage(line));
      }
    });

    stdin.write(serializeMessage(createRequest("initialize", {
      manifest: objectReferenceManifest,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
    }, 1)));
    await waitForResponses(responses, 1);

    const initializeResponse = responses[0];
    expect(isJsonRpcSuccessResponse(initializeResponse)).toBe(true);
    if (!isJsonRpcSuccessResponse(initializeResponse)) return;
    expect(initializeResponse.result.supportedMethods).toContain("detectExternalObjects");
    expect(initializeResponse.result.supportedMethods).toContain("resolveExternalObject");

    stdin.write(serializeMessage(createRequest("detectExternalObjects", {
      companyId: "company-1",
      urls: [{
        sanitizedCanonicalUrl: "https://mock.example/tickets/123",
        sanitizedDisplayUrl: "https://mock.example/tickets/123",
        canonicalIdentityHash: "hash-123",
        canonicalIdentity: { scheme: "https", host: "mock.example", path: "/tickets/123" },
        redactedMatchedText: "https://mock.example/tickets/123",
      }],
      sourceContext: {
        companyId: "company-1",
        sourceIssueId: "issue-1",
        sourceKind: "description",
        sourceRecordId: null,
        documentKey: null,
        propertyKey: null,
      },
    }, 2)));
    await waitForResponses(responses, 2);

    const detectResponse = responses[1];
    expect(isJsonRpcSuccessResponse(detectResponse)).toBe(true);
    if (!isJsonRpcSuccessResponse(detectResponse)) return;
    expect(detectResponse.result.detections[0]).toMatchObject({
      providerKey: "mocktracker",
      objectType: "ticket",
      externalId: "MOCK-123",
    });

    stdin.write(serializeMessage(createRequest("resolveExternalObject", {
      companyId: "company-1",
      providerKey: "mocktracker",
      objectType: "ticket",
      externalId: "MOCK-123",
      object: {
        id: "object-1",
        companyId: "company-1",
        providerKey: "mocktracker",
        objectType: "ticket",
        externalId: "MOCK-123",
        sanitizedCanonicalUrl: "https://mock.example/tickets/123",
        canonicalIdentityHash: "hash-123",
        displayTitle: "Mock ticket",
        statusKey: null,
        statusLabel: null,
        statusCategory: "unknown",
        statusTone: "neutral",
        liveness: "unknown",
        isTerminal: false,
        data: {},
        remoteVersion: null,
        etag: null,
      },
    }, 3)));
    await waitForResponses(responses, 3);

    const resolveResponse = responses[2];
    expect(isJsonRpcSuccessResponse(resolveResponse)).toBe(true);
    if (!isJsonRpcSuccessResponse(resolveResponse)) return;
    expect(resolveResponse.result).toMatchObject({
      ok: true,
      snapshot: {
        statusCategory: "succeeded",
        statusTone: "success",
      },
    });

    host.stop();
  });
});

async function waitForResponses(responses: unknown[], count: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (responses.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(responses.length).toBeGreaterThanOrEqual(count);
}
