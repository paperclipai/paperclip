// inventory-mapping.test.ts — hermes_gateway read-only inventory mapping
// (Layer 1, spec-309 Phase 1, Plan 02). Colocated fork-convention vitest
// suite (mirrors `packages/adapters/hermes/src/index.test.ts`): constructs
// the REAL gateway adapter via `createServerAdapter()` and exercises the
// PUBLIC surface (`listSkills`/`syncSkills`) only — no test-local
// reimplementation of the mapping/sync logic.
//
// Overlay-copied by
// specs/309-hermes-gateway-remote-skill-contract/scripts/build-paperclip-hermes-fork.sh
// into the fork's `packages/adapters/hermes/src/gateway/` alongside
// capabilities.ts, skills.ts, and the modified index.ts, and run under the
// fork's OWN vitest (`pnpm exec vitest run src/gateway/inventory-mapping.test.ts`)
// by tests/inventory-mapping.test.mjs (the node:test wrapper ROADMAP
// criterion 1's literal command executes) — gap round 2: plain `node --test`
// cannot resolve the pinned adapter-utils raw-src import chain that
// createServerAdapter() requires (see 01-02-PLAN.md "Gap round 2" section).
//
// Stub fixture (the ONLY mock boundary, per 01-CONTEXT.md) is vendored
// alongside this test file at ./test-fixtures/hermes-stub-server.mjs and
// resolved by a test-file-relative path — self-contained upstream, zero
// openclaw-local env-var conventions. It has no declaration file, so the
// dynamic import below cannot be a static import.

import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import type { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";
import { createServerAdapter } from "./index.js";
import { LEGACY_UNSUPPORTED_RESPONSE } from "./capabilities.js";

const STUB_FIXTURE_PATH = fileURLToPath(new URL("./test-fixtures/hermes-stub-server.mjs", import.meta.url));

interface StubRequestRecord {
  method: string | null;
  path: string | null;
  hasValidAuth: boolean | null;
}

interface StubHandle {
  server: { close: () => void };
  baseUrl: string;
  requests: StubRequestRecord[];
}

interface StubModule {
  startHermesStub: (mode: string) => Promise<StubHandle>;
  STUB_API_KEY: string;
}

// Runtime string import — TS cannot statically resolve a module outside this
// package, so the module shape is asserted via the interface above (not
// `as any` — the forbidden-suppression list per 01-02-PLAN.md is `as any` /
// `@ts-ignore` / `@ts-expect-error`, none of which appear here).
const stubModulePromise: Promise<StubModule> = import(STUB_FIXTURE_PATH);

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

function makeCtx(config: Record<string, unknown>): AdapterSkillContext {
  return { adapterType: "hermes_gateway", agentId: AGENT_ID, companyId: COMPANY_ID, config };
}

type Adapter = ReturnType<typeof createServerAdapter>;

async function callListSkills(adapter: Adapter, config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  expect(adapter.listSkills, "listSkills is not registered in createServerAdapter()").toBeTypeOf("function");
  const snapshot = await adapter.listSkills?.(makeCtx(config));
  if (!snapshot) throw new Error("listSkills returned no snapshot");
  return snapshot;
}

async function callSyncSkills(
  adapter: Adapter,
  config: Record<string, unknown>,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  expect(adapter.syncSkills, "syncSkills is not registered in createServerAdapter()").toBeTypeOf("function");
  const snapshot = await adapter.syncSkills?.(makeCtx(config), desiredSkills);
  if (!snapshot) throw new Error("syncSkills returned no snapshot");
  return snapshot;
}

test("listSkills_readonly_invariant", async () => {
  const adapter = createServerAdapter();
  const { startHermesStub, STUB_API_KEY } = await stubModulePromise;
  const { server, baseUrl } = await startHermesStub("v0_16");
  try {
    const snapshot = await callListSkills(adapter, {
      apiBaseUrl: baseUrl,
      apiKey: STUB_API_KEY,
      negotiationTimeoutMs: 2_000,
    });

    expect(snapshot.supported).toBe(true);
    expect(snapshot.mode).toBe("unsupported");
    expect(snapshot.desiredSkills).toEqual([]);
    expect(snapshot.entries.length).toBeGreaterThan(0);

    for (const entry of snapshot.entries) {
      expect(entry.managed).toBe(false);
      expect(entry.desired).toBe(false);
      expect(entry.state).toBe("available");
      expect(entry.state).not.toBe("installed");
      expect(entry.state).not.toBe("configured");
      expect(entry.readOnly).toBe(true);
      expect(entry.origin).toBe("external_unknown");
      expect(entry.originLabel).toBe("remote-native");
      expect(entry.key).toBeTruthy();
      expect(entry.runtimeName).toBeTruthy();
    }

    // FR-004: no remote field (canary included) propagates — proves
    // field-by-field construction, never a spread of the remote object.
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("internalToken");
    expect(serialized).not.toContain("syncedStatus");
    expect(serialized).not.toContain("spec309-canary-internal-token-DO-NOT-LEAK");
  } finally {
    server.close();
  }
});

test("listSkills_wrong_token_auth_error", async () => {
  const adapter = createServerAdapter();
  const { startHermesStub } = await stubModulePromise;
  const { server, baseUrl } = await startHermesStub("v0_16");
  try {
    const snapshot = await callListSkills(adapter, {
      apiBaseUrl: baseUrl,
      apiKey: "spec309-WRONG-synthetic-bearer",
      negotiationTimeoutMs: 2_000,
    });

    expect(snapshot.supported).toBe(false);
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.warnings.some((w) => w.includes("auth_error"))).toBe(true);
  } finally {
    server.close();
  }
});

test("listSkills_malformed_item_rejected", async () => {
  const adapter = createServerAdapter();
  const { startHermesStub, STUB_API_KEY } = await stubModulePromise;
  const { server, baseUrl } = await startHermesStub("bad_item");
  try {
    const snapshot = await callListSkills(adapter, {
      apiBaseUrl: baseUrl,
      apiKey: STUB_API_KEY,
      negotiationTimeoutMs: 2_000,
    });

    expect(snapshot.supported).toBe(false);
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.warnings.some((w) => w.includes("malformed"))).toBe(true);
  } finally {
    server.close();
  }
});

test("listSkills_unknown_major_refuse", async () => {
  const adapter = createServerAdapter();
  const { startHermesStub, STUB_API_KEY } = await stubModulePromise;
  const { server, baseUrl } = await startHermesStub("unknown_major");
  try {
    const snapshot = await callListSkills(adapter, {
      apiBaseUrl: baseUrl,
      apiKey: STUB_API_KEY,
      negotiationTimeoutMs: 2_000,
    });

    expect(snapshot.supported).toBe(false);
    expect(snapshot.entries).toEqual([]);
  } finally {
    server.close();
  }
});

test("syncSkills_honest_unsupported_zero_calls", async () => {
  const adapter = createServerAdapter();
  const { startHermesStub, STUB_API_KEY } = await stubModulePromise;
  const { server, baseUrl, requests } = await startHermesStub("v0_16");
  try {
    const snapshot = await callSyncSkills(
      adapter,
      { apiBaseUrl: baseUrl, apiKey: STUB_API_KEY, negotiationTimeoutMs: 2_000 },
      ["brand-voice"],
    );

    expect(snapshot.supported).toBe(LEGACY_UNSUPPORTED_RESPONSE.supported);
    expect(snapshot.mode).toBe(LEGACY_UNSUPPORTED_RESPONSE.mode);
    expect(snapshot.entries).toEqual([...LEGACY_UNSUPPORTED_RESPONSE.entries]);
    expect(snapshot.warnings).toContain(LEGACY_UNSUPPORTED_RESPONSE.warning);

    // Full transcript: only permitted capability/inventory GETs — no other
    // method or path (zero activation calls, T-01-05).
    for (const req of requests) {
      expect(req.method).toBe("GET");
      expect(["/v1/capabilities", "/v1/skills"]).toContain(req.path);
    }
  } finally {
    server.close();
  }
});

test("INT_001_negotiate_and_list_end_to_end", async () => {
  const adapter = createServerAdapter();
  const { startHermesStub, STUB_API_KEY } = await stubModulePromise;
  const { server, baseUrl, requests } = await startHermesStub("v0_16");
  try {
    const snapshot = await callListSkills(adapter, {
      apiBaseUrl: baseUrl,
      apiKey: STUB_API_KEY,
      negotiationTimeoutMs: 2_000,
    });

    expect(snapshot.supported).toBe(true);
    expect(snapshot.mode).toBe("unsupported");
    for (const entry of snapshot.entries) {
      expect(entry.managed).toBe(false);
      expect(entry.desired).toBe(false);
      expect(entry.state).toBe("available");
      expect(entry.readOnly).toBe(true);
    }

    // Wire-order invariant: GET /v1/capabilities precedes exactly ONE
    // authenticated GET /v1/skills — negotiate-FIRST falsified at the wire.
    const capIndex = requests.findIndex((r) => r.path === "/v1/capabilities");
    const skillsRequests = requests.filter((r) => r.path === "/v1/skills");
    expect(capIndex).toBeGreaterThanOrEqual(0);
    expect(skillsRequests.length).toBe(1);
    const skillsIndex = requests.findIndex((r) => r.path === "/v1/skills");
    expect(skillsIndex).toBeGreaterThan(capIndex);
    expect(requests[skillsIndex]?.hasValidAuth).toBe(true);
  } finally {
    server.close();
  }
});
