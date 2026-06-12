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

  it("self-write does not re-trigger translation (guard is load-bearing)", async () => {
    // Cyclic dictionary: X<->Y. Without the loop guard, the engine's own write
    // re-triggers the observer, which re-translates Y back to X, ad infinitum.
    // The guard is the ONLY thing that stops this thrashing, so this test fails
    // (assertion or runaway) if the guard is removed.
    const cyclic = { text: { "Run routine": "Routine ausführen", "Routine ausführen": "Run routine" } };
    document.body.innerHTML = ``;
    const t = createTranslator(cyclic, { root: document.body });
    t.start();
    // Add the node AFTER start() so the observer (not the synchronous initial
    // translateTree) handles it — this is what exercises the self-write path.
    const btn = document.createElement("button");
    const node = document.createTextNode("Run routine");
    btn.appendChild(node);
    // Count the engine's own writes directly via the nodeValue setter. Cap the
    // count so a broken guard fails the assertion instead of hanging forever.
    let writes = 0;
    const desc = Object.getOwnPropertyDescriptor(Node.prototype, "nodeValue")!;
    Object.defineProperty(node, "nodeValue", {
      configurable: true,
      get() { return desc.get!.call(this); },
      set(v) { if (++writes > 50) return; desc.set!.call(this, v); },
    });
    document.body.appendChild(btn);
    await flush(); await flush(); await flush();
    delete (node as any).nodeValue; // restore prototype accessor
    t.stop();
    expect(writes).toBe(1); // only the engine's own write; guard stops re-translation
    expect(node.nodeValue).toBe("Routine ausführen"); // settled, not flipped back
  });
});
