// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddExistingWorkPicker } from "./AddExistingWorkPicker";

const skillsApi = vi.hoisted(() => ({ list: vi.fn() }));
const responsibilitiesApi = vi.hoisted(() => ({ link: vi.fn() }));
vi.mock("@/api/companySkills", () => ({ companySkillsApi: skillsApi }));
vi.mock("@/api/responsibilities", () => ({ responsibilitiesApi }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SKILL_COUNT = 600;
const FILED_COUNT = 100;

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The filed-skill ids, counting each lookup and failing at once past `limit`. */
class CountedIds extends Set<string> {
  lookups = 0;
  constructor(ids: Iterable<string>, readonly limit: number) {
    super(ids);
  }
  override has(id: string) {
    this.lookups += 1;
    if (this.lookups > this.limit) throw new Error(`linkedIds.has called ${this.lookups} times, past ${this.limit}`);
    return super.has(id);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
  vi.unstubAllGlobals();
});

describe("AddExistingWorkPicker with a company's skills", () => {
  it("lists hundreds of skills without the filed ones, searches them, and does work in proportion", async () => {
    const skills = Array.from({ length: SKILL_COUNT }, (_, index) => ({
      id: `skill-${index}`, name: index % 50 === 0 ? `Interview loop ${index}` : `Skill ${index}`,
    }));
    skillsApi.list.mockResolvedValue(skills);
    // One lookup per skill each time the list is worked out; a memo that misses on every keystroke would blow this.
    const linkedIds = new CountedIds(skills.slice(0, FILED_COUNT).map((skill) => skill.id), SKILL_COUNT * 2);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <AddExistingWorkPicker companyId="company-1" responsibilityId="resp-1" kind="skill" linkedIds={linkedIds} open onOpenChange={vi.fn()} />
        </QueryClientProvider>,
      );
    });
    await flush();

    const items = () => document.body.querySelectorAll('[data-slot="command-item"]');
    expect(items()).toHaveLength(SKILL_COUNT - FILED_COUNT);
    expect(document.body.textContent).not.toContain("Interview loop 0");

    const search = document.body.querySelector<HTMLInputElement>('input[aria-label="Search skills"]')!;
    for (const value of ["I", "In", "Int", "Interview"]) {
      await act(async () => type(search, value));
    }
    await flush();
    // Skills 100, 150, ... 550 match; 0 and 50 are filed already.
    expect([...items()].map((item) => item.textContent)).toEqual(
      skills.filter((skill, index) => index >= FILED_COUNT && skill.name.startsWith("Interview")).map((skill) => skill.name),
    );
    expect(linkedIds.lookups).toBeLessThanOrEqual(SKILL_COUNT * 2);
  });
});
