import { describe, expect, it, vi } from "vitest";
import { inboxStep, openPersonalInbox } from "./inbox-triage-flow.js";
import { JourneyError, type JourneyContext } from "./types.js";

type Probe = { visible?: () => boolean; count?: () => number; value?: () => string };
vi.mock("@playwright/test", () => ({ expect: (probe: Probe) => ({
  toBeVisible: async () => { if (!probe.visible?.()) throw new Error("private browser diagnostic"); },
  toHaveCount: async (expected: number) => { if (probe.count?.() !== expected) throw new Error("private browser diagnostic"); },
  toHaveValue: async (expected: string) => { if (probe.value?.() !== expected) throw new Error("private browser diagnostic"); },
}) }));

function fixture(options: { loading?: boolean; listVisible?: boolean; ignoreClear?: boolean } = {}) {
  let query = "saved global search";
  const fills: string[] = [], visits: string[] = [];
  const search = {
    visible: () => true, value: () => query,
    fill: async (value: string) => { fills.push(value); if (!options.ignoreClear) query = value; },
  };
  const list = { visible: () => options.listVisible !== false };
  const context = {
    api: { origin: "https://qa.example.test" }, company: { issuePrefix: "QA" },
    page: {
      goto: async (url: string) => { visits.push(url); },
      getByPlaceholder: () => search,
      getByRole: () => ({ count: () => options.loading ? 1 : 0 }),
      getByText: () => ({ visible: () => false }),
      locator: () => ({ or: () => ({ first: () => list }) }),
    },
  } as unknown as JourneyContext;
  // Production search results can lack personal archive controls. A normal
  // view is required even when an ID selector could locate a search result.
  return { context, fills, visits, personalControlsAvailable: () => query === "" };
}

describe("personal inbox navigation", () => {
  it.each(["mine", "unread"] as const)("clears global search before acting in the %s view", async view => {
    const f = fixture();
    expect(f.personalControlsAvailable()).toBe(false);
    await openPersonalInbox(f.context, view);
    expect(f.visits).toEqual([`https://qa.example.test/QA/inbox/${view}`]);
    expect(f.fills).toEqual([""]);
    expect(f.personalControlsAvailable()).toBe(true);
  });

  it.each([{ loading: true }, { listVisible: false }, { ignoreClear: true }])("does not prove absence from an unready or searched view: %j", async options => {
    await expect(openPersonalInbox(fixture(options).context, "unread")).rejects.toMatchObject({
      outcome: "failed", code: "inbox_unread_view_unavailable",
    });
  });
});

describe("inbox operation diagnostics", () => {
  it("returns the original successful observation", async () => {
    const observation = { isUnreadForMe: true };
    expect(await inboxStep("inbox_unread_projection_failed", async () => observation)).toBe(observation);
  });

  it("retains a closed code without raw browser values", async () => {
    const failure = await inboxStep("inbox_unread_projection_failed", async () => {
      throw new Error("https://private.example/callback?token=DO_NOT_RETAIN");
    }).catch(error => error);
    expect(failure).toBeInstanceOf(JourneyError);
    expect(failure.code).toBe("inbox_unread_projection_failed");
    expect(JSON.stringify(failure)).not.toContain("DO_NOT_RETAIN");
  });

  it("preserves an independently detected missing task projection", async () => {
    const missing = new JourneyError("failed", "inbox_owned_task_projection_missing");
    await expect(inboxStep("inbox_unread_projection_failed", async () => { throw missing; })).rejects.toBe(missing);
  });
});
