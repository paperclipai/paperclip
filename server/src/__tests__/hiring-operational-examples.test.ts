import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createAgentHireSchema, createIssueThreadInteractionSchema, updateIssueSchema } from "@paperclipai/shared";
import { runnerApiReference } from "../services/native-runtime/runner-api-reference.js";

const reference = readFileSync(new URL("../../../skills/paperclip/references/api-reference.md", import.meta.url), "utf8");
const uuid = "11111111-1111-4111-8111-111111111111";
const examples = [...reference.matchAll(/^(POST|PATCH) (\/api\/[^\s]+)\n(\{[^\n]*\}|\{\n[\s\S]*?\n\})/gm)]
  .flatMap((match) => {
    try { return [{ method: match[1], path: match[2], body: JSON.parse(match[3]) }]; }
    catch { return []; }
  });
const substituteIds = (body: unknown) => JSON.parse(JSON.stringify(body).replace(/\{[\w-]+\}/g, uuid));

describe("published hiring and human-input examples", () => {
  const questions = examples.filter(({ body }) => body.kind === "ask_user_questions");
  const hires = examples.filter(({ path }) => path.endsWith("/agent-hires"));
  const waits = examples.filter(({ method, body }) => method === "PATCH" && (body.unblockDescriptor || body.comment === "Waiting for your answer in the saved responsibility question card."));

  it("publishes valid structured and free-text questions, managed hires, and waiting states", () => {
    expect(questions).toHaveLength(2);
    expect(hires.length).toBeGreaterThan(0);
    expect(waits).toHaveLength(2);
    for (const { body } of questions) expect(createIssueThreadInteractionSchema.safeParse(substituteIds(body))).toMatchObject({ success: true });
    for (const { body } of hires) {
      expect(createAgentHireSchema.safeParse(substituteIds(body))).toMatchObject({ success: true });
      expect(body.instructionsBundle.files["AGENTS.md"]).toEqual(expect.any(String));
    }
    for (const { body } of waits) expect(updateIssueSchema.safeParse(substituteIds(body))).toMatchObject({ success: true });
  });

  it("keeps these examples in the generated runner reference without displacing confirmations", () => {
    for (const example of [...questions, ...hires, ...waits]) {
      const key = `${example.method} ${example.path.replace(/\{[^}]+\}/g, "{}")}`;
      expect(runnerApiReference[key]?.examples).toContainEqual({ body: example.body });
    }
    expect(runnerApiReference["POST /api/issues/{}/interactions"].examples)
      .toEqual(expect.arrayContaining([expect.objectContaining({ body: expect.objectContaining({ kind: "request_confirmation" }) })]));
  });

  it("only enriches documented endpoint templates, not literal narrative URLs", () => {
    const documentedOperations = new Set([...reference.matchAll(/^\|\s*(GET|POST|PATCH|PUT|DELETE)\s*\|\s*`([^`]+)`/gm)]
      .map((match) => `${match[1]} ${match[2].replace(/:[A-Za-z][A-Za-z0-9_]*|\{[^}]+\}/g, "{}")}`));
    expect(Object.keys(runnerApiReference).filter((key) => !documentedOperations.has(key))).toEqual([]);
    expect(runnerApiReference["PATCH /api/issues/issue-101"]).toBeUndefined();
    expect(runnerApiReference["POST /api/companies/company-1/imports/preview"]).toBeUndefined();
  });
});
