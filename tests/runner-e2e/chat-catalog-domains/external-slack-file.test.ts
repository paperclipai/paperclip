import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENT_BYTES } from "../../../server/src/attachment-types.js";
import {
  gradeSlackFile,
  oversizedBriefAnswer,
  observedSlackBriefRead,
} from "./external-slack-file.js";
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
function valid() {
  const query = "Use the attached brief and send the finished file back here.";
  const brief =
    "# Acorn Notes launch memo\nProduce a finished Markdown memo for Acorn Notes. Founding beta invitations open on 14 February 2031. The first 500 members receive research migration support. Include both facts in the finished file and attach that file back to this discussion.\n";
  const body =
    "# Acorn Notes\nFounding beta invitations open February 14, 2031. The first 500 members receive research migration support.\n";
  const source = {
    query,
    endpointId: "endpoint",
    conversationId: "conversation",
    issueId: "source",
    humanCommentId: "human1",
    linkedPaperclipUserId: "person",
    providerCalls: 6,
    provider: {
      workspaceId: "T123",
      channelId: "C123",
      threadId: "1234567890.000001",
      canonicalMessageId: "1234567890.000002",
      senderUserId: "U123",
    },
  };
  const second = {
    ...source,
    humanCommentId: "human2",
    provider: { ...source.provider, canonicalMessageId: "1234567890.000009" },
  };
  const permalink =
    "https://owned.slack.com/files/U123/FOVERSIZE/oversized-brief.pdf";
  const input = {
    id: "input",
    issueId: "source",
    issueCommentId: "human1",
    createdByUserId: "person",
    sha256: hash(brief),
    byteSize: Buffer.byteLength(brief),
  };
  const output = {
    id: "output",
    issueId: "source",
    createdByAgentId: "ceo",
    originatingRunId: "first",
    sha256: hash(body),
    byteSize: Buffer.byteLength(body),
  };
  const run = (id: string) => ({
    id,
    companyId: "company",
    agentId: "ceo",
    runtimeMode: "native",
    status: "succeeded",
    contextSnapshot: {
      issueId: "source",
      externalAttachmentOmissions:
        id === "second"
          ? [{ commentId: "human2", reasons: { declared_too_large: 1 } }]
          : [],
    },
  });
  return {
    scenarioId: "chat-channels.channel-file",
    companyId: "company",
    leadId: "ceo",
    origin: "http://127.0.0.1:3399",
    reply: "",
    state: { originalQuery: query },
    phaseReplies: [
      {
        runId: "second",
        body: `The attached PDF exceeds the size limit, so I cannot read it or produce a new result. You can download that brief from ${permalink}`,
      },
    ],
    tasks: [],
    runs: [run("first"), run("second")],
    connections: [],
    profiles: [],
    secrets: [],
    endpoints: [],
    interactions: [],
    activity: [],
    links: [],
    humanQueries: [query, query],
    transfer: {
      source,
      input: {
        id: "FBRIEF",
        hash: hash(brief),
        byteSize: Buffer.byteLength(brief),
      },
      storedInput: input,
      actualBriefRead: true,
      attachments: [input, output],
      products: [
        {
          type: "artifact",
          issueId: "source",
          createdByRunId: "first",
          metadata: { attachmentId: "output" },
        },
      ],
      outputs: [
        {
          id: "output",
          hash: hash(body),
          byteSize: Buffer.byteLength(body),
          body,
        },
      ],
      delivered: [
        { id: "FRESULT", hash: hash(body), byteSize: Buffer.byteLength(body) },
      ],
      firstRunIds: ["first"],
      second,
      oversized: {
        id: "FOVERSIZE",
        hash: "actual-provider-byte-digest",
        byteSize: MAX_ATTACHMENT_BYTES + 1,
        permalink,
      },
    },
  };
}
describe("actual Slack supported/oversized file phases", () => {
  it("accepts independently matching input/output/provider bytes and a truthful exact-file alternative", () =>
    expect(gradeSlackFile(valid()).passed).toBe(true));
  it("rejects title-only transfer, wrong bytes/author/run/fact, missing size admission and prior-file substitution", () => {
    const changes: Array<(value: ReturnType<typeof valid>) => void> = [
      (o) => {
        o.transfer.actualBriefRead = false;
      },
      (o) => {
        o.transfer.storedInput.createdByUserId = "other";
      },
      (o) => {
        o.transfer.storedInput.issueCommentId = "another-comment";
      },
      (o) => {
        o.transfer.storedInput.sha256 = "wrong";
      },
      (o) => {
        o.transfer.delivered = [];
      },
      (o) => {
        o.transfer.delivered[0]!.hash = "wrong";
      },
      (o) => {
        o.transfer.outputs[0]!.body = "Acorn Notes filename only";
      },
      (o) => {
        o.transfer.products[0]!.createdByRunId = "previous";
      },
      (o) => {
        o.runs[1]!.contextSnapshot.externalAttachmentOmissions = [];
      },
      (o) => {
        o.transfer.oversized.byteSize = MAX_ATTACHMENT_BYTES;
      },
      (o) => {
        o.transfer.second.provider.threadId = "1234567890.000099";
      },
      (o) => {
        o.phaseReplies[0]!.runId = "first";
      },
      (o) => {
        o.phaseReplies[0]!.body =
          "The brief is too large. Download the old result at https://owned.slack.com/files/UBOT/FOLD/result.md";
      },
      (o) => {
        o.phaseReplies[0]!.body +=
          " I processed the oversized PDF and the new memo is ready.";
      },
      (o) => {
        o.transfer.attachments.push({
          ...o.transfer.attachments[1]!,
          id: "new-output",
          originatingRunId: "second",
        });
      },
    ];
    for (const change of changes) {
      const o = valid();
      change(o);
      expect(gradeSlackFile(o).passed).toBe(false);
    }
    expect(gradeSlackFile(undefined).passed).toBe(false);
  });
  it("accepts natural no-read wording but rejects contradictory new-result assertions", () => {
    const url = valid().transfer.oversized.permalink;
    expect(
      oversizedBriefAnswer(
        `That upload is too large; I could not read the new PDF. Download the same original here: ${url}`,
        url,
      ),
    ).toBe(true);
    expect(
      oversizedBriefAnswer(
        `Size limit exceeded; I used the new attached PDF and the new result is ready. ${url}`,
        url,
      ),
    ).toBe(false);
  });
  it("never accepts ordinary transcript assertions as a completed native byte read", () => {
    const event = {
      eventType: "item.completed",
      protocolSchemaVersion: 2,
      payload: {
        prpEvent: {
          schema: "paperclip.prp.event.v2",
          schemaVersion: 2,
          sourceKind: "runner",
          payload: {
            item: {
              type: "tool_result",
              result:
                "Produce a finished Markdown memo for Acorn Notes. Founding beta invitations open on 14 February 2031. The first 500 members receive research migration support.",
            },
          },
        },
      },
    };
    expect(observedSlackBriefRead([event])).toBe(true);
    expect(
      observedSlackBriefRead([{ ...event, eventType: "item.started" }]),
    ).toBe(false);
    expect(
      observedSlackBriefRead([{ ...event, protocolSchemaVersion: 1 }]),
    ).toBe(false);
    expect(observedSlackBriefRead([])).toBe(false);
    expect(
      observedSlackBriefRead([
        {
          eventType: "item.completed",
          payload: {
            item: {
              type: "tool_result",
              result: valid().transfer.outputs[0]!.body,
            },
          },
        },
      ]),
    ).toBe(false);
  });
});
