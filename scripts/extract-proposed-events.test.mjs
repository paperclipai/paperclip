import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

import {
  PROPOSED_TELEMETRY_SCHEMA_VERSION,
  assertRepoRelativePath,
  extractProposedEvents,
  toRepoRelativePath,
} from "./extract-proposed-events.mjs";

function withFixtureRepo(source, callback) {
  const repoRoot = mkdtempSync(join(tmpdir(), "paperclip-proposed-events-"));
  const eventsFile = join(repoRoot, "packages", "shared", "src", "telemetry", "events.ts");
  mkdirSync(join(repoRoot, "packages", "shared", "src", "telemetry"), { recursive: true });
  writeFileSync(eventsFile, source);
  try {
    return callback({ repoRoot, eventsFile });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

const fixtureSource = `
import type { TelemetryClient } from "./client.js";

type RawDimension<T extends string | undefined> = T | (string & {});

export function trackSkillStudioCreated(
  client: TelemetryClient,
  dims: {
    sharing_scope: RawDimension<"team" | "private">;
    category_count: number;
    launched_from_template: boolean;
  },
): void {
  client.track(
    // @ts-expect-error -- proposed-telemetry(PAP-2411): measure Skill Studio create completion
    "skill_studio.skill_created",
    dims,
  );
}

export function trackSkillStudioOpened(
  client: TelemetryClient,
  dims: {
    surface: "modal" | "page";
  },
): void {
  client.track(
    // @ts-expect-error
    "skill_studio.opened",
    dims,
  );
}

export function trackInstallStarted(client: TelemetryClient): void {
  client.track("install.started", {});
}
`;

test("extractor emits deterministic proposed-telemetry-extractor.v2 records", () => {
  const output = withFixtureRepo(fixtureSource, ({ repoRoot, eventsFile }) =>
    extractProposedEvents({ repoRoot, eventsFile, ref: "fixture-sha", baseRef: "master" }),
  );

  assert.equal(output.schemaVersion, PROPOSED_TELEMETRY_SCHEMA_VERSION);
  assert.deepEqual(output.source, {
    repo: "paperclipai/paperclip",
    ref: "fixture-sha",
    baseRef: "master",
  });
  assert.deepEqual(
    output.proposals.map((proposal) => proposal.name),
    ["skill_studio.opened", "skill_studio.skill_created"],
  );

  const created = output.proposals.find((proposal) => proposal.name === "skill_studio.skill_created");
  assert.deepEqual(created.dimensions, [
    { name: "category_count", type: "number" },
    { name: "launched_from_template", type: "boolean" },
    { name: "sharing_scope", type: "string" },
  ]);
  assert.deepEqual(created.rationale, {
    issue: "PAP-2411",
    text: "measure Skill Studio create completion",
    missingIssue: false,
    missingRationale: false,
  });
  assert.equal(created.provenance.length, 1);
  assert.equal(created.provenance[0].file, "packages/shared/src/telemetry/events.ts");
  assert.equal(typeof created.provenance[0].line, "number");
  assert.equal(typeof created.provenance[0].column, "number");
});

test("extractor flags a missing proposed-telemetry suffix without hard-failing", () => {
  const output = withFixtureRepo(fixtureSource, ({ repoRoot, eventsFile }) =>
    extractProposedEvents({ repoRoot, eventsFile, ref: "fixture-sha" }),
  );

  const opened = output.proposals.find((proposal) => proposal.name === "skill_studio.opened");
  assert.deepEqual(opened.rationale, {
    issue: null,
    text: null,
    missingIssue: true,
    missingRationale: true,
  });
  assert.deepEqual(opened.dimensions, [{ name: "surface", type: "string" }]);
});

test("extractor scans TelemetryClient wrappers whose receiver is not named client", () => {
  const output = withFixtureRepo(
    `type TelemetryClient = { track(name: string, dims: unknown): void };

export function trackWorkspaceOpened(
  telemetry: TelemetryClient,
  dims: { surface: string },
): void {
  telemetry.track(
    // @ts-expect-error -- proposed-telemetry(PAP-2463): exercise alternate telemetry client parameter names
    "workspace.opened",
    dims,
  );
}
`,
    ({ repoRoot, eventsFile }) => extractProposedEvents({ repoRoot, eventsFile, ref: "fixture-sha" }),
  );

  assert.deepEqual(
    output.proposals.map((proposal) => proposal.name),
    ["workspace.opened"],
  );
  assert.deepEqual(output.proposals[0].dimensions, [{ name: "surface", type: "string" }]);
});

test("extractor scans variable-assigned wrappers and ignores nullable union members", () => {
  const output = withFixtureRepo(
    `type TelemetryClient = { track(name: string, dims: unknown): void };

export const trackWorkspaceArrow = (
  telemetry: TelemetryClient,
  dims: { surface: string | null | undefined },
): void => {
  telemetry.track(
    // @ts-expect-error -- proposed-telemetry(PAP-2463): exercise arrow wrapper extraction
    "workspace.arrow_opened",
    dims,
  );
};

export const trackWorkspaceFunctionExpression = function (
  tc: TelemetryClient,
  dims: { accepted: true | false | null },
): void {
  tc.track(
    // @ts-expect-error -- proposed-telemetry(PAP-2463): exercise function-expression wrapper extraction
    "workspace.function_expression_opened",
    dims,
  );
};
`,
    ({ repoRoot, eventsFile }) => extractProposedEvents({ repoRoot, eventsFile, ref: "fixture-sha" }),
  );

  assert.deepEqual(
    output.proposals.map((proposal) => proposal.name),
    ["workspace.arrow_opened", "workspace.function_expression_opened"],
  );
  assert.deepEqual(output.proposals[0].dimensions, [{ name: "surface", type: "string" }]);
  assert.deepEqual(output.proposals[1].dimensions, [{ name: "accepted", type: "boolean" }]);
});

test("extractor rejects invalid rationale issue references when present", () => {
  assert.throws(
    () =>
      withFixtureRepo(
        `export function trackBad(client, dims: { source: string }): void {\n  client.track(\n    // @ts-expect-error -- proposed-telemetry(PROJ-1): bad issue ref\n    "skill_studio.bad_issue",\n    dims,\n  );\n}\n`,
        ({ repoRoot, eventsFile }) => extractProposedEvents({ repoRoot, eventsFile, ref: "fixture-sha" }),
      ),
    /rationale issue must be PAP-<digits>/,
  );
});

test("provenance paths are repo-relative and reject dev-host path shapes", () => {
  assert.equal(
    assertRepoRelativePath("packages/shared/src/telemetry/events.ts"),
    "packages/shared/src/telemetry/events.ts",
  );
  assert.throws(() => assertRepoRelativePath("/tmp/events.ts"), /repo-relative/);
  assert.throws(() => assertRepoRelativePath("../events.ts"), /unsafe path segment/);
  assert.throws(() => assertRepoRelativePath("C:/repo/events.ts"), /drive-letter/);
  assert.throws(() => assertRepoRelativePath("packages\\shared\\events.ts"), /forward slashes/);

  const repoRoot = mkdtempSync(join(tmpdir(), "paperclip-provenance-root-"));
  try {
    assert.throws(() => toRepoRelativePath(repoRoot, join(repoRoot, "..", "events.ts")), /inside repo root/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

function diagnosticsFor(sourceText) {
  const repoRoot = mkdtempSync(join(tmpdir(), "paperclip-ts2578-"));
  const fileName = join(repoRoot, "fixture.ts");
  writeFileSync(fileName, sourceText);
  try {
    const program = ts.createProgram([fileName], {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      types: [],
    });
    return ts
      .getPreEmitDiagnostics(program)
      .filter((diagnostic) => diagnostic.file?.fileName === fileName)
      .map((diagnostic) => diagnostic.code);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

function tsMechanicsFixture(eventUnion, mapEntry) {
  return `
type TelemetryEventName = ${eventUnion};
interface EventDimensionsMap {
  "install.started": {};
  ${mapEntry}
}
type TelemetryEventDimensions<K extends TelemetryEventName> = EventDimensionsMap[K];
type TrackArgs<K extends TelemetryEventName> = keyof TelemetryEventDimensions<K> extends never
  ? [dimensions?: TelemetryEventDimensions<K>]
  : [dimensions: TelemetryEventDimensions<K>];
declare const client: {
  track<K extends TelemetryEventName>(eventName: K, ...args: TrackArgs<K>): void;
};
client.track(
  // @ts-expect-error -- proposed-telemetry(PAP-2411): TS2578 expiry fixture
  "skill_studio.skill_created",
  { sharing_scope: "team" },
);
`;
}

test("TS2578 expires the directive once a fixture event is registered", () => {
  const unregistered = diagnosticsFor(tsMechanicsFixture('"install.started"', ""));
  assert.deepEqual(unregistered, []);

  const registered = diagnosticsFor(
    tsMechanicsFixture(
      '"install.started" | "skill_studio.skill_created"',
      '"skill_studio.skill_created": { sharing_scope: string };',
    ),
  );
  assert.ok(registered.includes(2578), `expected TS2578, got ${registered.join(", ")}`);
});
