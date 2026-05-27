import { describe, expect, it, vi } from "vitest";
import { createBrabrixAgentSyncService } from "../services/brabrix-agent-sync.js";
import type { BrabrixConfig } from "../integrations/brabrix/brabrix-config.js";
import type {
  AgentRun,
  BrabrixTask,
  ProjectContext,
} from "../integrations/brabrix/brabrix-types.js";

function baseConfig(overrides: Partial<BrabrixConfig> = {}): BrabrixConfig {
  return {
    apiUrl: "https://api.brabrix.dev",
    agentToken: "token-123",
    projectId: "project-1",
    agentId: "agent-7",
    provider: "brabrix-dev",
    endpoints: {
      projectContext: "/v1/projects/{projectId}/context",
      nextTask: "/v1/projects/{projectId}/tasks/next",
      sendRunLogs: "/v1/projects/{projectId}/runs/{runId}/logs",
      completeTask: "/v1/projects/{projectId}/tasks/{taskId}/complete",
    },
    timeoutMs: 10_000,
    maxRetries: 2,
    retryDelayMs: 100,
    ...overrides,
  };
}

function createClientMock() {
  return {
    getProjectContext: vi.fn<() => Promise<ProjectContext | null>>(async () => null),
    getNextTask: vi.fn<() => Promise<BrabrixTask | null>>(async () => null),
    sendRunLogs: vi.fn<(input: unknown) => Promise<void>>(async (input) => {
      void input;
    }),
    completeTask: vi.fn<(input: unknown) => Promise<void>>(async (input) => {
      void input;
    }),
  };
}

describe("createBrabrixAgentSyncService", () => {
  it("stays disabled and performs no-op sync when config is incomplete", async () => {
    const client = createClientMock();
    const service = createBrabrixAgentSyncService({
      config: baseConfig({ agentToken: null }),
      client,
    });

    expect(service.isEnabled()).toBe(false);
    await expect(service.fetchNextTask()).resolves.toEqual({
      projectContext: null,
      task: null,
      goal: null,
      context: null,
    });
    await expect(service.sendRunLogs({
      taskId: "task-1",
      runId: "run-1",
      logs: [{ timestamp: new Date().toISOString(), level: "info", message: "noop" }],
    })).resolves.toBeUndefined();
    await expect(service.syncStatus({
      taskId: "task-1",
      runId: "run-1",
      status: "completed",
    })).resolves.toBeUndefined();
    await expect(service.updateExecution({
      taskId: "task-1",
      run: {
        runId: "run-1",
        agentId: "agent-7",
        provider: "brabrix-dev",
        status: "completed",
      },
      summary: "done",
    })).resolves.toBeUndefined();

    expect(client.getProjectContext).not.toHaveBeenCalled();
    expect(client.getNextTask).not.toHaveBeenCalled();
    expect(client.sendRunLogs).not.toHaveBeenCalled();
    expect(client.completeTask).not.toHaveBeenCalled();
  });

  it("fetches project context and next task when enabled", async () => {
    const projectContext: ProjectContext = {
      projectId: "project-1",
      name: "Brabrix Agent",
      description: "Projeto de execução de tasks",
      skills: [{ skillKey: "coding.fullstack", name: "Fullstack Coding" }],
      providers: ["brabrix-dev"],
      defaultProvider: "brabrix-dev",
    };
    const task: BrabrixTask = {
      taskId: "task-99",
      title: "Implementar integração HTTP",
      priority: "high",
    };

    const client = createClientMock();
    client.getProjectContext.mockResolvedValue(projectContext);
    client.getNextTask.mockResolvedValue(task);

    const service = createBrabrixAgentSyncService({
      config: baseConfig(),
      client,
    });

    const result = await service.fetchNextTask();
    expect(service.isEnabled()).toBe(true);
    expect(result.projectContext).toEqual(projectContext);
    expect(result.task).toEqual(task);
    expect(result.goal).toMatchObject({
      source: "brabrix",
      sourceTaskId: "task-99",
      title: "Implementar integração HTTP",
      level: "task",
      status: "planned",
      agentProfile: "backend",
    });
    expect(result.context).toMatchObject({
      profile: {
        key: "backend",
      },
      skillsApplied: ["coding.fullstack"],
    });
    expect(client.getProjectContext).toHaveBeenCalledTimes(1);
    expect(client.getNextTask).toHaveBeenCalledTimes(1);
  });

  it("forwards explicit run logs and status sync operations", async () => {
    const client = createClientMock();
    const service = createBrabrixAgentSyncService({
      config: baseConfig(),
      client,
    });

    await service.sendRunLogs({
      taskId: "task-2",
      runId: "run-2",
      logs: [{ timestamp: new Date().toISOString(), level: "warn", message: "checkpoint" }],
    });
    await service.syncStatus({
      taskId: "task-2",
      runId: "run-2",
      status: "completed",
      summary: "finalizado",
    });

    expect(client.sendRunLogs).toHaveBeenCalledWith({
      taskId: "task-2",
      runId: "run-2",
      logs: [expect.objectContaining({ level: "warn", message: "checkpoint" })],
    });
    expect(client.completeTask).toHaveBeenCalledWith({
      taskId: "task-2",
      runId: "run-2",
      status: "completed",
      summary: "finalizado",
    });
  });

  it("updates execution for non-terminal runs by sending logs only", async () => {
    const run: AgentRun = {
      runId: "run-42",
      agentId: "agent-7",
      provider: "brabrix-dev",
      status: "running",
    };
    const client = createClientMock();
    const service = createBrabrixAgentSyncService({
      config: baseConfig(),
      client,
    });

    await service.updateExecution({
      taskId: "task-42",
      run,
      logs: [{ timestamp: new Date().toISOString(), level: "info", message: "still running" }],
      summary: "parcial",
    });

    expect(client.sendRunLogs).toHaveBeenCalledWith({
      taskId: "task-42",
      runId: "run-42",
      agentRun: run,
      logs: [expect.objectContaining({ level: "info", message: "still running" })],
    });
    expect(client.completeTask).not.toHaveBeenCalled();
  });

  it("updates execution for terminal runs by mapping run status into task completion status", async () => {
    const run: AgentRun = {
      runId: "run-77",
      agentId: "agent-7",
      provider: "brabrix-dev",
      status: "failed",
    };
    const client = createClientMock();
    const service = createBrabrixAgentSyncService({
      config: baseConfig(),
      client,
    });

    await service.updateExecution({
      taskId: "task-77",
      run,
      summary: "erro de timeout",
      output: { code: "TIMEOUT" },
    });

    expect(client.sendRunLogs).not.toHaveBeenCalled();
    expect(client.completeTask).toHaveBeenCalledWith({
      taskId: "task-77",
      runId: "run-77",
      agentRun: run,
      status: "failed",
      summary: "erro de timeout",
      output: { code: "TIMEOUT" },
    });
  });
});
