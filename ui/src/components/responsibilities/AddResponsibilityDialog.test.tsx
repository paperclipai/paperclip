// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { areaFundraising, areaPortfolio, fundraisingBehind } from "../../../storybook/fixtures/responsibilities";
import { AddResponsibilityDialog } from "./AddResponsibilityDialog";

const api = vi.hoisted(() => ({ create: vi.fn() }));
const areasApi = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/api/responsibilities", () => ({ responsibilitiesApi: api, responsibilityAreasApi: areasApi }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]')!;
const field = (label: string) =>
  [...dialog().querySelectorAll("label")].find((node) => node.querySelector("span")?.textContent?.startsWith(label))!
    .querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select")!;
const submit = () => [...dialog().querySelectorAll("button")].find((button) => button.textContent === "Add responsibility")!;

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function choose(select: HTMLSelectElement, value: string) {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

async function render(defaultAreaId: string | null = null, onOpenChange = vi.fn()) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <AddResponsibilityDialog
          open
          onOpenChange={onOpenChange}
          companyId="company-storybook"
          areas={[areaFundraising, areaPortfolio]}
          defaultAreaId={defaultAreaId}
        />
      </QueryClientProvider>,
    );
  });
  return onOpenChange;
}

async function fillRequired() {
  await act(async () => {
    type(field("What do you own?") as HTMLInputElement, "LP updates");
    type(field("The bar") as HTMLTextAreaElement, "Every LP hears from us monthly.");
    type(field("What you measure") as HTMLInputElement, "Days since the last letter");
    type(field("Target") as HTMLInputElement, "30");
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

describe("AddResponsibilityDialog", () => {
  it("says which required fields are missing and sends nothing", async () => {
    await render();
    await act(async () => submit().click());
    expect(api.create).not.toHaveBeenCalled();
    const text = dialog().textContent;
    expect(text).toContain("Name what you own");
    expect(text).toContain("Describe the bar");
    expect(text).toContain("Name what you measure");
    expect(text).toContain("Set a target");
  });

  it("creates it under the chosen area with direction, unit and a current reading", async () => {
    api.create.mockResolvedValue(fundraisingBehind);
    const onOpenChange = await render(areaFundraising.id);
    expect((field("Area") as HTMLSelectElement).value).toBe(areaFundraising.id);
    await fillRequired();
    await act(async () => {
      choose(field("Better when it is") as HTMLSelectElement, "at_most");
      type(field("Unit") as HTMLInputElement, "days");
      type(field("Where it is now") as HTMLInputElement, "36");
    });
    await act(async () => submit().click());
    await flush();
    expect(areasApi.create).not.toHaveBeenCalled();
    expect(api.create).toHaveBeenCalledExactlyOnceWith("company-storybook", {
      title: "LP updates",
      standard: "Every LP hears from us monthly.",
      metricKind: "volume",
      metricName: "Days since the last letter",
      metricTarget: 30,
      metricDirection: "at_most",
      metricUnit: "days",
      metricCurrent: 36,
      areaId: areaFundraising.id,
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("creates a new area first when asked, and files it there", async () => {
    areasApi.create.mockResolvedValue({ ...areaFundraising, id: "area-new", title: "Investor relations" });
    api.create.mockResolvedValue(fundraisingBehind);
    await render();
    await fillRequired();
    await act(async () => choose(field("Area") as HTMLSelectElement, "__new__"));
    const newArea = dialog().querySelector<HTMLInputElement>('input[aria-label="New area name"]')!;
    await act(async () => submit().click());
    expect(dialog().textContent).toContain("Name the new area");
    expect(api.create).not.toHaveBeenCalled();
    await act(async () => type(newArea, "Investor relations"));
    await act(async () => submit().click());
    await flush();
    expect(areasApi.create).toHaveBeenCalledExactlyOnceWith("company-storybook", { title: "Investor relations" });
    expect(api.create.mock.calls[0]![1]).toMatchObject({ areaId: "area-new" });
  });

  it("marks the fields the server says are missing (422)", async () => {
    api.create.mockRejectedValue(new ApiError("refused", 422, {
      error: "A responsibility needs its bar (standard), a metric name and a target before it can be active",
      details: { missing: ["standard"] },
    }));
    await render();
    await fillRequired();
    await act(async () => submit().click());
    await flush();
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("Couldn’t add the responsibility.");
    expect(field("The bar").getAttribute("aria-invalid")).toBe("true");
  });
});
