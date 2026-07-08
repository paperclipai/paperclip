// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { CompanySkillDetail, CompanySkillVersion } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillDetailPage, getSkillVersionDiffSelection } from "./CompanySkills";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    type = "button",
    variant: _variant,
    size: _size,
    asChild: _asChild,
    ...props
  }: ComponentProps<"button"> & { asChild?: boolean; variant?: string; size?: string }) => (
    <button type={type} {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open?: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: () => null,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button type="button" onClick={onSelect}>{children}</button>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button type="button" onClick={onSelect}>{children}</button>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: () => null,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
}));

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: (props: ComponentProps<"input">) => <input type="checkbox" {...props} />,
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: ({ value }: { value: string }) => <textarea readOnly value={value} />,
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

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
});

function makeVersion(revisionNumber: number, content: string): CompanySkillVersion {
  return {
    id: `version-${revisionNumber}`,
    companyId: "company-1",
    companySkillId: "skill-1",
    revisionNumber,
    label: null,
    fileInventory: [
      {
        path: "SKILL.md",
        kind: "skill",
        content,
      },
    ],
    authorAgentId: null,
    authorUserId: null,
    createdAt: new Date(`2026-01-0${revisionNumber}T00:00:00Z`),
  };
}

function makeDetail(currentVersion: CompanySkillVersion, overrides: Partial<CompanySkillDetail> = {}): CompanySkillDetail {
  return {
    id: "skill-1",
    companyId: "company-1",
    key: "demo-skill",
    slug: "demo-skill",
    name: "Demo Skill",
    description: "A demo skill.",
    markdown: "# Demo Skill",
    sourceType: "local_path",
    sourceLocator: null,
    sourceRef: null,
    trustLevel: "markdown_only",
    compatibility: "compatible",
    fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    iconUrl: null,
    color: null,
    tagline: null,
    authorName: null,
    homepageUrl: null,
    categories: [],
    sharingScope: "private",
    publicShareToken: null,
    forkedFromSkillId: null,
    forkedFromCompanyId: null,
    starCount: 0,
    installCount: 0,
    forkCount: 0,
    currentVersionId: currentVersion.id,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    attachedAgentCount: 0,
    usedByAgents: [],
    existingForks: [],
    editable: true,
    editableReason: null,
    sourceLabel: "Local",
    sourceBadge: "local",
    sourcePath: null,
    currentVersion,
    starredByCurrentActor: false,
    ...overrides,
  };
}

async function renderSkillDetail(
  versions: CompanySkillVersion[],
  props: Partial<ComponentProps<typeof SkillDetailPage>> = {},
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const detail = props.detail ?? makeDetail(versions[0]!);

  await act(async () => {
    root?.render(
      <SkillDetailPage
        detail={detail}
        loading={false}
        activeTab={props.activeTab ?? "versions"}
        onTabChange={vi.fn()}
        selectedPath="SKILL.md"
        file={null}
        fileLoading={false}
        viewMode="preview"
        editMode={false}
        draft=""
        setViewMode={vi.fn()}
        setEditMode={vi.fn()}
        setDraft={vi.fn()}
        onSave={vi.fn()}
        savePending={false}
        versions={versions}
        versionsLoading={false}
        attachAgents={[]}
        onSubmitAttach={vi.fn()}
        attachPending={false}
        expandedDirs={new Set()}
        onToggleDir={vi.fn()}
        onSelectPath={vi.fn()}
        updateStatus={null}
        updateStatusLoading={false}
        onCheckUpdates={vi.fn()}
        checkUpdatesPending={false}
        onInstallUpdate={vi.fn()}
        installUpdatePending={false}
        onToggleStar={vi.fn()}
        starPending={false}
        onFork={vi.fn()}
        onUpdateSettings={vi.fn()}
        updateSettingsPending={false}
        onDelete={vi.fn()}
        deletePending={false}
        {...props}
      />,
    );
  });

  return container;
}

function buttonsNamed(node: ParentNode, name: string) {
  return Array.from(node.querySelectorAll("button")).filter((button) => button.textContent?.trim() === name);
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function inputValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function selectValue(select: HTMLSelectElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("getSkillVersionDiffSelection", () => {
  it("selects the previous saved revision or the initial baseline for row diffs", () => {
    const v1 = makeVersion(1, "first");
    const v2 = makeVersion(2, "second");

    expect(getSkillVersionDiffSelection([v2, v1], v2.id)).toEqual({
      leftVersionId: v1.id,
      rightVersionId: v2.id,
    });
    expect(getSkillVersionDiffSelection([v2, v1], v1.id)).toEqual({
      leftVersionId: null,
      rightVersionId: v1.id,
    });
  });
});

describe("SkillDetailPage versions tab", () => {
  it("opens per-row version diffs for newest and oldest revisions", async () => {
    const v1 = makeVersion(1, "# Demo Skill\n\nFirst line");
    const v2 = makeVersion(2, "# Demo Skill\n\nSecond line");
    const node = await renderSkillDetail([v2, v1]);
    const viewDiffButtons = buttonsNamed(node, "View diff") as HTMLButtonElement[];

    expect(viewDiffButtons).toHaveLength(2);

    await click(viewDiffButtons[0]!);
    let dialog = node.querySelector('[role="dialog"]') as HTMLElement;
    let selects = Array.from(dialog.querySelectorAll("select"));

    expect(dialog.textContent).toContain("Diff");
    expect(selects[0]?.value).toBe(v1.id);
    expect(selects[1]?.value).toBe(v2.id);
    expect(dialog.textContent).toContain("Second line");

    await click(viewDiffButtons[1]!);
    dialog = node.querySelector('[role="dialog"]') as HTMLElement;
    selects = Array.from(dialog.querySelectorAll("select"));

    expect(selects[0]?.value).toBe("");
    expect(selects[1]?.value).toBe(v1.id);
    expect(dialog.textContent).toContain("Initial");
    expect(dialog.textContent).toContain("First line");
    expect(dialog.textContent).not.toContain("Both sides are the same version");
  });
});

describe("SkillDetailPage settings", () => {
  it("saves normalized category edits from the settings dialog", async () => {
    const v1 = makeVersion(1, "# Demo Skill");
    const onUpdateSettings = vi.fn();
    const node = await renderSkillDetail([v1], {
      activeTab: "overview",
      detail: makeDetail(v1, {
        categories: ["engineering"],
        sharingScope: "company",
      }),
      onUpdateSettings,
    });

    await click(buttonsNamed(node, "Settings")[0] as HTMLButtonElement);
    const dialog = node.querySelector('[role="dialog"]') as HTMLElement;
    const categoryInput = dialog.querySelector("input") as HTMLInputElement;
    const saveButton = buttonsNamed(dialog, "Save settings")[0] as HTMLButtonElement;

    expect(categoryInput.value).toBe("engineering");

    await inputValue(categoryInput, " Memory, review, memory ,,");
    await click(saveButton);

    expect(onUpdateSettings).toHaveBeenCalledWith({
      sharingScope: "company",
      categories: ["memory", "review"],
    });
  });

  it("allows clearing categories and saving sharing together", async () => {
    const v1 = makeVersion(1, "# Demo Skill");
    const onUpdateSettings = vi.fn();
    const node = await renderSkillDetail([v1], {
      activeTab: "overview",
      detail: makeDetail(v1, {
        categories: ["engineering"],
        sharingScope: "company",
      }),
      onUpdateSettings,
    });

    await click(buttonsNamed(node, "Settings")[0] as HTMLButtonElement);
    const dialog = node.querySelector('[role="dialog"]') as HTMLElement;

    await inputValue(dialog.querySelector("input") as HTMLInputElement, "");
    await selectValue(dialog.querySelector("select") as HTMLSelectElement, "private");
    await click(buttonsNamed(dialog, "Save settings")[0] as HTMLButtonElement);

    expect(onUpdateSettings).toHaveBeenCalledWith({
      sharingScope: "private",
      categories: [],
    });
  });

  it("does not treat reordered categories as dirty", async () => {
    const v1 = makeVersion(1, "# Demo Skill");
    const node = await renderSkillDetail([v1], {
      activeTab: "overview",
      detail: makeDetail(v1, {
        categories: ["memory", "review"],
        sharingScope: "company",
      }),
    });

    await click(buttonsNamed(node, "Settings")[0] as HTMLButtonElement);
    const dialog = node.querySelector('[role="dialog"]') as HTMLElement;

    await inputValue(dialog.querySelector("input") as HTMLInputElement, "review, memory");

    expect((buttonsNamed(dialog, "Save settings")[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the category draft visible while a failed save leaves detail unchanged", async () => {
    const v1 = makeVersion(1, "# Demo Skill");
    const detail = makeDetail(v1, {
      categories: ["engineering"],
      sharingScope: "company",
    });
    const onUpdateSettings = vi.fn();
    const node = await renderSkillDetail([v1], {
      activeTab: "overview",
      detail,
      onUpdateSettings,
    });

    await click(buttonsNamed(node, "Settings")[0] as HTMLButtonElement);
    const categoryInput = node.querySelector('[role="dialog"] input') as HTMLInputElement;

    await inputValue(categoryInput, "memory");
    await click(buttonsNamed(node.querySelector('[role="dialog"]') as HTMLElement, "Save settings")[0] as HTMLButtonElement);

    await act(async () => {
      root?.render(
        <SkillDetailPage
          detail={detail}
          loading={false}
          activeTab="overview"
          onTabChange={vi.fn()}
          selectedPath="SKILL.md"
          file={null}
          fileLoading={false}
          viewMode="preview"
          editMode={false}
          draft=""
          setViewMode={vi.fn()}
          setEditMode={vi.fn()}
          setDraft={vi.fn()}
          onSave={vi.fn()}
          savePending={false}
          versions={[v1]}
          versionsLoading={false}
          attachAgents={[]}
          onSubmitAttach={vi.fn()}
          attachPending={false}
          expandedDirs={new Set()}
          onToggleDir={vi.fn()}
          onSelectPath={vi.fn()}
          updateStatus={null}
          updateStatusLoading={false}
          onCheckUpdates={vi.fn()}
          checkUpdatesPending={false}
          onInstallUpdate={vi.fn()}
          installUpdatePending={false}
          onToggleStar={vi.fn()}
          starPending={false}
          onFork={vi.fn()}
          onUpdateSettings={onUpdateSettings}
          updateSettingsPending={false}
          onDelete={vi.fn()}
          deletePending={false}
        />,
      );
    });

    expect((node.querySelector('[role="dialog"] input') as HTMLInputElement).value).toBe("memory");
  });
});
