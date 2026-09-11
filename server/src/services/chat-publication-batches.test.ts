import { describe, expect, it } from "vitest";
import type { ChatPublicationSummary } from "@paperclipai/shared";
import {
  chatFileTransferResolutionActions,
  projectChatFileTransfer,
  projectChatPublicationBatch,
  type ChatFileTransferProjection,
} from "./chat-publication-batches.js";

const part = (
  id: string,
  state: ChatPublicationSummary["state"],
): ChatPublicationSummary => ({
  id,
  state,
  attempts: 1,
});
const transfer = (
  patch: Partial<ChatFileTransferProjection> = {},
): ChatFileTransferProjection => ({
  publicationId: "file",
  phase: "awaiting_consent",
  version: 2,
  filename: "report.txt",
  expiresAt: new Date("2026-09-10T00:00:00Z"),
  consentMessageId: "offer-1",
  responseActivityId: null,
  fileInfoMessageId: null,
  operatorConfirmed: false,
  ...patch,
});

describe("truthful file publication batch projections", () => {
  it.each([
    ["consent_pending", "pending"],
    ["consent_sending", "streaming"],
    ["consent_unknown", "delivery_unknown"],
    ["awaiting_consent", "awaiting_consent"],
    ["upload_pending", "pending"],
    ["uploading", "streaming"],
    ["upload_unknown", "delivery_unknown"],
    ["file_info_pending", "pending"],
    ["file_info_sending", "streaming"],
    ["file_info_unknown", "delivery_unknown"],
    ["conflict", "delivery_unknown"],
    ["expired", "cancelled"],
    ["cancelled", "cancelled"],
  ] as const)(
    "projects %s without calling a card or upload delivered",
    (phase, expected) => {
      const projected = projectChatFileTransfer(
        part("file", "published"),
        transfer({ phase }),
      );
      expect(projected.state).toBe(expected);
      expect(projectChatPublicationBatch([projected]).published).toBe(0);
    },
  );

  it("counts delivered, declined, expired and cancelled parts separately", () => {
    const mapped = (id: string, phase: string) =>
      projectChatFileTransfer(
        part(id, "pending"),
        transfer({
          publicationId: id,
          phase,
          fileInfoMessageId: phase === "delivered" ? "file-1" : null,
          responseActivityId: phase === "declined" ? "decline-1" : null,
        }),
      );
    const parts = [
      part("text", "published"),
      mapped("file", "delivered"),
      mapped("declined", "declined"),
      mapped("expired", "expired"),
      mapped("cancelled", "cancelled"),
    ];
    expect(projectChatPublicationBatch(parts)).toMatchObject({
      parts,
      total: 5,
      published: 2,
      declined: 1,
      expired: 1,
      cancelled: 1,
      settled: 5,
      awaitingConsent: 0,
      canDismiss: true,
      publication: { id: "declined", state: "cancelled" },
    });
  });

  it("does not let a cancelled head hide a waiting tail", () => {
    const waiting = projectChatFileTransfer(
      part("file", "pending"),
      transfer(),
    );
    expect(
      projectChatPublicationBatch([part("head", "cancelled"), waiting]),
    ).toMatchObject({
      publication: waiting,
      total: 2,
      settled: 1,
      cancelled: 1,
      published: 0,
      awaitingConsent: 1,
      canDismiss: false,
    });
  });

  it.each([
    "pending",
    "streaming",
    "retry",
    "failed",
    "delivery_unknown",
    "awaiting_consent",
  ] as const)(
    "does not dismiss a batch with an unresolved %s part",
    (state) => {
      expect(
        projectChatPublicationBatch([
          part("done", "published"),
          part("pending", state),
        ]),
      ).toMatchObject({ published: 1, settled: 1, canDismiss: false });
    },
  );

  it.each([
    { phase: "delivered" },
    { phase: "awaiting_consent", consentMessageId: null },
    { phase: "declined", responseActivityId: null },
  ])("requires a distinct receipt for terminal/waiting claims %#", (patch) => {
    const result = projectChatFileTransfer(
      part("file", "published"),
      transfer(patch),
    );
    expect(result.state).toBe("delivery_unknown");
    expect(projectChatPublicationBatch([result])).toMatchObject({
      published: 0,
      settled: 0,
      canDismiss: false,
    });
    expect(chatFileTransferResolutionActions(result)).toEqual([]);
  });

  it("represents an operator-confirmed file-info receipt without inventing a provider message ID", () => {
    const projected = projectChatFileTransfer(
      part("file", "delivery_unknown"),
      transfer({
        phase: "delivered",
        operatorConfirmed: true,
      }),
    );
    expect(projected.state).toBe("published");
    expect(projected).not.toHaveProperty("providerMessageId");
    expect(projectChatPublicationBatch([projected]).canDismiss).toBe(true);
  });

  it.each([
    { phase: "toString" },
    { version: 0 },
    { version: NaN },
    { publicationId: "other" },
    { expiresAt: new Date(NaN) },
    { filename: "" },
  ])("fails closed on malformed transfer proof %#", (patch) => {
    expect(
      projectChatFileTransfer(part("file", "published"), transfer(patch)),
    ).toMatchObject({ state: "delivery_unknown" });
  });

  it("does not dismiss duplicate or contradictory parts", () => {
    const same = part("same", "published");
    expect(projectChatPublicationBatch([same, same]).canDismiss).toBe(false);
    const waiting = projectChatFileTransfer(
      part("file", "pending"),
      transfer(),
    );
    expect(
      projectChatPublicationBatch([{ ...waiting, state: "cancelled" }])
        .canDismiss,
    ).toBe(false);
  });

  it("keeps capability metadata out of every public projection", () => {
    const privateInput = {
      ...transfer(),
      privateState: { url: "CAPABILITY-CANARY", token: "TOKEN-CANARY" },
    };
    const result = projectChatFileTransfer(
      part("file", "pending"),
      privateInput,
    );
    expect(result.fileTransfer).toEqual({
      provider: "microsoft-teams",
      phase: "awaiting_consent",
      filename: "report.txt",
      expiresAt: "2026-09-10T00:00:00.000Z",
      version: 2,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /CANARY|privateState|consentMessageId/,
    );
  });

  it.each(["consent_unknown", "upload_unknown"])(
    "never offers generic delivery or resend for %s",
    (phase) => {
      const projected = projectChatFileTransfer(
        part("file", "delivery_unknown"),
        transfer({ phase }),
      );
      expect(chatFileTransferResolutionActions(projected)).toEqual(["cancel"]);
    },
  );
  it("offers audited file-info actions only at that exact final stage", () => {
    const projected = projectChatFileTransfer(
      part("file", "delivery_unknown"),
      transfer({ phase: "file_info_unknown" }),
    );
    expect(chatFileTransferResolutionActions(projected)).toEqual([
      "mark_delivered",
      "retry_anyway",
      "cancel",
    ]);
    expect(
      chatFileTransferResolutionActions(part("legacy", "delivery_unknown")),
    ).toEqual([]);
    expect(
      chatFileTransferResolutionActions(
        projectChatFileTransfer(
          part("file", "delivery_unknown"),
          transfer({ phase: "conflict" }),
        ),
      ),
    ).toEqual([]);
  });

  it("offers only cancellation for an exact independently verified conflict version", () => {
    const projected = projectChatFileTransfer(
      part("file", "delivery_unknown"),
      transfer({ phase: "conflict", version: 7 }),
    );
    expect(
      chatFileTransferResolutionActions(projected, {
        publicationId: "file",
        version: 7,
      }),
    ).toEqual(["cancel"]);
    for (const proof of [
      undefined,
      { publicationId: "other", version: 7 },
      { publicationId: "file", version: 6 },
    ])
      expect(chatFileTransferResolutionActions(projected, proof)).toEqual([]);
    expect(
      chatFileTransferResolutionActions(
        { ...projected, state: "published" },
        { publicationId: "file", version: 7 },
      ),
    ).toEqual([]);
  });
});
