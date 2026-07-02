import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sanitizeForPersistence, sanitizeTextForPersistence } from "../persistence-sanitizer.js";
import { REDACTED_EVENT_VALUE } from "../redaction.js";

// Fake canary values only — shaped like credentials, never real ones.
const CANARY = "canary-fake-value-000";
const CANARY_OPENAI_SHAPED = "sk-canaryFAKE000000000000";
const CANARY_GITHUB_SHAPED = "ghp_canaryFAKE00000000000000";
const CANARY_JWT_SHAPED = "eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl";

describe("sanitizeTextForPersistence", () => {
  it("redacts env-style secret assignments in free text", () => {
    const out = sanitizeTextForPersistence(`run with MY_API_TOKEN=${CANARY} please`);
    expect(out).not.toContain(CANARY);
    expect(out).toContain(REDACTED_EVENT_VALUE);
  });

  it("redacts bearer authorization headers in comment-like text", () => {
    const out = sanitizeTextForPersistence(
      `The request failed. I used Authorization: Bearer ${CANARY} as the header.`,
    );
    expect(out).not.toContain(CANARY);
    expect(out).toContain(REDACTED_EVENT_VALUE);
  });

  it("redacts provider-shaped tokens embedded in log chunks", () => {
    const chunk = `stdout: pushing with ${CANARY_GITHUB_SHAPED} and ${CANARY_OPENAI_SHAPED}\n`;
    const out = sanitizeTextForPersistence(chunk);
    expect(out).not.toContain(CANARY_GITHUB_SHAPED);
    expect(out).not.toContain(CANARY_OPENAI_SHAPED);
  });

  it("redacts JWT-shaped values", () => {
    const out = sanitizeTextForPersistence(`session resumed with ${CANARY_JWT_SHAPED}`);
    expect(out).not.toContain(CANARY_JWT_SHAPED);
  });

  it("redacts JSON secret fields inside serialized text", () => {
    const out = sanitizeTextForPersistence(`config was {"apiKey": "${CANARY}"}`);
    expect(out).not.toContain(CANARY);
  });

  it("leaves ordinary prose intact", () => {
    const text = "Deployed version 1.2.3 to production; the keyboard shortcut works now.";
    expect(sanitizeTextForPersistence(text)).toBe(text);
  });

  it("is idempotent", () => {
    const once = sanitizeTextForPersistence(`MY_API_TOKEN=${CANARY}`);
    expect(sanitizeTextForPersistence(once)).toBe(once);
  });
});

describe("sanitizeForPersistence", () => {
  it("redacts secret-named keys in adapter/env/config-like payloads", () => {
    const out = sanitizeForPersistence({
      model: "some-model",
      apiKey: CANARY,
      env: { SERVICE_ACCESS_TOKEN: CANARY, LOG_LEVEL: "debug" },
    });
    expect(out.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect((out.env as Record<string, unknown>).SERVICE_ACCESS_TOKEN).toBe(REDACTED_EVENT_VALUE);
    expect((out.env as Record<string, unknown>).LOG_LEVEL).toBe("debug");
    expect(out.model).toBe("some-model");
  });

  it("preserves secret_ref bindings and redacts plain bindings under secret keys", () => {
    const out = sanitizeForPersistence({
      env: {
        API_TOKEN: { type: "secret_ref", secretId: "secret-id-1" },
        OTHER_TOKEN: { type: "plain", value: CANARY },
      },
    });
    const env = out.env as Record<string, unknown>;
    expect(env.API_TOKEN).toEqual({ type: "secret_ref", secretId: "secret-id-1" });
    expect(env.OTHER_TOKEN).toEqual({ type: "plain", value: REDACTED_EVENT_VALUE });
  });

  it("redacts credential-shaped text nested in objects and arrays", () => {
    const out = sanitizeForPersistence({
      steps: [
        { note: `first step ran EXPORTED_API_TOKEN=${CANARY}` },
        { note: "second step was fine" },
      ],
      summary: [`saw ${CANARY_GITHUB_SHAPED} in output`],
    });
    const steps = out.steps as Array<Record<string, string>>;
    expect(steps[0]!.note).not.toContain(CANARY);
    expect(steps[1]!.note).toBe("second step was fine");
    expect((out.summary as string[])[0]).not.toContain(CANARY_GITHUB_SHAPED);
  });

  it("sanitizes activity/event-like payloads while preserving operational metadata", () => {
    const out = sanitizeForPersistence({
      action: "issue.updated",
      entityId: "issue-1",
      durationMs: 1200,
      ok: true,
      detail: `retried after Authorization: Bearer ${CANARY} was rejected`,
    });
    expect(out.action).toBe("issue.updated");
    expect(out.entityId).toBe("issue-1");
    expect(out.durationMs).toBe(1200);
    expect(out.ok).toBe(true);
    expect(out.detail).not.toContain(CANARY);
  });

  it("handles top-level strings and arrays", () => {
    expect(sanitizeForPersistence(`X_API_TOKEN=${CANARY}`)).not.toContain(CANARY);
    const arr = sanitizeForPersistence([`X_API_TOKEN=${CANARY}`, 7, null]);
    expect(arr[0]).not.toContain(CANARY);
    expect(arr[1]).toBe(7);
    expect(arr[2]).toBeNull();
  });

  it("returns already-safe values unchanged", () => {
    const payload = {
      title: "Weekly report",
      count: 3,
      done: false,
      tags: ["ops", "review"],
      when: null,
    };
    expect(sanitizeForPersistence(payload)).toEqual(payload);
    expect(sanitizeForPersistence(42)).toBe(42);
    expect(sanitizeForPersistence(null)).toBeNull();
    expect(sanitizeForPersistence(undefined)).toBeUndefined();
  });

  it("passes non-JSON values through untouched", () => {
    const date = new Date("2026-01-01T00:00:00.000Z");
    expect(sanitizeForPersistence(date)).toBe(date);
  });
});

describe("run log store pre-persistence sanitization", () => {
  let baseDir: string;
  let store: import("../services/run-log-store.js").RunLogStore;

  beforeAll(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-log-sanitize-"));
    process.env.RUN_LOG_BASE_PATH = baseDir;
    const { getRunLogStore } = await import("../services/run-log-store.js");
    store = getRunLogStore();
  });

  afterAll(async () => {
    delete process.env.RUN_LOG_BASE_PATH;
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("sanitizes credential-shaped chunks before they reach disk", async () => {
    const handle = await store.begin({ companyId: "co-1", agentId: "agent-1", runId: "run-1" });
    await store.append(handle, {
      stream: "stdout",
      chunk: `exporting MY_API_TOKEN=${CANARY} then ${CANARY_GITHUB_SHAPED}\n`,
      ts: "2026-01-01T00:00:00.000Z",
    });

    const raw = await fs.readFile(path.join(baseDir, handle.logRef), "utf8");
    expect(raw).not.toContain(CANARY);
    expect(raw).not.toContain(CANARY_GITHUB_SHAPED);
    expect(raw).toContain(REDACTED_EVENT_VALUE);

    const readBack = await store.read(handle);
    expect(readBack.content).not.toContain(CANARY);
  });

  it("keeps safe chunks byte-identical", async () => {
    const handle = await store.begin({ companyId: "co-1", agentId: "agent-1", runId: "run-2" });
    const chunk = "compiled 14 files in 3.1s\n";
    await store.append(handle, { stream: "stdout", chunk, ts: "2026-01-01T00:00:01.000Z" });

    const readBack = await store.read(handle);
    expect(JSON.parse(readBack.content.trim()).chunk).toBe(chunk);
  });
});
