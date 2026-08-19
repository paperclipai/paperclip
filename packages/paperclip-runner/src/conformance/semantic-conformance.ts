export type SemanticConformanceAuthorization =
  | { readonly outcome: "allowed" }
  | { readonly outcome: "denied"; readonly code: string };

export interface SemanticConformanceVector {
  readonly id: string;
  readonly operationId: string;
  readonly input: unknown;
  /** Identifies an isolated fixture world when vectors cannot share state. */
  readonly worldId?: string;
  /** A contract oracle distinguishes adapter drift from contract drift. */
  readonly expected?: SemanticConformanceObservation;
}

export interface SemanticConformanceObservation {
  readonly authorization: SemanticConformanceAuthorization;
  readonly state: unknown;
  readonly effects: readonly unknown[];
  readonly audit: readonly unknown[];
  /** Provider-neutral normalized view of the PRP semantic result receipt. */
  readonly receipt?: {
    readonly schema: "paperclip.prp.semantic_tool.v1";
    readonly schemaVersion: 1;
    readonly phase: "result";
    readonly operationId: string;
    readonly callId: string;
    readonly idempotencyKeyPresent: boolean;
    readonly outcome: string;
    readonly code: string;
    readonly retryable: boolean;
    readonly authorizationBoundary: string;
    readonly operationReceiptPresent: boolean;
    readonly inputDigestPresent: boolean;
    readonly outputDigestPresent: boolean;
    readonly currentRevisionPresent: boolean;
  };
}

export type SemanticConformanceAdapterKind = "mock" | "production_binding";

export interface SemanticConformanceAdapter {
  readonly id: string;
  readonly kind?: SemanticConformanceAdapterKind;
  execute(vector: SemanticConformanceVector): Promise<SemanticConformanceObservation>;
}

export interface SemanticConformanceReportRow {
  readonly vectorId: string;
  readonly operationId: string;
  readonly adapterIds: readonly string[];
  /** Retained for consumers of the original report shape. */
  readonly observation: SemanticConformanceObservation;
  readonly observations: Readonly<Record<string, SemanticConformanceObservation>>;
}

export interface SemanticConformanceReport {
  readonly schema: "paperclip.semantic-conformance-report.v1";
  readonly rows: readonly SemanticConformanceReportRow[];
}

export interface SemanticConformanceDiff {
  readonly path: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

export type SemanticConformanceSuspectedSource =
  | SemanticConformanceAdapterKind
  | "contract"
  | "multiple";

export class SemanticConformanceMismatchError extends Error {
  readonly code = "semantic_conformance_mismatch" as const;

  constructor(
    readonly vectorId: string,
    readonly operationId: string,
    readonly baselineAdapterId: string,
    readonly mismatchedAdapterId: string,
    readonly suspectedSource: SemanticConformanceSuspectedSource,
    readonly diffs: readonly SemanticConformanceDiff[],
    readonly observations: Readonly<Record<string, SemanticConformanceObservation>>,
  ) {
    const firstPath = diffs[0]?.path ?? "$";
    const firstDiff = diffs[0];
    const values = firstDiff === undefined
      ? ""
      : `; expected ${displayValue(firstDiff.expected)}, actual ${displayValue(firstDiff.actual)}`;
    super(
      `Semantic conformance mismatch for ${vectorId} (${operationId}) at ${firstPath}${values}; suspected source: ${suspectedSource}; ${mismatchedAdapterId} differs from ${baselineAdapterId}`,
    );
    this.name = "SemanticConformanceMismatchError";
  }
}

/**
 * Executes provider-neutral command vectors against two or more adapters and
 * compares their normalized authorization, state, effects, and audit output.
 * Adapters own setup/teardown and normalization; this package owns comparison.
 */
export async function runSemanticConformanceKit(input: {
  readonly vectors: readonly SemanticConformanceVector[];
  readonly adapters: readonly SemanticConformanceAdapter[];
}): Promise<SemanticConformanceReport> {
  if (input.adapters.length < 2) {
    throw new Error("semantic_conformance_requires_two_adapters");
  }
  if (new Set(input.adapters.map((adapter) => adapter.id)).size !== input.adapters.length) {
    throw new Error("semantic_conformance_adapter_ids_must_be_unique");
  }
  const rows: SemanticConformanceReportRow[] = [];
  for (const vector of input.vectors) {
    const executed = await Promise.all(
      input.adapters.map(async (adapter) => ({
        adapter,
        observation: await adapter.execute(vector),
      })),
    );
    const observations = Object.freeze(Object.fromEntries(
      executed.map(({ adapter, observation }) => [adapter.id, structuredClone(observation)]),
    ));
    const baseline = executed[0]!;
    const baselineJson = canonicalJson(baseline.observation);
    for (const candidate of executed.slice(1)) {
      if (canonicalJson(candidate.observation) !== baselineJson) {
        throw mismatchError(vector, baseline, candidate, observations);
      }
    }
    if (
      vector.expected !== undefined
      && canonicalJson(baseline.observation) !== canonicalJson(vector.expected)
    ) {
      throw new SemanticConformanceMismatchError(
        vector.id,
        vector.operationId,
        "contract",
        baseline.adapter.id,
        "contract",
        normalizedDiff(vector.expected, baseline.observation),
        observations,
      );
    }
    rows.push(Object.freeze({
      vectorId: vector.id,
      operationId: vector.operationId,
      adapterIds: Object.freeze(input.adapters.map((adapter) => adapter.id)),
      observation: structuredClone(baseline.observation),
      observations,
    }));
  }
  return Object.freeze({
    schema: "paperclip.semantic-conformance-report.v1",
    rows: Object.freeze(rows),
  });
}

function mismatchError(
  vector: SemanticConformanceVector,
  baseline: { adapter: SemanticConformanceAdapter; observation: SemanticConformanceObservation },
  candidate: { adapter: SemanticConformanceAdapter; observation: SemanticConformanceObservation },
  observations: Readonly<Record<string, SemanticConformanceObservation>>,
): SemanticConformanceMismatchError {
  let suspectedSource: SemanticConformanceSuspectedSource = candidate.adapter.kind ?? "multiple";
  let expected = baseline.observation;
  let actual = candidate.observation;
  if (vector.expected !== undefined) {
    const baselineMatches = canonicalJson(baseline.observation) === canonicalJson(vector.expected);
    const candidateMatches = canonicalJson(candidate.observation) === canonicalJson(vector.expected);
    if (baselineMatches && !candidateMatches) {
      suspectedSource = candidate.adapter.kind ?? "multiple";
      expected = vector.expected;
    } else if (!baselineMatches && candidateMatches) {
      suspectedSource = baseline.adapter.kind ?? "multiple";
      expected = vector.expected;
      actual = baseline.observation;
    } else {
      suspectedSource = "multiple";
      expected = vector.expected;
    }
  }
  return new SemanticConformanceMismatchError(
    vector.id,
    vector.operationId,
    baseline.adapter.id,
    candidate.adapter.id,
    suspectedSource,
    normalizedDiff(expected, actual),
    observations,
  );
}

function normalizedDiff(expected: unknown, actual: unknown, path = "$"): SemanticConformanceDiff[] {
  if (canonicalJson(expected) === canonicalJson(actual)) return [];
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const diffs: SemanticConformanceDiff[] = [];
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      diffs.push(...normalizedDiff(expected[index], actual[index], `${path}[${index}]`));
    }
    return diffs;
  }
  if (isRecord(expected) && isRecord(actual)) {
    const diffs: SemanticConformanceDiff[] = [];
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) {
      diffs.push(...normalizedDiff(expected[key], actual[key], `${path}.${key}`));
    }
    return diffs;
  }
  return [{ path, expected: structuredCloneSafe(expected), actual: structuredCloneSafe(actual) }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function structuredCloneSafe(value: unknown): unknown {
  return value === undefined ? "<missing>" : structuredClone(value);
}

function displayValue(value: unknown): string {
  const rendered = canonicalJson(value);
  return rendered.length <= 240 ? rendered : `${rendered.slice(0, 237)}...`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
