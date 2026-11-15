import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("isolates pathological patterns throughout canonical answer validation", () => {
  const moduleUrl = new URL("./question-interaction-answers.ts", import.meta.url).href;
  const script = `
    const { parseQuestionInteractionAnswers } = await import(${JSON.stringify(moduleUrl)});
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 10);
    try {
      await parseQuestionInteractionAnswers({
        schema: "paperclip.question_set.v1",
        questions: [{ id: "value", prompt: "Value?", required: true, answerMode: "text", textValidation: { pattern: "^(a+)+$" } }],
      }, [{ questionId: "value", optionIds: [], otherText: "a".repeat(99999) + "!" }], []);
      process.exitCode = 1;
    } catch (error) {
      process.stdout.write(JSON.stringify({ message: error.message, ticks }));
    } finally { clearInterval(timer); }
  `;
  // A future synchronous regression must fail this child deadline, not hang Vitest.
  const child = spawnSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)), encoding: "utf8", timeout: 10_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout);
  expect(result.message).toContain("time limit");
  expect(result.ticks).toBeGreaterThan(1);
}, 15_000);
