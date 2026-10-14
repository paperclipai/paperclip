import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const workflow = readFileSync(new URL("../../workflows/ci-routing.yml", import.meta.url), "utf8");
const jobs = workflow.split(/^jobs:\n/m)[1];

test("routing uses reserved capacity and runs no PR code or actions", () => {
  assert.deepEqual([...jobs.matchAll(/^ {2}([a-z_]+):$/gm)].map((match) => match[1]), ["gate"]);
  const placement = jobs.match(/^ {4}runs-on: (.+)$/m)?.[1];
  assert.ok(placement, "routing placement must be defined");
  assert.doesNotMatch(placement, /fromJSON/);
  assert.ok(placement.includes("vars.AWS_CI_TRUSTED_USER_IDS == vars.AWS_CI_ROUTING_USER_IDS_SOURCE"));
  assert.ok(placement.includes("github.event.pull_request.user.id"));
  assert.ok(placement.includes("github.event.sender.id"));
  assert.ok(placement.endsWith("&& 'runs-on/fleet=paperclip-ci-routing-x64/env=public-ci' || 'ubuntu-latest' }}"));
  assert.doesNotMatch(jobs, /uses:|actions\/checkout|secrets\./);
  assert.doesNotMatch(workflow, /^ {2}(?:actions|contents|pull-requests): write$/m);
});

test("routing exports both placement and stack scope to callers", () => {
  assert.match(workflow, /^ {6}runner:\n {8}value: \$\{\{ jobs\.gate\.outputs\.runner \}\}$/m);
  assert.match(workflow, /^ {6}full_ci:\n {8}value: \$\{\{ jobs\.gate\.outputs\.full_ci \}\}$/m);
  assert.match(jobs, /^ {6}runner: \$\{\{ steps\.route\.outputs\.runner \}\}$/m);
  assert.match(jobs, /^ {6}full_ci: \$\{\{ steps\.scope\.outputs\.full_ci \}\}$/m);
});

const githubStub = "#!/usr/bin/env bash\nset -Eeuo pipefail\n\nendpoint=\"${*: -1}\"\ncase \"$endpoint\" in\n  */pulls/*)\n    jq -cn \\\n      --argjson author_id \"${TEST_PR_AUTHOR_ID:-34892728}\" \\\n      --argjson repository_id \"${TEST_REPOSITORY_ID:-1170821064}\" \\\n      --arg base_ref \"${TEST_BASE_REF:-master}\" \\\n      --arg base_sha \"${TEST_PR_BASE_SHA:-$EVENT_BASE_SHA}\" \\\n      --arg head_sha \"${TEST_PR_HEAD_SHA:-1111111111111111111111111111111111111111}\" \\\n      --arg merge_sha \"${TEST_PR_MERGE_SHA:-4444444444444444444444444444444444444444}\" '{\n        state: \"open\",\n        user: {id: $author_id},\n        base: {repo: {id: $repository_id}, ref: $base_ref, sha: $base_sha},\n        head: {sha: $head_sha},\n        merge_commit_sha: $merge_sha\n      }'\n    ;;\n  */git/ref/heads/*)\n    jq -cn \\\n      --arg sha \"${TEST_LIVE_BASE_REF_SHA:-$EVENT_BASE_SHA}\" '{object: {sha: $sha}}'\n    ;;\n  */compare/*)\n    jq -cn \\\n      --arg merge_base_sha \"${TEST_BASE_COMPARISON_MERGE_BASE_SHA:-$EVENT_BASE_SHA}\" \\\n      --arg status \"${TEST_BASE_COMPARISON_STATUS:-ahead}\" '{\n        merge_base_commit: {sha: $merge_base_sha},\n        status: $status\n      }'\n    ;;\n  */git/commits/*)\n    requested_sha=\"${endpoint##*/}\"\n    live_merge_sha=\"${TEST_PR_MERGE_SHA:-4444444444444444444444444444444444444444}\"\n    synthetic_base_merge_sha=\"${TEST_SYNTHETIC_BASE_MERGE_SHA:-}\"\n    if [[ \"$requested_sha\" == \"$EVENT_MERGE_SHA\" ]]; then\n      tree_sha=\"${TEST_EVENT_MERGE_TREE_SHA:-5555555555555555555555555555555555555555}\"\n      base_sha=\"${TEST_EVENT_MERGE_BASE_SHA:-$EVENT_BASE_SHA}\"\n      head_sha=\"${TEST_EVENT_MERGE_HEAD_SHA:-$EVENT_HEAD_SHA}\"\n    elif [[ \"$requested_sha\" == \"$live_merge_sha\" ]]; then\n      tree_sha=\"${TEST_LIVE_MERGE_TREE_SHA:-5555555555555555555555555555555555555555}\"\n      base_sha=\"${TEST_LIVE_MERGE_BASE_SHA:-$EVENT_BASE_SHA}\"\n      head_sha=\"${TEST_LIVE_MERGE_HEAD_SHA:-$EVENT_HEAD_SHA}\"\n    elif [[ -n \"$synthetic_base_merge_sha\" && \"$requested_sha\" == \"$synthetic_base_merge_sha\" ]]; then\n      tree_sha=\"${TEST_SYNTHETIC_BASE_MERGE_TREE_SHA:-8888888888888888888888888888888888888888}\"\n      base_sha=\"${TEST_SYNTHETIC_MASTER_PARENT_SHA:-9999999999999999999999999999999999999999}\"\n      head_sha=\"${TEST_SYNTHETIC_BASE_REF_PARENT_SHA:-${TEST_LIVE_BASE_REF_SHA:-$EVENT_BASE_SHA}}\"\n    else\n      echo \"unexpected merge commit: $requested_sha\" >&2\n      exit 1\n    fi\n    jq -cn \\\n      --arg sha \"$requested_sha\" \\\n      --arg tree_sha \"$tree_sha\" \\\n      --arg base_sha \"$base_sha\" \\\n      --arg head_sha \"$head_sha\" '{\n        sha: $sha,\n        tree: {sha: $tree_sha},\n        parents: [{sha: $base_sha}, {sha: $head_sha}]\n      }'\n    ;;\n  */actions/runs/*)\n    jq -cn \\\n      --argjson actor_id \"${TEST_TRIGGERING_ACTOR_ID:-34892728}\" \\\n      --argjson repository_id \"${TEST_REPOSITORY_ID:-1170821064}\" \\\n      --arg event_name \"${TEST_EVENT_NAME:-pull_request}\" '{\n        triggering_actor: {id: $actor_id},\n        repository: {id: $repository_id},\n        event: $event_name\n      }'\n    ;;\n  *)\n    echo \"unexpected gh endpoint: $endpoint\" >&2\n    exit 1\n    ;;\nesac";

function stepScript(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `missing step: ${name}`);
  const body = workflow.slice(start);
  const runStart = body.indexOf("        run: |\n");
  assert.ok(runStart >= 0, `missing script: ${name}`);
  const script = body.slice(runStart + "        run: |\n".length).split("\n      - name:")[0];
  return script.split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n");
}

function executeStep(name, overrides = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "paperclip-routing-test-"));
  const output = path.join(directory, "output");
  try {
    const gh = path.join(directory, "gh");
    writeFileSync(gh, githubStub);
    chmodSync(gh, 0o700);
    const result = spawnSync("bash", ["-c", stepScript(name)], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        GITHUB_OUTPUT: output,
        AWS_CI_ENABLED: "true",
        TRUSTED_USER_IDS: "[34892728]",
        EVENT_NAME: "pull_request",
        EVENT_REPOSITORY: "paperclipai/paperclip",
        EVENT_REPOSITORY_ID: "1170821064",
        EVENT_ACTION: "synchronize",
        EVENT_PR_NUMBER: "12350",
        EVENT_PR_AUTHOR_ID: "34892728",
        EVENT_SENDER_ID: "34892728",
        EVENT_BASE_REPOSITORY_ID: "1170821064",
        EVENT_BASE_REF: "master",
        EVENT_BASE_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        EVENT_HEAD_SHA: "1111111111111111111111111111111111111111",
        EVENT_MERGE_SHA: "2222222222222222222222222222222222222222",
        RUN_ID: "123456789",
        ...overrides,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = readFileSync(output, "utf8").trim().split("\n");
    assert.equal(lines.length, 1, "each step must emit exactly one decision");
    return Object.fromEntries(lines.map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const awsRunner = "runs-on/fleet=paperclip-public-pr-x64/env=public-ci";
const stackedBase = {
  EVENT_BASE_REF: "trusted-stack-base",
  TEST_BASE_REF: "trusted-stack-base",
  TEST_PR_BASE_SHA: "7777777777777777777777777777777777777777",
  TEST_LIVE_BASE_REF_SHA: "7777777777777777777777777777777777777777",
  TEST_SYNTHETIC_BASE_MERGE_SHA: "8888888888888888888888888888888888888888",
  TEST_EVENT_MERGE_BASE_SHA: "8888888888888888888888888888888888888888",
  TEST_LIVE_MERGE_BASE_SHA: "8888888888888888888888888888888888888888",
};

const routeCases = [
  ["allowlisted PR", {}, awsRunner],
  ["validated stacked base", stackedBase, awsRunner],
  ["lagging PR API base snapshot", { TEST_PR_BASE_SHA: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, awsRunner],
  ["disabled AWS", { AWS_CI_ENABLED: "false" }],
  ["missing AWS variables", { AWS_CI_ENABLED: "", TRUSTED_USER_IDS: "" }],
  ["unlisted author", { EVENT_PR_AUTHOR_ID: "99999999" }],
  ["unlisted sender", { EVENT_SENDER_ID: "99999999" }],
  ["unlisted rerun actor", { TEST_TRIGGERING_ACTOR_ID: "99999999" }],
  ["missing base", { EVENT_BASE_REF: "" }],
  ["wrong base repository", { EVENT_BASE_REPOSITORY_ID: "999999999" }],
  ["replaced base ancestry", { TEST_BASE_COMPARISON_MERGE_BASE_SHA: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }],
  ["stale head", { TEST_PR_HEAD_SHA: "3333333333333333333333333333333333333333" }],
  ["changed merge head", { TEST_LIVE_MERGE_HEAD_SHA: "3333333333333333333333333333333333333333" }],
  ["stacked base with wrong parent", { ...stackedBase, TEST_SYNTHETIC_BASE_REF_PARENT_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
  ["changed merge tree", { TEST_LIVE_MERGE_TREE_SHA: "6666666666666666666666666666666666666666" }],
  ["wrong repository", { EVENT_REPOSITORY_ID: "999999999" }],
  ["malformed allowlist", { TRUSTED_USER_IDS: '["34892728"]' }],
  ["manual dispatch", { EVENT_NAME: "workflow_dispatch" }],
  ["unsupported PR action", { EVENT_ACTION: "closed" }],
  ["malformed commit SHA", { EVENT_HEAD_SHA: "invalid" }],
];

for (const [name, env, expected = "ubuntu-latest"] of routeCases) {
  test(`runner decision: ${name}`, () => {
    assert.equal(executeStep("Validate PR identity and select runner", env).runner, expected);
  });
}

const scopeCases = [
  ["ordinary PR", null, "master", "true"],
  ["top stack PR", { position: 11, size: 11, base: { ref: "master" } }, "stack-10", "true"],
  ["lowest unmerged PR", { position: 1, size: 11, base: { ref: "master" } }, "master", "true"],
  ["middle stack PR", { position: 6, size: 11, base: { ref: "master" } }, "stack-5", "false"],
  ["malformed position", { position: "invalid", size: 11, base: { ref: "master" } }, "stack-5", "true"],
  ["out-of-range position", { position: 12, size: 11, base: { ref: "master" } }, "stack-5", "true"],
  ["missing stack base", { position: 6, size: 11 }, "stack-5", "true"],
  ["empty metadata", {}, "master", "true"],
];

for (const [name, stack, base, expected] of scopeCases) {
  test(`scope decision: ${name}`, () => {
    assert.equal(executeStep("Select stacked PR CI scope", {
      STACK_JSON: JSON.stringify(stack), PR_BASE_REF: base,
    }).full_ci, expected);
  });
}


function routingPlacement(vars = {}, github = {}) {
  const source = "[34892728]";
  const expression = jobs.match(/^ {4}runs-on: \$\{\{ (.+) \}\}$/m)?.[1];
  assert.ok(expression, "routing expression is missing");
  return vm.runInNewContext(expression, {
    vars: {
      AWS_CI_ENABLED: "true",
      AWS_CI_TRUSTED_USER_IDS: source,
      AWS_CI_ROUTING_USER_IDS_SOURCE: source,
      AWS_CI_ROUTING_USER_IDS: "|34892728|",
      ...vars,
    },
    github: {
      repository: "paperclipai/paperclip",
      repository_id: "1170821064",
      event_name: "pull_request",
      ref: "refs/heads/master",
      actor_id: "34892728",
      event: { pull_request: { user: { id: 34892728 } }, sender: { id: 34892728 } },
      ...github,
    },
    contains: (search, item) => String(search).toLowerCase().includes(String(item).toLowerCase()),
    format: (template, ...args) => template.replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index)])),
  }, { timeout: 1000 });
}

const placementCases = [
  ["approved PR", {}, {}, "runs-on/fleet=paperclip-ci-routing-x64/env=public-ci"],
  ["unapproved author", {}, { event: { pull_request: { user: { id: 999 } }, sender: { id: 34892728 } } }],
  ["unapproved sender", {}, { event: { pull_request: { user: { id: 34892728 } }, sender: { id: 999 } } }],
  ["partial ID cannot match", {}, { event: { pull_request: { user: { id: 4892728 } }, sender: { id: 34892728 } } }],
  ["invalid JSON keeps hosted fallback", { AWS_CI_TRUSTED_USER_IDS: "[34892728,]" }, {}],
  ["stale snapshot", { AWS_CI_TRUSTED_USER_IDS: "[34892728,999]" }, {}],
  ["missing snapshot", { AWS_CI_ROUTING_USER_IDS_SOURCE: "" }, {}],
  ["missing admission members", { AWS_CI_ROUTING_USER_IDS: "" }, {}],
  ["disabled routing", { AWS_CI_ENABLED: "false" }, {}],
  ["different repository", {}, { repository: "other/repo" }],
  ["different repository ID", {}, { repository_id: "999" }],
  ["approved manual master canary", {}, { event_name: "workflow_dispatch" }, "runs-on/fleet=paperclip-ci-routing-x64/env=public-ci"],
  ["unapproved manual actor", {}, { event_name: "workflow_dispatch", actor_id: "999" }],
  ["manual branch canary", {}, { event_name: "workflow_dispatch", ref: "refs/heads/other" }],
];

for (const [name, vars, github, expected = "ubuntu-latest"] of placementCases) {
  test(`placement before allocation: ${name}`, () => {
    assert.equal(routingPlacement(vars, github), expected);
  });
}
