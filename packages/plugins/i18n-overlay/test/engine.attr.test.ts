import { describe, it, expect } from "vitest";
import { createTranslator } from "../src/engine";

const dict = {
  text: { "Code label": "Code-Beschriftung" },
  attr: { "Search issues…": "Aufgaben suchen…" },
};

describe("attribute translation + skip", () => {
  it("translates whitelisted attributes", () => {
    document.body.innerHTML = `<input placeholder="Search issues…" />`;
    createTranslator(dict, { root: document.body }).start();
    expect(document.body.querySelector("input")!.getAttribute("placeholder")).toBe("Aufgaben suchen…");
  });

  it("does not translate inside skipped subtrees", () => {
    document.body.innerHTML = `<pre><span>Code label</span></pre>`;
    createTranslator(dict, { root: document.body }).start();
    expect(document.body.textContent).toBe("Code label");
  });

  it("does not translate textarea or contenteditable content", () => {
    document.body.innerHTML = `<div contenteditable="true">Code label</div>`;
    createTranslator(dict, { root: document.body }).start();
    expect(document.body.textContent).toBe("Code label");
  });
});
