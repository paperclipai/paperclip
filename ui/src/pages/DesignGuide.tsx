import { useState } from "react";
import { useTranslation } from "@/i18n";
import {
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  CircleDot,
  Command as CommandIcon,
  DollarSign,
  Hexagon,
  History,
  Inbox,
  LayoutDashboard,
  ListTodo,
  Mail,
  Plus,
  Search,
  Settings,
  Target,
  Trash2,
  Upload,
  User,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
  DropdownMenuShortcut,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandEmpty,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from "@/components/ui/avatar";
import { StatusBadge } from "@/components/StatusBadge";
import { StatusIcon } from "@/components/StatusIcon";
import { PriorityIcon } from "@/components/PriorityIcon";
import { agentStatusDot, agentStatusDotDefault } from "@/lib/status-colors";
import { EntityRow } from "@/components/EntityRow";
import { EmptyState } from "@/components/EmptyState";
import { MetricCard } from "@/components/MetricCard";
import { FilterBar, type FilterValue } from "@/components/FilterBar";
import { InlineEditor } from "@/components/InlineEditor";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Identity } from "@/components/Identity";
import { IssueReferencePill } from "@/components/IssueReferencePill";
import { MembershipAction } from "@/components/MembershipAction";

/* ------------------------------------------------------------------ */
/*  Section wrapper                                                    */
/* ------------------------------------------------------------------ */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
        {title}
      </h3>
      <Separator />
      {children}
    </section>
  );
}

function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium">{title}</h4>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Color swatch                                                       */
/* ------------------------------------------------------------------ */

function Swatch({ name, cssVar }: { name: string; cssVar: string }) {
  return (
    <div className="flex items-center gap-3">
      <div
        className="h-8 w-8 rounded-md border border-border shrink-0"
        style={{ backgroundColor: `var(${cssVar})` }}
      />
      <div>
        <p className="text-xs font-mono">{cssVar}</p>
        <p className="text-xs text-muted-foreground">{name}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export function DesignGuide() {
  const { t } = useTranslation();
  const [status, setStatus] = useState("todo");
  const [priority, setPriority] = useState("medium");
  const [selectValue, setSelectValue] = useState("in_progress");
  const [menuChecked, setMenuChecked] = useState(true);
  const [collapsibleOpen, setCollapsibleOpen] = useState(false);
  const [inlineText, setInlineText] = useState("Click to edit this text");
  const [inlineTitle, setInlineTitle] = useState("Editable Title");
  const [inlineDesc, setInlineDesc] = useState(
    "This is an editable description. Click to edit it — the textarea auto-sizes to fit the content without layout shift."
  );
  const [filters, setFilters] = useState<FilterValue[]>([
    { key: "status", label: "Status", value: "Active" },
    { key: "priority", label: "Priority", value: "High" },
  ]);

  return (
    <div className="space-y-10 max-w-4xl">
      {/* Page header */}
      <div>
        <h2 className="text-xl font-bold">{t("pages.designGuide.title")}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t("pages.designGuide.description")}
        </p>
      </div>

      {/* ============================================================ */}
      {/*  COVERAGE                                                     */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.coverage")}>
        <p className="text-sm text-muted-foreground">
          {t("pages.designGuide.coverage.description")}
        </p>
        <div className="grid gap-6 md:grid-cols-2">
          <SubSection title="UI primitives">
            <div className="flex flex-wrap gap-2">
              {[
                "avatar", "badge", "breadcrumb", "button", "card", "checkbox", "collapsible",
                "command", "dialog", "dropdown-menu", "input", "label", "popover", "scroll-area",
                "select", "separator", "sheet", "skeleton", "tabs", "textarea", "tooltip",
              ].map((name) => (
                <Badge key={name} variant="outline" className="font-mono text-[10px]">
                  {name}
                </Badge>
              ))}
            </div>
          </SubSection>
          <SubSection title="App components">
            <div className="flex flex-wrap gap-2">
              {[
                "StatusBadge", "StatusIcon", "PriorityIcon", "EntityRow", "EmptyState", "MetricCard",
                "FilterBar", "InlineEditor", "PageSkeleton", "Identity", "CommentThread", "MarkdownEditor",
                "PropertiesPanel", "Sidebar", "CommandPalette",
              ].map((name) => (
                <Badge key={name} variant="ghost" className="font-mono text-[10px]">
                  {name}
                </Badge>
              ))}
            </div>
          </SubSection>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  COLORS                                                       */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.colors")}>
        <SubSection title="Core">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Swatch name={t("pages.designGuide.color.background")} cssVar="--background" />
            <Swatch name={t("pages.designGuide.color.foreground")} cssVar="--foreground" />
            <Swatch name={t("pages.designGuide.color.card")} cssVar="--card" />
            <Swatch name={t("pages.designGuide.color.primary")} cssVar="--primary" />
            <Swatch name={t("pages.designGuide.color.primaryForeground")} cssVar="--primary-foreground" />
            <Swatch name={t("pages.designGuide.color.secondary")} cssVar="--secondary" />
            <Swatch name={t("pages.designGuide.color.muted")} cssVar="--muted" />
            <Swatch name={t("pages.designGuide.color.mutedForeground")} cssVar="--muted-foreground" />
            <Swatch name={t("pages.designGuide.color.accent")} cssVar="--accent" />
            <Swatch name={t("pages.designGuide.color.destructive")} cssVar="--destructive" />
            <Swatch name={t("pages.designGuide.color.border")} cssVar="--border" />
            <Swatch name={t("pages.designGuide.color.ring")} cssVar="--ring" />
          </div>
        </SubSection>

        <SubSection title={t("pages.designGuide.subSection.sidebar")}>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Swatch name={t("pages.designGuide.color.sidebar")} cssVar="--sidebar" />
            <Swatch name={t("pages.designGuide.color.sidebarBorder")} cssVar="--sidebar-border" />
          </div>
        </SubSection>

        <SubSection title={t("pages.designGuide.subSection.chart")}>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Swatch name={t("pages.designGuide.color.chart1")} cssVar="--chart-1" />
            <Swatch name={t("pages.designGuide.color.chart2")} cssVar="--chart-2" />
            <Swatch name={t("pages.designGuide.color.chart3")} cssVar="--chart-3" />
            <Swatch name={t("pages.designGuide.color.chart4")} cssVar="--chart-4" />
            <Swatch name={t("pages.designGuide.color.chart5")} cssVar="--chart-5" />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TYPOGRAPHY                                                   */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.typography")}>
        <div className="space-y-3">
          <h2 className="text-xl font-bold">{t("pages.designGuide.typography.pageTitle")}</h2>
          <h2 className="text-lg font-semibold">{t("pages.designGuide.typography.sectionTitle")}</h2>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            {t("pages.designGuide.typography.sectionHeading")}
          </h3>
          <p className="text-sm font-medium">{t("pages.designGuide.typography.cardTitle")}</p>
          <p className="text-sm font-semibold">{t("pages.designGuide.typography.cardTitleAlt")}</p>
          <p className="text-sm">{t("pages.designGuide.typography.bodyText")}</p>
          <p className="text-sm text-muted-foreground">
            {t("pages.designGuide.typography.mutedDescription")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("pages.designGuide.typography.tinyLabel")}
          </p>
          <p className="text-sm font-mono text-muted-foreground">
            {t("pages.designGuide.typography.monoIdentifier")}
          </p>
          <p className="text-2xl font-bold">{t("pages.designGuide.typography.largeStat")}</p>
          <p className="font-mono text-xs">{t("pages.designGuide.typography.logCodeText")}</p>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  SPACING & RADIUS                                             */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.radius")}>
        <div className="flex items-end gap-4 flex-wrap">
          {[
            ["sm", "var(--radius-sm)"],
            ["md", "var(--radius-md)"],
            ["lg", "var(--radius-lg)"],
            ["xl", "var(--radius-xl)"],
            ["full", "9999px"],
          ].map(([label, radius]) => (
            <div key={label} className="flex flex-col items-center gap-1">
              <div
                className="h-12 w-12 bg-primary"
                style={{ borderRadius: radius }}
              />
              <span className="text-xs text-muted-foreground">{label}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  BUTTONS                                                      */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.buttons")}>
        <SubSection title={t("pages.designGuide.subSection.variants")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="default">{t("pages.designGuide.button.default")}</Button>
            <Button variant="secondary">{t("pages.designGuide.button.secondary")}</Button>
            <Button variant="outline">{t("pages.designGuide.button.outline")}</Button>
            <Button variant="ghost">{t("pages.designGuide.button.ghost")}</Button>
            <Button variant="destructive">{t("pages.designGuide.button.destructive")}</Button>
            <Button variant="link">{t("pages.designGuide.button.link")}</Button>
          </div>
        </SubSection>

        <SubSection title={t("pages.designGuide.subSection.sizes")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="xs">{t("pages.designGuide.button.extraSmall")}</Button>
            <Button size="sm">{t("pages.designGuide.button.small")}</Button>
            <Button size="default">{t("pages.designGuide.button.default")}</Button>
            <Button size="lg">{t("pages.designGuide.button.large")}</Button>
          </div>
        </SubSection>

        <SubSection title={t("pages.designGuide.subSection.iconButtons")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="ghost" size="icon-xs"><Search /></Button>
            <Button variant="ghost" size="icon-sm"><Search /></Button>
            <Button variant="outline" size="icon"><Search /></Button>
            <Button variant="outline" size="icon-lg"><Search /></Button>
          </div>
        </SubSection>

        <SubSection title={t("pages.designGuide.subSection.withIcons")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button><Plus /> {t("pages.designGuide.button.newIssue")}</Button>
            <Button variant="outline"><Upload /> {t("pages.designGuide.button.upload")}</Button>
            <Button variant="destructive"><Trash2 /> {t("pages.designGuide.button.delete")}</Button>
            <Button size="sm"><Plus /> {t("pages.designGuide.button.add")}</Button>
          </div>
        </SubSection>

        <SubSection title={t("pages.designGuide.subSection.states")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button disabled>{t("pages.designGuide.button.disabled")}</Button>
            <Button variant="outline" disabled>{t("pages.designGuide.button.disabledOutline")}</Button>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  BADGES                                                       */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.badges")}>
        <SubSection title={t("pages.designGuide.subSection.variants")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="default">{t("pages.designGuide.badge.default")}</Badge>
            <Badge variant="secondary">{t("pages.designGuide.badge.secondary")}</Badge>
            <Badge variant="outline">{t("pages.designGuide.badge.outline")}</Badge>
            <Badge variant="destructive">{t("pages.designGuide.badge.destructive")}</Badge>
            <Badge variant="ghost">{t("pages.designGuide.badge.ghost")}</Badge>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  STATUS BADGES & ICONS                                        */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.statusSystem")}>
        <SubSection title={t("pages.designGuide.subSection.statusBadgeAllStatuses")}>
          <div className="flex items-center gap-2 flex-wrap">
            {[
              "active", "running", "paused", "idle", "archived", "planned",
              "achieved", "completed", "failed", "timed_out", "succeeded", "error",
              "pending_approval", "backlog", "todo", "in_progress", "in_review", "blocked",
              "done", "terminated", "cancelled", "pending", "revision_requested",
              "approved", "rejected",
            ].map((s) => (
              <StatusBadge key={s} status={s} />
            ))}
          </div>
        </SubSection>

        <SubSection title={t("pages.designGuide.subSection.statusIconInteractive")}>
          <div className="flex items-center gap-3 flex-wrap">
            {["backlog", "todo", "in_progress", "in_review", "done", "cancelled", "blocked"].map(
              (s) => (
                <div key={s} className="flex items-center gap-1.5">
                  <StatusIcon status={s} />
                  <span className="text-xs text-muted-foreground">{s}</span>
                </div>
              )
            )}
          </div>
          <div className="flex items-center gap-2 mt-2">
            <StatusIcon status={status} onChange={setStatus} />
            <span className="text-sm">{t("pages.designGuide.statusIcon.clickToChange", { current: status })}</span>
          </div>
        </SubSection>

        <SubSection title={t("pages.designGuide.subSection.priorityIconInteractive")}>
          <div className="flex items-center gap-3 flex-wrap">
            {["critical", "high", "medium", "low"].map((p) => (
              <div key={p} className="flex items-center gap-1.5">
                <PriorityIcon priority={p} />
                <span className="text-xs text-muted-foreground">{p}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-2">
            <PriorityIcon priority={priority} onChange={setPriority} />
            <span className="text-sm">{t("pages.designGuide.priorityIcon.clickToChange", { current: priority })}</span>
          </div>
        </SubSection>

        <SubSection title={t("pages.designGuide.subSection.agentStatusDots")}>
          <div className="flex items-center gap-4 flex-wrap">
            {(["running", "active", "paused", "error", "archived"] as const).map((label) => (
              <div key={label} className="flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  <span className={`inline-flex h-full w-full rounded-full ${agentStatusDot[label] ?? agentStatusDotDefault}`} />
                </span>
                <span className="text-xs text-muted-foreground">{label}</span>
              </div>
            ))}
          </div>
        </SubSection>

        <SubSection title={t("pages.designGuide.subSection.runInvocationBadges")}>
          <div className="flex items-center gap-2 flex-wrap">
            {[
              ["timer", "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300"],
              ["assignment", "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300"],
              ["on_demand", "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300"],
              ["automation", "bg-muted text-muted-foreground"],
            ].map(([label, cls]) => (
              <span key={label} className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
                {label}
              </span>
            ))}
          </div>
        </SubSection>

        <SubSection title={t("pages.designGuide.subSection.issueReferencePill")}>
          <p className="text-xs text-muted-foreground">
            {t("pages.designGuide.issueReferencePill.description")}
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <IssueReferencePill issue={{ id: "demo-1", identifier: "PAP-123", title: t("pages.designGuide.issueReferencePill.identifierOnly") }} />
            <IssueReferencePill issue={{ id: "demo-2", identifier: "PAP-456", title: t("pages.designGuide.issueReferencePill.withStatus"), status: "in_progress" }} />
            <IssueReferencePill issue={{ id: "demo-3", identifier: "PAP-789", title: t("pages.designGuide.issueReferencePill.doneStatus"), status: "done" }} />
            <IssueReferencePill issue={{ id: "demo-4", identifier: "PAP-101", title: t("pages.designGuide.issueReferencePill.blockedStatus"), status: "blocked" }} />
            <IssueReferencePill strikethrough issue={{ id: "demo-5", identifier: "PAP-202", title: t("pages.designGuide.issueReferencePill.removed"), status: "todo" }} />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  FORM ELEMENTS                                                */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.formElements")}>
        <div className="grid gap-6 md:grid-cols-2">
          <SubSection title={t("pages.designGuide.subSection.input")}>
            <Input placeholder={t("pages.designGuide.input.placeholder")} />
            <Input placeholder={t("pages.designGuide.input.disabledPlaceholder")} disabled className="mt-2" />
          </SubSection>

          <SubSection title={t("pages.designGuide.subSection.textarea")}>
            <Textarea placeholder={t("pages.designGuide.textarea.placeholder")} />
          </SubSection>

          <SubSection title={t("pages.designGuide.subSection.checkboxLabel")}>
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Checkbox id="check1" defaultChecked />
                <Label htmlFor="check1">{t("pages.designGuide.checkbox.checked")}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="check2" />
                <Label htmlFor="check2">{t("pages.designGuide.checkbox.unchecked")}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="check3" disabled />
                <Label htmlFor="check3">{t("pages.designGuide.checkbox.disabled")}</Label>
              </div>
            </div>
          </SubSection>

          <SubSection title={t("pages.designGuide.subSection.inlineEditor")}>
            <div className="space-y-4">
              <div>
                <p className="text-xs text-muted-foreground mb-1">{t("pages.designGuide.inlineEditor.titleSingleLine")}</p>
                <InlineEditor
                  value={inlineTitle}
                  onSave={setInlineTitle}
                  as="h2"
                  className="text-xl font-bold"
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">{t("pages.designGuide.inlineEditor.bodySingleLine")}</p>
                <InlineEditor
                  value={inlineText}
                  onSave={setInlineText}
                  as="p"
                  className="text-sm"
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">{t("pages.designGuide.inlineEditor.descriptionMultiline")}</p>
                <InlineEditor
                  value={inlineDesc}
                  onSave={setInlineDesc}
                  as="p"
                  className="text-sm text-muted-foreground"
                  placeholder={t("pages.designGuide.inlineEditor.addDescription")}
                  multiline
                />
              </div>
            </div>
          </SubSection>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  SELECT                                                       */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.select")}>
        <div className="grid gap-6 md:grid-cols-2">
          <SubSection title={t("pages.designGuide.subSection.defaultSize")}>
            <Select value={selectValue} onValueChange={setSelectValue}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("pages.designGuide.select.placeholder")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="backlog">{t("common.status.backlog")}</SelectItem>
                <SelectItem value="todo">{t("common.status.todo")}</SelectItem>
                <SelectItem value="in_progress">{t("common.status.inProgress")}</SelectItem>
                <SelectItem value="in_review">{t("common.status.inReview")}</SelectItem>
                <SelectItem value="done">{t("common.status.done")}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t("pages.designGuide.select.currentValue", { value: selectValue })}</p>
          </SubSection>
          <SubSection title={t("pages.designGuide.subSection.smallTrigger")}>
            <Select defaultValue="high">
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="critical">{t("common.priority.critical")}</SelectItem>
                <SelectItem value="high">{t("common.priority.high")}</SelectItem>
                <SelectItem value="medium">{t("common.priority.medium")}</SelectItem>
                <SelectItem value="low">{t("common.priority.low")}</SelectItem>
              </SelectContent>
            </Select>
          </SubSection>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  DROPDOWN MENU                                                */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.dropdownMenu")}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {t("pages.designGuide.dropdownMenu.quickActions")}
              <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem>
              <Check className="h-4 w-4" />
              {t("pages.designGuide.dropdownMenu.markAsDone")}
              <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem>
              <BookOpen className="h-4 w-4" />
              {t("pages.designGuide.dropdownMenu.openDocs")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={menuChecked}
              onCheckedChange={(value) => setMenuChecked(value === true)}
            >
              {t("pages.designGuide.dropdownMenu.watchIssue")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuItem variant="destructive">
              <Trash2 className="h-4 w-4" />
              {t("pages.designGuide.dropdownMenu.deleteIssue")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Section>

      {/* ============================================================ */}
      {/*  POPOVER                                                      */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.popover")}>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">{t("pages.designGuide.popover.open")}</Button>
          </PopoverTrigger>
          <PopoverContent className="space-y-2">
            <p className="text-sm font-medium">{t("pages.designGuide.popover.agentHeartbeat")}</p>
            <p className="text-xs text-muted-foreground">
              {t("pages.designGuide.popover.lastRunInfo")}
            </p>
            <Button size="xs">{t("pages.designGuide.popover.wakeNow")}</Button>
          </PopoverContent>
        </Popover>
      </Section>

      {/* ============================================================ */}
      {/*  COLLAPSIBLE                                                  */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.collapsible")}>
        <Collapsible open={collapsibleOpen} onOpenChange={setCollapsibleOpen} className="space-y-2">
          <CollapsibleTrigger asChild>
            <Button variant="outline" size="sm">
              {collapsibleOpen ? t("pages.designGuide.collapsible.hide") : t("pages.designGuide.collapsible.show")} {t("pages.designGuide.collapsible.advancedFilters")}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="rounded-md border border-border p-3">
            <div className="space-y-2">
              <Label htmlFor="owner-filter">{t("pages.designGuide.collapsible.owner")}</Label>
              <Input id="owner-filter" placeholder={t("pages.designGuide.collapsible.filterByAgentName")} />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </Section>

      {/* ============================================================ */}
      {/*  SHEET                                                        */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.sheet")}>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" size="sm">{t("pages.designGuide.sheet.open")}</Button>
          </SheetTrigger>
          <SheetContent side="right">
            <SheetHeader>
              <SheetTitle>{t("pages.designGuide.sheet.issueProperties")}</SheetTitle>
              <SheetDescription>{t("pages.designGuide.sheet.editMetadata")}</SheetDescription>
            </SheetHeader>
            <div className="space-y-4 px-4">
              <div className="space-y-1">
                <Label htmlFor="sheet-title">{t("common.form.title")}</Label>
                <Input id="sheet-title" defaultValue={t("pages.designGuide.sheet.improveOnboardingDocs")} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sheet-description">{t("common.form.description")}</Label>
                <Textarea id="sheet-description" defaultValue={t("pages.designGuide.sheet.capturePitfalls")} />
              </div>
            </div>
            <SheetFooter>
              <Button variant="outline">{t("common.actions.cancel")}</Button>
              <Button>{t("common.actions.save")}</Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </Section>

      {/* ============================================================ */}
      {/*  SCROLL AREA                                                  */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.scrollArea")}>
        <ScrollArea className="h-36 rounded-md border border-border">
          <div className="space-y-2 p-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="rounded-md border border-border p-2 text-sm">
                {t("pages.designGuide.scrollArea.heartbeatRun", { number: i + 1 })}
              </div>
            ))}
          </div>
        </ScrollArea>
      </Section>

      {/* ============================================================ */}
      {/*  COMMAND                                                      */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.command")}>
        <div className="rounded-md border border-border">
          <Command>
            <CommandInput placeholder={t("pages.designGuide.command.placeholder")} />
            <CommandList>
              <CommandEmpty>{t("pages.designGuide.command.empty")}</CommandEmpty>
              <CommandGroup heading={t("pages.designGuide.command.pages")}>
                <CommandItem>
                  <LayoutDashboard className="h-4 w-4" />
                  {t("nav.sidebar.dashboard")}
                </CommandItem>
                <CommandItem>
                  <CircleDot className="h-4 w-4" />
                  {t("nav.sidebar.issues")}
                </CommandItem>
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading={t("pages.designGuide.command.actions")}>
                <CommandItem>
                  <CommandIcon className="h-4 w-4" />
                  {t("pages.designGuide.command.openPalette")}
                </CommandItem>
                <CommandItem>
                  <Plus className="h-4 w-4" />
                  {t("pages.designGuide.command.createIssue")}
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  BREADCRUMB                                                   */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.breadcrumb")}>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="#">{t("pages.designGuide.breadcrumb.projects")}</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href="#">{t("pages.designGuide.breadcrumb.paperclipApp")}</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{t("pages.designGuide.breadcrumb.issueList")}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </Section>

      {/* ============================================================ */}
      {/*  CARDS                                                        */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.cards")}>
        <SubSection title={t("pages.designGuide.subSection.standardCard")}>
          <Card>
            <CardHeader>
              <CardTitle>{t("pages.designGuide.card.title")}</CardTitle>
              <CardDescription>{t("pages.designGuide.card.description")}</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm">{t("pages.designGuide.card.content")}</p>
            </CardContent>
            <CardFooter className="gap-2">
              <Button size="sm">{t("pages.designGuide.button.action")}</Button>
              <Button variant="outline" size="sm">{t("common.actions.cancel")}</Button>
            </CardFooter>
          </Card>
        </SubSection>

        <SubSection title={t("pages.designGuide.subSection.metricCards")}>
          <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
            <MetricCard icon={Bot} value={12} label={t("pages.designGuide.metricCards.activeAgents")} description={t("pages.designGuide.metricCards.thisWeek")} />
            <MetricCard icon={CircleDot} value={48} label={t("pages.designGuide.metricCards.openIssues")} />
            <MetricCard icon={DollarSign} value="$1,234" label={t("pages.designGuide.metricCards.monthlyCost")} description={t("pages.designGuide.metricCards.underBudget")} />
            <MetricCard icon={Zap} value="99.9%" label={t("pages.designGuide.metricCards.uptime")} />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TABS                                                         */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.tabs")}>
        <SubSection title={t("pages.designGuide.subSection.defaultVariant")}>
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">{t("pages.designGuide.tabs.overview")}</TabsTrigger>
              <TabsTrigger value="runs">{t("pages.designGuide.tabs.runs")}</TabsTrigger>
              <TabsTrigger value="config">{t("pages.designGuide.tabs.config")}</TabsTrigger>
              <TabsTrigger value="costs">{t("pages.designGuide.tabs.costs")}</TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              <p className="text-sm text-muted-foreground py-4">{t("pages.designGuide.tabs.overviewContent")}</p>
            </TabsContent>
            <TabsContent value="runs">
              <p className="text-sm text-muted-foreground py-4">{t("pages.designGuide.tabs.runsContent")}</p>
            </TabsContent>
            <TabsContent value="config">
              <p className="text-sm text-muted-foreground py-4">{t("pages.designGuide.tabs.configContent")}</p>
            </TabsContent>
            <TabsContent value="costs">
              <p className="text-sm text-muted-foreground py-4">{t("pages.designGuide.tabs.costsContent")}</p>
            </TabsContent>
          </Tabs>
        </SubSection>

        <SubSection title={t("pages.designGuide.subSection.lineVariant")}>
          <Tabs defaultValue="summary">
            <TabsList variant="line">
              <TabsTrigger value="summary">{t("pages.designGuide.tabs.summary")}</TabsTrigger>
              <TabsTrigger value="details">{t("pages.designGuide.tabs.details")}</TabsTrigger>
              <TabsTrigger value="comments">{t("pages.designGuide.tabs.comments")}</TabsTrigger>
            </TabsList>
            <TabsContent value="summary">
              <p className="text-sm text-muted-foreground py-4">{t("pages.designGuide.tabs.summaryContent")}</p>
            </TabsContent>
            <TabsContent value="details">
              <p className="text-sm text-muted-foreground py-4">{t("pages.designGuide.tabs.detailsContent")}</p>
            </TabsContent>
            <TabsContent value="comments">
              <p className="text-sm text-muted-foreground py-4">{t("pages.designGuide.tabs.commentsContent")}</p>
            </TabsContent>
          </Tabs>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  ENTITY ROWS                                                  */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.entityRows")}>
        <div className="border border-border rounded-md">
          <EntityRow
            leading={
              <>
                <StatusIcon status="in_progress" />
                <PriorityIcon priority="high" />
              </>
            }
            identifier="PAP-001"
            title={t("pages.designGuide.entityRow.implementAuth")}
            subtitle={t("pages.designGuide.entityRow.assignedToAlpha")}
            trailing={<StatusBadge status="in_progress" />}
            onClick={() => {}}
          />
          <EntityRow
            leading={
              <>
                <StatusIcon status="done" />
                <PriorityIcon priority="medium" />
              </>
            }
            identifier="PAP-002"
            title={t("pages.designGuide.entityRow.setUpCICD")}
            subtitle={t("pages.designGuide.entityRow.completedTwoDays")}
            trailing={<StatusBadge status="done" />}
            onClick={() => {}}
          />
          <EntityRow
            leading={
              <>
                <StatusIcon status="todo" />
                <PriorityIcon priority="low" />
              </>
            }
            identifier="PAP-003"
            title={t("pages.designGuide.entityRow.writeAPIDocs")}
            trailing={<StatusBadge status="todo" />}
            onClick={() => {}}
          />
          <EntityRow
            leading={
              <>
                <StatusIcon status="blocked" />
                <PriorityIcon priority="critical" />
              </>
            }
            identifier="PAP-004"
            title={t("pages.designGuide.entityRow.deployToProduction")}
            subtitle={t("pages.designGuide.entityRow.blockedBy001")}
            trailing={<StatusBadge status="blocked" />}
            selected
          />
        </div>
        <SubSection title="Membership action">
          <div className="border border-border rounded-md">
            <EntityRow
              title="Joined resource"
              subtitle="Hover or focus the row to reveal the reserved action slot."
              className="group"
              trailing={
                <MembershipAction
                  state="joined"
                  resourceName="Joined resource"
                  onJoin={() => {}}
                  onLeave={() => {}}
                />
              }
            />
            <EntityRow
              title="Left resource"
              subtitle="Persistent action with dimmed row content."
              className="group text-foreground/55"
              trailing={
                <MembershipAction
                  state="left"
                  resourceName="Left resource"
                  onJoin={() => {}}
                  onLeave={() => {}}
                />
              }
            />
            <EntityRow
              title="Leaving resource"
              subtitle="Disabled while the optimistic mutation is pending."
              className="group text-foreground/55"
              trailing={
                <MembershipAction
                  state="left"
                  pending
                  pendingState="left"
                  resourceName="Leaving resource"
                  onJoin={() => {}}
                  onLeave={() => {}}
                />
              }
            />
            <EntityRow
              title="Joining resource"
              subtitle="The target state is visible immediately while the server confirms."
              className="group"
              trailing={
                <MembershipAction
                  state="joined"
                  pending
                  pendingState="joined"
                  resourceName="Joining resource"
                  onJoin={() => {}}
                  onLeave={() => {}}
                />
              }
            />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  FILTER BAR                                                   */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.filterBar")}>
        <FilterBar
          filters={filters}
          onRemove={(key) => setFilters((f) => f.filter((x) => x.key !== key))}
          onClear={() => setFilters([])}
        />
        {filters.length === 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setFilters([
                { key: "status", label: "Status", value: "Active" },
                { key: "priority", label: "Priority", value: "High" },
              ])
            }
          >
            {t("pages.designGuide.filterBar.resetFilters")}
          </Button>
        )}
      </Section>

      {/* ============================================================ */}
      {/*  AVATARS                                                      */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.avatars")}>
        <SubSection title={t("pages.designGuide.subSection.sizes")}>
          <div className="flex items-center gap-3">
            <Avatar size="sm"><AvatarFallback>{t("pages.designGuide.avatar.sm")}</AvatarFallback></Avatar>
            <Avatar><AvatarFallback>{t("pages.designGuide.avatar.df")}</AvatarFallback></Avatar>
            <Avatar size="lg"><AvatarFallback>{t("pages.designGuide.avatar.lg")}</AvatarFallback></Avatar>
          </div>
        </SubSection>

        <SubSection title={t("pages.designGuide.subSection.group")}>
          <AvatarGroup>
            <Avatar><AvatarFallback>{t("pages.designGuide.avatar.a1")}</AvatarFallback></Avatar>
            <Avatar><AvatarFallback>{t("pages.designGuide.avatar.a2")}</AvatarFallback></Avatar>
            <Avatar><AvatarFallback>{t("pages.designGuide.avatar.a3")}</AvatarFallback></Avatar>
            <AvatarGroupCount>{t("pages.designGuide.avatar.moreCount")}</AvatarGroupCount>
          </AvatarGroup>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  IDENTITY                                                     */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.identity")}>
        <SubSection title={t("pages.designGuide.subSection.sizes")}>
          <div className="flex items-center gap-6">
            <Identity name={t("pages.designGuide.identity.agentAlpha")} size="sm" />
            <Identity name={t("pages.designGuide.identity.agentAlpha")} />
            <Identity name={t("pages.designGuide.identity.agentAlpha")} size="lg" />
          </div>
        </SubSection>

        <SubSection title={t("pages.designGuide.subSection.initialsDerivation")}>
          <div className="flex flex-col gap-2">
            <Identity name={t("pages.designGuide.identity.ceoAgent")} size="sm" />
            <Identity name={t("pages.designGuide.identity.alpha")} size="sm" />
            <Identity name={t("pages.designGuide.identity.qaLead")} size="sm" />
          </div>
        </SubSection>

        <SubSection title={t("pages.designGuide.subSection.customInitials")}>
          <Identity name={t("pages.designGuide.identity.backendService")} initials="BS" size="sm" />
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TOOLTIPS                                                     */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.tooltips")}>
        <div className="flex items-center gap-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm">{t("pages.designGuide.tooltip.hoverMe")}</Button>
            </TooltipTrigger>
            <TooltipContent>{t("pages.designGuide.tooltip.thisIsTooltip")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm"><Settings /></Button>
            </TooltipTrigger>
            <TooltipContent>{t("nav.sidebar.settings")}</TooltipContent>
          </Tooltip>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  DIALOG                                                       */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.dialog")}>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline">{t("pages.designGuide.dialog.open")}</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("pages.designGuide.dialog.dialogTitle")}</DialogTitle>
              <DialogDescription>
                {t("pages.designGuide.dialog.dialogDescription")}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>{t("common.form.name")}</Label>
                <Input placeholder={t("pages.designGuide.dialog.enterName")} className="mt-1.5" />
              </div>
              <div>
                <Label>{t("common.form.description")}</Label>
                <Textarea placeholder={t("pages.designGuide.dialog.describe")} className="mt-1.5" />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline">{t("common.actions.cancel")}</Button>
              <Button>{t("common.actions.save")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Section>

      {/* ============================================================ */}
      {/*  EMPTY STATE                                                  */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.emptyState")}>
        <div className="border border-border rounded-md">
          <EmptyState
            icon={Inbox}
            message={t("pages.designGuide.emptyState.message")}
            action={t("pages.designGuide.emptyState.action")}
            onAction={() => {}}
          />
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  PROGRESS BARS                                                */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.progressBars")}>
        <div className="space-y-3">
          {[
            { label: t("pages.designGuide.progress.underBudget"), pct: 40, color: "bg-green-400" },
            { label: t("pages.designGuide.progress.warning"), pct: 75, color: "bg-yellow-400" },
            { label: t("pages.designGuide.progress.overBudget"), pct: 95, color: "bg-red-400" },
          ].map(({ label, pct, color }) => (
            <div key={label} className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{label}</span>
                <span className="text-xs font-mono">{pct}%</span>
              </div>
              <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-[width,background-color] duration-150 ${color}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  LOG VIEWER                                                   */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.logViewer")}>
        <div className="bg-neutral-950 rounded-lg p-3 font-mono text-xs max-h-80 overflow-y-auto">
          <div className="text-foreground">[12:00:01] INFO  {t("pages.designGuide.logViewer.agentStarted")}</div>
          <div className="text-foreground">[12:00:02] INFO  {t("pages.designGuide.logViewer.processingTask")} PAP-001</div>
          <div className="text-yellow-400">[12:00:05] WARN  {t("pages.designGuide.logViewer.rateLimit")} (80%)</div>
          <div className="text-foreground">[12:00:08] INFO  {t("pages.designGuide.logViewer.taskCompleted")} PAP-001</div>
          <div className="text-red-400">[12:00:12] ERROR {t("pages.designGuide.logViewer.connectionTimeout")}</div>
          <div className="text-blue-300">[12:00:12] SYS   {t("pages.designGuide.logViewer.retryingConnection")}</div>
          <div className="text-foreground">[12:00:17] INFO  {t("pages.designGuide.logViewer.reconnected")}</div>
          <div className="flex items-center gap-1.5">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-cyan-400 animate-pulse" />
              <span className="inline-flex h-full w-full rounded-full bg-cyan-400" />
            </span>
            <span className="text-cyan-400">{t("pages.designGuide.logViewer.live")}</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  PROPERTY ROW PATTERN                                         */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.propertyRowPattern")}>
        <div className="border border-border rounded-md p-4 space-y-1 max-w-sm">
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">{t("common.form.status")}</span>
            <StatusBadge status="active" />
          </div>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">{t("common.form.priority")}</span>
            <PriorityIcon priority="high" />
          </div>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">{t("common.form.assignee")}</span>
            <div className="flex items-center gap-1.5">
              <Avatar size="sm"><AvatarFallback>A</AvatarFallback></Avatar>
              <span className="text-xs">{t("pages.designGuide.propertyRow.agentAlpha")}</span>
            </div>
          </div>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">{t("common.form.created")}</span>
            <span className="text-xs">{t("pages.designGuide.propertyRow.jan152025")}</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  NAVIGATION PATTERNS                                          */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.navigationPatterns")}>
        <SubSection title={t("pages.designGuide.subSection.sidebarNavItems")}>
          <div className="w-60 border border-border rounded-md p-3 space-y-0.5 bg-card">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium bg-accent text-accent-foreground">
              <LayoutDashboard className="h-4 w-4" />
              {t("nav.sidebar.dashboard")}
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <CircleDot className="h-4 w-4" />
              {t("nav.sidebar.issues")}
              <span className="ml-auto text-xs bg-primary text-primary-foreground rounded-full px-1.5 py-0.5">
                12
              </span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <Bot className="h-4 w-4" />
              {t("nav.sidebar.issues")}
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <Hexagon className="h-4 w-4" />
              {t("nav.sidebar.work")}
            </div>
          </div>
        </SubSection>

        <SubSection title={t("pages.designGuide.subSection.viewToggle")}>
          <div className="flex items-center border border-border rounded-md w-fit">
            <button className="px-3 py-1.5 text-xs font-medium bg-accent text-foreground rounded-l-md">
              <ListTodo className="h-3.5 w-3.5 inline mr-1" />
              {t("pages.designGuide.viewToggle.list")}
            </button>
            <button className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent/50 rounded-r-md">
              <Target className="h-3.5 w-3.5 inline mr-1" />
              {t("pages.designGuide.viewToggle.org")}
            </button>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  GROUPED LIST (Issues pattern)                                */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.groupedList")}>
        <div>
          <div className="flex items-center gap-2 px-4 py-2 bg-muted/50 rounded-t-md">
            <StatusIcon status="in_progress" />
            <span className="text-sm font-medium">{t("common.status.inProgress")}</span>
            <span className="text-xs text-muted-foreground ml-1">2</span>
          </div>
          <div className="border border-border rounded-b-md">
            <EntityRow
              leading={<PriorityIcon priority="high" />}
              identifier="PAP-101"
              title={t("pages.designGuide.groupedList.buildHeartbeat")}
              onClick={() => {}}
            />
            <EntityRow
              leading={<PriorityIcon priority="medium" />}
              identifier="PAP-102"
              title={t("pages.designGuide.groupedList.addCostDashboard")}
              onClick={() => {}}
            />
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  COMMENT THREAD PATTERN                                       */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.commentThread")}>
        <div className="space-y-3 max-w-2xl">
          <h3 className="text-sm font-semibold">{t("pages.designGuide.commentThread.comments", { count: 2 })}</h3>
          <div className="space-y-3">
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-muted-foreground">{t("pages.designGuide.commentThread.agent")}</span>
                <span className="text-xs text-muted-foreground">{t("pages.designGuide.commentThread.jan152025")}</span>
              </div>
              <p className="text-sm">{t("pages.designGuide.commentThread.agentMessage")}</p>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-muted-foreground">{t("pages.designGuide.commentThread.human")}</span>
                <span className="text-xs text-muted-foreground">{t("pages.designGuide.commentThread.jan162025")}</span>
              </div>
              <p className="text-sm">{t("pages.designGuide.commentThread.humanMessage")}</p>
            </div>
          </div>
          <div className="space-y-2">
            <Textarea placeholder={t("pages.designGuide.commentThread.leaveComment")} rows={3} />
            <Button size="sm">{t("pages.designGuide.commentThread.comment")}</Button>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  COST TABLE PATTERN                                           */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.costTable")}>
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead className="border-b border-border bg-accent/20">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">{t("pages.designGuide.costTable.model")}</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">{t("pages.designGuide.costTable.tokens")}</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">{t("pages.designGuide.costTable.cost")}</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border">
                <td className="px-3 py-2">claude-sonnet-4-20250514</td>
                <td className="px-3 py-2 font-mono">1.2M</td>
                <td className="px-3 py-2 font-mono">$18.00</td>
              </tr>
              <tr className="border-b border-border">
                <td className="px-3 py-2">claude-haiku-4-20250506</td>
                <td className="px-3 py-2 font-mono">500k</td>
                <td className="px-3 py-2 font-mono">$1.25</td>
              </tr>
              <tr>
                <td className="px-3 py-2 font-medium">{t("pages.designGuide.costTable.total")}</td>
                <td className="px-3 py-2 font-mono">1.7M</td>
                <td className="px-3 py-2 font-mono font-medium">$19.25</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  SKELETONS                                                    */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.skeletons")}>
        <SubSection title={t("pages.designGuide.subSection.individual")}>
          <div className="space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-8 w-full max-w-sm" />
            <Skeleton className="h-20 w-full" />
          </div>
        </SubSection>

        <SubSection title={t("pages.designGuide.subSection.pageSkeletonList")}>
          <div className="border border-border rounded-md p-4">
            <PageSkeleton variant="list" />
          </div>
        </SubSection>

        <SubSection title={t("pages.designGuide.subSection.pageSkeletonDetail")}>
          <div className="border border-border rounded-md p-4">
            <PageSkeleton variant="detail" />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  SEPARATOR                                                    */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.separator")}>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("pages.designGuide.separator.horizontal")}</p>
          <Separator />
          <div className="flex items-center gap-4 h-8">
            <span className="text-sm">{t("pages.designGuide.separator.left")}</span>
            <Separator orientation="vertical" />
            <span className="text-sm">{t("pages.designGuide.separator.right")}</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  ICON REFERENCE                                               */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.commonIcons")}>
        <div className="grid grid-cols-4 md:grid-cols-6 gap-4">
          {[
            [t("pages.designGuide.icon.inbox"), Inbox],
            [t("pages.designGuide.icon.listTodo"), ListTodo],
            [t("pages.designGuide.icon.circleDot"), CircleDot],
            [t("pages.designGuide.icon.hexagon"), Hexagon],
            [t("pages.designGuide.icon.target"), Target],
            [t("pages.designGuide.icon.layoutDashboard"), LayoutDashboard],
            [t("pages.designGuide.icon.bot"), Bot],
            [t("pages.designGuide.icon.dollarSign"), DollarSign],
            [t("pages.designGuide.icon.history"), History],
            [t("pages.designGuide.icon.search"), Search],
            [t("pages.designGuide.icon.plus"), Plus],
            [t("pages.designGuide.icon.trash2"), Trash2],
            [t("pages.designGuide.icon.settings"), Settings],
            [t("pages.designGuide.icon.user"), User],
            [t("pages.designGuide.icon.mail"), Mail],
            [t("pages.designGuide.icon.upload"), Upload],
            [t("pages.designGuide.icon.zap"), Zap],
          ].map(([name, Icon]) => {
            const LucideIcon = Icon as React.FC<{ className?: string }>;
            return (
              <div key={name as string} className="flex flex-col items-center gap-1.5 p-2">
                <LucideIcon className="h-4 w-4 text-muted-foreground" />
                <span className="text-[10px] text-muted-foreground font-mono">{name as string}</span>
              </div>
            );
          })}
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  KEYBOARD SHORTCUTS                                           */}
      {/* ============================================================ */}
      <Section title={t("pages.designGuide.section.keyboardShortcuts")}>
        <div className="border border-border rounded-md divide-y divide-border text-sm">
          {[
            ["Cmd+K / Ctrl+K", t("pages.designGuide.shortcuts.openPalette")],
            ["C", t("pages.designGuide.shortcuts.newIssue")],
            ["[", t("pages.designGuide.shortcuts.toggleSidebar")],
            ["]", t("pages.designGuide.shortcuts.toggleProperties")],
            ["Cmd+Enter / Ctrl+Enter", t("pages.designGuide.shortcuts.submitComment")],
          ].map(([key, desc]) => (
            <div key={key} className="flex items-center justify-between px-4 py-2">
              <span className="text-muted-foreground">{desc}</span>
              <kbd className="px-2 py-0.5 text-xs font-mono bg-muted rounded border border-border">
                {key}
              </kbd>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
