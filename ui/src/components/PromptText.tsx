import { MarkdownBody } from "./MarkdownBody";

/** Decision prompts use the same safe Markdown and reference media as task chat. */
export function PromptText({ children }: { children: string }) {
  return <MarkdownBody className="paperclip-markdown-on-accent" mediaMode="reference">{children}</MarkdownBody>;
}
