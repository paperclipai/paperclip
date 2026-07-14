// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The real Link is company-aware and needs a CompanyProvider. Stub it to a
// plain anchor so we can assert the resolved hrefs without a router.
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

import {
  PaperclipEeAffordance,
  SkillPolicyDenialNotice,
  useSkillPolicyDenial,
} from "./SkillPolicySurfaces";
import type { EeSkillPolicyAvailability } from "./SkillPolicySurfaces";
import { classifySkillDenial } from "@/lib/skill-policy-denial";
import { ApiError } from "@/api/client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

function act<T>(cb: () => T): T {
  let result: T | undefined;
  flushSync(() => {
    result = cb();
  });
  return result as T;
}

function render(node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
});

const eeEnabled: EeSkillPolicyAvailability = {
  availability: "enabled",
  pageLink: "/ACME/plugins/ee-uuid",
  settingsLink: "/company/settings/instance/plugins/paperclipai.paperclip-ee",
};

function policyDenial() {
  return classifySkillDenial(
    new ApiError("denied", 403, {
      code: "skill_policy_denied",
      reason: "explicit_rule",
      remediation: "A company administrator can change the skill policy to allow this.",
    }),
    "Installing external skills",
  )!;
}

function platformDenial() {
  return classifySkillDenial(
    new ApiError("blocked", 403, {
      code: "skill_secret_handling_blocked",
      reason: "platform_invariant",
    }),
  )!;
}

describe("SkillPolicyDenialNotice", () => {
  it("renders a State B policy denial with title, remediation, and an EE link when EE is enabled", () => {
    const el = render(<SkillPolicyDenialNotice denial={policyDenial()} ee={eeEnabled} />);
    expect(el.textContent).toContain("restricted by your company policy");
    expect(el.textContent).toContain("administrator can change the skill policy");
    const link = el.querySelector("a[href='/ACME/plugins/ee-uuid']");
    expect(link).not.toBeNull();
    expect(el.textContent).toContain("Open skill policy in EE");
  });

  it("never shows an EE link for a State C platform-safety denial", () => {
    const el = render(<SkillPolicyDenialNotice denial={platformDenial()} ee={eeEnabled} />);
    expect(el.textContent).toContain("secret value");
    expect(el.querySelector("a[href='/ACME/plugins/ee-uuid']")).toBeNull();
  });

  it("omits the EE link for a policy denial when EE is absent (no broken link)", () => {
    const el = render(
      <SkillPolicyDenialNotice
        denial={policyDenial()}
        ee={{ availability: "absent", pageLink: null, settingsLink: null }}
      />,
    );
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("administrator can change the skill policy");
  });
});

describe("PaperclipEeAffordance", () => {
  it("absent → text-only marketing link, never disables anything", () => {
    const el = render(
      <PaperclipEeAffordance availability="absent" pageLink={null} settingsLink={null} />,
    );
    const link = el.querySelector("a[href='https://paperclip.ing/ee']");
    expect(link).not.toBeNull();
  });

  it("enabled → in-app deep link", () => {
    const el = render(
      <PaperclipEeAffordance
        availability="enabled"
        pageLink="/ACME/plugins/ee-uuid"
        settingsLink={null}
      />,
    );
    expect(el.querySelector("a[href='/ACME/plugins/ee-uuid']")).not.toBeNull();
  });

  it("disabled → enable hint pointing at plugin settings", () => {
    const el = render(
      <PaperclipEeAffordance
        availability="disabled"
        pageLink={null}
        settingsLink="/company/settings/instance/plugins/paperclipai.paperclip-ee"
      />,
    );
    expect(el.textContent).toContain("installed but disabled");
    expect(
      el.querySelector("a[href='/company/settings/instance/plugins/paperclipai.paperclip-ee']"),
    ).not.toBeNull();
  });

  it("error → still says skill management works", () => {
    const el = render(
      <PaperclipEeAffordance availability="error" pageLink={null} settingsLink={null} />,
    );
    expect(el.textContent).toContain("Skill management still works");
  });
});

describe("useSkillPolicyDenial", () => {
  const policyError = new ApiError("denied", 403, {
    code: "skill_policy_denied",
    reason: "explicit_rule",
  });
  const transientError = new ApiError("conflict", 409, { message: "try again" });

  function Harness({ error, label }: { error: unknown; label?: string }) {
    const controller = useSkillPolicyDenial();
    return (
      <div>
        <span data-testid="captured">
          {controller.denial ? `banner:${controller.denial.state}` : "no-banner"}
        </span>
        <button data-testid="capture" onClick={() => controller.capture(error, label)}>
          capture
        </button>
        <button data-testid="reset" onClick={() => controller.reset()}>
          reset
        </button>
      </div>
    );
  }

  it("captures an explicit-policy denial into the banner and clears on reset", () => {
    const el = render(<Harness error={policyError} label="Installing external skills" />);
    expect(el.querySelector("[data-testid=captured]")!.textContent).toBe("no-banner");
    act(() => (el.querySelector("[data-testid=capture]") as HTMLButtonElement).click());
    expect(el.querySelector("[data-testid=captured]")!.textContent).toBe("banner:policy");
    act(() => (el.querySelector("[data-testid=reset]") as HTMLButtonElement).click());
    expect(el.querySelector("[data-testid=captured]")!.textContent).toBe("no-banner");
  });

  it("ignores transient errors so they stay on the caller's toast path", () => {
    const el = render(<Harness error={transientError} />);
    act(() => (el.querySelector("[data-testid=capture]") as HTMLButtonElement).click());
    expect(el.querySelector("[data-testid=captured]")!.textContent).toBe("no-banner");
  });
});
