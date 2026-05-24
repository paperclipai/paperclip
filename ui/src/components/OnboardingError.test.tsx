// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnboardingError } from "./OnboardingError";
import type { CategorizedOnboardingError } from "../lib/onboarding-error";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
});

function render(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

function make(
  partial: Partial<CategorizedOnboardingError> & { class: CategorizedOnboardingError["class"] },
): CategorizedOnboardingError {
  return {
    status: null,
    serverMessage: null,
    incidentId: null,
    fields: [],
    ...partial,
  };
}

describe("OnboardingError", () => {
  it("renders nothing when error is null", () => {
    const node = render(<OnboardingError error={null} />);
    expect(node.textContent).toBe("");
    expect(node.querySelector('[role="alert"]')).toBeNull();
  });

  it("suppresses rendering for adapter_environment", () => {
    const node = render(
      <OnboardingError error={make({ class: "adapter_environment" })} />,
    );
    expect(node.querySelector('[role="alert"]')).toBeNull();
  });

  it("renders unknown_server_error with friendly copy and a retry button", () => {
    const onRetry = vi.fn();
    const node = render(
      <OnboardingError
        error={make({ class: "unknown_server_error", status: 500 })}
        onRetry={onRetry}
      />,
    );

    const alert = node.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute("data-class")).toBe("unknown_server_error");
    expect(node.textContent).toContain("Something went wrong on our side");
    expect(node.textContent).not.toContain("Internal server error");

    const retry = node.querySelector(
      '[data-testid="onboarding-error-retry"]',
    ) as HTMLButtonElement | null;
    expect(retry).not.toBeNull();

    act(() => {
      retry?.click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("surfaces incidentId in the body when present", () => {
    const node = render(
      <OnboardingError
        error={make({
          class: "unknown_server_error",
          status: 500,
          incidentId: "GST-77",
        })}
        onRetry={() => {}}
      />,
    );
    expect(node.textContent).toContain("GST-77");
  });

  it("renders name_conflict with retry, never echoing the raw server message", () => {
    const node = render(
      <OnboardingError
        error={make({
          class: "name_conflict",
          status: 409,
          serverMessage: "Agent shortname 'CEO' is already in use in this company",
        })}
        onRetry={() => {}}
      />,
    );
    expect(node.textContent).toContain("That name is taken");
    expect(node.textContent).not.toContain("shortname");
  });

  it("renders validation as inline (no banner) and lists each field message", () => {
    const node = render(
      <OnboardingError
        error={make({
          class: "validation",
          status: 400,
          fields: [
            { path: "name", message: "Required" },
            { path: "model", message: "Must be provider/model" },
          ],
        })}
        onRetry={() => {}}
      />,
    );
    const alert = node.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    // No banner class on inline variant
    expect(alert?.className).not.toContain("border-destructive");
    expect(node.textContent).toContain("name: Required");
    expect(node.textContent).toContain("model: Must be provider/model");
    // Inline variant has no retry button
    expect(
      node.querySelector('[data-testid="onboarding-error-retry"]'),
    ).toBeNull();
  });

  it("renders network with check-connection copy", () => {
    const node = render(
      <OnboardingError
        error={make({ class: "network", serverMessage: "Failed to fetch" })}
        onRetry={() => {}}
      />,
    );
    expect(node.textContent).toContain("Couldn't reach Paperclip");
    expect(node.textContent).not.toContain("Failed to fetch");
  });

  it("disables the retry button when retrying is true", () => {
    const node = render(
      <OnboardingError
        error={make({ class: "unknown_server_error" })}
        onRetry={() => {}}
        retrying
      />,
    );
    const retry = node.querySelector(
      '[data-testid="onboarding-error-retry"]',
    ) as HTMLButtonElement | null;
    expect(retry).not.toBeNull();
    expect(retry?.disabled).toBe(true);
    expect(retry?.textContent).toBe("Retrying...");
  });

  it("omits the retry button when no onRetry is provided", () => {
    const node = render(
      <OnboardingError error={make({ class: "unknown_server_error" })} />,
    );
    expect(node.querySelector('[role="alert"]')).not.toBeNull();
    expect(
      node.querySelector('[data-testid="onboarding-error-retry"]'),
    ).toBeNull();
  });
});
