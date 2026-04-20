// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InviteUxLab } from "./InviteUxLab";

vi.mock("@/components/CompanyPatternIcon", () => ({
  CompanyPatternIcon: ({ companyName }: { companyName: string }) => (
    <div aria-label={`${companyName} logo`}>{companyName}</div>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("InviteUxLab", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders the invite/signup review sections", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(<InviteUxLab />);
    });

    expect(container.textContent).toContain("Invite and signup UX review surface");
    expect(container.textContent).toContain("/tests/ux/invites");
    expect(container.textContent).toContain("Landing state coverage");
    expect(container.textContent).toContain("Split-screen invite flows");
    expect(container.textContent).toContain("Approval and completion screens");
    expect(container.textContent).toContain("Auth page states");
    expect(container.textContent).toContain("Company invite management");
    expect(container.textContent).toContain("Create your account");
    expect(container.textContent).toContain("Invite history");

    await act(async () => {
      root.unmount();
    });
  });
});
