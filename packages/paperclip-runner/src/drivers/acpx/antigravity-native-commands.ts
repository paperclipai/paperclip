/**
 * The pinned Antigravity ACP server turns some prompt text into native slash
 * commands before inference. These matchers mirror its exact rules so managed
 * prompt text always reaches the model as prose:
 *
 * - `plan`: in every text block, `(?:\s|^)/(plan)(?:\s|$)` anywhere, not only at
 *   a line start (server.py `_CMD_PATTERN`, applied by `_parse_prompt`).
 * - `logout`: all text blocks joined, `.strip() == "/logout"` (logout.py
 *   `is_logout_prompt`).
 * - `usage`: all text blocks joined and stripped, case-insensitively starting
 *   with `/usage` followed by whitespace or the end (usage.py `is_usage_prompt`).
 *
 * Python's `\s` and `str.strip()` use `str.isspace()`, which is wider than
 * JavaScript's whitespace (for example U+001C..U+001F and U+0085).
 */
export const ANTIGRAVITY_NATIVE_COMMANDS: readonly string[] = ["plan", "logout", "usage"];

const PYTHON_WHITESPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PLAN_COMMAND = `(^|[${PYTHON_WHITESPACE}])/(?=plan(?:[${PYTHON_WHITESPACE}]|$))`;
const LEADING_WHITESPACE = new RegExp(`^[${PYTHON_WHITESPACE}]*`);
const PYTHON_STRIP = new RegExp(`^[${PYTHON_WHITESPACE}]+|[${PYTHON_WHITESPACE}]+$`, "g");
const STARTS_WITH_WHITESPACE = new RegExp(`^[${PYTHON_WHITESPACE}]`);
// Whitespace to neither runtime: the slash no longer follows whitespace or
// starts the prompt, and the model still reads the same words.
const WORD_JOINER = "⁠";

/** Names of the native commands the pinned server would run for these text blocks. */
export function antigravityNativeCommands(blocks: readonly string[]): string[] {
  const found: string[] = [];
  if (blocks.some(text => new RegExp(PLAN_COMMAND).test(text))) found.push("plan");
  const joined = blocks.join("").replace(PYTHON_STRIP, "");
  if (joined === "/logout") found.push("logout");
  if (joined.slice(0, 6).toLowerCase() === "/usage" && (joined.length === 6 || STARTS_WITH_WHITESPACE.test(joined.slice(6)))) found.push("usage");
  return found;
}

/** Places a word joiner before each slash the server would run as a native command. */
export function neutralizeAntigravityNativeCommands(blocks: readonly string[]): string[] {
  const result = blocks.map(text => text.replace(new RegExp(PLAN_COMMAND, "g"), `$1${WORD_JOINER}/`));
  if (antigravityNativeCommands(result).length > 0) {
    // logout and usage match only when the prompt's first visible character is their slash.
    const index = result.findIndex(text => LEADING_WHITESPACE.exec(text)![0].length < text.length);
    const text = result[index]!;
    const lead = LEADING_WHITESPACE.exec(text)![0].length;
    result[index] = `${text.slice(0, lead)}${WORD_JOINER}${text.slice(lead)}`;
  }
  return result;
}
