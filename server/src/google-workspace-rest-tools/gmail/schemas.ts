const stringArray = (description: string) => ({ type: "array", items: { type: "string" }, description });

export const attachmentMetadataSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "The attachment ID." },
    mimeType: { type: "string", description: "The attachment's MIME type." },
    filename: { type: "string", description: "The attachment's file name." },
  },
} as const;

export const messageSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "The message ID." },
    snippet: { type: "string", description: "A short excerpt of the message body." },
    subject: { type: "string", description: "The subject header." },
    sender: { type: "string", description: "The sender's email address." },
    toRecipients: stringArray("To recipient email addresses."),
    ccRecipients: stringArray("Cc recipient email addresses."),
    date: { type: "string", description: "The message date, ISO 8601 (YYYY-MM-DD)." },
    plaintextBody: { type: "string", description: "The plain-text body. Only with FULL_CONTENT." },
    attachmentIds: stringArray("Attachment IDs. Only with FULL_CONTENT."),
    htmlBody: { type: "string", description: "The HTML body. Only with FULL_CONTENT." },
    attachments: { type: "array", items: attachmentMetadataSchema, description: "Attachments. Only with FULL_CONTENT." },
    labelIds: stringArray("User label IDs and the system labels INBOX, SPAM, TRASH, UNREAD, STARRED, IMPORTANT, SENT, DRAFT and CHAT."),
  },
} as const;
