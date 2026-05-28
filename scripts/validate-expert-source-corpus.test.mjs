import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadExpertSourceCorpus, validateExpertSourceCorpus } from "./validate-expert-source-corpus.mjs";

describe("OUT-36769 expert-source corpus", () => {
  it("maps every surviving D4 target row to at least one tier-A source with required provenance", async () => {
    const corpus = await loadExpertSourceCorpus();
    const result = validateExpertSourceCorpus(corpus);

    assert.equal(result.rows_with_tier_a_source, 5);
    assert.deepEqual(
      result.row_results.map((row) => row.row).sort((left, right) => left - right),
      [2, 4, 5, 13, 23],
    );
    assert.ok(result.row_results.every((row) => row.tier_a_source_count >= 1));
  });
});
