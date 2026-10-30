// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Goal } from "@paperclipai/shared";
import { GoalProperties } from "./GoalProperties";

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: [] }),
}));

const sampleGoal: Goal = {
  id: "goal-1",
  companyId: "company-1",
  title: "Test Goal",
  description: "Goal description",
  level: "task",
  status: "planned",
  parentId: null,
  ownerAgentId: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

describe("GoalProperties", () => {
  it("renders owner section and delete action when onUpdate and onDelete are provided", () => {
    const html = renderToStaticMarkup(
      <GoalProperties
        goal={sampleGoal}
        onUpdate={() => {}}
        onDelete={() => {}}
      />
    );

    expect(html).toContain("Owner");
    expect(html).toContain("Delete Goal");
  });

  it("renders read-only owner when onUpdate is not provided", () => {
    const html = renderToStaticMarkup(<GoalProperties goal={sampleGoal} />);
    expect(html).toContain("Owner");
    expect(html).toContain("None");
    expect(html).not.toContain("Delete Goal");
  });
});
