import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AlertTriangle, ArrowRight, Check, Copy, Play, Plus, Save, Search, Settings } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const buttonVariants = ["default", "secondary", "outline", "ghost", "destructive", "link"] as const;
const buttonSizes = ["xs", "sm", "default", "lg", "icon", "icon-sm"] as const;
const badgeVariants = ["default", "secondary", "outline", "destructive", "ghost", "link"] as const;

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="paperclip-story__frame overflow-hidden">
      <div className="border-b border-border px-5 py-4">
        <div className="paperclip-story__label">{eyebrow}</div>
        <h2 className="mt-1 text-xl font-semibold">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function FoundationsMatrix() {
  const [autoMode, setAutoMode] = useState(true);
  const [boardApproval, setBoardApproval] = useState(true);

  return (
    <div className="paperclip-story">
      <main className="paperclip-story__inner space-y-6">
        <section className="paperclip-story__frame p-6">
          <div className="paperclip-story__label">Foundations</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Primitives and interaction states</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
            A dense pass over the base controls that Paperclip pages use for operational actions, filtering,
            approvals, and settings.
          </p>
        </section>

        <Section eyebrow="Actions" title="Button variants and sizes">
          <div className="space-y-6">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {buttonVariants.map((variant) => (
                <div key={variant} className="rounded-lg border border-border bg-background/70 p-4">
                  <div className="mb-3 text-xs font-medium capitalize text-muted-foreground">{variant}</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant={variant}>
                      <Play className="h-4 w-4" />
                      Invoke run
                    </Button>
                    <Button variant={variant} disabled>
                      Disabled
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <div className="rounded-lg border border-border bg-background/70 p-4">
              <div className="mb-3 text-xs font-medium text-muted-foreground">Sizes and icon-only actions</div>
              <div className="flex flex-wrap items-center gap-2">
                {buttonSizes.map((size) => (
                  <Button key={size} size={size} variant={size.startsWith("icon") ? "outline" : "secondary"}>
                    {size.startsWith("icon") ? <Settings /> : size}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </Section>

        <Section eyebrow="Status labels" title="Badges and compact metadata">
          <div className="flex flex-wrap gap-2">
            {badgeVariants.map((variant) => (
              <Badge key={variant} variant={variant}>
                {variant === "destructive" ? <AlertTriangle /> : variant === "default" ? <Check /> : null}
                {variant}
              </Badge>
            ))}
            <Badge variant="outline" className="font-mono">
              PAP-1641
            </Badge>
            <Badge variant="secondary">
              <ArrowRight />
              in review
            </Badge>
          </div>
        </Section>

        <Section eyebrow="Inputs" title="Form controls with real Paperclip copy">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="space-y-4">
              <div className="grid gap-2">
                <Label htmlFor="story-title">Issue title</Label>
                <Input id="story-title" defaultValue="Create Storybook coverage for the board UI" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="story-summary">Comment</Label>
                <Textarea
                  id="story-summary"
                  defaultValue={"Implemented the foundation stories.\nNext action: run static build verification."}
                  rows={5}
                />
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label>Priority</Label>
                  <Select defaultValue="high">
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Priority" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="critical">Critical</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="low">Low</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label>Assignee</Label>
                  <Select defaultValue="codexcoder">
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Assignee" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="codexcoder">CodexCoder</SelectItem>
                      <SelectItem value="qachecker">QAChecker</SelectItem>
                      <SelectItem value="board">Board</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Governed settings</CardTitle>
                <CardDescription>Switches, checkboxes, and validation copy in one compact panel.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
                  <div>
                    <div className="text-sm font-medium">Auto mode</div>
                    <div className="text-xs text-muted-foreground">Let agents continue after review approval.</div>
                  </div>
                  <ToggleSwitch checked={autoMode} onCheckedChange={setAutoMode} />
                </div>
                <label className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm">
                  <Checkbox checked={boardApproval} onCheckedChange={(value) => setBoardApproval(value === true)} />
                  <span>
                    <span className="font-medium">Require board approval for new agents</span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      Mirrors the company-level governance control.
                    </span>
                  </span>
                </label>
              </CardContent>
            </Card>
          </div>
        </Section>

        <Section eyebrow="Navigation" title="Tabs, overlays, and modal affordances">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
            <Tabs defaultValue="details" className="rounded-lg border border-border bg-background/70 p-4">
              <TabsList variant="line">
                <TabsTrigger value="details">Details</TabsTrigger>
                <TabsTrigger value="activity">Activity</TabsTrigger>
                <TabsTrigger value="budget">Budget</TabsTrigger>
              </TabsList>
              <TabsContent value="details" className="pt-5 text-sm leading-6 text-muted-foreground">
                The line tab style is used on dense detail pages where the content, not the tab chrome, needs to dominate.
              </TabsContent>
              <TabsContent value="activity" className="pt-5 text-sm leading-6 text-muted-foreground">
                Activity copy stays compact and pairs with timestamped rows in the product stories.
              </TabsContent>
              <TabsContent value="budget" className="pt-5 text-sm leading-6 text-muted-foreground">
                Budget controls surface warning and hard-stop states in the control-plane stories.
              </TabsContent>
            </Tabs>

            <div className="space-y-3">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" className="w-full justify-start">
                    <Search className="h-4 w-4" />
                    Hover for tooltip
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Search issues, agents, projects, and approvals.</TooltipContent>
              </Tooltip>

              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-start">
                    <Copy className="h-4 w-4" />
                    Open popover
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72">
                  <div className="text-sm font-medium">Copy-safe detail</div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Popovers should keep quick metadata close to the control that opened them.
                  </p>
                </PopoverContent>
              </Popover>

              <Dialog>
                <DialogTrigger asChild>
                  <Button className="w-full justify-start">
                    <Plus className="h-4 w-4" />
                    Open dialog
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Create issue</DialogTitle>
                    <DialogDescription>
                      Dialogs should keep the primary decision and risk clear without leaving the current board context.
                    </DialogDescription>
                  </DialogHeader>
                  <Separator />
                  <div className="grid gap-2">
                    <Label htmlFor="dialog-title">Title</Label>
                    <Input id="dialog-title" defaultValue="Review Storybook visual coverage" />
                  </div>
                  <DialogFooter>
                    <Button variant="outline">Cancel</Button>
                    <Button>
                      <Save className="h-4 w-4" />
                      Save
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </Section>
      </main>
    </div>
  );
}

const meta = {
  title: "Foundations/Primitive Matrix",
  component: FoundationsMatrix,
  parameters: {
    docs: {
      description: {
        component:
          "Foundation stories keep base shadcn/Radix primitives visible in every variant and key interaction state used by Paperclip.",
      },
    },
  },
} satisfies Meta<typeof FoundationsMatrix>;

export default meta;

type Story = StoryObj<typeof meta>;

export const AllPrimitives: Story = {};
