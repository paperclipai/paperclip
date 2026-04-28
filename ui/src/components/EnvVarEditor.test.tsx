// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { CompanySecret, EnvBinding } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvVarEditor } from "./EnvVarEditor";

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    className,
  }: {
    children: React.ReactNode;
    to: string;
    className?: string;
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const secret: CompanySecret = {
  id: "secret-1",
  companyId: "company-1",
  name: "OPENAI_API_KEY",
  provider: "local_encrypted",
  externalRef: null,
  latestVersion: 1,
  description: null,
  createdByAgentId: null,
  createdByUserId: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("EnvVarEditor", () => {
  let container: HTMLDivElement;

  afterEach(() => {
    container?.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("uses existing secret references without inline secret creation controls", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    const onChange = vi.fn();
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <EnvVarEditor
          value={{}}
          secrets={[secret]}
          onChange={onChange}
        />,
      );
    });

    expect(container.textContent).not.toContain("Seal");
    expect(container.textContent).not.toContain("New");
    expect(container.textContent).toContain("Company Settings > Secrets");

    const keyInput = container.querySelector("input[placeholder='KEY']") as HTMLInputElement;
    const sourceSelect = container.querySelector("select") as HTMLSelectElement;

    await act(async () => {
      setInputValue(keyInput, "OPENAI_API_KEY");
    });
    await act(async () => {
      setSelectValue(sourceSelect, "secret");
    });

    expect(sourceSelect.value).toBe("secret");
    expect(onChange).toHaveBeenLastCalledWith(undefined);

    const selects = container.querySelectorAll("select");
    const secretSelect = selects[1] as HTMLSelectElement;
    await act(async () => {
      setSelectValue(secretSelect, "secret-1");
    });

    expect(onChange).toHaveBeenLastCalledWith({
      OPENAI_API_KEY: {
        type: "secret_ref",
        secretId: "secret-1",
        version: "latest",
      },
    } satisfies Record<string, EnvBinding>);

    await act(async () => {
      root.unmount();
    });
  });
});
