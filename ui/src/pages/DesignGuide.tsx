import { useState } from "react";
import {
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  CircleDot,
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
import {
  Button,
  Badge,
  Input,
  Checkbox,
  Separator,
  Skeleton,
  Tabs,
  Card,
  Modal,
  Tooltip,
  Select,
  ListBox,
  Dropdown,
  Popover,
  Drawer,
} from "@heroui/react";
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
      <h3 className="text-sm font-semibold text-foreground/60">
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
  const [status, setStatus] = useState("todo");
  const [priority, setPriority] = useState("medium");
  const [selectValue, setSelectValue] = useState<string>("in_progress");
  const [checked1, setChecked1] = useState(true);
  const [checked2, setChecked2] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
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
        <h2 className="text-xl font-bold">Design Guide</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Every component, style, and pattern used across Paperclip.
        </p>
      </div>

      {/* ============================================================ */}
      {/*  COVERAGE                                                     */}
      {/* ============================================================ */}
      <Section title="Component Coverage">
        <p className="text-sm text-muted-foreground">
          This page should be updated when new UI primitives or app-level patterns ship.
        </p>
        <div className="grid gap-6 md:grid-cols-2">
          <SubSection title="UI primitives">
            <div className="flex flex-wrap gap-2">
              {[
                "badge", "button", "card", "checkbox", "drawer", "input", "modal",
                "popover", "select", "separator", "skeleton", "tabs", "tooltip",
              ].map((name) => (
                <Badge key={name} variant="secondary" className="font-mono text-[10px]">
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
                <Badge key={name} variant="soft" className="font-mono text-[10px]">
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
      <Section title="Colors">
        <SubSection title="Core">
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

        <SubSection title="Sidebar">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Swatch name="Sidebar" cssVar="--sidebar" />
            <Swatch name="Sidebar border" cssVar="--sidebar-border" />
          </div>
        </SubSection>

        <SubSection title="Chart">
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
      <Section title="Typography">
        <div className="space-y-3">
          <h2 className="text-xl font-bold">Page Title — text-xl font-bold</h2>
          <h2 className="text-lg font-semibold">Section Title — text-lg font-semibold</h2>
          <h3 className="text-sm font-semibold text-foreground/60">
            Section Heading — text-sm font-semibold uppercase tracking-wide
          </h3>
          <p className="text-sm font-medium">Card Title — text-sm font-medium</p>
          <p className="text-sm font-semibold">Card Title Alt — text-sm font-semibold</p>
          <p className="text-sm">Body text — text-sm</p>
          <p className="text-sm text-muted-foreground">
            Muted description — text-sm text-muted-foreground
          </p>
          <p className="text-xs text-muted-foreground">
            Tiny label — text-xs text-muted-foreground
          </p>
          <p className="text-sm font-mono text-muted-foreground">
            Mono identifier — text-sm font-mono text-muted-foreground
          </p>
          <p className="text-2xl font-bold">Large stat — text-2xl font-bold</p>
          <p className="font-mono text-xs">Log/code text — font-mono text-xs</p>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  SPACING & RADIUS                                             */}
      {/* ============================================================ */}
      <Section title="Radius">
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
      <Section title="Buttons">
        <SubSection title="Variants">
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="primary">Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Danger</Button>
          </div>
        </SubSection>

        <SubSection title="Sizes">
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="sm">Small</Button>
            <Button>Default</Button>
            <Button size="lg">Large</Button>
          </div>
        </SubSection>

        <SubSection title="Icon buttons">
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="ghost" size="sm" isIconOnly><Search className="h-4 w-4" /></Button>
            <Button variant="outline" isIconOnly><Search className="h-4 w-4" /></Button>
          </div>
        </SubSection>

        <SubSection title="With icons">
          <div className="flex items-center gap-2 flex-wrap">
            <Button><Plus className="h-4 w-4 mr-1.5" /> New Issue</Button>
            <Button variant="outline"><Upload className="h-4 w-4 mr-1.5" /> Upload</Button>
            <Button variant="danger"><Trash2 className="h-4 w-4 mr-1.5" /> Delete</Button>
            <Button size="sm"><Plus className="h-3.5 w-3.5 mr-1" /> Add</Button>
          </div>
        </SubSection>

        <SubSection title="States">
          <div className="flex items-center gap-2 flex-wrap">
            <Button isDisabled>Disabled</Button>
            <Button variant="outline" isDisabled>Disabled Outline</Button>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  BADGES                                                       */}
      {/* ============================================================ */}
      <Section title="Badges">
        <SubSection title="Variants">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge>Default</Badge>
            <Badge variant="secondary">Secondary</Badge>
            <Badge variant="secondary">Secondary (was outline)</Badge>
            <Badge variant="soft">Soft (was ghost)</Badge>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  STATUS BADGES & ICONS                                        */}
      {/* ============================================================ */}
      <Section title="Status System">
        <SubSection title="StatusBadge (all statuses)">
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

        <SubSection title="StatusIcon (interactive)">
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
            <span className="text-sm">Click the icon to change status (current: {status})</span>
          </div>
        </SubSection>

        <SubSection title="PriorityIcon (interactive)">
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
            <span className="text-sm">Click the icon to change (current: {priority})</span>
          </div>
        </SubSection>

        <SubSection title="Agent status dots">
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

        <SubSection title="Run invocation badges">
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
      </Section>

      {/* ============================================================ */}
      {/*  FORM ELEMENTS                                                */}
      {/* ============================================================ */}
      <Section title="Form Elements">
        <div className="grid gap-6 md:grid-cols-2">
          <SubSection title="Input">
            <Input placeholder="Default input" />
            <Input placeholder="Disabled input" disabled className="mt-2" />
          </SubSection>

          <SubSection title="Textarea">
            <textarea
              className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none"
              placeholder="Write something..."
              rows={3}
            />
          </SubSection>

          <SubSection title="Checkbox">
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Checkbox id="check1" isSelected={checked1} onChange={() => setChecked1(!checked1)} />
                <label htmlFor="check1" className="text-sm">Checked item</label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="check2" isSelected={checked2} onChange={() => setChecked2(!checked2)} />
                <label htmlFor="check2" className="text-sm">Unchecked item</label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="check3" isDisabled />
                <label htmlFor="check3" className="text-sm text-muted-foreground">Disabled item</label>
              </div>
            </div>
          </SubSection>

          <SubSection title="Inline Editor">
            <div className="space-y-4">
              <div>
                <p className="text-xs text-muted-foreground mb-1">Title (single-line)</p>
                <InlineEditor
                  value={inlineTitle}
                  onSave={setInlineTitle}
                  as="h2"
                  className="text-xl font-bold"
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Body text (single-line)</p>
                <InlineEditor
                  value={inlineText}
                  onSave={setInlineText}
                  as="p"
                  className="text-sm"
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Description (multiline, auto-sizing)</p>
                <InlineEditor
                  value={inlineDesc}
                  onSave={setInlineDesc}
                  as="p"
                  className="text-sm text-muted-foreground"
                  placeholder="Add a description..."
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
      <Section title="Select">
        <div className="grid gap-6 md:grid-cols-2">
          <SubSection title="Default size">
            <Select
              selectedKey={selectValue}
              onSelectionChange={(key) => setSelectValue(String(key))}
              aria-label="Select status"
            >
              <Select.Trigger className="w-full" />
              <Select.Popover>
                <ListBox>
                  <ListBox.Item id="backlog">Backlog</ListBox.Item>
                  <ListBox.Item id="todo">Todo</ListBox.Item>
                  <ListBox.Item id="in_progress">In Progress</ListBox.Item>
                  <ListBox.Item id="in_review">In Review</ListBox.Item>
                  <ListBox.Item id="done">Done</ListBox.Item>
                </ListBox>
              </Select.Popover>
            </Select>
            <p className="text-xs text-muted-foreground">Current value: {selectValue}</p>
          </SubSection>
          <SubSection title="Small trigger">
            <Select defaultSelectedKey="high" aria-label="Select priority">
              <Select.Trigger className="w-full" />
              <Select.Popover>
                <ListBox>
                  <ListBox.Item id="critical">Critical</ListBox.Item>
                  <ListBox.Item id="high">High</ListBox.Item>
                  <ListBox.Item id="medium">Medium</ListBox.Item>
                  <ListBox.Item id="low">Low</ListBox.Item>
                </ListBox>
              </Select.Popover>
            </Select>
          </SubSection>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  DROPDOWN MENU                                                */}
      {/* ============================================================ */}
      <Section title="Dropdown Menu">
        <Dropdown>
          <Dropdown.Trigger>
            <Button variant="outline" size="sm">
              Quick Actions
              <ChevronDown className="h-4 w-4 ml-1" />
            </Button>
          </Dropdown.Trigger>
          <Dropdown.Popover>
            <Dropdown.Menu className="w-56">
              <Dropdown.Item>
                <Check className="h-4 w-4 mr-2" />
                Mark as done
              </Dropdown.Item>
              <Dropdown.Item>
                <BookOpen className="h-4 w-4 mr-2" />
                Open docs
              </Dropdown.Item>
              <Dropdown.Item className="text-destructive">
                <Trash2 className="h-4 w-4 mr-2" />
                Delete issue
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </Section>

      {/* ============================================================ */}
      {/*  POPOVER                                                      */}
      {/* ============================================================ */}
      <Section title="Popover">
        <Popover>
          <Popover.Trigger>
            <Button variant="outline" size="sm">Open Popover</Button>
          </Popover.Trigger>
          <Popover.Content className="space-y-2 p-3">
            <p className="text-sm font-medium">Agent heartbeat</p>
            <p className="text-xs text-muted-foreground">
              Last run succeeded 24s ago. Next timer run in 9m.
            </p>
            <Button size="sm">Wake now</Button>
          </Popover.Content>
        </Popover>
      </Section>

      {/* ============================================================ */}
      {/*  DRAWER (replaces Sheet)                                      */}
      {/* ============================================================ */}
      <Section title="Drawer">
        <Button variant="outline" size="sm" onPress={() => setDrawerOpen(true)}>Open Side Panel</Button>
        <Drawer isOpen={drawerOpen} onOpenChange={setDrawerOpen}>
          <Drawer.Content>
            <div className="space-y-4 p-4">
              <div>
                <h2 className="text-base font-semibold">Issue Properties</h2>
                <p className="text-sm text-muted-foreground mt-0.5">Edit metadata without leaving the current page.</p>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Title</label>
                <Input defaultValue="Improve onboarding docs" />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Description</label>
                <textarea
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none resize-none"
                  defaultValue="Capture setup pitfalls and screenshots."
                  rows={3}
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onPress={() => setDrawerOpen(false)}>Cancel</Button>
                <Button onPress={() => setDrawerOpen(false)}>Save</Button>
              </div>
            </div>
          </Drawer.Content>
        </Drawer>
      </Section>

      {/* ============================================================ */}
      {/*  SCROLL AREA (overflow-auto)                                  */}
      {/* ============================================================ */}
      <Section title="Scroll Area">
        <div className="h-36 rounded-md border border-border overflow-auto scrollbar-auto-hide">
          <div className="space-y-2 p-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="rounded-md border border-border p-2 text-sm">
                Heartbeat run #{i + 1}: completed successfully
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  CARDS                                                        */}
      {/* ============================================================ */}
      <Section title="Cards">
        <SubSection title="Standard Card">
          <Card>
            <Card.Header>
              <div className="font-semibold">Card Title</div>
              <p className="text-sm text-muted-foreground">Card description with supporting text.</p>
            </Card.Header>
            <Card.Content>
              <p className="text-sm">Card content goes here. This is the main body area.</p>
            </Card.Content>
            <Card.Footer className="gap-2">
              <Button size="sm">Action</Button>
              <Button variant="outline" size="sm">Cancel</Button>
            </Card.Footer>
          </Card>
        </SubSection>

        <SubSection title="Metric Cards">
          <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
            <MetricCard icon={Bot} value={12} label="Active Agents" description="+3 this week" />
            <MetricCard icon={CircleDot} value={48} label="Open Issues" />
            <MetricCard icon={DollarSign} value="$1,234" label="Monthly Cost" description="Under budget" />
            <MetricCard icon={Zap} value="99.9%" label="Uptime" />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TABS                                                         */}
      {/* ============================================================ */}
      <Section title="Tabs">
        <SubSection title="Default variant">
          <Tabs defaultSelectedKey="overview">
            <Tabs.ListContainer>
              <Tabs.List>
                <Tabs.Tab id="overview">Overview<Tabs.Indicator /></Tabs.Tab>
                <Tabs.Tab id="runs">Runs<Tabs.Indicator /></Tabs.Tab>
                <Tabs.Tab id="config">Config<Tabs.Indicator /></Tabs.Tab>
                <Tabs.Tab id="costs">Costs<Tabs.Indicator /></Tabs.Tab>
              </Tabs.List>
            </Tabs.ListContainer>
            <Tabs.Panel id="overview">
              <p className="text-sm text-muted-foreground py-4">Overview tab content.</p>
            </Tabs.Panel>
            <Tabs.Panel id="runs">
              <p className="text-sm text-muted-foreground py-4">Runs tab content.</p>
            </Tabs.Panel>
            <Tabs.Panel id="config">
              <p className="text-sm text-muted-foreground py-4">Config tab content.</p>
            </Tabs.Panel>
            <Tabs.Panel id="costs">
              <p className="text-sm text-muted-foreground py-4">Costs tab content.</p>
            </Tabs.Panel>
          </Tabs>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  ENTITY ROWS                                                  */}
      {/* ============================================================ */}
      <Section title="Entity Rows">
        <div className="border border-border rounded-md">
          <EntityRow
            leading={
              <>
                <StatusIcon status="in_progress" />
                <PriorityIcon priority="high" />
              </>
            }
            identifier="PAP-001"
            title="Implement authentication flow"
            subtitle="Assigned to Agent Alpha"
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
            title="Set up CI/CD pipeline"
            subtitle="Completed 2 days ago"
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
            title="Write API documentation"
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
            title="Deploy to production"
            subtitle="Blocked by PAP-001"
            trailing={<StatusBadge status="blocked" />}
            selected
          />
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  FILTER BAR                                                   */}
      {/* ============================================================ */}
      <Section title="Filter Bar">
        <FilterBar
          filters={filters}
          onRemove={(key) => setFilters((f) => f.filter((x) => x.key !== key))}
          onClear={() => setFilters([])}
        />
        {filters.length === 0 && (
          <Button
            variant="outline"
            size="sm"
            onPress={() =>
              setFilters([
                { key: "status", label: "Status", value: "Active" },
                { key: "priority", label: "Priority", value: "High" },
              ])
            }
          >
            Reset filters
          </Button>
        )}
      </Section>

      {/* ============================================================ */}
      {/*  IDENTITY                                                     */}
      {/* ============================================================ */}
      <Section title="Identity">
        <SubSection title="Sizes">
          <div className="flex items-center gap-6">
            <Identity name="Agent Alpha" size="sm" />
            <Identity name="Agent Alpha" />
            <Identity name="Agent Alpha" size="lg" />
          </div>
        </SubSection>

        <SubSection title="Initials derivation">
          <div className="flex flex-col gap-2">
            <Identity name="CEO Agent" size="sm" />
            <Identity name="Alpha" size="sm" />
            <Identity name="Quality Assurance Lead" size="sm" />
          </div>
        </SubSection>

        <SubSection title="Custom initials">
          <Identity name="Backend Service" initials="BS" size="sm" />
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TOOLTIPS                                                     */}
      {/* ============================================================ */}
      <Section title="Tooltips">
        <div className="flex items-center gap-4">
          <Tooltip>
            <Tooltip.Trigger>
              <Button variant="outline" size="sm">Hover me</Button>
            </Tooltip.Trigger>
            <Tooltip.Content>This is a tooltip</Tooltip.Content>
          </Tooltip>
          <Tooltip>
            <Tooltip.Trigger>
              <Button variant="ghost" size="sm" isIconOnly><Settings className="h-4 w-4" /></Button>
            </Tooltip.Trigger>
            <Tooltip.Content>Settings</Tooltip.Content>
          </Tooltip>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  MODAL (replaces Dialog)                                      */}
      {/* ============================================================ */}
      <Section title="Modal">
        <Button variant="outline" onPress={() => setDialogOpen(true)}>Open Modal</Button>
        <Modal.Backdrop isOpen={dialogOpen} onOpenChange={setDialogOpen}>
          <Modal.Container size="md">
            <Modal.Dialog>
              <div className="p-6 space-y-4 max-w-md">
                <div>
                  <h2 className="text-base font-semibold">Modal Title</h2>
                  <p className="text-sm text-muted-foreground mt-1">
                    This is a sample modal showing the standard layout with header, content, and footer.
                  </p>
                </div>
                <div className="space-y-3">
                  <div>
                    <label className="text-xs text-muted-foreground">Name</label>
                    <Input placeholder="Enter a name" className="mt-1.5" />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">Description</label>
                    <textarea
                      className="w-full mt-1.5 rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none resize-none"
                      placeholder="Describe..."
                      rows={3}
                    />
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onPress={() => setDialogOpen(false)}>Cancel</Button>
                  <Button onPress={() => setDialogOpen(false)}>Save</Button>
                </div>
              </div>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Section>

      {/* ============================================================ */}
      {/*  EMPTY STATE                                                  */}
      {/* ============================================================ */}
      <Section title="Empty State">
        <div className="border border-border rounded-md">
          <EmptyState
            icon={Inbox}
            message="No items to show. Create your first one to get started."
            action="Create Item"
            onAction={() => {}}
          />
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  PROGRESS BARS                                                */}
      {/* ============================================================ */}
      <Section title="Progress Bars (Budget)">
        <div className="space-y-3">
          {[
            { label: "Under budget (40%)", pct: 40, color: "bg-green-400" },
            { label: "Warning (75%)", pct: 75, color: "bg-yellow-400" },
            { label: "Over budget (95%)", pct: 95, color: "bg-red-400" },
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
      <Section title="Log Viewer">
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
            <span className="text-cyan-400">Live</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  PROPERTY ROW PATTERN                                         */}
      {/* ============================================================ */}
      <Section title="Property Row Pattern">
        <div className="border border-border rounded-md p-4 space-y-1 max-w-sm">
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">Status</span>
            <StatusBadge status="active" />
          </div>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">Priority</span>
            <PriorityIcon priority="high" />
          </div>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">Created</span>
            <span className="text-xs">Jan 15, 2025</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  NAVIGATION PATTERNS                                          */}
      {/* ============================================================ */}
      <Section title="Navigation Patterns">
        <SubSection title="Sidebar nav items">
          <div className="w-60 border border-border rounded-md p-3 space-y-0.5 bg-card">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium bg-accent text-accent-foreground">
              <LayoutDashboard className="h-4 w-4" />
              Dashboard
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <CircleDot className="h-4 w-4" />
              Issues
              <span className="ml-auto text-xs bg-primary text-primary-foreground rounded-full px-1.5 py-0.5">
                12
              </span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <Bot className="h-4 w-4" />
              Agents
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <Hexagon className="h-4 w-4" />
              Projects
            </div>
          </div>
        </SubSection>

        <SubSection title="View toggle">
          <div className="flex items-center border border-border rounded-md w-fit">
            <button className="px-3 py-1.5 text-xs font-medium bg-accent text-foreground rounded-l-md">
              <ListTodo className="h-3.5 w-3.5 inline mr-1" />
              List
            </button>
            <button className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent/50 rounded-r-md">
              <Target className="h-3.5 w-3.5 inline mr-1" />
              Org
            </button>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  GROUPED LIST (Issues pattern)                                */}
      {/* ============================================================ */}
      <Section title="Grouped List (Issues pattern)">
        <div>
          <div className="flex items-center gap-2 px-4 py-2 bg-muted/50 rounded-t-md">
            <StatusIcon status="in_progress" />
            <span className="text-sm font-medium">In Progress</span>
            <span className="text-xs text-muted-foreground ml-1">2</span>
          </div>
          <div className="border border-border rounded-b-md">
            <EntityRow
              leading={<PriorityIcon priority="high" />}
              identifier="PAP-101"
              title="Build agent heartbeat system"
              onClick={() => {}}
            />
            <EntityRow
              leading={<PriorityIcon priority="medium" />}
              identifier="PAP-102"
              title="Add cost tracking dashboard"
              onClick={() => {}}
            />
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  COMMENT THREAD PATTERN                                       */}
      {/* ============================================================ */}
      <Section title="Comment Thread Pattern">
        <div className="space-y-3 max-w-2xl">
          <h3 className="text-sm font-semibold">Comments (2)</h3>
          <div className="space-y-3">
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-muted-foreground">Agent</span>
                <span className="text-xs text-muted-foreground">Jan 15, 2025</span>
              </div>
              <p className="text-sm">Started working on the authentication module. Will need API keys configured.</p>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-muted-foreground">Human</span>
                <span className="text-xs text-muted-foreground">Jan 16, 2025</span>
              </div>
              <p className="text-sm">API keys have been added to the vault. Please proceed.</p>
            </div>
          </div>
          <div className="space-y-2">
            <textarea
              className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none resize-none"
              placeholder="Leave a comment..."
              rows={3}
            />
            <Button size="sm">Comment</Button>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  COST TABLE PATTERN                                           */}
      {/* ============================================================ */}
      <Section title="Cost Table Pattern">
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead className="border-b border-border bg-accent/20">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Model</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Tokens</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Cost</th>
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
                <td className="px-3 py-2 font-medium">Total</td>
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
      <Section title="Skeletons">
        <SubSection title="Individual">
          <div className="space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-8 w-full max-w-sm" />
            <Skeleton className="h-20 w-full" />
          </div>
        </SubSection>

        <SubSection title="Page Skeleton (list)">
          <div className="border border-border rounded-md p-4">
            <PageSkeleton variant="list" />
          </div>
        </SubSection>

        <SubSection title="Page Skeleton (detail)">
          <div className="border border-border rounded-md p-4">
            <PageSkeleton variant="detail" />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  SEPARATOR                                                    */}
      {/* ============================================================ */}
      <Section title="Separator">
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">Horizontal</p>
          <Separator />
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  ICON REFERENCE                                               */}
      {/* ============================================================ */}
      <Section title="Common Icons (Lucide)">
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
      <Section title="Keyboard Shortcuts">
        <div className="border border-border rounded-md divide-y divide-border text-sm">
          {[
            ["Cmd+K / Ctrl+K", "Open Command Palette"],
            ["C", "New Issue (outside inputs)"],
            ["[", "Toggle Sidebar"],
            ["]", "Toggle Properties Panel"],
            ["Cmd+Enter / Ctrl+Enter", "Submit markdown comment"],
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
