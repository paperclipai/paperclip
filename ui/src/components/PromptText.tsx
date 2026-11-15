import type { ComponentProps } from "react";
import { MarkdownBody } from "./MarkdownBody";

/** Decision prompts use the same safe Markdown and reference media as task chat. */
export function PromptText({ children }: { children: string }) {
  return <MarkdownBody className="paperclip-markdown-on-accent" mediaMode="reference">{children}</MarkdownBody>;
}

/**
 * Secondary card text (help text, notes): the same safe Markdown, but it keeps
 * its container's size, line height and color, so a small muted line stays one.
 */
export function SecondaryMarkdownText({ children, ...props }: Omit<ComponentProps<typeof MarkdownBody>, "className" | "mediaMode">) {
  return <MarkdownBody {...props} className="paperclip-markdown-on-accent paperclip-markdown-inherit" mediaMode="reference">{children}</MarkdownBody>;
}
