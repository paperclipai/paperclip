// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { buildSystemNoticeProps, mapCommentMetadataToSystemNoticeSections, systemNoticeMetadataLabelDisplay, systemNoticeMetadataValueDisplay } from "./system-notice-comment";

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("mapCommentMetadataToSystemNoticeSections", () => {
  it("projects the AI repair title and known next action while preserving raw bodies and other metadata", async () => {
    const nextAction = "Reconnect the selected AI account or choose an available connection, then continue the task.";
    const body = "This task paused because its selected AI account is unavailable. Reconnect the account or choose an available connection to continue.";
    const presentation = { kind: "system_notice" as const, title: "AI connection needs attention", tone: "danger" as const, detailsDefaultOpen: false };
    const metadata = { version: 1 as const, sections: [{ title: "Recovery", rows: [
      { type: "key_value" as const, label: "Next action", value: nextAction },
      { type: "key_value" as const, label: "Failure summary", value: nextAction },
      { type: "key_value" as const, label: "Next action", value: "Reconnect Keep English Name using custom settings." },
    ] }] };
    const original = JSON.stringify({ presentation, metadata, body });
    for (const locale of ["en", "ru", "en"]) {
      await i18n.changeLanguage(locale);
      const props = buildSystemNoticeProps({ presentation, metadata, body });
      expect(props.label).toBe(presentation.title);
      expect(props.body).toBe(body);
      expect(systemNoticeMetadataLabelDisplay(props.label!)).toBe(locale === "en" ? presentation.title : "Нужно проверить подключение к сервису ИИ");
      expect(systemNoticeMetadataValueDisplay(props.metadata![0]!.rows[0]!)).toBe(locale === "en" ? nextAction
        : "Повторно подключите выбранную учётную запись сервиса ИИ или выберите доступное подключение, затем продолжите задачу.");
      expect(systemNoticeMetadataValueDisplay(props.metadata![0]!.rows[1]!)).toBe(nextAction);
      expect(systemNoticeMetadataValueDisplay(props.metadata![0]!.rows[2]!)).toBe("Reconnect Keep English Name using custom settings.");
      expect(JSON.stringify({ presentation, metadata, body })).toBe(original);
    }
  });

  it("renders Photon provenance labels without changing metadata keys, reply GUIDs, or user text", async () => {
    const metadata = { version: 1 as const, sourceChannel: "imessage-photon" as const, sections: [{ title: "iMessage Photon sender", rows: [
      { type: "key_value" as const, label: "Reply to message", value: "original-message-guid" },
      { type: "key_value" as const, label: "Reply part", value: "p:0" },
      { type: "key_value" as const, label: "Name", value: "Reply to message" },
      { type: "key_value" as const, label: "Authority", value: "Linked Paperclip user" },
      { type: "key_value" as const, label: "Authority", value: "Sponsored external guest (restricted)" },
      { type: "key_value" as const, label: "Name", value: "Linked Paperclip user" },
      { type: "key_value" as const, label: "Provider ID", value: "imessage:+15555550111" },
    ] }] };
    const original = JSON.stringify(metadata);
    const expected = mapCommentMetadataToSystemNoticeSections(metadata);
    for (const locale of ["en", "ru", "en"]) {
      await i18n.changeLanguage(locale);
      const sections = mapCommentMetadataToSystemNoticeSections(metadata);
      expect(sections).toEqual(expected);
      expect(systemNoticeMetadataLabelDisplay(sections[0]!.title!)).toBe(i18n.t("communityPhoton.senderMetadata"));
      for (const [index, key] of ["replyToMessage", "replyPart"].entries()) {
        expect(systemNoticeMetadataLabelDisplay(sections[0]!.rows[index]!.label)).toBe(i18n.t(`communityPhoton.${key}`));
      }
      expect(systemNoticeMetadataValueDisplay(sections[0]!.rows[0]!)).toBe("original-message-guid");
      expect(systemNoticeMetadataValueDisplay(sections[0]!.rows[1]!)).toBe("p:0");
      expect(systemNoticeMetadataValueDisplay(sections[0]!.rows[2]!)).toBe("Reply to message");
      expect(systemNoticeMetadataValueDisplay(sections[0]!.rows[3]!)).toBe(i18n.t("communityPhoton.linkedUser"));
      expect(systemNoticeMetadataValueDisplay(sections[0]!.rows[4]!)).toBe(i18n.t("communityPhoton.sponsoredGuest"));
      expect(systemNoticeMetadataValueDisplay(sections[0]!.rows[5]!)).toBe("Linked Paperclip user");
      expect(systemNoticeMetadataValueDisplay(sections[0]!.rows[6]!)).toBe("imessage:+15555550111");
      expect(systemNoticeMetadataLabelDisplay("Provider ID")).toBe(i18n.t("communityPhoton.providerId"));
      expect(systemNoticeMetadataLabelDisplay("Authority")).toBe(i18n.t("communityPhoton.authority"));
      expect(systemNoticeMetadataLabelDisplay("Name")).toBe(i18n.t("communityPhoton.senderName"));
      expect(JSON.stringify(metadata)).toBe(original);
    }
  });
  it("maps server metadata row types to SystemNotice rows", () => {
    const sections = mapCommentMetadataToSystemNoticeSections(
      {
        version: 1,
        sections: [
          {
            title: "Required action",
            rows: [
              { type: "issue_link", label: "Source issue", issueId: "i1", identifier: "PAP-3440", title: "Recovery" },
              { type: "agent_link", label: "Responsible", agentId: "agent-1", name: "CodexCoder" },
              { type: "key_value", label: "Status before", value: "in_progress" },
              { type: "code", label: "Cause code", code: "missing_disposition" },
              { type: "text", label: "Notes", text: "Pick a disposition." },
              { type: "run_link", label: "Source run", runId: "9cdba892-c7ca-4d93-8604-4843873b127c", title: "succeeded" },
            ],
          },
        ],
      },
      { runAgentId: "agent-1" },
    );

    expect(sections).toHaveLength(1);
    expect(sections[0]?.title).toBe("Required action");

    const rows = sections[0]!.rows;
    expect(rows).toEqual([
      {
        kind: "issue",
        label: "Source issue",
        identifier: "PAP-3440",
        href: "/issues/PAP-3440",
        title: "Recovery",
      },
      { kind: "agent", label: "Responsible", name: "CodexCoder", href: "/agents/agent-1" },
      { kind: "text", label: "Status before", value: "in_progress" },
      { kind: "code", label: "Cause code", value: "missing_disposition" },
      { kind: "text", label: "Notes", value: "Pick a disposition." },
      {
        kind: "run",
        label: "Source run",
        runId: "9cdba892-c7ca-4d93-8604-4843873b127c",
        href: "/agents/agent-1/runs/9cdba892-c7ca-4d93-8604-4843873b127c",
        status: "succeeded",
      },
    ]);
  });

  it("omits run href when no runAgentId is available", () => {
    const sections = mapCommentMetadataToSystemNoticeSections(
      {
        version: 1,
        sections: [
          {
            rows: [
              { type: "run_link", label: "Run", runId: "abc12345" },
            ],
          },
        ],
      },
      {},
    );

    expect(sections[0]?.rows[0]).toEqual({
      kind: "run",
      label: "Run",
      runId: "abc12345",
      href: undefined,
      status: undefined,
    });
  });

  it("returns an empty array for null metadata", () => {
    expect(mapCommentMetadataToSystemNoticeSections(null)).toEqual([]);
    expect(mapCommentMetadataToSystemNoticeSections(undefined)).toEqual([]);
  });
});

describe("buildSystemNoticeProps", () => {
  it("derives tone, label, and metadata from a system_notice presentation", () => {
    const props = buildSystemNoticeProps({
      presentation: {
        kind: "system_notice",
        tone: "warning",
        title: "Missing disposition",
        detailsDefaultOpen: false,
      },
      metadata: {
        version: 1,
        sections: [
          {
            title: "Required",
            rows: [{ type: "key_value", label: "Status", value: "in_progress" }],
          },
        ],
      },
      body: "Body text",
      runAgentId: "agent-1",
    });

    expect(props.tone).toBe("warning");
    expect(props.label).toBe("Missing disposition");
    expect(props.detailsDefaultOpen).toBe(false);
    expect(props.metadata?.[0]?.rows[0]).toEqual({
      kind: "text",
      label: "Status",
      value: "in_progress",
    });
  });

  it("falls back to neutral tone with default label when presentation is null", () => {
    const props = buildSystemNoticeProps({
      presentation: null,
      metadata: null,
      body: "Hello",
    });

    expect(props.tone).toBe("neutral");
    expect(props.label).toBe("System notice");
    expect(props.metadata).toBeUndefined();
  });

  it("uses the danger default label when presentation lacks a title", () => {
    const props = buildSystemNoticeProps({
      presentation: {
        kind: "system_notice",
        tone: "danger",
        title: null,
        detailsDefaultOpen: true,
      },
      metadata: null,
      body: "boom",
    });

    expect(props.label).toBe("System alert");
    expect(props.detailsDefaultOpen).toBe(true);
  });
});
