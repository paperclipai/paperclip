import { describe, expect, it } from "vitest";
import { validateLocaleMessages } from "./locale-validation";

describe("localized URL sentence punctuation", () => {
  it("allows Chinese sentence punctuation without treating it as part of the URL", () => {
    expect(validateLocaleMessages(
      { help: "请访问 https://example.com/setup。" },
      { help: "Visit https://example.com/setup." },
    )).toEqual([]);
  });

  it("still rejects a changed destination with localized punctuation", () => {
    expect(validateLocaleMessages(
      { help: "请访问 https://unexpected.example/setup。" },
      { help: "Visit https://example.com/setup." },
    )).toContain("help contains disallowed unexpected URL");
  });

  it("preserves meaningful path, query, and fragment parts", () => {
    expect(validateLocaleMessages(
      { help: "请访问 https://example.com/setup?mode=changed#permissions。" },
      { help: "Visit https://example.com/setup?mode=read#permissions." },
    )).toContain("help contains disallowed unexpected URL");
  });
});
