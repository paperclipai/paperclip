// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { AgentDepartmentsField } from "./AgentDepartmentsField";

vi.mock("@/api/departments", () => ({
  departmentsApi: {
    list: () => new Promise(() => {}),
    setForAgent: vi.fn(),
    create: vi.fn(),
  },
}));

function markup(client: QueryClient) {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AgentDepartmentsField companyId="company-1" agentId="agent-1" />
    </QueryClientProvider>,
  );
}

function departmentInput(html: string) {
  return html.match(/<input\b[^>]*>/g)?.find((tag) => tag.includes('aria-label="Add a department"')) ?? "";
}

describe("AgentDepartmentsField", () => {
  it("keeps writes off until the department list has loaded", () => {
    const pending = markup(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    expect(departmentInput(pending)).toContain('disabled=""');

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.departments.list("company-1"), [
      { id: "dept-1", companyId: "company-1", name: "Research", agentIds: ["agent-1"] },
    ]);
    const loaded = markup(client);
    expect(loaded).toContain("Research");
    expect(departmentInput(loaded)).not.toContain('disabled=""');
    expect(loaded).toContain('aria-label="Remove Research"');
  });
});
