// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import {
  SkillPolicyDenialNotice,
  useSkillPolicyDenial,
} from "./SkillPolicySurfaces";
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
  it("renders a State B policy denial with title and remediation", () => {
    const el = render(<SkillPolicyDenialNotice denial={policyDenial()} />);
    expect(el.textContent).toContain("restricted by your company policy");
    expect(el.textContent).toContain("administrator can change the skill policy");
  });

  it("renders a State C platform-safety denial", () => {
    const el = render(<SkillPolicyDenialNotice denial={platformDenial()} />);
    expect(el.textContent).toContain("secret value");
  });

  it("supports dismissing the persistent banner", () => {
    let dismissed = false;
    const el = render(
      <SkillPolicyDenialNotice denial={policyDenial()} onDismiss={() => { dismissed = true; }} />,
    );
    act(() => (el.querySelector("button") as HTMLButtonElement).click());
    expect(dismissed).toBe(true);
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
