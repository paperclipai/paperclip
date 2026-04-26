// @vitest-environment node

import { describe, expect, it } from "vitest";
import { remarkSoftBreaks } from "./remark-soft-breaks";

// ============================================================================
// Helper to build a minimal markdown tree
// ============================================================================

type TextNode = { type: "text"; value: string };
type BreakNode = { type: "break" };
type ParentNode = { type?: string; children: Array<TextNode | BreakNode | ParentNode> };

function makeTree(children: Array<TextNode | BreakNode | ParentNode>): ParentNode {
  return { children };
}

function text(value: string): TextNode {
  return { type: "text", value };
}

function applyPlugin(tree: ParentNode): ParentNode {
  const transform = remarkSoftBreaks();
  transform(tree as Parameters<typeof transform>[0]);
  return tree;
}

// ============================================================================
// remarkSoftBreaks — transformer tests
// ============================================================================

describe("remarkSoftBreaks", () => {
  it("returns a function (transformer)", () => {
    expect(typeof remarkSoftBreaks()).toBe("function");
  });

  it("leaves a tree with no newlines unchanged", () => {
    const tree = makeTree([text("hello world")]);
    applyPlugin(tree);
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]).toEqual({ type: "text", value: "hello world" });
  });

  it("splits a single text node with a newline into text + break + text", () => {
    const tree = makeTree([text("hello\nworld")]);
    applyPlugin(tree);
    expect(tree.children).toHaveLength(3);
    expect(tree.children[0]).toEqual({ type: "text", value: "hello" });
    expect(tree.children[1]).toEqual({ type: "break" });
    expect(tree.children[2]).toEqual({ type: "text", value: "world" });
  });

  it("handles multiple newlines in a single text node", () => {
    const tree = makeTree([text("a\nb\nc")]);
    applyPlugin(tree);
    // Expected: text(a), break, text(b), break, text(c)
    expect(tree.children).toHaveLength(5);
    expect(tree.children[0]).toEqual({ type: "text", value: "a" });
    expect(tree.children[1]).toEqual({ type: "break" });
    expect(tree.children[2]).toEqual({ type: "text", value: "b" });
    expect(tree.children[3]).toEqual({ type: "break" });
    expect(tree.children[4]).toEqual({ type: "text", value: "c" });
  });

  it("handles a leading newline", () => {
    const tree = makeTree([text("\nworld")]);
    applyPlugin(tree);
    // "\n" splits into ["", "world"] → break + text(world)
    expect(tree.children.some((n) => n.type === "break")).toBe(true);
    expect(tree.children.some((n) => n.type === "text" && (n as TextNode).value === "world")).toBe(true);
  });

  it("handles a trailing newline", () => {
    const tree = makeTree([text("hello\n")]);
    applyPlugin(tree);
    // "hello\n" splits into ["hello", ""] → text(hello) + break (empty part skipped)
    expect(tree.children[0]).toEqual({ type: "text", value: "hello" });
    expect(tree.children[1]).toEqual({ type: "break" });
    expect(tree.children).toHaveLength(2);
  });

  it("recursively transforms nested parent nodes", () => {
    const innerParent: ParentNode = makeTree([text("line1\nline2")]);
    const outer = makeTree([innerParent]);
    applyPlugin(outer);
    // The inner tree should be transformed
    expect(innerParent.children).toHaveLength(3);
    expect(innerParent.children[1]).toEqual({ type: "break" });
  });

  it("does not modify break nodes", () => {
    const breakNode: BreakNode = { type: "break" };
    const tree = makeTree([breakNode]);
    applyPlugin(tree);
    expect(tree.children[0]).toEqual({ type: "break" });
  });

  it("processes multiple text nodes independently", () => {
    const tree = makeTree([text("a\nb"), text("c\nd")]);
    applyPlugin(tree);
    // Both text nodes should be split: a, break, b, c, break, d
    expect(tree.children).toHaveLength(6);
    const values = tree.children
      .filter((n) => n.type === "text")
      .map((n) => (n as TextNode).value);
    expect(values).toEqual(["a", "b", "c", "d"]);
  });
});
