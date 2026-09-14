import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";

import {
  buildCapabilityScenarioIndex,
  capabilityRunScenario,
  type CapabilityRunArtifact,
  type CapabilityScenarioIndex,
  type CapabilityScenarioIndexEntry,
} from "@paperclip-runner-local/capability";

import {
  AuthorizationPanel,
  ContextPanel,
  denialCount,
  ParityPanel,
  StateDiffPanel,
} from "./components/inspector-panels.js";
import { ScenarioTranscript } from "./components/scenario-transcript.js";
import { RunHeader } from "./components/run-header.js";
import {
  ScenarioPicker,
  buildFacets,
  findTypeaheadMatch,
} from "./components/scenario-picker.js";
import { ExplorerApp, matches } from "./app.js";
import { EMPTY_FILTERS, parseCapabilityRoute } from "./route.js";

const MANIFEST_PATH = resolve(import.meta.dirname, "../../../spec/capability/eval-traceability.yaml");

let index: CapabilityScenarioIndex;
const artifacts = new Map<string, CapabilityRunArtifact>();

beforeAll(async () => {
  index = buildCapabilityScenarioIndex(await readFile(MANIFEST_PATH, "utf8"));
  for (const id of [
    "hb-scoped-wake-01",
    "ap-mcp-gate-01",
    "rs-question-only-01",
    "rs-secret-hygiene-01",
    "rf-api-mgr-heartbeat-01",
    "bl-create-blocked-01",
    "wk-skilltest-mode-01",
  ]) {
    artifacts.set(id, await capabilityRunScenario(entryFor(id)));
  }
});

function entryFor(id: string): CapabilityScenarioIndexEntry {
  const entry = index.entries.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`scenario ${id} is missing`);
  return entry;
}

/** Returns the opening tag for the element carrying `data-testid`. */
function tagFor(markup: string, testId: string): string {
  const index = markup.indexOf(`data-testid="${testId}"`);
  expect(index, `no element with data-testid="${testId}"`).toBeGreaterThan(-1);
  const start = markup.lastIndexOf("<", index);
  return markup.slice(start, markup.indexOf(">", index) + 1);
}

function artifactFor(id: string): CapabilityRunArtifact {
  const artifact = artifacts.get(id);
  if (artifact === undefined) throw new Error(`artifact ${id} was not prepared`);
  return artifact;
}

const NOOP_REPLAY = {
  active: true,
  position: 0,
  length: 0,
  playing: false,
  enter: () => {},
  exit: () => {},
  setPosition: () => {},
  togglePlay: () => {},
  step: () => {},
};

describe("scenario picker", () => {
  it("renders a labelled listbox with every group and a live result count", () => {
    const parityStatus = () => "not_run" as const;
    const visible = index.entries.filter((entry) => matches(entry, EMPTY_FILTERS, parityStatus));
    const facets = buildFacets(index.entries, (key, value) =>
      index.entries.filter((entry) => matches(entry, { ...EMPTY_FILTERS, [key]: value }, parityStatus))
        .length,
    );
    const markup = renderToStaticMarkup(
      <ScenarioPicker
        entries={index.entries}
        visible={visible}
        facets={facets}
        filters={EMPTY_FILTERS}
        selectedId={null}
        parityStatus={parityStatus}
        onFilterChange={() => {}}
        onClearFilters={() => {}}
        onSelect={() => {}}
        onCommitSelection={() => {}}
      />,
    );
    expect(markup).toContain('role="listbox"');
    expect(markup).toContain('aria-label="Scenario picker"');
    expect(markup).toContain("106 of 106 scenarios");
    expect(facets.group).toHaveLength(16);
    expect(facets.group.reduce((total, facet) => total + facet.count, 0)).toBe(106);
    for (const facet of facets.group) {
      expect(markup).toContain(`data-testid="facet-group-${facet.value}"`);
    }
  });

  it("keeps zero-count facet values visible but disabled", () => {
    const parityStatus = () => "not_run" as const;
    const filters = { ...EMPTY_FILTERS, group: "ix" };
    const visible = index.entries.filter((entry) => matches(entry, filters, parityStatus));
    const facets = buildFacets(index.entries, (key, value) =>
      index.entries.filter((entry) => matches(entry, { ...filters, [key]: value }, parityStatus)).length,
    );
    const markup = renderToStaticMarkup(
      <ScenarioPicker
        entries={index.entries}
        visible={visible}
        facets={facets}
        filters={filters}
        selectedId={null}
        parityStatus={parityStatus}
        onFilterChange={() => {}}
        onClearFilters={() => {}}
        onSelect={() => {}}
        onCommitSelection={() => {}}
      />,
    );
    expect(markup).toContain('data-testid="clear-filters"');
    expect(markup).toContain('data-testid="active-filter-group"');
    // Parity is "not run" for every scenario here, so Pass must render disabled.
    expect(tagFor(markup, "facet-parity-pass")).toContain("disabled");
  });

  it("offers a way out when no scenario matches", () => {
    const markup = renderToStaticMarkup(
      <ScenarioPicker
        entries={index.entries}
        visible={[]}
        facets={buildFacets(index.entries, () => 0)}
        filters={{ ...EMPTY_FILTERS, query: "no-such-case" }}
        selectedId={null}
        parityStatus={() => "not_run"}
        onFilterChange={() => {}}
        onClearFilters={() => {}}
        onSelect={() => {}}
        onCommitSelection={() => {}}
      />,
    );
    expect(markup).toContain("No scenarios match these filters.");
    expect(markup).toContain("Clear filters");
  });

  it("type-ahead matches case IDs and titles and wraps after the active option", () => {
    const interactionCases = index.entries.filter((entry) => entry.group === "ix");
    expect(findTypeaheadMatch(interactionCases, null, "ix-checkbox-r")?.id).toBe(
      "ix-checkbox-result-01",
    );
    expect(findTypeaheadMatch(interactionCases, "ix-checkbox-01", "checkbox continuation")?.id).toBe(
      "ix-checkbox-result-01",
    );
    expect(findTypeaheadMatch(interactionCases, "ix-checkbox-result-01", "i")?.id).not.toBe(
      "ix-checkbox-result-01",
    );
  });
});

describe("scenario transcript", () => {
  it("separates the agent and control-plane channels", () => {
    const artifact = artifactFor("hb-scoped-wake-01");
    const markup = renderToStaticMarkup(
      <ScenarioTranscript timeline={artifact.timeline} highlightSequence={null} />,
    );
    expect(markup).toContain('data-channel="control_plane"');
    expect(markup).toContain('data-channel="agent"');
    expect(markup).toContain("Control plane");
    expect(markup).toContain("no agent tool exists for this");
    expect(markup).toContain("get_task_context");
  });

  it("renders a typed denial in place, with no protected state", () => {
    const artifact = artifactFor("ap-mcp-gate-01");
    const markup = renderToStaticMarkup(
      <ScenarioTranscript timeline={artifact.timeline} highlightSequence={null} />,
    );
    expect(markup).toContain('data-outcome="denied"');
    expect(markup).toContain("required_claim_missing");
    expect(markup).toContain("not returned — the denial carries no task data");
    expect(markup).toContain('data-testid="denial-announcement"');
    expect(markup).toContain('aria-live="assertive"');
  });

  it("keeps restraint legible when the correct behaviour is absence", () => {
    const artifact = artifactFor("rs-question-only-01");
    const markup = renderToStaticMarkup(
      <ScenarioTranscript timeline={artifact.timeline} highlightSequence={null} />,
    );
    expect(markup).toContain('data-testid="restraint-note"');
    expect(markup).toContain("No further operations");
  });

  it("renders a redaction chip that names its rule and never the value", () => {
    const artifact = artifactFor("rs-secret-hygiene-01");
    const markup = renderToStaticMarkup(
      <ScenarioTranscript timeline={artifact.timeline} highlightSequence={null} />,
    );
    expect(markup).toContain('data-testid="redaction-chip"');
    expect(markup).toContain("read_secret_value:$.value");
    expect(markup).not.toContain("fixture-secret-value-not-a-real-credential");
  });

  it("flags the test-only escape hatch on every call card that uses it", () => {
    const artifact = artifactFor("wk-skilltest-mode-01");
    expect(
      artifact.timeline.some((item) => item.kind === "semantic_call" && item.escapeHatch),
      "the skill-test scenario must exercise the generic escape hatch",
    ).toBe(true);
    const markup = renderToStaticMarkup(
      <ScenarioTranscript timeline={artifact.timeline} highlightSequence={null} />,
    );
    expect(markup).toContain('data-testid="escape-hatch-banner"');
  });
});

describe("explorer shell fallbacks", () => {
  it("renders a named unknown-case error with a picker link", () => {
    const markup = renderToStaticMarkup(
      <ExplorerApp index={index} initialRoute={parseCapabilityRoute("#/case/not-a-real-scenario")} />,
    );
    expect(markup).toContain('data-testid="unknown-scenario"');
    expect(markup).toContain("No scenario named");
    expect(markup).toContain("not-a-real-scenario");
    expect(markup).toContain('href="#/"');
    expect(markup).toContain("Back to the scenario picker");
  });

  it("keeps the frozen SDK badge fixes scoped to the explorer stylesheet", async () => {
    const css = await readFile(resolve(import.meta.dirname, "explorer.css"), "utf8");
    expect(css).toContain('.pcr7-shell .pcr-disclosure-summary > [data-slot="badge"]');
    expect(css).toContain("flex: none");
    expect(css).toContain(".pcr7-shell .pcr-badge");
    expect(css).toContain("text-transform: none");
  });
});

describe("inspector panels", () => {
  it("context lists always tools, optional tools with their grant, and control-plane absence", () => {
    const artifact = artifactFor("rf-api-mgr-heartbeat-01");
    const markup = renderToStaticMarkup(
      <ContextPanel entry={entryFor("rf-api-mgr-heartbeat-01")} artifact={artifact} />,
    );
    expect(markup).toContain('data-testid="exposure-always"');
    expect(markup).toContain('data-testid="exposure-optional"');
    expect(markup).toContain('data-testid="exposure-control-plane"');
    expect(markup).toContain("via <code");
    expect(markup).toContain("discovery:agents:read");
    expect(markup).toContain("checkout_task");
    expect(markup).toContain("Manager");
  });

  it("context renders a primed empty state before any run", () => {
    const markup = renderToStaticMarkup(
      <ContextPanel entry={entryFor("hb-scoped-wake-01")} artifact={null} />,
    );
    expect(markup).toContain("No run yet.");
    expect(markup).not.toContain('data-testid="exposure-always"');
  });

  it("authorization renders one row per record with an icon and a text decision", () => {
    const artifact = artifactFor("ap-mcp-gate-01");
    const markup = renderToStaticMarkup(
      <AuthorizationPanel records={artifact.authorizationRecords} />,
    );
    expect(denialCount(artifact.authorizationRecords)).toBeGreaterThan(0);
    expect(markup).toContain('data-outcome="denied"');
    expect(markup).toContain("Deny");
    expect(markup).toContain("Allow");
    for (const record of artifact.authorizationRecords) {
      expect(markup).toContain(`data-testid="authorization-row-${record.sequence}"`);
    }
  });

  it("state diff groups the ten entity domains and collapses unchanged ones", () => {
    const artifact = artifactFor("bl-create-blocked-01");
    const markup = renderToStaticMarkup(<StateDiffPanel diff={artifact.diff} />);
    for (const domain of [
      "tasks",
      "comments",
      "documents",
      "interactions",
      "approvals",
      "artifacts",
      "blockers",
      "workspace",
      "budget",
      "run",
    ]) {
      expect(markup).toContain(`data-testid="diff-domain-${domain}"`);
    }
    expect(markup).toContain("unchanged");
    expect(markup).toContain('data-change="added"');
    expect(markup).toContain("Added");
  });

  it("parity renders the verdict, assertions, forbidden list, and the 7E carry-through", () => {
    const artifact = artifactFor("rs-question-only-01");
    const markup = renderToStaticMarkup(<ParityPanel parity={artifact.parity} />);
    expect(markup).toContain('data-testid="parity-verdict"');
    expect(markup).toContain('data-testid="parity-assertion-1"');
    expect(markup).toContain('data-testid="parity-forbidden"');
    expect(markup).toContain("Not run");
    expect(markup).toContain("never recomputes it");
    expect(markup).toContain("Reference baseline, not the pass condition");
  });

  it("every panel renders a designed empty state rather than a dead panel", () => {
    expect(renderToStaticMarkup(<AuthorizationPanel records={[]} />)).toContain("No run yet.");
    expect(renderToStaticMarkup(<StateDiffPanel diff={null} />)).toContain("No run yet.");
    expect(renderToStaticMarkup(<ParityPanel parity={null} />)).toContain("No run yet.");
  });
});

describe("run header", () => {
  it("names the verdict, the assertion counts, and offers a parity deep link", () => {
    const artifact = artifactFor("hb-scoped-wake-01");
    const markup = renderToStaticMarkup(
      <RunHeader
        entry={entryFor("hb-scoped-wake-01")}
        artifact={artifact}
        runState="settled"
        codexAvailable={false}
        mode="fake"
        replay={NOOP_REPLAY}
        onRun={() => {}}
        onModeChange={() => {}}
        onOpenParity={() => {}}
      />,
    );
    expect(markup).toContain('data-testid="verdict-banner"');
    expect(markup).toContain("assertions");
    expect(markup).toContain("Open parity");
    expect(markup).toContain('data-testid="replay-controls"');
  });

  it("disables Codex mode with a stated reason when the relay is unavailable", () => {
    const markup = renderToStaticMarkup(
      <RunHeader
        entry={entryFor("hb-scoped-wake-01")}
        artifact={null}
        runState="idle"
        codexAvailable={false}
        mode="fake"
        replay={NOOP_REPLAY}
        onRun={() => {}}
        onModeChange={() => {}}
        onOpenParity={() => {}}
      />,
    );
    expect(tagFor(markup, "mode-codex")).toContain("disabled");
    expect(markup).toContain("provider relay not running");
    expect(markup).toContain("Fake mode stays fully usable offline");
  });

  it("reports a harness failure without discarding the partial timeline", () => {
    const artifact = artifactFor("hb-scoped-wake-01");
    const markup = renderToStaticMarkup(
      <RunHeader
        entry={entryFor("hb-scoped-wake-01")}
        artifact={{ ...artifact, failure: { message: "fixture is missing" } }}
        runState="failed"
        codexAvailable={false}
        mode="fake"
        replay={NOOP_REPLAY}
        onRun={() => {}}
        onModeChange={() => {}}
        onOpenParity={() => {}}
      />,
    );
    expect(markup).toContain("harness error: fixture is missing");
    expect(markup).toContain("Re-run scenario");
  });
});

describe("credential and policy boundary", () => {
  it("renders no credential, token, or API key anywhere in a run artifact", () => {
    for (const artifact of artifacts.values()) {
      const serialized = JSON.stringify(artifact).toLowerCase();
      for (const forbidden of [
        "authorization: bearer",
        "api_key=",
        "paperclip_api_key",
        "sk-ant-",
        "fixture-secret-value-not-a-real-credential",
      ]) {
        expect(serialized, `${artifact.scenarioId} leaked ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("never re-derives a disposition in the view layer", () => {
    for (const artifact of artifacts.values()) {
      for (const item of artifact.timeline) {
        if (item.kind !== "semantic_call") continue;
        expect(["always_agent_tool", "optional_agent_tool"]).toContain(item.disposition);
      }
    }
  });
});
