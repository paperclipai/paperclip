// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CompanySkillDetail } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillStudio } from "./SkillStudio";

const routeState = vi.hoisted(() => ({
  pathname: "/skills/studio/new",
  search: "",
  skillId: "new" as string | undefined,
}));

const mockNavigate = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

const mockCompanySkillsApi = vi.hoisted(() => ({
  list: vi.fn(),
  detail: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname: routeState.pathname, search: routeState.search, hash: "" }),
  useNavigate: () => mockNavigate,
  useParams: () => ({ skillId: routeState.skillId }),
  useSearchParams: () => [new URLSearchParams(routeState.search), vi.fn()],
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("@/api/companySkills", () => ({
  companySkillsApi: mockCompanySkillsApi,
}));

vi.mock("@/components/SearchableSelect", () => ({
  SearchableSelect: ({
    placeholder,
    renderValue,
  }: {
    placeholder: string;
    renderValue?: (option: null) => ReactNode;
  }) => <button type="button">{renderValue ? renderValue(null) : placeholder}</button>,
}));

vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: ({ value }: { value: string }) => <textarea readOnly value={value} />,
}));

vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("./CompanySkills", () => ({
  SkillCardIcon: ({ card }: { card: { name: string } }) => (
    <div data-testid="skill-card-icon">{card.name}</div>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flushReact();
    }
  }
  throw lastError;
}

async function renderStudio() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <SkillStudio />
      </QueryClientProvider>,
    );
  });

  return container;
}

async function inputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function makeSkill(overrides: Partial<CompanySkillDetail> = {}): CompanySkillDetail {
  return {
    id: "source-skill",
    companyId: "company-1",
    key: "paperclip/demo-skill",
    slug: "demo-skill",
    name: "Demo Skill",
    description: "A demo skill.",
    markdown: "---\nname: Demo Skill\ndescription: Existing\n---\n\n# Demo Skill\n",
    sourceType: "local_path",
    sourceLocator: null,
    sourceRef: null,
    trustLevel: "markdown_only",
    compatibility: "compatible",
    fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    iconUrl: null,
    color: null,
    tagline: "Existing tagline",
    authorName: null,
    homepageUrl: null,
    categories: ["engineering"],
    sharingScope: "company",
    publicShareToken: null,
    forkedFromSkillId: null,
    forkedFromCompanyId: null,
    starCount: 0,
    installCount: 0,
    forkCount: 0,
    currentVersionId: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    attachedAgentCount: 0,
    usedByAgents: [],
    editable: true,
    editableReason: null,
    sourceLabel: "Local",
    sourceBadge: "local",
    sourcePath: null,
    currentVersion: null,
    starredByCurrentActor: false,
    ...overrides,
  };
}

function buttonsNamed(node: ParentNode, name: string) {
  return Array.from(node.querySelectorAll("button")).filter((button) =>
    button.textContent?.trim() === name,
  );
}

beforeEach(() => {
  routeState.pathname = "/skills/studio/new";
  routeState.search = "";
  routeState.skillId = "new";
  mockNavigate.mockReset();
  mockSetBreadcrumbs.mockReset();
  mockCompanySkillsApi.list.mockResolvedValue([]);
  mockCompanySkillsApi.detail.mockResolvedValue(makeSkill());
  mockCompanySkillsApi.create.mockResolvedValue({
    id: "created-skill",
    name: "Code Review",
    forkedFromSkillId: null,
  });
});

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("SkillStudio create mode", () => {
  it("renders /skills/studio/new as create mode instead of loading skill id new", async () => {
    const node = await renderStudio();

    await waitFor(() => expect(node.textContent).toContain("Create a new skill"));

    expect(node.textContent).not.toContain("Skill not found.");
    expect(mockCompanySkillsApi.detail).not.toHaveBeenCalledWith("company-1", "new");
    expect(mockSetBreadcrumbs).toHaveBeenCalledWith([
      { label: "Skills", href: "/skills" },
      { label: "Studio", href: "/skills/studio" },
      { label: "New skill" },
    ]);
  });

  it("prefills fork drafts from the forkFrom query param", async () => {
    routeState.search = "?forkFrom=source-skill";

    const node = await renderStudio();

    await waitFor(() => expect(node.textContent).toContain("Forking Demo Skill"));

    expect(mockCompanySkillsApi.detail).toHaveBeenCalledWith("company-1", "source-skill");
    expect((node.querySelector("#skill-name") as HTMLInputElement).value).toBe("Demo Skill Fork");
    expect((node.querySelector("#skill-slug") as HTMLInputElement).value).toBe("demo-skill-fork");
  });

  it("creates a skill and navigates to the Studio editor for the new id", async () => {
    const node = await renderStudio();

    await waitFor(() => expect(node.querySelector("#skill-name")).toBeTruthy());
    await inputValue(node.querySelector("#skill-name") as HTMLInputElement, "Code Review");
    await click(buttonsNamed(node, "Create skill")[0] as HTMLButtonElement);

    await waitFor(() => expect(mockCompanySkillsApi.create).toHaveBeenCalled());

    expect(mockCompanySkillsApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        name: "Code Review",
        slug: "code-review",
        sharingScope: "company",
        forkedFromSkillId: null,
      }),
    );
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/skills/studio/created-skill"));
  });
});
