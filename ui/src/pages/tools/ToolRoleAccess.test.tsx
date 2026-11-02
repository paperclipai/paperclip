// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentBoardAccess } from "@/api/access";
import { AdvancedToolsRoute } from "./AdvancedToolsRoute";
import { ToolsAdminGate } from "./profiles/ToolsAdminGate";

const accessState = vi.hoisted(() => ({ data: undefined as CurrentBoardAccess | undefined }));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: accessState.data, isLoading: false }),
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("./ToolsAccess", () => ({
  ToolsAccess: () => <div>Advanced tool setup</div>,
}));

function snapshot(role: "owner" | "admin" | "operator" | "member" | "viewer"): CurrentBoardAccess {
  return {
    user: { id: "user-1", email: "editor@example.com", name: "Editor", image: null },
    userId: "user-1",
    isInstanceAdmin: false,
    companyIds: ["company-1"],
    memberships: [{ companyId: "company-1", membershipRole: role, status: "active" }],
    source: "session",
    keyId: null,
  };
}

describe.each([
  ["advanced tool setup", <AdvancedToolsRoute />, "Advanced tool setup"],
  ["access profiles", <ToolsAdminGate>Profile editor</ToolsAdminGate>, "Profile editor"],
] as const)("%s role access", (_label, content, editorText) => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    accessState.data = undefined;
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  function render(access: CurrentBoardAccess | undefined) {
    accessState.data = access;
    flushSync(() => root.render(content));
  }

  it.each(["owner", "admin", "operator", "member"] as const)("allows active %s defaults", (role) => {
    render(snapshot(role));
    expect(container.textContent).toContain(editorText);
  });

  it("allows local boards and instance admins without company membership", () => {
    render({ ...snapshot("viewer"), memberships: [], source: "local_implicit" });
    expect(container.textContent).toContain(editorText);
    render({ ...snapshot("viewer"), memberships: [], isInstanceAdmin: true });
    expect(container.textContent).toContain(editorText);
  });

  it("rejects viewers, inactive memberships, and members of another company", () => {
    render(snapshot("viewer"));
    expect(container.textContent).not.toContain(editorText);
    const operator = snapshot("operator");
    render({ ...operator, memberships: [{ ...operator.memberships![0]!, status: "suspended" }] });
    expect(container.textContent).not.toContain(editorText);
    render({ ...operator, memberships: [{ ...operator.memberships![0]!, companyId: "company-2" }] });
    expect(container.textContent).not.toContain(editorText);
    render(undefined);
    expect(container.textContent).not.toContain(editorText);
  });
});
