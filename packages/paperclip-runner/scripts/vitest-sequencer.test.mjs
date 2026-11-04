import assert from "node:assert/strict";
import { test } from "vitest";
import { BaseSequencer } from "vitest/node";
import { RunnerSequencer } from "./vitest-sequencer.mjs";

const project = { name: "runner", config: { isolate: true, sequence: { groupOrder: 0 } } };
const files = [
  "large.test.ts",
  "runnerd-codex-transport.test.ts",
  "small.test.ts",
  "runnerd-codex-transport-settlement.test.ts",
  "runnerd-codex-transport-deadlines.test.ts",
].map((name) => ({ moduleId: `/repo/src/live/${name}`, project }));
const ctx = {
  config: { root: "/repo", shard: { index: 1, count: 2 } },
  cache: {
    getFileTestResults: () => undefined,
    getFileStats: (key) => ({ size: 100 - files.findIndex((file) => key.endsWith(file.moduleId.slice(6))) }),
  },
};

test("starts real-wait transport files first without changing test membership", async () => {
  const sorted = await new RunnerSequencer(ctx).sort(files);
  assert.deepEqual(sorted, [files[1], files[3], files[4], files[0], files[2]]);
  assert.equal(new Set(sorted).size, files.length);
  assert.deepEqual(await new BaseSequencer(ctx).sort(files), files);
});

test("selected subsets stay selected and retain default ordering", async () => {
  const selected = [files[2], files[0]];
  assert.deepEqual(await new RunnerSequencer(ctx).sort(selected), await new BaseSequencer(ctx).sort(selected));
  assert.deepEqual(await new RunnerSequencer(ctx).sort([files[4]]), [files[4]]);
  assert.deepEqual(await new RunnerSequencer(ctx).sort([]), []);
});

test("keeps Vitest shard membership and schedules waits within each shard", async () => {
  const all = [];
  for (const index of [1, 2]) {
    const shardCtx = { ...ctx, config: { ...ctx.config, shard: { index, count: 2 } } };
    const sequencer = new RunnerSequencer(shardCtx);
    const shard = await sequencer.shard(files);
    assert.deepEqual(shard, await new BaseSequencer(shardCtx).shard(files));
    const sorted = await sequencer.sort(shard);
    assert.deepEqual(new Set(sorted), new Set(shard));
    all.push(...sorted);
  }
  assert.equal(all.length, files.length);
  assert.deepEqual(new Set(all), new Set(files));
});

test("recognizes Windows paths", async () => {
  const deadline = { ...files[4], moduleId: "C:\\repo\\src\\live\\runnerd-codex-transport-deadlines.test.ts" };
  assert.deepEqual(await new RunnerSequencer(ctx).sort([files[0], deadline]), [deadline, files[0]]);
});

test("starts measured slow provider files before short files without adding work", async () => {
  const streaming = { ...files[0], moduleId: "/repo/src/live/runnerd-opencode-streaming-tools.test.ts" };
  const launch = { ...files[0], moduleId: "/repo/src/control-plane/cursor-cloud-runner-launch.test.ts" };
  assert.deepEqual(await new RunnerSequencer(ctx).sort([files[0], streaming, files[4], launch]),
    [launch, files[4], streaming, files[0]]);
});
