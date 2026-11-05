import express from "express";
import request from "supertest";
import { QueryPromise } from "drizzle-orm/query-promise";
import { afterEach, expect, it, vi } from "vitest";
import { withDatabaseOperation } from "@paperclipai/db";
import { installDatabaseWorkSignals } from "@paperclipai/db/work-signals";
import { databaseOperationMiddleware } from "../middleware/database-operation.js";
import { withBudgetSpan } from "../services/budget-tracing.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../services/delivery-work-notifications.js";
import {
  createRunPreparationTiming,
  measureRunPhase,
  withRunExecutionTiming,
  withRunResponsePresentationTiming,
  withRunWorkspaceFinalizationTiming,
} from "../services/execution-preparation-timing.js";

const { owners } = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return { owners: new AsyncLocalStorage<string>() };
});
vi.mock("@paperclipai/db", async importOriginal => ({
  ...await importOriginal<typeof import("@paperclipai/db")>(),
  withDatabaseOperation: <T>(owner: string, action: () => T): T => owners.run(owner, action),
}));

class OwnerQuery extends QueryPromise<string | undefined> {
  async execute() { return owners.getStore(); }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it.each(["", "http://collector.test"])("attributes lazy queries to execution, preparation, and budget owners with endpoint %s", async endpoint => {
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);
  await withDatabaseOperation("http.request", async () => {
    const query = new OwnerQuery();
    await expect(withRunExecutionTiming("private-run", () => query)).resolves.toBe("task.execution_attempt");
    await expect(withRunWorkspaceFinalizationTiming("private-run", () => query)).resolves.toBe("task.workspace_finalization");
    await expect(withRunResponsePresentationTiming("private-run", () => query)).resolves.toBe("task.response_presentation");
    await expect(createRunPreparationTiming("private-run")("agent_read", () => query)).resolves.toBe("heartbeat.prepare.agent_read");
    await expect(createRunPreparationTiming("private-run", "native.controller")("backend_setup", () => query)).resolves.toBe("native.controller.backend_setup");
    await expect(measureRunPhase("skills.inventory", () => query)).resolves.toBe("skills.inventory");
    await expect(withBudgetSpan("budget.accounting.transaction", () => query)).resolves.toBe("budget.accounting.transaction");
    await expect(query).resolves.toBe("http.request");
  });
  expect(owners.getStore()).toBeUndefined();
});

it("keeps owner attribution after the span detail limit and restores nested scopes after failure", async () => {
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
  const failure = new Error("private accounting failure");
  await withRunExecutionTiming("private-run", async () => {
    for (let i = 0; i < 18; i++) {
      await expect(measureRunPhase("skills.inventory", () => new OwnerQuery())).resolves.toBe("skills.inventory");
    }
    await expect(measureRunPhase("execution.budget_reservation", async () => {
      await expect(withBudgetSpan("budget.admission.reserve", async () => {
        await Promise.resolve();
        expect(owners.getStore()).toBe("budget.admission.reserve");
        throw failure;
      })).rejects.toBe(failure);
      return new OwnerQuery();
    })).resolves.toBe("execution.budget_reservation");
    await expect(new OwnerQuery()).resolves.toBe("task.execution_attempt");
  });
  expect(owners.getStore()).toBeUndefined();
});

it("keeps concurrent HTTP requests and nested work in fixed scopes without using private URLs", async () => {
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
  const app = express();
  app.use(databaseOperationMiddleware);
  app.use(express.json());
  let arrived = 0;
  let release!: () => void;
  const both = new Promise<void>(resolve => { release = resolve; });
  app.all("/:privateId", async (req, res) => {
    const before = await new OwnerQuery();
    const work = async () => {
      if (++arrived === 2) release();
      await both;
      return new OwnerQuery();
    };
    const during = req.params.privateId === "first"
      ? await withBudgetSpan("budget.admission.reserve", work)
      : await measureRunPhase("skills.inventory", work);
    res.json({ before, during, after: await new OwnerQuery() });
  });
  const [first, second] = await Promise.all([
    request(app).get("/first?secret=private-first").expect(200),
    request(app).post("/second?secret=private-second").send({ private: "request-body" }).expect(200),
  ]);
  expect(first.body).toEqual({ before: "http.request", during: "budget.admission.reserve", after: "http.request" });
  expect(second.body).toEqual({ before: "http.request", during: "skills.inventory", after: "http.request" });
  expect(owners.getStore()).toBeUndefined();
});

it("replaces producer ownership on each delivery dispatch, including retry and pending checks", async () => {
  vi.useFakeTimers();
  const execute = vi.fn(async () => [{ xid: "42" }]);
  const database = installDatabaseWorkSignals({ execute, async transaction<T>(action: (tx: object) => Promise<T>): Promise<T> {
    return action({ execute });
  } });
  const seen: Array<{ queue: string; phase: string; owner: string | undefined }> = [];
  const coordinator = createDeliveryWorkCoordinator({ owner: database, canRun: () => true,
    onError: (_error, queue) => { seen.push({ queue, phase: "failure", owner: owners.getStore() }); },
  });
  let fail = true;
  try {
    const workers = withDatabaseOperation("http.request", () => [DELIVERY_QUEUES.feedback, DELIVERY_QUEUES.email].map(queue =>
      coordinator.register(queue, { retryMs: 5000,
        run: async () => {
          await Promise.resolve();
          seen.push({ queue, phase: "run", owner: await new OwnerQuery() });
          if (queue === DELIVERY_QUEUES.feedback && fail) { fail = false; throw new Error("retry"); }
        },
        hasPending: async () => {
          seen.push({ queue, phase: "pending", owner: await new OwnerQuery() });
          return false;
        },
      })));
    await Promise.all(workers.map(worker => worker.ready));
    await withDatabaseOperation("budget.accounting.transaction", () => database.transaction(tx =>
      notifyDeliveryWork(tx, DELIVERY_QUEUES.feedback)));
    await vi.advanceTimersByTimeAsync(1);
    expect(seen.map(({ phase }) => phase).sort()).toEqual(["failure", "pending", "pending", "run", "run", "run"]);
    for (const entry of seen) expect(entry.owner).toBe(`delivery.${entry.queue}`);
    expect(owners.getStore()).toBeUndefined();
    expect(coordinator.nextWakeAt()).toBeNull();
  } finally {
    await coordinator.stop();
  }
});
