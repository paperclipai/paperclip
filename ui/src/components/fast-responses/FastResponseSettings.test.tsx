// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { updateFastResponseSchema } from "@paperclipai/shared";
import { FastResponseSettingsView } from "./FastResponseSettings";
import { choices } from "../../../storybook/stories/decision-models/fixtures";
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-storybook" }),
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
it("saves only API settings and keeps the draft across unchanged query refetches", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container),
    onSave = vi.fn();
  const settings = {
    companyId: "company-storybook",
    enabled: false,
    connectionId: null,
    grantId: null,
    provider: null,
    model: null,
    allowSponsored: false,
  };
  const render = () => (
    <MemoryRouter>
      <FastResponseSettingsView
        settings={{ ...settings }}
        choices={choices}
        onSave={onSave}
        onTest={vi.fn()}
      />
    </MemoryRouter>
  );
  try {
    await act(async () => root.render(render()));
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((b) => b.textContent?.includes("Company OpenRouter"))!
        .click(),
    );
    await act(async () => root.render(render()));
    expect(
      container.querySelector<HTMLInputElement>("input[list]")?.value,
    ).toBe("openai/gpt-oss-120b");
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((b) => b.textContent === "Save fast response")!
        .click(),
    );
    const saved = onSave.mock.calls[0][0];
    expect(updateFastResponseSchema.safeParse(saved).success).toBe(true);
    expect(saved).toMatchObject({
      enabled: true,
      allowSponsored: false,
      connectionId: choices[1]!.id,
    });
    expect(saved).not.toHaveProperty("companyId");
    expect(saved).not.toHaveProperty("provider");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
it("selects a newly created connection and recommends its default model", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container),
    onSave = vi.fn(),
    onConnectionChange = vi.fn();
  const settings = {
    companyId: "company-storybook",
    enabled: false,
    connectionId: null,
    grantId: null,
    provider: null,
    model: null,
    allowSponsored: true,
  };
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <FastResponseSettingsView
            settings={settings}
            choices={choices}
            newlyConnectedId={choices[1]!.id}
            onConnectionChange={onConnectionChange}
            onSave={onSave}
            onTest={vi.fn()}
          />
        </MemoryRouter>,
      ),
    );
    expect(
      container.querySelector<HTMLInputElement>("input[list]")?.value,
    ).toBe("openai/gpt-oss-120b");
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((b) => b.textContent === "Save fast response")!
        .click(),
    );
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: choices[1]!.id,
        enabled: true,
        allowSponsored: true,
      }),
    );
    expect(onConnectionChange).toHaveBeenCalledWith(choices[1]!.id);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
