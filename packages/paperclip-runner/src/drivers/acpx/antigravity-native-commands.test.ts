import { describe, expect, it } from "vitest";
import { antigravityNativeCommands, neutralizeAntigravityNativeCommands } from "./antigravity-native-commands.js";

const serverOutcomes: Array<[string[], string[]]> = [
  [["Please read the doc; see /plan for details."], ["plan"]],
  [["{\"task\":\"Fix bug. Then /plan the rollout\"}"], ["plan"]],
  [["line one\n/plan\nline three"], ["plan"]],
  [["tab\t/plan\there"], ["plan"]],
  [["x\u001c/plan"], ["plan"]],
  [["/plan"], ["plan"]],
  [["/planning ahead"], []], [["a/plan b"], []], [["see https://example.test/plan for docs"], []],
  [["/plan/foo"], []], [["/PLAN now"], []], [["{\"issue\":\"quoted: \\\"> /plan\\\" end\"}"], []],
  [["{\"t\":\"x /logout\"}"], []], [["  /logout  "], ["logout"]], [["\u001c/logout"], ["logout"]], [["/log", "out"], ["logout"]],
  [["Do the task\n/logout"], []],
  [["/USAGE"], ["usage"]], [["/usage now"], ["usage"]], [["\u0085/usage"], ["usage"]], [["/usages"], []], [["text /usage"], []],
  [["⁠/plan"], []], [["⁠/logout"], []],
];

describe("Antigravity native command matching", () => {
  it.each(serverOutcomes)("matches the pinned server for %j", (blocks, commands) => {
    expect(antigravityNativeCommands(blocks)).toEqual(commands);
  });

  it.each(serverOutcomes)("leaves no native command and changes nothing but word joiners in %j", blocks => {
    const sent = neutralizeAntigravityNativeCommands(blocks);
    expect(antigravityNativeCommands(sent)).toEqual([]);
    expect(sent.map(text => text.replaceAll("⁠", ""))).toEqual(blocks.map(text => text.replaceAll("⁠", "")));
    if (antigravityNativeCommands(blocks).length === 0) expect(sent).toEqual(blocks);
  });
});
