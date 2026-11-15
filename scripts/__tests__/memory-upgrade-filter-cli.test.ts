import assert from "node:assert/strict";
import test from "node:test";
import { parseFilterArgs } from "../memory-upgrade-filter-args.js";
import { runFilterCli } from "../memory-upgrade-filter.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";

const VALID_COMPANY = "00000000-0000-4000-8000-000000000001";
const OTHER_COMPANY = "00000000-0000-4000-8000-000000000002";

test("Memory Upgrade Filter CLI Parsing and Flag Gates", async (t) => {
  await t.test("rejects unknown flags naming filter command", () => {
    assert.throws(
      () => parseFilterArgs(["--unknown-flag", "value"]),
      (err: any) =>
        err instanceof CompanyMemoryUpgradeError &&
        err.code === "INVALID_ARGUMENT" &&
        err.message.includes("Only filter options are accepted"),
    );
  });

  await t.test("--help and -h print help and exit 0", () => {
    const res1 = parseFilterArgs(["--help"]);
    assert.deepEqual(res1, { exitCode: 0 });

    const res2 = parseFilterArgs(["-h"]);
    assert.deepEqual(res2, { exitCode: 0 });
  });

  await t.test("enforces --concurrency between 1 and 16", () => {
    const invalidVals = ["0", "17", "abc", "-1", "4.5"];
    for (const val of invalidVals) {
      assert.throws(
        () =>
          parseFilterArgs([
            "--manifest", "export.manifest.json",
            "--jsonl", "export.jsonl",
            "--concurrency", val,
          ]),
        (err: any) =>
          err instanceof CompanyMemoryUpgradeError &&
          err.code === "INVALID_ARGUMENT" &&
          err.message === "Invalid --concurrency. Must be an integer between 1 and 16.",
      );
    }
  });

  await t.test("enforces --confirm strict match with --company", () => {
    assert.throws(
      () =>
        parseFilterArgs([
          "--manifest", "export.manifest.json",
          "--jsonl", "export.jsonl",
          "--company", VALID_COMPANY,
          "--confirm", OTHER_COMPANY,
        ]),
      (err: any) =>
        err instanceof CompanyMemoryUpgradeError &&
        err.code === "INVALID_ARGUMENT" &&
        err.message.includes("Flag --confirm <uuid> must strictly match --company <uuid>"),
    );
  });

  await t.test("enforces --output-dir when --confirm is supplied", () => {
    assert.throws(
      () =>
        parseFilterArgs([
          "--manifest", "export.manifest.json",
          "--jsonl", "export.jsonl",
          "--confirm", VALID_COMPANY,
        ]),
      (err: any) =>
        err instanceof CompanyMemoryUpgradeError &&
        err.code === "INVALID_ARGUMENT" &&
        err.message.includes("Flag --output-dir is required when --confirm is supplied"),
    );
  });

  await t.test("parses valid options successfully", () => {
    const res = parseFilterArgs([
      "--manifest", "export.manifest.json",
      "--jsonl", "export.jsonl",
      "--output-dir", "/tmp/out",
      "--company", VALID_COMPANY,
      "--confirm", VALID_COMPANY,
      "--model", "gpt-5.4-mini",
      "--concurrency", "8",
      "--chat-rpm", "600",
      "--chat-tpm", "300000",
      "--max-cost-usd", "1.5",
      "--format", "json",
    ]);

    assert.ok(!("exitCode" in res));
    assert.equal(res.concurrency, 8);
    assert.equal(res.chatRpm, 600);
    assert.equal(res.chatTpm, 300_000);
    assert.equal(res.isDryRun, false);
  });

  await t.test("CLI execution handles error and returns exit code 1", async () => {
    const exitCode = await runFilterCli(["--manifest", "does-not-exist.json", "--jsonl", "does-not-exist.jsonl"]);
    assert.equal(exitCode, 1);
  });
});
