import { describe, expect, it } from "vitest";
import type { AdapterModel } from "../../api/agents";
import type { AdapterModelFusionComponent } from "@paperclipai/adapter-utils";
import {
  changeFusionFilter,
  devinModelActionError,
  devinModelView,
  filterFusionModels,
  fusionComponents,
  fusionFilterOptions,
  fusionFiltersForModel,
  isFusionOption,
} from "./model-selection";

function component(
  overrides: Partial<AdapterModelFusionComponent> = {},
): AdapterModelFusionComponent {
  return {
    id: "alpha-high",
    modelKey: "alpha",
    modelLabel: "Alpha",
    effortKey: "high",
    effortLabel: "High",
    effortSource: "uid",
    label: "Alpha High",
    modifiers: [],
    ...overrides,
  };
}

function fusionModel(
  id: string,
  label: string,
  orchestrator: AdapterModelFusionComponent,
  worker: AdapterModelFusionComponent,
): AdapterModel {
  return {
    id,
    label,
    fusion: {
      version: 1,
      kind: "fusion",
      components: { orchestrator, worker },
      rates: null,
      costSummary: null,
    },
  };
}

const ORCH_ALPHA_HIGH = component();
const ORCH_ALPHA_LOW = component({
  id: "alpha-low",
  effortKey: "low",
  effortLabel: "Low",
  label: "Alpha Low",
});
const ORCH_GAMMA = component({
  id: "gamma-2",
  modelKey: "gamma",
  modelLabel: "Gamma",
  effortKey: "fixed:gamma-2",
  effortLabel: "High (fixed)",
  effortSource: "label_fixed",
});
const WORK_BETA_LOW = component({
  id: "beta-low",
  modelKey: "beta",
  modelLabel: "Beta",
  effortKey: "low",
  effortLabel: "Low",
  label: "Beta Low",
});
const WORK_BETA_PRIORITY = component({
  ...WORK_BETA_LOW,
  id: "beta-low-priority",
  modifiers: ["priority"],
});
const WORK_DELTA_UNSPEC = component({
  id: "delta-3",
  modelKey: "delta",
  modelLabel: "Delta",
  effortKey: "unspecified:delta-3",
  effortLabel: "Not specified by catalog",
  effortSource: "unspecified",
});

const MODELS: AdapterModel[] = [
  fusionModel(
    "fusion-alpha-high-sidekick-beta-low",
    "Fusion (Alpha High + Beta Low)",
    ORCH_ALPHA_HIGH,
    WORK_BETA_LOW,
  ),
  fusionModel(
    "fusion-alpha-high-sidekick-beta-low-priority",
    "Fusion (Alpha High + Beta Low Priority)",
    ORCH_ALPHA_HIGH,
    WORK_BETA_PRIORITY,
  ),
  fusionModel(
    "fusion-alpha-low-sidekick-delta-3",
    "Fusion (Alpha Low + Delta)",
    ORCH_ALPHA_LOW,
    WORK_DELTA_UNSPEC,
  ),
  fusionModel(
    "fusion-gamma-2-sidekick-beta-low",
    "Fusion (Gamma + Beta Low)",
    ORCH_GAMMA,
    WORK_BETA_LOW,
  ),
  {
    id: "fusion-legacy-opaque",
    label: "Fusion (Legacy + Unknown)",
    fusion: {
      version: 1,
      kind: "fusion",
      components: null,
      rates: null,
      costSummary: "$2 / 1M Input",
    },
  },
  {
    id: "acme-pair-1",
    label: "Acme pair",
    fusion: {
      version: 1,
      kind: "fusion",
      components: { orchestrator: ORCH_ALPHA_HIGH, worker: WORK_BETA_LOW },
      rates: null,
      costSummary: null,
    },
  },
  { id: "devin-family", label: "Devin family", efforts: ["low", "high"] },
];

describe("devinModelView / isFusionOption", () => {
  it("classifies default, single, and fusion values", () => {
    expect(devinModelView("", MODELS)).toBe("default");
    expect(devinModelView("devin-family", MODELS)).toBe("single");
    expect(devinModelView("fusion-alpha-high-sidekick-beta-low", MODELS)).toBe("fusion");
    expect(devinModelView("acme-pair-1", MODELS)).toBe("fusion");
    expect(devinModelView("fusion-not-in-catalog", MODELS)).toBe("fusion");
    expect(devinModelView("unknown-manual", MODELS)).toBe("single");
  });

  it("treats fusion-prefixed and metadata-backed entries as fusion options", () => {
    expect(MODELS.filter(isFusionOption).map((m) => m.id)).toEqual([
      "fusion-alpha-high-sidekick-beta-low",
      "fusion-alpha-high-sidekick-beta-low-priority",
      "fusion-alpha-low-sidekick-delta-3",
      "fusion-gamma-2-sidekick-beta-low",
      "fusion-legacy-opaque",
      "acme-pair-1",
    ]);
  });
});

describe("fusionComponents", () => {
  it("rejects malformed metadata instead of trusting it", () => {
    const base = MODELS[0]!;
    expect(fusionComponents(base)).not.toBeNull();
    for (const fusion of [
      { version: 2, kind: "fusion", components: base.fusion!.components },
      { version: 1, kind: "other", components: base.fusion!.components },
      { version: 1, kind: "fusion", components: null },
      {
        version: 1,
        kind: "fusion",
        components: { orchestrator: { ...ORCH_ALPHA_HIGH, modifiers: "fast" }, worker: WORK_BETA_LOW },
      },
      {
        version: 1,
        kind: "fusion",
        components: { orchestrator: { ...ORCH_ALPHA_HIGH, effortSource: "guessed" }, worker: WORK_BETA_LOW },
      },
      {
        version: 1,
        kind: "fusion",
        components: { orchestrator: { ...ORCH_ALPHA_HIGH, modelLabel: 7 }, worker: WORK_BETA_LOW },
      },
    ]) {
      expect(fusionComponents({ ...base, fusion: fusion as never })).toBeNull();
    }
  });
});

describe("filterFusionModels", () => {
  it("returns only structured candidates matching every defined filter", () => {
    expect(
      filterFusionModels(MODELS, { orchestratorModel: "alpha" }).map((m) => m.id),
    ).toEqual([
      "fusion-alpha-high-sidekick-beta-low",
      "fusion-alpha-high-sidekick-beta-low-priority",
      "fusion-alpha-low-sidekick-delta-3",
      "acme-pair-1",
    ]);
    expect(
      filterFusionModels(MODELS, {
        orchestratorModel: "alpha",
        orchestratorEffort: "high",
        workerModel: "beta",
        workerEffort: "low",
      }).map((m) => m.id),
    ).toEqual([
      "fusion-alpha-high-sidekick-beta-low",
      "fusion-alpha-high-sidekick-beta-low-priority",
      "acme-pair-1",
    ]);
    expect(
      filterFusionModels(MODELS, { orchestratorModel: "missing" }),
    ).toEqual([]);
  });
});

describe("fusionFilterOptions", () => {
  it("scopes options to preceding fields only", () => {
    const workerEfforts = fusionFilterOptions(
      MODELS,
      { orchestratorModel: "alpha", orchestratorEffort: "high", workerModel: "beta" },
      "workerEffort",
    );
    expect(workerEfforts).toEqual([{ id: "low", label: "Low" }]);

    const orchestratorModels = fusionFilterOptions(MODELS, {}, "orchestratorModel");
    expect(orchestratorModels).toEqual([
      { id: "alpha", label: "Alpha" },
      { id: "gamma", label: "Gamma" },
    ]);

    const workerModels = fusionFilterOptions(
      MODELS,
      { orchestratorModel: "alpha", orchestratorEffort: "low" },
      "workerModel",
    );
    expect(workerModels).toEqual([{ id: "delta", label: "Delta" }]);
  });

  it("falls back to the id when labels conflict for one option id", () => {
    const conflicting: AdapterModel[] = [
      fusionModel("fusion-a-sidekick-b", "A + B", ORCH_ALPHA_HIGH, WORK_BETA_LOW),
      fusionModel(
        "fusion-a2-sidekick-b",
        "A2 + B",
        component({ id: "alpha2-high", modelLabel: "Alpha Prime" }),
        WORK_BETA_LOW,
      ),
    ];
    const options = fusionFilterOptions(conflicting, {}, "orchestratorModel");
    expect(options).toEqual([{ id: "alpha", label: "alpha" }]);
  });
});

describe("changeFusionFilter", () => {
  it("preserves compatible later filters and clears incompatible ones", () => {
    const previous = {
      orchestratorModel: "alpha",
      orchestratorEffort: "high",
      workerModel: "beta",
      workerEffort: "low",
    };
    const changed = changeFusionFilter(MODELS, previous, "orchestratorEffort", "low");
    expect(changed.filters).toEqual({
      orchestratorModel: "alpha",
      orchestratorEffort: "low",
    });
    expect(changed.cleared).toEqual(["workerModel", "workerEffort"]);
  });

  it("keeps later filters that still match under the new prefix", () => {
    const previous = {
      orchestratorModel: "alpha",
      orchestratorEffort: "high",
      workerModel: "beta",
      workerEffort: "low",
    };
    const changed = changeFusionFilter(MODELS, previous, "workerEffort", "low");
    expect(changed.filters).toEqual(previous);
    expect(changed.cleared).toEqual([]);
  });

  it("clears the field itself on an empty value", () => {
    const changed = changeFusionFilter(
      MODELS,
      { orchestratorModel: "alpha", workerModel: "beta" },
      "orchestratorModel",
      "",
    );
    expect(changed.filters.orchestratorModel).toBeUndefined();
  });
});

describe("fusionFiltersForModel", () => {
  it("derives filters from structured metadata and {} for opaque", () => {
    expect(fusionFiltersForModel(MODELS[0])).toEqual({
      orchestratorModel: "alpha",
      orchestratorEffort: "high",
      workerModel: "beta",
      workerEffort: "low",
    });
    expect(fusionFiltersForModel(MODELS[4])).toEqual({});
    expect(fusionFiltersForModel(undefined)).toEqual({});
  });
});

describe("devinModelActionError", () => {
  it("rejects bare fusion before any draft state", () => {
    for (const value of ["fusion", " Fusion ", "FUSION"]) {
      expect(devinModelActionError(value, { view: "fusion", dirty: false, pending: false, message: null })).toBe(
        "Choose an explicit Fusion combination; select an orchestrator and worker.",
      );
    }
  });

  it("surfaces the pending draft message and defaults one", () => {
    expect(
      devinModelActionError("devin-family", {
        view: "fusion",
        dirty: true,
        pending: true,
        message: "Cleared Worker model.",
      }),
    ).toBe("Cleared Worker model.");
    expect(
      devinModelActionError("devin-family", {
        view: "fusion",
        dirty: true,
        pending: true,
        message: null,
      }),
    ).toBe("Complete the model selection before continuing.");
    expect(
      devinModelActionError("devin-family", {
        view: "single",
        dirty: false,
        pending: false,
        message: null,
      }),
    ).toBeNull();
  });
});
