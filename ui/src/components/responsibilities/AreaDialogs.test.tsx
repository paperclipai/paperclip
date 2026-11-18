// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { areaFundraising } from "../../../storybook/fixtures/responsibilities";
import { AddAreaDialog, ArchiveAreaDialog, RenameAreaDialog } from "./AreaDialogs";

const areasApi = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), list: vi.fn() }));
vi.mock("@/api/responsibilities", () => ({ responsibilitiesApi: {}, responsibilityAreasApi: areasApi }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]')!;
const button = (label: string) => [...dialog().querySelectorAll("button")].find((candidate) => candidate.textContent === label)!;

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function render(element: ReactElement) {
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});

describe("area dialogs", () => {
  it("adds an area by name and hands it back", async () => {
    areasApi.create.mockResolvedValue(areaFundraising);
    const onCreated = vi.fn();
    await render(<AddAreaDialog open onOpenChange={vi.fn()} companyId="company-storybook" onCreated={onCreated} />);
    expect(dialog().textContent).toContain("What do you care about?");
    await act(async () => type(dialog().querySelector("input")!, " Fundraising "));
    await act(async () => button("Add area").click());
    await flush();
    expect(areasApi.create).toHaveBeenCalledExactlyOnceWith("company-storybook", { title: "Fundraising" });
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(areaFundraising);
  });

  it("renames an area and shows the server's reason when the name is taken", async () => {
    areasApi.update.mockRejectedValue(new ApiError('Another area is already called "Portfolio"', 409, {
      error: 'Another area is already called "Portfolio"',
    }));
    await render(<RenameAreaDialog area={areaFundraising} onOpenChange={vi.fn()} />);
    const input = dialog().querySelector("input")!;
    expect(input.value).toBe("Fundraising");
    await act(async () => type(input, "Portfolio"));
    await act(async () => button("Save name").click());
    await flush();
    expect(areasApi.update).toHaveBeenCalledExactlyOnceWith(areaFundraising.id, { title: "Portfolio" });
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('Another area is already called "Portfolio"');
  });

  it("archives an area after saying what happens to what is in it", async () => {
    areasApi.update.mockResolvedValue({ ...areaFundraising, status: "archived" });
    const onOpenChange = vi.fn();
    await render(<ArchiveAreaDialog area={areaFundraising} ownedHere={2} onOpenChange={onOpenChange} />);
    expect(dialog().textContent).toContain("Archive Fundraising?");
    expect(dialog().textContent).toContain("Your 2 responsibilities in it stay there until you move them to another area.");
    await act(async () => button("Archive area").click());
    await flush();
    expect(areasApi.update).toHaveBeenCalledExactlyOnceWith(areaFundraising.id, { status: "archived" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
