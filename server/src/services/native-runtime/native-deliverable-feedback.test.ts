import { describe, expect, it } from "vitest";
import { explicitlyRequestsFileOutput } from "./native-deliverable-feedback.js";

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
  ])("does not require a file for a text or source-review request: %s", objective => {
    expect(explicitlyRequestsFileOutput(objective)).toBe(false);
  });
});
