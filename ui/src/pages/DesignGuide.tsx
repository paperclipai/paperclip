import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/i18n/runtime";
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
  const { t } = useI18n();
  const [status, setStatus] = useState("todo");
  const [priority, setPriority] = useState("medium");
  const [selectValue, setSelectValue] = useState("in_progress");
  const [menuChecked, setMenuChecked] = useState(true);
  const [collapsibleOpen, setCollapsibleOpen] = useState(false);
  const defaultInlineText = t("designGuide.inlineEditor.body.default", "Click to edit this text");
  const defaultInlineTitle = t("designGuide.inlineEditor.title.default", "Editable Title");
  const defaultInlineDesc = t(
    "designGuide.inlineEditor.description.default",
    "This is an editable description. Click to edit it — the textarea auto-sizes to fit the content without layout shift.",
  );
  const defaultFilters = useMemo<FilterValue[]>(() => [
    { key: "status", label: t("designGuide.filterBar.statusLabel", "Status"), value: t("designGuide.filterBar.statusValue", "Active") },
    { key: "priority", label: t("designGuide.filterBar.priorityLabel", "Priority"), value: t("designGuide.filterBar.priorityValue", "High") },
  ], [t]);
  const [inlineText, setInlineText] = useState(defaultInlineText);
  const [inlineTitle, setInlineTitle] = useState(defaultInlineTitle);
  const [inlineDesc, setInlineDesc] = useState(defaultInlineDesc);
  const [filters, setFilters] = useState<FilterValue[]>(defaultFilters);

  useEffect(() => {
    setInlineText(defaultInlineText);
    setInlineTitle(defaultInlineTitle);
    setInlineDesc(defaultInlineDesc);
    setFilters(defaultFilters);
  }, [defaultFilters, defaultInlineDesc, defaultInlineText, defaultInlineTitle]);

  return (
    <div className="space-y-10 max-w-4xl">
      {/* Page header */}
      <div>
        <h2 className="text-xl font-bold">{t("designGuide.header.title", "Design Guide")}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t("designGuide.header.description", "Every component, style, and pattern used across Paperclip.")}
        </p>
      </div>

      {/* ============================================================ */}
      {/*  COVERAGE                                                     */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.coverage.title", "Component Coverage")}>
        <p className="text-sm text-muted-foreground">
          {t("designGuide.sections.coverage.description", "This page should be updated when new UI primitives or app-level patterns ship.")}
        </p>
        <div className="grid gap-6 md:grid-cols-2">
          <SubSection title={t("designGuide.sections.coverage.uiPrimitives", "UI primitives")}>
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
          <SubSection title={t("designGuide.sections.coverage.appComponents", "App components")}>
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
      <Section title={t("designGuide.sections.colors.title", "Colors")}>
        <SubSection title={t("designGuide.sections.colors.core", "Core")}>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Swatch name="Background" cssVar="--background" />
            <Swatch name="Foreground" cssVar="--foreground" />
            <Swatch name="Card" cssVar="--card" />
            <Swatch name="Primary" cssVar="--primary" />
            <Swatch name="Primary foreground" cssVar="--primary-foreground" />
            <Swatch name="Secondary" cssVar="--secondary" />
            <Swatch name="Muted" cssVar="--muted" />
            <Swatch name="Muted foreground" cssVar="--muted-foreground" />
            <Swatch name="Accent" cssVar="--accent" />
            <Swatch name="Destructive" cssVar="--destructive" />
            <Swatch name="Border" cssVar="--border" />
            <Swatch name="Ring" cssVar="--ring" />
          </div>
        </SubSection>

        <SubSection title={t("designGuide.sections.colors.sidebar", "Sidebar")}>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Swatch name="Sidebar" cssVar="--sidebar" />
            <Swatch name="Sidebar border" cssVar="--sidebar-border" />
          </div>
        </SubSection>

        <SubSection title={t("designGuide.sections.colors.chart", "Chart")}>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Swatch name="Chart 1" cssVar="--chart-1" />
            <Swatch name="Chart 2" cssVar="--chart-2" />
            <Swatch name="Chart 3" cssVar="--chart-3" />
            <Swatch name="Chart 4" cssVar="--chart-4" />
            <Swatch name="Chart 5" cssVar="--chart-5" />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TYPOGRAPHY                                                   */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.typography.title", "Typography")}>
        <div className="space-y-3">
          <h2 className="text-xl font-bold">{t("designGuide.sections.typography.pageTitle", "Page Title — text-xl font-bold")}</h2>
          <h2 className="text-lg font-semibold">{t("designGuide.sections.typography.sectionTitle", "Section Title — text-lg font-semibold")}</h2>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            {t("designGuide.sections.typography.sectionHeading", "Section Heading — text-sm font-semibold uppercase tracking-wide")}
          </h3>
          <p className="text-sm font-medium">{t("designGuide.sections.typography.cardTitle", "Card Title — text-sm font-medium")}</p>
          <p className="text-sm font-semibold">{t("designGuide.sections.typography.cardTitleAlt", "Card Title Alt — text-sm font-semibold")}</p>
          <p className="text-sm">{t("designGuide.sections.typography.bodyText", "Body text — text-sm")}</p>
          <p className="text-sm text-muted-foreground">
            {t("designGuide.sections.typography.mutedDescription", "Muted description — text-sm text-muted-foreground")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("designGuide.sections.typography.tinyLabel", "Tiny label — text-xs text-muted-foreground")}
          </p>
          <p className="text-sm font-mono text-muted-foreground">
            {t("designGuide.sections.typography.monoIdentifier", "Mono identifier — text-sm font-mono text-muted-foreground")}
          </p>
          <p className="text-2xl font-bold">{t("designGuide.sections.typography.largeStat", "Large stat — text-2xl font-bold")}</p>
          <p className="font-mono text-xs">{t("designGuide.sections.typography.logCodeText", "Log/code text — font-mono text-xs")}</p>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  SPACING & RADIUS                                             */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.radius.title", "Radius")}>
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
      <Section title={t("designGuide.sections.buttons.title", "Buttons")}>
        <SubSection title={t("designGuide.sections.buttons.variants", "Variants")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="default">{t("designGuide.sections.buttons.default", "Default")}</Button>
            <Button variant="secondary">{t("designGuide.sections.buttons.secondary", "Secondary")}</Button>
            <Button variant="outline">{t("designGuide.sections.buttons.outline", "Outline")}</Button>
            <Button variant="ghost">{t("designGuide.sections.buttons.ghost", "Ghost")}</Button>
            <Button variant="destructive">{t("designGuide.sections.buttons.destructive", "Destructive")}</Button>
            <Button variant="link">{t("designGuide.sections.buttons.link", "Link")}</Button>
          </div>
        </SubSection>

        <SubSection title={t("designGuide.sections.buttons.sizes", "Sizes")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="xs">{t("designGuide.sections.buttons.extraSmall", "Extra Small")}</Button>
            <Button size="sm">{t("designGuide.sections.buttons.small", "Small")}</Button>
            <Button size="default">{t("designGuide.sections.buttons.default", "Default")}</Button>
            <Button size="lg">{t("designGuide.sections.buttons.large", "Large")}</Button>
          </div>
        </SubSection>

        <SubSection title={t("designGuide.sections.buttons.iconButtons", "Icon buttons")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="ghost" size="icon-xs"><Search /></Button>
            <Button variant="ghost" size="icon-sm"><Search /></Button>
            <Button variant="outline" size="icon"><Search /></Button>
            <Button variant="outline" size="icon-lg"><Search /></Button>
          </div>
        </SubSection>

        <SubSection title={t("designGuide.sections.buttons.withIcons", "With icons")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button><Plus /> {t("designGuide.sections.buttons.newIssue", "New Issue")}</Button>
            <Button variant="outline"><Upload /> {t("designGuide.sections.buttons.upload", "Upload")}</Button>
            <Button variant="destructive"><Trash2 /> {t("designGuide.sections.buttons.delete", "Delete")}</Button>
            <Button size="sm"><Plus /> {t("designGuide.sections.buttons.add", "Add")}</Button>
          </div>
        </SubSection>

        <SubSection title={t("designGuide.sections.buttons.states", "States")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button disabled>{t("designGuide.sections.buttons.disabled", "Disabled")}</Button>
            <Button variant="outline" disabled>{t("designGuide.sections.buttons.disabledOutline", "Disabled Outline")}</Button>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  BADGES                                                       */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.badges.title", "Badges")}>
        <SubSection title={t("designGuide.sections.badges.variants", "Variants")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="default">{t("designGuide.sections.badges.default", "Default")}</Badge>
            <Badge variant="secondary">{t("designGuide.sections.badges.secondary", "Secondary")}</Badge>
            <Badge variant="outline">{t("designGuide.sections.badges.outline", "Outline")}</Badge>
            <Badge variant="destructive">{t("designGuide.sections.badges.destructive", "Destructive")}</Badge>
            <Badge variant="ghost">{t("designGuide.sections.badges.ghost", "Ghost")}</Badge>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  STATUS BADGES & ICONS                                        */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.statusSystem.title", "Status System")}>
        <SubSection title={t("designGuide.sections.statusSystem.statusBadgeAllStatuses", "StatusBadge (all statuses)")}>
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

        <SubSection title={t("designGuide.sections.statusSystem.statusIconInteractive", "StatusIcon (interactive)")}>
          <div className="flex items-center gap-3 flex-wrap">
            {["backlog", "todo", "in_progress", "in_review", "done", "cancelled", "blocked"].map(
              (s) => (
                <div key={s} className="flex items-center gap-1.5">
                  <StatusIcon status={s} />
                  <span className="text-xs text-muted-foreground">{t(`designGuide.sections.statusSystem.status.${s}` as Parameters<typeof t>[0], s)}</span>
                </div>
              )
            )}
          </div>
          <div className="flex items-center gap-2 mt-2">
            <StatusIcon status={status} onChange={setStatus} />
            <span className="text-sm">{t("designGuide.sections.statusSystem.clickToChangeStatus", "Click the icon to change status (current: {{status}})", { status })}</span>
          </div>
        </SubSection>

        <SubSection title={t("designGuide.sections.statusSystem.priorityIconInteractive", "PriorityIcon (interactive)")}>
          <div className="flex items-center gap-3 flex-wrap">
            {["critical", "high", "medium", "low"].map((p) => (
              <div key={p} className="flex items-center gap-1.5">
                <PriorityIcon priority={p} />
                <span className="text-xs text-muted-foreground">{t(`designGuide.sections.statusSystem.priority.${p}` as Parameters<typeof t>[0], p)}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-2">
            <PriorityIcon priority={priority} onChange={setPriority} />
            <span className="text-sm">{t("designGuide.sections.statusSystem.clickToChangePriority", "Click the icon to change (current: {{priority}})", { priority })}</span>
          </div>
        </SubSection>

        <SubSection title={t("designGuide.sections.statusSystem.agentStatusDots", "Agent status dots")}>
          <div className="flex items-center gap-4 flex-wrap">
            {(["running", "active", "paused", "error", "archived"] as const).map((label) => (
              <div key={label} className="flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  <span className={`inline-flex h-full w-full rounded-full ${agentStatusDot[label] ?? agentStatusDotDefault}`} />
                </span>
                <span className="text-xs text-muted-foreground">{t(`designGuide.sections.statusSystem.agentStatus.${label}` as Parameters<typeof t>[0], label)}</span>
              </div>
            ))}
          </div>
        </SubSection>

        <SubSection title={t("designGuide.sections.statusSystem.runInvocationBadges", "Run invocation badges")}>
          <div className="flex items-center gap-2 flex-wrap">
            {[
              ["timer", "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300"],
              ["assignment", "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300"],
              ["on_demand", "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300"],
              ["automation", "bg-muted text-muted-foreground"],
            ].map(([label, cls]) => (
              <span key={label} className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
                {t(`designGuide.sections.statusSystem.runInvocation.${label}` as Parameters<typeof t>[0], label)}
              </span>
            ))}
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  FORM ELEMENTS                                                */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.formElements.title", "Form Elements")}>
        <div className="grid gap-6 md:grid-cols-2">
          <SubSection title={t("designGuide.sections.formElements.input", "Input")}>
            <Input placeholder={t("designGuide.sections.formElements.defaultInput", "Default input")} />
            <Input placeholder={t("designGuide.sections.formElements.disabledInput", "Disabled input")} disabled className="mt-2" />
          </SubSection>

          <SubSection title={t("designGuide.sections.formElements.textarea", "Textarea")}>
            <Textarea placeholder={t("designGuide.sections.formElements.writeSomething", "Write something...")} />
          </SubSection>

          <SubSection title={t("designGuide.sections.formElements.checkboxAndLabel", "Checkbox & Label")}>
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Checkbox id="check1" defaultChecked />
                <Label htmlFor="check1">{t("designGuide.sections.formElements.checkedItem", "Checked item")}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="check2" />
                <Label htmlFor="check2">{t("designGuide.sections.formElements.uncheckedItem", "Unchecked item")}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="check3" disabled />
                <Label htmlFor="check3">{t("designGuide.sections.formElements.disabledItem", "Disabled item")}</Label>
              </div>
            </div>
          </SubSection>

          <SubSection title={t("designGuide.sections.formElements.inlineEditor", "Inline Editor")}>
            <div className="space-y-4">
              <div>
                <p className="text-xs text-muted-foreground mb-1">{t("designGuide.inlineEditor.titleLabel", "Title (single-line)")}</p>
                <InlineEditor
                  value={inlineTitle}
                  onSave={setInlineTitle}
                  as="h2"
                  className="text-xl font-bold"
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">{t("designGuide.inlineEditor.bodyLabel", "Body text (single-line)")}</p>
                <InlineEditor
                  value={inlineText}
                  onSave={setInlineText}
                  as="p"
                  className="text-sm"
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">{t("designGuide.inlineEditor.descriptionLabel", "Description (multiline, auto-sizing)")}</p>
                <InlineEditor
                  value={inlineDesc}
                  onSave={setInlineDesc}
                  as="p"
                  className="text-sm text-muted-foreground"
                  placeholder={t("designGuide.inlineEditor.descriptionPlaceholder", "Add a description...")}
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
      <Section title={t("designGuide.sections.select.title", "Select")}>
        <div className="grid gap-6 md:grid-cols-2">
          <SubSection title={t("designGuide.sections.select.defaultSize", "Default size")}>
            <Select value={selectValue} onValueChange={setSelectValue}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("designGuide.sections.select.selectStatus", "Select status")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="backlog">{t("designGuide.sections.select.backlog", "Backlog")}</SelectItem>
                <SelectItem value="todo">{t("designGuide.sections.select.todo", "Todo")}</SelectItem>
                <SelectItem value="in_progress">{t("designGuide.sections.select.inProgress", "In Progress")}</SelectItem>
                <SelectItem value="in_review">{t("designGuide.sections.select.inReview", "In Review")}</SelectItem>
                <SelectItem value="done">{t("designGuide.sections.select.done", "Done")}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t("designGuide.sections.select.currentValue", "Current value: {{value}}", { value: selectValue })}</p>
          </SubSection>
          <SubSection title={t("designGuide.sections.select.smallTrigger", "Small trigger")}>
            <Select defaultValue="high">
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="critical">{t("designGuide.sections.select.critical", "Critical")}</SelectItem>
                <SelectItem value="high">{t("designGuide.sections.select.high", "High")}</SelectItem>
                <SelectItem value="medium">{t("designGuide.sections.select.medium", "Medium")}</SelectItem>
                <SelectItem value="low">{t("designGuide.sections.select.low", "Low")}</SelectItem>
              </SelectContent>
            </Select>
          </SubSection>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  DROPDOWN MENU                                                */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.dropdownMenu.title", "Dropdown Menu")}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {t("designGuide.sections.dropdownMenu.quickActions", "Quick Actions")}
              <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem>
              <Check className="h-4 w-4" />
              {t("designGuide.sections.dropdownMenu.markAsDone", "Mark as done")}
              <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem>
              <BookOpen className="h-4 w-4" />
              {t("designGuide.sections.dropdownMenu.openDocs", "Open docs")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={menuChecked}
              onCheckedChange={(value) => setMenuChecked(value === true)}
            >
              {t("designGuide.sections.dropdownMenu.watchIssue", "Watch issue")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuItem variant="destructive">
              <Trash2 className="h-4 w-4" />
              {t("designGuide.sections.dropdownMenu.deleteIssue", "Delete issue")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Section>

      {/* ============================================================ */}
      {/*  POPOVER                                                      */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.popover.title", "Popover")}>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">{t("designGuide.sections.popover.open", "Open Popover")}</Button>
          </PopoverTrigger>
          <PopoverContent className="space-y-2">
            <p className="text-sm font-medium">{t("designGuide.sections.popover.agentHeartbeat", "Agent heartbeat")}</p>
            <p className="text-xs text-muted-foreground">
              {t("designGuide.sections.popover.lastRun", "Last run succeeded 24s ago. Next timer run in 9m.")}
            </p>
            <Button size="xs">{t("designGuide.sections.popover.wakeNow", "Wake now")}</Button>
          </PopoverContent>
        </Popover>
      </Section>

      {/* ============================================================ */}
      {/*  COLLAPSIBLE                                                  */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.collapsible.title", "Collapsible")}>
        <Collapsible open={collapsibleOpen} onOpenChange={setCollapsibleOpen} className="space-y-2">
          <CollapsibleTrigger asChild>
            <Button variant="outline" size="sm">
              {collapsibleOpen
                ? t("designGuide.sections.collapsible.hideAdvancedFilters", "Hide advanced filters")
                : t("designGuide.sections.collapsible.showAdvancedFilters", "Show advanced filters")}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="rounded-md border border-border p-3">
            <div className="space-y-2">
              <Label htmlFor="owner-filter">{t("designGuide.sections.collapsible.owner", "Owner")}</Label>
              <Input id="owner-filter" placeholder={t("designGuide.sections.collapsible.filterByAgentName", "Filter by agent name")} />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </Section>

      {/* ============================================================ */}
      {/*  SHEET                                                        */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.sheet.title", "Sheet")}>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" size="sm">{t("designGuide.sections.sheet.openSidePanel", "Open Side Panel")}</Button>
          </SheetTrigger>
          <SheetContent side="right">
            <SheetHeader>
              <SheetTitle>{t("designGuide.sections.sheet.issueProperties", "Issue Properties")}</SheetTitle>
              <SheetDescription>{t("designGuide.sections.sheet.editMetadata", "Edit metadata without leaving the current page.")}</SheetDescription>
            </SheetHeader>
            <div className="space-y-4 px-4">
              <div className="space-y-1">
                <Label htmlFor="sheet-title">{t("designGuide.sections.sheet.fieldTitle", "Title")}</Label>
                <Input id="sheet-title" defaultValue={t("designGuide.sections.sheet.defaultTitle", "Improve onboarding docs")} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sheet-description">{t("designGuide.sections.sheet.fieldDescription", "Description")}</Label>
                <Textarea id="sheet-description" defaultValue={t("designGuide.sections.sheet.defaultDescription", "Capture setup pitfalls and screenshots.")} />
              </div>
            </div>
            <SheetFooter>
              <Button variant="outline">{t("designGuide.sections.sheet.cancel", "Cancel")}</Button>
              <Button>{t("designGuide.sections.sheet.save", "Save")}</Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </Section>

      {/* ============================================================ */}
      {/*  SCROLL AREA                                                  */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.scrollArea.title", "Scroll Area")}>
        <ScrollArea className="h-36 rounded-md border border-border">
          <div className="space-y-2 p-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="rounded-md border border-border p-2 text-sm">
                {t("designGuide.sections.scrollArea.heartbeatRunCompleted", "Heartbeat run #{{index}}: completed successfully", { index: i + 1 })}
              </div>
            ))}
          </div>
        </ScrollArea>
      </Section>

      {/* ============================================================ */}
      {/*  COMMAND                                                      */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.command.title", "Command (CMDK)")}>
        <div className="rounded-md border border-border">
          <Command>
            <CommandInput placeholder={t("designGuide.sections.command.typeACommand", "Type a command or search...")} />
            <CommandList>
              <CommandEmpty>{t("designGuide.sections.command.noResults", "No results found.")}</CommandEmpty>
              <CommandGroup heading={t("designGuide.sections.command.pages", "Pages")}>
                <CommandItem>
                  <LayoutDashboard className="h-4 w-4" />
                  {t("designGuide.sections.command.dashboard", "Dashboard")}
                </CommandItem>
                <CommandItem>
                  <CircleDot className="h-4 w-4" />
                  {t("designGuide.sections.command.issues", "Issues")}
                </CommandItem>
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading={t("designGuide.sections.command.actions", "Actions")}>
                <CommandItem>
                  <CommandIcon className="h-4 w-4" />
                  {t("designGuide.sections.command.openCommandPalette", "Open command palette")}
                </CommandItem>
                <CommandItem>
                  <Plus className="h-4 w-4" />
                  {t("designGuide.sections.command.createNewIssue", "Create new issue")}
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  BREADCRUMB                                                   */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.breadcrumb.title", "Breadcrumb")}>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="#">{t("designGuide.sections.breadcrumb.projects", "Projects")}</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href="#">{t("designGuide.sections.breadcrumb.paperclipApp", "Paperclip App")}</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{t("designGuide.sections.breadcrumb.issueList", "Issue List")}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </Section>

      {/* ============================================================ */}
      {/*  CARDS                                                        */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.cards.title", "Cards")}>
        <SubSection title={t("designGuide.sections.cards.standardCard", "Standard Card")}>
          <Card>
            <CardHeader>
              <CardTitle>{t("designGuide.sections.cards.cardTitle", "Card Title")}</CardTitle>
              <CardDescription>{t("designGuide.sections.cards.cardDescription", "Card description with supporting text.")}</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm">{t("designGuide.sections.cards.cardContent", "Card content goes here. This is the main body area.")}</p>
            </CardContent>
            <CardFooter className="gap-2">
              <Button size="sm">{t("designGuide.sections.cards.action", "Action")}</Button>
              <Button variant="outline" size="sm">{t("designGuide.sections.cards.cancel", "Cancel")}</Button>
            </CardFooter>
          </Card>
        </SubSection>

        <SubSection title={t("designGuide.sections.cards.metricCards", "Metric Cards")}>
          <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
            <MetricCard icon={Bot} value={12} label={t("designGuide.sections.cards.activeAgents", "Active Agents")} description={t("designGuide.sections.cards.plusThreeThisWeek", "+3 this week")} />
            <MetricCard icon={CircleDot} value={48} label={t("designGuide.sections.cards.openIssues", "Open Issues")} />
            <MetricCard icon={DollarSign} value="$1,234" label={t("designGuide.sections.cards.monthlyCost", "Monthly Cost")} description={t("designGuide.sections.cards.underBudget", "Under budget")} />
            <MetricCard icon={Zap} value="99.9%" label={t("designGuide.sections.cards.uptime", "Uptime")} />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TABS                                                         */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.tabs.title", "Tabs")}>
        <SubSection title={t("designGuide.sections.tabs.defaultPillVariant", "Default (pill) variant")}>
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">{t("designGuide.sections.tabs.overview", "Overview")}</TabsTrigger>
              <TabsTrigger value="runs">{t("designGuide.sections.tabs.runs", "Runs")}</TabsTrigger>
              <TabsTrigger value="config">{t("designGuide.sections.tabs.config", "Config")}</TabsTrigger>
              <TabsTrigger value="costs">{t("designGuide.sections.tabs.costs", "Costs")}</TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              <p className="text-sm text-muted-foreground py-4">{t("designGuide.sections.tabs.overviewTabContent", "Overview tab content.")}</p>
            </TabsContent>
            <TabsContent value="runs">
              <p className="text-sm text-muted-foreground py-4">{t("designGuide.sections.tabs.runsTabContent", "Runs tab content.")}</p>
            </TabsContent>
            <TabsContent value="config">
              <p className="text-sm text-muted-foreground py-4">{t("designGuide.sections.tabs.configTabContent", "Config tab content.")}</p>
            </TabsContent>
            <TabsContent value="costs">
              <p className="text-sm text-muted-foreground py-4">{t("designGuide.sections.tabs.costsTabContent", "Costs tab content.")}</p>
            </TabsContent>
          </Tabs>
        </SubSection>

        <SubSection title={t("designGuide.sections.tabs.lineVariant", "Line variant")}>
          <Tabs defaultValue="summary">
            <TabsList variant="line">
              <TabsTrigger value="summary">{t("designGuide.sections.tabs.summary", "Summary")}</TabsTrigger>
              <TabsTrigger value="details">{t("designGuide.sections.tabs.details", "Details")}</TabsTrigger>
              <TabsTrigger value="comments">{t("designGuide.sections.tabs.comments", "Comments")}</TabsTrigger>
            </TabsList>
            <TabsContent value="summary">
              <p className="text-sm text-muted-foreground py-4">{t("designGuide.sections.tabs.summaryContent", "Summary content with underline tabs.")}</p>
            </TabsContent>
            <TabsContent value="details">
              <p className="text-sm text-muted-foreground py-4">{t("designGuide.sections.tabs.detailsContent", "Details content.")}</p>
            </TabsContent>
            <TabsContent value="comments">
              <p className="text-sm text-muted-foreground py-4">{t("designGuide.sections.tabs.commentsContent", "Comments content.")}</p>
            </TabsContent>
          </Tabs>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  ENTITY ROWS                                                  */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.entityRows.title", "Entity Rows")}>
        <div className="border border-border rounded-md">
          <EntityRow
            leading={
              <>
                <StatusIcon status="in_progress" />
                <PriorityIcon priority="high" />
              </>
            }
            identifier="PAP-001"
            title={t("designGuide.sections.entityRows.authFlow", "Implement authentication flow")}
            subtitle={t("designGuide.sections.entityRows.assignedToAgentAlpha", "Assigned to Agent Alpha")}
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
            title={t("designGuide.sections.entityRows.cicdPipeline", "Set up CI/CD pipeline")}
            subtitle={t("designGuide.sections.entityRows.completedTwoDaysAgo", "Completed 2 days ago")}
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
            title={t("designGuide.sections.entityRows.writeApiDocumentation", "Write API documentation")}
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
            title={t("designGuide.sections.entityRows.deployToProduction", "Deploy to production")}
            subtitle={t("designGuide.sections.entityRows.blockedByPap001", "Blocked by PAP-001")}
            trailing={<StatusBadge status="blocked" />}
            selected
          />
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  FILTER BAR                                                   */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.filterBar.title", "Filter Bar")}>
        <FilterBar
          filters={filters}
          onRemove={(key) => setFilters((f) => f.filter((x) => x.key !== key))}
          onClear={() => setFilters([])}
        />
        {filters.length === 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setFilters(defaultFilters)}
          >
            {t("designGuide.filterBar.resetFilters", "Reset filters")}
          </Button>
        )}
      </Section>

      {/* ============================================================ */}
      {/*  AVATARS                                                      */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.avatars.title", "Avatars")}>
        <SubSection title={t("designGuide.sections.avatars.sizes", "Sizes")}>
          <div className="flex items-center gap-3">
            <Avatar size="sm"><AvatarFallback>SM</AvatarFallback></Avatar>
            <Avatar><AvatarFallback>DF</AvatarFallback></Avatar>
            <Avatar size="lg"><AvatarFallback>LG</AvatarFallback></Avatar>
          </div>
        </SubSection>

        <SubSection title={t("designGuide.sections.avatars.group", "Group")}>
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
      <Section title={t("designGuide.sections.identity.title", "Identity")}>
        <SubSection title={t("designGuide.sections.identity.sizes", "Sizes")}>
          <div className="flex items-center gap-6">
            <Identity name="Agent Alpha" size="sm" />
            <Identity name="Agent Alpha" />
            <Identity name="Agent Alpha" size="lg" />
          </div>
        </SubSection>

        <SubSection title={t("designGuide.sections.identity.initialsDerivation", "Initials derivation")}>
          <div className="flex flex-col gap-2">
            <Identity name="CEO Agent" size="sm" />
            <Identity name="Alpha" size="sm" />
            <Identity name="Quality Assurance Lead" size="sm" />
          </div>
        </SubSection>

        <SubSection title={t("designGuide.sections.identity.customInitials", "Custom initials")}>
          <Identity name="Backend Service" initials="BS" size="sm" />
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TOOLTIPS                                                     */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.tooltips.title", "Tooltips")}>
        <div className="flex items-center gap-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm">{t("designGuide.sections.tooltips.hoverMe", "Hover me")}</Button>
            </TooltipTrigger>
            <TooltipContent>{t("designGuide.sections.tooltips.thisIsATooltip", "This is a tooltip")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm"><Settings /></Button>
            </TooltipTrigger>
            <TooltipContent>{t("designGuide.sections.tooltips.settings", "Settings")}</TooltipContent>
          </Tooltip>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  DIALOG                                                       */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.dialog.title", "Dialog")}>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline">{t("designGuide.sections.dialog.openDialog", "Open Dialog")}</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("designGuide.sections.dialog.dialogTitle", "Dialog Title")}</DialogTitle>
              <DialogDescription>
                {t("designGuide.sections.dialog.dialogDescription", "This is a sample dialog showing the standard layout with header, content, and footer.")}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>{t("designGuide.sections.dialog.name", "Name")}</Label>
                <Input placeholder={t("designGuide.sections.dialog.enterAName", "Enter a name")} className="mt-1.5" />
              </div>
              <div>
                <Label>{t("designGuide.sections.dialog.description", "Description")}</Label>
                <Textarea placeholder={t("designGuide.sections.dialog.describe", "Describe...")} className="mt-1.5" />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline">{t("designGuide.sections.dialog.cancel", "Cancel")}</Button>
              <Button>{t("designGuide.sections.dialog.save", "Save")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Section>

      {/* ============================================================ */}
      {/*  EMPTY STATE                                                  */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.emptyState.title", "Empty State")}>
        <div className="border border-border rounded-md">
          <EmptyState
            icon={Inbox}
            message={t("designGuide.sections.emptyState.message", "No items to show. Create your first one to get started.")}
            action={t("designGuide.sections.emptyState.action", "Create Item")}
            onAction={() => {}}
          />
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  PROGRESS BARS                                                */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.progressBars.title", "Progress Bars (Budget)")}>
        <div className="space-y-3">
          {[
            { label: t("designGuide.sections.progressBars.underBudget", "Under budget (40%)"), pct: 40, color: "bg-green-400" },
            { label: t("designGuide.sections.progressBars.warning", "Warning (75%)"), pct: 75, color: "bg-yellow-400" },
            { label: t("designGuide.sections.progressBars.overBudget", "Over budget (95%)"), pct: 95, color: "bg-red-400" },
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
      <Section title={t("designGuide.sections.logViewer.title", "Log Viewer")}>
        <div className="bg-neutral-950 rounded-lg p-3 font-mono text-xs max-h-80 overflow-y-auto">
          <div className="text-foreground">[12:00:01] INFO  Agent started successfully</div>
          <div className="text-foreground">[12:00:02] INFO  Processing task PAP-001</div>
          <div className="text-yellow-400">[12:00:05] WARN  Rate limit approaching (80%)</div>
          <div className="text-foreground">[12:00:08] INFO  Task PAP-001 completed</div>
          <div className="text-red-400">[12:00:12] ERROR Connection timeout to upstream service</div>
          <div className="text-blue-300">[12:00:12] SYS   Retrying connection in 5s...</div>
          <div className="text-foreground">[12:00:17] INFO  Reconnected successfully</div>
          <div className="flex items-center gap-1.5">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-cyan-400 animate-pulse" />
              <span className="inline-flex h-full w-full rounded-full bg-cyan-400" />
            </span>
            <span className="text-cyan-400">{t("designGuide.sections.logViewer.live", "Live")}</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  PROPERTY ROW PATTERN                                         */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.propertyRowPattern.title", "Property Row Pattern")}>
        <div className="border border-border rounded-md p-4 space-y-1 max-w-sm">
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">{t("designGuide.sections.propertyRowPattern.status", "Status")}</span>
            <StatusBadge status="active" />
          </div>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">{t("designGuide.sections.propertyRowPattern.priority", "Priority")}</span>
            <PriorityIcon priority="high" />
          </div>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">{t("designGuide.sections.propertyRowPattern.assignee", "Assignee")}</span>
            <div className="flex items-center gap-1.5">
              <Avatar size="sm"><AvatarFallback>A</AvatarFallback></Avatar>
              <span className="text-xs">{t("designGuide.sections.propertyRowPattern.agentAlpha", "Agent Alpha")}</span>
            </div>
          </div>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">{t("designGuide.sections.propertyRowPattern.created", "Created")}</span>
            <span className="text-xs">Jan 15, 2025</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  NAVIGATION PATTERNS                                          */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.navigationPatterns.title", "Navigation Patterns")}>
        <SubSection title={t("designGuide.sections.navigationPatterns.sidebarNavItems", "Sidebar nav items")}>
          <div className="w-60 border border-border rounded-md p-3 space-y-0.5 bg-card">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium bg-accent text-accent-foreground">
              <LayoutDashboard className="h-4 w-4" />
              {t("designGuide.sections.navigationPatterns.dashboard", "Dashboard")}
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <CircleDot className="h-4 w-4" />
              {t("designGuide.sections.navigationPatterns.issues", "Issues")}
              <span className="ml-auto text-xs bg-primary text-primary-foreground rounded-full px-1.5 py-0.5">
                12
              </span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <Bot className="h-4 w-4" />
              {t("designGuide.sections.navigationPatterns.agents", "Agents")}
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <Hexagon className="h-4 w-4" />
              {t("designGuide.sections.navigationPatterns.projects", "Projects")}
            </div>
          </div>
        </SubSection>

        <SubSection title={t("designGuide.sections.navigationPatterns.viewToggle", "View toggle")}>
          <div className="flex items-center border border-border rounded-md w-fit">
            <button className="px-3 py-1.5 text-xs font-medium bg-accent text-foreground rounded-l-md">
              <ListTodo className="h-3.5 w-3.5 inline mr-1" />
              {t("designGuide.sections.navigationPatterns.list", "List")}
            </button>
            <button className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent/50 rounded-r-md">
              <Target className="h-3.5 w-3.5 inline mr-1" />
              {t("designGuide.sections.navigationPatterns.org", "Org")}
            </button>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  GROUPED LIST (Issues pattern)                                */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.groupedList.title", "Grouped List (Issues pattern)")}>
        <div>
          <div className="flex items-center gap-2 px-4 py-2 bg-muted/50 rounded-t-md">
            <StatusIcon status="in_progress" />
            <span className="text-sm font-medium">{t("designGuide.sections.groupedList.inProgress", "In Progress")}</span>
            <span className="text-xs text-muted-foreground ml-1">2</span>
          </div>
          <div className="border border-border rounded-b-md">
            <EntityRow
              leading={<PriorityIcon priority="high" />}
              identifier="PAP-101"
              title={t("designGuide.sections.groupedList.buildAgentHeartbeatSystem", "Build agent heartbeat system")}
              onClick={() => {}}
            />
            <EntityRow
              leading={<PriorityIcon priority="medium" />}
              identifier="PAP-102"
              title={t("designGuide.sections.groupedList.addCostTrackingDashboard", "Add cost tracking dashboard")}
              onClick={() => {}}
            />
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  COMMENT THREAD PATTERN                                       */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.commentThread.title", "Comment Thread Pattern")}>
        <div className="space-y-3 max-w-2xl">
          <h3 className="text-sm font-semibold">{t("designGuide.sections.commentThread.commentsCount", "Comments (2)")}</h3>
          <div className="space-y-3">
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-muted-foreground">{t("designGuide.sections.commentThread.agent", "Agent")}</span>
                <span className="text-xs text-muted-foreground">Jan 15, 2025</span>
              </div>
              <p className="text-sm">{t("designGuide.sections.commentThread.agentComment", "Started working on the authentication module. Will need API keys configured.")}</p>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-muted-foreground">{t("designGuide.sections.commentThread.human", "Human")}</span>
                <span className="text-xs text-muted-foreground">Jan 16, 2025</span>
              </div>
              <p className="text-sm">{t("designGuide.sections.commentThread.humanComment", "API keys have been added to the vault. Please proceed.")}</p>
            </div>
          </div>
          <div className="space-y-2">
            <Textarea placeholder={t("designGuide.sections.commentThread.leaveAComment", "Leave a comment...")} rows={3} />
            <Button size="sm">{t("designGuide.sections.commentThread.comment", "Comment")}</Button>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  COST TABLE PATTERN                                           */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.costTable.title", "Cost Table Pattern")}>
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead className="border-b border-border bg-accent/20">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">{t("designGuide.sections.costTable.model", "Model")}</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">{t("designGuide.sections.costTable.tokens", "Tokens")}</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">{t("designGuide.sections.costTable.cost", "Cost")}</th>
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
                <td className="px-3 py-2 font-medium">{t("designGuide.sections.costTable.total", "Total")}</td>
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
      <Section title={t("designGuide.sections.skeletons.title", "Skeletons")}>
        <SubSection title={t("designGuide.sections.skeletons.individual", "Individual")}>
          <div className="space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-8 w-full max-w-sm" />
            <Skeleton className="h-20 w-full" />
          </div>
        </SubSection>

        <SubSection title={t("designGuide.sections.skeletons.pageSkeletonList", "Page Skeleton (list)")}>
          <div className="border border-border rounded-md p-4">
            <PageSkeleton variant="list" />
          </div>
        </SubSection>

        <SubSection title={t("designGuide.sections.skeletons.pageSkeletonDetail", "Page Skeleton (detail)")}>
          <div className="border border-border rounded-md p-4">
            <PageSkeleton variant="detail" />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  SEPARATOR                                                    */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.separator.title", "Separator")}>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("designGuide.sections.separator.horizontal", "Horizontal")}</p>
          <Separator />
          <div className="flex items-center gap-4 h-8">
            <span className="text-sm">{t("designGuide.sections.separator.left", "Left")}</span>
            <Separator orientation="vertical" />
            <span className="text-sm">{t("designGuide.sections.separator.right", "Right")}</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  ICON REFERENCE                                               */}
      {/* ============================================================ */}
      <Section title={t("designGuide.sections.commonIcons.title", "Common Icons (Lucide)")}>
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
      <Section title={t("designGuide.sections.keyboardShortcuts.title", "Keyboard Shortcuts")}>
        <div className="border border-border rounded-md divide-y divide-border text-sm">
          {[
            ["Cmd+K / Ctrl+K", t("designGuide.sections.keyboardShortcuts.openCommandPalette", "Open Command Palette")],
            ["C", t("designGuide.sections.keyboardShortcuts.newIssue", "New Issue (outside inputs)")],
            ["[", t("designGuide.sections.keyboardShortcuts.toggleSidebar", "Toggle Sidebar")],
            ["]", t("designGuide.sections.keyboardShortcuts.togglePropertiesPanel", "Toggle Properties Panel")],
            ["Cmd+Enter / Ctrl+Enter", t("designGuide.sections.keyboardShortcuts.submitMarkdownComment", "Submit markdown comment")],
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
