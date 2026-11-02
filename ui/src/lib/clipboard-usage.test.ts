import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIRECT_CLIPBOARD_WRITE = /navigator\.clipboard|document\.execCommand/;
/** Any affordance that tells the reader the copy landed (or didn't). */
const COPY_FEEDBACK =
  /useCopyAction|useCopyToast|copyWithToast|CopyValueButton|CopyDetailsButton|setCopied|pushToast|showCopyFeedback|setCopyStatus|Copied/i;

function sourceFiles(root: URL): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), root);
    if (entry.isDirectory()) return sourceFiles(url);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [fileURLToPath(url)];
  });
}

describe("clipboard usage", () => {
  it("routes core and first-party plugin copy actions through shared helpers", () => {
    const coreSource = new URL("../", import.meta.url);
    const pluginSource = new URL("../../../packages/plugins/plugin-workspace-diff/src/ui/", import.meta.url);
    const violations = [...sourceFiles(coreSource), ...sourceFiles(pluginSource)]
      .filter((file) => !file.replaceAll("\\", "/").endsWith("/lib/clipboard.ts"))
      .filter((file) => DIRECT_CLIPBOARD_WRITE.test(readFileSync(file, "utf8")));

    expect(violations).toEqual([]);
  });

  it("gives every copy action some way to say whether it worked", () => {
    // A copy that says nothing is indistinguishable from a copy that failed,
    // which is the whole complaint. Whichever affordance a site picks — the
    // inline swap from `useCopyAction`, a toast from `useCopyToast`, or a
    // hand-rolled `copied` state — it has to pick one.
    //
    // Scope, so nobody reads more into a pass than it earns: this catches
    // *silence*. It cannot prove the affordance waits for the write to
    // resolve — a dozen sites name their state differently enough that
    // demanding a known helper would flag nine working buttons. The
    // swallowed-rejection check below covers the specific way a site claims
    // success it did not earn; `AdapterLoginChrome.test.tsx` and
    // `use-copy-action.test.ts` hold the behavioral line per site.
    const silent = sourceFiles(new URL("../", import.meta.url))
      .filter((file) => !file.replaceAll("\\", "/").endsWith("/lib/clipboard.ts"))
      .flatMap((file) => {
        const lines = readFileSync(file, "utf8").split("\n");
        return lines.flatMap((line, index) => {
          if (!line.includes("copyTextToClipboard(")) return [];
          if (line.includes("import") || line.includes("export")) return [];
          const near = lines.slice(Math.max(0, index - 8), index + 9).join("\n");
          return COPY_FEEDBACK.test(near) ? [] : [`${file}:${index + 1}`];
        });
      });

    expect(silent).toEqual([]);
  });

  it("never discards a copy rejection", () => {
    // The precise way a copy button lies: hand the promise an empty rejection
    // handler, then show a success state the write never earned. That is the
    // pattern all eleven silent sites had, and the one
    // `AdapterLoginChrome.test.tsx` refuses for its own button.
    const swallowed = sourceFiles(new URL("../", import.meta.url))
      .filter((file) => !file.replaceAll("\\", "/").endsWith("/lib/clipboard.ts"))
      .flatMap((file) => {
        const source = readFileSync(file, "utf8");
        const lines = source.split("\n");
        return lines.flatMap((line, index) => {
          if (!line.includes("copyTextToClipboard(")) return [];
          if (line.includes("import") || line.includes("export")) return [];
          // The handler can wrap onto the next lines, so read forward a little.
          const after = lines.slice(index, index + 6).join("\n");
          return /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)|,\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(after)
            ? [`${file}:${index + 1}`]
            : [];
        });
      });

    expect(swallowed).toEqual([]);
  });
});
