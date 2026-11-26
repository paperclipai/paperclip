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

export const FULL_THREAD = {
  id: "18c0ffee00000000",
  historyId: "9002",
  messages: [FULL_MESSAGE, { ...METADATA_MESSAGE, payload: { ...METADATA_MESSAGE.payload, body: { size: 18, data: b64("Thanks, looks good") } } }],
};

export const MESSAGE_LIST = {
  messages: [
    { id: "18c0ffee00000002", threadId: "18c0ffee00000000" },
    { id: "18c0ffee00000001", threadId: "18c0ffee00000000" },
  ],
  nextPageToken: "messages-page-2",
  resultSizeEstimate: 37,
};

export const FULL_DRAFT = {
  id: "r-1234567890123456789",
  message: {
    id: "18c0ffee00000099",
    threadId: "18c0ffee00000000",
    labelIds: ["DRAFT"],
    snippet: "Draft reply",
    internalDate: "1763510400000",
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "To", value: "Avery <avery@example.test>" },
        { name: "Cc", value: "casey@example.test" },
        { name: "Bcc", value: "\"Ops\" <ops@example.test>" },
        { name: "Subject", value: "Re: Quarterly plan" },
      ],
      parts: [
        { mimeType: "text/plain", body: { size: 11, data: b64("Draft reply") } },
        { mimeType: "text/html", body: { size: 18, data: b64("<p>Draft reply</p>") } },
      ],
    },
  },
};

export const DRAFT_LIST = {
  drafts: [
    { id: "r-1234567890123456789", message: { id: "18c0ffee00000099", threadId: "18c0ffee00000000" } },
    { id: "r-2000000000000000001", message: { id: "18c0ffee000000a0", threadId: "18c0ffee000000a0" } },
  ],
  nextPageToken: "drafts-page-2",
  resultSizeEstimate: 2,
};

export const LABEL_LIST = {
  labels: [
    { id: "INBOX", name: "INBOX", type: "system", messageListVisibility: "hide", labelListVisibility: "labelShow" },
    { id: "Label_7", name: "Receipts", type: "user", color: { textColor: "#000000", backgroundColor: "#4a86e8" } },
    { id: "CATEGORY_UPDATES", name: "CATEGORY_UPDATES", type: "system" },
    { id: "Label_42", name: "Projects", type: "user" },
    { id: "Label_3", name: "Projects/Plan", type: "user", color: { backgroundColor: "#ffffff" } },
  ],
};
