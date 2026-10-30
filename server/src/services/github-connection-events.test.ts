import { describe, expect, it, vi } from "vitest";
import { chatEndpoints, type Db } from "@paperclipai/db";
import { githubConnectionEventService } from "./github-connection-events.js";
import type { PaperclipCloudConnector } from "./paperclip-cloud-connector.js";

function fixture() {
  let time = Date.parse("2026-09-04T12:00:00Z");
  const bindings = [{
    grant: { id: "grant", companyId: "company", kind: "user", subjectUserId: "owner", status: "active",
      providerTenant: { github: { installationIds: ["101"] } } },
    connection: { id: "connection", config: { sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } } },
  }];
  const bots: Array<{ companyId: string }> = [];
  // Only SQL is stubbed. Backoff, lease admission and concurrent execution use
  // the real service; relational persistence has its own Postgres suite.
  const select = vi.fn(() => ({ from: (table: unknown) => table === chatEndpoints
    ? { where: async () => bots }
    : { innerJoin: () => ({ where: async () => bindings }) } }));
  const leaseEvents = vi.fn<PaperclipCloudConnector["leaseEvents"]>().mockResolvedValue(null);
  const connector = { leaseEvents } as unknown as PaperclipCloudConnector;
  const service = githubConnectionEventService({ select } as unknown as Db, { connector, now: () => new Date(time) });
  return { service, leaseEvents, select, bots, advance: (ms: number) => { time += ms; } };
}

describe("GitHub event polling during active App setup", () => {
  it("reaches Cloud during an old empty-queue backoff without expanding idle polling", async () => {
    const f = fixture();
    for (const delay of [0, 10_000, 20_000, 40_000, 80_000]) {
      f.advance(delay);
      await f.service.pollOnce();
    }
    expect(f.leaseEvents).toHaveBeenCalledTimes(5);
    const queries = f.select.mock.calls.length;
    f.bots.push({ companyId: "company" });
    f.advance(5_000);
    for (let index = 0; index < 3; index++) await f.service.pollOnce();
    expect(f.select).toHaveBeenCalledTimes(queries);
    expect(f.leaseEvents).toHaveBeenCalledTimes(5);
    await f.service.pollOnce({ forSetup: true });
    expect(f.leaseEvents).toHaveBeenCalledTimes(6);
    const setupQueries = f.select.mock.calls.length;
    await f.service.pollOnce({ forSetup: true });
    expect(f.leaseEvents).toHaveBeenCalledTimes(6);
    expect(f.select).toHaveBeenCalledTimes(setupQueries);
    f.advance(5_000);
    await f.service.pollOnce({ forSetup: true });
    expect(f.leaseEvents).toHaveBeenCalledTimes(7);
  });

  it("shares one lease between setup and scheduled callers while Cloud is slow", async () => {
    const f = fixture();
    let complete!: (value: null) => void;
    f.leaseEvents.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const scheduled = f.service.pollOnce();
    const setup = f.service.pollOnce({ forSetup: true });
    await vi.waitFor(() => expect(f.leaseEvents).toHaveBeenCalledTimes(1));
    expect(complete).toBeTypeOf("function");
    complete(null);
    await Promise.all([scheduled, setup]);
    expect(f.leaseEvents).toHaveBeenCalledTimes(1);
  });

  it("releases the shared attempt after an error and retries only after the setup throttle", async () => {
    const f = fixture();
    f.leaseEvents.mockRejectedValueOnce(new Error("Cloud unavailable"));
    await expect(f.service.pollOnce({ forSetup: true })).rejects.toThrow("Cloud unavailable");
    await f.service.pollOnce({ forSetup: true });
    await f.service.pollOnce();
    expect(f.leaseEvents).toHaveBeenCalledTimes(1);
    f.advance(5_000);
    await f.service.pollOnce({ forSetup: true });
    expect(f.leaseEvents).toHaveBeenCalledTimes(2);
  });
});
