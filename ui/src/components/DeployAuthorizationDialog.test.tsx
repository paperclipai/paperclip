// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEPLOY_AUTHORIZATION_ISSUED_EVENT,
  type OneTimeDeployAuthorization,
} from "../api/issues";
import { ThemeProvider } from "../context/ThemeContext";
import { DeployAuthorizationDialog } from "./DeployAuthorizationDialog";
import { TooltipProvider } from "./ui/tooltip";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(children: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <ThemeProvider>
        <TooltipProvider>{children}</TooltipProvider>
      </ThemeProvider>,
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

describe("DeployAuthorizationDialog", () => {
  it("keeps the token visible until the operator confirms it was saved", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<DeployAuthorizationDialog />);
    const authorization: OneTimeDeployAuthorization = {
      id: "authorization-1",
      candidateId: "candidate-1",
      token: "one-time-secret-token",
      tokenReturnedOnce: true,
      alreadyIssued: false,
      targetHost: "srv1749248",
      imageDigest: "ghcr.io/backbond/scanner@sha256:abc",
      environment: "production",
      sequence: 21,
      expiresAt: "2026-07-21T00:00:00.000Z",
    };

    act(() => {
      window.dispatchEvent(new CustomEvent(DEPLOY_AUTHORIZATION_ISSUED_EVENT, { detail: authorization }));
    });

    expect(document.body.textContent).toContain("Save the one-time deploy token");
    expect(document.querySelector('[data-testid="one-time-deploy-token"]')?.textContent).toContain(
      authorization.token,
    );

    const copyButton = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Copy token"),
    );
    await act(async () => {
      copyButton?.click();
    });
    expect(writeText).toHaveBeenCalledWith(authorization.token);
    expect(document.body.textContent).toContain("Copied");

    const savedButton = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("I saved the token"),
    );
    act(() => savedButton?.click());
    expect(document.body.textContent).not.toContain(authorization.token);
  });
});
