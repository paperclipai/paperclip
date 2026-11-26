/**
 * OpenCode (qualified 1.18.34) cannot place images in OpenAI-compatible tool
 * results, so it moves tool-result media into a synthetic *user* message that
 * starts with "Attached media from tool result:". When the selected model has
 * no image input, OpenCode then swaps each image for
 * "ERROR: Cannot read image (this model does not support image input). Inform
 * the user." The model sees that as the person speaking and derails: it redoes
 * finished work or tells the person about an error they never caused.
 *
 * Every OpenCode request for an OpenRouter or Paperclip-connection model goes
 * through the runner's provider proxy, so the proxy moves that notice back
 * into the tool result it came from, worded as a tool outcome. Real user
 * messages (including images a person attached) are never touched, and the
 * rewrite is deterministic so prompt-cache prefixes stay stable.
 */

export const OPENCODE_SYNTHETIC_ATTACHMENT_PROMPT = "Attached media from tool result:";

const UNSUPPORTED_MEDIA = /^ERROR: Cannot read (.+) \(this model does not support ([a-z]+) input\)\. Inform the user\.$/;
const EMPTY_IMAGE = "ERROR: Image file is empty or corrupted. Please provide a valid image.";

type Message = Record<string, unknown>;

function textOf(part: unknown): string | null {
  if (!part || typeof part !== "object") return null;
  const record = part as Record<string, unknown>;
  return record.type === "text" && typeof record.text === "string" ? record.text : null;
}

function describe(text: string): string | null {
  if (text === EMPTY_IMAGE) return "an image attachment that was empty or corrupted";
  const match = UNSUPPORTED_MEDIA.exec(text);
  if (!match) return null;
  const [, name, modality] = match;
  const article = /^[aeiou]/.test(modality) ? "an" : "a";
  const file = name === modality ? "" : ` (${name.replace(/^"|"$/g, "")})`;
  const subject = `${article} ${modality} attachment${file}`;
  return `${subject} that this model cannot read because it does not accept ${modality} input`;
}

function toolNote(descriptions: string[], toolResults: number): string {
  const unique = [...new Set(descriptions)];
  const source = toolResults === 1 ? "This tool result" : "A tool result in this step";
  return [
    `[Paperclip runner: ${source} included ${unique.join("; ")}, so it was not shown to you.`,
    "The tool call itself completed. Do not retry viewing it; verify with text-based checks instead.",
    "This note comes from the runner, not from the user, and needs no reply.]",
  ].join(" ");
}

function appendToToolMessage(message: Message, note: string): boolean {
  if (typeof message.content === "string") {
    message.content = message.content ? `${message.content}\n\n${note}` : note;
    return true;
  }
  if (Array.isArray(message.content)) {
    message.content = [...message.content, { type: "text", text: note }];
    return true;
  }
  return false;
}

/**
 * Rewrites an OpenAI-compatible chat-completions payload in place. Returns
 * true when anything changed, so the caller can keep the original bytes
 * otherwise.
 */
export function attributeUnsupportedToolMedia(payload: Record<string, unknown>): boolean {
  const messages = payload.messages;
  if (!Array.isArray(messages)) return false;
  let changed = false;
  for (let index = messages.length - 1; index > 0; index -= 1) {
    const message = messages[index] as Message | null;
    if (!message || message.role !== "user" || !Array.isArray(message.content)) continue;
    const [header, ...rest] = message.content as unknown[];
    if (textOf(header) !== OPENCODE_SYNTHETIC_ATTACHMENT_PROMPT) continue;
    const descriptions: string[] = [];
    const kept: unknown[] = [];
    for (const part of rest) {
      const text = textOf(part);
      const description = text === null ? null : describe(text);
      if (description) descriptions.push(description);
      else kept.push(part);
    }
    if (descriptions.length === 0) continue;
    // OpenCode places the synthetic message directly after the tool results
    // of the step that produced the media. Anything else is not ours to edit.
    let firstTool = index;
    while (firstTool > 0 && (messages[firstTool - 1] as Message | null)?.role === "tool") firstTool -= 1;
    const toolResults = index - firstTool;
    if (toolResults === 0) continue;
    if (!appendToToolMessage(messages[index - 1] as Message, toolNote(descriptions, toolResults))) continue;
    if (kept.length === 0) messages.splice(index, 1);
    else message.content = [header, ...kept];
    changed = true;
  }
  return changed;
}
