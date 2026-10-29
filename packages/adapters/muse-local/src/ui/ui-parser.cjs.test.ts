import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cjsParser = require(path.resolve(__dirname, "../../ui-parser.cjs"));

describe("ui-parser.cjs CommonJS module parity", () => {
  it("exports createStdoutParser and parseStdoutLine", () => {
    expect(typeof cjsParser.createStdoutParser).toBe("function");
    expect(typeof cjsParser.parseStdoutLine).toBe("function");
    expect(typeof cjsParser.createMuseStdoutParser).toBe("function");
    expect(typeof cjsParser.parseMuseStdoutLine).toBe("function");
  });

  it("parses non-json lines as stdout", () => {
    const entries = cjsParser.parseStdoutLine("hello world", "2026-10-28T12:00:00Z");
    expect(entries).toEqual([{ kind: "stdout", ts: "2026-10-28T12:00:00Z", text: "hello world" }]);
  });

  it("parses init event", () => {
    const parser = cjsParser.createStdoutParser();
    const line = JSON.stringify({
      payload_type: "run.model.configured",
      stream: { id: "sess-123" },
      payload: { model: "muse-wonder-1.0" },
    });
    const entries = parser.parseLine(line, "2026-10-28T12:00:00Z");
    expect(entries).toEqual([
      { kind: "init", ts: "2026-10-28T12:00:00Z", model: "muse-wonder-1.0", sessionId: "sess-123" },
    ]);
  });

  it("parses streaming assistant output deltas", () => {
    const parser = cjsParser.createStdoutParser();
    const line = JSON.stringify({
      payload_type: "run.output.delta",
      payload: { text: "Thinking done" },
    });
    const entries = parser.parseLine(line, "2026-10-28T12:00:00Z");
    expect(entries).toEqual([
      { kind: "assistant", ts: "2026-10-28T12:00:00Z", text: "Thinking done", delta: true },
    ]);
  });
});
