export type SemanticConformanceAuthorization =
  | { readonly outcome: "allowed" }
  | { readonly outcome: "denied"; readonly code: string };

export type SemanticConformanceJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly SemanticConformanceJsonValue[]
  | { readonly [key: string]: SemanticConformanceJsonValue };

export interface SemanticConformanceVector {
  readonly id: string;
  readonly operationId: string;
  readonly input: SemanticConformanceJsonValue;
}

export interface SemanticConformanceObservation {
  readonly authorization: SemanticConformanceAuthorization;
  readonly state: SemanticConformanceJsonValue;
  readonly effects: readonly SemanticConformanceJsonValue[];
  readonly audit: readonly SemanticConformanceJsonValue[];
}

export interface SemanticConformanceAdapter {
  readonly id: string;
  execute(
    vector: SemanticConformanceVector,
  ): Promise<SemanticConformanceObservation>;
}

export interface SemanticConformanceReportRow {
  readonly vectorId: string;
  readonly operationId: string;
  readonly adapterIds: readonly string[];
  readonly observation: SemanticConformanceObservation;
}

export interface SemanticConformanceReport {
  readonly schema: "paperclip.semantic-conformance-report.v1";
  readonly rows: readonly SemanticConformanceReportRow[];
}

export class SemanticConformanceMismatchError extends Error {
  readonly code = "semantic_conformance_mismatch" as const;

  constructor(
    readonly vectorId: string,
    readonly baselineAdapterId: string,
    readonly mismatchedAdapterId: string,
  ) {
    super(
      `Semantic conformance mismatch for ${vectorId}: ${mismatchedAdapterId} differs from ${baselineAdapterId}`,
    );
    this.name = "SemanticConformanceMismatchError";
  }
}

/**
 * Compare normalized authorization, state, effects, and audit output from two
 * or more adapters. Adapters own setup and normalization; the kit owns a
 * deterministic, provider-neutral comparison.
 */
export async function runSemanticConformanceKit(input: {
  readonly vectors: readonly SemanticConformanceVector[];
  readonly adapters: readonly SemanticConformanceAdapter[];
}): Promise<SemanticConformanceReport> {
  if (input.adapters.length < 2) {
    throw new Error("semantic_conformance_requires_two_adapters");
  }
  if (
    new Set(input.adapters.map((adapter) => adapter.id)).size !==
    input.adapters.length
  ) {
    throw new Error("semantic_conformance_adapter_ids_must_be_unique");
  }

  const rows: SemanticConformanceReportRow[] = [];
  for (const vector of input.vectors) {
    const observations = await Promise.all(
      input.adapters.map(async (adapter) => ({
        adapter,
        observation: await adapter.execute(vector),
      })),
    );
    const baseline = observations[0]!;
    const baselineJson = canonicalJson(baseline.observation);
    for (const candidate of observations.slice(1)) {
      if (canonicalJson(candidate.observation) !== baselineJson) {
        throw new SemanticConformanceMismatchError(
          vector.id,
          baseline.adapter.id,
          candidate.adapter.id,
        );
      }
    }
    rows.push(
      Object.freeze({
        vectorId: vector.id,
        operationId: vector.operationId,
        adapterIds: Object.freeze(input.adapters.map((adapter) => adapter.id)),
        observation: structuredClone(baseline.observation),
      }),
    );
  }

  return Object.freeze({
    schema: "paperclip.semantic-conformance-report.v1",
    rows: Object.freeze(rows),
  });
}

function canonicalJson(
  value: unknown,
  ancestors = new WeakSet<object>(),
): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidObservation();
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw invalidObservation();
  if (ancestors.has(value)) {
    throw new Error("semantic_conformance_cyclic_observation");
  }

  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    throw invalidObservation();
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw invalidObservation();
        entries.push(canonicalJson(value[index], ancestors));
      }
      return `[${entries.join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`,
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function invalidObservation(): Error {
  return new Error("semantic_conformance_non_json_observation");
}
