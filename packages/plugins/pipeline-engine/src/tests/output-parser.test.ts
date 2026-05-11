import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import { extractOutput, loadSchema, setSchemasDir, validateOutput } from "../output-parser.js";

describe("output-parser", () => {
  beforeAll(() => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    setSchemasDir(resolve(__dirname, "../../schemas"));
  });

  describe("extractOutput", () => {
    it("extracts JSON from sentinel-marked comment", () => {
      const body = `Some discussion here.

<!-- pipeline-output -->
\`\`\`json
{ "status": "pass", "test_results": { "passed": 5, "failed": 0, "skipped": 1 }, "lint_status": "pass", "type_check_status": "pass" }
\`\`\`

Some more text.`;
      const result = extractOutput(body);
      expect(result.found).toBe(true);
      expect(result.data).not.toBeNull();
      expect(result.data!.status).toBe("pass");
    });

    it("returns found:false for comment without sentinel", () => {
      const body = `\`\`\`json\n{ "status": "pass" }\n\`\`\``;
      const result = extractOutput(body);
      expect(result.found).toBe(false);
      expect(result.data).toBeNull();
    });

    it("returns parseError for invalid JSON after sentinel", () => {
      const body = `<!-- pipeline-output -->\n\`\`\`json\n{ invalid json }\n\`\`\``;
      const result = extractOutput(body);
      expect(result.found).toBe(true);
      expect(result.data).toBeNull();
      expect(result.parseError).toBeDefined();
    });

    it("handles multiline JSON", () => {
      const body = `<!-- pipeline-output -->
\`\`\`json
{
  "status": "complete",
  "files_changed": ["src/a.ts", "src/b.ts"],
  "branch": "feat/pipeline",
  "summary": "Added pipeline"
}
\`\`\``;
      const result = extractOutput(body);
      expect(result.found).toBe(true);
      expect(result.data!.files_changed).toHaveLength(2);
    });
  });

  describe("validateOutput", () => {
    it("validates against schema", () => {
      const schema = loadSchema("validation-output");
      const data = {
        status: "pass",
        test_results: { passed: 5, failed: 0, skipped: 0 },
        lint_status: "pass",
        type_check_status: "pass",
      };
      const result = validateOutput(data, schema);
      expect(result.valid).toBe(true);
    });

    it("rejects invalid data", () => {
      const schema = loadSchema("validation-output");
      const data = { status: "invalid_value" };
      const result = validateOutput(data, schema);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBeDefined();
      }
    });
  });
});
