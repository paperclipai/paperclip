import { afterEach, describe, expect, it, vi } from "vitest";
import { addDynamicImportDiagnostics, addSentryRunLinks, setSentryRunLinkResolver } from "../sentry-links.js";

const runId = "22222222-2222-4222-8222-222222222222";
const companyId = "55555555-5555-4555-8555-555555555555";
const agentId = "66666666-6666-4666-8666-666666666666";
const taskId = "11111111-1111-4111-8111-111111111111";
const identity = { companyId, companyPrefix: "TEAM", agentId, taskId, taskIdentifier: "TEAM-42" };

afterEach(() => {
  setSentryRunLinkResolver(null);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("Sentry navigation links", () => {
  it("adds normal UI URLs to run failures and Stop errors without changing API references or unrelated events", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "https://paperclip.example.com");
    const resolve = vi.fn(async () => identity);
    setSentryRunLinkResolver(resolve);
    const event = { tags: { run_id: runId, company_id: companyId }, contexts: { paperclip: { runUrl: "/api/original" } }, fingerprint: ["failure"] };
    const linked = await addSentryRunLinks(event);
    const runUrl = `https://paperclip.example.com/TEAM/agents/${agentId}/runs/${runId}`;
    expect(linked).toMatchObject({ tags: { task_url: "https://paperclip.example.com/TEAM/issues/TEAM-42", run_url: runUrl, task_identifier: "TEAM-42" },
      contexts: { paperclip: { runUrl: "/api/original", runPageUrl: runUrl, taskUrl: "https://paperclip.example.com/TEAM/issues/TEAM-42" } }, fingerprint: ["failure"] });
    expect(resolve).toHaveBeenCalledWith({ runId, companyId });
    expect(await addSentryRunLinks({ contexts: { adapter_stop: { runId } } })).toMatchObject({ tags: { run_url: runUrl } });
    const unrelated = { tags: { error_code: "unrelated" } };
    expect(await addSentryRunLinks(unrelated)).toEqual(unrelated);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("falls back to the task UUID and omits task links for taskless runs", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "http://localhost:3100");
    setSentryRunLinkResolver(async () => ({ ...identity, taskIdentifier: null }));
    expect(await addSentryRunLinks({ tags: { run_id: runId } })).toMatchObject({ tags: { task_url: `http://localhost:3100/TEAM/issues/${taskId}` } });
    setSentryRunLinkResolver(async () => ({ ...identity, taskId: null, taskIdentifier: null }));
    const result = await addSentryRunLinks({ tags: { run_id: runId } });
    expect(result.tags).toHaveProperty("run_url");
    expect(result.tags).not.toHaveProperty("task_url");
    expect(result.tags).not.toHaveProperty("task_identifier");
  });

  it.each([17, 210])("keeps navigation for a saved %i-character company prefix within tag limits", async length => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "https://paperclip.example.com");
    const companyPrefix = "A".repeat(length);
    const taskIdentifier = `${companyPrefix}-42`;
    setSentryRunLinkResolver(async () => ({ ...identity, companyPrefix, taskIdentifier }));
    const linked = await addSentryRunLinks({ tags: { run_id: runId } });
    const taskUrl = `https://paperclip.example.com/${companyPrefix}/issues/${taskIdentifier}`;
    expect(linked).toHaveProperty("contexts.paperclip.taskUrl", taskUrl);
    expect(linked).toHaveProperty("contexts.paperclip.runPageUrl");
    if (length === 17) {
      expect(linked.tags).toHaveProperty("task_identifier", taskIdentifier);
      expect(linked.tags).toHaveProperty("task_url", taskUrl);
    } else {
      expect(linked.tags).not.toHaveProperty("task_identifier");
      expect(linked.tags).not.toHaveProperty("task_url");
      expect(linked.tags).not.toHaveProperty("run_url");
    }
  });

  it.each(["https://user:secret@example.com", "https://example.com?secret=token", "https://example.com/#private", "https://example.com/private", "ftp://example.com", "invalid", ""])("omits unsafe instance origins without a database lookup: %s", async origin => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", origin);
    const resolve = vi.fn(async () => identity);
    setSentryRunLinkResolver(resolve);
    const event = { tags: { run_id: runId } };
    expect(await addSentryRunLinks(event)).toEqual(event);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not widen a malformed company identity or put long URLs in tags", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", `https://${"a".repeat(60)}.${"b".repeat(60)}.example.com`);
    const resolve = vi.fn(async () => identity);
    setSentryRunLinkResolver(resolve);
    await addSentryRunLinks({ tags: { run_id: runId, company_id: "private-invalid" } });
    expect(resolve).not.toHaveBeenCalled();
    const linked = await addSentryRunLinks({ tags: { run_id: runId } });
    expect(linked.tags).not.toHaveProperty("run_url");
    expect(linked).toHaveProperty("contexts.paperclip.runPageUrl");
  });

  it("preserves the error on lookup rejection and bounds a stalled lookup", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "https://paperclip.example.com");
    const event = { tags: { run_id: runId } };
    setSentryRunLinkResolver(async () => { throw new Error("database unavailable"); });
    expect(await addSentryRunLinks(event)).toEqual(event);
    vi.useFakeTimers();
    let finish!: (value: typeof identity) => void;
    setSentryRunLinkResolver(() => new Promise(resolve => { finish = resolve; }));
    const pending = addSentryRunLinks(event);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toEqual(event);
    finish(identity);
    await Promise.resolve();
    expect(event.tags).not.toHaveProperty("task_url");
  });

  it("tags missing dynamic import callback crashes with origin diagnostics and keeps other events unchanged", async () => {
    const error = Object.assign(new TypeError("A dynamic import callback was not specified."), {
      code: "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING",
      stack: "TypeError: A dynamic import callback was not specified.\n    at importModuleDynamicallyCallback (node:internal/modules/esm/utils:280:9)\n    at Timeout._onTimeout (<anonymous>:1:41)",
    });
    const event: { tags?: Record<string, unknown>; contexts?: Record<string, Record<string, unknown>> } = { tags: { existing: "kept" } };
    const enriched = await addSentryRunLinks(event as never, { originalException: error });
    expect(enriched).toMatchObject({
      tags: { existing: "kept", error_code: "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING", inspector_active: false },
      contexts: { dynamic_import: { inspectorActive: false, anonymousFrames: ["at Timeout._onTimeout (<anonymous>:1:41)"] } },
    });
    expect(addDynamicImportDiagnostics({ tags: { a: "b" } }, { originalException: new Error("other") })).toEqual({ tags: { a: "b" } });
    expect(addDynamicImportDiagnostics({ tags: { a: "b" } })).toEqual({ tags: { a: "b" } });
  });

  it("limits abandoned database lookups while continuing to send subsequent errors", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "https://paperclip.example.com");
    vi.useFakeTimers();
    const releases: Array<(value: typeof identity) => void> = [];
    const resolve = vi.fn(() => new Promise<typeof identity>(done => releases.push(done)));
    setSentryRunLinkResolver(resolve);
    const pending = Array.from({ length: 8 }, () => addSentryRunLinks({ tags: { run_id: runId } }));
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all(pending);
    const ninth = { tags: { run_id: runId } };
    expect(await addSentryRunLinks(ninth)).toEqual(ninth);
    expect(resolve).toHaveBeenCalledTimes(8);
    releases.forEach(release => release(identity));
    await Promise.resolve();
  });
});
