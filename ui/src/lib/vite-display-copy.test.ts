import { describe, expect, it } from "vitest";
import { cleanJsxText, decodeJsxEntities, transformDisplayCopy } from "./vite-display-copy";

function transform(source: string, id = "/repo/ui/src/Example.tsx") {
  return transformDisplayCopy(source, id);
}

describe("transformDisplayCopy", () => {
  it("wraps JSX labels and display attributes but leaves data and payload values alone", () => {
    const result = transform(
      'export function Example({ user }) { const payload = { name: "New Agent", status: "done" }; return <><h1>New Agent</h1><p>{user.name}</p><input value={user.name} placeholder="Search agents" /></>; }',
    );
    expect(result?.code).toContain('__paperclipDisplayText("New Agent")');
    expect(result?.code).toContain('placeholder={__paperclipDisplayText("Search agents")}');
    expect(result?.code).toContain('name: "New Agent"');
    expect(result?.code).toContain("value={user.name}");
    expect(result?.code).toContain('import { displayText as __paperclipDisplayText } from "@/i18n/display-text";');
    expect(result?.strings).toEqual(["New Agent", "Search agents"]);
  });

  it("skips code, editable content, opted-out zones and options that submit their text", () => {
    const result = transform(
      'export function Demo() { return <><pre>Run this command</pre><code>Sample code</code><textarea>Enter content</textarea><div contentEditable>Write here</div><div data-no-translate>Keep this</div><select><option>Submit me</option><option value="a">Show me</option></select><p>Save changes</p></>; }',
    );
    expect(result?.strings).toEqual(["Save changes", "Show me"]);
    expect(result?.code).toContain("<pre>Run this command</pre>");
    expect(result?.code).toContain("<option>Submit me</option>");
  });

  it("keeps interpolated values out of the translated sentence", () => {
    const result = transform("export function Demo({ count }) { return <p title={`Found ${count} agents`}>{`Found ${count} agents`}</p>; }");
    expect(result?.strings).toEqual(["Found {{v0}} agents"]);
    expect(result?.code).toContain('__paperclipDisplayText("Found {{v0}} agents", { v0: (count) })');
  });

  it("wraps both branches of conditionals and the fallback of logical expressions", () => {
    const result = transform('export function Demo({ open, label }) { return <span>{open ? "Close panel" : "Open panel"}{label || "No label"}</span>; }');
    expect(result?.strings).toEqual(["Close panel", "No label", "Open panel"]);
  });

  it("matches the JSX whitespace and entity rules", () => {
    expect(cleanJsxText("\n      Sign in\n      to continue\n    ")).toBe("Sign in to continue");
    expect(cleanJsxText(" Hello ")).toBe(" Hello ");
    expect(decodeJsxEntities("Don&apos;t &amp; won&#39;t&nbsp;stop")).toBe("Don't & won't\u00a0stop");
    expect(decodeJsxEntities("Unknown &zwsp; entity")).toBeNull();
    const result = transform("export const Demo = () => <p>Don&apos;t stop</p>;");
    expect(result?.strings).toEqual(["Don't stop"]);
  });

  it("keeps the original line count so later lines keep their positions", () => {
    const source = "export function Demo() {\n  return (\n    <p>\n      First line\n      second line\n    </p>\n  );\n}\n";
    const result = transform(source);
    const lines = result?.code.split("\n") ?? [];
    expect(lines.slice(0, source.split("\n").length - 1).join("\n").split("\n")).toHaveLength(source.split("\n").length - 1);
    expect(lines[6]).toBe("  );");
  });

  it("ignores tests, stories and plain TypeScript modules", () => {
    expect(transform("export const A = () => <p>Hello there</p>;", "/repo/ui/src/A.test.tsx")).toBeNull();
    expect(transform("export const A = () => <p>Hello there</p>;", "/repo/ui/src/A.stories.tsx")).toBeNull();
    expect(transform('export const label = "Hello there";', "/repo/ui/src/a.ts")).toBeNull();
    expect(transform("export const A = () => <p>{count}</p>;")).toBeNull();
  });
});
