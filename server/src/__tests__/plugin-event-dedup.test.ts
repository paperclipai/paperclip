import { describe, expect, it, vi } from "vitest";
import { buildHostServices } from "../services/plugin-host-services.js";

const warn = vi.fn();
vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: (...args: unknown[]) => warn(...args),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
  },
}));

/**
 * Fake event bus that records every handler registered through
 * `forPlugin().subscribe()`. Tests drive delivery by invoking the captured
 * handlers directly, simulating the real bus fanning a single domain event out
 * to every matching subscription for the plugin.
 */
function createEventBus(handlers: Array<(event: unknown) => Promise<void>>) {
  return {
    forPlugin() {
      return {
        emit: vi.fn(),
        clear: vi.fn(),
        subscribe: (_pattern: unknown, filterOrHandler: unknown, maybeHandler?: unknown) => {
          const handler = (typeof maybeHandler === "function" ? maybeHandler : filterOrHandler) as (
            event: unknown,
          ) => Promise<void>;
          handlers.push(handler);
        },
      };
    },
  } as never;
}

function makeEvent(eventId: string | undefined) {
  return {
    eventId,
    eventType: "issue.created",
    occurredAt: "2026-06-19T00:00:00.000Z",
    companyId: "company-1",
    payload: {},
  };
}

describe("plugin event delivery deduplication", () => {
  it("notifies the worker once when overlapping subscriptions match the same event", async () => {
    const handlers: Array<(event: unknown) => Promise<void>> = [];
    const notifyWorker = vi.fn();
    const services = buildHostServices(
      {} as never,
      "plugin-record-id",
      "acme.slack",
      createEventBus(handlers),
      notifyWorker,
    );

    // A plugin that registers two ctx.events.on("issue.created", ...) handlers.
    await services.events.subscribe({ eventPattern: "issue.created" });
    await services.events.subscribe({ eventPattern: "issue.created" });
    expect(handlers).toHaveLength(2);

    // The bus fans one event out to both subscriptions.
    const event = makeEvent("evt-1");
    for (const handler of handlers) await handler(event);

    expect(notifyWorker).toHaveBeenCalledTimes(1);
    expect(notifyWorker).toHaveBeenCalledWith("onEvent", { event });

    services.dispose();
  });

  it("notifies the worker once per distinct eventId", async () => {
    const handlers: Array<(event: unknown) => Promise<void>> = [];
    const notifyWorker = vi.fn();
    const services = buildHostServices(
      {} as never,
      "plugin-record-id",
      "acme.slack",
      createEventBus(handlers),
      notifyWorker,
    );

    await services.events.subscribe({ eventPattern: "issue.created" });
    await services.events.subscribe({ eventPattern: "issue.created" });

    for (const handler of handlers) await handler(makeEvent("evt-1"));
    for (const handler of handlers) await handler(makeEvent("evt-2"));

    expect(notifyWorker).toHaveBeenCalledTimes(2);

    services.dispose();
  });

  it("does not deduplicate events that carry no eventId, and warns once", async () => {
    warn.mockClear();
    const handlers: Array<(event: unknown) => Promise<void>> = [];
    const notifyWorker = vi.fn();
    const services = buildHostServices(
      {} as never,
      "plugin-record-id",
      "acme.slack",
      createEventBus(handlers),
      notifyWorker,
    );

    await services.events.subscribe({ eventPattern: "issue.created" });
    await services.events.subscribe({ eventPattern: "issue.created" });

    // Two deliveries of an eventId-less event cannot be collapsed.
    for (const handler of handlers) await handler(makeEvent(undefined));

    expect(notifyWorker).toHaveBeenCalledTimes(2);
    // The gap is surfaced exactly once, not on every delivery.
    expect(warn).toHaveBeenCalledTimes(1);

    services.dispose();
  });
});
