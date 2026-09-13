import { expect, it } from "vitest";
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
