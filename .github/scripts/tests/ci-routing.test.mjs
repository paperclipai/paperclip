import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const workflow = readFileSync(new URL("../../workflows/ci-routing.yml", import.meta.url), "utf8");
const jobs = workflow.split(/^jobs:\n/m)[1];

test("authorization uses reserved capacity and runs no PR code or actions", () => {
  assert.deepEqual([...jobs.matchAll(/^ {2}([a-z_]+):$/gm)].map((match) => match[1]), ["gate"]);
  const placement = jobs.match(/^ {4}runs-on: (.+)$/m)?.[1];
  assert.ok(placement, "routing placement must be defined");
  assert.match(placement, /runs-on\/fleet=paperclip-ci-routing-x64\/env=public-ci/);
  assert.doesNotMatch(placement, /fromJSON/);
  assert.doesNotMatch(jobs, /uses:|actions\/checkout|secrets\./);
  assert.doesNotMatch(workflow, /^ {2}(?:actions|contents|pull-requests): write$/m);
});

test("routing exports both placement and stack scope to callers", () => {
  assert.match(workflow, /^ {6}runner:\n {8}value: \$\{\{ jobs\.gate\.outputs\.runner \}\}$/m);
  assert.match(workflow, /^ {6}full_ci:\n {8}value: \$\{\{ jobs\.gate\.outputs\.full_ci \}\}$/m);
  assert.match(jobs, /^ {6}runner: \$\{\{ steps\.route\.outputs\.runner \}\}$/m);
  assert.match(jobs, /^ {6}full_ci: \$\{\{ steps\.scope\.outputs\.full_ci \}\}$/m);
});

const githubStub = "#!/usr/bin/env bash\nset -Eeuo pipefail\n\nendpoint=\"\"\nquery=\"\"\nfor arg in \"$@\"; do\n  case \"$arg\" in /repos/*|/users/*) endpoint=\"$arg\" ;; esac\ndone\nif [[ \"$*\" == *\"--jq\"* ]]; then query=\"${*: -1}\"; fi\ncase \"$endpoint\" in\n  */contents/scripts/ci-profile/authorize.mjs?ref=*)\n    [[ -z \"${TEST_OWNER_HELPER_FAIL:-}\" ]] || exit 1\n    [[ \"$endpoint\" == *\"ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\" ]] || exit 1\n    base64 < \"$TEST_OWNER_HELPER\"\n    ;;\n  */contents/.github/CODEOWNERS?ref=*)\n    [[ -z \"${TEST_CODEOWNERS_FAIL:-}\" ]] || exit 1\n    [[ \"$endpoint\" == *\"ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\" ]] || exit 1\n    jq -cn --arg content \"$TEST_CODEOWNERS_BASE64\" '{encoding: \"base64\", content: $content}'\n    ;;\n  /users/ci-owner)\n    [[ -z \"${TEST_OWNER_LOOKUP_FAIL:-}\" ]] || exit 1\n    jq -cn --argjson id \"${TEST_CI_OWNER_ID:-34892728}\" --arg type \"${TEST_CI_OWNER_TYPE:-User}\" '{id: $id, type: $type}'\n    ;;\n  */pulls/*)\n    jq -cn \\\n      --argjson author_id \"${TEST_PR_AUTHOR_ID:-34892728}\" \\\n      --argjson repository_id \"${TEST_REPOSITORY_ID:-1170821064}\" \\\n      --arg base_ref \"${TEST_BASE_REF:-master}\" \\\n      --arg base_sha \"${TEST_PR_BASE_SHA:-$EVENT_BASE_SHA}\" \\\n      --arg head_sha \"${TEST_PR_HEAD_SHA:-1111111111111111111111111111111111111111}\" \\\n      --arg merge_sha \"${TEST_PR_MERGE_SHA:-4444444444444444444444444444444444444444}\" '{\n        state: \"open\",\n        user: {id: $author_id},\n        base: {repo: {id: $repository_id}, ref: $base_ref, sha: $base_sha},\n        head: {sha: $head_sha},\n        merge_commit_sha: $merge_sha\n      }'\n    ;;\n  */git/ref/heads/*)\n    if [[ \"$query\" == \".object.sha\" ]]; then\n      [[ -z \"${TEST_MASTER_FAIL:-}\" ]] || exit 1\n      echo \"${TEST_TRUSTED_MASTER_SHA:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}\"\n      exit 0\n    fi\n    jq -cn \\\n      --arg sha \"${TEST_LIVE_BASE_REF_SHA:-$EVENT_BASE_SHA}\" '{object: {sha: $sha}}'\n    ;;\n  */compare/*)\n    [[ -z \"${TEST_COMPARE_FAIL:-}\" ]] || exit 1\n    comparison=\"${endpoint##*/}\"\n    comparison_base=\"${comparison%%...*}\"\n    comparison_head=\"${comparison##*...}\"\n    default_files='[{\"filename\":\"server/src/index.ts\"}]'\n    jq -cn \\\n      --arg base \"$comparison_base\" \\\n      --arg head \"$comparison_head\" \\\n      --arg event_base \"$EVENT_BASE_SHA\" \\\n      --arg intermediate \"${TEST_INTERMEDIATE_BASE_SHA:-}\" \\\n      --arg current \"${TEST_LIVE_BASE_REF_SHA:-$EVENT_BASE_SHA}\" \\\n      --arg side_branch \"${TEST_SIDE_BRANCH_SHA:-}\" \\\n      --arg merge_base_override \"${TEST_BASE_COMPARISON_MERGE_BASE_SHA:-}\" \\\n      --arg status_override \"${TEST_BASE_COMPARISON_STATUS:-}\" \\\n      --argjson files \"${TEST_COMPARE_FILES:-$default_files}\" '\n        [$event_base, $intermediate, $current] | map(select(length > 0)) as $history |\n        ($history | index($base)) as $from |\n        ($history | index($head)) as $to |\n        (($from != null and $to != null and $from <= $to) or\n          ($side_branch != \"\" and $base == $event_base and $head == $side_branch)) as $ancestor |\n        {\n          merge_base_commit: {sha: (if $merge_base_override != \"\" then $merge_base_override\n            elif $ancestor then $base\n            elif $base == $side_branch and $to != null then $event_base\n            else \"0000000000000000000000000000000000000000\" end)},\n          status: (if $status_override != \"\" then $status_override\n            elif $base == $head then \"identical\" elif $ancestor then \"ahead\" else \"diverged\" end),\n          files: $files\n        }'\n    ;;\n  */git/commits/*)\n    requested_sha=\"${endpoint##*/}\"\n    live_merge_sha=\"${TEST_PR_MERGE_SHA:-4444444444444444444444444444444444444444}\"\n    synthetic_base_merge_sha=\"${TEST_SYNTHETIC_BASE_MERGE_SHA:-}\"\n    if [[ \"$requested_sha\" == \"$EVENT_MERGE_SHA\" ]]; then\n      tree_sha=\"${TEST_EVENT_MERGE_TREE_SHA:-5555555555555555555555555555555555555555}\"\n      base_sha=\"${TEST_EVENT_MERGE_BASE_SHA:-$EVENT_BASE_SHA}\"\n      head_sha=\"${TEST_EVENT_MERGE_HEAD_SHA:-$EVENT_HEAD_SHA}\"\n    elif [[ \"$requested_sha\" == \"$live_merge_sha\" ]]; then\n      tree_sha=\"${TEST_LIVE_MERGE_TREE_SHA:-5555555555555555555555555555555555555555}\"\n      base_sha=\"${TEST_LIVE_MERGE_BASE_SHA:-$EVENT_BASE_SHA}\"\n      head_sha=\"${TEST_LIVE_MERGE_HEAD_SHA:-$EVENT_HEAD_SHA}\"\n    elif [[ -n \"$synthetic_base_merge_sha\" && \"$requested_sha\" == \"$synthetic_base_merge_sha\" ]]; then\n      tree_sha=\"${TEST_SYNTHETIC_BASE_MERGE_TREE_SHA:-8888888888888888888888888888888888888888}\"\n      base_sha=\"${TEST_SYNTHETIC_MASTER_PARENT_SHA:-9999999999999999999999999999999999999999}\"\n      head_sha=\"${TEST_SYNTHETIC_BASE_REF_PARENT_SHA:-${TEST_LIVE_BASE_REF_SHA:-$EVENT_BASE_SHA}}\"\n    else\n      echo \"unexpected merge commit: $requested_sha\" >&2\n      exit 1\n    fi\n    jq -cn \\\n      --arg sha \"$requested_sha\" \\\n      --arg tree_sha \"$tree_sha\" \\\n      --arg base_sha \"$base_sha\" \\\n      --arg head_sha \"$head_sha\" '{\n        sha: $sha,\n        tree: {sha: $tree_sha},\n        parents: [{sha: $base_sha}, {sha: $head_sha}]\n      }'\n    ;;\n  */actions/runs/*/attempts/*)\n    jq -cn \\\n      --argjson actor_id \"${TEST_TRIGGERING_ACTOR_ID:-34892728}\" \\\n      --argjson repository_id \"${TEST_REPOSITORY_ID:-1170821064}\" \\\n      --argjson run_attempt \"${TEST_RUN_ATTEMPT:-1}\" \\\n      --arg event_name \"${TEST_EVENT_NAME:-pull_request}\" '{\n        run_attempt: $run_attempt,\n        triggering_actor: {id: $actor_id},\n        repository: {id: $repository_id},\n        event: $event_name\n      }'\n    ;;\n  *)\n    echo \"unexpected gh endpoint: $endpoint\" >&2\n    exit 1\n    ;;\nesac";

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
        RUNNER_TEMP: directory,
        TEST_OWNER_HELPER: path.resolve("scripts/ci-profile/authorize.mjs"),
        TEST_CODEOWNERS_BASE64: Buffer.from(".github/** @ci-owner\n").toString("base64"),
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
        RUN_ATTEMPT: "1",
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
  ...["profile-ci", "full-ci"].flatMap((label) => {
    const event = { EVENT_ACTION: "labeled", EVENT_LABEL_NAME: label };
    return [
      [`allowlisted ${label} label`, event, awsRunner],
      [`${label} with unlisted author`, { ...event, EVENT_PR_AUTHOR_ID: "99999999" }],
      [`${label} with unlisted sender`, { ...event, EVENT_SENDER_ID: "99999999" }],
      [`${label} with unlisted rerun actor`, { ...event, TEST_TRIGGERING_ACTOR_ID: "99999999" }],
      [`${label} on non-owner PR with owner sender and rerun`, {
        ...event, EVENT_PR_AUTHOR_ID: "99999999", TEST_PR_AUTHOR_ID: "99999999", TRUSTED_USER_IDS: "[34892728,99999999]",
      }],
      [`${label} with non-owner sender`, { ...event, EVENT_SENDER_ID: "99999999", TRUSTED_USER_IDS: "[34892728,99999999]" }],
      [`${label} with non-owner rerun actor`, { ...event, TEST_TRIGGERING_ACTOR_ID: "99999999", TRUSTED_USER_IDS: "[34892728,99999999]" }],
    ];
  }),
  ["unrelated label", { EVENT_ACTION: "labeled", EVENT_LABEL_NAME: "documentation" }],
  ["validated stacked base", stackedBase, awsRunner],
  ["lagging PR API base snapshot", { TEST_PR_BASE_SHA: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, awsRunner],
  ["base advances while the routing job waits", { TEST_LIVE_BASE_REF_SHA: "7777777777777777777777777777777777777777" }, awsRunner],
  ["merge uses a newer base snapshot than the event payload", {
    TEST_LIVE_BASE_REF_SHA: "7777777777777777777777777777777777777777",
    TEST_INTERMEDIATE_BASE_SHA: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    TEST_EVENT_MERGE_BASE_SHA: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  }, awsRunner],
  ["GitHub regenerates the live merge after base advancement", {
    TEST_LIVE_BASE_REF_SHA: "7777777777777777777777777777777777777777",
    TEST_LIVE_MERGE_BASE_SHA: "7777777777777777777777777777777777777777",
    TEST_LIVE_MERGE_TREE_SHA: "6666666666666666666666666666666666666666",
  }, awsRunner],
  ["live merge is temporarily unavailable", { TEST_PR_MERGE_SHA: "unavailable" }, awsRunner],
  ["stacked base advances while the routing job waits", {
    ...stackedBase,
    TEST_SYNTHETIC_BASE_REF_PARENT_SHA: "7777777777777777777777777777777777777777",
    TEST_INTERMEDIATE_BASE_SHA: "7777777777777777777777777777777777777777",
    TEST_LIVE_BASE_REF_SHA: "cccccccccccccccccccccccccccccccccccccccc",
  }, awsRunner],
  ["merge parent outside the base branch history", { TEST_EVENT_MERGE_BASE_SHA: "cccccccccccccccccccccccccccccccccccccccc" }],
  ["stacked base parent descends from the event base but diverges from the live base", {
    ...stackedBase,
    TEST_SIDE_BRANCH_SHA: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    TEST_SYNTHETIC_BASE_REF_PARENT_SHA: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  }],
  ["base history lookup unavailable", { TEST_COMPARE_FAIL: "1" }],
  ["disabled AWS", { AWS_CI_ENABLED: "false" }],
  ["missing AWS variables", { AWS_CI_ENABLED: "", TRUSTED_USER_IDS: "" }],
  ["unlisted author", { EVENT_PR_AUTHOR_ID: "99999999" }],
  ["unlisted sender", { EVENT_SENDER_ID: "99999999" }],
  ["unlisted rerun actor", { TEST_TRIGGERING_ACTOR_ID: "99999999" }],
  ["allowlisted user removed from CODEOWNERS", { TEST_CI_OWNER_ID: "99999999" }],
  ["CODEOWNER not on numeric allowlist", { TRUSTED_USER_IDS: "[99999999]" }],
  ["non-owner PR with owner rerun", { EVENT_PR_AUTHOR_ID: "99999999", TEST_PR_AUTHOR_ID: "99999999", TRUSTED_USER_IDS: "[34892728,99999999]" }],
  ["non-owner event sender", { EVENT_SENDER_ID: "99999999", TRUSTED_USER_IDS: "[34892728,99999999]" }],
  ["non-owner rerun actor", { TEST_TRIGGERING_ACTOR_ID: "99999999", TRUSTED_USER_IDS: "[34892728,99999999]" }],
  ["CODEOWNERS unavailable", { TEST_CODEOWNERS_FAIL: "1" }],
  ["owner identity unavailable", { TEST_OWNER_LOOKUP_FAIL: "1" }],
  ["owner is not a person", { TEST_CI_OWNER_TYPE: "Bot" }],
  ["trusted helper unavailable", { TEST_OWNER_HELPER_FAIL: "1" }],
  ["trusted master unavailable", { TEST_MASTER_FAIL: "1" }],
  ["invalid trusted master", { TEST_TRUSTED_MASTER_SHA: "bad" }],
  ["documentation owners do not authorize CI", { TEST_CODEOWNERS_BASE64: Buffer.from("doc/** @ci-owner\n").toString("base64") }],
  ["ambiguous CODEOWNERS deny access", { TEST_CODEOWNERS_BASE64: Buffer.from(".github/** @ci-owner\n/.github/** @ci-owner\n").toString("base64") }],
  ["malformed run attempt", { RUN_ATTEMPT: "bad" }],
  ["wrong run attempt", { TEST_RUN_ATTEMPT: "2" }],
  ["owner rerun validates its own attempt", { RUN_ATTEMPT: "2", TEST_RUN_ATTEMPT: "2" }, awsRunner],
  ["missing base", { EVENT_BASE_REF: "" }],
  ["wrong base repository", { EVENT_BASE_REPOSITORY_ID: "999999999" }],
  ["replaced base ancestry", { TEST_BASE_COMPARISON_MERGE_BASE_SHA: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }],
  ["stale head", { TEST_PR_HEAD_SHA: "3333333333333333333333333333333333333333" }],
  ["event merge has the wrong head", { TEST_EVENT_MERGE_HEAD_SHA: "3333333333333333333333333333333333333333" }],
  ["stacked base with wrong parent", { ...stackedBase, TEST_SYNTHETIC_BASE_REF_PARENT_SHA: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }],
  ["event merge has an invalid tree", { TEST_EVENT_MERGE_TREE_SHA: "invalid" }],
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
    assert.equal(executeStep("Select PR CI scope", {
      STACK_JSON: JSON.stringify(stack), PR_BASE_REF: base,
    }).full_ci, expected);
  });
}

const files = (...paths) => JSON.stringify(paths.map((filename) => ({ filename })));

test("full-suite requests override both middle-stack and release-notes-only skips", () => {
  for (const overrides of [
    { STACK_JSON: JSON.stringify({ position: 2, size: 3, base: { ref: "master" } }), PR_BASE_REF: "stack-1" },
    { STACK_JSON: "null", PR_BASE_REF: "master", TEST_COMPARE_FILES: files("releases/v2026.1015.0.md") },
  ]) {
    assert.equal(executeStep("Select PR CI scope", { ...overrides, PROFILE_CI: "false" }).full_ci, "false");
    for (const request of [{ PROFILE_CI: "true" }, { FORCE_FULL_CI: "true" }, { CI_INCREMENTAL_MODE: "full" }]) {
      assert.equal(executeStep("Select PR CI scope", { ...overrides, ...request }).full_ci, "true");
    }
  }
});
const manyReleaseNotes = JSON.stringify(Array.from({ length: 300 }, (_, index) => ({
  filename: `releases/beta/v2026.1012.${index}-beta.0.md`,
})));

const pathScopeCases = [
  ["stable release notes", { TEST_COMPARE_FILES: files("releases/v2026.1015.0.md") }, "false"],
  ["beta release notes draft", { TEST_COMPARE_FILES: files("releases/beta/v2026.1012.1-beta.0.md") }, "false"],
  ["stable and beta notes", { TEST_COMPARE_FILES: files("releases/v2026.1015.0.md", "releases/beta/v2026.1012.1-beta.0.md") }, "false"],
  ["removed release notes", { TEST_COMPARE_FILES: JSON.stringify([{ filename: "releases/beta/v2026.1006.0-beta.0.md", status: "removed" }]) }, "false"],
  ["release notes and code", { TEST_COMPARE_FILES: files("releases/v2026.1015.0.md", "server/src/index.ts") }, "true"],
  ["code renamed into releases", { TEST_COMPARE_FILES: JSON.stringify([{ filename: "releases/v2026.1015.0.md", previous_filename: "scripts/release.sh" }]) }, "true"],
  ["non-markdown file in releases", { TEST_COMPARE_FILES: files("releases/beta/v2026.1012.1-beta.0.json") }, "true"],
  ["nested releases directory", { TEST_COMPARE_FILES: files("releases/beta/drafts/v2026.1012.1-beta.0.md") }, "true"],
  ["markdown outside releases", { TEST_COMPARE_FILES: files("doc/RELEASING.md") }, "true"],
  ["file entry without a name", { TEST_COMPARE_FILES: JSON.stringify([{ status: "modified" }]) }, "true"],
  ["empty diff", { TEST_COMPARE_FILES: "[]" }, "true"],
  ["possibly truncated file list", { TEST_COMPARE_FILES: manyReleaseNotes }, "true"],
  ["compare lookup failure", { TEST_COMPARE_FAIL: "1", TEST_COMPARE_FILES: files("releases/v2026.1015.0.md") }, "true"],
  ["non-PR event", { EVENT_NAME: "workflow_dispatch", TEST_COMPARE_FILES: files("releases/v2026.1015.0.md") }, "true"],
  ["malformed head SHA", { EVENT_HEAD_SHA: "invalid", TEST_COMPARE_FILES: files("releases/v2026.1015.0.md") }, "true"],
];

for (const [name, env, expected] of pathScopeCases) {
  test(`path scope decision: ${name}`, () => {
    assert.equal(executeStep("Select PR CI scope", {
      STACK_JSON: "null", PR_BASE_REF: "master", ...env,
    }).full_ci, expected);
  });
}

test("path scope keeps full CI for the top PR in a stack that touches code", () => {
  assert.equal(executeStep("Select PR CI scope", {
    STACK_JSON: JSON.stringify({ position: 11, size: 11, base: { ref: "master" } }),
    PR_BASE_REF: "stack-10",
  }).full_ci, "true");
});

test("path scope keeps full CI for release notes on top of code-changing stacked PRs", () => {
  assert.equal(executeStep("Select PR CI scope", {
    STACK_JSON: JSON.stringify({ position: 11, size: 11, base: { ref: "master" } }),
    PR_BASE_REF: "stack-10",
    TEST_COMPARE_FILES: files("releases/v2026.1015.0.md"),
  }).full_ci, "true");
});

test("path scope keeps full CI for release notes with malformed stack metadata", () => {
  assert.equal(executeStep("Select PR CI scope", {
    STACK_JSON: JSON.stringify({ position: 0, size: 2, base: { ref: "master" } }),
    PR_BASE_REF: "master",
    TEST_COMPARE_FILES: files("releases/v2026.1015.0.md"),
  }).full_ci, "true");
});

test("path scope skips full CI for the lowest PR in a stack that only touches release notes", () => {
  assert.equal(executeStep("Select PR CI scope", {
    STACK_JSON: JSON.stringify({ position: 1, size: 3, base: { ref: "master" } }),
    PR_BASE_REF: "master",
    TEST_COMPARE_FILES: files("releases/v2026.1015.0.md"),
  }).full_ci, "false");
});

test("path scope skips full CI for a single-PR stack that only touches release notes", () => {
  assert.equal(executeStep("Select PR CI scope", {
    STACK_JSON: JSON.stringify({ position: 1, size: 1, base: { ref: "master" } }),
    PR_BASE_REF: "master",
    TEST_COMPARE_FILES: files("releases/v2026.1015.0.md"),
  }).full_ci, "false");
});

function routingPlacement(vars = {}, github = {}, placementJobs = jobs) {
  const source = "[34892728]";
  const expression = placementJobs.match(/^ {4}runs-on: \$\{\{ (.+) \}\}$/m)?.[1];
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

const catalogWorkflow = readFileSync(new URL("../../workflows/chat-catalog-testops.yml", import.meta.url), "utf8");
const catalogAuthorize = catalogWorkflow.split("  authorize:\n")[1].split("\n  select:\n")[0];
const catalogContext = {
  event_name: "workflow_dispatch",
  workflow_ref: "paperclipai/paperclip/.github/workflows/chat-catalog-testops.yml@refs/heads/master",
  actor: "dotta",
  triggering_actor: "dotta",
  run_attempt: "1",
};

const catalogPlacementCases = [
  ["approved first manual master attempt", {}, awsRunner],
  ["foreign repository", { repository: "other/paperclip" }],
  ["foreign repository ID", { repository_id: "999" }],
  ["untrusted branch", { ref: "refs/heads/other" }],
  ["tag", { ref: "refs/tags/master" }],
  ["pull request", { event_name: "pull_request" }],
  ["push", { event_name: "push" }],
  ["different workflow", { workflow_ref: "paperclipai/paperclip/.github/workflows/ci-routing.yml@refs/heads/master" }],
  ["branch workflow", { workflow_ref: "paperclipai/paperclip/.github/workflows/chat-catalog-testops.yml@refs/heads/other" }],
  ["unapproved actor", { actor_id: "999" }],
  ["partial actor ID", { actor_id: "4892728" }],
  ["different triggering actor", { triggering_actor: "other" }],
  ["missing triggering actor", { triggering_actor: "" }],
  ["rerun", { run_attempt: "2" }],
  ["missing attempt", { run_attempt: "" }],
];

for (const [name, overrides, expected = "ubuntu-latest"] of catalogPlacementCases) {
  test(`catalog authorize placement before allocation: ${name}`, () => {
    assert.equal(routingPlacement({}, { ...catalogContext, ...overrides }, catalogAuthorize), expected);
  });
}

test("catalog placement retains downstream jobs and actual dispatch guard", () => {
  assert.match(catalogWorkflow.split("  select:\n")[1].split("\n  build:\n")[0], /^ {4}runs-on: ubuntu-latest$/m);
  assert.match(catalogAuthorize, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(catalogAuthorize, /persist-credentials: false/);
  assert.match(catalogAuthorize, /TESTOPS_ALLOWED_ACTOR_IDS: \$\{\{ vars\.RUNNER_E2E_ALLOWED_ACTOR_IDS \}\}/);
  assert.match(catalogAuthorize, /run: node tests\/runner-e2e\/chat-completion-testops-cli\.mjs guard/);
  assert.doesNotMatch(catalogAuthorize, /secrets\.|environment:/);
});

const reservedFleet = "runs-on/fleet=paperclip-ci-routing-x64/env=public-ci";
const shortJobVars = { AWS_CI_SHORT_JOBS_ENABLED: "true" };
const ownerRun = { id: 34892728 };
const ownRepository = { id: 1170821064 };

const notifierJob = readFileSync(new URL("../../workflows/pr-merge-review.yml", import.meta.url), "utf8")
  .split(/^jobs:\n/m)[1];
const notifierEvent = (workflowRun = {}) => ({
  event_name: "workflow_run",
  event: { workflow_run: { head_repository: ownRepository, actor: ownerRun, triggering_actor: ownerRun, ...workflowRun } },
});
const notifierPlacementCases = [
  ["CODEOWNER PR run", shortJobVars, notifierEvent(), reservedFleet],
  ["not yet enabled", {}, notifierEvent()],
  ["AWS CI disabled", { ...shortJobVars, AWS_CI_ENABLED: "false" }, notifierEvent()],
  ["stale snapshot", { ...shortJobVars, AWS_CI_TRUSTED_USER_IDS: "[34892728,999]" }, notifierEvent()],
  ["community author", shortJobVars, notifierEvent({ actor: { id: 999 } })],
  ["community rerun of an owner PR", shortJobVars, notifierEvent({ triggering_actor: { id: 999 } })],
  ["partial ID cannot match", shortJobVars, notifierEvent({ actor: { id: 4892728 } })],
  ["fork head", shortJobVars, notifierEvent({ head_repository: { id: 999 } })],
  ["missing head repository", shortJobVars, notifierEvent({ head_repository: {} })],
  ["external check run", shortJobVars, { event_name: "check_run", event: { check_run: {}, sender: ownerRun } }],
  ["commit status", shortJobVars, { event_name: "status", event: { sender: ownerRun } }],
  ["different repository", shortJobVars, { ...notifierEvent(), repository: "other/repo" }],
  ["different repository ID", shortJobVars, { ...notifierEvent(), repository_id: "999" }],
];

for (const [name, vars, github, expected = "ubuntu-latest"] of notifierPlacementCases) {
  test(`merge review notifier placement: ${name}`, () => {
    assert.equal(routingPlacement(vars, github, notifierJob), expected);
  });
}

const reviewJob = readFileSync(new URL("../../workflows/commitperclip-review.yml", import.meta.url), "utf8")
  .split(/^jobs:\n/m)[1];
const reviewEvent = (pullRequest = {}, sender = ownerRun) => ({
  event_name: "pull_request_target",
  event: { pull_request: { user: ownerRun, head: { repo: ownRepository }, ...pullRequest }, sender },
});
const reviewPlacementCases = [
  ["CODEOWNER PR", shortJobVars, reviewEvent(), reservedFleet],
  ["not yet enabled", {}, reviewEvent()],
  ["AWS CI disabled", { ...shortJobVars, AWS_CI_ENABLED: "false" }, reviewEvent()],
  ["missing admission members", { ...shortJobVars, AWS_CI_ROUTING_USER_IDS: "" }, reviewEvent()],
  ["community author", shortJobVars, reviewEvent({ user: { id: 999 } })],
  ["community sender on an owner PR", shortJobVars, reviewEvent({}, { id: 999 })],
  ["owner PR from a fork", shortJobVars, reviewEvent({ head: { repo: { id: 999 } } })],
  ["deleted fork", shortJobVars, reviewEvent({ head: { repo: {} } })],
  ["other event", shortJobVars, { ...reviewEvent(), event_name: "pull_request" }],
  ["different repository ID", shortJobVars, { ...reviewEvent(), repository_id: "999" }],
];

for (const [name, vars, github, expected = "ubuntu-latest"] of reviewPlacementCases) {
  test(`commitperclip review placement: ${name}`, () => {
    assert.equal(routingPlacement(vars, github, reviewJob), expected);
  });
}

test("GitHub-hosted PR runs queue at most four jobs per matrix", () => {
  const trusted = readFileSync(new URL("../../workflows/pr-trusted.yml", import.meta.url), "utf8");
  const strategies = trusted.match(/^ {4}strategy:\n(?: {6}.*\n)+/gm) ?? [];
  assert.equal(strategies.length, 4);
  for (const strategy of strategies) {
    const expression = strategy.match(/^ {6}max-parallel: \$\{\{ (.+) \}\}$/m)?.[1];
    assert.ok(expression, "every PR matrix must bound its GitHub-hosted fan-out");
    const limit = (runner) => vm.runInNewContext(expression, { needs: { gate: { outputs: { runner } } } });
    assert.equal(limit("ubuntu-latest"), 4);
    assert.equal(limit(awsRunner), 256);
  }
});
