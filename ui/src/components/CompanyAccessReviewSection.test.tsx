// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyAccessReviewSection } from "./CompanyAccessReviewSection";
import { ApiError } from "../api/client";

const mockAccessApi = vi.hoisted(() => ({
  getCompanyAccessReview: vi.fn(),
}));

vi.mock("../api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, type = "button", ...props }: ComponentProps<"button">) => (
    <button type={type} onClick={onClick} {...props}>
      {children}
    </button>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderSection(container: HTMLDivElement, companyId: string) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <CompanyAccessReviewSection companyId={companyId} />
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("CompanyAccessReviewSection", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAccessApi.getCompanyAccessReview.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders effective access reasons separately from explicit grants", async () => {
    mockAccessApi.getCompanyAccessReview.mockResolvedValue({
      companyId: "company-1",
      generatedAt: "2026-04-15T20:00:00.000Z",
      people: [
        {
          userId: "user-1",
          name: "Alice Admin",
          email: "alice@example.com",
          membershipRole: "owner",
          membershipStatus: "active",
          effectiveAccess: [
            { kind: "company_membership", label: "Active company owner" },
            { kind: "instance_admin", label: "Instance admin" },
          ],
          explicitPermissions: ["users:manage_permissions"],
        },
        {
          userId: "user-2",
          name: "Bob Builder",
          email: "bob@example.com",
          membershipRole: "member",
          membershipStatus: "active",
          effectiveAccess: [
            { kind: "company_membership", label: "Active company member" },
          ],
          explicitPermissions: [],
        },
      ],
    });

    const root = renderSection(container, "company-1");
    await flush();

    expect(container.textContent).toContain("People with effective access");
    expect(container.textContent).toContain("Alice Admin");
    expect(container.textContent).toContain("alice@example.com");
    expect(container.textContent).toContain("Instance admin");
    expect(container.textContent).toContain("users:manage_permissions");
    expect(container.textContent).toContain("No explicit company grants.");

    act(() => root.unmount());
  });

  it("shows a non-leaky permission message on 403", async () => {
    mockAccessApi.getCompanyAccessReview.mockRejectedValue(
      new ApiError("Permission denied", 403, { error: "Permission denied" }),
    );

    const root = renderSection(container, "company-1");
    await flush();
    await flush();

    expect(container.textContent).toContain(
      "You need users:manage_permissions to review effective company access.",
    );
    expect(container.textContent).not.toContain("Permission denied");

    act(() => root.unmount());
  });
});
