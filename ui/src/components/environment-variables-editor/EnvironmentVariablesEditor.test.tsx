// @vitest-environment jsdom

import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanySecret, EnvBinding } from "@paperclipai/shared";
import { EnvironmentVariablesEditor } from "./index";
import { SecretPicker } from "./SecretPicker";

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
    scope: "company",
    ownerUserId: null,
    userSecretDefinitionId: null,
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

// Radix DropdownMenu opens/selects on the pointerdown→pointerup sequence, not a
// bare click; drive both so jsdom exercises the real dismissal-layer path.
function pointerClick(el: Element) {
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
  el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }));
  (el as HTMLElement).click();
}

// Deterministic settle for the nested DropdownMenu/combobox → Popover deferred-
// open regression tests. Those flows open the anchored popover from inside a
// closing menu via `window.setTimeout(…, 0)` (PAP-12476/12477/12478). Under real
// timers, jsdom orders the menu's focus-return (a `focusin` that Radix reads as
// `focusOutside` → dismiss) against that deferred open non-deterministically, so
// the popover *sometimes* opens-then-instantly-closes — flaky. `vi.useFakeTimers`
// makes that ordering deterministic (matching the real-browser path where the
// focus-return settles before the macrotask), while still running the deferred
// `setTimeout` — so a *synchronous* (unfixed) open would still be dismissed here.
function settleFakeTimers() {
  flushSync(() => {});
  vi.runAllTimers();
  flushSync(() => {});
}

describe("EnvironmentVariablesEditor", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  function render(node: React.ReactNode) {
    root = createRoot(container);
    flushSync(() => root!.render(node));
  }

  function rerender(node: React.ReactNode) {
    flushSync(() => root!.render(node));
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    // Restore real timers first (the PAP-12478 test swaps in fake timers and may
    // exit without restoring if it throws) so unmount cleanup runs on real timers
    // and gets drained below.
    vi.useRealTimers();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
    // Drain any pending macrotasks (deferred popover-open timers, Radix's
    // focus-restoration timers) so a timer scheduled by this test can't fire
    // mid-way through the next one and dismiss its freshly-opened popover — that
    // cross-test leak is what made the real-timer sibling regression tests flaky.
    await flush();
    for (const child of [...document.body.children]) {
      child.remove();
    }
    document.body.style.pointerEvents = "";
    vi.restoreAllMocks();
  });

  const secrets = [makeSecret("s1", { name: "GITHUB_TOKEN", latestVersion: 3 })];

  function nameInputs() {
    return [...container.querySelectorAll<HTMLInputElement>('input[aria-label="Variable name"]')];
  }

  function saveButton() {
    return [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Save")!;
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

  it("keeps long secret names clear of the latest version control", () => {
    const longSecret = makeSecret("long", {
      name: "/paperclip-cloud/prod/provider/resend/api-key-with-a-very-long-name",
      latestVersion: 4,
    });

    render(
      <EnvironmentVariablesEditor
        value={{
          RESEND_API_KEY: { type: "secret_ref", secretId: "long", version: "latest" },
        }}
        secrets={[longSecret]}
        onChange={() => {}}
        onCreateSecret={async () => longSecret}
      />,
    );

    const combobox = container.querySelector<HTMLElement>('[role="combobox"]')!;
    const selectedLabel = combobox.querySelector<HTMLElement>("[title] span.truncate");
    const versionTag = container.querySelector<HTMLButtonElement>('button[aria-label="Version"]')!;

    expect(versionTag.textContent).toBe("latest");
    expect(combobox.className).toContain("has-[>svg]:!pr-24");
    expect(selectedLabel?.textContent).toBe(longSecret.name);
    expect(selectedLabel?.className).toContain("flex-1");
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

  it("does not emit when + Add variable only creates an empty draft row", async () => {
    const onChange = vi.fn();
    render(<EnvironmentVariablesEditor value={{}} secrets={secrets} onChange={onChange} onCreateSecret={async () => secrets[0]} />);
    const addButton = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add variable"))!;
    addButton.click();
    await flush();
    expect(nameInputs()).toHaveLength(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("saves plain bindings only when Save is clicked", async () => {
    const onChange = vi.fn();
    render(<EnvironmentVariablesEditor value={{ FOO: { type: "plain", value: "" } }} secrets={secrets} onChange={onChange} onCreateSecret={async () => secrets[0]} />);
    const valueInput = container.querySelector<HTMLInputElement>('input[aria-label="Variable value"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(valueInput, "bar");
    valueInput.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Unsaved changes");
    saveButton().click();
    await flush();
    expect(onChange).toHaveBeenLastCalledWith({ FOO: { type: "plain", value: "bar" } });
  });

  it("flushes unsaved editor changes before an enclosing form submits", async () => {
    const submittedValues: Array<Record<string, EnvBinding> | undefined> = [];

    function FormHarness() {
      const [value, setValue] = useState<Record<string, EnvBinding>>({
        FOO: { type: "plain", value: "" },
      });
      return (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submittedValues.push(value);
          }}
        >
          <EnvironmentVariablesEditor
            value={value}
            secrets={secrets}
            onChange={(next) => setValue(next ?? {})}
            onCreateSecret={async () => secrets[0]}
          />
          <button type="submit">Outer save</button>
        </form>
      );
    }

    render(<FormHarness />);
    const valueInput = container.querySelector<HTMLInputElement>('input[aria-label="Variable value"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(valueInput, "bar");
    valueInput.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();

    const outerSave = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Outer save"),
    )!;
    outerSave.click();
    await flush();

    expect(submittedValues).toEqual([{ FOO: { type: "plain", value: "bar" } }]);
  });

  it("flushes unsaved editor changes before an external save button reads parent state", async () => {
    const savedValues: Array<Record<string, EnvBinding>> = [];

    function SaveButtonHarness() {
      const [value, setValue] = useState<Record<string, EnvBinding>>({
        FOO: { type: "plain", value: "" },
      });
      return (
        <div>
          <EnvironmentVariablesEditor
            value={value}
            secrets={secrets}
            onChange={(next) => setValue(next ?? {})}
            onCreateSecret={async () => secrets[0]}
          />
          <button type="button" onClick={() => savedValues.push(value)}>
            Save settings
          </button>
        </div>
      );
    }

    render(<SaveButtonHarness />);
    const valueInput = container.querySelector<HTMLInputElement>('input[aria-label="Variable value"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(valueInput, "bar");
    valueInput.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();

    const outerSave = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Save settings"),
    )!;
    outerSave.click();
    await flush();

    expect(savedValues).toEqual([{ FOO: { type: "plain", value: "bar" } }]);
  });

  it("makes unsaved fields and save controls prominent while editing", async () => {
    render(<EnvironmentVariablesEditor value={{ FOO: { type: "plain", value: "" } }} secrets={secrets} onChange={() => {}} onCreateSecret={async () => secrets[0]} />);
    const valueInput = container.querySelector<HTMLInputElement>('input[aria-label="Variable value"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(valueInput, "bar");
    valueInput.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();

    const unsavedBar = [...container.querySelectorAll<HTMLElement>('[role="status"]')].find((node) =>
      node.textContent?.includes("Unsaved changes"),
    );
    const valueCell = valueInput.closest<HTMLDivElement>(".relative.flex");
    const save = saveButton();
    const revert = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Revert")!;

    expect(unsavedBar?.className).toContain("bg-amber-500/10");
    expect(valueCell?.className).toContain("border-amber-500/70");
    expect(save.className).toContain("h-9");
    expect(save.className).toContain("px-4");
    expect(revert.className).toContain("h-9");
  });

  it("marks a newly typed variable name as unsaved before saving", async () => {
    render(<EnvironmentVariablesEditor value={{}} secrets={secrets} onChange={() => {}} onCreateSecret={async () => secrets[0]} />);
    const addButton = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add variable"))!;
    addButton.click();
    await flush();

    const nameInput = nameInputs()[0]!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(nameInput, "API_TOKEN");
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();

    expect(nameInput.className).toContain("border-amber-500/70");
    expect(container.textContent).toContain("Unsaved changes");
  });

  it("does not emit or remount while typing a new variable before manual save", async () => {
    const onChange = vi.fn();
    const savedValue: Record<string, EnvBinding> = {
      ZED: { type: "plain", value: "z" },
      ALPHA: { type: "plain", value: "a" },
    };
    render(
      <EnvironmentVariablesEditor
        value={savedValue}
        secrets={secrets}
        onChange={onChange}
        onCreateSecret={async () => secrets[0]}
      />,
    );
    const addButton = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add variable"))!;
    addButton.click();
    await flush();

    const newNameInput = nameInputs().at(-1)!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(newNameInput, "ca");
    newNameInput.dispatchEvent(new Event("input", { bubbles: true }));
    newNameInput.focus();
    await flush();

    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(newNameInput);

    rerender(
      <EnvironmentVariablesEditor
        value={savedValue}
        secrets={secrets}
        onChange={onChange}
        onCreateSecret={async () => secrets[0]}
      />,
    );
    await flush();

    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(newNameInput);
    expect(nameInputs().at(-1)).toBe(newNameInput);

    setter.call(newNameInput, "carol");
    newNameInput.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(onChange).not.toHaveBeenCalled();

    saveButton().click();
    await flush();
    expect(onChange).toHaveBeenLastCalledWith({
      ZED: { type: "plain", value: "z" },
      ALPHA: { type: "plain", value: "a" },
      carol: { type: "plain", value: "" },
    });
  });

  it("keeps the active row mounted when a manual save echo returns an equivalent value", async () => {
    const onChange = vi.fn();
    const emptyValue: Record<string, EnvBinding> = {};
    const savedValue: Record<string, EnvBinding> = { API_TOKEN: { type: "plain", value: "secret-value" } };
    render(
      <EnvironmentVariablesEditor
        value={emptyValue}
        secrets={secrets}
        onChange={onChange}
        onCreateSecret={async () => secrets[0]}
      />,
    );
    const addButton = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add variable"))!;
    addButton.click();
    await flush();

    const [nameInput] = nameInputs();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(nameInput, "API_TOKEN");
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();

    const valueInput = container.querySelector<HTMLInputElement>('input[aria-label="Variable value"]')!;
    setter.call(valueInput, "secret-value");
    valueInput.dispatchEvent(new Event("input", { bubbles: true }));
    valueInput.focus();
    await flush();
    expect(document.activeElement).toBe(valueInput);
    expect(onChange).not.toHaveBeenCalled();
    saveButton().click();
    await flush();
    expect(onChange).toHaveBeenLastCalledWith(savedValue);

    rerender(
      <EnvironmentVariablesEditor
        value={{ API_TOKEN: { type: "plain", value: "secret-value" } }}
        secrets={secrets}
        onChange={onChange}
        onCreateSecret={async () => secrets[0]}
      />,
    );
    await flush();

    expect(document.activeElement).toBe(valueInput);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Variable value"]')).toBe(valueInput);
  });

  it("emits undefined when the last binding is removed", async () => {
    const onChange = vi.fn();
    render(<EnvironmentVariablesEditor value={{ FOO: { type: "plain", value: "x" } }} secrets={secrets} onChange={onChange} onCreateSecret={async () => secrets[0]} />);
    const removeButton = container.querySelector<HTMLButtonElement>('button[aria-label^="Remove"]')!;
    removeButton.click();
    await flush();
    expect(onChange).not.toHaveBeenCalled();
    saveButton().click();
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

  it("renders name warnings as a row spanning the name and value columns", () => {
    render(
      <EnvironmentVariablesEditor
        value={{ PAPERCLIP_PAGE_BASE_URL: { type: "plain", value: "https://pages.paperclip.ing" } }}
        secrets={secrets}
        onChange={() => {}}
        onCreateSecret={async () => secrets[0]}
      />,
    );

    const nameInput = container.querySelector<HTMLInputElement>('input[aria-label="Variable name"]')!;
    const warning = [...container.querySelectorAll<HTMLParagraphElement>("p")].find((node) =>
      node.textContent?.includes("Reserved prefix"),
    );

    expect(warning, "reserved-prefix warning should render").toBeTruthy();
    expect(nameInput.getAttribute("aria-describedby")).toBe(warning!.id);
    expect(warning!.parentElement?.contains(nameInput), "warning should stay in the row grid").toBe(true);
    expect(warning!.parentElement).not.toBe(nameInput.parentElement);
    expect(warning!.className).toContain("col-span-2");
    expect(warning!.className).toContain("@[40rem]/env:row-start-2");
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
    expect(onChange).not.toHaveBeenCalled();
    saveButton().click();
    await flush();
    expect(onChange).toHaveBeenLastCalledWith({
      A: { type: "plain", value: "1" },
      B: { type: "plain", value: "2" },
      C: { type: "plain", value: "3" },
    });
  });

  it("bulk-imports dotenv updates without mutating the committed row baseline", async () => {
    render(
      <EnvironmentVariablesEditor
        value={{ A: { type: "plain", value: "old" } }}
        secrets={secrets}
        onChange={() => {}}
        onCreateSecret={async () => secrets[0]}
      />,
    );
    const addButton = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Add variable"),
    )!;
    addButton.click();
    await flush();

    const targetNameInput = nameInputs().at(-1)!;
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true }) as unknown as ClipboardEvent;
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: { getData: () => "A=new" } as unknown as DataTransfer,
    });
    targetNameInput.dispatchEvent(pasteEvent);
    await flush();

    const valueInput = container.querySelector<HTMLInputElement>('input[aria-label="Variable value"]')!;
    const valueCell = valueInput.closest<HTMLDivElement>(".relative.flex");
    expect(valueInput.value).toBe("new");
    expect(valueCell?.className).toContain("border-amber-500/70");
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

  it("keeps the create-secret popover open when focus returns to a control inside the value cell (§6.4, PAP-12492)", async () => {
    // Regression for the *fragile* part of the picker → create transition.
    // The picker's combobox and the anchored create popover share the value
    // cell as their anchor. When the picker tears down, Radix returns focus to
    // the combobox trigger *inside* that anchor — and because the anchor sits
    // outside the create popover's content, Radix reads that focus-return as a
    // `focusOutside` and dismisses the just-opened create popover. The picker's
    // close animation can delay that focus-return past the `setTimeout(0)` open
    // defer, so a timing-based fix is not enough; the popover must survive an
    // in-anchor focus-return whenever it lands. jsdom does not reproduce the
    // animation-delayed focus-return on its own, so we drive it explicitly:
    // open the create popover, then fire a late `focusin` on an in-anchor
    // control and assert the popover is still open.
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
    expect(document.body.textContent, "create-secret popover should open").toContain("Create secret");

    // Simulate the picker's animation-delayed focus-return landing on a control
    // that lives inside the value cell (the source-switch trigger is a stable
    // in-anchor target that doesn't reopen the picker). Moving focus fires a
    // blur off the create popover's content (flipping Radix's "focus inside"
    // flag) and then a focusin on the in-anchor control — exactly the sequence
    // Radix reads as a `focusOutside`. Without the guard this dismisses the
    // create popover; with it, the popover survives.
    const sourceButton = container.querySelector<HTMLElement>('button[aria-label="Value source"]')!;
    expect(sourceButton, "in-anchor Value source control should exist").toBeTruthy();
    sourceButton.focus();
    await flush();

    expect(
      document.body.textContent,
      "create-secret popover must survive the in-anchor focus-return",
    ).toContain("Create secret");
    expect(
      document.querySelector('input[aria-label="Secret name"]'),
      "create-secret name field should still render",
    ).toBeTruthy();
  });

  it("opens the store-as-secret popover from the ⋯ overflow menu (PAP-12477)", async () => {
    // Regression: the ⋯ overflow → "Store as secret…" item is the same nested
    // shape as the picker's + Create item — a DropdownMenu whose onSelect opens
    // the row's anchored Popover. The menu closing returns focus to its trigger
    // (which lives outside the Popover), which must not land as a focusOutside
    // that dismisses the just-opened popover. A non-sensitive text row surfaces
    // the ⋯ menu (the sensitive-value inline button is a separate path).
    render(
      <EnvironmentVariablesEditor
        value={{ API_BASE_URL: { type: "plain", value: "https://example.com" } }}
        secrets={secrets}
        onChange={() => {}}
        onCreateSecret={async () => secrets[0]}
      />,
    );
    // The value is non-sensitive, so no inline Store-as-secret button — only ⋯.
    expect(container.querySelector('button[title^="This value looks sensitive"]')).toBeNull();
    const overflow = container.querySelector<HTMLButtonElement>('button[aria-label="More actions"]');
    expect(overflow, "⋯ overflow menu should render for a non-sensitive text row").toBeTruthy();
    pointerClick(overflow!);
    await flush();
    const storeItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes("Store as secret"),
    );
    expect(storeItem, "Store as secret… menu item should be present").toBeTruthy();
    pointerClick(storeItem!);
    await flush();
    // The store popover is open (heading rendered) and stays open — it must not
    // be dismissed by the menu's focus-return.
    expect(document.body.textContent, "store-as-secret popover should open").toContain(
      "Store value as secret",
    );
    expect(
      document.querySelector('input[aria-label="Secret value"]'),
      "store-as-secret value field should render",
    ).toBeTruthy();
  });

  it("opens the store popover from the source dropdown Text→Company secret (with a value) and keeps it open (PAP-12478)", () => {
    // Regression: switching a *non-empty* Text row to "Company secret" via the
    // in-field Value source dropdown must open the anchored store-as-secret
    // popover (§6.3) — value preserved, not discarded. This is the same nested
    // DropdownMenu→Popover open-while-closing race as the ⋯ and picker paths
    // (PAP-12476/12477): opening the popover synchronously inside the menu-item's
    // onSelect lets the menu's focus-return dismiss it in the same tick. With a
    // *synchronous* open this assertion fails; with the deferred open it passes.
    vi.useFakeTimers();
    render(
      <EnvironmentVariablesEditor
        value={{ NODE_ENV: { type: "plain", value: "production" } }}
        secrets={secrets}
        onChange={() => {}}
        onCreateSecret={async () => secrets[0]}
      />,
    );
    const sourceButton = container.querySelector<HTMLButtonElement>('button[aria-label="Value source"]');
    expect(sourceButton, "Value source dropdown should render").toBeTruthy();
    pointerClick(sourceButton!);
    settleFakeTimers();
    const secretItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes("Company secret"),
    );
    expect(secretItem, "Company secret menu item should be present").toBeTruthy();
    pointerClick(secretItem!);
    settleFakeTimers();
    // The store popover is open (heading rendered) and stays open — it must not
    // be dismissed by the menu's focus-return.
    expect(document.body.textContent, "store-as-secret popover should open").toContain(
      "Store value as secret",
    );
    // The current value is carried forward (masked), not discarded.
    const secretValueField = document.querySelector<HTMLInputElement>('input[aria-label="Secret value"]');
    expect(secretValueField, "store-as-secret value field should render").toBeTruthy();
    expect(secretValueField!.value).toBe("production");
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

  it("lets slash-delimited secrets be browsed by folder and exposes full paths on hover", async () => {
    const cloudProviderKey = "/paperclip-cloud/prod/provider/aws-access-key-id";
    const cloudMigrationKey = "/paperclip-cloud/prod/migration/postgres-url";
    const onSelect = vi.fn();
    render(
      <SecretPicker
        secretId=""
        secrets={[
          makeSecret("provider-key", { name: cloudProviderKey, key: cloudProviderKey }),
          makeSecret("migration-key", { name: cloudMigrationKey, key: cloudMigrationKey }),
          makeSecret("plain-key", { name: "paperclip-page-aws-access-key-id", key: "paperclip-page-aws-access-key-id" }),
        ]}
        onSelect={onSelect}
        onCreateNew={() => {}}
        disablePortal
      />,
    );

    const combobox = container.querySelector<HTMLElement>('[role="combobox"]')!;
    combobox.focus();
    await flush();

    const itemByText = (text: string) =>
      [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find((el) =>
        el.textContent?.includes(text),
      );
    const rowTitle = (item: HTMLElement | undefined) => item?.querySelector<HTMLElement>("[title]")?.getAttribute("title");

    expect(rowTitle(itemByText("paperclip-cloud"))).toBe("/paperclip-cloud");
    expect(rowTitle(itemByText("paperclip-page-aws-access-key-id"))).toBe(
      "paperclip-page-aws-access-key-id",
    );

    itemByText("paperclip-cloud")!.click();
    await flush();
    expect(rowTitle(itemByText("prod"))).toBe("/paperclip-cloud/prod");

    itemByText("prod")!.click();
    await flush();
    expect(rowTitle(itemByText("provider"))).toBe("/paperclip-cloud/prod/provider");
    expect(rowTitle(itemByText("migration"))).toBe("/paperclip-cloud/prod/migration");

    itemByText("provider")!.click();
    await flush();
    const leaf = itemByText("aws-access-key-id");
    expect(rowTitle(leaf)).toBe(cloudProviderKey);

    leaf!.click();
    await flush();
    expect(onSelect).toHaveBeenCalledWith("provider-key");
  });

  it("keeps secret search global while browsing starts at slash folders", async () => {
    const cloudMigrationKey = "/paperclip-cloud/prod/migration/postgres-url";
    render(
      <SecretPicker
        secretId=""
        secrets={[
          makeSecret("provider-key", {
            name: "/paperclip-cloud/prod/provider/aws-access-key-id",
            key: "/paperclip-cloud/prod/provider/aws-access-key-id",
          }),
          makeSecret("migration-key", { name: cloudMigrationKey, key: cloudMigrationKey }),
        ]}
        onSelect={() => {}}
        onCreateNew={() => {}}
        disablePortal
      />,
    );

    const combobox = container.querySelector<HTMLElement>('[role="combobox"]')!;
    combobox.focus();
    await flush();
    expect(document.body.textContent).toContain("paperclip-cloud");
    expect(document.body.textContent).not.toContain("postgres-url");

    const search = document.querySelector<HTMLInputElement>('input[placeholder="Search secrets…"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(search, "postgres");
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();

    const match = [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find((el) =>
      el.textContent?.includes(cloudMigrationKey),
    );
    expect(match?.querySelector<HTMLElement>("[title]")?.getAttribute("title")).toBe(cloudMigrationKey);
  });
});
