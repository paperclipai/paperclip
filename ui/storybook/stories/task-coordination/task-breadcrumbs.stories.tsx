import { useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { BreadcrumbBar } from "@/components/BreadcrumbBar";
import { LockedIssueChip } from "@/components/LockedIssueChip";
import { StatusIcon } from "@/components/StatusIcon";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useLocation } from "@/lib/router";
import { PluginLauncherProvider } from "@/plugins/launchers";

function TaskBreadcrumbPreview({
  parentTitle,
  title,
  showParent = true,
  privateParent = false,
  source = "Tasks",
}: {
  parentTitle: string;
  title: string;
  showParent?: boolean;
  privateParent?: boolean;
  source?: "Tasks" | "Mine";
}) {
  const { setBreadcrumbs } = useBreadcrumbs();
  const location = useLocation();
  useEffect(() => {
    setBreadcrumbs([
      { label: source, href: source === "Mine" ? "/inbox" : "/issues" },
      ...(showParent ? [{
        label: privateParent ? "Private task" : parentTitle,
        href: privateParent ? undefined : "/issues/PAP-120",
        control: privateParent ? <LockedIssueChip identifier={null} /> : undefined,
        controlKey: privateParent ? "private-parent" : undefined,
      }] : []),
      { label: title, identifier: "PAP-121", leading: <StatusIcon status="in_progress" className="size-3" />, leadingKey: "in_progress" },
    ]);
  }, [parentTitle, title, showParent, privateParent, source, setBreadcrumbs]);

  return (
    <div className="min-h-dvh w-full bg-background text-foreground">
      <BreadcrumbBar taskDetailLayout />
      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Task breadcrumb preview</p>
        <h1 className="text-xl font-semibold">{title}</h1>
        {showParent && !privateParent ? <p className="text-sm text-muted-foreground">Parent: {parentTitle}</p> : null}
        <p className="text-sm text-muted-foreground">Breadcrumb titles show up to 48 characters, including the ellipsis. Narrow screens shorten both titles further. Hover a breadcrumb to read its full title; screen readers retain the full name.</p>
        <output className="text-xs text-muted-foreground" data-testid="navigation-destination">Current route: {location.pathname}</output>
      </main>
    </div>
  );
}

const meta = {
  id: "task-parent-breadcrumbs",
  title: "Tasks and conversations/Delegation, dependencies, and signoff/Parent task breadcrumbs",
  component: TaskBreadcrumbPreview,
  decorators: [(Story) => <PluginLauncherProvider><Story /></PluginLauncherProvider>],
  parameters: {
    layout: "fullscreen",
    initialEntries: ["/PAP/issues/PAP-121"],
    waitForViewport: true,
    paperclip: {
      capabilities: ["task-coordination/delegation", "navigation-preferences/navigation"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes: "Mounts the shipped BreadcrumbBar with fixture breadcrumb context. Covers title-only linked immediate parent, long titles, private parent, standalone task, Mine source, light/dark themes and responsive widths. Page data loading and parent authorization are outside this isolated header story.",
    },
  },
  args: { parentTitle: "Prepare the product launch", title: "Review the release checklist" },
  globals: { theme: "light" },
} satisfies Meta<typeof TaskBreadcrumbPreview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Subtask: Story = {
  play: async ({ canvasElement }) => {
    const nav = within(await within(canvasElement).findByRole("navigation", { name: "breadcrumb" }));
    await expect(nav.getByRole("link", { name: "Prepare the product launch" })).toHaveAttribute("href", "/PAP/issues/PAP-120");
    await expect(nav.getByRole("link", { name: "Prepare the product launch" })).toHaveTextContent(/^Prepare the product launch$/);
    await expect(nav.getByRole("link", { name: "Review the release checklist PAP-121" })).toHaveAttribute("aria-current", "page");
  },
};
export const LongTitles: Story = {
  args: {
    parentTitle: "Prepare the international product launch and coordinate release readiness across all teams",
    title: "Review the release checklist and verify every customer migration before the launch window opens",
  },
  play: async ({ canvasElement }) => {
    const nav = await within(canvasElement).findByRole("navigation", { name: "breadcrumb" });
    for (const title of nav.querySelectorAll('[data-slot="breadcrumb-item"] .truncate')) {
      await expect(Array.from(title.textContent ?? "").length).toBeLessThanOrEqual(48);
    }
    await expect(within(nav).getByRole("link", { name: /Prepare the international product launch/ })).toHaveAttribute("title", "Prepare the international product launch and coordinate release readiness across all teams");
  },
};
export const Mobile: Story = { ...LongTitles, globals: { viewport: { value: "mobile", isRotated: false } } };
export const SmallMobile: Story = { ...LongTitles, globals: { viewport: { value: "mobile1", isRotated: false } } };
export const Tablet: Story = { ...LongTitles, globals: { viewport: { value: "tablet", isRotated: false } } };
export const Dark: Story = { ...LongTitles, globals: { theme: "dark" } };
export const StandaloneTask: Story = { args: { showParent: false } };
export const FromMine: Story = { args: { source: "Mine" } };
export const PrivateParent: Story = {
  args: { privateParent: true },
  play: async ({ canvasElement }) => {
    const nav = await within(canvasElement).findByRole("navigation", { name: "breadcrumb" });
    await expect(within(nav).queryByRole("link", { name: /Prepare the product launch/ })).not.toBeInTheDocument();
    await expect(within(nav).queryByRole("link", { name: /private/i })).not.toBeInTheDocument();
    await expect(within(nav).getByTestId("locked-issue-chip")).toHaveTextContent(/^Private$/);
    await expect(nav).not.toHaveTextContent("PAP-120");
    await expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  },
};
export const PrivateParentMobile: Story = {
  ...PrivateParent,
  globals: { viewport: { value: "mobile1", isRotated: false } },
  play: async (context) => {
    await PrivateParent.play!(context);
    const nav = await within(context.canvasElement).findByRole("navigation", { name: "breadcrumb" });
    await expect(within(nav).getByTestId("locked-issue-chip")).toHaveTextContent("Private");
    await expect(nav).not.toHaveTextContent("PAP-120");
    await expect(nav).toHaveTextContent("PAP-121");
  },
};
