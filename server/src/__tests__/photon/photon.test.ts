import { describe, it, expect, vi } from "vitest";
import { Client, Server, ServerCredentials, credentials } from "@grpc/grpc-js";
import { IMessageError } from "@photon-ai/advanced-imessage";
import type { AskUserQuestionsInteraction } from "@paperclipai/shared";
import {
  PhotonCloudClient,
  PhotonLineAuthentication, photonSharedIdentity, photonSharedScope,
  PhotonError,
  photonFailure,
} from "../../services/photon/cloud.js";
import { PhotonReceiver } from "../../services/photon/receiver.js";
import {
  PhotonChatAdapter,
  splitPhotonText,
} from "../../services/photon/adapter.js";
import { PhotonState } from "../../services/photon/state.js";
import {
  photonCatchUpRequest,
  photonEnvelopeSequence,
  decodePhotonRecoveryFrame,
  PhotonRecoveryTransport,
  PHOTON_CATCHUP_PATH,
} from "../../services/photon/recovery-transport.js";
import {
  publishPhotonPrompt,
  parsePhotonQuestionAnswer,
  photonResponseCommand,
} from "../../services/photon/interactions.js";
import { photonFixture, photonEvent, stream } from "./fixture.js";
import {
  downloadPhotonAttachment,
  takePhotonCompanion,
} from "../../services/photon/attachments.js";
import {
  photonHeifPreview,
  validateHeifDimensions,
  validatePhotonImage,
} from "../../services/photon/media.js";
import sharp from "sharp";
import { readFile } from "node:fs/promises";

const question = (id = "interaction"): AskUserQuestionsInteraction =>
  ({
    id,
    kind: "ask_user_questions",
    payload: {
      questions: [
        {
          id: "q1",
          prompt: "Same title",
          options: [
            { id: "a", label: "Same" },
            { id: "b", label: "Same" },
          ],
          selectionMode: "single",
          allowOther: false,
          required: true,
        },
      ],
    },
  }) as AskUserQuestionsInteraction;
const guard = async () => {};

describe("Photon Cloud and fixed line identity", () => {
  it("uses Basic project auth, verifies dedicated allocation, and never exposes tokens", async () => {
    const fetcher = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toMatch(
          /^https:\/\/spectrum.photon.codes\/projects\/p\//,
        );
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Basic ${Buffer.from("p:secret").toString("base64")}`,
        );
        return Response.json({
          succeed: true,
          data: String(url).endsWith("tokens")
            ? {
                type: "dedicated",
                auth: { one: "TOKEN", two: "TOKEN2" },
                numbers: { one: "+15555550100", two: "+15555550102" },
                expiresIn: 300,
              }
            : { id: "p", name: "Project" },
        });
      },
    );
    const result = await new PhotonCloudClient(fetcher).inspect("p", "secret");
    expect(result.lines).toHaveLength(2);
    expect(JSON.stringify(result)).not.toMatch(/TOKEN|secret/);
  });
  it("rejects credentials and missing dedicated lines while inspecting shared DMs without exposing tokens", async () => {
    const client = new PhotonCloudClient(
      async () => new Response("secret=BAD", { status: 401 }),
    );
    await expect(client.inspect("p", "secret")).rejects.toMatchObject({
      code: "credentials",
    });
    const shared = new PhotonCloudClient(async () =>
      Response.json({
        succeed: true,
        data: { type: "shared", token: "PRIVATE", expiresIn: 300 },
      }),
    );
    expect(await shared.inspect("p", "secret")).toMatchObject({
      eligible: true,
      allocation: "shared",
      lines: [],
    });
    const missing = new PhotonCloudClient(async () =>
      Response.json({
        succeed: true,
        data: { type: "dedicated", auth: {}, numbers: {}, expiresIn: 300 },
      }),
    );
    expect(await missing.inspect("p", "secret")).toMatchObject({
      eligible: false,
      lines: [],
    });
  });
  it("binds shared gateway tokens to one project and fences renewal and group access", async () => {
    let now = 0;
    const cloud = new PhotonCloudClient();
    const allocation = vi.spyOn(cloud, "allocation").mockResolvedValue({
      inspection: {projectId: "p", projectName: "Shared", allocation: "shared", eligible: true, lines: []},
      tokens: new Map(), sharedToken: "first", expiresIn: 60,
    });
    const identity = {allocation: "shared" as const, projectId: "p", lineId: photonSharedScope("p"), phoneNumber: photonSharedIdentity("p")};
    const auth = new PhotonLineAuthentication(identity, "secret", cloud, () => now);
    expect(auth.address).toBe("imessage.spectrum.photon.codes:443");
    await expect(auth.token()).resolves.toBe("first");
    expect(photonSharedScope("other")).not.toBe(identity.lineId);
    expect(() => new PhotonLineAuthentication({...identity, projectId: "other"}, "secret", cloud)).toThrow(/match its project/);
    const f = photonFixture();
    const adapter = new PhotonChatAdapter("Shared", auth, f.state, f.adapter.client);
    expect(() => adapter.encodeThreadId({lineId: identity.lineId, chatGuid: "group", isGroup: true})).toThrow(/direct messages only/);
    expect(() => adapter.decodeThreadId(`imessage-photon:${identity.lineId}:g:Z3JvdXA`)).toThrow(/direct messages only/);
    now = 60_000;
    allocation.mockResolvedValueOnce({inspection: {projectId:"p", projectName:"Moved", allocation:"dedicated", eligible:true, lines:[]}, tokens:new Map(), expiresIn:60});
    await expect(auth.token()).rejects.toMatchObject({code:"line_unavailable"});
  });
  it("renews only the selected line and refuses replacement identity or retired ownership", async () => {
    const f = photonFixture();
    await expect(f.authentication.token()).resolves.toBe("private-line-token");
    f.authentication.retire();
    await expect(f.authentication.token()).rejects.toMatchObject({
      code: "credentials",
    });
    const other = photonFixture();
    other.allocation.mockResolvedValueOnce({
      inspection: {
        projectId: "project",
        projectName: "Test",
        allocation: "dedicated",
        eligible: true,
        lines: [
          { lineId: "line", phoneNumber: "+15555550999", eligible: true },
        ],
      },
      tokens: new Map([["line", "TOKEN"]]),
      expiresIn: 60,
    });
    await expect(other.authentication.token()).rejects.toMatchObject({
      code: "line_unavailable",
    });
  });
});

describe("Photon publication receipts", () => {
  it("keeps Unicode and paragraph order and reuses immutable receipts across restart", async () => {
    const f = photonFixture();
    const text = "😀".repeat(3999) + "\n\n" + "tail";
    expect(splitPhotonText(text).join("")).toBe(text);
    expect(
      splitPhotonText(text).every((part) => Array.from(part).length <= 4000),
    ).toBe(true);
    const first = await f.adapter.publish(
      f.threadId,
      "pub",
      { markdown: text },
      { assertCurrent: guard },
    );
    const restarted = new PhotonChatAdapter(
      "Agent",
      f.authentication,
      new PhotonState(f.state.scope, f.persistence),
      f.adapter.client,
    );
    expect(
      await restarted.publish(
        f.threadId,
        "pub",
        { markdown: text },
        { assertCurrent: guard },
      ),
    ).toEqual(first);
    expect(f.client.messages.sendText).toHaveBeenCalledTimes(2);
    await expect(
      restarted.publish(
        f.threadId,
        "pub",
        { markdown: "changed" },
        { assertCurrent: guard },
      ),
    ).rejects.toThrow("payload changed");
  });
  it("holds an unknown send until explicit retry and reuses the same key", async () => {
    const f = photonFixture();
    const original = f.client.messages.sendText.getMockImplementation()!;
    f.client.messages.sendText.mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error("socket closed after send");
    });
    await expect(
      f.adapter.publish(f.threadId, "pub", "hello", { assertCurrent: guard }),
    ).rejects.toMatchObject({ code: "delivery_unknown" });
    await expect(
      f.adapter.publish(f.threadId, "pub", "hello", { assertCurrent: guard }),
    ).rejects.toMatchObject({ code: "delivery_unknown" });
    expect(f.client.messages.sendText).toHaveBeenCalledTimes(1);
    await f.adapter.publish(f.threadId, "pub", "hello", {
      assertCurrent: guard,
      retryUnknown: true,
    });
    expect(f.receipts.size).toBe(1);
    expect(f.client.messages.sendText.mock.calls[0][2]).toEqual(
      f.client.messages.sendText.mock.calls[1][2],
    );
  });
  it("stores an upload before a failed send and never uploads it twice", async () => {
    const f = photonFixture();
    f.client.messages.sendAttachment.mockRejectedValueOnce(
      new Error("lost receipt"),
    );
    const message = {
      markdown: "",
      files: [{ filename: "photo.png", data: Buffer.from("data") }],
    };
    await expect(
      f.adapter.publish(f.threadId, "filepub", message, {
        assertCurrent: guard,
      }),
    ).rejects.toMatchObject({ code: "delivery_unknown" });
    await f.adapter.publish(f.threadId, "filepub", message, {
      assertCurrent: guard,
      retryUnknown: true,
    });
    expect(f.client.attachments.upload).toHaveBeenCalledTimes(1);
  });
  it("retains unknown delivery when the shared gateway rejects a duplicate without a receipt", async () => {
    const f = photonFixture();
    f.client.messages.sendText.mockRejectedValueOnce(new Error("lost receipt"));
    await expect(f.adapter.publish(f.threadId, "duplicate", "hello", {
      assertCurrent: guard,
    })).rejects.toMatchObject({ code: "delivery_unknown" });
    // Observed on Photon Pro: ALREADY_EXISTS arrives as internalError, without
    // a message GUID. Neither the wording nor duplicate status proves a receipt.
    f.client.messages.sendText.mockRejectedValueOnce(new IMessageError(
      "[upstream] Operation already processed with this client message ID",
      { code: "internalError", grpcCode: 6, retryable: false },
    ));
    await expect(f.adapter.publish(f.threadId, "duplicate", "hello", {
      assertCurrent: guard, retryUnknown: true,
    })).rejects.toMatchObject({ code: "delivery_unknown" });
    await expect(f.adapter.publish(f.threadId, "duplicate", "hello", {
      assertCurrent: guard,
    })).rejects.toMatchObject({ code: "delivery_unknown" });
    expect(f.client.messages.sendText).toHaveBeenCalledTimes(2);
    expect(f.client.messages.sendText.mock.calls[0][2]).toEqual(
      f.client.messages.sendText.mock.calls[1][2],
    );
  });
  it("distinguishes explicit quota errors and rechecks authorization between parts", async () => {
    const f = photonFixture();
    f.client.messages.sendText.mockRejectedValueOnce(
      new IMessageError("secret upstream text", {
        code: "dailyLimitExceeded",
        grpcCode: 8,
        retryable: true,
        retryAfter: 12345,
      }),
    );
    await expect(
      f.adapter.publish(f.threadId, "quota", "hello", { assertCurrent: guard }),
    ).rejects.toMatchObject({ code: "quota", retryAfterMs: 12345 });
    await f.adapter.publish(f.threadId, "quota", "hello", {
      assertCurrent: guard,
    });
    let calls = 0;
    await expect(
      f.adapter.publish(f.threadId, "parts", "x".repeat(9000), {
        assertCurrent: async () => {
          if (++calls === 2) throw new Error("revoked");
        },
      }),
    ).rejects.toThrow("revoked");
    expect(f.client.messages.sendText).toHaveBeenCalledTimes(3);
  });
});

describe("Photon durable event recovery", () => {
  it("records preceding events, deduplicates, and does not checkpoint an unadmitted event", async () => {
    const f = photonFixture();
    const events = [photonEvent(1), photonEvent(2)];
    let crash = true;
    const admitted = vi.fn(async (event) => {
      if (event.sequence === 2 && crash) throw new Error("crash");
    });
    const receiver = new PhotonReceiver({
      client: f.adapter.client,
      state: f.state,
      lineId: "line",
      intakeAfter: 0,
      assertOwned: guard,
      admit: admitted,
      failure: guard,
      catchUp: () =>
        stream([...events, { type: "catchup.complete", headSequence: 2 }]),
    });
    await expect(receiver.catchUp()).rejects.toThrow("crash");
    expect(await f.state.read("checkpoint")).toMatchObject({ sequence: 1 });
    crash = false;
    await receiver.catchUp();
    expect(await f.state.read("checkpoint")).toMatchObject({ sequence: 2 });
    expect(admitted.mock.calls.map(([event]) => event.sequence)).toEqual([
      1, 2, 2,
    ]);
  });
  it("advances irrelevant frames and cutoff history, and stops at genuine gaps or lost leases", async () => {
    const f = photonFixture();
    const admit = vi.fn();
    const receiver = new PhotonReceiver({
      client: f.adapter.client,
      state: f.state,
      lineId: "line",
      intakeAfter: Date.now() + 1000,
      assertOwned: guard,
      admit,
      failure: guard,
      catchUp: () =>
        stream([
          photonEvent(10),
          { type: "photon.ignored", sequence: 11 },
          { type: "catchup.complete", headSequence: 11 },
        ]),
    });
    await receiver.catchUp();
    expect(admit).not.toHaveBeenCalled();
    expect(await f.state.read("checkpoint")).toMatchObject({ sequence: 11 });
    const gap = new PhotonReceiver({
      client: f.adapter.client,
      state: f.state,
      lineId: "line",
      intakeAfter: 0,
      assertOwned: guard,
      admit,
      failure: guard,
      catchUp: () =>
        stream([
          photonEvent(13),
          { type: "catchup.complete", headSequence: 13 },
        ]),
    });
    await expect(gap.catchUp()).rejects.toMatchObject({ code: "history_gap" });
    const lost = new PhotonReceiver({
      client: f.adapter.client,
      state: f.state,
      lineId: "line",
      intakeAfter: 0,
      assertOwned: async () => {
        throw new Error("lease lost");
      },
      admit,
      failure: guard,
    });
    await expect(lost.catchUp()).rejects.toThrow("lease lost");
    expect(admit).not.toHaveBeenCalled();
  });
  it("recovers sparse shared-project sequences and commits only a complete ordered replay", async () => {
    const f = photonFixture();
    const admit = vi.fn(guard);
    await f.state.update("checkpoint", () => ({schema:1, lineId:"line", sequence:0}));
    let events: any[] = [photonEvent(1_008_648_034), {type:"catchup.complete",headSequence:1_008_648_034}];
    const receiver = new PhotonReceiver({client:f.adapter.client,state:f.state,lineId:"line",allocation:"shared",intakeAfter:0,assertOwned:guard,admit,failure:guard,catchUp:()=>stream(events)});
    await receiver.catchUp();
    expect(admit).toHaveBeenCalledTimes(1);
    expect(await f.state.read("checkpoint")).toMatchObject({sequence:1_008_648_034});
    events=[photonEvent(1_008_648_090),photonEvent(1_008_648_080),{type:"catchup.complete",headSequence:1_008_648_090}];
    await expect(receiver.catchUp()).rejects.toThrow(/out of order/);
    expect(await f.state.read("checkpoint")).toMatchObject({sequence:1_008_648_034});
    events=[photonEvent(1_008_648_080)];
    await expect(receiver.catchUp()).rejects.toMatchObject({code:"network"});
    expect(await f.state.read("checkpoint")).toMatchObject({sequence:1_008_648_034});
    events=[{type:"catchup.complete",headSequence:0}];
    await expect(receiver.catchUp()).rejects.toMatchObject({code:"history_gap"});
  });
  it("reads sequence-only and complete frames over authenticated synthetic gRPC", async () => {
    const f = photonFixture();
    const server = new Server();
    server.addService(
      {
        catchUp: {
          path: PHOTON_CATCHUP_PATH,
          requestStream: false,
          responseStream: true,
          requestSerialize: (b: Buffer) => b,
          requestDeserialize: (b: Buffer) => b,
          responseSerialize: (b: Buffer) => b,
          responseDeserialize: (b: Buffer) => b,
        },
      },
      {
        catchUp: (call: any) => {
          expect(call.metadata.get("authorization")).toEqual([
            "Bearer private-line-token",
          ]);
          expect(call.request).toEqual(photonCatchUpRequest(2));
          call.write(Buffer.from([8, 3]));
          call.write(Buffer.from([162, 1, 2, 8, 3]));
          call.end();
        },
      },
    );
    const port = await new Promise<number>((resolve, reject) =>
      server.bindAsync(
        "127.0.0.1:0",
        ServerCredentials.createInsecure(),
        (error, port) => (error ? reject(error) : resolve(port)),
      ),
    );
    const transport = new PhotonRecoveryTransport(
      f.authentication,
      new Client(`127.0.0.1:${port}`, credentials.createInsecure()),
    );
    try {
      const result = [];
      for await (const event of transport.catchUp(2)) result.push(event);
      expect(result).toEqual([
        { type: "photon.ignored", sequence: 3 },
        { type: "catchup.complete", headSequence: 3 },
      ]);
    } finally {
      transport.close();
      server.forceShutdown();
    }
  });
  it("keeps state company scoped and rejects corrupt cursor envelopes", async () => {
    const f = photonFixture();
    await f.state.update("checkpoint", () => ({ sequence: 1 }));
    expect(
      await new PhotonState(
        { ...f.state.scope, companyId: "other" },
        f.persistence,
      ).read("checkpoint"),
    ).toBeNull();
    expect(() => photonEnvelopeSequence(Buffer.from([8, 128]))).toThrow();
    expect(() =>
      decodePhotonRecoveryFrame(Buffer.from([8, 1, 8, 2])),
    ).toThrow();
  });
});

describe("Photon native prompts and media", () => {
  it("binds duplicate titles and option labels only by returned IDs across restart", async () => {
    const f = photonFixture();
    const binding = {
      version: 1 as const,
      reference: "referenceA",
      interactionId: "one",
      publicationId: "publication1",
      sessionGeneration: 1,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    const first = await publishPhotonPrompt({
      adapter: f.adapter,
      threadId: f.threadId,
      binding,
      interaction: question("one"),
      questionIndex: 0,
      assertCurrent: guard,
    });
    const second = await publishPhotonPrompt({
      adapter: f.adapter,
      threadId: f.threadId,
      binding: {
        ...binding,
        reference: "referenceB",
        interactionId: "two",
        publicationId: "publication2",
      },
      interaction: question("two"),
      questionIndex: 0,
      assertCurrent: guard,
    });
    expect(first.pollMessageGuid).not.toBe(second.pollMessageGuid);
    expect(Object.values(first.options)).toEqual(["a", "b"]);
    expect(
      await f.state.read(`poll-message:${first.pollMessageGuid}`),
    ).toMatchObject({ reference: "referenceA" });
    await publishPhotonPrompt({
      adapter: f.adapter,
      threadId: f.threadId,
      binding,
      interaction: question("one"),
      questionIndex: 0,
      assertCurrent: guard,
    });
    expect(f.client.polls.create).toHaveBeenCalledTimes(2);
  });
  it("reuses poll clientMessageId after an accepted create loses its local receipt", async () => {
    const f = photonFixture();
    const create = f.client.polls.create.getMockImplementation()!;
    f.client.polls.create.mockImplementationOnce(async (...args) => {
      await create(...args);
      throw new Error("crash");
    });
    const input = {
      adapter: f.adapter,
      threadId: f.threadId,
      binding: {
        version: 1 as const,
        reference: "referenceA",
        interactionId: "one",
        publicationId: "p",
        sessionGeneration: 1,
        expiresAt: new Date().toISOString(),
      },
      interaction: question(),
      questionIndex: 0,
      assertCurrent: guard,
    };
    await expect(publishPhotonPrompt(input)).rejects.toMatchObject({
      code: "delivery_unknown",
    });
    await expect(publishPhotonPrompt(input)).rejects.toMatchObject({
      code: "delivery_unknown",
    });
    await publishPhotonPrompt({ ...input, retryUnknown: true });
    expect(f.polls.size).toBe(1);
  });
  it("validates numbered selection, custom answers, optional skips and explicit references", () => {
    expect(parsePhotonQuestionAnswer(question(), 0, "2")).toEqual({
      questionId: "q1",
      optionIds: ["b"],
    });
    expect(() => parsePhotonQuestionAnswer(question(), 0, "yes")).toThrow();
    expect(() => parsePhotonQuestionAnswer(question(), 0, "1,2")).toThrow();
    expect(photonResponseCommand("yes")).toBeNull();
    expect(
      photonResponseCommand("/answer referenceA.2 custom answer"),
    ).toMatchObject({
      reference: "referenceA",
      questionIndex: 1,
      value: "custom answer",
    });
    const multi = question();
    multi.payload.questions[0].selectionMode = "multi";
    expect(parsePhotonQuestionAnswer(multi, 0, "1,2").optionIds).toEqual([
      "a",
      "b",
    ]);
    multi.payload.questions[0].required = false;
    expect(parsePhotonQuestionAnswer(multi, 0, "skip").optionIds).toEqual([]);
  });
  it("rejects foreign attachment provenance before downloading and bounds decoded images", async () => {
    const f = photonFixture();
    await expect(
      downloadPhotonAttachment(f.adapter.client, "line", {
        kind: "photon_attachment",
        lineId: "other",
        chatGuid: f.chat.guid,
        messageGuid: "m",
        attachmentGuid: "a",
      }),
    ).rejects.toThrow("another line");
    await expect(
      downloadPhotonAttachment(f.adapter.client, "line", {
        kind: "photon_attachment",
        lineId: "line",
        chatGuid: "other",
        messageGuid: "m",
        attachmentGuid: "a",
      }),
    ).rejects.toThrow("does not belong");
    const wrongMessage = await f.client.messages.get("different-message");
    wrongMessage.content.attachments = [{ guid: "a" }] as typeof wrongMessage.content.attachments;
    f.client.messages.get.mockResolvedValueOnce(wrongMessage);
    await expect(downloadPhotonAttachment(f.adapter.client, "line", {
      kind: "photon_attachment",
      lineId: "line",
      chatGuid: f.chat.guid,
      messageGuid: "m",
      attachmentGuid: "a",
    })).rejects.toThrow("does not belong");
    expect(f.client.attachments.downloadStream).not.toHaveBeenCalled();
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    await validatePhotonImage(png, "image/png");
    await expect(validatePhotonImage(png, "image/jpeg")).rejects.toThrow(
      "declared",
    );
    expect(() => validateHeifDimensions(png)).toThrow();
  });
  it("preserves numerical free-text answers for canonical numeric validation", () => {
    const interaction = question();
    interaction.payload.questions[0].allowOther = true;
    interaction.payload.questions[0].options = [
      { id: "number", label: "Enter a number", freeText: true },
    ];
    expect(parsePhotonQuestionAnswer(interaction, 0, "42")).toEqual({
      questionId: "q1",
      optionIds: ["number"],
      otherText: "42",
    });
  });
  it("downloads a shared project alias with a native header UUID only after source ownership is verified", async () => {
    const f = photonFixture();
    const body = Buffer.from("synthetic shared attachment");
    const alias = "spc-att-11111111-1111-4111-8111-111111111111";
    const message = photonEvent(1).message;
    const info = {guid: alias, totalBytes: body.length, fileName: "test.txt", mimeType: "text/plain", isHidden: false, isSticker: false};
    (message.content.attachments as any[]).push(info);
    f.client.messages.get.mockResolvedValue(message);
    const native = {...info, guid: "22222222-2222-4222-8222-222222222222"};
    f.client.attachments.downloadStream.mockImplementation(() => stream([
      {type: "header", info: native}, {type: "primaryChunk", data: body},
    ]));
    const locator = {kind: "photon_attachment" as const, lineId: "line", chatGuid: f.chat.guid, messageGuid: message.guid, attachmentGuid: alias};
    await expect(downloadPhotonAttachment(f.adapter.client, "line", locator)).rejects.toThrow("metadata changed");
    await expect(downloadPhotonAttachment(f.adapter.client, "line", locator, "shared")).resolves.toEqual(body);
    expect(f.client.attachments.downloadStream).toHaveBeenLastCalledWith(alias);
    native.mimeType = "application/octet-stream";
    await expect(downloadPhotonAttachment(f.adapter.client, "line", locator, "shared")).rejects.toThrow("metadata changed");
    f.client.attachments.downloadStream.mockClear();
    await expect(downloadPhotonAttachment(f.adapter.client, "line", {...locator, chatGuid: "wrong-chat"}, "shared")).rejects.toThrow("does not belong");
    expect(f.client.attachments.downloadStream).not.toHaveBeenCalled();
  });
  it("retains source-bound Live Photo companion bytes and waits for incomplete companions", async () => {
    const f = photonFixture();
    const photo = Buffer.from("primary"),
      video = Buffer.from("companion");
    const message = photonEvent(1).message;
    (message.content.attachments as any[]).push({
      guid: "live-photo",
      totalBytes: photo.length,
      isHidden: false,
      isSticker: false,
    });
    f.client.messages.get.mockResolvedValue(message);
    const locator = {
      kind: "photon_attachment" as const,
      lineId: "line",
      chatGuid: f.chat.guid,
      messageGuid: message.guid,
      attachmentGuid: "live-photo",
    };
    const header = {
      type: "header",
      info: { guid: "live-photo", totalBytes: photo.length },
      companionInfo: {
        kind: "live-photo-video",
        mimeType: "video/quicktime",
        fileName: "photo.mov",
        totalBytes: video.length,
      },
    };
    f.client.attachments.downloadStream.mockImplementationOnce(() =>
      stream([header, { type: "primaryChunk", data: photo }]),
    );
    await expect(
      downloadPhotonAttachment(f.adapter.client, "line", locator),
    ).rejects.toMatchObject({ code: "attachment_not_ready" });
    f.client.attachments.downloadStream.mockImplementationOnce(() =>
      stream([
        header,
        { type: "primaryChunk", data: photo },
        { type: "companionChunk", data: video },
      ]),
    );
    const result = await downloadPhotonAttachment(
      f.adapter.client,
      "line",
      locator,
    );
    expect(result).toEqual(photo);
    expect(takePhotonCompanion(result)).toEqual({
      unavailable: false,
      fileName: "photo.mov",
      mimeType: "video/quicktime",
      data: video,
    });
    expect(takePhotonCompanion(result)).toBeUndefined();
  });
  it("converts a real synthetic HEIC with the installed native binary and bounds its dimensions", async () => {
    const heic = await readFile(
      new URL("./fixtures/synthetic.heic", import.meta.url),
    );
    const jpeg = await photonHeifPreview(heic);
    expect(await sharp(jpeg).metadata()).toMatchObject({
      format: "jpeg",
      width: 16,
      height: 16,
    });
    const oversized = Buffer.from(heic);
    const at = oversized.indexOf("ispe");
    expect(at).toBeGreaterThan(0);
    oversized.writeUInt32BE(100_000, at + 8);
    expect(() => validateHeifDimensions(oversized)).toThrow("pixel limit");
  });
});
