import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import type { IssueDocument } from "../../../packages/shared/src/types/issue.js";
import { checks, putDocument } from "./internal-support.js";
import { privilegedDefinition, privilegedObservation, settlePrivilegedChat } from "./privileged-support.js";
import { prepareOwnedCli, runOwnedCli, cleanupOwnedCli } from "./privileged-cli-support.js";

export function documentExportCommand(reply: string, sourceId: string) {
  const blocks = [...reply.matchAll(/```(?:bash|sh|shell)?\s*\n([\s\S]*?)```/g)].map(match => match[1]!.replace(/\\\r?\n/g, " ").trim());
  const matches = blocks.flatMap(block => block.split(/\r?\n/)).map(line => line.match(/^(?:paperclipai|npx(?: -y)? paperclipai|pnpm (?:exec )?paperclipai)\s+issue\s+document:get\s+(\S+)\s+plan\s+--json\s*\|\s*jq\s+(-[rj]+)\s+['"]?\.body['"]?\s*>\s*([A-Za-z0-9][A-Za-z0-9_.-]*)$/)).filter(Boolean);
  if (matches.length !== 1) throw new Error("One supported plan JSON-to-file command is required; arbitrary shell is not admitted");
  const command = matches[0]!;
  const original = command[1]!, id = /^(?:<[A-Z_ -]+>|\$\{?[A-Z_]+\}?)$/.test(original) ? sourceId : original;
  if (id !== sourceId || path.basename(command[3]!) !== command[3]!) throw new Error("Document export targets a different task or destination");
  return { argv: ["issue", "document:get", id, "plan", "--json"], filterArgs: [command[2]!, ".body"], filename: command[3]!,
    unresolvedIssueBinding: original === id ? undefined : { placeholder: original, fixtureValue: id } };
}
export function gradeExportDocumentCli(value: unknown) {
  const c = checks(), o = privilegedObservation(value);
  c.add("saved-document-export-evidence", !!o, "An actual supported CLI read, structured result and owned file bytes are required."); if (!o) return c.result();
  c.add("correct-saved-revision", typeof o.state.documentRevisionId === "string" && o.state.exportRevisionId === o.state.documentRevisionId
    && o.state.documentUnchanged === true && o.state.exportIssueId === o.state.sourceIssueId,
    "The downloaded structured document is the exact selected saved plan revision on the authorized source task.");
  c.add("actual-file-bytes", o.state.actualFileSha256 === o.state.savedBodySha256 && typeof o.state.actualFileSha256 === "string"
    && o.state.fileReadBack === true && o.state.fileWithinOwnedDirectory === true,
    "The actual terminal output file is read back and matches the saved document body byte-for-byte.");
  c.add("no-summary-substitute", o.state.cliExecuted === true && typeof o.state.commandSha256 === "string"
    && o.state.exportStructuredResult === true && o.state.onlyExpectedDocumentReturned === true,
    "A chat summary or unrelated document cannot stand in for the real authorized file download.");
  return c.result();
}
const exportPlan = privilegedDefinition("cli-operations.export-document-cli", "privileged-document-cli", {
  async setup(ctx) {
    const operator = await prepareOwnedCli(ctx);
    await ctx.input.api.post(`/api/companies/${ctx.input.fixtures.company.id}/chats/${ctx.input.fixtures.agent.id}`);
    await ctx.refreshIssue(); const issue = ctx.issue(); if (!issue) throw new Error("Owned standing task did not persist");
    const body = `# Website plan\n\nA saved synthetic revision for Acorn.\n\nReference ${ctx.input.nonce}.`;
    const document = await putDocument(ctx, issue.id, body);
    return { ...operator, sourceIssueId: issue.id, documentRevisionId: document.latestRevisionId,
      savedBodySha256: createHash("sha256").update(body).digest("hex") };
  },
  async act(ctx, state) {
    const reply = await settlePrivilegedChat(ctx), sourceId = String(state.sourceIssueId);
    const command = documentExportCommand(reply.reply, sourceId);
    const json = await runOwnedCli(ctx, command.argv), document = JSON.parse(json) as IssueDocument;
    // Execute the actual finite jq filter from the returned command; never a shell.
    const bytes = execFileSync("jq", command.filterArgs, { input: json, timeout: 5_000, maxBuffer: 1_048_576 });
    const destination = path.join(String(state.operatorDirectory), command.filename);
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    const actual = await readFile(destination);
    state.actualFileSha256 = createHash("sha256").update(actual).digest("hex"); state.fileReadBack = true;
    state.fileWithinOwnedDirectory = path.dirname(destination) === state.operatorDirectory;
    state.exportRevisionId = document.latestRevisionId; state.exportIssueId = document.issueId;
    const saved = await ctx.input.api.get<IssueDocument>(`/api/issues/${sourceId}/documents/plan`);
    state.documentUnchanged = saved.latestRevisionId === state.documentRevisionId && createHash("sha256").update(saved.body ?? "").digest("hex") === state.savedBodySha256;
    state.exportStructuredResult = typeof document.body === "string" && typeof document.latestRevisionId === "string";
    state.onlyExpectedDocumentReturned = document.key === "plan" && document.issueId === sourceId;
    state.cliExecuted = true;
    state.commandSha256 = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    state.unresolvedIssueBinding = command.unresolvedIssueBinding;
    await ctx.input.evidence("chat-catalog-cli-plan-file.json", { sourceIssueId: sourceId, revisionId: state.documentRevisionId,
      fileSha256: state.actualFileSha256, expectedSha256: state.savedBodySha256, bytes: actual.length,
      filename: command.filename, commandSha256: state.commandSha256, unresolvedIssueBinding: command.unresolvedIssueBinding });
  }, grade: gradeExportDocumentCli,
  async verifyResult(ctx) { await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible(); },
});
exportPlan.sourceFiles = [...exportPlan.sourceFiles, "chat-catalog-domains/privileged-cli-support.ts", "../../cli/src/index.ts"];
exportPlan.cleanup = cleanupOwnedCli;
export const privilegedDocumentCliCases = [exportPlan];
