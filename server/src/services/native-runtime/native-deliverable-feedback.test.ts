import { describe, expect, it } from "vitest";
import { explicitlyRequestsFileOutput, explicitlyRequestsTaskDocumentOutput } from "./native-deliverable-feedback.js";

describe("explicit file output requirements", () => {
  it.each([
    "Prepare a requested file",
    "Make a Markdown file named checklist.md with three items.",
    "Export the results as a CSV.",
    "Give me a downloadable report.",
    "Please create out/answer.pdf and attach it.",
    "Do not use external services. Create a file with the results.",
    "Make a file but do not send it to anyone else.",
    "Export a summary of this PDF as CSV.",
    "Create no temporary files; export the results as CSV.",
  ])("recognizes an explicit output request: %s", objective => {
    expect(explicitlyRequestsFileOutput(objective)).toBe(true);
  });
  it.each([
    "Explain how a newsletter works",
    "Read the file and explain what it does.",
    "Review the PDF and answer in the chat.",
    "Do not create a file; answer inline.",
    "Don't attach a file. Reply with three bullets.",
    "Fix a crash in parser.ts.",
    "Read the file and write a short explanation inline.",
    "No downloadable file is needed.",
    "Write a summary of this PDF in chat.",
    "Create a review of README.md; reply inline.",
    "Give me advice on file permissions.",
    "Post exactly one durable progress comment whose entire body is TRACKED, then finish this child task. Create no files and do not delegate or create any further tasks.",
    "Create no files.",
    "Generate no attachments and answer in chat.",
    "Write a reply without any files.",
  ])("does not require a file for a text or source-review request: %s", objective => {
    expect(explicitlyRequestsFileOutput(objective)).toBe(false);
  });
});


describe("explicit task-document output", () => {
  it.each([
    "Use the connected page service to find recent pages and create a short Markdown briefing document on this task. Include the titles and verification code returned by the service.",
    "Save a document on this task.",
    "Write a report document attached to the issue.",
    "Do not call HubSpot, but create a document on this task.",
    "You may skip HubSpot, but create a document on this task.",
    "Explain the lookup error, but save a document on this task.",
  ])("requires a published task document: %s", objective => {
    expect(explicitlyRequestsTaskDocumentOutput(objective)).toBe(true);
  });
  it.each([
    "Explain the document on this task.",
    "Write a summary of the document on this task in chat.",
    "Do not create a document on this task; reply inline.",
    "Create no document on this task.",
    "Write a response without a document on this task.",
    "Create a document about this task in the repository.",
    "Explain how to create a document on this task.",
    "Create briefing.md in the workspace.",
    "If the lookup succeeds, create a document on this task.",
    "Create a document on this task if the lookup succeeds.",
    "Only create a document on this task when the lookup succeeds.",
    "Create a document on this task, but only if the lookup succeeds.",
    "If the lookup succeeds, do not call HubSpot, but create a document on this task.",
    "Read the task, but do not yet create a document on this task.",
    "Unless I decline, create a document on this task.",
    "Once approved, create a document on this task.",
    "Do not yet create a document on this task.",
    "Don’t ever create a document on this task.",
    "You may optionally create a document on this task.",
    "Create a document on this task only if useful; otherwise answer inline.",
    "Connect HubSpot so you can read my recent contacts. If the contacts are unavailable, a brief explanation is enough instead of the contact list.",
  ])("preserves other output scopes: %s", objective => {
    expect(explicitlyRequestsTaskDocumentOutput(objective)).toBe(false);
  });
});
