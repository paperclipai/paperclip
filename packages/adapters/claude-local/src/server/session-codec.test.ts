import { describe, expect, it } from "vitest";
import {
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  type AdapterSandboxExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import { sessionCodec } from "./index.js";

const sandbox = (leaseId: string): AdapterSandboxExecutionTarget => ({
  kind: "remote",
  transport: "sandbox",
  providerKey: "coder",
  environmentId: "env-1",
  leaseId,
  remoteCwd: "/home/coder/.sessions/paperclip",
  sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId: "ws-1" },
});

describe("claude_local sessionCodec", () => {
  it("keeps the remote execution identity through a database round trip", () => {
    const remoteExecution = adapterExecutionTargetSessionIdentity(sandbox("lease-row-1"));
    const params = {
      sessionId: "a82041de-0000-4000-8000-000000000001",
      cwd: "/home/coder/.sessions/paperclip",
      remoteExecution,
    };
    const stored = JSON.parse(JSON.stringify(sessionCodec.serialize(params)));
    const loaded = sessionCodec.deserialize(stored);
    expect(loaded?.remoteExecution).toEqual(remoteExecution);
    expect(adapterExecutionTargetSessionMatches(loaded?.remoteExecution, sandbox("lease-row-2"))).toBe(true);
  });

  it("omits remoteExecution when there is none", () => {
    const loaded = sessionCodec.deserialize({ sessionId: "a82041de-0000-4000-8000-000000000001" });
    expect(loaded).not.toHaveProperty("remoteExecution");
  });
});
