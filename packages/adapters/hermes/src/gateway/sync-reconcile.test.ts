// sync-reconcile.test.ts — hermes_gateway syncSkills deterministic reconcile
// (Layer 2, spec-309 Phase 2, Plan 03). Colocated fork-convention vitest
// suite (mirrors inventory-mapping.test.ts): constructs the REAL gateway
// adapter via `createServerAdapter()` and exercises the PUBLIC surface
// (`syncSkills`) only — no test-local reimplementation of the reconcile
// logic. Every hash is computed at runtime via node:crypto; zero hand-typed
// sha256 hex strings.
//
// Overlay-copied by build-paperclip-hermes-fork.sh into the fork's
// `packages/adapters/hermes/src/gateway/` and run under the fork's own
// vitest by tests/sync-reconcile.test.mjs (the node:test wrapper ROADMAP
// criterion 1's literal command executes).
//
// Stub fixture (the ONLY mock boundary, per 01-CONTEXT.md) is vendored
// alongside this test file at ./test-fixtures/hermes-stub-server.mjs and
// resolved by a test-file-relative path — self-contained upstream, zero
// openclaw-local env-var conventions. It has no declaration file, so the
// dynamic import below cannot be a static import.

import { expect, test } from "vitest";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";
import { createServerAdapter } from "./index.js";
import { LEGACY_UNSUPPORTED_RESPONSE } from "./capabilities.js";

const STUB_FIXTURE_PATH = fileURLToPath(new URL("./test-fixtures/hermes-stub-server.mjs", import.meta.url));

interface StubRequestRecord {
  method: string | null;
  path: string | null;
  hasValidAuth: boolean | null;
  body?: unknown;
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
// `as any` — the forbidden-suppression list is `as any` / `@ts-ignore` /
// `@ts-expect-error`, none of which appear here).
const stubModulePromise: Promise<StubModule> = import(STUB_FIXTURE_PATH);

const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const COMPANY_ID = "44444444-4444-4444-8444-444444444444";

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

interface Bundle {
  version: string;
  content: string;
}

function makeCtx(
  baseUrl: string,
  apiKey: string,
  desiredSkillBundles: Record<string, Bundle>,
): AdapterSkillContext {
  return {
    adapterType: "hermes_gateway",
    agentId: AGENT_ID,
    companyId: COMPANY_ID,
    config: { apiBaseUrl: baseUrl, apiKey, negotiationTimeoutMs: 2_000, desiredSkillBundles },
  };
}

type Adapter = ReturnType<typeof createServerAdapter>;

async function sync(
  adapter: Adapter,
  baseUrl: string,
  apiKey: string,
  desired: string[],
  bundles: Record<string, Bundle>,
): Promise<AdapterSkillSnapshot> {
  expect(adapter.syncSkills, "syncSkills is not registered in createServerAdapter()").toBeTypeOf("function");
  const snapshot = await adapter.syncSkills?.(makeCtx(baseUrl, apiKey, bundles), desired);
  if (!snapshot) throw new Error("syncSkills returned no snapshot");
  return snapshot;
}

// --- direct-wire helpers (pre-seeding / rollback / raw managed reads) ------
// Mirrors tests/stub-activation-wire.test.mjs's helpers — drives the real
// stub over loopback HTTP, no reconcile logic reimplemented.

async function directActivate(
  baseUrl: string,
  apiKey: string,
  opts: { skillId: string; version?: string; content: string; key: string },
): Promise<{ status: number; body: any }> {
  const hash = `sha256:${sha256Hex(opts.content)}`;
  const res = await fetch(`${baseUrl}/v1/skills/activations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      contractVersion: "1",
      idempotencyKey: opts.key,
      skill: { skillId: opts.skillId, version: opts.version ?? "1", contentHash: hash, content: opts.content },
    }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

async function directDelete(
  baseUrl: string,
  apiKey: string,
  skillId: string,
  mode: "clean" | "rollback",
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/v1/skills/activations/${encodeURIComponent(skillId)}?mode=${mode}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const body = await res.json();
  return { status: res.status, body };
}

async function directManagedInventory(baseUrl: string, apiKey: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/v1/skills?scope=managed`, { headers: { authorization: `Bearer ${apiKey}` } });
  const body = await res.json();
  return { status: res.status, body };
}

function bundle(content: string, version = "1"): Bundle {
  return { version, content };
}

// Typed narrowing for a POST transcript record's body — never `as any` (the
// forbidden-suppression list is `as any` / `@ts-ignore` / `@ts-expect-error`).
function asRecordBody(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function postedSkillId(record: StubRequestRecord): unknown {
  const body = asRecordBody(record.body);
  const skill = body ? asRecordBody(body.skill) : null;
  return skill?.skillId;
}

function postedIdempotencyKey(record: StubRequestRecord): unknown {
  return asRecordBody(record.body)?.idempotencyKey;
}

function postRequests(requests: StubRequestRecord[]): StubRequestRecord[] {
  return requests.filter((r) => r.method === "POST" && r.path === "/v1/skills/activations");
}

function deleteRequests(requests: StubRequestRecord[]): StubRequestRecord[] {
  return requests.filter((r) => r.method === "DELETE");
}

test("reconcile_INT_003_desired_activated_observed_clean", async () => {
  const adapter = createServerAdapter();
  const { startHermesStub, STUB_API_KEY } = await stubModulePromise;
  const { server, baseUrl, requests } = await startHermesStub("v1_activation");
  try {
    const content = "# int-003\nbrand new skill content";
    const snapshot = await sync(adapter, baseUrl, STUB_API_KEY, ["int-003-skill"], {
      "int-003-skill": bundle(content, "7"),
    });

    expect(snapshot.supported).toBe(true);
    expect(snapshot.mode).toBe("persistent");
    expect(snapshot.desiredSkills).toEqual(["int-003-skill"]);
    expect(snapshot.desiredSkillEntries).toEqual([{ key: "int-003-skill", versionId: "7" }]);
    expect(snapshot.warnings).toEqual([]);

    const entry = snapshot.entries.find((e) => e.key === "int-003-skill");
    expect(entry, "expected an entry for int-003-skill").toBeTruthy();
    expect(entry?.state).toBe("installed");
    expect(entry?.detail).toBe("activated");
    expect(entry?.managed).toBe(true);
    expect(entry?.readOnly).not.toBe(true);
    expect(entry?.versionId).toBe("7");
    if (entry?.origin !== undefined) {
      expect(["company_managed", "user_installed", "external_unknown"]).toContain(entry.origin);
    }

    const { body: managed } = await directManagedInventory(baseUrl, STUB_API_KEY);
    const managedEntry = managed.data.find((d: any) => d.name === "int-003-skill");
    expect(managedEntry?.contentHash).toBe(`sha256:${sha256Hex(content)}`);

    const capIndex = requests.findIndex((r) => r.path === "/v1/capabilities");
    const baseSkillsIndex = requests.findIndex((r) => r.path === "/v1/skills");
    const managedGetIndices = requests
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.method === "GET" && r.path === "/v1/skills?scope=managed")
      .map(({ i }) => i);
    const postIndex = requests.findIndex((r) => r.method === "POST" && r.path === "/v1/skills/activations");
    expect(capIndex).toBeGreaterThanOrEqual(0);
    expect(baseSkillsIndex).toBeGreaterThan(capIndex);
    expect(managedGetIndices.length).toBeGreaterThanOrEqual(2);
    expect(managedGetIndices[0]).toBeGreaterThan(baseSkillsIndex);
    expect(postIndex).toBeGreaterThan(managedGetIndices[0]);
    expect(managedGetIndices[managedGetIndices.length - 1]).toBeGreaterThan(postIndex);
  } finally {
    server.close();
  }
});

test("reconcile_stale_by_hash_refreshed", async () => {
  const adapter = createServerAdapter();
  const { startHermesStub, STUB_API_KEY } = await stubModulePromise;
  const { server, baseUrl, requests } = await startHermesStub("v1_activation");
  try {
    const oldContent = "# stale\nold content";
    await directActivate(baseUrl, STUB_API_KEY, { skillId: "stale-skill", content: oldContent, key: "preseed-stale" });
    const beforeSync = requests.length;

    const newContent = "# stale\nnew content, definitely different";
    const snapshot = await sync(adapter, baseUrl, STUB_API_KEY, ["stale-skill"], {
      "stale-skill": bundle(newContent, "2"),
    });

    const entry = snapshot.entries.find((e) => e.key === "stale-skill");
    expect(entry?.state).toBe("installed");
    expect(entry?.detail).toBe("stale_refreshed");

    // Only the reconcile's own POST(s) count here — the preseed POST above
    // is excluded via the beforeSync slice.
    const posts = postRequests(requests.slice(beforeSync));
    expect(posts.length).toBe(1);

    const { body: managed } = await directManagedInventory(baseUrl, STUB_API_KEY);
    const managedEntry = managed.data.find((d: any) => d.name === "stale-skill");
    expect(managedEntry?.contentHash).toBe(`sha256:${sha256Hex(newContent)}`);
  } finally {
    server.close();
  }
});

test("reconcile_clean_managed_not_desired_only", async () => {
  const adapter = createServerAdapter();
  const { startHermesStub, STUB_API_KEY } = await stubModulePromise;
  const { server, baseUrl, requests } = await startHermesStub("v1_activation");
  try {
    await directActivate(baseUrl, STUB_API_KEY, {
      skillId: "orphan-skill",
      content: "# orphan\nto be cleaned",
      key: "preseed-orphan",
    });

    const newContent = "# fresh\nnewly desired";
    const snapshot = await sync(adapter, baseUrl, STUB_API_KEY, ["fresh-skill"], {
      "fresh-skill": bundle(newContent),
    });

    const deletes = deleteRequests(requests);
    expect(deletes.length).toBe(1);
    expect(deletes[0]?.path).toContain("orphan-skill");
    expect(deletes[0]?.path).toContain("mode=clean");
    // Never a DELETE for any native fixture name.
    expect(deletes.some((d) => d.path?.includes("brand-voice") || d.path?.includes("release-notes"))).toBe(false);

    expect(snapshot.warnings).toEqual(["reconcile:orphan-skill:cleaned"]);
    for (const entry of snapshot.entries) {
      expect(entry.state).toBe("installed");
    }

    const { body: managed } = await directManagedInventory(baseUrl, STUB_API_KEY);
    expect(managed.data.some((d: any) => d.name === "orphan-skill")).toBe(false);
  } finally {
    server.close();
  }
});

test("reconcile_never_mutates_remote_native", async () => {
  const adapter = createServerAdapter();
  const { startHermesStub, STUB_API_KEY } = await stubModulePromise;
  const { server, baseUrl, requests } = await startHermesStub("v1_activation");
  try {
    const newContent = "# native-test\na new one";
    const nativeContent = "# hijack-attempt\nshould never activate";
    const snapshot = await sync(adapter, baseUrl, STUB_API_KEY, ["brand-voice", "native-test-new"], {
      "brand-voice": bundle(nativeContent),
      "native-test-new": bundle(newContent),
    });

    const newEntry = snapshot.entries.find((e) => e.key === "native-test-new");
    expect(newEntry?.state).toBe("installed");
    expect(newEntry?.detail).toBe("activated");

    const nativeEntry = snapshot.entries.find((e) => e.key === "brand-voice");
    expect(nativeEntry?.state).toBe("external");
    expect(nativeEntry?.detail).toBe("native_conflict");
    expect(snapshot.warnings.some((w) => w.includes("brand-voice"))).toBe(true);

    const posts = postRequests(requests);
    expect(posts.some((p) => postedSkillId(p) === "brand-voice")).toBe(false);
    expect(posts.some((p) => postedSkillId(p) === "native-test-new")).toBe(true);

    const { body: base } = await fetch(`${baseUrl}/v1/skills`, {
      headers: { authorization: `Bearer ${STUB_API_KEY}` },
    }).then(async (r) => ({ body: await r.json() }));
    expect(base.data.some((d: any) => d.name === "brand-voice")).toBe(true);
  } finally {
    server.close();
  }
});

test("reconcile_repeat_run_zero_mutations_idempotent", async () => {
  const adapter = createServerAdapter();
  const { startHermesStub, STUB_API_KEY } = await stubModulePromise;
  const { server, baseUrl, requests } = await startHermesStub("v1_activation");
  try {
    const content = "# repeat\nstable content";
    const bundles = { "repeat-skill": bundle(content) };

    const first = await sync(adapter, baseUrl, STUB_API_KEY, ["repeat-skill"], bundles);
    const firstEntry = first.entries.find((e) => e.key === "repeat-skill");
    expect(firstEntry?.state).toBe("installed");
    expect(firstEntry?.detail).toBe("activated");

    const beforeSecond = requests.length;
    const second = await sync(adapter, baseUrl, STUB_API_KEY, ["repeat-skill"], bundles);
    const secondSlice = requests.slice(beforeSecond);

    expect(postRequests(secondSlice).length).toBe(0);
    expect(deleteRequests(secondSlice).length).toBe(0);
    expect(secondSlice.filter((r) => r.method === "GET").length).toBe(3);

    for (const entry of second.entries) {
      expect(["installed"]).toContain(entry.state);
      expect(["already_installed"]).toContain(entry.detail);
    }
    expect(second.warnings).toEqual([]);
  } finally {
    server.close();
  }
});

test("reconcile_ack_without_observed_stays_red", async () => {
  const adapter = createServerAdapter();
  const { startHermesStub, STUB_API_KEY } = await stubModulePromise;
  const { server, baseUrl } = await startHermesStub("v1_ack_not_observed");
  try {
    const snapshot = await sync(adapter, baseUrl, STUB_API_KEY, ["ghost-skill"], {
      "ghost-skill": bundle("# ghost\nnever truly observed"),
    });

    const entry = snapshot.entries.find((e) => e.key === "ghost-skill");
    expect(entry?.state).not.toBe("installed");
    expect(entry?.detail).toBe("activated_not_observed");
    expect(entry?.managed).toBe(false);
    expect(snapshot.warnings.length).toBeGreaterThan(0);
  } finally {
    server.close();
  }
});

test("reconcile_INT_005_wrong_scope_403_zero_transitions", async () => {
  const adapter = createServerAdapter();
  const { startHermesStub, STUB_API_KEY } = await stubModulePromise;
  const { server, baseUrl, requests } = await startHermesStub("v1_wrong_scope");
  try {
    const snapshot = await sync(adapter, baseUrl, STUB_API_KEY, ["aaa-first", "zzz-second"], {
      "aaa-first": bundle("# aaa\nfirst"),
      "zzz-second": bundle("# zzz\nsecond"),
    });

    const posts = postRequests(requests);
    expect(posts.length).toBe(1);
    expect(deleteRequests(requests).length).toBe(0);

    const first = snapshot.entries.find((e) => e.key === "aaa-first");
    const second = snapshot.entries.find((e) => e.key === "zzz-second");
    expect(first?.detail).toBe("failed:wrong_scope");
    expect(second?.detail).toBe("skipped_after_wrong_scope");
    expect(snapshot.warnings.some((w) => w.includes("wrong_scope"))).toBe(true);
  } finally {
    server.close();
  }
});

test("reconcile_auth_error_fail_closed_zero_activation_calls", async () => {
  const adapter = createServerAdapter();
  const { startHermesStub, STUB_API_KEY } = await stubModulePromise;
  const { server, baseUrl, requests } = await startHermesStub("auth_fail");
  try {
    const snapshot = await sync(adapter, baseUrl, STUB_API_KEY, ["whatever"], {
      whatever: bundle("# whatever\ncontent"),
    });

    expect(snapshot.supported).toBe(LEGACY_UNSUPPORTED_RESPONSE.supported);
    expect(snapshot.mode).toBe(LEGACY_UNSUPPORTED_RESPONSE.mode);
    expect(snapshot.entries).toEqual([...LEGACY_UNSUPPORTED_RESPONSE.entries]);
    expect(snapshot.warnings).toContain(LEGACY_UNSUPPORTED_RESPONSE.warning);

    for (const req of requests) {
      expect(req.method).toBe("GET");
      expect(["/v1/capabilities", "/v1/skills"]).toContain(req.path);
    }
  } finally {
    server.close();
  }
});

test("reconcile_integrity_409_reported_failed", async () => {
  const adapter = createServerAdapter();
  const { startHermesStub, STUB_API_KEY } = await stubModulePromise;
  const { server, baseUrl } = await startHermesStub("v1_integrity_409");
  try {
    const snapshot = await sync(adapter, baseUrl, STUB_API_KEY, ["forced-409"], {
      "forced-409": bundle("# forced\nintegrity injection"),
    });

    const entry = snapshot.entries.find((e) => e.key === "forced-409");
    expect(entry?.detail?.startsWith("failed:")).toBe(true);
    expect(entry?.state).toBe("missing");
    expect(entry?.state).not.toBe("installed");
    expect(snapshot.warnings.length).toBeGreaterThan(0);

    const { body: managed } = await directManagedInventory(baseUrl, STUB_API_KEY);
    expect(managed.data).toEqual([]);
  } finally {
    server.close();
  }
});

test("reconcile_INT_004_concurrent_double_sync_single_final_state", async () => {
  const adapter1 = createServerAdapter();
  const adapter2 = createServerAdapter();
  const { startHermesStub, STUB_API_KEY } = await stubModulePromise;
  const { server, baseUrl, requests } = await startHermesStub("v1_activation");
  try {
    const content = "# concurrent\nidentical content both runs";
    const bundles = { "concurrent-skill": bundle(content) };

    const [snap1, snap2] = await Promise.all([
      sync(adapter1, baseUrl, STUB_API_KEY, ["concurrent-skill"], bundles),
      sync(adapter2, baseUrl, STUB_API_KEY, ["concurrent-skill"], bundles),
    ]);

    const e1 = snap1.entries.find((e) => e.key === "concurrent-skill");
    const e2 = snap2.entries.find((e) => e.key === "concurrent-skill");
    expect(e1?.state).toBe("installed");
    expect(e2?.state).toBe("installed");

    const { body: managed } = await directManagedInventory(baseUrl, STUB_API_KEY);
    const matches = managed.data.filter((d: any) => d.name === "concurrent-skill");
    expect(matches.length).toBe(1);
    expect(matches[0]?.contentHash).toBe(`sha256:${sha256Hex(content)}`);

    const posts = postRequests(requests).filter((p) => postedSkillId(p) === "concurrent-skill");
    expect(posts.length).toBe(2);
    const keys = new Set(posts.map((p) => postedIdempotencyKey(p)));
    expect(keys.size).toBe(1);
  } finally {
    server.close();
  }
});

test("reconcile_layer1_unsupported_guard_byte_compat", async () => {
  const adapter = createServerAdapter();
  const { startHermesStub, STUB_API_KEY } = await stubModulePromise;
  const { server, baseUrl, requests } = await startHermesStub("v0_16");
  try {
    const snapshot = await sync(adapter, baseUrl, STUB_API_KEY, ["brand-voice"], {
      "brand-voice": bundle("# ignored\nno activation advert"),
    });

    expect(snapshot.supported).toBe(LEGACY_UNSUPPORTED_RESPONSE.supported);
    expect(snapshot.mode).toBe(LEGACY_UNSUPPORTED_RESPONSE.mode);
    expect(snapshot.entries).toEqual([...LEGACY_UNSUPPORTED_RESPONSE.entries]);
    expect(snapshot.warnings).toContain(LEGACY_UNSUPPORTED_RESPONSE.warning);
    expect(postRequests(requests).length).toBe(0);
    expect(deleteRequests(requests).length).toBe(0);
  } finally {
    server.close();
  }
});

test("reconcile_wire_carries_content_identity_never_path", async () => {
  const adapter = createServerAdapter();
  const { startHermesStub, STUB_API_KEY } = await stubModulePromise;
  const { server, baseUrl, requests } = await startHermesStub("v1_activation");
  try {
    const content = "# wire-shape\nasserted body shape";
    await sync(adapter, baseUrl, STUB_API_KEY, ["wire-shape-skill"], {
      "wire-shape-skill": bundle(content, "9"),
    });

    const posts = postRequests(requests);
    expect(posts.length).toBeGreaterThanOrEqual(1);

    const DENYLIST = new Set([
      "path",
      "filePath",
      "file_path",
      "sourcePath",
      "source_path",
      "localPath",
      "local_path",
      "dir",
      "directory",
    ]);

    function scanNoPathLeak(value: unknown, skipKey: string | null): void {
      if (Array.isArray(value)) {
        for (const item of value) scanNoPathLeak(item, skipKey);
        return;
      }
      if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          expect(DENYLIST.has(key)).toBe(false);
          scanNoPathLeak(child, key === "skill" ? "content" : skipKey);
        }
        return;
      }
      if (typeof value === "string" && skipKey !== "content-value") {
        expect(value.includes("..")).toBe(false);
      }
    }

    for (const req of posts) {
      const body = asRecordBody(req.body);
      expect(body).toBeTruthy();
      expect(body?.contractVersion).toBe("1");
      expect(typeof body?.idempotencyKey).toBe("string");
      expect(body?.idempotencyKey).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
      const skill = body ? asRecordBody(body.skill) : null;
      expect(skill?.skillId).toBeTruthy();
      expect(skill?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(String(skill?.skillId).includes("/")).toBe(false);
      expect(String(skill?.skillId).includes("..")).toBe(false);
      expect(String(skill?.version).includes("/")).toBe(false);
      expect(String(skill?.version).includes("..")).toBe(false);
      scanNoPathLeak(body, null);
    }
  } finally {
    server.close();
  }
});

test("reconcile_REQ_007_rollback_restores_prior_managed_state", async () => {
  const adapter = createServerAdapter();
  const { startHermesStub, STUB_API_KEY } = await stubModulePromise;
  const { server, baseUrl } = await startHermesStub("v1_activation");
  try {
    const contentA = "# rollback\nversion A content";
    const contentB = "# rollback\nversion B content, longer and different";

    const snapA = await sync(adapter, baseUrl, STUB_API_KEY, ["rollback-skill"], {
      "rollback-skill": bundle(contentA, "1"),
    });
    expect(snapA.entries.find((e) => e.key === "rollback-skill")?.detail).toBe("activated");

    const snapB = await sync(adapter, baseUrl, STUB_API_KEY, ["rollback-skill"], {
      "rollback-skill": bundle(contentB, "2"),
    });
    expect(snapB.entries.find((e) => e.key === "rollback-skill")?.detail).toBe("stale_refreshed");

    const { body: managedAfterB } = await directManagedInventory(baseUrl, STUB_API_KEY);
    expect(managedAfterB.data.find((d: any) => d.name === "rollback-skill")?.contentHash).toBe(
      `sha256:${sha256Hex(contentB)}`,
    );

    const { status: rollbackStatus, body: rollbackBody } = await directDelete(
      baseUrl,
      STUB_API_KEY,
      "rollback-skill",
      "rollback",
    );
    expect(rollbackStatus).toBe(200);
    expect(rollbackBody.ack.restored).toBe(true);

    const { body: managedAfterRollback } = await directManagedInventory(baseUrl, STUB_API_KEY);
    expect(managedAfterRollback.data.find((d: any) => d.name === "rollback-skill")?.contentHash).toBe(
      `sha256:${sha256Hex(contentA)}`,
    );
  } finally {
    server.close();
  }
});

test("reconcile_input_validation_fail_closed_and_dedupe", async () => {
  const adapter = createServerAdapter();
  const { startHermesStub, STUB_API_KEY } = await stubModulePromise;
  const { server, baseUrl, requests } = await startHermesStub("v1_activation");
  try {
    // (a) no bundle entry
    const snapA = await sync(adapter, baseUrl, STUB_API_KEY, ["no-bundle-skill"], {});
    const entryA = snapA.entries.find((e) => e.key === "no-bundle-skill");
    expect(entryA?.detail).toBe("failed:no_bundle");
    expect(postRequests(requests).length).toBe(0);

    // (b) invalid skillId shape
    const snapB = await sync(adapter, baseUrl, STUB_API_KEY, ["Invalid_ID_Upper"], {
      Invalid_ID_Upper: bundle("# invalid\ncontent"),
    });
    const entryB = snapB.entries.find((e) => e.key === "Invalid_ID_Upper");
    expect(entryB?.detail).toBe("failed:invalid_skill_id");
    expect(postRequests(requests).length).toBe(0);

    // (c) 501 desired names — fail-closed, zero wire mutations
    const manyNames = Array.from({ length: 501 }, (_, i) => `cap-test-skill-${i}`);
    const manyBundles: Record<string, Bundle> = {};
    for (const n of manyNames) manyBundles[n] = bundle(`# ${n}\ncontent`);
    const snapC = await sync(adapter, baseUrl, STUB_API_KEY, manyNames, manyBundles);
    expect(snapC.warnings.length).toBeGreaterThan(0);
    expect(postRequests(requests).length).toBe(0);
    expect(deleteRequests(requests).length).toBe(0);

    // (d) duplicate desired names — dedupe, first occurrence wins
    const beforeD = requests.length;
    const snapD = await sync(adapter, baseUrl, STUB_API_KEY, ["dup-skill", "dup-skill"], {
      "dup-skill": bundle("# dup\ncontent"),
    });
    expect(snapD.entries.filter((e) => e.key === "dup-skill").length).toBe(1);
    const dSlice = requests.slice(beforeD);
    expect(postRequests(dSlice).length).toBe(1);
  } finally {
    server.close();
  }
});

test("reconcile_reactivation_after_clean_reinstalls", async () => {
  const adapter = createServerAdapter();
  const { startHermesStub, STUB_API_KEY } = await stubModulePromise;
  const { server, baseUrl } = await startHermesStub("v1_activation");
  try {
    const content = "# reactivate\nsame content every time";
    const bundles = { "reactivate-me": bundle(content) };

    const snap1 = await sync(adapter, baseUrl, STUB_API_KEY, ["reactivate-me"], bundles);
    expect(snap1.entries.find((e) => e.key === "reactivate-me")?.state).toBe("installed");

    const snap2 = await sync(adapter, baseUrl, STUB_API_KEY, [], {});
    expect(snap2.entries.find((e) => e.key === "reactivate-me")).toBeUndefined();
    const { body: managedAfterClean } = await directManagedInventory(baseUrl, STUB_API_KEY);
    expect(managedAfterClean.data.some((d: any) => d.name === "reactivate-me")).toBe(false);

    const snap3 = await sync(adapter, baseUrl, STUB_API_KEY, ["reactivate-me"], bundles);
    const entry3 = snap3.entries.find((e) => e.key === "reactivate-me");
    expect(entry3?.state).toBe("installed");

    const { body: managedFinal } = await directManagedInventory(baseUrl, STUB_API_KEY);
    expect(managedFinal.data.find((d: any) => d.name === "reactivate-me")?.contentHash).toBe(
      `sha256:${sha256Hex(content)}`,
    );
  } finally {
    server.close();
  }
});
