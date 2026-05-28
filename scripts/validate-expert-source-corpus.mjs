import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const DEFAULT_CORPUS_PATH = new URL("../apps/ai-outrec-com/data/expert-source-corpus.json", import.meta.url);
const REQUIRED_ROWS = new Set([2, 4, 5, 13, 23]);
const REQUIRED_SOURCE_FIELDS = ["source_authority", "source_tier", "last_verified_at", "vertical_tag"];

export async function loadExpertSourceCorpus(corpusPath = DEFAULT_CORPUS_PATH) {
  return JSON.parse(await readFile(corpusPath, "utf8"));
}

export function validateExpertSourceCorpus(corpus) {
  assert.equal(corpus.manifest.issue, "OUT-36769");
  assert.deepEqual(new Set(corpus.manifest.target_rows), REQUIRED_ROWS);

  const sourcesById = new Map(corpus.sources.map((source) => [source.id, source]));
  const coverageRows = new Set(corpus.target_row_coverage.map((coverage) => coverage.row));
  assert.deepEqual(coverageRows, REQUIRED_ROWS);

  for (const source of corpus.sources) {
    for (const field of REQUIRED_SOURCE_FIELDS) {
      assert.ok(source[field], `${source.id} missing ${field}`);
    }
    assert.equal(source.source_tier, "A", `${source.id} must be tier A`);
    assert.match(source.last_verified_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.ok(Array.isArray(source.covers_rows), `${source.id} missing covers_rows`);
  }

  const rowResults = corpus.target_row_coverage.map((coverage) => {
    const tierASources = coverage.source_ids
      .map((sourceId) => sourcesById.get(sourceId))
      .filter((source) => source?.source_tier === "A" && source.covers_rows.includes(coverage.row));

    assert.ok(
      tierASources.length >= coverage.required_min_tier_a_sources,
      `row ${coverage.row} expected at least ${coverage.required_min_tier_a_sources} tier-A source`,
    );

    return {
      row: coverage.row,
      tier_a_source_count: tierASources.length,
      source_ids: tierASources.map((source) => source.id),
    };
  });

  return {
    manifest_id: corpus.manifest.id,
    target_rows: [...REQUIRED_ROWS],
    rows_with_tier_a_source: rowResults.length,
    row_results: rowResults,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const corpus = await loadExpertSourceCorpus(process.argv[2] ? new URL(process.argv[2], `file://${process.cwd()}/`) : undefined);
  const result = validateExpertSourceCorpus(corpus);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
