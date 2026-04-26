import { describe, it, expect, vi } from "vitest";
import {
  trackInstallStarted,
  trackInstallCompleted,
  trackCompanyImported,
  trackProjectCreated,
  trackRoutineCreated,
  trackRoutineRun,
  trackGoalCreated,
  trackAgentCreated,
  trackSkillImported,
  trackAgentFirstHeartbeat,
  trackAgentTaskCompleted,
  trackErrorHandlerCrash,
} from "./events.js";
import type { TelemetryClient } from "./client.js";

function makeClient(): TelemetryClient {
  return {
    track: vi.fn(),
    hashPrivateRef: vi.fn((v: string) => `hashed:${v}`),
  } as unknown as TelemetryClient;
}

describe("trackInstallStarted", () => {
  it("calls track with install.started", () => {
    const client = makeClient();
    trackInstallStarted(client);
    expect(client.track).toHaveBeenCalledWith("install.started");
    expect(client.track).toHaveBeenCalledTimes(1);
  });
});

describe("trackInstallCompleted", () => {
  it("calls track with adapter_type dimension", () => {
    const client = makeClient();
    trackInstallCompleted(client, { adapterType: "codex" });
    expect(client.track).toHaveBeenCalledWith("install.completed", { adapter_type: "codex" });
  });
});

describe("trackCompanyImported", () => {
  it("uses plain ref when isPrivate is false", () => {
    const client = makeClient();
    trackCompanyImported(client, { sourceType: "zip", sourceRef: "myref", isPrivate: false });
    expect(client.hashPrivateRef).not.toHaveBeenCalled();
    expect(client.track).toHaveBeenCalledWith("company.imported", {
      source_type: "zip",
      source_ref: "myref",
      source_ref_hashed: false,
    });
  });

  it("hashes ref when isPrivate is true", () => {
    const client = makeClient();
    trackCompanyImported(client, { sourceType: "git", sourceRef: "secret-ref", isPrivate: true });
    expect(client.hashPrivateRef).toHaveBeenCalledWith("secret-ref");
    expect(client.track).toHaveBeenCalledWith("company.imported", {
      source_type: "git",
      source_ref: "hashed:secret-ref",
      source_ref_hashed: true,
    });
  });
});

describe("trackProjectCreated", () => {
  it("calls track with project.created", () => {
    const client = makeClient();
    trackProjectCreated(client);
    expect(client.track).toHaveBeenCalledWith("project.created");
  });
});

describe("trackRoutineCreated", () => {
  it("calls track with routine.created", () => {
    const client = makeClient();
    trackRoutineCreated(client);
    expect(client.track).toHaveBeenCalledWith("routine.created");
  });
});

describe("trackRoutineRun", () => {
  it("calls track with source and status dimensions", () => {
    const client = makeClient();
    trackRoutineRun(client, { source: "schedule", status: "success" });
    expect(client.track).toHaveBeenCalledWith("routine.run", {
      source: "schedule",
      status: "success",
    });
  });
});

describe("trackGoalCreated", () => {
  it("omits goal_level dimension when dims not provided", () => {
    const client = makeClient();
    trackGoalCreated(client);
    expect(client.track).toHaveBeenCalledWith("goal.created", undefined);
  });

  it("includes goal_level when provided", () => {
    const client = makeClient();
    trackGoalCreated(client, { goalLevel: "company" });
    expect(client.track).toHaveBeenCalledWith("goal.created", { goal_level: "company" });
  });

  it("omits goal_level dimension when goalLevel is null", () => {
    const client = makeClient();
    trackGoalCreated(client, { goalLevel: null });
    expect(client.track).toHaveBeenCalledWith("goal.created", undefined);
  });
});

describe("trackAgentCreated", () => {
  it("includes agent_role without agent_id when id not provided", () => {
    const client = makeClient();
    trackAgentCreated(client, { agentRole: "cto" });
    expect(client.track).toHaveBeenCalledWith("agent.created", { agent_role: "cto" });
  });

  it("includes agent_id when provided", () => {
    const client = makeClient();
    trackAgentCreated(client, { agentRole: "developer", agentId: "abc-123" });
    expect(client.track).toHaveBeenCalledWith("agent.created", {
      agent_role: "developer",
      agent_id: "abc-123",
    });
  });
});

describe("trackSkillImported", () => {
  it("omits skill_ref when null", () => {
    const client = makeClient();
    trackSkillImported(client, { sourceType: "url", skillRef: null });
    expect(client.track).toHaveBeenCalledWith("skill.imported", { source_type: "url" });
  });

  it("includes skill_ref when provided", () => {
    const client = makeClient();
    trackSkillImported(client, { sourceType: "git", skillRef: "paperclip/some-skill" });
    expect(client.track).toHaveBeenCalledWith("skill.imported", {
      source_type: "git",
      skill_ref: "paperclip/some-skill",
    });
  });
});

describe("trackAgentFirstHeartbeat", () => {
  it("includes agent_role without id when not provided", () => {
    const client = makeClient();
    trackAgentFirstHeartbeat(client, { agentRole: "developer" });
    expect(client.track).toHaveBeenCalledWith("agent.first_heartbeat", {
      agent_role: "developer",
    });
  });

  it("includes agent_id when provided", () => {
    const client = makeClient();
    trackAgentFirstHeartbeat(client, { agentRole: "cto", agentId: "xyz" });
    expect(client.track).toHaveBeenCalledWith("agent.first_heartbeat", {
      agent_role: "cto",
      agent_id: "xyz",
    });
  });
});

describe("trackAgentTaskCompleted", () => {
  it("includes only agent_role when optional dims omitted", () => {
    const client = makeClient();
    trackAgentTaskCompleted(client, { agentRole: "developer" });
    expect(client.track).toHaveBeenCalledWith("agent.task_completed", {
      agent_role: "developer",
    });
  });

  it("includes all optional dimensions when all provided", () => {
    const client = makeClient();
    trackAgentTaskCompleted(client, {
      agentRole: "developer",
      agentId: "xyz",
      adapterType: "process",
      model: "claude-3",
    });
    expect(client.track).toHaveBeenCalledWith("agent.task_completed", {
      agent_role: "developer",
      agent_id: "xyz",
      adapter_type: "process",
      model: "claude-3",
    });
  });
});

describe("trackErrorHandlerCrash", () => {
  it("calls track with error_code dimension", () => {
    const client = makeClient();
    trackErrorHandlerCrash(client, { errorCode: "ENOENT" });
    expect(client.track).toHaveBeenCalledWith("error.handler_crash", { error_code: "ENOENT" });
  });
});
