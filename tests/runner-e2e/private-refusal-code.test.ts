import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { fixedRefusalMessages, privateRefusalCode } from "./private-refusal-code.js";

it("names only fixed literal refusals from the trusted evidence modules", () => {
  const fixed = fixedRefusalMessages();
  expect(fixed.has("Contaminated private evidence cannot be uploaded")).toBe(true);
  expect(fixed.has("Original evidence byte accounting changed")).toBe(true);
  expect(privateRefusalCode(new Error("Contaminated private evidence cannot be uploaded"))).toBe("contaminated-private-evidence-cannot-be-uploaded");
});

it("never returns the text of a dynamic or system message", () => {
  const leaked = "/home/runner/_work/private/secret-token-abc";
  expect(privateRefusalCode(new Error(`Secret leak in ${leaked}`))).toBe("dynamic");
  expect(privateRefusalCode(Object.assign(new Error(`ENOENT: no such file, open '${leaked}'`), { code: "ENOENT" }))).toBe("fs-ENOENT");
  expect(privateRefusalCode(new TypeError(`bad ${leaked}`))).toBe("error-type-TypeError");
  expect(privateRefusalCode(leaked)).toBe("non-error-thrown");
  for (const value of [new Error(`x ${leaked}`), new TypeError(leaked), leaked]) expect(privateRefusalCode(value)).not.toContain("secret");
});

it("names refusals from the dispatch-authority and admission modules the transfer calls", () => {
  const fixed = fixedRefusalMessages();
  for (const file of ["manual-dispatch-authority.ts", "testops-chat-admission.ts"]) {
    const literals = [...readFileSync(new URL(`./${file}`, import.meta.url), "utf8").matchAll(/new Error\("([^"$`\\]+)"\)/g)].map(match => match[1]!);
    expect(literals.length, file).toBeGreaterThan(0);
    for (const message of literals) expect(privateRefusalCode(new Error(message), fixed), message).not.toBe("dynamic");
  }
});
