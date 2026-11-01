import assert from "node:assert/strict";
import { loadShardDurations, partitionGeneralServerSuites } from "../general-server-shard.mjs";
import { selectionHash, validateSelection } from "./test-selection-manifest.mjs";

// Preserve the existing per-job budget. Small selections use fewer runners;
// large selections retain the existing parallelism and serialized ownership.
export function partitionSelection(inventory, selected, maxShards, durations = {}) {
  const totalWeight = partitionGeneralServerSuites(inventory, 1, durations)[0].totalWeight;
  const selectedWeight = partitionGeneralServerSuites(selected, 1, durations)[0].totalWeight;
  const budget = totalWeight / maxShards || 1;
  const count = Math.min(maxShards, selected.length, Math.max(1, Math.ceil(selectedWeight / budget)));
  return selected.length ? partitionGeneralServerSuites(selected, count, durations).map((shard) => shard.files) : [];
}

export function refineTestPlan({ plan, head, owners, graphs, durations = {} }) {
  const result = structuredClone(plan);
  const manifest = { version: 1, head, lanes: {} };
  const stats = [];
  const byProject = new Map(graphs.map((graph) => [graph.project, graph]));
  for (const job of ["general_tests", "verify_serialized_server"]) {
    if (!plan.jobs[job].run) continue;
    const entries = plan.jobs[job].matrix.include;
    const groups = [...new Set(entries.map((entry) => entry.group ?? "serialized"))];
    const matrix = [];
    for (const group of groups) {
      const original = entries.filter((entry) => (entry.group ?? "serialized") === group);
      if (group === "general-chat") { matrix.push(...original); continue; }
      const owned = owners[group];
      assert.ok(owned, `Missing inventory owner: ${group}`);
      const projectByFile = new Map();
      const selected = [];
      for (const [project, files] of Object.entries(owned)) {
        const graph = byProject.get(project);
        assert.ok(graph, `Missing project graph: ${project}`);
        const inventory = new Set(graph.inventory);
        const affected = new Set(graph.selected);
        for (const file of files) {
          assert.ok(inventory.has(file), `Runner/Vitest inventory disagreement: ${file}`);
          assert.ok(!projectByFile.has(file), `Ambiguous owner: ${file}`);
          projectByFile.set(file, project);
          if (affected.has(file)) selected.push(file);
        }
      }
      const partitions = partitionSelection([...projectByFile.keys()], selected, original.length, durations[group]);
      if (partitions.length) {
        const shards = partitions.map((files) => {
          const shard = {};
          for (const file of files) (shard[projectByFile.get(file)] ??= []).push(file);
          return shard;
        });
        manifest.lanes[group] = { shards };
        for (let index = 0; index < shards.length; index++) {
          const entry = { ...original[0], selection: true };
          if (original[0].shard_count) {
            Object.assign(entry, { shard_index: index, shard_count: shards.length });
            if (entry.shard_label) entry.shard_label = `${index + 1}/${shards.length}`;
            if (entry.group_label) entry.group_label = entry.group_label.replace(/\(\d+\/\d+\)/, `(${index + 1}/${shards.length})`);
          }
          matrix.push(entry);
        }
      }
      stats.push({ group, total: projectByFile.size, selected: selected.length, beforeJobs: original.length, jobs: partitions.length });
    }
    result.jobs[job] = { ...result.jobs[job], run: matrix.length > 0, selected: matrix.length, proposed: matrix.length,
      matrix: { include: matrix.length ? matrix : entries } };
  }
  validateSelection(manifest);
  result.testSelection = { version: 1, head, hash: selectionHash(manifest), stats };
  return { plan: result, manifest };
}

export function selectionDurations() {
  return {
    "general-server-without-chat": loadShardDurations("scripts/general-server-shard-durations.json"),
    serialized: loadShardDurations("scripts/serialized-shard-durations.json"),
  };
}
