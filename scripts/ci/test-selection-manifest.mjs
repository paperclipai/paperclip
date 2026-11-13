import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

export const selectableGroups = ["general-server-without-chat", "general-workspaces-a",
  "general-workspaces-b", "general-workspaces-c", "serialized"];

export function selectionHash(manifest) {
  return createHash("sha256").update(JSON.stringify({ version: manifest.version, lanes: manifest.lanes })).digest("hex");
}

export function validateSelection(manifest, { head, hash } = {}) {
  assert.equal(manifest.version, 1, "Unsupported test selection");
  assert.match(manifest.head, /^[a-f0-9]{40}$/);
  if (head) assert.equal(manifest.head, head, "Selection belongs to another checkout");
  assert.ok(manifest.lanes && typeof manifest.lanes === "object" && !Array.isArray(manifest.lanes));
  const seen = new Set();
  for (const [group, lane] of Object.entries(manifest.lanes)) {
    assert.ok(selectableGroups.includes(group), `Unknown selection group: ${group}`);
    assert.ok(Array.isArray(lane.shards) && lane.shards.length > 0 && lane.shards.length <= 12);
    for (const shard of lane.shards) {
      assert.ok(shard && typeof shard === "object" && !Array.isArray(shard));
      let count = 0;
      for (const [project, files] of Object.entries(shard)) {
        assert.ok(project && Array.isArray(files) && files.length > 0);
        for (const file of files) {
          assert.equal(typeof file, "string");
          assert.ok(/^(ui|server|cli|packages)\//.test(file) && !/[\0\r\n\\:*?\[\]{}]/.test(file)
            && !file.split("/").some((part) => ["", ".", ".."].includes(part)), `Invalid selected path: ${file}`);
          const key = `${project}:${file}`;
          assert.ok(!seen.has(key), `Test assigned twice: ${key}`);
          seen.add(key);
          count++;
        }
      }
      assert.ok(count > 0, "Empty selection shard");
    }
  }
  if (hash) assert.equal(selectionHash(manifest), hash, "Selection artifact does not match its plan");
  return manifest;
}

export function loadSelection(file = process.env.PAPERCLIP_CI_TEST_SELECTION) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const manifest = validateSelection(JSON.parse(readFileSync(file, "utf8")), {
    head, hash: process.env.PAPERCLIP_CI_SELECTION_HASH,
  });
  for (const lane of Object.values(manifest.lanes)) {
    for (const shard of lane.shards) for (const files of Object.values(shard)) {
      for (const file of files) assert.ok(statSync(file).isFile(), `Selected test missing: ${file}`);
    }
  }
  return manifest;
}

export function selectedShard(manifest, options, projects) {
  const group = options.mode === "serialized" ? "serialized" : options.group;
  const lane = manifest.lanes[group];
  assert.ok(lane, `Missing selection for ${group}`);
  assert.equal(lane.shards.length, options.shardCount ?? 1, "Selection shard count mismatch");
  const shard = lane.shards[options.shardIndex ?? 0];
  assert.ok(shard, "Missing selection shard");
  for (const project of Object.keys(shard)) assert.ok(projects.includes(project), `Wrong project for ${group}: ${project}`);
  return shard;
}
