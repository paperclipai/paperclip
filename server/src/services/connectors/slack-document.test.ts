import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { authorizeSlackDocument } from "./slack-document.js";
import type { SlackTaskAuthority } from "./slack-authority.js";
import type { slackClient } from "./slack-client.js";

const CHANNEL = "C0CG50ZA7AB";
const PARENT = "1794943241.252069";
const REPLY = "1794943256.592329";
const FILE = "F0CJJCK1AKG";

const authority = {
  endpoint: { id: "endpoint", companyId: "company" },
  issueId: "issue",
  userId: "user",
} as unknown as SlackTaskAuthority;
// No earlier Slack-created canvas or list matches, so the linking message decides.
const db = {
  select: () => ({ from: () => ({ where: async () => [] }) }),
} as unknown as Db;

function slack(options: {
  history?: unknown[];
  replies?: unknown[];
  shares?: unknown;
}) {
  const api = vi.fn(async (method: string, _args?: Record<string, unknown>) => {
    if (method === "conversations.history") return { messages: options.history ?? [] };
    if (method === "conversations.replies") return { messages: options.replies ?? [] };
    if (method === "files.info") return { file: { id: FILE, name: "resume.pdf", shares: options.shares } };
    throw new Error(`unexpected ${method}`);
  });
  const methods = () => api.mock.calls.map(([method]) => method);
  return { api: api as unknown as ReturnType<typeof slackClient>, methods, calls: api.mock.calls };
}
const withFile = (ts: string) => ({ ts, files: [{ id: FILE }] });
const share = (ts: string, thread_ts: string) => ({ ts, thread_ts });

describe("authorizeSlackDocument", () => {
  it("accepts a file on a top-level message without consulting the file's shares", async () => {
    const { api, methods } = slack({ history: [withFile(PARENT)] });
    const file = await authorizeSlackDocument(db, authority, api, { channel: CHANNEL, file: FILE, ts: PARENT }, false);
    expect(file.id).toBe(FILE);
    expect(methods()).toEqual(["conversations.history", "files.info"]);
  });

  it("finds a file attached in a thread reply from the thread Slack records on the file", async () => {
    const { api, calls, methods } = slack({
      history: [{ ts: PARENT }],
      replies: [{ ts: PARENT }, withFile(REPLY)],
      shares: { private: { [CHANNEL]: [share(REPLY, PARENT)] } },
    });
    const file = await authorizeSlackDocument(db, authority, api, { channel: CHANNEL, file: FILE, ts: REPLY }, false);
    expect(file.id).toBe(FILE);
    expect(methods()).toEqual(["conversations.history", "files.info", "conversations.replies"]);
    expect(calls[2]![1]).toMatchObject({ channel: CHANNEL, ts: PARENT, oldest: REPLY, latest: REPLY });
  });

  it("reads shares in public channels too", async () => {
    const { api } = slack({
      replies: [withFile(REPLY)],
      shares: { public: { [CHANNEL]: [share(REPLY, PARENT)] } },
    });
    await expect(
      authorizeSlackDocument(db, authority, api, { channel: CHANNEL, file: FILE, ts: REPLY }, false),
    ).resolves.toMatchObject({ id: FILE });
  });

  it("still requires the thread message itself to link the file", async () => {
    const { api } = slack({
      replies: [{ ts: REPLY, files: [{ id: "FOTHER" }] }],
      shares: { private: { [CHANNEL]: [share(REPLY, PARENT)] } },
    });
    await expect(
      authorizeSlackDocument(db, authority, api, { channel: CHANNEL, file: FILE, ts: REPLY }, false),
    ).rejects.toThrow("Document must be linked from the authorized message");
  });

  it("ignores shares recorded for a different message or channel", async () => {
    const { api, methods } = slack({
      replies: [withFile(REPLY)],
      shares: {
        private: {
          [CHANNEL]: [share("1794943999.000001", PARENT)],
          C0OTHER: [share(REPLY, PARENT)],
        },
      },
    });
    await expect(
      authorizeSlackDocument(db, authority, api, { channel: CHANNEL, file: FILE, ts: REPLY }, false),
    ).rejects.toThrow("Document must be linked from the authorized message");
    expect(methods()).not.toContain("conversations.replies");
  });

  it("denies with guidance when Slack records no thread for the file", async () => {
    const { api } = slack({ history: [{ ts: PARENT }] });
    await expect(
      authorizeSlackDocument(db, authority, api, { channel: CHANNEL, file: FILE, ts: REPLY }, false),
    ).rejects.toThrow(/pass that reply's ts and the thread's parent ts as thread_ts/);
  });

  it("does not search another thread when the caller already named one", async () => {
    const { api, methods } = slack({
      replies: [{ ts: REPLY }],
      shares: { private: { [CHANNEL]: [share(REPLY, "1700000000.000001")] } },
    });
    await expect(
      authorizeSlackDocument(db, authority, api, { channel: CHANNEL, file: FILE, ts: REPLY, thread_ts: PARENT }, false),
    ).rejects.toThrow("Document must be linked from the authorized message");
    expect(methods()).toEqual(["conversations.replies"]);
  });

  it("requires the linking message to be named", async () => {
    const { api, methods } = slack({});
    await expect(
      authorizeSlackDocument(db, authority, api, { channel: CHANNEL, file: FILE }, false),
    ).rejects.toThrow("Supply the message that links this document");
    expect(methods()).toEqual([]);
  });
});
