import { describe, expect, it } from "vitest";
import { $createLinkNode } from "@lexical/link";
import { createEditor } from "lexical";
import {
  MentionAwareLinkNode,
  getMentionAwareLinkNodeInit,
  mentionAwareLinkNodeReplacement,
} from "./mention-aware-link-node";

function createTestEditor() {
  return createEditor({
    namespace: "mention-aware-link-node-test",
    nodes: [MentionAwareLinkNode, mentionAwareLinkNodeReplacement],
    onError(error: Error) {
      throw error;
    },
  });
}

describe("getMentionAwareLinkNodeInit", () => {
  it("copies link attributes without carrying over a node key", () => {
    const init = getMentionAwareLinkNodeInit({
      getURL: () => "agent://agent-123",
      getRel: () => "noreferrer",
      getTarget: () => "_blank",
      getTitle: () => "Agent mention",
    });

    expect(Object.keys(init)).toEqual(["url", "attributes"]);
    expect(init).toEqual({
      url: "agent://agent-123",
      attributes: {
        rel: "noreferrer",
        target: "_blank",
        title: "Agent mention",
      },
    });
  });

  it("replaces LinkNode creation with MentionAwareLinkNode without throwing", () => {
    const editor = createTestEditor();
    let created: unknown;

    editor.update(() => {
      created = $createLinkNode("agent://agent-123");
    });

    expect(created).toBeInstanceOf(MentionAwareLinkNode);
  });

  it.each([
    "agent://agent-123?i=code",
    "project://project-123?c=0f766e",
    "user://user-123",
    "skill://skill-123?s=test-it-for-real",
    "routine://routine-123",
    "/issues/PAP-123",
  ])("preserves the rich-chip destination %s", (href) => {
    const editor = createTestEditor();
    let renderedUrl: string | undefined;
    editor.update(() => {
      renderedUrl = $createLinkNode(href).sanitizeUrl(href);
    });
    expect(renderedUrl).toBe(href);
  });

  it("still blocks executable link destinations", () => {
    const editor = createTestEditor();
    let renderedUrl: string | undefined;
    editor.update(() => {
      renderedUrl = $createLinkNode("javascript:alert(1)").sanitizeUrl("javascript:alert(1)");
    });
    expect(renderedUrl).toBe("about:blank");
  });
});
