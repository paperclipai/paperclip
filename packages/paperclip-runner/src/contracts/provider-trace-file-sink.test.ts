import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createProviderTraceFileSink } from "./provider-trace-file-sink.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ProviderTraceFileSink", () => {
  it("hardens an existing file before it appends provider frames", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-provider-trace-mode-"));
    roots.push(root);
    const tracePath = join(root, "provider.ndjson");
    await writeFile(tracePath, "", { mode: 0o644 });
    await chmod(tracePath, 0o644);

    const sink = await createProviderTraceFileSink({
      path: tracePath,
      provider: "opencode",
      channel: "test",
    });

    expect(statMode(await stat(tracePath))).toBe(0o600);
    await sink?.finish();
  });

  it("redacts registered credentials before raw frames reach disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-provider-trace-secret-"));
    roots.push(root);
    const tracePath = join(root, "provider.ndjson");
    const sink = await createProviderTraceFileSink({
      path: tracePath,
      provider: "opencode",
      channel: "test",
    });
    sink?.addSensitiveValues(["provider-secret", "bridge-secret"]);
    sink?.frame({
      direction: "provider_stderr",
      raw: "credential=provider-secret authorization=bridge-secret",
      transport: "process_stderr",
    });
    await sink?.finish();

    const trace = await readFile(tracePath, "utf8");
    expect(trace).not.toContain("provider-secret");
    expect(trace).not.toContain("bridge-secret");
    const frame = JSON.parse(trace.trim().split("\n")[0]!) as Record<string, unknown>;
    expect(Buffer.from(String(frame.rawBase64), "base64").toString("utf8"))
      .toBe("credential=[REDACTED] authorization=[REDACTED]");
  });
});

function statMode(value: Awaited<ReturnType<typeof stat>>): number {
  return value.mode & 0o777;
}
