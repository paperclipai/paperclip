import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGmailClient } from "./google-client.js";

const mocks = vi.hoisted(() => ({
  OAuth2: vi.fn(),
  setCredentials: vi.fn(),
  gmail: vi.fn(),
  getProfile: vi.fn(),
  threadsList: vi.fn(),
  threadsGet: vi.fn(),
  messagesGet: vi.fn(),
  labelsList: vi.fn(),
  draftsList: vi.fn(),
  draftsGet: vi.fn(),
  draftsCreate: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: mocks.OAuth2,
    },
    gmail: mocks.gmail,
  },
}));

function encode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function resetGoogleapisMock() {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.OAuth2.mockImplementation(function OAuth2(this: { setCredentials: typeof mocks.setCredentials }) {
    this.setCredentials = mocks.setCredentials;
  });
  mocks.gmail.mockReturnValue({
    users: {
      getProfile: mocks.getProfile,
      threads: { list: mocks.threadsList, get: mocks.threadsGet },
      messages: { get: mocks.messagesGet },
      labels: { list: mocks.labelsList },
      drafts: { list: mocks.draftsList, get: mocks.draftsGet, create: mocks.draftsCreate },
    },
  });
}

const credentials = { clientId: "client-id", clientSecret: "client-secret", refreshToken: "refresh-token" };

describe("Gmail API client", () => {
  beforeEach(() => {
    resetGoogleapisMock();
  });

  it("authorizes with an OAuth2 client set up from a refresh token, never performing a consent flow", () => {
    createGmailClient(credentials);
    expect(mocks.OAuth2).toHaveBeenCalledWith("client-id", "client-secret");
    expect(mocks.setCredentials).toHaveBeenCalledWith({ refresh_token: "refresh-token" });
  });

  it("gets the account profile", async () => {
    mocks.getProfile.mockResolvedValueOnce({
      data: { emailAddress: "me@example.test", messagesTotal: 42, threadsTotal: 10 },
    });
    const client = createGmailClient(credentials);
    await expect(client.getProfile()).resolves.toEqual({
      emailAddress: "me@example.test",
      messagesTotal: 42,
      threadsTotal: 10,
    });
    expect(mocks.getProfile).toHaveBeenCalledWith({ userId: "me" });
  });

  it("searches threads and enriches each with From/To/Subject/Date metadata", async () => {
    mocks.threadsList.mockResolvedValueOnce({
      data: { threads: [{ id: "t1", snippet: "hi there" }], nextPageToken: "next-page" },
    });
    mocks.threadsGet.mockResolvedValueOnce({
      data: {
        messages: [{
          payload: {
            headers: [
              { name: "From", value: "a@example.com" },
              { name: "Subject", value: "Hello" },
              { name: "Date", value: "Mon, 1 Jan 2026 00:00:00 +0000" },
            ],
          },
        }],
      },
    });

    const client = createGmailClient(credentials);
    const result = await client.searchThreads({ query: "from:a@example.com", maxResults: 25 });

    expect(mocks.threadsList).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "me", q: "from:a@example.com", maxResults: 25 }),
    );
    expect(result.nextPageToken).toBe("next-page");
    expect(result.threads).toEqual([{
      threadId: "t1",
      snippet: "hi there",
      from: "a@example.com",
      to: null,
      subject: "Hello",
      date: "Mon, 1 Jan 2026 00:00:00 +0000",
    }]);
  });

  it("gets a message with its plain-text body and attachment filenames", async () => {
    mocks.messagesGet.mockResolvedValueOnce({
      data: {
        id: "m1",
        threadId: "t1",
        snippet: "snippet",
        payload: {
          headers: [{ name: "Subject", value: "Report" }],
          parts: [
            { mimeType: "text/plain", body: { data: encode("body text") } },
            { mimeType: "application/pdf", filename: "report.pdf", body: { attachmentId: "a1" } },
          ],
        },
      },
    });

    const client = createGmailClient(credentials);
    const message = await client.getMessage("m1");

    expect(message.subject).toBe("Report");
    expect(message.body).toBe("body text");
    expect(message.attachmentFilenames).toEqual(["report.pdf"]);
  });

  it("lists labels", async () => {
    mocks.labelsList.mockResolvedValueOnce({
      data: { labels: [{ id: "INBOX", name: "INBOX", type: "system" }] },
    });
    const client = createGmailClient(credentials);
    await expect(client.listLabels()).resolves.toEqual([{ id: "INBOX", name: "INBOX", type: "system" }]);
  });

  it("creates a draft without threading when not replying", async () => {
    mocks.draftsCreate.mockResolvedValueOnce({
      data: { id: "d1", message: { id: "m2", threadId: "t2", snippet: "", payload: {} } },
    });

    const client = createGmailClient(credentials);
    const draft = await client.createDraft({ to: ["a@example.com"], subject: "Hi", body: "Body" });

    expect(mocks.messagesGet).not.toHaveBeenCalled();
    expect(draft.draftId).toBe("d1");
    const [[call]] = mocks.draftsCreate.mock.calls;
    expect(call.requestBody.message.threadId).toBeUndefined();
  });

  it("threads a reply draft off the original message's Message-Id and sets the thread ID", async () => {
    mocks.messagesGet.mockResolvedValueOnce({
      data: {
        threadId: "t1",
        payload: {
          headers: [{ name: "Message-Id", value: "<orig@mail.gmail.com>" }],
        },
      },
    });
    mocks.draftsCreate.mockResolvedValueOnce({
      data: { id: "d2", message: { id: "m3", threadId: "t1", snippet: "", payload: {} } },
    });

    const client = createGmailClient(credentials);
    await client.createDraft({
      to: ["a@example.com"],
      subject: "Re: Hi",
      body: "Reply",
      replyToMessageId: "orig-id",
    });

    expect(mocks.messagesGet).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "me", id: "orig-id", format: "metadata" }),
    );
    const [[call]] = mocks.draftsCreate.mock.calls;
    expect(call.requestBody.message.threadId).toBe("t1");
    const raw = Buffer.from(call.requestBody.message.raw, "base64url").toString("utf8");
    expect(raw).toContain("In-Reply-To: <orig@mail.gmail.com>");
  });

  it("never calls users.messages.send or users.drafts.send — this client has no such method", () => {
    const client = createGmailClient(credentials);
    expect((client as unknown as Record<string, unknown>).send).toBeUndefined();
    expect((client as unknown as Record<string, unknown>).sendDraft).toBeUndefined();
    expect((client as unknown as Record<string, unknown>).trashMessage).toBeUndefined();
    expect((client as unknown as Record<string, unknown>).deleteMessage).toBeUndefined();
  });
});
