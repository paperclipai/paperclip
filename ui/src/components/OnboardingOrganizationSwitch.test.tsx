// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OnboardingOrganizationSwitch,
  onboardingSwitchCompanies,
  type OnboardingSwitchCompany,
} from "./OnboardingOrganizationSwitch";

const bmc: OnboardingSwitchCompany = {
  id: "bmc",
  name: "BMC",
  issuePrefix: "BMC",
  status: "active",
  logoUrl: null,
};
const and: OnboardingSwitchCompany = {
  id: "and",
  name: "andhash",
  issuePrefix: "AND",
  status: "active",
  logoUrl: null,
};

describe("onboardingSwitchCompanies", () => {
  it("hides the switch when this company is the only one", () => {
    expect(onboardingSwitchCompanies([bmc], bmc.id)).toEqual([]);
    expect(onboardingSwitchCompanies([], null)).toEqual([]);
  });

  it("ignores an archived company", () => {
    expect(onboardingSwitchCompanies([bmc, { ...and, status: "archived" }], bmc.id)).toEqual([]);
  });

  it("keeps the current company in the list when another live company exists", () => {
    expect(onboardingSwitchCompanies([bmc, and], bmc.id).map((company) => company.issuePrefix)).toEqual([
      "BMC",
      "AND",
    ]);
  });
});

describe("OnboardingOrganizationSwitch", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders nothing while the operator has no other organization", async () => {
    await act(async () => {
      root.render(<OnboardingOrganizationSwitch companies={[bmc]} selectedCompanyId={bmc.id} onSelect={vi.fn()} />);
    });
    expect(document.querySelector('[data-testid="onboarding-organization-switch"]')).toBeNull();
  });

  it("navigates by choosing another organization and leaves the current one in place", async () => {
    const onSelect = vi.fn();
    await act(async () => {
      root.render(
        <OnboardingOrganizationSwitch companies={[bmc, and]} selectedCompanyId={bmc.id} onSelect={onSelect} />,
      );
    });
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="onboarding-organization-switch"]');
    expect(trigger?.getAttribute("aria-label")).toBe("Switch organization");
    expect(trigger?.textContent).toContain("BMC");

    await act(async () => {
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const other = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find((item) =>
      item.textContent?.includes("andhash"),
    );
    expect(other).toBeTruthy();
    await act(async () => {
      other?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      other?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0].issuePrefix).toBe("AND");

    const current = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find((item) =>
      item.textContent?.includes("BMC"),
    );
    onSelect.mockClear();
    await act(async () => {
      current?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      current?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSelect).not.toHaveBeenCalled();
  });
});
