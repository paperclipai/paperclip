import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Built-in agent routines dispatch real heartbeat runs. Those runs acquire a
 * sandbox lease, and a plugin-backed sandbox provider can only be resolved when
 * the plugin worker manager reaches the environment runtime.
 *
 * The manager is threaded app.ts -> routes -> service -> routines -> heartbeat.
 * When any hop drops it the runtime resolves the provider with no manager and
 * every run fails setup with "its worker is not running", even though the
 * worker is healthy. These tests pin both hops that are easy to miss.
 */

const pluginWorkerManager = { isRunning: () => true, call: async () => undefined } as any;

describe("built-in agents plugin worker wiring", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("forwards the plugin worker manager from the routes to the service", async () => {
    const builtInAgentService = vi.fn(() => ({}) as any);
    vi.doMock("../services/index.js", () => ({
      accessService: () => ({}),
      instanceSettingsService: () => ({}),
      logActivity: vi.fn(),
    }));
    vi.doMock("../services/built-in-agents.js", () => ({ builtInAgentService }));

    const { builtInAgentRoutes } = await vi.importActual<typeof import("../routes/built-in-agents.js")>(
      "../routes/built-in-agents.js",
    );
    const db = {} as any;
    builtInAgentRoutes(db, { pluginWorkerManager });

    expect(builtInAgentService).toHaveBeenCalledWith(db, expect.objectContaining({ pluginWorkerManager }));
  });

  it("forwards the plugin worker manager from the service to the routine service", async () => {
    const routineService = vi.fn(() => ({}) as any);
    vi.doMock("../services/routines.js", () => ({ routineService }));
    vi.doMock("../services/agent-instructions.js", () => ({ agentInstructionsService: () => ({}) }));
    vi.doMock("../services/agents.js", () => ({ agentService: () => ({}) }));
    vi.doMock("../services/approvals.js", () => ({ approvalService: () => ({}) }));
    vi.doMock("../services/company-skills.js", () => ({ companySkillService: () => ({}) }));
    vi.doMock("../services/access.js", () => ({ accessService: () => ({}) }));

    const { builtInAgentService } = await vi.importActual<typeof import("../services/built-in-agents.js")>(
      "../services/built-in-agents.js",
    );
    const db = {} as any;
    builtInAgentService(db, { pluginWorkerManager });

    expect(routineService).toHaveBeenCalledWith(db, expect.objectContaining({ pluginWorkerManager }));
  });

  it("forwards the plugin worker manager from the company skill routes to the heartbeat service", async () => {
    const heartbeatService = vi.fn(() => ({}) as any);
    vi.doMock("../services/index.js", () => ({
      accessService: () => ({}),
      companySkillService: () => ({}),
      heartbeatService,
      issueService: () => ({}),
      logActivity: vi.fn(),
    }));
    vi.doMock("../services/company-skills.js", () => ({
      isGitRepoSkillImportSource: () => false,
      parseSkillImportSourceInput: () => null,
    }));
    vi.doMock("../services/company-skill-policy.js", () => ({ companySkillPolicyService: () => ({}) }));

    const { companySkillRoutes } = await vi.importActual<typeof import("../routes/company-skills.js")>(
      "../routes/company-skills.js",
    );
    const db = {} as any;
    companySkillRoutes(db, { pluginWorkerManager });

    expect(heartbeatService).toHaveBeenCalledWith(db, expect.objectContaining({ pluginWorkerManager }));
  });

  it("forwards the plugin worker manager from the issue tree control routes to the heartbeat service", async () => {
    const heartbeatService = vi.fn(() => ({}) as any);
    vi.doMock("../services/index.js", () => ({
      heartbeatService,
      issueService: () => ({}),
      issueTreeControlService: () => ({}),
      logActivity: vi.fn(),
    }));

    const { issueTreeControlRoutes } = await vi.importActual<
      typeof import("../routes/issue-tree-control.js")
    >("../routes/issue-tree-control.js");
    const db = {} as any;
    issueTreeControlRoutes(db, { pluginWorkerManager });

    expect(heartbeatService).toHaveBeenCalledWith(db, expect.objectContaining({ pluginWorkerManager }));
  });
});
