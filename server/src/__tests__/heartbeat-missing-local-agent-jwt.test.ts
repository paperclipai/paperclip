import { describe, expect, it } from "vitest";
import {
  ConfigurationIncompleteFailure,
  MISSING_LOCAL_AGENT_JWT_CODE,
  MissingLocalAgentJwtFailure,
  WorkspaceValidationFailure,
} from "../services/heartbeat.ts";

// VIR-880 / VIR-881: thin unit coverage for the typed-failure plumbing used
// by the fail-fast branch in heartbeat.ts. We deliberately avoid DB-bound
// scenarios here because the broader heartbeat lifecycle is exercised by
// heartbeat-local-environment.test.ts under embedded Postgres.
describe("MissingLocalAgentJwtFailure (VIR-880 / VIR-881)", () => {
  it("exports the canonical errorCode constant", () => {
    expect(MISSING_LOCAL_AGENT_JWT_CODE).toBe("missing_local_agent_jwt");
  });

  it("preserves message, name, code, and resultJson", () => {
    const resultJson = {
      runId: "run-1",
      issueId: "issue-1",
      issueIdentifier: "VIR-881",
      agentId: "agent-1",
      adapterType: "opencode_local",
      checkedAt: "2026-08-12T22:00:00.000Z",
    };
    const failure = new MissingLocalAgentJwtFailure("adapter requer local agent jwt", resultJson);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toBeInstanceOf(MissingLocalAgentJwtFailure);
    expect(failure.name).toBe("MissingLocalAgentJwtFailure");
    expect(failure.message).toBe("adapter requer local agent jwt");
    expect(failure.code).toBe("missing_local_agent_jwt");
    expect(failure.resultJson).toEqual(resultJson);
  });

  it("is distinguishable from sibling *Failure types via instanceof", () => {
    const failure = new MissingLocalAgentJwtFailure("boom", { runId: "r" });
    expect(failure).toBeInstanceOf(MissingLocalAgentJwtFailure);
    expect(failure).not.toBeInstanceOf(WorkspaceValidationFailure);
    expect(failure).not.toBeInstanceOf(ConfigurationIncompleteFailure);

    const workspaceFailure = new WorkspaceValidationFailure("boom", { runId: "r" });
    expect(workspaceFailure).not.toBeInstanceOf(MissingLocalAgentJwtFailure);
    expect(workspaceFailure.code).toBe("workspace_validation_failed");

    const incompleteFailure = new ConfigurationIncompleteFailure("boom", { runId: "r" });
    expect(incompleteFailure).not.toBeInstanceOf(MissingLocalAgentJwtFailure);
    expect(incompleteFailure.code).toBe("configuration_incomplete");
  });

  it("serialises a stable diagnostic shape suitable for setRunStatusIfRunning", () => {
    const failure = new MissingLocalAgentJwtFailure("adapter requer local agent jwt", {
      runId: "run-1",
      issueIdentifier: "VIR-881",
      agentId: "agent-1",
      adapterType: "opencode_local",
    });

    // The fail-fast block uses the union of these three fields as the
    // `resultJson` written alongside the run. Lock the shape so downstream
    // tooling (recovery, dashboards) keeps working.
    expect(failure.resultJson).toMatchObject({
      runId: "run-1",
      issueIdentifier: "VIR-881",
      agentId: "agent-1",
      adapterType: "opencode_local",
    });
  });
});
