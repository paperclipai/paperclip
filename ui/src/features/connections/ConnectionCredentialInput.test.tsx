// @vitest-environment jsdom
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionCredentialInput } from "./ConnectionCredentialInput";

const pem = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
let dispose: () => void;
afterEach(() => dispose?.());

function Form({ configPath }: { configPath: string }) {
  const [value, setValue] = useState("");
  return <form><ConnectionCredentialInput configPath={configPath} value={value} onChange={setValue} /><output>{value}</output></form>;
}
function render(configPath: string) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<Form configPath={configPath} />));
  dispose = () => { act(() => root.unmount()); container.remove(); };
  return container;
}

describe("shared setup and reconnect credential input", () => {
  it.each(["\n", "\r\n"])("preserves a multiline RSA PEM with %j line endings and later edits", (ending) => {
    const container = render("credentials.privateKey");
    const input = container.querySelector("textarea")!;
    expect(input).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, pem.replace(/\n/g, ending));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector("output")!.textContent).toBe(pem);
    expect(createPrivateKey(container.querySelector("output")!.textContent!).asymmetricKeyType).toBe("rsa");

    act(() => { setter.call(input, pem + "\n"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(container.querySelector("output")!.textContent).toBe(pem + "\n");
    expect(createPrivateKey(container.querySelector("output")!.textContent!).asymmetricKeyType).toBe("rsa");
  });

  it("masks PEMs by default, reveals only on request, and explains secret storage", () => {
    const container = render("credentials.privateKey");
    const textarea = container.querySelector("textarea")!;
    expect(textarea.classList.contains("secret-textarea")).toBe(true);
    expect(textarea.autocomplete).toBe("off");
    expect(textarea.getAttribute("spellcheck")).toBe("false");
    const button = container.querySelector("button")!;
    expect(button.type).toBe("button");
    act(() => button.click());
    expect(textarea.classList.contains("secret-textarea")).toBe(false);
    expect(button.textContent).toBe("Hide private key");
    act(() => button.click());
    expect(textarea.classList.contains("secret-textarea")).toBe(true);
    expect(container.textContent).toContain("automatically stores this key as an encrypted secret");
  });

  it("keeps other credentials masked", () => {
    const container = render("credentials.token");
    expect(container.querySelector("input")!.type).toBe("password");
    expect(container.querySelector("textarea")).toBeNull();
  });
});
