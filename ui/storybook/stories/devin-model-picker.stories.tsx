import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AdapterModel } from "@/api/agents";
import { DevinModelPicker } from "@/adapters/devin-local/model-picker";
import type { DevinModelDraftStatus } from "@/adapters/devin-local/model-selection";

const ALPHA = {
  id: "alpha-high",
  modelKey: "alpha",
  modelLabel: "Alpha",
  effortKey: "high",
  effortLabel: "High",
  effortSource: "uid" as const,
  label: "Alpha High",
  modifiers: [] as string[],
};

const MODELS: AdapterModel[] = [
  { id: "devin-family", label: "Devin family", efforts: ["low", "medium", "high"] },
  {
    id: "fusion-alpha-high-sidekick-beta-low",
    label: "Fusion (Alpha High + Beta Low)",
    fusion: {
      version: 1,
      kind: "fusion",
      components: {
        orchestrator: ALPHA,
        worker: {
          ...ALPHA,
          id: "beta-low",
          modelKey: "beta",
          modelLabel: "Beta",
          effortKey: "low",
          effortLabel: "Low",
          label: "Beta Low",
        },
      },
      rates: {
        orchestrator: { inputPerMillion: 2, cachedInputPerMillion: 0.2, outputPerMillion: 8 },
        worker: { inputPerMillion: 0.5, cachedInputPerMillion: 0.05, outputPerMillion: 2 },
      },
      costSummary: "$2.00 / 1M Input + $8.00 / 1M Output",
    },
  },
  {
    id: "fusion-alpha-high-sidekick-beta-low-priority",
    label: "Fusion (Alpha High + Beta Low Priority)",
    fusion: {
      version: 1,
      kind: "fusion",
      components: {
        orchestrator: ALPHA,
        worker: {
          ...ALPHA,
          id: "beta-low-priority",
          modelKey: "beta",
          modelLabel: "Beta",
          effortKey: "low",
          effortLabel: "Low",
          label: "Beta Low Fast",
          modifiers: ["priority"],
        },
      },
      rates: null,
      costSummary: "$3.00 / 1M Input",
    },
  },
  {
    id: "fusion-gamma-unspecified-sidekick-delta-fixed-low",
    label: "Fusion (Gamma + Delta Fixed Low)",
    fusion: {
      version: 1,
      kind: "fusion",
      components: {
        orchestrator: {
          ...ALPHA,
          id: "gamma",
          modelKey: "gamma",
          modelLabel: "Gamma",
          effortKey: "unspecified:gamma",
          effortLabel: "Not specified by catalog",
          effortSource: "unspecified",
          label: "Gamma",
        },
        worker: {
          ...ALPHA,
          id: "delta-fixed-low",
          modelKey: "delta",
          modelLabel: "Delta",
          effortKey: "fixed:delta-fixed-low",
          effortLabel: "Low (fixed)",
          effortSource: "label_fixed",
          label: "Delta Fixed Low",
        },
      },
      rates: null,
      costSummary: null,
    },
  },
  {
    id: "fusion-legacy-opaque",
    label: "Fusion (Legacy + Unknown)",
    fusion: { version: 1, kind: "fusion", components: null, rates: null, costSummary: "$5.00 / 1M Input" },
  },
  {
    id: "fusion-an-extremely-long-model-name-that-keeps-going-sidekick-worker-with-an-equally-long-name-priority",
    label: "Fusion (<script>alert(1)</script> Alpha High + A worker label that is deliberately very long to exercise wrapping behavior in the picker summary card)",
    fusion: {
      version: 1,
      kind: "fusion",
      components: {
        orchestrator: ALPHA,
        worker: {
          ...ALPHA,
          id: "worker-with-an-equally-long-name-priority",
          modelKey: "worker-long",
          modelLabel: "<img src=x onerror=alert(1)>",
          effortKey: "low",
          effortLabel: "Low",
          label: "Worker Long Low Fast",
          modifiers: ["priority"],
        },
      },
      rates: null,
      costSummary: null,
    },
  },
];

function Harness({
  initialValue = "",
  models = MODELS,
  catalogState = "ready",
  catalogError = null,
}: {
  initialValue?: string;
  models?: AdapterModel[];
  catalogState?: "loading" | "ready" | "error";
  catalogError?: string | null;
}) {
  const [value, setValue] = useState(initialValue);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<DevinModelDraftStatus | null>(null);
  return (
    <TooltipProvider>
      <div className="max-w-xl space-y-4 p-4">
        <DevinModelPicker
          models={models}
          value={value}
          onChange={setValue}
          open={open}
          onOpenChange={setOpen}
          allowDefault
          required={false}
          groupByProvider={false}
          creatable
          scopeKey="storybook"
          catalogState={catalogState}
          catalogError={catalogError}
          onDraftStatusChange={setStatus}
        />
        <pre className="rounded-md border border-border bg-muted/40 p-2 text-xs">
          {JSON.stringify({ value, status }, null, 2)}
        </pre>
      </div>
    </TooltipProvider>
  );
}

const meta: Meta<typeof Harness> = {
  title: "Adapters/Devin Model Picker",
  component: Harness,
};
export default meta;
type Story = StoryObj<typeof Harness>;

export const Empty: Story = {};

export const FusionSelected: Story = {
  args: { initialValue: "fusion-alpha-high-sidekick-beta-low-priority" },
};

export const OpaqueFusion: Story = {
  args: { initialValue: "fusion-legacy-opaque" },
};

export const BareFusionRejected: Story = {
  args: { initialValue: "fusion" },
};

export const CatalogOffline: Story = {
  args: {
    catalogState: "error",
    catalogError: "Could not reach the Devin CLI discovery endpoint.",
  },
};

export const CatalogLoading: Story = {
  args: { catalogState: "loading" },
};

export const PartialFiltersOnly: Story = {
  args: { initialValue: "" },
  render: (args) => <Harness {...args} />,
};

export const FixedEffortOnly: Story = {
  args: { initialValue: "fusion-gamma-unspecified-sidekick-delta-fixed-low" },
};

export const LongHostileLabel: Story = {
  args: {
    initialValue:
      "fusion-an-extremely-long-model-name-that-keeps-going-sidekick-worker-with-an-equally-long-name-priority",
  },
};
