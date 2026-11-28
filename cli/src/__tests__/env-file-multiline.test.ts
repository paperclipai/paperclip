import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readPaperclipEnvEntries, writePaperclipEnvEntries } from "../config/env.js";

describe("managed env updates with multiline operator values", () => {
  it.each(["'", '"', "`"])("preserves %s values through a file write and dotenv read", (quote) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-multiline-env-"));
    const filePath = path.join(directory, ".env");
    const note = "first line\nPAPERCLIP_HOME=/quoted-example\nlast line";
    const original = `OPERATOR_NOTES=${quote}${note}${quote}\n`;

    try {
      fs.writeFileSync(filePath, original);
      writePaperclipEnvEntries({ PAPERCLIP_HOME: "/new-home" }, filePath);

      expect(fs.readFileSync(filePath, "utf8")).toBe(`${original}PAPERCLIP_HOME=/new-home\n`);
      expect(readPaperclipEnvEntries(filePath)).toEqual({
        OPERATOR_NOTES: note,
        PAPERCLIP_HOME: "/new-home",
      });

      writePaperclipEnvEntries({ PAPERCLIP_HOME: "/updated-home" }, filePath);
      expect(readPaperclipEnvEntries(filePath)).toEqual({
        OPERATOR_NOTES: note,
        PAPERCLIP_HOME: "/updated-home",
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
