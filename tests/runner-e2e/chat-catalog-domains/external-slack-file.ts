import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import type {
  ChatCatalogContext,
  ChatSlackIngressReceipt,
} from "../chat-catalog-contract.js";
import type { IssueAttachment } from "../../../packages/shared/src/types/issue.js";
import type { IssueWorkProduct } from "../../../packages/shared/src/types/work-product.js";
import { MAX_ATTACHMENT_BYTES } from "../../../server/src/attachment-types.js";
import { collectRunEvents } from "../run-observations.js";
import { isValidNativePrpEnvelope } from "../native-event-envelope.js";
import { pollUntil } from "../api.js";
import { privateScanJson } from "./external-secret-scan.js";
import {
  prepareSlackFixture,
  slackCompanionFields,
} from "./external-slack-fixture.js";
import {
  definition,
  checks,
  observeExternal,
  externalObservation,
  verifyRenderedReply,
  type ExternalObservation,
} from "./external-support.js";

const digest = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const brief =
  "# Acorn Notes launch memo\nProduce a finished Markdown memo for Acorn Notes. Founding beta invitations open on 14 February 2031. The first 500 members receive research migration support. Include both facts in the finished file and attach that file back to this discussion.\n";
const row = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export function hasLaunchMemoFacts(body: string) {
  return (
    /Acorn\s+Notes/i.test(body) &&
    /(?:14\s+February\s+2031|February\s+14,?\s+2031|2031-02-14)/i.test(body) &&
    /500\b/.test(body) &&
    /research\s+migration\s+support/i.test(body)
  );
}
/** Only an actual completed native tool result can prove the input bytes were read. */
export function observedSlackBriefRead(events: Record<string, unknown>[]) {
  return events.some((event) => {
    const envelope = row(row(event.payload).prpEvent);
    if (
      !isValidNativePrpEnvelope(envelope, event.protocolSchemaVersion) ||
      envelope.sourceKind !== "runner" ||
      event.eventType !== "item.completed"
    )
      return false;
    const item = row(row(envelope.payload).item);
    const result = JSON.stringify(item.result);
    return (
      item.type === "tool_result" &&
      result.includes("Produce a finished Markdown memo for Acorn Notes.") &&
      hasLaunchMemoFacts(result)
    );
  });
}
interface FileBytes {
  id: string;
  hash: string;
  byteSize: number;
  body?: string;
  permalink?: string;
  messageId?: string;
}
interface Transfer {
  source: ChatSlackIngressReceipt;
  input: FileBytes;
  storedInput?: IssueAttachment;
  actualBriefRead: boolean;
  attachments: IssueAttachment[];
  products: IssueWorkProduct[];
  outputs: FileBytes[];
  delivered: FileBytes[];
  firstRunIds: string[];
  second?: ChatSlackIngressReceipt;
  oversized?: FileBytes;
}
interface Observation extends ExternalObservation {
  transfer?: Transfer;
}
type Fixture = Awaited<ReturnType<typeof prepareSlackFixture>>;
interface PrivateState {
  fixture: Fixture;
  input?: FileBytes;
  oversized?: FileBytes;
  delivered: Map<string, FileBytes>;
  actualBriefRead: boolean;
  firstRunIds: string[];
  firstArtifactIds: string[];
  lastProviderRead: number;
}
const fixtures = new WeakMap<ChatCatalogContext, PrivateState>();
function owned(ctx: ChatCatalogContext) {
  const value = fixtures.get(ctx);
  if (!value) throw new Error("Actual Slack file fixture is missing");
  return value;
}
export function oversizedBriefAnswer(text: string, permalink: string) {
  const clauses = text.split(/[.!?;\n]+|\bbut\b/i);
  const falseRead = clauses.some(
    (clause) =>
      !/\b(?:not|cannot|can't|couldn't|unable|no|never|nothing)\b/i.test(
        clause,
      ) &&
      /\b(?:read|processed|used|converted|finished|completed)\b.*\b(?:new|oversized|large|PDF|second|attached)\b|\b(?:new|second)\s+(?:result|file|memo)\s+(?:is\s+)?(?:ready|finished|complete)/i.test(
        clause,
      ),
  );
  return (
    /too\s+large|size\s+limit|exceeds?[^.!?\n]{0,60}limit|could not[^.!?\n]{0,60}(?:read|download)|cannot[^.!?\n]{0,60}(?:read|download)/i.test(
      text,
    ) &&
    text.includes(permalink) &&
    !falseRead
  );
}
export function gradeSlackFile(value: unknown, supportedOnly = false) {
  const c = checks(),
    o = externalObservation(value) as Observation | undefined,
    t = o?.transfer;
  c.add(
    "actual-file-transfer-observations",
    !!o &&
      !!t &&
      [t.attachments, t.products, t.outputs, t.delivered, t.firstRunIds].every(
        Array.isArray,
      ),
    "Actual author/thread-bound provider bytes, persisted task attachments, native reads and generated publication are required.",
  );
  if (
    !o ||
    !t ||
    ![t.attachments, t.products, t.outputs, t.delivered, t.firstRunIds].every(
      Array.isArray,
    )
  )
    return c.result();
  const input = t.storedInput;
  c.add(
    "supported-inbound-exact-bytes",
    t.source.query === o.state.originalQuery &&
      t.input.hash === digest(brief) &&
      t.input.byteSize === Buffer.byteLength(brief) &&
      input?.issueId === t.source.issueId &&
      input.issueCommentId === t.source.humanCommentId &&
      input.createdByUserId === t.source.linkedPaperclipUserId &&
      input.sha256 === t.input.hash &&
      input.byteSize === t.input.byteSize &&
      t.actualBriefRead,
    "The genuine Slack upload is downloaded independently, admitted under the exact human comment and read through an actual completed native tool result.",
  );
  const output = t.attachments.find(
    (file) =>
      file.createdByAgentId &&
      t.products.some(
        (product) =>
          product.type === "artifact" &&
          product.issueId === file.issueId &&
          product.createdByRunId === file.originatingRunId &&
          product.metadata?.attachmentId === file.id,
      ) &&
      o.runs.some(
        (run) =>
          run.id === file.originatingRunId &&
          run.agentId === file.createdByAgentId &&
          run.contextSnapshot?.issueId === file.issueId &&
          run.status === "succeeded" &&
          (!t.firstRunIds.length || t.firstRunIds.includes(run.id)),
      ) &&
      t.outputs.some(
        (actual) =>
          actual.id === file.id &&
          actual.hash === file.sha256 &&
          actual.byteSize === file.byteSize &&
          !!actual.body &&
          digest(actual.body) === file.sha256 &&
          hasLaunchMemoFacts(actual.body),
      ) &&
      t.delivered.some(
        (actual) =>
          actual.hash === file.sha256 && actual.byteSize === file.byteSize,
      ),
  );
  c.add(
    "generated-file-really-delivered",
    !!output,
    "A real run-attributed inspectable artifact contains the actual brief facts; an independently downloaded app-bot file in the same Slack thread has identical bytes. A filename or link alone cannot pass.",
  );
  const sourceIds = new Set([t.source.issueId]);
  for (const task of o.tasks)
    if (task.parentId === t.source.issueId) sourceIds.add(task.id);
  c.add(
    "only-attributed-native-work",
    o.runs.length >= 1 &&
      o.runs.every(
        (run) =>
          run.companyId === o.companyId &&
          run.runtimeMode === "native" &&
          run.status === "succeeded" &&
          sourceIds.has(String(run.contextSnapshot?.issueId)),
      ),
    "Every measured native belongs to this source or its actual directly delegated task.",
  );
  if (supportedOnly) return c.result();
  const next = t.second,
    oversized = t.oversized;
  const later = o.runs.filter(
    (run) =>
      !t.firstRunIds.includes(run.id) &&
      run.contextSnapshot?.issueId === t.source.issueId,
  );
  const omitted = later.some(
    (run) =>
      Array.isArray(run.contextSnapshot?.externalAttachmentOmissions) &&
      run.contextSnapshot.externalAttachmentOmissions.some(
        (entry: unknown) =>
          row(entry).commentId === next?.humanCommentId &&
          row(row(entry).reasons).declared_too_large === 1,
      ),
  );
  c.add(
    "actual-oversized-upload-is-not-read",
    !!next &&
      next.query === t.source.query &&
      next.issueId === t.source.issueId &&
      next.provider.threadId === t.source.provider.threadId &&
      next.provider.canonicalMessageId !==
        t.source.provider.canonicalMessageId &&
      !!oversized &&
      oversized.byteSize === MAX_ATTACHMENT_BYTES + 1 &&
      !!oversized.permalink &&
      omitted &&
      !t.attachments.some(
        (file) => file.issueCommentId === next.humanCommentId,
      ) &&
      later.length >= 1 &&
      t.attachments
        .filter((file) => file.createdByAgentId)
        .every((file) => t.firstRunIds.includes(file.originatingRunId ?? "")),
    "A second genuine oversized provider file is rejected by the actual intake size gate; no inaccessible brief or new finished result is silently manufactured.",
  );
  c.add(
    "truthful-failure-and-own-download-alternative",
    !!oversized?.permalink &&
      o.phaseReplies.some(
        (reply) =>
          later.some((run) => run.id === reply.runId) &&
          oversizedBriefAnswer(reply.body, oversized.permalink!),
      ),
    "The second actual model phase explains its unavailable oversized brief and links that exact provider-owned file's supported download alternative, never a prior result relabelled as the new result.",
  );
  return c.result();
}

async function dispatch(
  ctx: ChatCatalogContext,
  state: Record<string, unknown>,
  query: string,
  signal: AbortSignal,
  oversized: boolean,
) {
  if (query !== ctx.scenario.query)
    throw new Error("Slack file phase changed canonical query bytes");
  const local = owned(ctx),
    f = local.fixture,
    start = f.provider.receipts.length;
  if (oversized) f.relay.nextFilePhase();
  f.relay.expectCanonical(query, f.threadId);
  const bytes = oversized
    ? Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 32)
    : Buffer.from(brief);
  if (oversized)
    bytes.write("%PDF-1.4\n% Deliberately oversized disposable brief.\n");
  const uploaded = await f.provider.uploadBrief({
    filename: oversized ? "oversized-brief.pdf" : "launch-brief.md",
    bytes,
    query,
    threadId: f.threadId,
    signal,
  });
  const actual = await pollUntil({
    label: "genuine uploaded Slack file and exact canonical human comment",
    deadlineAt: Date.now() + 60000,
    load: () => f.readThread(f.threadId),
    accept: (rows) =>
      rows.some(
        (message) =>
          message.user === f.binding.prerequisites.senderUserId &&
          message.text === query &&
          message.files?.some((file) => file.id === uploaded.id),
      ),
  });
  const message = actual.find(
    (message) =>
      message.user === f.binding.prerequisites.senderUserId &&
      message.text === query &&
      message.files?.some((file) => file.id === uploaded.id),
  )!;
  const independentlyRead = await f.provider.readThreadFile(
    f.threadId,
    uploaded.id,
    "sender",
    oversized ? MAX_ATTACHMENT_BYTES + 1 : 262144,
  );
  if (
    digest(independentlyRead.bytes) !== digest(bytes) ||
    independentlyRead.messageId !== message.ts
  )
    throw new Error(
      "Actual Slack upload bytes or human message identity changed",
    );
  const receipt: FileBytes = {
    id: uploaded.id,
    hash: digest(bytes),
    byteSize: bytes.length,
    permalink: independentlyRead.permalink,
    messageId: message.ts,
  };
  if (oversized) local.oversized = receipt;
  else local.input = receipt;
  await pollUntil({
    label: "genuine signed Slack file delivery",
    deadlineAt: Date.now() + 30000,
    load: async () => f.relay.receipt(),
    accept: (row) => row.canonicalDeliveryCaptured,
  });
  signal.throwIfAborted();
  return f.resolveIngress(
    query,
    message.ts,
    f.provider.receipts.length - start,
  );
}
async function observe(
  ctx: ChatCatalogContext,
  state: Record<string, unknown>,
): Promise<Observation> {
  const o = await observeExternal(ctx, state),
    local = owned(ctx),
    f = local.fixture,
    source = state.slackIngressReceipt as ChatSlackIngressReceipt | undefined;
  if (!source || !local.input) return o;
  const ids = new Set([source.issueId]);
  for (const task of o.tasks)
    if (task.parentId === source.issueId) ids.add(task.id);
  const attachments: IssueAttachment[] = [],
    products: IssueWorkProduct[] = [],
    outputs: FileBytes[] = [];
  for (const id of ids) {
    attachments.push(
      ...(await ctx.input.api.get<IssueAttachment[]>(
        `/api/issues/${id}/attachments`,
      )),
    );
    products.push(
      ...(await ctx.input.api.get<IssueWorkProduct[]>(
        `/api/issues/${id}/work-products`,
      )),
    );
  }
  if (attachments.length > 20)
    throw new Error(
      "Slack file artifact inventory exceeds finite inspection bound",
    );
  for (const file of attachments.filter((file) => file.createdByAgentId)) {
    if (
      file.byteSize > 262144 ||
      !/^(?:text\/(?:plain|markdown)|application\/json)$/.test(file.contentType)
    )
      continue;
    const bytes = await ctx.input.api.getAttachmentContent(file.id);
    outputs.push({
      id: file.id,
      hash: digest(bytes),
      byteSize: bytes.length,
      body: bytes.toString("utf8"),
    });
  }
  if (
    !local.actualBriefRead &&
    o.runs.length &&
    o.runs.every((run) => run.status === "succeeded")
  ) {
    for (const run of o.runs) {
      const events = await collectRunEvents<Record<string, unknown>>(
        (afterSeq) =>
          privateScanJson(
            ctx,
            `/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=1000`,
          ),
      );
      local.actualBriefRead ||= observedSlackBriefRead(events);
    }
  }
  if (
    outputs.length &&
    o.runs.every((run) => run.status === "succeeded") &&
    Date.now() - local.lastProviderRead > 2000
  ) {
    local.lastProviderRead = Date.now();
    const messages = await f.readThread(f.threadId);
    for (const message of messages.filter(
      (message) => message.user === f.binding.prerequisites.botUserId,
    ))
      for (const file of message.files ?? []) {
        if (local.delivered.has(file.id)) continue;
        const actual = await f.provider.readThreadFile(
          f.threadId,
          file.id,
          "bot",
        );
        local.delivered.set(file.id, {
          id: file.id,
          hash: digest(actual.bytes),
          byteSize: actual.byteSize,
          permalink: actual.permalink,
          messageId: actual.messageId,
        });
      }
  }
  return {
    ...o,
    transfer: {
      source,
      input: local.input,
      storedInput: attachments.find(
        (file) => file.issueCommentId === source.humanCommentId,
      ),
      actualBriefRead: local.actualBriefRead,
      attachments,
      products,
      outputs,
      delivered: [...local.delivered.values()],
      firstRunIds: local.firstRunIds,
      second: state.slackUnsupportedIngressReceipt as
        ChatSlackIngressReceipt | undefined,
      oversized: local.oversized,
    },
  };
}
export const slackFileExternalCases = [
  definition(
    "chat-channels.channel-file",
    async (ctx) => {
      const fixture = await prepareSlackFixture(ctx);
      fixtures.set(ctx, {
        fixture,
        delivered: new Map(),
        actualBriefRead: false,
        firstRunIds: [],
        firstArtifactIds: [],
        lastProviderRead: 0,
      });
      return { originalQuery: ctx.scenario.query };
    },
    gradeSlackFile,
    {
      authentication: "human-session",
      journeyKind: "native-slack-thread",
      slackIngress: {
        kind: "native-slack-thread",
        maximumProviderCalls: 20,
        ingressTimeoutMs: 120000,
      },
      expectedRunCount: 6,
      minimumRunCount: 2,
      expectedHumanMessageCount: 2,
      turnTimeoutMs: 120000,
      attemptTimeoutMs: 900000,
      externalInput: { provider: "slack", fields: slackCompanionFields },
      sourceFiles: [
        "chat-catalog-domains/external-slack-file.ts",
        "chat-catalog-domains/external-slack-provider.ts",
        "chat-catalog-domains/external-slack-fixture.ts",
        "chat-catalog-domains/external-slack-relay.ts",
        "chat-catalog-domains/external-fixtures.ts",
        "chat-catalog-domains/external-secret-scan.ts",
        "chat-catalog-domains/external-support.ts",
        "chat-catalog-domains/internal-support.ts",
        "chat-slack-ingress.ts",
        "run-observations.ts",
        "native-event-envelope.ts",
        "../../server/src/attachment-types.ts",
        "../../server/src/services/chat-channels/inbound-attachments.ts",
        "../../server/src/services/chat-channels/inbound/wakeups.ts",
        "../../server/src/services/issue-assignment-wakeup.ts",
        "../../server/src/services/chat-channels/slack/file-receipts.ts",
        "../../server/src/services/chat-channels/outbound-attachments.ts",
        "chat-scenarios/chat-channels.yaml",
      ],
      dispatchSlackQuery: (ctx, state, { query, signal }) =>
        dispatch(ctx, state, query, signal, false),
      async verifySlackSupportedTransfer(ctx, state) {
        const value = await observe(ctx, state),
          grade = gradeSlackFile(value, true);
        if (grade.passed) {
          const local = owned(ctx);
          local.firstRunIds = value.runs.map((run) => run.id);
          local.firstArtifactIds = value
            .transfer!.attachments.filter((file) => file.createdByAgentId)
            .map((file) => file.id);
        }
        return grade;
      },
      dispatchSlackUnsupportedFile: (ctx, state, { query, signal }) =>
        dispatch(ctx, state, query, signal, true),
      observe,
      async verifyResult(ctx, _state, value) {
        await verifyRenderedReply(ctx, value);
        const o = value as Observation,
          t = o.transfer;
        const result = t?.attachments.find((file) =>
          t.outputs.some(
            (actual) =>
              actual.id === file.id &&
              actual.hash === file.sha256 &&
              t.delivered.some((sent) => sent.hash === actual.hash),
          ),
        );
        if (!result || !t?.oversized?.permalink)
          throw new Error(
            "Actual original-thread output and oversized file alternative are missing",
          );
        const page = await ctx.input.page.context().newPage();
        try {
          const pending = page
            .waitForEvent("download", { timeout: 5000 })
            .catch(() => undefined);
          await page
            .goto(new URL(result.contentPath, o.origin).href)
            .catch((error) => {
              if (!/download|ERR_ABORTED/i.test(String(error))) throw error;
            });
          const downloaded = await pending;
          const path = await downloaded?.path();
          const bytes = path
            ? await readFile(path)
            : await ctx.input.api.getAttachmentContent(result.id);
          if (
            digest(bytes) !== result.sha256 ||
            !hasLaunchMemoFacts(bytes.toString("utf8"))
          )
            throw new Error(
              "Public result retrieval differs from the generated and Slack-delivered memo",
            );
          if (!downloaded)
            await expect(page.getByText(/Acorn Notes/).first()).toBeVisible();
        } finally {
          await page.close();
        }
        await expect(
          ctx.input.page
            .locator(
              `[id^="comment-"] a[href=${JSON.stringify(t.oversized.permalink)}]`,
            )
            .first(),
        ).toBeVisible();
        await ctx.input.evidence("chat-catalog-slack-files-visible.json", {
          resultAttachmentId: result.id,
          resultHash: result.sha256,
          oversizedFileId: t.oversized.id,
          alternativeIsExactOversizedFile: true,
        });
      },
      async cleanup(ctx) {
        try {
          await fixtures.get(ctx)?.fixture.cleanup();
        } finally {
          fixtures.delete(ctx);
        }
      },
    },
  ),
];
