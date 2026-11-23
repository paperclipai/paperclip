export const ANTIGRAVITY_NATIVE_COMMANDS: readonly string[] = ["plan", "logout", "usage"];

const PYTHON_WHITESPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PLAN_COMMAND = `(^|[${PYTHON_WHITESPACE}])/(?=plan(?:[${PYTHON_WHITESPACE}]|$))`;
const LEADING_WHITESPACE = new RegExp(`^[${PYTHON_WHITESPACE}]*`);
const PYTHON_STRIP = new RegExp(`^[${PYTHON_WHITESPACE}]+|[${PYTHON_WHITESPACE}]+$`, "g");
const STARTS_WITH_WHITESPACE = new RegExp(`^[${PYTHON_WHITESPACE}]`);
const WORD_JOINER = "⁠";

export function antigravityNativeCommands(blocks: readonly string[]): string[] {
  const found: string[] = [];
  if (blocks.some(text => new RegExp(PLAN_COMMAND).test(text))) found.push("plan");
  const joined = blocks.join("").replace(PYTHON_STRIP, "");
  if (joined === "/logout") found.push("logout");
  if (joined.slice(0, 6).toLowerCase() === "/usage" && (joined.length === 6 || STARTS_WITH_WHITESPACE.test(joined.slice(6)))) found.push("usage");
  return found;
}

export function neutralizeAntigravityNativeCommands(blocks: readonly string[]): string[] {
  const result = blocks.map(text => text.replace(new RegExp(PLAN_COMMAND, "g"), `$1${WORD_JOINER}/`));
  if (antigravityNativeCommands(result).length === 0) return result;
  const index = result.findIndex(text => leadingWhitespace(text) < text.length);
  if (index === -1) return result;
  const text = result[index] as string;
  const lead = leadingWhitespace(text);
  result[index] = `${text.slice(0, lead)}${WORD_JOINER}${text.slice(lead)}`;
  return result;
}

function leadingWhitespace(text: string): number {
  return LEADING_WHITESPACE.exec(text)?.[0].length ?? 0;
}
