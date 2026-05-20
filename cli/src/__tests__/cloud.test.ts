import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyPortabilityExportResult } from "@paperclipai/shared";
import {
  assertDiscoveryCompatible,
  buildBundleFromLocalCompany,
  cloudCommandExitCodes,
  connectCloud,
  discoverUpstream,
} from "../commands/client/cloud.js";
import {
  LocalUpstreamPushCoordinator,
  normalizedContentHash,
  type LocalUpstreamExportBundle,
} from "../commands/client/cloud-transfer.js";
import { getCloudConnection, resolveCloudConnectionStorePath } from "../commands/client/cloud-store.js";

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

describe("cloud CLI helpers", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-cloud-cli-"));
    process.env = { ...originalEnv, PAPERCLIP_HOME: tempHome };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("connects with the device-code flow and stores the resulting cloud connection", async () => {
    globalThis.fetch = vi.fn(async (url, init) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/.well-known/paperclip-upstream")) {
        return jsonResponse(discovery());
      }
      if (requestUrl.endsWith("/api/upstream-sync/device-code")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          stackId: "stack-1",
          scopes: ["upstream_import:preview", "upstream_import:write", "upstream_import:read"],
        });
        return jsonResponse({
          deviceCode: "device-1",
          userCode: "ABCD-EFGH",
          verificationUri: "https://cloud.example.test/api/upstream-sync/device-code/approve",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          intervalSeconds: 0,
        });
      }
      if (requestUrl.endsWith("/api/upstream-sync/token")) {
        return jsonResponse({
          accessToken: "upt_test",
          scopes: ["upstream_import:preview"],
          token: {
            id: "token-1",
            companyStackId: "stack-1",
            targetOrigin: "https://cloud.example.test",
            sourceInstanceId: "paperclip-local-default",
            sourceInstanceFingerprint: "sha256:test",
            scopes: ["upstream_import:preview"],
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        });
      }
      return jsonResponse({ error: "not_found" }, 404);
    }) as typeof fetch;

    const connection = await connectCloud("https://cloud.example.test", { noBrowser: true, json: true });

    expect(connection.accessToken).toBe("upt_test");
    expect(getCloudConnection("https://cloud.example.test")?.token.id).toBe("token-1");
    const rawStore = fs.readFileSync(resolveCloudConnectionStorePath(), "utf8");
    expect(rawStore).not.toContain("upt_test");
    expect(rawStore).not.toContain("PRIVATE KEY");
    expect(rawStore).toContain("accessTokenMaterial");
    expect(rawStore).toContain("privateKeyMaterial");
  });

  it("hard-blocks incompatible transfer schema versions with the stable schema exit code", () => {
    expect(() => assertDiscoveryCompatible(discovery({ supportedSchemaMajor: 99 }))).toThrow(/schema mismatch/i);
    expect(() => assertDiscoveryCompatible(discovery({ featureFlags: [] }))).toThrow(/cloud_sync/);
    expect(cloudCommandExitCodes.schemaMismatch).toBe(3);
  });

  it("requires HTTPS before fetching cloud discovery except for localhost development", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("discovery fetch should not run for insecure remote URLs");
    }) as typeof fetch;

    await expect(discoverUpstream("http://cloud.example.test")).rejects.toThrow(/must use HTTPS/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("builds deterministic chunks with validated payload hashes", async () => {
    const bundle = await buildTestBundle();

    expect(bundle.chunks).toHaveLength(2);
    expect(bundle.manifest.perEntityTypeCounts.company).toBe(1);
    expect(bundle.chunks[0]?.sha256).toBe(normalizedContentHash(bundle.chunks[0]?.payload));
    expect(bundle.manifest.chunks[0]?.manifestHash).toBe(bundle.manifest.manifestHash);
    expect(bundle.manifest.idempotencyKey).toBe((await buildTestBundle()).manifest.idempotencyKey);
  });

  it("fails device-code authorization when expiresAt is malformed", async () => {
    globalThis.fetch = vi.fn(async (url, init) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/.well-known/paperclip-upstream")) {
        return jsonResponse(discovery());
      }
      if (requestUrl.endsWith("/api/upstream-sync/device-code")) {
        return jsonResponse({
          deviceCode: "device-1",
          userCode: "ABCD-EFGH",
          verificationUri: "https://cloud.example.test/api/upstream-sync/device-code/approve",
          expiresAt: "not-a-date",
          intervalSeconds: 0,
        });
      }
      throw new Error(`unexpected request: ${requestUrl} ${init?.method ?? "GET"}`);
    }) as typeof fetch;

    await expect(connectCloud("https://cloud.example.test", { noBrowser: true, json: true }))
      .rejects.toThrow(/valid expiresAt/);
  });

  it("reuses the same manifest and chunk identity when an interrupted apply is retried", async () => {
    const bundle = await buildTestBundle();
    const calls: Array<{ path: string; body: unknown }> = [];
    const coordinator = new LocalUpstreamPushCoordinator({
      targetOrigin: "https://cloud.example.test",
      paperclipCompanyId: "target-company-1",
      fetch: async (url, init) => {
        const parsed = new URL(String(url));
        const body = init?.body ? JSON.parse(String(init.body)) as unknown : {};
        calls.push({ path: parsed.pathname, body });
        if (parsed.pathname.endsWith("/runs")) return jsonResponse({ run: { id: "run-1" } });
        return jsonResponse({ run: { id: "run-1" }, summary: { create: 0, update: 0, adopt: 0, skip: 2, conflict: 0, staleMapping: 0 } });
      },
    });

    await coordinator.apply(bundle);
    await coordinator.apply(bundle);

    const runBodies = calls.filter((call) => call.path.endsWith("/runs")).map((call) => call.body as { manifest: { idempotencyKey: string } });
    const chunkBodies = calls.filter((call) => call.path.endsWith("/chunks")).map((call) => call.body as { chunkIndex: number; sha256: string });
    expect(runBodies).toHaveLength(2);
    expect(runBodies[0]?.manifest.idempotencyKey).toBe(runBodies[1]?.manifest.idempotencyKey);
    expect(chunkBodies[0]).toEqual(chunkBodies[2]);
    expect(chunkBodies[1]).toEqual(chunkBodies[3]);
  });

  it("uses the manifest-only request shape for CLI previews", async () => {
    const bundle = await buildTestBundle();
    const calls: Array<{ path: string; body: unknown }> = [];
    const coordinator = new LocalUpstreamPushCoordinator({
      targetOrigin: "https://cloud.example.test",
      paperclipCompanyId: "target-company-1",
      fetch: async (url, init) => {
        const parsed = new URL(String(url));
        calls.push({ path: parsed.pathname, body: init?.body ? JSON.parse(String(init.body)) as unknown : {} });
        return jsonResponse({ warnings: [], conflicts: [] });
      },
    });

    await coordinator.preview(bundle);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/api/companies/target-company-1/upstream-imports/preview");
    expect(calls[0]?.body).toMatchObject({
      manifest: bundle.manifest,
      previewShape: "manifest_only",
      conflictKeysBySource: {},
    });
    expect(calls[0]?.body).not.toHaveProperty("entities");
  });
});

async function buildTestBundle(): Promise<LocalUpstreamExportBundle> {
  return buildBundleFromLocalCompany({
    localCompanyId: "local-company-1",
    connection: {
      id: "conn-1",
      remoteUrl: "https://cloud.example.test",
      targetOrigin: "https://cloud.example.test",
      targetHost: "cloud.example.test",
      stackId: "stack-1",
      targetCompanyId: "target-company-1",
      accessToken: "upt_test",
      token: {
        id: "token-1",
        companyStackId: "stack-1",
        targetOrigin: "https://cloud.example.test",
        sourceInstanceId: "paperclip-local-default",
        sourceInstanceFingerprint: "sha256:test",
        scopes: ["upstream_import:preview"],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      privateKeyPem: "unused",
      sourcePublicKey: "unused",
      sourceInstanceId: "paperclip-local-default",
      sourceInstanceFingerprint: "sha256:test",
      scopes: ["upstream_import:preview"],
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z",
    },
    discovery: discovery(),
    localApi: {
      post: async <T>() => portabilityExport() as T,
    },
    maxEntitiesPerChunk: 1,
    mode: "apply",
  });
}

function discovery(overrides: Partial<{ supportedSchemaMajor: number; featureFlags: string[] }> = {}) {
  return {
    schema: "paperclip-upstream-discovery-v1",
    stack: {
      id: "stack-1",
      slug: "cloud-test",
      displayName: "Cloud Test",
      companyId: "target-company-1",
      origin: "https://cloud.example.test",
    },
    auth: {
      deviceCode: {
        deviceCodeUrl: "https://cloud.example.test/api/upstream-sync/device-code",
        verificationUrl: "https://cloud.example.test/api/upstream-sync/device-code/approve",
        tokenUrl: "https://cloud.example.test/api/upstream-sync/token",
      },
      scopes: ["upstream_import:preview", "upstream_import:write", "upstream_import:read"],
    },
    transfer: {
      supportedSchemaMajor: overrides.supportedSchemaMajor ?? 1,
      featureFlags: overrides.featureFlags ?? ["cloud_sync"],
    },
  };
}

function portabilityExport(): CompanyPortabilityExportResult {
  return {
    rootPath: ".",
    paperclipExtensionPath: ".paperclip.yaml",
    manifest: {
      schemaVersion: 1,
      generatedAt: "2026-05-18T00:00:00.000Z",
      source: {
        companyId: "local-company-1",
        companyName: "Local Company",
      },
      includes: {
        company: true,
        agents: true,
        projects: true,
        issues: true,
        skills: true,
      },
      company: {
        path: "company.json",
        name: "Local Company",
        description: null,
        brandColor: null,
        logoPath: null,
        attachmentMaxBytes: null,
        requireBoardApprovalForNewAgents: false,
        feedbackDataSharingEnabled: false,
        feedbackDataSharingConsentAt: null,
        feedbackDataSharingConsentByUserId: null,
        feedbackDataSharingTermsVersion: null,
      },
      sidebar: null,
      agents: [],
      skills: [],
      projects: [],
      issues: [],
      envInputs: [],
    },
    files: {
      "README.md": "Local Company",
    },
    warnings: [],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
