import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import type { RunnerApi } from "./api.js";

export interface HistoryDownloadEvidence {
  runId: string;
  bodyId: string;
  byteLength: number;
  sha256: string;
  browserDownload: true;
  stream?: { byteLength: number; sha256: string; executionId: string };
}

/** The oracle compares bytes from a user-visible download with the exact
 * requested shell output. A preview or successful HTTP response is insufficient. */
export async function downloadIndexedHistory(input: {
  page: Page;
  api: RunnerApi;
  issuePrefix: string;
  run: { id: string; agentId: string };
  expected: string;
  requireCommandStream?: boolean;
}): Promise<HistoryDownloadEvidence> {
  const bodyId = createHash("sha256").update(input.expected).digest("hex");
  let after = 0, found = false;
  let streamBytes = 0, streamExecutionId = "", completedExecutionId = "";
  const streamHash = createHash("sha256");
  // This short live fixture has a finite event budget. Production history is
  // paged; the qualification never requests a whole transcript in one response.
  for (let page = 0; page < 32 && (!found || input.requireCommandStream); page++) {
    const events = await input.api.get<Array<{ seq: number; payload?: { prpEvent?: { eventType?: string; itemId?: string; payload?: Record<string, any> } } }>>(
      `/api/heartbeat-runs/${input.run.id}/events?afterSeq=${after}&limit=200`,
    );
    for (const row of events) {
      const event = row.payload?.prpEvent, payload = event?.payload;
      if (payload?.outputBody?.bodyId === bodyId) {
        found = true;
        if (event?.eventType === "tool.execution.completed") completedExecutionId = payload.executionId;
      }
      if (!input.requireCommandStream || event?.eventType !== "item.delta" || payload?.kind !== "commandExecution") continue;
      expect(event.itemId, "command output must retain one execution binding").toBeTruthy();
      if (streamExecutionId) expect(event.itemId).toBe(streamExecutionId);
      streamExecutionId = event.itemId!;
      let text = payload.text;
      if (payload.outputBody) {
        const response = await input.api.request.get(`/api/heartbeat-runs/${input.run.id}/output-bodies/${payload.outputBody.bodyId}`);
        expect(response.ok()).toBe(true);
        text = await response.text();
        expect(createHash("sha256").update(text).digest("hex")).toBe(payload.outputBody.sha256);
      }
      expect(typeof text).toBe("string");
      streamBytes += Buffer.byteLength(text);
      expect(streamBytes).toBeLessThanOrEqual(Buffer.byteLength(input.expected));
      streamHash.update(text);
    }
    if (!events.length) break;
    expect(events.at(-1)!.seq).toBeGreaterThan(after);
    after = events.at(-1)!.seq;
  }
  expect(found, "the real provider output must have the exact expected durable body reference").toBe(true);
  const stream = input.requireCommandStream ? { byteLength: streamBytes, sha256: streamHash.digest("hex"), executionId: streamExecutionId } : undefined;
  if (stream) {
    expect(stream.byteLength, "all streamed command bytes must survive independently of the completion snapshot").toBe(Buffer.byteLength(input.expected));
    expect(stream.sha256).toBe(bodyId);
    expect(stream.executionId).toBe(completedExecutionId);
  }
  await input.page.goto(`/${input.issuePrefix}/agents/${input.run.agentId}/runs/${input.run.id}`, { waitUntil: "domcontentloaded" });
  const href = `/api/heartbeat-runs/${input.run.id}/output-bodies/${bodyId}`;
  const link = input.page.getByRole("link", { name: "Download full output", exact: true }).and(input.page.locator(`a[href="${href}"]`)).first();
  await expect(link).toBeVisible();
  const [download] = await Promise.all([input.page.waitForEvent("download"), link.click()]);
  expect(await download.failure()).toBeNull();
  const file = await download.path();
  expect(file).toBeTruthy();
  const bytes = await readFile(file!);
  expect(bytes.equals(Buffer.from(input.expected)), "full output must survive restart without truncation or duplication").toBe(true);
  return { runId: input.run.id, bodyId, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), browserDownload: true, ...(stream ? { stream } : {}) };
}
