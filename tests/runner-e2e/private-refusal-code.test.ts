import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { fixedRefusalMessages, privateRefusalCode, PRIVATE_REFUSAL_MODULES } from "./private-refusal-code.js";

it("names only fixed literal refusals from the trusted evidence modules", () => {
  const fixed = fixedRefusalMessages();
  expect(fixed.has("Contaminated private evidence cannot be uploaded")).toBe(true);
  expect(fixed.has("Original evidence byte accounting changed")).toBe(true);
  expect(privateRefusalCode(new Error("Contaminated private evidence cannot be uploaded"))).toBe("contaminated-private-evidence-cannot-be-uploaded");
});

it("never returns the text of a dynamic or system message", () => {
  const leaked = "/home/runner/_work/private/secret-token-abc";
  expect(privateRefusalCode(new Error(`Unexpected state at ${leaked}`))).toBe("dynamic");
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

it("covers every local module the trusted transfer imports that has fixed refusals", () => {
  const transfer = readFileSync(new URL("./manual-private-transfer.ts", import.meta.url), "utf8");
  const imported = [...transfer.matchAll(/from "\.\/([a-z0-9-]+)\.js"/g)].map(match => `${match[1]}.ts`);
  for (const file of imported.filter(name => name !== "private-refusal-code.ts")) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    if (/new Error\("[^"$`\\]+"\)/.test(source)) expect(PRIVATE_REFUSAL_MODULES as readonly string[], file).toContain(file);
  }
});
it("never throws while naming a refusal", () => {
  const broken = new Proxy(new Set<string>(), { get() { throw new Error("read failed /private/path"); } });
  expect(privateRefusalCode(new Error("x"), broken)).toBe("unnamed");
});

it("names runtime-built refusal templates without their variable parts", () => {
  const secret = "/home/runner/private/token-xyz";
  expect(privateRefusalCode(new Error(`Secret leak in ${secret}: exact secret value`))).toBe("template-secret-leak");
  expect(privateRefusalCode(new Error("Private cell archive exceeds the publication boundary (300 files, 70000000 bytes)"))).toBe("template-publication-boundary-exceeded");
  expect(privateRefusalCode(new Error(`${secret} contains invalid or duplicate file metadata`))).toBe("template-invalid-file-metadata");
  expect(privateRefusalCode(new Error(`Secret leak in ${secret}: x`))).not.toContain("token");
});
it("has a named template for every runtime-built refusal in the trusted modules", () => {
  for (const file of PRIVATE_REFUSAL_MODULES) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    for (const match of source.matchAll(/new Error\(`([^`]+)`\)/g)) {
      const sample = match[1]!.replace(/\$\{[^}]+\}/g, "X").replace(/\(X files, X bytes\)/, "(1 files, 2 bytes)");
      expect(privateRefusalCode(new Error(sample)), `${file}: ${match[1]}`).not.toBe("dynamic");
    }
  }
});
