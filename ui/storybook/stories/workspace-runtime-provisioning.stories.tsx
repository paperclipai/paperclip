import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { RuntimeProvisionStatusValue, type RuntimeProvisionStatus } from "@/pages/ExecutionWorkspaceDetail";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const noop = () => {};

// Mirrors the DetailRow layout used on the execution workspace detail page so the
// captured story matches how the "Runtime provisioning" row renders in context.
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 py-1.5 sm:flex-row sm:items-start sm:gap-3">
      <div className="shrink-0 text-xs text-muted-foreground sm:w-32">{label}</div>
      <div className="min-w-0 flex-1 text-sm">{children}</div>
    </div>
  );
}

function ContextCard({ status }: { status: RuntimeProvisionStatus }) {
  return (
    <Card className="max-w-xl rounded-none">
      <CardHeader>
        <CardTitle>Workspace context</CardTitle>
        <CardDescription>Linked objects and relationships</CardDescription>
      </CardHeader>
      <CardContent>
        <DetailRow label="Project">board-ui</DetailRow>
        <DetailRow label="Runtime provisioning">
          <RuntimeProvisionStatusValue status={status} onViewLogs={noop} />
        </DetailRow>
        <DetailRow label="Workspace ID">
          <span className="font-mono text-xs">ews-7f21c9a3</span>
        </DetailRow>
      </CardContent>
    </Card>
  );
}

const meta: Meta<typeof RuntimeProvisionStatusValue> = {
  title: "Workspaces/Runtime provisioning status",
  component: RuntimeProvisionStatusValue,
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof RuntimeProvisionStatusValue>;

export const Deferred: Story = {
  name: "Deferred (configured, not yet run)",
  render: () => <ContextCard status={{ kind: "deferred" }} />,
};

export const Provisioned: Story = {
  name: "Provisioned at <time>",
  render: () => <ContextCard status={{ kind: "provisioned", at: new Date("2026-08-01T18:24:00Z") }} />,
};

export const Provisioning: Story = {
  name: "Provisioning… (running)",
  render: () => <ContextCard status={{ kind: "provisioning", at: new Date("2026-08-01T18:23:00Z") }} />,
};

export const Failed: Story = {
  name: "Failed (links to runtime logs)",
  render: () => <ContextCard status={{ kind: "failed", at: new Date("2026-08-01T18:24:00Z") }} />,
};

export const Eager: Story = {
  name: "Eager (no runtime provision command)",
  render: () => <ContextCard status={{ kind: "eager" }} />,
};

export const AllStates: Story = {
  name: "All states (overview)",
  render: () => (
    <div className="flex max-w-md flex-col gap-4">
      {(
        [
          ["Eager", { kind: "eager" }],
          ["Deferred", { kind: "deferred" }],
          ["Provisioning", { kind: "provisioning", at: new Date("2026-08-01T18:23:00Z") }],
          ["Provisioned", { kind: "provisioned", at: new Date("2026-08-01T18:24:00Z") }],
          ["Failed", { kind: "failed", at: new Date("2026-08-01T18:24:00Z") }],
        ] as const
      ).map(([label, status]) => (
        <div key={label} className="flex items-start justify-between gap-6 border-b border-border/60 pb-3">
          <span className="text-sm font-medium text-muted-foreground">{label}</span>
          <RuntimeProvisionStatusValue status={status} onViewLogs={noop} />
        </div>
      ))}
    </div>
  ),
};
