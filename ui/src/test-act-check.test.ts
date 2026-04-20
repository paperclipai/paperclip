// @vitest-environment node
import { createEditor } from "lexical";
import { $createLinkNode, LinkNode } from "@lexical/link";
import { it, expect } from "vitest";

it("lexical createEditor should work", () => {
  const editor = createEditor({ namespace: "test", nodes: [LinkNode], onError: (e) => { throw e; } });
  expect(typeof createEditor).toBe("function");
  expect(typeof $createLinkNode).toBe("function");
});

