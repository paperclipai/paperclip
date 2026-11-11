import { expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { sendChatMessage } from "../chat-flow.js";
import { openStandingChat } from "./identity-support.js";
import { prepareRuntimeWorkerGate, readRuntimeTaskGate, taskBoundRuntimeGate } from "./runtime-busy-worker.js";
import { runtimePostStopCases } from "./runtime-post-stop.js";

vi.mock("../chat-flow.js", async original => ({ ...await original<typeof import("../chat-flow.js")>(), sendChatMessage: vi.fn() }));
vi.mock("./identity-support.js", async original => ({ ...await original<typeof import("./identity-support.js")>(), openStandingChat: vi.fn() }));
vi.mock("./runtime-busy-worker.js", async original => ({ ...await original<typeof import("./runtime-busy-worker.js")>(),
  prepareRuntimeWorkerGate: vi.fn(), readRuntimeTaskGate: vi.fn() }));

it("waits for the task-bound listener on the genuine source and lead before preparing Stop", async () => {
  const lead = { id: "source-agent", companyId: "company", lifecycleState: "ready" };
  const source = { id: "canonical-source" };
  const gate = taskBoundRuntimeGate("same-source-post-stop");
  const close = vi.fn(async () => {});
  const secondary = { close };
  vi.mocked(openStandingChat).mockResolvedValue(source as Awaited<ReturnType<typeof openStandingChat>>);
  vi.mocked(prepareRuntimeWorkerGate).mockResolvedValue({ worker: lead, gate, previousRuns: [], company: "/api/companies/company" });
  vi.mocked(readRuntimeTaskGate).mockResolvedValue("waiting");
  vi.mocked(sendChatMessage).mockResolvedValue(undefined);
  const ctx = { input: { fixtures: { company: { id: "company" }, agent: lead }, page: { context: () => ({ newPage: async () => secondary }) },
    api: { get: async (route: string) => {
      if (route === "/api/agents/source-agent") return lead;
      if (route === "/api/heartbeat-runs/original-native") throw new Error("independent run identity read reached");
      throw new Error("Unexpected fixture read");
    } } }, allRuns: async () => [{ id: "original-native", agentId: lead.id, status: "running" }] } as unknown as ChatCatalogContext;
  await expect(runtimePostStopCases[0]!.setup(ctx)).rejects.toThrow("independent run identity read reached");
  expect(prepareRuntimeWorkerGate).toHaveBeenCalledWith(ctx, { worker: lead, taskBound: true });
  expect(readRuntimeTaskGate).toHaveBeenCalledWith(ctx, gate, source.id, lead.id);
  expect(sendChatMessage).toHaveBeenCalledOnce();
  const firstHumanRequest = vi.mocked(sendChatMessage).mock.calls[0]![1];
  expect(firstHumanRequest).toContain(`First run the bounded command ${gate.command} once`);
  expect(firstHumanRequest).not.toContain("wait-for-brief-runtime-");
  expect(close).toHaveBeenCalledOnce();
});
