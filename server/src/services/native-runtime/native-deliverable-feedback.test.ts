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
    "Create no temporary files; export the results as CSV.",
    "Write report.pdf. This is an internal verification file, not a deliverable. Also export the results as CSV.",
    "Write a downloadable report.pdf. This is personal memory, not a task deliverable.",
    "Attempt native write to report.txt with content requested.",
    "Write report.pdf and checklist.md. This is an internal assertion file, not a deliverable.",
    "Write report.pdf; write internal-proof.txt. This is an internal verification file, not a deliverable.",
    "Write report.pdf and attempt native write to /outside/probe.txt; this negative test must be denied.",
    "Attempt native write to /outside/probe.json and write report.pdf; this negative test must be denied.",
    "Write report.txt and attach it. This is an internal verification file, not a deliverable.",
    "Attach it.",
    "Write report.txt and return it as an attachment. This is an internal verification file, not a deliverable.",
    "Write report.txt and send it to me. This is an internal verification file, not a deliverable.",
    "Write report.txt. This is an internal verification file, not a deliverable. Send it to me.",
    "Write report.txt and provide it to me. This is an internal verification file, not a deliverable.",
    "Write report.txt and give me it. This is an internal verification file, not a deliverable.",
    "Write report.txt and return it. This is an internal verification file, not a deliverable.",
    "Write report.txt and send it as an attachment in your response. This is an internal verification file, not a deliverable.",
    "Write report.txt. This is an internal verification file, not a deliverable. Send it as a download link in your response.",
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
    "Use native write/read file tools for this task, not bash or the instructions API.",
    "Write a memory entry to memory/pi-native.txt inside the registered AGENT_HOME. This is personal memory, not a task deliverable.",
    "Use native write to copy those exact bytes into pi-agent-memory-proof.txt in the task workspace. This is an internal assertion file, not a deliverable.",
    "Before finishing, attempt native write exactly once to /outside/pi-unassigned.txt with content forbidden. This intentionally unassigned root must be denied.",
    "Write internal-proof.txt; then check it exists. This is an internal verification file, not a deliverable.",
    "Attempt native write to /outside/probe.txt and create no files. This negative test must be denied.",
    "Write internal-proof.txt; do not attach it. This is an internal verification file, not a deliverable.",
    "Write a reply and return it in chat.",
    "Write internal-proof.txt and return it in chat. This is an internal verification file, not a deliverable.",
    "Write internal-proof.txt and send it in chat. This is an internal verification file, not a deliverable.",
    "Write internal-proof.txt. This is an internal verification file, not a deliverable. Return it inline.",
    "Write internal-proof.txt and send it as a code block in your response. This is an internal verification file, not a deliverable.",
    "Write internal-proof.txt and return it in my reply. This is an internal verification file, not a deliverable.",
    "Write internal-proof.txt and provide it as plain text. This is an internal verification file, not a deliverable.",
  ])("does not require a file for a text or source-review request: %s", objective => {
    expect(explicitlyRequestsFileOutput(objective)).toBe(false);
  });
});
