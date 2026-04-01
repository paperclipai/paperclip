import { useState } from "react";
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
import { useI18n } from "../i18n";
import { formatDate } from "../lib/utils";
import { designGuideText } from "../i18n/messages/demo";

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
  const { locale } = useI18n();
  const tr = (key: string) => designGuideText(locale, key);
  const copy = {
    pageTitle: tr("Design Guide"),
    pageSubtitle: tr("Every component, style, and pattern used across Paperclip."),
    componentCoverage: tr("Component Coverage"),
    componentCoverageDesc: tr("This page should be updated when new UI primitives or app-level patterns ship."),
    uiPrimitives: tr("UI primitives"),
    appComponents: tr("App components"),
    colors: tr("Colors"),
    core: tr("Core"),
    sidebar: tr("Sidebar"),
    chart: tr("Chart"),
    typography: tr("Typography"),
    radius: tr("Radius"),
    buttons: tr("Buttons"),
    variants: tr("Variants"),
    sizes: tr("Sizes"),
    iconButtons: tr("Icon buttons"),
    withIcons: tr("With icons"),
    states: tr("States"),
    badges: tr("Badges"),
    statusSystem: tr("Status System"),
    formElements: tr("Form Elements"),
    select: tr("Select"),
    dropdownMenu: tr("Dropdown Menu"),
    popover: tr("Popover"),
    collapsible: tr("Collapsible"),
    sheet: tr("Sheet"),
    scrollArea: tr("Scroll Area"),
    command: tr("Command (CMDK)"),
    breadcrumb: tr("Breadcrumb"),
    cards: tr("Cards"),
    tabs: tr("Tabs"),
    entityRows: tr("Entity Rows"),
    filterBar: tr("Filter Bar"),
    avatars: tr("Avatars"),
    identity: tr("Identity"),
    tooltips: tr("Tooltips"),
    dialog: tr("Dialog"),
    emptyState: tr("Empty State"),
    progressBars: tr("Progress Bars (Budget)"),
    logViewer: tr("Log Viewer"),
    propertyRowPattern: tr("Property Row Pattern"),
    navigationPatterns: tr("Navigation Patterns"),
    groupedListPattern: tr("Grouped List (Issues pattern)"),
    commentThreadPattern: tr("Comment Thread Pattern"),
    costTablePattern: tr("Cost Table Pattern"),
    skeletons: tr("Skeletons"),
    separator: tr("Separator"),
    commonIcons: tr("Common Icons (Lucide)"),
    keyboardShortcuts: tr("Keyboard Shortcuts"),
  };
    const [status, setStatus] = useState("todo");
  const [priority, setPriority] = useState("medium");
  const [selectValue, setSelectValue] = useState("in_progress");
  const [menuChecked, setMenuChecked] = useState(true);
  const [collapsibleOpen, setCollapsibleOpen] = useState(false);
  const [inlineText, setInlineText] = useState(tr("Click to edit this text"));
  const [inlineTitle, setInlineTitle] = useState(tr("Editable Title"));
  const [inlineDesc, setInlineDesc] = useState(
    tr("This is an editable description. Click to edit it — the textarea auto-sizes to fit the content without layout shift.")
  );
  const statusTokenLabel = (value: string) => ({
    backlog: tr("Backlog"),
    todo: tr("Todo"),
    in_progress: tr("In Progress"),
    in_review: tr("In Review"),
    done: tr("Done"),
    cancelled: tr("Cancelled"),
    blocked: tr("Blocked"),
    running: tr("Running"),
    active: tr("Active"),
    paused: tr("Paused"),
    error: tr("Error"),
    archived: tr("Archived"),
  } as Record<string, string>)[value] ?? value;
  const priorityTokenLabel = (value: string) => ({
    critical: tr("Critical"),
    high: tr("High"),
    medium: tr("Medium"),
    low: tr("Low"),
  } as Record<string, string>)[value] ?? value;
  const invocationTokenLabel = (value: string) => ({
    timer: tr("Timer"),
    assignment: tr("Assignment"),
    on_demand: tr("On demand"),
    automation: tr("Automation"),
  } as Record<string, string>)[value] ?? value;
  const samplePropertyDate = formatDate("2025-01-15T00:00:00Z");
  const sampleCommentDate = formatDate("2025-01-15T00:00:00Z");
  const sampleReplyDate = formatDate("2025-01-16T00:00:00Z");
  const [filters, setFilters] = useState<FilterValue[]>([
    { key: "status", label: tr("Status"), value: tr("Active") },
    { key: "priority", label: tr("Priority"), value: tr("High") },
  ]);

  return (
    <div className="space-y-10 max-w-4xl">
      {/* Page header */}
      <div>
        <h2 className="text-xl font-bold">{copy.pageTitle}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {copy.pageSubtitle}
        </p>
      </div>

      {/* ============================================================ */}
      {/*  COVERAGE                                                     */}
      {/* ============================================================ */}
      <Section title={copy.componentCoverage}>
        <p className="text-sm text-muted-foreground">
          {copy.componentCoverageDesc}
        </p>
        <div className="grid gap-6 md:grid-cols-2">
          <SubSection title={copy.uiPrimitives}>
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
          <SubSection title={copy.appComponents}>
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
      <Section title={copy.colors}>
        <SubSection title={copy.core}>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Swatch name={tr("Background")} cssVar="--background" />
            <Swatch name={tr("Foreground")} cssVar="--foreground" />
            <Swatch name={tr("Card")} cssVar="--card" />
            <Swatch name={tr("Primary")} cssVar="--primary" />
            <Swatch name={tr("Primary foreground")} cssVar="--primary-foreground" />
            <Swatch name={tr("Secondary")} cssVar="--secondary" />
            <Swatch name={tr("Muted")} cssVar="--muted" />
            <Swatch name={tr("Muted foreground")} cssVar="--muted-foreground" />
            <Swatch name={tr("Accent")} cssVar="--accent" />
            <Swatch name={tr("Destructive")} cssVar="--destructive" />
            <Swatch name={tr("Border")} cssVar="--border" />
            <Swatch name={tr("Ring")} cssVar="--ring" />
          </div>
        </SubSection>

        <SubSection title={copy.sidebar}>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Swatch name={tr("Sidebar")} cssVar="--sidebar" />
            <Swatch name={tr("Sidebar border")} cssVar="--sidebar-border" />
          </div>
        </SubSection>

        <SubSection title={copy.chart}>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Swatch name={tr("Chart 1")} cssVar="--chart-1" />
            <Swatch name={tr("Chart 2")} cssVar="--chart-2" />
            <Swatch name={tr("Chart 3")} cssVar="--chart-3" />
            <Swatch name={tr("Chart 4")} cssVar="--chart-4" />
            <Swatch name={tr("Chart 5")} cssVar="--chart-5" />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TYPOGRAPHY                                                   */}
      {/* ============================================================ */}
      <Section title={copy.typography}>
        <div className="space-y-3">
          <h2 className="text-xl font-bold">{tr("Page Title")} - text-xl font-bold</h2>
          <h2 className="text-lg font-semibold">{tr("Section Title")} - text-lg font-semibold</h2>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            {tr("Section Heading")} - text-sm font-semibold uppercase tracking-wide
          </h3>
          <p className="text-sm font-medium">{tr("Card Title")} - text-sm font-medium</p>
          <p className="text-sm font-semibold">{tr("Card Title Alt")} - text-sm font-semibold</p>
          <p className="text-sm">{tr("Body text")} - text-sm</p>
          <p className="text-sm text-muted-foreground">
            {tr("Muted description")} - text-sm text-muted-foreground
          </p>
          <p className="text-xs text-muted-foreground">
            {tr("Tiny label")} - text-xs text-muted-foreground
          </p>
          <p className="text-sm font-mono text-muted-foreground">
            {tr("Mono identifier")} - text-sm font-mono text-muted-foreground
          </p>
          <p className="text-2xl font-bold">{tr("Large stat")} - text-2xl font-bold</p>
          <p className="font-mono text-xs">{tr("Log/code text")} - font-mono text-xs</p>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  SPACING & RADIUS                                             */}
      {/* ============================================================ */}
      <Section title={copy.radius}>
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
              <span className="text-xs text-muted-foreground">{label === "full" ? tr("full") : label}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  BUTTONS                                                      */}
      {/* ============================================================ */}
      <Section title={copy.buttons}>
        <SubSection title={copy.variants}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="default">{tr("Default")}</Button>
            <Button variant="secondary">{tr("Secondary")}</Button>
            <Button variant="outline">{tr("Outline")}</Button>
            <Button variant="ghost">{tr("Ghost")}</Button>
            <Button variant="destructive">{tr("Destructive")}</Button>
            <Button variant="link">{tr("Link")}</Button>
          </div>
        </SubSection>

        <SubSection title={copy.sizes}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="xs">{tr("Extra Small")}</Button>
            <Button size="sm">{tr("Small")}</Button>
            <Button size="default">{tr("Default")}</Button>
            <Button size="lg">{tr("Large")}</Button>
          </div>
        </SubSection>

        <SubSection title={copy.iconButtons}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="ghost" size="icon-xs"><Search /></Button>
            <Button variant="ghost" size="icon-sm"><Search /></Button>
            <Button variant="outline" size="icon"><Search /></Button>
            <Button variant="outline" size="icon-lg"><Search /></Button>
          </div>
        </SubSection>

        <SubSection title={copy.withIcons}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button><Plus /> {tr("New Issue")}</Button>
            <Button variant="outline"><Upload /> {tr("Upload")}</Button>
            <Button variant="destructive"><Trash2 /> {tr("Delete")}</Button>
            <Button size="sm"><Plus /> {tr("Add")}</Button>
          </div>
        </SubSection>

        <SubSection title={copy.states}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button disabled>{tr("Disabled")}</Button>
            <Button variant="outline" disabled>{tr("Disabled Outline")}</Button>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  BADGES                                                       */}
      {/* ============================================================ */}
      <Section title={copy.badges}>
        <SubSection title={copy.variants}>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="default">{tr("Default")}</Badge>
            <Badge variant="secondary">{tr("Secondary")}</Badge>
            <Badge variant="outline">{tr("Outline")}</Badge>
            <Badge variant="destructive">{tr("Destructive")}</Badge>
            <Badge variant="ghost">{tr("Ghost")}</Badge>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  STATUS BADGES & ICONS                                        */}
      {/* ============================================================ */}
      <Section title={copy.statusSystem}>
        <SubSection title={tr("StatusBadge (all statuses)")}>
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

        <SubSection title={tr("StatusIcon (interactive)")}>
          <div className="flex items-center gap-3 flex-wrap">
            {["backlog", "todo", "in_progress", "in_review", "done", "cancelled", "blocked"].map(
              (s) => (
                <div key={s} className="flex items-center gap-1.5">
                  <StatusIcon status={s} />
                  <span className="text-xs text-muted-foreground">{statusTokenLabel(s)}</span>
                </div>
              )
            )}
          </div>
          <div className="flex items-center gap-2 mt-2">
            <StatusIcon status={status} onChange={setStatus} />
            <span className="text-sm">{tr("Click the icon to change status")} ({tr("current")}: {statusTokenLabel(status)})</span>
          </div>
        </SubSection>

        <SubSection title={tr("PriorityIcon (interactive)")}>
          <div className="flex items-center gap-3 flex-wrap">
            {["critical", "high", "medium", "low"].map((p) => (
              <div key={p} className="flex items-center gap-1.5">
                <PriorityIcon priority={p} />
                <span className="text-xs text-muted-foreground">{priorityTokenLabel(p)}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-2">
            <PriorityIcon priority={priority} onChange={setPriority} />
            <span className="text-sm">{tr("Click the icon to change")} ({tr("current")}: {priorityTokenLabel(priority)})</span>
          </div>
        </SubSection>

        <SubSection title={tr("Agent status dots")}>
          <div className="flex items-center gap-4 flex-wrap">
            {(["running", "active", "paused", "error", "archived"] as const).map((label) => (
              <div key={label} className="flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  <span className={`inline-flex h-full w-full rounded-full ${agentStatusDot[label] ?? agentStatusDotDefault}`} />
                </span>
                <span className="text-xs text-muted-foreground">{statusTokenLabel(label)}</span>
              </div>
            ))}
          </div>
        </SubSection>

        <SubSection title={tr("Run invocation badges")}>
          <div className="flex items-center gap-2 flex-wrap">
            {[
              ["timer", "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300"],
              ["assignment", "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300"],
              ["on_demand", "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300"],
              ["automation", "bg-muted text-muted-foreground"],
            ].map(([label, cls]) => (
              <span key={label} className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
                {invocationTokenLabel(label)}
              </span>
            ))}
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  FORM ELEMENTS                                                */}
      {/* ============================================================ */}
      <Section title={copy.formElements}>
          <div className="grid gap-6 md:grid-cols-2">
          <SubSection title={tr("Input")}>
            <Input placeholder={tr("Default input")} />
            <Input placeholder={tr("Disabled input")} disabled className="mt-2" />
          </SubSection>

          <SubSection title={tr("Textarea")}>
            <Textarea placeholder={tr("Write something...")} />
          </SubSection>

          <SubSection title={tr("Checkbox & Label")}>
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Checkbox id="check1" defaultChecked />
                <Label htmlFor="check1">{tr("Checked item")}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="check2" />
                <Label htmlFor="check2">{tr("Unchecked item")}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="check3" disabled />
                <Label htmlFor="check3">{tr("Disabled item")}</Label>
              </div>
            </div>
          </SubSection>

          <SubSection title={tr("Inline Editor")}>
            <div className="space-y-4">
              <div>
                <p className="text-xs text-muted-foreground mb-1">{tr("Title (single-line)")}</p>
                <InlineEditor
                  value={inlineTitle}
                  onSave={setInlineTitle}
                  as="h2"
                  className="text-xl font-bold"
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">{tr("Body text (single-line)")}</p>
                <InlineEditor
                  value={inlineText}
                  onSave={setInlineText}
                  as="p"
                  className="text-sm"
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">{tr("Description (multiline, auto-sizing)")}</p>
                <InlineEditor
                  value={inlineDesc}
                  onSave={setInlineDesc}
                  as="p"
                  className="text-sm text-muted-foreground"
                  placeholder={tr("Add a description...")}
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
      <Section title={copy.select}>
        <div className="grid gap-6 md:grid-cols-2">
          <SubSection title={tr("Default size")}>
            <Select value={selectValue} onValueChange={setSelectValue}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={tr("Select status")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="backlog">{tr("Backlog")}</SelectItem>
                <SelectItem value="todo">{tr("Todo")}</SelectItem>
                <SelectItem value="in_progress">{tr("In Progress")}</SelectItem>
                <SelectItem value="in_review">{tr("In Review")}</SelectItem>
                <SelectItem value="done">{tr("Done")}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{tr("Current value")}: {selectValue}</p>
          </SubSection>
          <SubSection title={tr("Small trigger")}>
            <Select defaultValue="high">
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="critical">{tr("Critical")}</SelectItem>
                <SelectItem value="high">{tr("High")}</SelectItem>
                <SelectItem value="medium">{tr("Medium")}</SelectItem>
                <SelectItem value="low">{tr("Low")}</SelectItem>
              </SelectContent>
            </Select>
          </SubSection>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  DROPDOWN MENU                                                */}
      {/* ============================================================ */}
      <Section title={copy.dropdownMenu}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {tr("Quick Actions")}
              <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem>
              <Check className="h-4 w-4" />
              {tr("Mark as done")}
              <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem>
              <BookOpen className="h-4 w-4" />
              {tr("Open docs")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={menuChecked}
              onCheckedChange={(value) => setMenuChecked(value === true)}
            >
              {tr("Watch issue")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuItem variant="destructive">
              <Trash2 className="h-4 w-4" />
              {tr("Delete issue")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Section>

      {/* ============================================================ */}
      {/*  POPOVER                                                      */}
      {/* ============================================================ */}
      <Section title={copy.popover}>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">{tr("Open Popover")}</Button>
          </PopoverTrigger>
          <PopoverContent className="space-y-2">
            <p className="text-sm font-medium">{tr("Agent heartbeat")}</p>
            <p className="text-xs text-muted-foreground">
              {tr("Last run succeeded 24s ago. Next timer run in 9m.")}
            </p>
            <Button size="xs">{tr("Wake now")}</Button>
          </PopoverContent>
        </Popover>
      </Section>

      {/* ============================================================ */}
      {/*  COLLAPSIBLE                                                  */}
      {/* ============================================================ */}
      <Section title={copy.collapsible}>
        <Collapsible open={collapsibleOpen} onOpenChange={setCollapsibleOpen} className="space-y-2">
          <CollapsibleTrigger asChild>
            <Button variant="outline" size="sm">
              {collapsibleOpen ? tr("Hide") : tr("Show")} {tr("advanced filters")}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="rounded-md border border-border p-3">
            <div className="space-y-2">
              <Label htmlFor="owner-filter">{tr("Owner")}</Label>
              <Input id="owner-filter" placeholder={tr("Filter by agent name")} />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </Section>

      {/* ============================================================ */}
      {/*  SHEET                                                        */}
      {/* ============================================================ */}
      <Section title={copy.sheet}>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" size="sm">{tr("Open Side Panel")}</Button>
          </SheetTrigger>
          <SheetContent side="right">
            <SheetHeader>
              <SheetTitle>{tr("Issue Properties")}</SheetTitle>
              <SheetDescription>{tr("Edit metadata without leaving the current page.")}</SheetDescription>
            </SheetHeader>
            <div className="space-y-4 px-4">
              <div className="space-y-1">
                <Label htmlFor="sheet-title">{tr("Title")}</Label>
                <Input id="sheet-title" defaultValue={tr("Improve onboarding docs")} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sheet-description">{tr("Description")}</Label>
                <Textarea id="sheet-description" defaultValue={tr("Capture setup pitfalls and screenshots.")} />
              </div>
            </div>
            <SheetFooter>
              <Button variant="outline">{tr("Cancel")}</Button>
              <Button>{tr("Save")}</Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </Section>

      {/* ============================================================ */}
      {/*  SCROLL AREA                                                  */}
      {/* ============================================================ */}
      <Section title={copy.scrollArea}>
        <ScrollArea className="h-36 rounded-md border border-border">
          <div className="space-y-2 p-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="rounded-md border border-border p-2 text-sm">
                {tr("Heartbeat run")} #{i + 1}: {tr("completed successfully")}
              </div>
            ))}
          </div>
        </ScrollArea>
      </Section>

      {/* ============================================================ */}
      {/*  COMMAND                                                      */}
      {/* ============================================================ */}
      <Section title={copy.command}>
        <div className="rounded-md border border-border">
          <Command>
            <CommandInput placeholder={tr("Type a command or search...")} />
            <CommandList>
              <CommandEmpty>{tr("No results found.")}</CommandEmpty>
              <CommandGroup heading={tr("Pages")}>
                <CommandItem>
                  <LayoutDashboard className="h-4 w-4" />
                  {tr("Dashboard")}
                </CommandItem>
                <CommandItem>
                  <CircleDot className="h-4 w-4" />
                  {tr("Issues")}
                </CommandItem>
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading={tr("Actions")}>
                <CommandItem>
                  <CommandIcon className="h-4 w-4" />
                  {tr("Open command palette")}
                </CommandItem>
                <CommandItem>
                  <Plus className="h-4 w-4" />
                  {tr("Create new issue")}
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  BREADCRUMB                                                   */}
      {/* ============================================================ */}
      <Section title={copy.breadcrumb}>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="#">{tr("Projects")}</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href="#">{tr("Paperclip App")}</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{tr("Issue List")}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </Section>

      {/* ============================================================ */}
      {/*  CARDS                                                        */}
      {/* ============================================================ */}
      <Section title={copy.cards}>
        <SubSection title={tr("Standard Card")}>
          <Card>
            <CardHeader>
              <CardTitle>{tr("Card Title")}</CardTitle>
              <CardDescription>{tr("Card description with supporting text.")}</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm">{tr("Card content goes here. This is the main body area.")}</p>
            </CardContent>
            <CardFooter className="gap-2">
              <Button size="sm">{tr("Action")}</Button>
              <Button variant="outline" size="sm">{tr("Cancel")}</Button>
            </CardFooter>
          </Card>
        </SubSection>

        <SubSection title={tr("Metric Cards")}>
          <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
            <MetricCard icon={Bot} value={12} label={tr("Active Agents")} description={tr("+3 this week")} />
            <MetricCard icon={CircleDot} value={48} label={tr("Open Issues")} />
            <MetricCard icon={DollarSign} value="$1,234" label={tr("Monthly Cost")} description={tr("Under budget")} />
            <MetricCard icon={Zap} value="99.9%" label={tr("Uptime")} />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TABS                                                         */}
      {/* ============================================================ */}
      <Section title={copy.tabs}>
        <SubSection title={tr("Default (pill) variant")}>
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">{tr("Overview")}</TabsTrigger>
              <TabsTrigger value="runs">{tr("Runs")}</TabsTrigger>
              <TabsTrigger value="config">{tr("Config")}</TabsTrigger>
              <TabsTrigger value="costs">{tr("Costs")}</TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              <p className="text-sm text-muted-foreground py-4">{tr("Overview tab content.")}</p>
            </TabsContent>
            <TabsContent value="runs">
              <p className="text-sm text-muted-foreground py-4">{tr("Runs tab content.")}</p>
            </TabsContent>
            <TabsContent value="config">
              <p className="text-sm text-muted-foreground py-4">{tr("Config tab content.")}</p>
            </TabsContent>
            <TabsContent value="costs">
              <p className="text-sm text-muted-foreground py-4">{tr("Costs tab content.")}</p>
            </TabsContent>
          </Tabs>
        </SubSection>

        <SubSection title={tr("Line variant")}>
          <Tabs defaultValue="summary">
            <TabsList variant="line">
              <TabsTrigger value="summary">{tr("Summary")}</TabsTrigger>
              <TabsTrigger value="details">{tr("Details")}</TabsTrigger>
              <TabsTrigger value="comments">{tr("Comments")}</TabsTrigger>
            </TabsList>
            <TabsContent value="summary">
              <p className="text-sm text-muted-foreground py-4">{tr("Summary content with underline tabs.")}</p>
            </TabsContent>
            <TabsContent value="details">
              <p className="text-sm text-muted-foreground py-4">{tr("Details content.")}</p>
            </TabsContent>
            <TabsContent value="comments">
              <p className="text-sm text-muted-foreground py-4">{tr("Comments content.")}</p>
            </TabsContent>
          </Tabs>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  ENTITY ROWS                                                  */}
      {/* ============================================================ */}
      <Section title={copy.entityRows}>
        <div className="border border-border rounded-md">
          <EntityRow
            leading={
              <>
                <StatusIcon status="in_progress" />
                <PriorityIcon priority="high" />
              </>
            }
            identifier="PAP-001"
            title={tr("Implement authentication flow")}
            subtitle={tr("Assigned to Agent Alpha")}
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
            title={tr("Set up CI/CD pipeline")}
            subtitle={tr("Completed 2 days ago")}
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
            title={tr("Write API documentation")}
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
            title={tr("Deploy to production")}
            subtitle={tr("Blocked by PAP-001")}
            trailing={<StatusBadge status="blocked" />}
            selected
          />
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  FILTER BAR                                                   */}
      {/* ============================================================ */}
      <Section title={copy.filterBar}>
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
                { key: "status", label: tr("Status"), value: tr("Active") },
                { key: "priority", label: tr("Priority"), value: tr("High") },
              ])
            }
          >
            {tr("Reset filters")}
          </Button>
        )}
      </Section>

      {/* ============================================================ */}
      {/*  AVATARS                                                      */}
      {/* ============================================================ */}
      <Section title={copy.avatars}>
        <SubSection title={tr("Sizes")}>
          <div className="flex items-center gap-3">
            <Avatar size="sm"><AvatarFallback>SM</AvatarFallback></Avatar>
            <Avatar><AvatarFallback>DF</AvatarFallback></Avatar>
            <Avatar size="lg"><AvatarFallback>LG</AvatarFallback></Avatar>
          </div>
        </SubSection>

        <SubSection title={tr("Group")}>
          <AvatarGroup>
            <Avatar><AvatarFallback>A1</AvatarFallback></Avatar>
            <Avatar><AvatarFallback>A2</AvatarFallback></Avatar>
            <Avatar><AvatarFallback>A3</AvatarFallback></Avatar>
            <AvatarGroupCount>+5</AvatarGroupCount>
          </AvatarGroup>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  IDENTITY                                                     */}
      {/* ============================================================ */}
      <Section title={copy.identity}>
        <SubSection title={tr("Sizes")}>
          <div className="flex items-center gap-6">
            <Identity name={tr("Agent Alpha")} size="sm" />
            <Identity name={tr("Agent Alpha")} />
            <Identity name={tr("Agent Alpha")} size="lg" />
          </div>
        </SubSection>

        <SubSection title={tr("Initials derivation")}>
          <div className="flex flex-col gap-2">
            <Identity name={tr("CEO Agent")} size="sm" />
            <Identity name={tr("Alpha")} size="sm" />
            <Identity name={tr("Quality Assurance Lead")} size="sm" />
          </div>
        </SubSection>

        <SubSection title={tr("Custom initials")}>
          <Identity name={tr("Backend Service")} initials="BS" size="sm" />
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TOOLTIPS                                                     */}
      {/* ============================================================ */}
      <Section title={copy.tooltips}>
        <div className="flex items-center gap-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm">{tr("Hover me")}</Button>
            </TooltipTrigger>
            <TooltipContent>{tr("This is a tooltip")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm"><Settings /></Button>
            </TooltipTrigger>
            <TooltipContent>{tr("Settings")}</TooltipContent>
          </Tooltip>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  DIALOG                                                       */}
      {/* ============================================================ */}
      <Section title={copy.dialog}>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline">{tr("Open Dialog")}</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{tr("Dialog Title")}</DialogTitle>
              <DialogDescription>
                {tr("This is a sample dialog showing the standard layout with header, content, and footer.")}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>{tr("Name")}</Label>
                <Input placeholder={tr("Enter a name")} className="mt-1.5" />
              </div>
              <div>
                <Label>{tr("Description")}</Label>
                <Textarea placeholder={tr("Describe...")} className="mt-1.5" />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline">{tr("Cancel")}</Button>
              <Button>{tr("Save")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Section>

      {/* ============================================================ */}
      {/*  EMPTY STATE                                                  */}
      {/* ============================================================ */}
      <Section title={copy.emptyState}>
        <div className="border border-border rounded-md">
          <EmptyState
            icon={Inbox}
            message={tr("No items to show. Create your first one to get started.")}
            action={tr("Create Item")}
            onAction={() => {}}
          />
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  PROGRESS BARS                                                */}
      {/* ============================================================ */}
      <Section title={copy.progressBars}>
        <div className="space-y-3">
          {[
            { label: tr("Under budget (40%)"), pct: 40, color: "bg-green-400" },
            { label: tr("Warning (75%)"), pct: 75, color: "bg-yellow-400" },
            { label: tr("Over budget (95%)"), pct: 95, color: "bg-red-400" },
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
      <Section title={copy.logViewer}>
        <div className="bg-neutral-950 rounded-lg p-3 font-mono text-xs max-h-80 overflow-y-auto">
          <div className="text-foreground">[12:00:01] INFO  {tr("Agent started successfully")}</div>
          <div className="text-foreground">[12:00:02] INFO  {tr("Processing task PAP-001")}</div>
          <div className="text-yellow-400">[12:00:05] WARN  {tr("Rate limit approaching (80%)")}</div>
          <div className="text-foreground">[12:00:08] INFO  {tr("Task PAP-001 completed")}</div>
          <div className="text-red-400">[12:00:12] ERROR {tr("Connection timeout to upstream service")}</div>
          <div className="text-blue-300">[12:00:12] SYS   {tr("Retrying connection in 5s...")}</div>
          <div className="text-foreground">[12:00:17] INFO  {tr("Reconnected successfully")}</div>
          <div className="flex items-center gap-1.5">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-cyan-400 animate-pulse" />
              <span className="inline-flex h-full w-full rounded-full bg-cyan-400" />
            </span>
            <span className="text-cyan-400">{tr("Live")}</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  PROPERTY ROW PATTERN                                         */}
      {/* ============================================================ */}
      <Section title={copy.propertyRowPattern}>
        <div className="border border-border rounded-md p-4 space-y-1 max-w-sm">
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">{tr("Status")}</span>
            <StatusBadge status="active" />
          </div>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">{tr("Priority")}</span>
            <PriorityIcon priority="high" />
          </div>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">{tr("Assignee")}</span>
            <div className="flex items-center gap-1.5">
              <Avatar size="sm"><AvatarFallback>A</AvatarFallback></Avatar>
              <span className="text-xs">{tr("Agent Alpha")}</span>
            </div>
          </div>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">{tr("Created")}</span>
            <span className="text-xs">{samplePropertyDate}</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  NAVIGATION PATTERNS                                          */}
      {/* ============================================================ */}
      <Section title={copy.navigationPatterns}>
        <SubSection title={tr("Sidebar nav items")}>
          <div className="w-60 border border-border rounded-md p-3 space-y-0.5 bg-card">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium bg-accent text-accent-foreground">
              <LayoutDashboard className="h-4 w-4" />
              {tr("Dashboard")}
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <CircleDot className="h-4 w-4" />
              {tr("Issues")}
              <span className="ml-auto text-xs bg-primary text-primary-foreground rounded-full px-1.5 py-0.5">
                12
              </span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <Bot className="h-4 w-4" />
              {tr("Agents")}
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <Hexagon className="h-4 w-4" />
              {tr("Projects")}
            </div>
          </div>
        </SubSection>

        <SubSection title={tr("View toggle")}>
          <div className="flex items-center border border-border rounded-md w-fit">
            <button className="px-3 py-1.5 text-xs font-medium bg-accent text-foreground rounded-l-md">
              <ListTodo className="h-3.5 w-3.5 inline mr-1" />
              {tr("List")}
            </button>
            <button className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent/50 rounded-r-md">
              <Target className="h-3.5 w-3.5 inline mr-1" />
              {tr("Org")}
            </button>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  GROUPED LIST (Issues pattern)                                */}
      {/* ============================================================ */}
      <Section title={copy.groupedListPattern}>
        <div>
          <div className="flex items-center gap-2 px-4 py-2 bg-muted/50 rounded-t-md">
            <StatusIcon status="in_progress" />
            <span className="text-sm font-medium">{tr("In Progress")}</span>
            <span className="text-xs text-muted-foreground ml-1">2</span>
          </div>
          <div className="border border-border rounded-b-md">
            <EntityRow
              leading={<PriorityIcon priority="high" />}
              identifier="PAP-101"
              title={tr("Build agent heartbeat system")}
              onClick={() => {}}
            />
            <EntityRow
              leading={<PriorityIcon priority="medium" />}
              identifier="PAP-102"
              title={tr("Add cost tracking dashboard")}
              onClick={() => {}}
            />
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  COMMENT THREAD PATTERN                                       */}
      {/* ============================================================ */}
      <Section title={copy.commentThreadPattern}>
        <div className="space-y-3 max-w-2xl">
          <h3 className="text-sm font-semibold">{tr("Comments")} (2)</h3>
          <div className="space-y-3">
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-muted-foreground">{tr("Agent")}</span>
                <span className="text-xs text-muted-foreground">{sampleCommentDate}</span>
              </div>
              <p className="text-sm">{tr("Started working on the authentication module. Will need API keys configured.")}</p>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-muted-foreground">{tr("Human")}</span>
                <span className="text-xs text-muted-foreground">{sampleReplyDate}</span>
              </div>
              <p className="text-sm">{tr("API keys have been added to the vault. Please proceed.")}</p>
            </div>
          </div>
          <div className="space-y-2">
            <Textarea placeholder={tr("Leave a comment...")} rows={3} />
            <Button size="sm">{tr("Comment")}</Button>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  COST TABLE PATTERN                                           */}
      {/* ============================================================ */}
      <Section title={copy.costTablePattern}>
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead className="border-b border-border bg-accent/20">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">{tr("Model")}</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">{tr("Tokens")}</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">{tr("Cost")}</th>
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
                <td className="px-3 py-2 font-medium">{tr("Total")}</td>
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
      <Section title={copy.skeletons}>
        <SubSection title={tr("Individual")}>
          <div className="space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-8 w-full max-w-sm" />
            <Skeleton className="h-20 w-full" />
          </div>
        </SubSection>

        <SubSection title={tr("Page Skeleton (list)")}>
          <div className="border border-border rounded-md p-4">
            <PageSkeleton variant="list" />
          </div>
        </SubSection>

        <SubSection title={tr("Page Skeleton (detail)")}>
          <div className="border border-border rounded-md p-4">
            <PageSkeleton variant="detail" />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  SEPARATOR                                                    */}
      {/* ============================================================ */}
      <Section title={copy.separator}>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{tr("Horizontal")}</p>
          <Separator />
          <div className="flex items-center gap-4 h-8">
            <span className="text-sm">{tr("Left")}</span>
            <Separator orientation="vertical" />
            <span className="text-sm">{tr("Right")}</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  ICON REFERENCE                                               */}
      {/* ============================================================ */}
      <Section title={copy.commonIcons}>
        <div className="grid grid-cols-4 md:grid-cols-6 gap-4">
          {[
            ["Inbox", Inbox],
            ["ListTodo", ListTodo],
            ["CircleDot", CircleDot],
            ["Hexagon", Hexagon],
            ["Target", Target],
            ["LayoutDashboard", LayoutDashboard],
            ["Bot", Bot],
            ["DollarSign", DollarSign],
            ["History", History],
            ["Search", Search],
            ["Plus", Plus],
            ["Trash2", Trash2],
            ["Settings", Settings],
            ["User", User],
            ["Mail", Mail],
            ["Upload", Upload],
            ["Zap", Zap],
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
      <Section title={copy.keyboardShortcuts}>
        <div className="border border-border rounded-md divide-y divide-border text-sm">
          {[
            ["Cmd+K / Ctrl+K", "Open Command Palette"],
            ["C", "New Issue (outside inputs)"],
            ["[", "Toggle Sidebar"],
            ["]", "Toggle Properties Panel"],

            ["Cmd+Enter / Ctrl+Enter", "Submit markdown comment"],
          ].map(([key, desc]) => (
            <div key={key} className="flex items-center justify-between px-4 py-2">
              <span className="text-muted-foreground">
                {desc === "Open Command Palette"
                  ? tr("Open Command Palette")
                  : desc === "New Issue (outside inputs)"
                    ? tr("New Issue (outside inputs)")
                    : desc === "Toggle Sidebar"
                      ? tr("Toggle Sidebar")
                      : desc === "Toggle Properties Panel"
                        ? tr("Toggle Properties Panel")
                        : tr("Submit markdown comment")}
              </span>
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
