import { describe, it, expect } from "vitest";
import { createTranslator } from "../src/engine";

const dict = { text: { "Run routine": "Routine ausführen" } };

function flush() { return new Promise((r) => setTimeout(r, 0)); }

describe("live observer", () => {
  it("translates nodes added after start()", async () => {
    document.body.innerHTML = ``;
    const t = createTranslator(dict, { root: document.body });
    t.start();
    const btn = document.createElement("button");
    btn.textContent = "Run routine";
    document.body.appendChild(btn);
    await flush();
    expect(btn.textContent).toBe("Routine ausführen");
    t.stop();
  });

  it("does not re-process or loop on its own writes", async () => {
    document.body.innerHTML = `<button>Run routine</button>`;
    const t = createTranslator(dict, { root: document.body });
    t.start();
    await flush();
    await flush();
    expect(document.body.textContent).toBe("Routine ausführen");
    t.stop();
  });

  it("stop() detaches the observer", async () => {
    document.body.innerHTML = ``;
    const t = createTranslator(dict, { root: document.body });
    t.start();
    t.stop();
    const btn = document.createElement("button");
    btn.textContent = "Run routine";
    document.body.appendChild(btn);
    await flush();
    expect(btn.textContent).toBe("Run routine");
  });
});
