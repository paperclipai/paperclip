// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CompanyCard } from "./CompanyCard";

const fakeCompany = {
  slug: "trail-of-bits-security",
  name: "Trail of Bits Security",
  description: "Security auditing and pentesting.",
  agents_count: 28,
  skills_count: 35,
  tags: ["security"],
  url: "https://github.com/paperclipai/companies/tree/main/trail-of-bits-security",
};

describe("CompanyCard", () => {
  it("renders name, description, and agent count", () => {
    render(<CompanyCard company={fakeCompany} onInstall={() => {}} installing={false} />);
    expect(screen.getByText("Trail of Bits Security")).toBeInTheDocument();
    expect(screen.getByText(/28 agents/i)).toBeInTheDocument();
  });

  it("calls onInstall when install button clicked", () => {
    const onInstall = vi.fn();
    render(<CompanyCard company={fakeCompany} onInstall={onInstall} installing={false} />);
    fireEvent.click(screen.getByRole("button", { name: /install/i }));
    expect(onInstall).toHaveBeenCalledWith("trail-of-bits-security");
  });

  it("shows loading state and disables button when installing", () => {
    render(<CompanyCard company={fakeCompany} onInstall={() => {}} installing={true} />);
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    expect(button.textContent).toMatch(/installing/i);
  });
});
