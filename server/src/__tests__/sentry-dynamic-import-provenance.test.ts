import inspector from "node:inspector";
import { createRequire } from "node:module";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addDynamicImportProvenance, readInspectorState, type ProvenanceEvent } from "../sentry-dynamic-import-provenance.js";

// Sentry is an optional peer. When installed, prove the real SDK passes the
// original rejection to the server's `beforeSend`.
const sentryPackage = (() => {
  try {
    const require = createRequire(import.meta.url);
    return require("@sentry/node") as {
      init(options: Record<string, unknown>): unknown;
      captureException(error: unknown): string;
      flush(timeout?: number): Promise<boolean>;
    };
  } catch {
    return null;
  }
})();

if (process.env.PAPERCLIP_REQUIRE_SENTRY_TEST_SDK === "1" && !sentryPackage) {
  throw new Error("The Sentry SDK contract job requires the audited optional peer");
}

// A developer may debug this file with an inspector already open. Only the
// test that opens its own session may close it.
const inspectorOpenAtStart = inspector.url() !== undefined;

/** The real Node error: code compiled without a filename calls `import()`. */
async function dynamicImportCallbackMissing(): Promise<Error> {
  const run = vm.compileFunction("return import('node:fs')", []) as () => Promise<unknown>;
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the dynamic import to reject");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("@sentry/node");
  vi.doUnmock("../peer-version-check.js");
});

describe("Sentry dynamic import provenance", () => {
  it("adds bounded inspector and process provenance to the real Node error", async () => {
    const error = await dynamicImportCallbackMissing();
    expect((error as NodeJS.ErrnoException).code).toBe("ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING");
    const input: ProvenanceEvent = { tags: { existing: "kept" }, contexts: { runtime: { name: "node" } } };
    const event = await addDynamicImportProvenance(
      input,
      { originalException: error },
      async () => "closed",
    );
    expect(event.tags).toEqual({ existing: "kept", dynamic_import_inspector: "closed" });
    expect(event.contexts?.runtime).toEqual({ name: "node" });
    expect(event.contexts?.dynamic_import_provenance).toEqual({
      inspector: "closed",
      nodeFlags: expect.any(Array),
      mainThread: expect.any(Boolean),
      pid: process.pid,
      ppid: process.ppid,
      uptimeSeconds: expect.any(Number),
    });
  });

  it.skipIf(inspectorOpenAtStart)("reports an open inspector session without sending its secret URL", async () => {
    expect(await readInspectorState()).toBe("closed");
    inspector.open(0, "127.0.0.1");
    try {
      const url = inspector.url();
      expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\//);
      const event = await addDynamicImportProvenance<ProvenanceEvent>({}, { originalException: await dynamicImportCallbackMissing() });
      expect(event).toMatchObject({ tags: { dynamic_import_inspector: "open" }, contexts: { dynamic_import_provenance: { inspector: "open" } } });
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain(url!);
      expect(serialized).not.toContain(url!.split("/").at(-1)!);
    } finally {
      inspector.close();
    }
  });

  it("keeps only allow-listed Node flag names and drops their values", async () => {
    vi.stubEnv("NODE_OPTIONS", "--max-old-space-size=4096 --inspect=0.0.0.0:9229 --require /private/preload.cjs --inspect");
    const event = await addDynamicImportProvenance<ProvenanceEvent>({}, { originalException: await dynamicImportCallbackMissing() }, async () => "open");
    const flags = event.contexts?.dynamic_import_provenance?.nodeFlags;
    expect(flags).toContain("--inspect");
    expect(flags).not.toContain("--max-old-space-size");
    expect(flags).not.toContain("--require");
    expect(JSON.stringify(event)).not.toMatch(/0\.0\.0\.0|9229|private|4096/);
  });

  it("leaves every other event unchanged", async () => {
    const unrelated = { tags: { run_id: "kept" }, contexts: {} };
    const readState = vi.fn(async () => "open" as const);
    const coded = Object.assign(new Error("other"), { code: "ERR_MODULE_NOT_FOUND" });
    for (const hint of [undefined, {}, { originalException: coded }, { originalException: "text" }, { originalException: null }]) {
      expect(await addDynamicImportProvenance(structuredClone(unrelated), hint, readState)).toEqual(unrelated);
    }
    expect(readState).not.toHaveBeenCalled();
  });

  it("returns the original event when the state read fails", async () => {
    const event = { tags: { existing: "kept" } };
    const result = await addDynamicImportProvenance(event, { originalException: await dynamicImportCallbackMissing() }, async () => {
      throw new Error("inspector read failed");
    });
    expect(result).toEqual({ tags: { existing: "kept" } });
  });

  it.skipIf(!sentryPackage || inspectorOpenAtStart)("receives the original rejection through the real SDK beforeSend", async () => {
    const Sentry = sentryPackage!;
    const events: Array<Record<string, unknown>> = [];
    vi.stubEnv("SENTRY_DSN_BACKEND", "https://public@example.invalid/1");
    vi.doMock("../peer-version-check.js", () => ({ checkExactPeerVersions: () => ({ ok: true }) }));
    vi.doMock("@sentry/node", () => ({
      ...Sentry,
      init: (options: Record<string, unknown>) => {
        const beforeSend = options.beforeSend as (event: unknown, hint: unknown) => Promise<Record<string, unknown>>;
        return Sentry.init({
          ...options,
          transport: () => ({ send: async () => ({}), flush: async () => true }),
          beforeSend: async (event: unknown, hint: unknown) => {
            const enriched = await beforeSend(event, hint);
            events.push(enriched);
            return enriched;
          },
        });
      },
    }));
    vi.resetModules();
    const { sentryReady, captureException } = await import("../sentry.js");
    await sentryReady;
    captureException(await dynamicImportCallbackMissing());
    captureException(new Error("unrelated fixture"));
    await Sentry.flush(2000);
    expect(events).toHaveLength(2);
    const enriched = events.filter((event) => (event.tags as Record<string, unknown> | undefined)?.dynamic_import_inspector);
    expect(enriched).toHaveLength(1);
    expect(enriched[0]).toMatchObject({
      tags: { dynamic_import_inspector: "closed" },
      contexts: { dynamic_import_provenance: { inspector: "closed", pid: process.pid } },
    });
  });
});
