import type { V1Job, V1Pod } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";

import {
  classifyAgentJobRunStatus,
  isActiveOrTerminatingAgentPod,
} from "../services/k8s-job-liveness.js";

describe("classifyAgentJobRunStatus", () => {
  it("keeps multi-completion Jobs active when only one pod succeeded and no Complete condition exists", () => {
    const job = {
      spec: { completions: 2 },
      status: {
        active: 1,
        succeeded: 1,
        conditions: [],
      },
    } as unknown as V1Job satisfies V1Job;

    expect(classifyAgentJobRunStatus(job)).toEqual({
      phase: "active",
      reason: null,
      message: null,
    });
  });

  it("keeps a Job active when pods have failed but no terminal Failed condition exists", () => {
    const job = {
      status: {
        active: 0,
        failed: 1,
        conditions: [],
      },
    } satisfies V1Job;

    expect(classifyAgentJobRunStatus(job)).toEqual({
      phase: "active",
      reason: null,
      message: null,
    });
  });
});

describe("isActiveOrTerminatingAgentPod", () => {
  it("treats terminating pods as active so RWO volumes can detach before retry dispatch", () => {
    const pod = {
      metadata: {
        deletionTimestamp: "2026-06-11T19:45:40.000Z",
      },
      status: {
        phase: "Running",
      },
    } as unknown as V1Pod;

    expect(isActiveOrTerminatingAgentPod(pod)).toBe(true);
  });

  it("ignores completed pods that are not terminating", () => {
    const pod = {
      status: {
        phase: "Succeeded",
      },
    } as V1Pod;

    expect(isActiveOrTerminatingAgentPod(pod)).toBe(false);
  });
});
