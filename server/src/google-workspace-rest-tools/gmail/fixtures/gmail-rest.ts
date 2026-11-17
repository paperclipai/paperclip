const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");

export const FULL_MESSAGE = {
  id: "18c0ffee00000001",
  threadId: "18c0ffee00000000",
  labelIds: ["INBOX", "UNREAD", "CATEGORY_PERSONAL", "Label_42"],
  snippet: "Here is the quarterly plan we discussed",
  internalDate: "1763337600000",
  sizeEstimate: 4096,
  historyId: "9001",
  payload: {
    partId: "",
    mimeType: "multipart/mixed",
    filename: "",
    headers: [
      { name: "From", value: "\"Avery Example\" <avery@example.test>" },
      { name: "To", value: "Blake <blake@example.test>, casey@example.test" },
      { name: "Cc", value: "\"Doe, Drew\" <drew@example.test>" },
      { name: "Subject", value: "Quarterly plan" },
      { name: "Date", value: "Mon, 17 Nov 2025 00:00:00 +0000" },
      { name: "Message-ID", value: "<plan-1@mail.example.test>" },
    ],
    body: { size: 0 },
    parts: [
      {
        partId: "0",
        mimeType: "multipart/alternative",
        filename: "",
        headers: [{ name: "Content-Type", value: "multipart/alternative; boundary=\"alt\"" }],
        body: { size: 0 },
        parts: [
          { partId: "0.0", mimeType: "text/plain", filename: "", headers: [], body: { size: 38, data: b64("Here is the quarterly plan we discussed.") } },
          { partId: "0.1", mimeType: "text/html", filename: "", headers: [], body: { size: 45, data: b64("<p>Here is the <b>quarterly plan</b>.</p>") } },
        ],
      },
      {
        partId: "1",
        mimeType: "application/pdf",
        filename: "plan.pdf",
        headers: [{ name: "Content-Disposition", value: "attachment; filename=\"plan.pdf\"" }],
        body: { attachmentId: "ANGjdJ_fake_attachment_1", size: 2048 },
      },
    ],
  },
};

export const METADATA_MESSAGE = {
  id: "18c0ffee00000002",
  threadId: "18c0ffee00000000",
  labelIds: ["SENT", "CATEGORY_UPDATES"],
  snippet: "Thanks, looks good",
  internalDate: "1763424000000",
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "From", value: "blake@example.test" },
      { name: "To", value: "avery@example.test" },
      { name: "Subject", value: "Re: Quarterly plan" },
      { name: "Date", value: "Tue, 18 Nov 2025 00:00:00 +0000" },
    ],
  },
};

export const THREAD_LIST = {
  threads: [
    { id: "18c0ffee00000000", snippet: "Thanks, looks good", historyId: "9002" },
    { id: "18c0ffee00000010", snippet: "Lunch?", historyId: "9003" },
  ],
  nextPageToken: "page-2-token",
  resultSizeEstimate: 201,
};

export const THREAD_ONE = {
  id: "18c0ffee00000000",
  historyId: "9002",
  messages: [{ ...FULL_MESSAGE, payload: { mimeType: "multipart/mixed", headers: FULL_MESSAGE.payload.headers } }, METADATA_MESSAGE],
};

export const REPLY_ORIGINAL = {
  id: "18c0ffee00000001",
  threadId: "18c0ffee00000000",
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "Message-ID", value: "<plan-1@mail.example.test>" },
      { name: "References", value: "<kickoff-0@mail.example.test>" },
      { name: "Subject", value: "Quarterly plan" },
    ],
  },
};

export const CREATED_DRAFT = {
  id: "r-1234567890123456789",
  message: { id: "18c0ffee00000099", threadId: "18c0ffee00000000", labelIds: ["DRAFT"] },
};
