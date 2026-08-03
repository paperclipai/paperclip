import { describe, expect, it, vi } from "vitest";
import * as ui from "../src/ui/index.js";

const taskInput = {
  companyId: "company-1",
  humanExternalId: "human-a",
  projectId: "project-1",
  title: "Review denials",
  description: "Check the payer response.",
  priority: "high",
};

describe("new human task request identity", () => {
  it("creates a new request ID when the selected human changes", () => {
    const resolveIdentity = (ui as Record<string, unknown>).resolveNewTaskRequestIdentity;
    expect(typeof resolveIdentity).toBe("function");

    const createId = vi.fn().mockReturnValue("request-2");
    const previous = { requestId: "request-1", input: taskInput };
    const next = (resolveIdentity as (
      current: typeof previous,
      input: typeof taskInput,
      createRequestId: () => string,
    ) => typeof previous)(
      previous,
      { ...taskInput, humanExternalId: "human-b" },
      createId,
    );

    expect(next.requestId).toBe("request-2");
    expect(next.input.humanExternalId).toBe("human-b");
    expect(createId).toHaveBeenCalledOnce();
  });

  it("retains the request ID when an unchanged submission is retried", () => {
    const resolveIdentity = (ui as Record<string, unknown>).resolveNewTaskRequestIdentity;
    expect(typeof resolveIdentity).toBe("function");

    const createId = vi.fn().mockReturnValue("request-2");
    const previous = { requestId: "request-1", input: taskInput };
    const next = (resolveIdentity as (
      current: typeof previous,
      input: typeof taskInput,
      createRequestId: () => string,
    ) => typeof previous)(previous, { ...taskInput }, createId);

    expect(next).toBe(previous);
    expect(createId).not.toHaveBeenCalled();
  });
});
