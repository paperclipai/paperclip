import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, cp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  publicChatView,
  publicText,
  PUBLIC_CHAT_SCHEMA,
  PUBLIC_CHAT_NOTICE,
} from "./public-eval-chat.mjs";
import {
  publicViewerShell,
  validatePublicChatPayload,
  trustedViewerFiles,
} from "./public-eval-viewer.mjs";
import { validatePublicProtocolEvalReport } from "./publish-runner-protocol-eval-history.mjs";

function artifact() {
  return {
    providerSessionId: "private-session-canary",
    snapshot: {
      networkEvidence: {
        realPaperclipRequests: 0,
        childPaperclipEnvironmentKeys: [],
      },
    },
    issueThread: {
      schema: "paperclip.capability.issue-thread-view.v1",
      issue: { status: "blocked" },
      turns: [
        {
          items: [
            { kind: "user_message", body: "Please block this task." },
            {
              kind: "agent_message",
              body: "Blocked. private-session-canary https://private.example/path",
              privateField: "private-field-canary",
            },
            {
              kind: "tool_activity",
              operationId: "block_task",
              status: "ok",
              input: { secret: "argument-canary" },
              result: { token: "result-canary" },
            },
            { kind: "thinking", body: "reasoning-canary" },
            { kind: "future_kind", body: "future-canary" },
          ],
        },
      ],
    },
  };
}

function payload() {
  return {
    attemptId: "attempt-01",
    caseId: "block-task",
    disposition: "pass",
    passed: true,
    checks: [],
    publication: { schema: PUBLIC_CHAT_SCHEMA, notice: PUBLIC_CHAT_NOTICE },
    view: publicChatView(artifact(), { id: "block-task" }),
    devtools: null,
    navigation: { suiteHref: "../../index.html", previous: null, next: null },
    run: {
      model: "test",
      provider: "test",
      sessionId: "public-report",
      effectiveModelHistory: [],
      managedProfile: null,
      acpxProfile: null,
      usage: null,
    },
  };
}

test("projects only isolated recorded messages and bounded tool facts", () => {
  const view = publicChatView(artifact(), { id: "block-task" });
  assert.equal(view.issue.status, "blocked");
  assert.deepEqual(
    view.turns[0].items.map((item) => item.kind),
    ["user_message", "agent_message", "tool_activity"],
  );
  assert.match(view.turns[0].items[1].body, /Blocked/);
  assert.doesNotMatch(JSON.stringify(view), /canary|private\.example/);
  assert.deepEqual(view.turns[0].items[2].input, {
    detail: "Arguments withheld from public replay.",
  });
  validatePublicChatPayload(payload());
  for (const networkEvidence of [
    undefined,
    { realPaperclipRequests: 1, childPaperclipEnvironmentKeys: [] },
    {
      realPaperclipRequests: 0,
      childPaperclipEnvironmentKeys: ["PAPERCLIP_API_KEY"],
    },
  ]) {
    const source = artifact();
    source.snapshot.networkEvidence = networkEvidence;
    const unavailable = publicChatView(source, { id: "block-task" });
    assert.equal(unavailable.turns[0].items[0].kind, "system_notice");
    assert.doesNotMatch(JSON.stringify(unavailable), /Please block|Blocked\./);
  }
});

test("scrubs credentials and private references before truncating text", () => {
  for (const secret of [
    "sk-" + "a".repeat(32),
    "ghp_" + "b".repeat(32),
    "Bearer abcdef123456",
    "password=secret-canary",
    "/Users/someone/private.txt",
    "arn:aws:service:region:account:resource",
    "-----BEGIN PRIVATE KEY-----\n" +
      "x".repeat(41_000) +
      "\n-----END PRIVATE KEY-----",
  ]) {
    assert.equal(publicText(secret), "[redacted]");
  }
  assert.match(publicText("a".repeat(41_000)), /\[truncated\]$/);
});

test("fails closed on unknown fields, raw tools, private evidence and identities", () => {
  for (const mutate of [
    (p) => {
      p.view.turns[0].items[0].extra = "unprojected";
    },
    (p) => {
      p.view.turns[0].items[2].input = { password: "oops" };
    },
    (p) => {
      p.view.evidence.calls[0].result.detail = "raw-result";
    },
    (p) => {
      p.view.evidence.state.push({ secret: "raw-state" });
    },
    (p) => {
      p.run.providerSessionId = "private-session";
    },
    (p) => {
      p.view.turns[0].items[1].body = "sk-" + "x".repeat(30);
    },
    (p) => {
      p.devtools = {};
    },
    (p) => {
      p.view.composer.state = "ready";
    },
  ]) {
    const value = payload();
    mutate(value);
    assert.throws(() => validatePublicChatPayload(value));
  }
});

test("publisher permits only the exact trusted shell/assets and valid local navigation", async () => {
  const root = await mkdtemp(join(tmpdir(), "eval-chat-contract-"));
  try {
    const viewer = join(root, "trusted");
    const report = join(root, "report");
    await mkdir(join(viewer, "assets"), { recursive: true });
    await mkdir(join(report, "attempts/attempt-01"), { recursive: true });
    const index =
      '<!doctype html><html><head><script type="module" src="./assets/app.js"></script><link rel="stylesheet" href="./assets/app.css"></head><body><div id="root"></div></body></html>';
    await writeFile(join(viewer, "index.html"), index);
    await writeFile(join(viewer, "assets/app.js"), "// trusted build");
    await writeFile(join(viewer, "assets/app.css"), ":root {}");
    await cp(join(viewer, "assets"), join(report, "viewer/assets"), {
      recursive: true,
    });
    await writeFile(
      join(report, "index.html"),
      '<a href="attempts/attempt-01/index.html">PASS</a>',
    );
    await writeFile(
      join(report, "campaign.json"),
      JSON.stringify({
        schema: "paperclip.runner-protocol-eval.campaign/v1",
        campaignId: "gha-42-1",
      }),
    );
    const page = join(report, "attempts/attempt-01/index.html");
    const writePayload = async (value) =>
      writeFile(
        page,
        publicViewerShell(
          index,
          JSON.stringify(value).replaceAll("<", "\\u003c"),
        ),
      );
    await writePayload(payload());
    await validatePublicProtocolEvalReport(report, { viewerRoot: viewer });
    await assert.rejects(validatePublicProtocolEvalReport(report));
    await writeFile(
      join(report, "viewer/assets/app.js"),
      "// substituted build",
    );
    await assert.rejects(
      validatePublicProtocolEvalReport(report, { viewerRoot: viewer }),
      /trusted/,
    );
    await writeFile(join(report, "viewer/assets/app.js"), "// trusted build");
    await writeFile(
      page,
      publicViewerShell(index, JSON.stringify(payload())) +
        "<script>alert(1)</script>",
    );
    await assert.rejects(
      validatePublicProtocolEvalReport(report, { viewerRoot: viewer }),
      /trusted shell/,
    );
    const escaped = payload();
    escaped.view.turns[0].items[0].body =
      '</script><script>alert("not executable")</script>';
    await writePayload(escaped);
    await validatePublicProtocolEvalReport(report, { viewerRoot: viewer });
    const broken = payload();
    broken.navigation.next = {
      label: "Next attempt",
      href: "../missing/index.html",
    };
    await writePayload(broken);
    await assert.rejects(
      validatePublicProtocolEvalReport(report, { viewerRoot: viewer }),
      /link|reference/i,
    );
    await symlink(viewer, join(root, "symlink"));
    await assert.rejects(trustedViewerFiles(join(root, "symlink")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
