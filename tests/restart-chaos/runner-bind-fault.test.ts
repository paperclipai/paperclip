import { describe, expect, it } from "vitest";
import { parseCommand } from "./config.js";
import { runnerBindFaultServerEnvironment } from "./session-faults.js";

const image = `img@sha256:${"a".repeat(64)}`;

describe("--runner-bind-fault", () => {
  it("arms the server's first-launch bind fault on the s6402 volume-free shape", () => {
    const command = parseCommand(["--env", "daytona", "--daytona-image", image, "--daytona-warm", "--storage", "s3",
      "--ephemeral-server", "--adapters", "claude", "--workloads", "W2", "--faults", "K1,K2,K15", "--k15-fresh-home",
      "--seed", "6402", "--runner-bind-fault"]);
    if (command.mode !== "wave") throw new Error("expected a wave");
    expect(command.options.runnerBindFault).toBe(true);
    expect(runnerBindFaultServerEnvironment(command.options.runnerBindFault))
      .toEqual({ PAPERCLIP_TEST_RUNNER_BIND_FAULT: "first_launch" });
  });

  it("leaves the server unarmed without the flag and refuses a local wave", () => {
    const command = parseCommand(["--env", "daytona", "--daytona-image", image, "--workloads", "W2", "--faults", "K2"]);
    if (command.mode !== "wave") throw new Error("expected a wave");
    expect(command.options.runnerBindFault).toBeUndefined();
    expect(runnerBindFaultServerEnvironment(command.options.runnerBindFault)).toEqual({});
    expect(() => parseCommand(["--workloads", "W2", "--faults", "K2", "--runner-bind-fault"])).toThrow("--env daytona");
  });
});
