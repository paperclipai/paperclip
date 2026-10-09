import { readFile } from "node:fs/promises";

import type { AcpElicitationRequest } from "acpx/runtime";
import { describe, expect, it } from "vitest";

import { normalizeAcpFormElicitation } from "../drivers/acpx/acp-question-adapter.js";
import {
  createCodexQuestionResponseContext,
  normalizeCodexQuestionSet,
  runtimeRequestResponse,
} from "../drivers/codex/codex-question-adapter.js";
import {
  parsePaperclipQuestionResponse,
  parsePaperclipQuestionSet,
  type PaperclipQuestionSet,
} from "./question-set.js";
import type { HarnessRuntimeRequest } from "./harness-driver.js";

interface QuestionAdapterFixture {
  schema: "paperclip.question_adapter_fixture.v1";
  adapter: "codex" | "acpx";
  nativeRequest: Record<string, unknown>;
  canonicalQuestionSet: unknown;
  canonicalResponse: unknown;
  nativeResponse: unknown;
}

async function fixture(
  adapter: QuestionAdapterFixture["adapter"],
): Promise<QuestionAdapterFixture> {
  const source = await readFile(
    new URL(
      `../../protocol/fixtures/questions/${adapter}.json`,
      import.meta.url,
    ),
    "utf8",
  );
  return JSON.parse(source) as QuestionAdapterFixture;
}

describe("question adapter conformance fixtures", () => {
  it("normalizes equivalent Codex and ACPX forms to one canonical question set", async () => {
    const [codex, acpx] = await Promise.all([
      fixture("codex"),
      fixture("acpx"),
    ]);
    const codexQuestionSet = normalizeCodexQuestionSet(
      String(codex.nativeRequest.method),
      codex.nativeRequest.params as Record<string, unknown>,
      createCodexQuestionResponseContext(),
    );
    const acpxQuestionSet = normalizeAcpFormElicitation(
      acpx.nativeRequest.params as AcpElicitationRequest,
    )?.questionSet;
    const codexExpected = parsePaperclipQuestionSet(codex.canonicalQuestionSet);
    const acpxExpected = parsePaperclipQuestionSet(acpx.canonicalQuestionSet);

    expect(codexQuestionSet).toEqual(codexExpected);
    expect(acpxQuestionSet).toEqual(acpxExpected);
    expect(questionPresentation(acpxExpected)).toEqual(
      questionPresentation(codexExpected),
    );
    expect(
      parsePaperclipQuestionResponse(codexExpected, codex.canonicalResponse),
    ).toEqual(codex.canonicalResponse);
    expect(
      parsePaperclipQuestionResponse(acpxExpected, acpx.canonicalResponse),
    ).toEqual(acpx.canonicalResponse);
  });

  it("converts one canonical response back to each provider shape", async () => {
    const [codex, acpx] = await Promise.all([
      fixture("codex"),
      fixture("acpx"),
    ]);
    const responseContext = createCodexQuestionResponseContext();
    const codexQuestionSet = normalizeCodexQuestionSet(
      String(codex.nativeRequest.method),
      codex.nativeRequest.params as Record<string, unknown>,
      responseContext,
    );
    if (codexQuestionSet === null) {
      throw new Error("Codex conformance fixture did not contain a question set");
    }
    const codexRequest: HarnessRuntimeRequest = {
      requestId: "fixture-request",
      requestKind: "user_input",
      method: String(codex.nativeRequest.method),
      turnId: "fixture-turn",
      itemId: "fixture-item",
      status: "pending",
      prompt: "Deployment input",
      details: {},
      input: codexQuestionSet,
      origin: {
        adapter: "codex",
        method: String(codex.nativeRequest.method),
      },
    };
    const codexResponse = parsePaperclipQuestionResponse(
      codexQuestionSet,
      codex.canonicalResponse,
    );
    const normalizedAcpx = normalizeAcpFormElicitation(
      acpx.nativeRequest.params as AcpElicitationRequest,
    );
    const acpxResponse = parsePaperclipQuestionResponse(
      normalizedAcpx!.questionSet,
      acpx.canonicalResponse,
    );

    expect(
      runtimeRequestResponse(codexRequest, {
        action: "submit",
        response: codexResponse,
      }, responseContext),
    ).toEqual(codex.nativeResponse);
    expect(normalizedAcpx?.accept(acpxResponse)).toEqual(acpx.nativeResponse);
  });
});

function questionPresentation(questionSet: PaperclipQuestionSet): unknown {
  return {
    ...questionSet,
    questions: questionSet.questions.map(
      ({ id: _questionId, options, ...question }) => ({
        ...question,
        ...(options
          ? {
              options: options.map(({ id: _optionId, ...option }) => option),
            }
          : {}),
      }),
    ),
  };
}
