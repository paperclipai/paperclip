import { describe, expect, it } from "vitest";
import {
  mergeHeartbeatRunDiagnosticEvidence,
  readHeartbeatRunFailureSubtype,
} from "../services/heartbeat-run-diagnostics.js";

describe("heartbeat run diagnostics", () => {
  it("copies failed adapter stdout/stderr from resultJson into persisted excerpts", () => {
    const diagnostic = mergeHeartbeatRunDiagnosticEvidence({
      resultJson: {
        stdout: "adapter stdout",
        stderr: "adapter stderr",
      },
      stdoutExcerpt: "",
      stderrExcerpt: "",
      failureSubtype: "adapter_failed",
    });

    expect(diagnostic.stdoutExcerpt).toBe("adapter stdout\n");
    expect(diagnostic.stderrExcerpt).toBe("adapter stderr\n");
    expect(diagnostic.resultJson).toEqual({
      stdout: "adapter stdout",
      stderr: "adapter stderr",
      failureSubtype: "adapter_failed",
    });
  });

  it("does not duplicate stderr already captured by live logging", () => {
    const diagnostic = mergeHeartbeatRunDiagnosticEvidence({
      resultJson: {
        stderr: "same stderr",
      },
      stdoutExcerpt: null,
      stderrExcerpt: "same stderr\n",
      failureSubtype: null,
    });

    expect(diagnostic.stderrExcerpt).toBe("same stderr\n");
  });

  it("infers codex failure subtype from jsonl stdout", () => {
    expect(
      readHeartbeatRunFailureSubtype({
        stdout: JSON.stringify({ type: "turn.failed", error: { message: "boom" } }),
      }),
    ).toBe("turn.failed");
  });
});
