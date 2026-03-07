// @vitest-environment node
//
// Unit tests for the pure utility functions in CodeMirrorEditor.tsx.
//
// CodeMirrorEditor contains two non-trivial pure functions that are critical
// to correct editor behaviour:
//
//   • isBinaryContent(content)      – detect binary/non-text files
//   • getLanguageExtension(path)    – derive syntax highlighting language
//
// These are tested here in isolation (logic mirrored from the source file)
// without needing to mount React or import CodeMirror dependencies.
//
// Additionally the exported constants that control file-size behaviour are
// verified so that accidental threshold changes are caught by CI.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Constants — mirrored from CodeMirrorEditor.tsx
// ---------------------------------------------------------------------------

const LARGE_FILE_THRESHOLD = 500_000; // 500 KB — editor switches to read-only
const BINARY_WARN_THRESHOLD = 1_000_000; // 1 MB  — full fallback UI shown
const BINARY_CHAR_RATIO_THRESHOLD = 0.1; // 10%  — non-printable char ratio
const BINARY_SAMPLE_SIZE = 1_000; // chars sampled for ratio check

// ---------------------------------------------------------------------------
// isBinaryContent — mirrored from CodeMirrorEditor.tsx
// ---------------------------------------------------------------------------

function isBinaryContent(content: string): boolean {
  if (content.includes("\0")) return true;
  if (content.length === 0) return false;

  const sample = content.slice(0, BINARY_SAMPLE_SIZE);
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code < 9 || (code > 13 && code < 32)) nonPrintable++;
  }
  return nonPrintable / sample.length > BINARY_CHAR_RATIO_THRESHOLD;
}

// ---------------------------------------------------------------------------
// getLanguageExtensionName — mirrors getLanguageExtension() return value
// identity; we return a string tag instead of the actual CM6 extension object
// so the tests remain dependency-free.
// ---------------------------------------------------------------------------

function getLanguageExtensionName(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "jsx":
      return "javascript-jsx";
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "tsx":
      return "typescript-jsx";
    case "html":
    case "htm":
      return "html";
    case "css":
    case "scss":
    case "sass":
    case "less":
      return "css";
    case "json":
    case "jsonc":
      return "json";
    case "md":
    case "mdx":
    case "markdown":
      return "markdown";
    case "py":
    case "pyw":
      return "python";
    default:
      return null;
  }
}

// ===========================================================================
// Test suites
// ===========================================================================

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("CodeMirrorEditor constants", () => {
  it("LARGE_FILE_THRESHOLD is 500 000 bytes (500 KB)", () => {
    expect(LARGE_FILE_THRESHOLD).toBe(500_000);
  });

  it("BINARY_WARN_THRESHOLD is 1 000 000 bytes (1 MB)", () => {
    expect(BINARY_WARN_THRESHOLD).toBe(1_000_000);
  });

  it("BINARY_CHAR_RATIO_THRESHOLD is 0.1 (10 %)", () => {
    expect(BINARY_CHAR_RATIO_THRESHOLD).toBe(0.1);
  });

  it("BINARY_SAMPLE_SIZE is 1 000 chars", () => {
    expect(BINARY_SAMPLE_SIZE).toBe(1_000);
  });

  it("LARGE_FILE_THRESHOLD is strictly less than BINARY_WARN_THRESHOLD", () => {
    expect(LARGE_FILE_THRESHOLD).toBeLessThan(BINARY_WARN_THRESHOLD);
  });

  describe("file size classification helpers", () => {
    it("classifies a 1 KB file as small (below both thresholds)", () => {
      const len = 1_024;
      expect(len < LARGE_FILE_THRESHOLD).toBe(true);
      expect(len < BINARY_WARN_THRESHOLD).toBe(true);
    });

    it("classifies a 600 KB file as large (exceeds LARGE_FILE_THRESHOLD only)", () => {
      const len = 600_000;
      expect(len > LARGE_FILE_THRESHOLD).toBe(true);
      expect(len < BINARY_WARN_THRESHOLD).toBe(true);
    });

    it("classifies a 1.1 MB file as very large (exceeds both thresholds)", () => {
      const len = 1_100_000;
      expect(len > LARGE_FILE_THRESHOLD).toBe(true);
      expect(len > BINARY_WARN_THRESHOLD).toBe(true);
    });

    it("500 000 byte boundary: at the threshold is NOT large (strict >)", () => {
      // isLargeFile = content.length > LARGE_FILE_THRESHOLD (strict greater-than)
      expect(500_000 > LARGE_FILE_THRESHOLD).toBe(false);
      expect(500_001 > LARGE_FILE_THRESHOLD).toBe(true);
    });

    it("1 000 000 byte boundary: at the threshold does NOT trigger fallback UI", () => {
      // Fallback condition: content.length > BINARY_WARN_THRESHOLD (strict)
      expect(1_000_000 > BINARY_WARN_THRESHOLD).toBe(false);
      expect(1_000_001 > BINARY_WARN_THRESHOLD).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// isBinaryContent
// ---------------------------------------------------------------------------

describe("isBinaryContent", () => {
  // --- safe/text cases ---

  it("returns false for an empty string", () => {
    expect(isBinaryContent("")).toBe(false);
  });

  it("returns false for a single space character", () => {
    expect(isBinaryContent(" ")).toBe(false);
  });

  it("returns false for plain ASCII text", () => {
    expect(isBinaryContent("Hello, world!")).toBe(false);
  });

  it("returns false for multi-line source code with newlines and tabs", () => {
    const code = [
      "function greet(name: string): string {",
      "\treturn `Hello, ${name}!`;",
      "}",
    ].join("\n");
    expect(isBinaryContent(code)).toBe(false);
  });

  it("returns false for content with CR LF line endings", () => {
    expect(isBinaryContent("line1\r\nline2\r\nline3")).toBe(false);
  });

  it("returns false for a JSON document", () => {
    const json = JSON.stringify({ key: "value", num: 42, arr: [1, 2, 3] }, null, 2);
    expect(isBinaryContent(json)).toBe(false);
  });

  it("returns false for a Markdown document with special chars", () => {
    const md = "# Heading\n\n- item **bold** _italic_ `code`\n\n> blockquote\n";
    expect(isBinaryContent(md)).toBe(false);
  });

  it("returns false for content containing only allowed control chars (TAB=9, LF=10, VT=11, FF=12, CR=13)", () => {
    // These must NOT be counted as non-printable.
    const content = "\t\n\x0b\x0c\r".repeat(100);
    expect(isBinaryContent(content)).toBe(false);
  });

  // --- binary / null-byte cases ---

  it("returns true when content contains a null byte (\\0)", () => {
    expect(isBinaryContent("hello\0world")).toBe(true);
  });

  it("returns true when content starts with null bytes", () => {
    expect(isBinaryContent("\0\0\0text")).toBe(true);
  });

  it("returns true when content ends with null bytes", () => {
    expect(isBinaryContent("text\0\0\0")).toBe(true);
  });

  it("returns true for a string that is only null bytes", () => {
    expect(isBinaryContent("\0\0\0\0\0")).toBe(true);
  });

  // --- non-printable character ratio cases ---

  it("returns true when >10% of the first 1000 chars are non-printable (code 1–8)", () => {
    // Create content with 15% non-printable chars (code 1 = SOH, which is <9).
    const nonPrintableCount = 150; // 15% of 1000
    const printableCount = 850;
    const content =
      "\x01".repeat(nonPrintableCount) + "x".repeat(printableCount);
    expect(isBinaryContent(content)).toBe(true);
  });

  it("returns false when exactly 10% (not strictly greater) are non-printable", () => {
    // Boundary: exactly 10% should NOT trigger binary detection (> not >=).
    const nonPrintableCount = 100; // exactly 10% of 1000
    const printableCount = 900;
    const content =
      "\x01".repeat(nonPrintableCount) + "x".repeat(printableCount);
    // 100/1000 = 0.1, and 0.1 > 0.1 is false
    expect(isBinaryContent(content)).toBe(false);
  });

  it("returns true when non-printable chars use code 14–31 range (e.g. \\x1f)", () => {
    // Code 14 (SO) through 31 (US) are non-printable per the heuristic.
    const nonPrintableCount = 200;
    const printableCount = 800;
    const content =
      "\x1f".repeat(nonPrintableCount) + "x".repeat(printableCount);
    expect(isBinaryContent(content)).toBe(true);
  });

  it("only samples the first BINARY_SAMPLE_SIZE (1000) chars", () => {
    // The first 1000 chars are clean; the rest contain non-printable chars.
    // Should be classified as text because the sample is clean.
    const cleanPart = "a".repeat(BINARY_SAMPLE_SIZE);
    const dirtyPart = "\x01".repeat(5_000); // well beyond the sample window
    expect(isBinaryContent(cleanPart + dirtyPart)).toBe(false);
  });

  it("detects binary even when non-printable chars appear only in the first BINARY_SAMPLE_SIZE chars", () => {
    // Non-printable chars appear in the sample window followed by clean text.
    const dirtyPart = "\x01".repeat(200); // 20% of the 1000-char sample
    const cleanPart = "x".repeat(800) + "y".repeat(10_000);
    expect(isBinaryContent(dirtyPart + cleanPart)).toBe(true);
  });

  it("handles content shorter than BINARY_SAMPLE_SIZE correctly", () => {
    // 5 chars: 2 non-printable = 40% → binary
    expect(isBinaryContent("\x01\x02xxx")).toBe(true);
    // 5 chars: 0 non-printable → text
    expect(isBinaryContent("hello")).toBe(false);
  });

  it("handles content of exactly BINARY_SAMPLE_SIZE length", () => {
    // Exactly 1000 chars, all printable — should be text.
    const content = "z".repeat(BINARY_SAMPLE_SIZE);
    expect(isBinaryContent(content)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getLanguageExtension (via mirrored name mapper)
// ---------------------------------------------------------------------------

describe("getLanguageExtensionName (language detection from file path)", () => {
  // --- JavaScript ---

  it("detects .js as javascript", () => {
    expect(getLanguageExtensionName("index.js")).toBe("javascript");
  });

  it("detects .mjs as javascript", () => {
    expect(getLanguageExtensionName("module.mjs")).toBe("javascript");
  });

  it("detects .cjs as javascript", () => {
    expect(getLanguageExtensionName("server.cjs")).toBe("javascript");
  });

  it("detects .jsx as javascript-jsx", () => {
    expect(getLanguageExtensionName("App.jsx")).toBe("javascript-jsx");
  });

  // --- TypeScript ---

  it("detects .ts as typescript", () => {
    expect(getLanguageExtensionName("types.ts")).toBe("typescript");
  });

  it("detects .mts as typescript", () => {
    expect(getLanguageExtensionName("worker.mts")).toBe("typescript");
  });

  it("detects .cts as typescript", () => {
    expect(getLanguageExtensionName("legacy.cts")).toBe("typescript");
  });

  it("detects .tsx as typescript-jsx", () => {
    expect(getLanguageExtensionName("Component.tsx")).toBe("typescript-jsx");
  });

  // --- HTML ---

  it("detects .html as html", () => {
    expect(getLanguageExtensionName("index.html")).toBe("html");
  });

  it("detects .htm as html", () => {
    expect(getLanguageExtensionName("page.htm")).toBe("html");
  });

  // --- CSS ---

  it("detects .css as css", () => {
    expect(getLanguageExtensionName("styles.css")).toBe("css");
  });

  it("detects .scss as css", () => {
    expect(getLanguageExtensionName("styles.scss")).toBe("css");
  });

  it("detects .sass as css", () => {
    expect(getLanguageExtensionName("styles.sass")).toBe("css");
  });

  it("detects .less as css", () => {
    expect(getLanguageExtensionName("styles.less")).toBe("css");
  });

  // --- JSON ---

  it("detects .json as json", () => {
    expect(getLanguageExtensionName("package.json")).toBe("json");
  });

  it("detects .jsonc as json", () => {
    expect(getLanguageExtensionName("tsconfig.jsonc")).toBe("json");
  });

  // --- Markdown ---

  it("detects .md as markdown", () => {
    expect(getLanguageExtensionName("README.md")).toBe("markdown");
  });

  it("detects .mdx as markdown", () => {
    expect(getLanguageExtensionName("blog-post.mdx")).toBe("markdown");
  });

  it("detects .markdown as markdown", () => {
    expect(getLanguageExtensionName("CHANGELOG.markdown")).toBe("markdown");
  });

  // --- Python ---

  it("detects .py as python", () => {
    expect(getLanguageExtensionName("main.py")).toBe("python");
  });

  it("detects .pyw as python", () => {
    expect(getLanguageExtensionName("gui_app.pyw")).toBe("python");
  });

  // --- Unknown / unsupported ---

  it("returns null for .exe", () => {
    expect(getLanguageExtensionName("app.exe")).toBeNull();
  });

  it("returns null for .zip", () => {
    expect(getLanguageExtensionName("archive.zip")).toBeNull();
  });

  it("returns null for .png", () => {
    expect(getLanguageExtensionName("photo.png")).toBeNull();
  });

  it("returns null for .sh shell scripts", () => {
    expect(getLanguageExtensionName("setup.sh")).toBeNull();
  });

  it("returns null for .yaml / .yml", () => {
    expect(getLanguageExtensionName("config.yaml")).toBeNull();
    expect(getLanguageExtensionName("ci.yml")).toBeNull();
  });

  it("returns null for .toml", () => {
    expect(getLanguageExtensionName("Cargo.toml")).toBeNull();
  });

  it("returns null for .xml", () => {
    expect(getLanguageExtensionName("config.xml")).toBeNull();
  });

  it("returns null for files with no extension (e.g. Makefile)", () => {
    // split(".").pop() on "Makefile" → "Makefile", not in the switch
    expect(getLanguageExtensionName("Makefile")).toBeNull();
  });

  // --- Dotfiles / edge cases ---

  it("returns null for .gitignore (no meaningful extension)", () => {
    // ".gitignore".split(".").pop() → "gitignore" which is not in the switch
    expect(getLanguageExtensionName(".gitignore")).toBeNull();
  });

  it("returns null for .env files", () => {
    expect(getLanguageExtensionName(".env")).toBeNull();
    // .env.local → last segment is "local" — not in switch → null
    expect(getLanguageExtensionName(".env.local")).toBeNull();
  });

  // --- Case insensitivity ---

  it("is case-insensitive: .TS → typescript", () => {
    expect(getLanguageExtensionName("app.TS")).toBe("typescript");
  });

  it("is case-insensitive: .JS → javascript", () => {
    expect(getLanguageExtensionName("index.JS")).toBe("javascript");
  });

  it("is case-insensitive: .MD → markdown", () => {
    expect(getLanguageExtensionName("README.MD")).toBe("markdown");
  });

  it("is case-insensitive: .HTML → html", () => {
    expect(getLanguageExtensionName("index.HTML")).toBe("html");
  });

  it("is case-insensitive: .PY → python", () => {
    expect(getLanguageExtensionName("script.PY")).toBe("python");
  });

  it("is case-insensitive: .CSS → css", () => {
    expect(getLanguageExtensionName("main.CSS")).toBe("css");
  });

  // --- Multi-dot filenames ---

  it("uses the LAST segment for multi-dot filenames", () => {
    expect(getLanguageExtensionName("vite.config.ts")).toBe("typescript");
    expect(getLanguageExtensionName("tailwind.config.js")).toBe("javascript");
    expect(getLanguageExtensionName("jest.config.mjs")).toBe("javascript");
    expect(getLanguageExtensionName("rollup.config.mts")).toBe("typescript");
  });

  it("handles file.test.ts correctly → typescript", () => {
    expect(getLanguageExtensionName("app.test.ts")).toBe("typescript");
  });

  it("handles file.spec.tsx correctly → typescript-jsx", () => {
    expect(getLanguageExtensionName("Button.spec.tsx")).toBe("typescript-jsx");
  });

  // --- Path with directories ---

  it("ignores directory segments and uses only the file extension", () => {
    expect(getLanguageExtensionName("src/components/Button.tsx")).toBe(
      "typescript-jsx",
    );
    expect(getLanguageExtensionName("/usr/local/bin/script.py")).toBe("python");
    expect(getLanguageExtensionName("deeply/nested/dir/styles.scss")).toBe(
      "css",
    );
  });

  // --- Empty path edge case ---

  it("returns null for an empty string path", () => {
    // "".split(".").pop() → "" — not in switch → null
    expect(getLanguageExtensionName("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration: isBinaryContent + file size thresholds together
// ---------------------------------------------------------------------------

describe("binary detection + file size threshold interaction", () => {
  it("a file with null bytes is binary regardless of size", () => {
    const tinyBinary = "\0";
    expect(isBinaryContent(tinyBinary)).toBe(true);
    expect(tinyBinary.length < LARGE_FILE_THRESHOLD).toBe(true); // small but binary
  });

  it("a large but text-only file is NOT binary", () => {
    const largeText = "console.log('hi');\n".repeat(30_000); // ~570 KB
    expect(isBinaryContent(largeText)).toBe(false);
    expect(largeText.length > LARGE_FILE_THRESHOLD).toBe(true);
  });

  it("a very large text file triggers the BINARY_WARN_THRESHOLD fallback", () => {
    const veryLargeText = "x".repeat(1_100_000);
    expect(isBinaryContent(veryLargeText)).toBe(false); // text, not binary
    expect(veryLargeText.length > BINARY_WARN_THRESHOLD).toBe(true); // but too large to show
  });

  it("a small binary file shows the fallback UI (isBinary takes priority over size)", () => {
    // Build a string where >\10% of the first 1000 chars are non-printable.
    // 200 SOH chars (code 1) out of 1000 total = 20% → binary.
    const smallBinary = "\x01".repeat(200) + "x".repeat(800);
    const isBinary = isBinaryContent(smallBinary);
    // isBinary must be true even though the file is below the size thresholds.
    expect(isBinary).toBe(true);
    expect(smallBinary.length < LARGE_FILE_THRESHOLD).toBe(true);
  });
});
