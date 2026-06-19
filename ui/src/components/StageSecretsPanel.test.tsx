// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanySecret, RoutineEnvConfig } from "@paperclipai/shared";
import { StageSecretsPanel } from "./StageSecretsPanel";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function secret(partial: Partial<CompanySecret> & { id: string; name: string }): CompanySecret {
  return {
    companyId: "company-1",
    key: partial.name.toLowerCase(),
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 1,
    description: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...partial,
  } as CompanySecret;
}

const SECRETS: CompanySecret[] = [
  secret({ id: "secret-gh", name: "GH_TOKEN", latestVersion: 2 }),
  secret({ id: "secret-disabled", name: "OLD_KEY", status: "disabled" }),
];

const noop = () => {};
const asyncNoop = async () => SECRETS[0]!;

describe("StageSecretsPanel", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function render(node: React.ReactNode) {
    const root = createRoot(container);
    act(() => {
      root.render(node as React.ReactElement);
    });
    return root;
  }

  it("shows the no-automation empty state with a jump-to-automation action", () => {
    const onSetup = vi.fn();
    render(
      <StageSecretsPanel
        hasAutomation={false}
        secrets={SECRETS}
        secretsLoading={false}
        value={{}}
        onChange={noop}
        onCreateSecret={asyncNoop}
        onSetupAutomation={onSetup}
        onSave={noop}
        saving={false}
        dirty={false}
      />,
    );
    expect(container.textContent).toContain("Secrets are available only to step automation");
    const button = container.querySelector("button");
    expect(button?.textContent).toContain("Set up automation");
    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSetup).toHaveBeenCalledTimes(1);
    // It must NOT render the env editor when there is no automation.
    expect(container.querySelector('input[placeholder="KEY"]')).toBeNull();
  });

  it("renders the configured state with the agent name, precedence copy, and env editor", () => {
    const value: RoutineEnvConfig = {
      GH_TOKEN: { type: "secret_ref", secretId: "secret-gh", version: "latest" },
    };
    render(
      <StageSecretsPanel
        hasAutomation
        agentName="Releasebot"
        agentIcon="bot"
        secrets={SECRETS}
        secretsLoading={false}
        value={value}
        onChange={noop}
        onCreateSecret={asyncNoop}
        onSetupAutomation={noop}
        onSave={noop}
        saving={false}
        dirty={false}
      />,
    );
    expect(container.textContent).toContain("Releasebot");
    expect(container.textContent).toContain("override matching project and agent env");
    // EnvVarEditor mounts a KEY input.
    expect(container.querySelector('input[placeholder="KEY"]')).not.toBeNull();
    // Save disabled while not dirty.
    const saveButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Save secrets"),
    );
    expect(saveButton).toBeTruthy();
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);
  });

  it("surfaces a warning for a disabled/missing secret binding", () => {
    const value: RoutineEnvConfig = {
      OLD_KEY: { type: "secret_ref", secretId: "secret-disabled", version: "latest" },
      GONE: { type: "secret_ref", secretId: "does-not-exist", version: "latest" },
    };
    render(
      <StageSecretsPanel
        hasAutomation
        agentName="Releasebot"
        secrets={SECRETS}
        secretsLoading={false}
        value={value}
        onChange={noop}
        onCreateSecret={asyncNoop}
        onSetupAutomation={noop}
        onSave={noop}
        saving={false}
        dirty={false}
      />,
    );
    expect(container.textContent).toContain("need attention");
    expect(container.textContent).toContain("disabled");
    expect(container.textContent).toContain("missing");
  });

  it("enables Save when dirty and fires onSave", () => {
    const onSave = vi.fn();
    render(
      <StageSecretsPanel
        hasAutomation
        agentName="Releasebot"
        secrets={SECRETS}
        secretsLoading={false}
        value={{ GH_TOKEN: { type: "secret_ref", secretId: "secret-gh", version: "latest" } }}
        onChange={noop}
        onCreateSecret={asyncNoop}
        onSetupAutomation={noop}
        onSave={onSave}
        saving={false}
        dirty
      />,
    );
    const saveButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Save secrets"),
    ) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    expect(container.textContent).toContain("Unsaved changes");
    act(() => {
      saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("shows a loading message instead of the editor while secrets load", () => {
    render(
      <StageSecretsPanel
        hasAutomation
        agentName="Releasebot"
        secrets={[]}
        secretsLoading
        value={{}}
        onChange={noop}
        onCreateSecret={asyncNoop}
        onSetupAutomation={noop}
        onSave={noop}
        saving={false}
        dirty={false}
      />,
    );
    expect(container.textContent).toContain("Loading secrets");
    expect(container.querySelector('input[placeholder="KEY"]')).toBeNull();
  });
});
