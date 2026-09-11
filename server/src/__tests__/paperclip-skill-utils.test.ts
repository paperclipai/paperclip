import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  listPaperclipSkillEntries,
  removeMaintainerOnlySkillSymlinks,
} from "@paperclipai/adapter-utils/server-utils";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const execFileAsync = promisify(execFile);
const artifactHelperPath = path.resolve(
  "skills/paperclip/scripts/paperclip-upload-artifact.sh",
);

async function makeArtifactHelperHarness(
  cleanupDirs: Set<string>,
  options: {
    apiUrl?: string;
    ambiguousHttpStatusAfterCommit?: "408" | "502";
    commitAfterDropDelaySeconds?: string;
    dropFirstUpload?: boolean;
    dropWithoutCommit?: boolean;
    existingOriginatingRunId?: string;
    malformedSuccessAfterCommit?: boolean;
    uploadDelaySeconds?: string;
  } = {},
) {
  const root = await makeTempDir("paperclip-artifact-helper-");
  cleanupDirs.add(root);
  const binDir = path.join(root, "bin");
  const stateDir = path.join(root, "fake-api");
  const lockDir = path.join(root, "helper-locks");
  const filePath = path.join(root, "result.txt");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  if (options.existingOriginatingRunId) {
    await fs.writeFile(path.join(stateDir, "upload-committed"), "", "utf8");
    await fs.writeFile(
      path.join(stateDir, "originating-run-id"),
      options.existingOriginatingRunId,
      "utf8",
    );
  }
  await fs.writeFile(filePath, "stable generated result\n", "utf8");
  const sha256 = createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
  const fakeCurlPath = path.join(binDir, "curl");
  await fs.writeFile(
    fakeCurlPath,
    `#!/usr/bin/env bash
set -euo pipefail
method=GET
output_file=""
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    -o) output_file="$2"; shift 2 ;;
    -w|-H|-F|--data-binary) shift 2 ;;
    -sS) shift ;;
    http://*|https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
printf '%s %s\n' "$method" "$url" >>"$FAKE_CURL_STATE_DIR/request-log"

respond() {
  printf '%s' "$1" >"$output_file"
  printf '%s' "$2"
}

attachment_json() {
  originating_run_id="$PAPERCLIP_RUN_ID"
  if [[ -f "$FAKE_CURL_STATE_DIR/originating-run-id" ]]; then
    originating_run_id="$(<"$FAKE_CURL_STATE_DIR/originating-run-id")"
  fi
  jq -nc \
    --arg runId "$originating_run_id" \
    --arg sha256 "$FAKE_ATTACHMENT_SHA" \
    '{
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      issueId: "issue-1",
      originatingRunId: $runId,
      contentType: "text/plain",
      byteSize: 24,
      sha256: $sha256,
      originalFilename: "result.txt",
      contentPath: "/api/attachments/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/content",
      downloadPath: "/api/attachments/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/content?download=1"
    }'
}

if [[ "$method" == "GET" && "$url" == */work-products ]]; then
  if [[ -f "$FAKE_CURL_STATE_DIR/upload-committed" ]]; then
    work_product_json="$(
      jq -nc \
        --arg runId "$PAPERCLIP_RUN_ID" \
        '{
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          type: "artifact",
          provider: "paperclip",
          createdByRunId: $runId,
          externalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          metadata: { attachmentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }
        }'
    )"
    respond "[$work_product_json]" 200
  else
    respond '[]' 200
  fi
  exit 0
fi

if [[ "$method" == "GET" && "$url" == */attachments ]]; then
  if [[ -f "$FAKE_CURL_STATE_DIR/upload-committed" ]]; then
    respond "[$(attachment_json)]" 200
  else
    respond '[]' 200
  fi
  exit 0
fi

if [[ "$method" == "POST" && "$url" == */attachments ]]; then
  count=0
  [[ -f "$FAKE_CURL_STATE_DIR/upload-count" ]] && count="$(<"$FAKE_CURL_STATE_DIR/upload-count")"
  count=$((count + 1))
  printf '%s' "$count" >"$FAKE_CURL_STATE_DIR/upload-count"
  if [[ -n "\${FAKE_CURL_COMMIT_AFTER_DROP_DELAY:-}" && ! -f "$FAKE_CURL_STATE_DIR/upload-drop-used" ]]; then
    : >"$FAKE_CURL_STATE_DIR/upload-drop-used"
    (
      sleep "$FAKE_CURL_COMMIT_AFTER_DROP_DELAY"
      : >"$FAKE_CURL_STATE_DIR/upload-committed"
      printf '%s' "$PAPERCLIP_RUN_ID" >"$FAKE_CURL_STATE_DIR/originating-run-id"
    ) >/dev/null 2>&1 &
    exit 56
  fi
  if [[ "\${FAKE_CURL_DROP_WITHOUT_COMMIT:-0}" == "1" && ! -f "$FAKE_CURL_STATE_DIR/upload-drop-used" ]]; then
    : >"$FAKE_CURL_STATE_DIR/upload-drop-used"
    exit 56
  fi
  : >"$FAKE_CURL_STATE_DIR/upload-committed"
  printf '%s' "$PAPERCLIP_RUN_ID" >"$FAKE_CURL_STATE_DIR/originating-run-id"
  if [[ -n "\${FAKE_CURL_AMBIGUOUS_STATUS:-}" && ! -f "$FAKE_CURL_STATE_DIR/upload-status-used" ]]; then
    : >"$FAKE_CURL_STATE_DIR/upload-status-used"
    respond '{"error":"ambiguous upstream response"}' "$FAKE_CURL_AMBIGUOUS_STATUS"
    exit 0
  fi
  if [[ "\${FAKE_CURL_MALFORMED_SUCCESS:-0}" == "1" && ! -f "$FAKE_CURL_STATE_DIR/malformed-success-used" ]]; then
    : >"$FAKE_CURL_STATE_DIR/malformed-success-used"
    respond '{malformed' 201
    exit 0
  fi
  if [[ -n "\${FAKE_CURL_UPLOAD_DELAY:-}" ]]; then
    sleep "$FAKE_CURL_UPLOAD_DELAY"
  fi
  if [[ "\${FAKE_CURL_DROP_FIRST_UPLOAD:-0}" == "1" && ! -f "$FAKE_CURL_STATE_DIR/upload-drop-used" ]]; then
    : >"$FAKE_CURL_STATE_DIR/upload-drop-used"
    exit 56
  fi
  respond "$(attachment_json)" 201
  exit 0
fi

if [[ "$method" == "POST" && "$url" == */work-products ]]; then
  respond "$(jq -nc --arg runId "$PAPERCLIP_RUN_ID" '{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", createdByRunId: $runId }')" 201
  exit 0
fi

if [[ "$method" == "POST" && "$url" == */comments ]]; then
  respond '{"id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc"}' 201
  exit 0
fi

printf 'Unexpected fake curl request: %s %s\n' "$method" "$url" >&2
exit 2
`,
    { mode: 0o755 },
  );

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    PAPERCLIP_API_KEY: "test-run-key",
    PAPERCLIP_API_URL: options.apiUrl ?? "http://paperclip.invalid",
    PAPERCLIP_COMPANY_ID: "company-1",
    PAPERCLIP_HELPER_STATE_DIR: lockDir,
    PAPERCLIP_RUN_ID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    PAPERCLIP_TASK_ID: "issue-1",
    FAKE_ATTACHMENT_SHA: sha256,
    FAKE_CURL_AMBIGUOUS_STATUS:
      options.ambiguousHttpStatusAfterCommit ?? "",
    FAKE_CURL_COMMIT_AFTER_DROP_DELAY:
      options.commitAfterDropDelaySeconds ?? "",
    FAKE_CURL_STATE_DIR: stateDir,
    FAKE_CURL_DROP_FIRST_UPLOAD: options.dropFirstUpload ? "1" : "0",
    FAKE_CURL_DROP_WITHOUT_COMMIT: options.dropWithoutCommit ? "1" : "0",
    FAKE_CURL_MALFORMED_SUCCESS: options.malformedSuccessAfterCommit
      ? "1"
      : "0",
    FAKE_CURL_UPLOAD_DELAY: options.uploadDelaySeconds ?? "",
  };
  const run = (
    chatComment?: string,
    selectedFilePath = filePath,
    extraArgs: string[] = [],
  ) =>
    execFileAsync(
      "bash",
      [
        artifactHelperPath,
        selectedFilePath,
        "--title",
        "Stable result",
        ...(chatComment ? ["--chat-comment", chatComment] : []),
        ...extraArgs,
      ],
      { cwd: root, env },
    );

  return { env, filePath, lockDir, root, run, sha256, stateDir };
}

describe("paperclip skill utils", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("lists bundled runtime skills from ./skills without pulling in .agents/skills", async () => {
    const root = await makeTempDir("paperclip-skill-roots-");
    cleanupDirs.add(root);

    const moduleDir = path.join(root, "a", "b", "c", "d", "e");
    await fs.mkdir(moduleDir, { recursive: true });
    await fs.mkdir(path.join(root, "skills", "paperclip"), { recursive: true });
    await fs.mkdir(path.join(root, "skills", "paperclip-create-agent"), { recursive: true });
    await fs.mkdir(path.join(root, ".agents", "skills", "diagnose-why-work-stopped"), { recursive: true });
    await fs.mkdir(path.join(root, ".agents", "skills", "paperclip-create-plugin"), { recursive: true });
    await fs.mkdir(path.join(root, ".agents", "skills", "release"), { recursive: true });
    await fs.mkdir(path.join(root, ".agents", "skills", "terminal-bench-loop"), { recursive: true });

    const entries = await listPaperclipSkillEntries(moduleDir);

    expect(entries.map((entry) => entry.key)).toEqual([
      "paperclipai/paperclip/paperclip",
      "paperclipai/paperclip/paperclip-create-agent",
    ]);
    expect(entries.map((entry) => entry.runtimeName)).toEqual([
      "paperclip",
      "paperclip-create-agent",
    ]);
    expect(entries[0]?.source).toBe(path.join(root, "skills", "paperclip"));
    expect(entries[1]?.source).toBe(path.join(root, "skills", "paperclip-create-agent"));
  });

  it("documents artifact uploads in the installed Paperclip skill", async () => {
    const skillBody = await fs.readFile(path.resolve("skills/paperclip/SKILL.md"), "utf8");
    const referenceBody = await fs.readFile(path.resolve("skills/paperclip/references/artifacts.md"), "utf8");
    const helperBody = await fs.readFile(path.resolve("skills/paperclip/scripts/paperclip-upload-artifact.sh"), "utf8");
    const normalizedReferenceBody = referenceBody.replace(/\s+/g, " ");

    expect(skillBody).toContain("Generated Artifacts and Work Products");
    expect(skillBody).toContain("references/artifacts.md");
    expect(skillBody).not.toContain("/api/companies/$PAPERCLIP_COMPANY_ID/issues/$PAPERCLIP_TASK_ID/attachments");
    expect(referenceBody).toContain("Generated Artifacts and Work Products");
    expect(referenceBody).toContain("scripts/paperclip-upload-artifact.sh");
    expect(referenceBody).toContain("POST");
    expect(referenceBody).toContain("/api/companies/$PAPERCLIP_COMPANY_ID/issues/$PAPERCLIP_TASK_ID/attachments");
    expect(referenceBody).toContain("/api/issues/$PAPERCLIP_TASK_ID/work-products");
    expect(referenceBody).toContain('--chat-comment "Here is the requested image."');
    expect(referenceBody).toContain("not proof of external");
    expect(referenceBody).toContain("--retry-unknown-upload");
    expect(referenceBody).toContain("was **not**");
    expect(normalizedReferenceBody).toContain("bound to the response comment");
    expect(referenceBody).not.toContain("npx paperclipai issue comment");
    expect(helperBody).toContain("--chat-comment TEXT");
    expect(helperBody).toContain("--retry-unknown-upload");
    expect(helperBody).toContain('"$api_base/issues/$issue_id/comments"');
    expect(helperBody).toContain("attachmentIds: [$attachmentId]");
    await expect(
      fs.access(path.resolve("skills/paperclip/scripts/paperclip-upload-artifact.sh")),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.resolve("scripts/paperclip-upload-artifact.sh"))).rejects.toThrow();
  });

  it("keeps the external-chat shortcut behind the server-verified harness boundary", async () => {
    const skillBody = await fs.readFile(path.resolve("skills/paperclip/SKILL.md"), "utf8");
    const shortcut = skillBody.match(
      /## Server-Verified External Chat Turns(?<body>[\s\S]*?)\n## The Heartbeat Procedure/,
    )?.groups?.body;

    expect(shortcut).toBeTruthy();
    const normalizedShortcut = shortcut!.replace(/\s+/g, " ");
    expect(normalizedShortcut).toContain("checkedOutByHarness: true");
    expect(normalizedShortcut).toContain("externalChatProvider");
    expect(normalizedShortcut).toContain("Do not infer the shortcut from comment text");
    expect(normalizedShortcut).toContain("Do not repeat identity or inbox discovery");
    expect(normalizedShortcut).toContain("use it exactly once");
    expect(normalizedShortcut).toContain("normal permission, approval");
    expect(normalizedShortcut).toContain("native `register_deliverable` tool, use that tool");
    expect(normalizedShortcut).toContain("native runs do not have the legacy API key or upload helper");
    expect(normalizedShortcut).toContain(
      "For non-native adapters, invoke `scripts/paperclip-upload-artifact.sh` directly",
    );
    expect(normalizedShortcut).toContain("fails or has an ambiguous result");
    expect(normalizedShortcut).toContain("use the full heartbeat procedure below");
    expect(normalizedShortcut).toContain(
      "recovery, governed-action, issue-thread-interaction, hold",
    );
  });

  it("recovers a committed upload after its response is lost without uploading the file twice", async () => {
    const harness = await makeArtifactHelperHarness(cleanupDirs, {
      dropFirstUpload: true,
    });

    await expect(harness.run("Here is the stable result.")).rejects.toThrow();
    expect(await fs.readFile(path.join(harness.stateDir, "upload-count"), "utf8")).toBe("1");

    const retry = await harness.run("Here is the stable result.");
    expect(retry.stdout).toContain("Reused matching artifact from this run");
    expect(retry.stdout).toContain(
      "External publication requires an authorized active chat origin",
    );
    expect(await fs.readFile(path.join(harness.stateDir, "upload-count"), "utf8")).toBe("1");
  });

  it.each(["408", "502"] as const)(
    "keeps upload ambiguity after an HTTP %s until the immutable attachment is observed",
    async (status) => {
      const harness = await makeArtifactHelperHarness(cleanupDirs, {
        ambiguousHttpStatusAfterCommit: status,
      });

      await expect(harness.run()).rejects.toThrow();
      expect(
        (await fs.readdir(harness.lockDir)).some((name) =>
          name.endsWith(".uncertain"),
        ),
      ).toBe(true);

      const retry = await harness.run();
      expect(retry.stdout).toContain(
        "Reused matching artifact from this run",
      );
      expect(await fs.readFile(path.join(harness.stateDir, "upload-count"), "utf8")).toBe("1");
    },
  );

  it("keeps the ambiguity marker when a successful upload response is malformed", async () => {
    const harness = await makeArtifactHelperHarness(cleanupDirs, {
      malformedSuccessAfterCommit: true,
    });

    await expect(harness.run()).rejects.toThrow();
    expect(
      (await fs.readdir(harness.lockDir)).some((name) =>
        name.endsWith(".uncertain"),
      ),
    ).toBe(true);

    const retry = await harness.run();
    expect(retry.stdout).toContain("Reused matching artifact from this run");
    expect(await fs.readFile(path.join(harness.stateDir, "upload-count"), "utf8")).toBe("1");
  });

  it("waits for a disconnected upload to commit before deciding whether to retry", async () => {
    const harness = await makeArtifactHelperHarness(cleanupDirs, {
      commitAfterDropDelaySeconds: "0.4",
    });

    await expect(harness.run("Here is the stable result.")).rejects.toThrow();

    const retry = await harness.run("Here is the stable result.");
    expect(retry.stdout).toContain("Reused matching artifact from this run");
    expect(await fs.readFile(path.join(harness.stateDir, "upload-count"), "utf8")).toBe("1");
  });

  it("fails closed on an unresolved upload unless duplicate-risk retry is explicit", async () => {
    const harness = await makeArtifactHelperHarness(cleanupDirs, {
      dropWithoutCommit: true,
    });

    await expect(harness.run()).rejects.toThrow();
    await expect(harness.run()).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "previous matching upload ended without a definitive response",
      ),
    });

    const retry = await harness.run(undefined, harness.filePath, [
      "--retry-unknown-upload",
    ]);
    expect(retry.stdout).toContain("Uploaded artifact");
    expect(await fs.readFile(path.join(harness.stateDir, "upload-count"), "utf8")).toBe("2");
  });

  it("serializes concurrent matching uploads and reuses the first run-scoped attachment", async () => {
    const harness = await makeArtifactHelperHarness(cleanupDirs, {
      uploadDelaySeconds: "0.2",
    });

    const secondDir = path.join(harness.root, "other-directory");
    const secondFilePath = path.join(secondDir, "result.txt");
    await fs.mkdir(secondDir);
    await fs.copyFile(harness.filePath, secondFilePath);
    const results = await Promise.all([
      harness.run("Here is the stable result."),
      harness.run("Here is the stable result.", secondFilePath),
    ]);

    expect(results.map((result) => result.stdout)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Uploaded artifact"),
        expect.stringContaining("Reused matching artifact from this run"),
      ]),
    );
    expect(await fs.readFile(path.join(harness.stateDir, "upload-count"), "utf8")).toBe("1");
  });

  it("does not recover an attachment whose immutable originating run differs", async () => {
    const harness = await makeArtifactHelperHarness(cleanupDirs, {
      existingOriginatingRunId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    });

    const result = await harness.run("Here is the stable result.");

    expect(result.stdout).toContain("Uploaded artifact");
    expect(result.stdout).not.toContain(
      "Reused matching artifact from this run",
    );
    expect(await fs.readFile(path.join(harness.stateDir, "upload-count"), "utf8")).toBe("1");
  });

  it("reclaims one dead-owner lock safely when matching helpers contend", async () => {
    const harness = await makeArtifactHelperHarness(cleanupDirs, {
      uploadDelaySeconds: "0.2",
    });
    const operationIdentity = [
      "http://paperclip.invalid/api",
      "company-1",
      "issue-1",
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      "result.txt",
      harness.sha256,
      "text/plain",
    ].join("|");
    const operationKey = createHash("sha256")
      .update(operationIdentity)
      .digest("hex");
    const staleLockPath = path.join(harness.lockDir, `${operationKey}.lock`);
    await fs.mkdir(harness.lockDir, { recursive: true });
    await fs.symlink("2147483647|stale process", staleLockPath);

    const results = await Promise.all([harness.run(), harness.run()]);

    expect(results.map((result) => result.stdout)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Uploaded artifact"),
        expect.stringContaining("Reused matching artifact from this run"),
      ]),
    );
    expect(await fs.readFile(path.join(harness.stateDir, "upload-count"), "utf8")).toBe("1");
    await expect(fs.lstat(staleLockPath)).rejects.toThrow();
  });

  it("accepts PAPERCLIP_API_URL with an existing trailing API path", async () => {
    const harness = await makeArtifactHelperHarness(cleanupDirs, {
      apiUrl: "http://paperclip.invalid/api/",
    });

    await harness.run();

    const requestLog = await fs.readFile(
      path.join(harness.stateDir, "request-log"),
      "utf8",
    );
    expect(requestLog).toContain(
      "GET http://paperclip.invalid/api/issues/issue-1/attachments",
    );
    expect(requestLog).not.toContain("/api/api/");
  });

  it("does not describe an ordinary artifact upload as prepared for provider delivery", async () => {
    const harness = await makeArtifactHelperHarness(cleanupDirs);

    const result = await harness.run();

    expect(result.stdout).toContain("Uploaded artifact");
    expect(result.stdout).not.toContain("provider delivery");
    expect(result.stdout).not.toContain("bound for delivery");
  });

  it("documents governed agent interaction resolution invariants", async () => {
    const apiReference = await fs.readFile(path.resolve("skills/paperclip/references/api-reference.md"), "utf8");
    const issueDocs = await fs.readFile(path.resolve("docs/api/issues.md"), "utf8");
    for (const body of [apiReference, issueDocs]) {
      expect(body).toContain('resolverPolicy: "anyone" | "not_creator" | "human_only"');
      expect(body).toContain("requestedResolverPolicy");
      expect(body).toContain("effectiveResolverPolicy");
      expect(body).toContain("toolAction");
      expect(body).toContain("watchdog");
      expect(body).toContain("low-trust");
      expect(body).toContain("addresseeAgentId");
      expect(body).toContain("interaction_pending");
      expect(body).toContain("attention feed");
    }
  });

  it("uses the authoritative PATCH response to confirm monitor scheduling", async () => {
    const skillBody = await fs.readFile(path.resolve("skills/paperclip/SKILL.md"), "utf8");

    expect(skillBody).toContain("Use that request's default full response");
    expect(skillBody).toContain("do not issue a confirming GET");
    expect(skillBody).toContain("`monitorNextCheckAt` is non-null");
    expect(skillBody).toContain("`assigneeAgentId` is set");
    expect(skillBody).toContain("`assigneeUserId` is null");
  });

  it("requires issue-update writes to be verified, not inferred", async () => {
    const skillBody = await fs.readFile(path.resolve("skills/paperclip/SKILL.md"), "utf8");

    expect(skillBody).toContain("Verify writes — never infer them");
    expect(skillBody).toContain("An empty response body means the write FAILED");
    expect(skillBody).toContain("Never pipe a disposition write through `head`/`tail`");
    // The helper's verification behavior (HTTP status parsing, retry
    // classification, attempt bound, exit codes) is exercised end-to-end in
    // paperclip-issue-update-helper.test.ts against a live local server.
  });

  it("keeps the create-issue-interaction-ui guide as a maintainer-only skill", async () => {
    const skillPath = path.resolve(".agents/skills/create-issue-interaction-ui/SKILL.md");
    const skillBody = await fs.readFile(skillPath, "utf8");
    const normalizedSkillBody = skillBody.replace(/\s+/g, " ");
    const normalizedLowerSkillBody = normalizedSkillBody.toLowerCase();

    expect(skillBody).toContain("name: create-issue-interaction-ui");
    expect(normalizedLowerSkillBody).toContain("developer/maintainer skill");
    expect(normalizedLowerSkillBody).toContain(
      "not the operational agents that run inside a deployed paperclip company",
    );
    expect(skillBody).toContain("packages/shared/src/constants.ts");
    expect(skillBody).toContain("server/src/services/issue-thread-interactions.ts");
    expect(skillBody).toContain("ui/src/components/IssueThreadInteractionCard.tsx");
    expect(skillBody).toContain("packages/plugins/sdk/src/testing.ts");
    await expect(fs.access(path.resolve("skills/create-issue-interaction-ui/SKILL.md"))).rejects.toThrow();
  });

  it("removes stale maintainer-only symlinks from a shared skills home", async () => {
    const root = await makeTempDir("paperclip-skill-cleanup-");
    cleanupDirs.add(root);

    const skillsHome = path.join(root, "skills-home");
    const runtimeSkill = path.join(root, "skills", "paperclip");
    const customSkill = path.join(root, "custom", "release-notes");
    const staleMaintainerSkill = path.join(root, ".agents", "skills", "release");

    await fs.mkdir(skillsHome, { recursive: true });
    await fs.mkdir(runtimeSkill, { recursive: true });
    await fs.mkdir(customSkill, { recursive: true });

    await fs.symlink(runtimeSkill, path.join(skillsHome, "paperclip"));
    await fs.symlink(customSkill, path.join(skillsHome, "release-notes"));
    await fs.symlink(staleMaintainerSkill, path.join(skillsHome, "release"));

    const removed = await removeMaintainerOnlySkillSymlinks(skillsHome, ["paperclip"]);

    expect(removed).toEqual(["release"]);
    await expect(fs.lstat(path.join(skillsHome, "release"))).rejects.toThrow();
    expect((await fs.lstat(path.join(skillsHome, "paperclip"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(skillsHome, "release-notes"))).isSymbolicLink()).toBe(true);
  });
});
