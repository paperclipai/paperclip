import { describe, it, expect } from "vitest";
import { mapTerminalState } from "../../src/orchestrator/failure-mapping.js";

describe("mapTerminalState", () => {
  it("returns success on Job.status.succeeded", () => {
    const r = mapTerminalState({
      job: { status: { succeeded: 1 } },
      pod: { status: { containerStatuses: [{ name: "agent", image: "x", imageID: "x", ready: false, restartCount: 0, state: { terminated: { exitCode: 0 } } }] } },
    });
    expect(r.exitCode).toBe(0);
    expect(r.errorCode).toBeUndefined();
  });

  it("maps ImagePullBackOff to image_pull_failed", () => {
    const r = mapTerminalState({
      job: { status: {} },
      pod: { status: { containerStatuses: [{ name: "agent", image: "x", imageID: "", ready: false, restartCount: 0, state: { waiting: { reason: "ImagePullBackOff", message: "no auth" } } }] } },
    });
    expect(r.errorCode).toBe("image_pull_failed");
    expect(r.errorFamily).toBe("transient_upstream");
  });

  it("maps OOMKilled exitCode 137", () => {
    const r = mapTerminalState({
      job: { status: { failed: 1 } },
      pod: { status: { containerStatuses: [{ name: "agent", image: "x", imageID: "", ready: false, restartCount: 0, state: { terminated: { reason: "OOMKilled", exitCode: 137 } } }] } },
    });
    expect(r.errorCode).toBe("oom_killed");
    expect(r.exitCode).toBe(137);
  });

  it("maps DeadlineExceeded to timeout", () => {
    const r = mapTerminalState({
      job: { status: { conditions: [{ type: "Failed", reason: "DeadlineExceeded", status: "True" }] } },
    });
    expect(r.errorCode).toBe("timeout");
    expect(r.timedOut).toBe(true);
  });

  it("maps init container terminal failure to workspace_init_failed", () => {
    const r = mapTerminalState({
      job: { status: { failed: 1 } },
      pod: { status: { initContainerStatuses: [{ name: "workspace-init", image: "x", imageID: "", ready: false, restartCount: 0, state: { terminated: { exitCode: 2, reason: "Error", message: "git clone failed" } } }] } },
    });
    expect(r.errorCode).toBe("workspace_init_failed");
  });

  it("falls through to agent_exit_nonzero for generic failures", () => {
    const r = mapTerminalState({
      job: { status: { failed: 1 } },
      pod: { status: { containerStatuses: [{ name: "agent", image: "x", imageID: "", ready: false, restartCount: 0, state: { terminated: { exitCode: 7 } } }] } },
    });
    expect(r.errorCode).toBe("agent_exit_nonzero");
    expect(r.exitCode).toBe(7);
  });
});
