import { describe, expect, it } from "vitest";
import { assertControllerLeaseSession } from "./legacy-controller-lease-continuation.js";

describe("retained lease session identity", () => {
  const fixture = () => ({
    context: {
      requireExistingSession: true,
      controllerLeaseResume: {
        sessionId: "conversation",
        sourceRunId: "source",
        workspaceId: "workspace",
        cwd: "/work/original",
      },
    },
    sessionId: "conversation",
    sessionSourceRunId: "source",
    workspaceId: "workspace",
    cwd: "/work/original",
    reset: false,
  });
  it("leaves ordinary session policy unchanged", () => {
    const input = fixture();
    input.context.requireExistingSession = false;
    expect(() =>
      assertControllerLeaseSession({ ...input, reset: true }),
    ).not.toThrow();
  });
  it("continues the exact saved conversation", () => {
    expect(() => assertControllerLeaseSession(fixture())).not.toThrow();
  });
  it.each([
    "sessionId",
    "sessionSourceRunId",
    "workspaceId",
    "cwd",
    "reset",
  ] as const)("rejects changed %s before provider dispatch", (field) => {
    const input = fixture();
    const changed =
      field === "reset"
        ? { ...input, reset: true }
        : { ...input, [field]: "changed" };
    expect(() => assertControllerLeaseSession(changed)).toThrow(
      "resume_session_unavailable",
    );
  });
});
