import { describe, it, expect } from "vitest";
import { createTranslator } from "../src/engine";

const dict = { text: { "Run routine": "Routine ausführen", "No project": "Kein Projekt" } };

describe("text translation", () => {
  it("replaces an exact matching text node", () => {
    document.body.innerHTML = `<button>Run routine</button>`;
    createTranslator(dict, { root: document.body }).start();
    expect(document.body.textContent).toBe("Routine ausführen");
  });

  it("preserves surrounding whitespace", () => {
    document.body.innerHTML = `<span>  No project  </span>`;
    createTranslator(dict, { root: document.body }).start();
    expect(document.body.querySelector("span")!.firstChild!.nodeValue).toBe("  Kein Projekt  ");
  });

  it("leaves unknown strings untranslated (English fallback)", () => {
    document.body.innerHTML = `<span>Custom user title</span>`;
    createTranslator(dict, { root: document.body }).start();
    expect(document.body.textContent).toBe("Custom user title");
  });
});
