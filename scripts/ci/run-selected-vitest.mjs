import assert from "node:assert/strict";
import path from "node:path";
import { createVitest, parseCLI } from "vitest/node";

// Positional Vitest CLI filters are substrings: foo.test.ts also selects
// foo.test.tsx. Run the exact discovered specifications assigned to this shard.
const { filter, options } = parseCLI(["vitest", "run", ...process.argv.slice(2)]);
assert.ok(filter.length > 0, "Selected execution requires explicit test files");
const expected = new Set(filter.map((file) => path.resolve(file)));
assert.equal(expected.size, filter.length, "Duplicate selected file");
process.env.TEST = "true";
process.env.VITEST = "true";
process.env.NODE_ENV ??= "test";
// Match the CLI's additive --exclude semantics without replacing project rules.
options.cliExclude = options.exclude;
delete options.exclude;
const ctx = await createVitest({ ...options, watch: false });
try {
  await ctx.standalone();
  const specifications = (await ctx.globTestSpecifications()).filter((spec) => expected.has(spec.moduleId));
  assert.deepEqual(specifications.map((spec) => spec.moduleId).sort(), [...expected].sort(),
    "Selected files must match exactly one discovered specification in this project");
  await ctx.runTestSpecifications(specifications);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await ctx.exit();
}
