// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanySecret, EnvBinding } from "@paperclipai/shared";
import { EnvironmentVariablesEditor } from "./index";

// Radix (DropdownMenu/Popover) relies on Pointer Capture APIs that jsdom omits.
const OriginalPointerEvent = globalThis.PointerEvent;
beforeAll(() => {
  if (!globalThis.PointerEvent) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.PointerEvent = MouseEvent as any;
  }
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  if (!globalThis.ResizeObserver) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }
});
afterAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.PointerEvent = OriginalPointerEvent as any;
});

function makeSecret(id: string, overrides: Partial<CompanySecret> = {}): CompanySecret {
  return {
    id,
    companyId: "co",
    key: id,
    name: id.toUpperCase(),
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 3,
    description: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("EnvironmentVariablesEditor", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  function render(node: React.ReactNode) {
    root = createRoot(container);
    flushSync(() => root!.render(node));
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
    vi.restoreAllMocks();
  });

  const secrets = [makeSecret("s1", { name: "GITHUB_TOKEN", latestVersion: 3 })];

  function nameInputs() {
    return [...container.querySelectorAll<HTMLInputElement>('input[aria-label="Variable name"]')];
  }

  it("renders header + a row per binding, no trailing ghost row", () => {
    render(
      <EnvironmentVariablesEditor
        value={{
          NODE_ENV: { type: "plain", value: "production" },
          GH: { type: "secret_ref", secretId: "s1", version: 2 },
        }}
        secrets={secrets}
        onChange={() => {}}
        onCreateSecret={async () => secrets[0]}
      />,
    );
    expect(nameInputs()).toHaveLength(2);
    expect(container.textContent).toContain("Name");
    expect(container.textContent).toContain("Value");
    // Version tag reflects the actual bound version (not a static "latest").
    const versionTag = container.querySelector('button[aria-label="Version"]');
    expect(versionTag?.textContent).toBe("v2");
  });

  it("shows the empty state with no bindings", () => {
    render(<EnvironmentVariablesEditor value={{}} secrets={secrets} onChange={() => {}} onCreateSecret={async () => secrets[0]} />);
    expect(container.textContent).toContain("No environment variables");
    expect(nameInputs()).toHaveLength(0);
  });

  it("appends a row when + Add variable is clicked", async () => {
    render(<EnvironmentVariablesEditor value={{}} secrets={secrets} onChange={() => {}} onCreateSecret={async () => secrets[0]} />);
    const addButton = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add variable"))!;
    addButton.click();
    await flush();
    expect(nameInputs()).toHaveLength(1);
  });

  it("emits plain bindings as the value is edited", async () => {
    const onChange = vi.fn();
    render(<EnvironmentVariablesEditor value={{ FOO: { type: "plain", value: "" } }} secrets={secrets} onChange={onChange} onCreateSecret={async () => secrets[0]} />);
    const valueInput = container.querySelector<HTMLInputElement>('input[aria-label="Variable value"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(valueInput, "bar");
    valueInput.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(onChange).toHaveBeenLastCalledWith({ FOO: { type: "plain", value: "bar" } });
  });

  it("emits undefined when the last binding is removed", async () => {
    const onChange = vi.fn();
    render(<EnvironmentVariablesEditor value={{ FOO: { type: "plain", value: "x" } }} secrets={secrets} onChange={onChange} onCreateSecret={async () => secrets[0]} />);
    const removeButton = container.querySelector<HTMLButtonElement>('button[aria-label^="Remove"]')!;
    removeButton.click();
    await flush();
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("disables inputs in read-only mode", () => {
    render(
      <EnvironmentVariablesEditor
        value={{ FOO: { type: "plain", value: "x" } }}
        secrets={secrets}
        onChange={() => {}}
        onCreateSecret={async () => secrets[0]}
        disabled
      />,
    );
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Variable name"]')!.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Variable value"]')!.disabled).toBe(true);
  });

  it("bulk-imports a dotenv paste into an empty name field", async () => {
    const onChange = vi.fn();
    render(<EnvironmentVariablesEditor value={{}} secrets={secrets} onChange={onChange} onCreateSecret={async () => secrets[0]} />);
    // Add an empty row to paste into.
    const addButton = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add variable"))!;
    addButton.click();
    await flush();
    const nameInput = nameInputs()[0]!;
    const clipboardData = { getData: () => "A=1\nB=2\nC=3" } as unknown as DataTransfer;
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true }) as unknown as ClipboardEvent;
    Object.defineProperty(pasteEvent, "clipboardData", { value: clipboardData });
    nameInput.dispatchEvent(pasteEvent);
    await flush();
    expect(onChange).toHaveBeenLastCalledWith({
      A: { type: "plain", value: "1" },
      B: { type: "plain", value: "2" },
      C: { type: "plain", value: "3" },
    });
  });

  it("auto-detects a sensitive value and offers a value-preserving Store-as-secret popover", async () => {
    // A sensitive KEY (matches the shared regex) surfaces the ShieldAlert
    // affordance and auto-masks the value input (§6.6).
    render(
      <EnvironmentVariablesEditor
        value={{ STRIPE_API_KEY: { type: "plain", value: "supersecretvalue" } }}
        secrets={secrets}
        onChange={() => {}}
        onCreateSecret={async () => secrets[0]}
      />,
    );
    const valueInput = container.querySelector<HTMLInputElement>('input[aria-label="Variable value"]')!;
    expect(valueInput.type).toBe("password"); // auto-masked
    const storeButton = container.querySelector<HTMLButtonElement>('button[title^="This value looks sensitive"]');
    expect(storeButton, "sensitive Store-as-secret affordance should render").toBeTruthy();
    storeButton!.click();
    await flush();
    // The store popover carries the typed value forward (not discarded).
    expect(document.body.textContent).toContain("Store value as secret");
    const secretValueField = document.querySelector<HTMLInputElement>('input[aria-label="Secret value"]');
    expect(secretValueField?.value).toBe("supersecretvalue");
  });

  it("opens the create-secret popover from the picker's + Create item (§6.4, PAP-12476)", async () => {
    // Regression: selecting the picker's `+ Create secret` item closes the
    // combobox popover and (in the same tick) opens the anchored create-secret
    // popover. The two Radix popovers must not race — the create popover has to
    // survive the combobox's focus-return instead of being dismissed instantly.
    render(
      <EnvironmentVariablesEditor
        value={{ GH: { type: "secret_ref", secretId: "s1", version: 2 } }}
        secrets={secrets}
        onChange={() => {}}
        onCreateSecret={async () => secrets[0]}
      />,
    );
    const combobox = container.querySelector<HTMLElement>('[role="combobox"]')!;
    combobox.focus();
    await flush();
    const createItem = [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find((el) =>
      el.textContent?.includes("Create"),
    );
    expect(createItem, "create item should be present in the open picker").toBeTruthy();
    createItem!.click();
    await flush();
    // The create-secret popover is open (heading rendered) and stays open.
    expect(document.body.textContent, "create-secret popover should open").toContain("Create secret");
    expect(
      document.querySelector('input[aria-label="Secret name"]'),
      "create-secret name field should render",
    ).toBeTruthy();
  });

  it("lets the user dismiss the sensitive-value hint, unmasking the value and keeping it plain (§6.6)", async () => {
    const onChange = vi.fn();
    render(
      <EnvironmentVariablesEditor
        value={{ STRIPE_API_KEY: { type: "plain", value: "supersecretvalue" } }}
        secrets={secrets}
        onChange={onChange}
        onCreateSecret={async () => secrets[0]}
      />,
    );
    const valueInput = container.querySelector<HTMLInputElement>('input[aria-label="Variable value"]')!;
    expect(valueInput.type).toBe("password"); // auto-masked while the hint shows

    const dismissButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss sensitive-value suggestion"]',
    );
    expect(dismissButton, "dismiss affordance should render alongside the hint").toBeTruthy();
    dismissButton!.click();
    await flush();

    // Hint + its dismiss control are gone, and the value is no longer masked.
    expect(
      container.querySelector('button[title^="This value looks sensitive"]'),
      "store-as-secret hint should be dismissed",
    ).toBeNull();
    expect(
      container.querySelector('button[aria-label="Dismiss sensitive-value suggestion"]'),
    ).toBeNull();
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Variable value"]')!.type,
    ).toBe("text");

    // Dismissal is a local UI concern — the emitted plain value is unchanged.
    const lastEmit = onChange.mock.calls.at(-1)?.[0];
    if (lastEmit) {
      expect(lastEmit).toEqual({ STRIPE_API_KEY: { type: "plain", value: "supersecretvalue" } });
    }
  });
});
