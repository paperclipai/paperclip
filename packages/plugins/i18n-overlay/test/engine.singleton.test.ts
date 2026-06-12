import { describe, it, expect } from "vitest";
import { ensureStarted, __resetSingletonForTests } from "../src/engine";

const dict = { text: { "Run routine": "Routine ausführen" } };

describe("singleton", () => {
  it("returns the same translator on repeated calls", () => {
    __resetSingletonForTests();
    document.body.innerHTML = `<button>Run routine</button>`;
    const a = ensureStarted(dict, { root: document.body });
    const b = ensureStarted(dict, { root: document.body });
    expect(a).toBe(b);
    expect(document.body.textContent).toBe("Routine ausführen");
  });
});
