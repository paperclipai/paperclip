import { expect, it, vi } from "vitest";
import { waitForRequest } from "./request-pacer.js";

it("spaces concurrent requests to one endpoint across clients", async () => {
  const started: number[] = [];
  const requests = [1, 2, 3].map(() => waitForRequest("https://pacing.test", new AbortController().signal)
    .then(() => started.push(Date.now())));
  await Promise.all(requests);
  expect(started).toHaveLength(3);
  expect(started[1] - started[0]).toBeGreaterThanOrEqual(280);
  expect(started[2] - started[1]).toBeGreaterThanOrEqual(280);
});

it("an aborted queued request does not block cleanup", async () => {
  await waitForRequest("https://cancel.test", new AbortController().signal);
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await expect(waitForRequest("https://cancel.test", controller.signal)).rejects.toThrow("cancelled");
  const cleanup = waitForRequest("https://cancel.test", new AbortController().signal);
  await cleanup;
});

it("cancels promptly behind other queued requests without disturbing their spacing", async () => {
  await waitForRequest("https://queued-cancel.test", new AbortController().signal);
  const earlierDone = vi.fn();
  const earlier = waitForRequest("https://queued-cancel.test", new AbortController().signal).then(earlierDone);
  const controller = new AbortController();
  const queued = waitForRequest("https://queued-cancel.test", controller.signal);
  const rejected = expect(queued).rejects.toThrow("cancelled");
  controller.abort(new Error("cancelled"));
  try {
    await rejected;
    expect(earlierDone).not.toHaveBeenCalled();
  } finally {
    await earlier;
  }
  await waitForRequest("https://queued-cancel.test", new AbortController().signal);
});
