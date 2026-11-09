import { describe, expect, it } from "vitest";
import { buildAlreadyImportedMessage } from "./company-import-transfer.js";

describe("buildAlreadyImportedMessage", () => {
  it("names the landed company with its prefix", () => {
    expect(
      buildAlreadyImportedMessage({ id: "company-2", name: "Paperclip", issuePrefix: "PAPA" }),
    ).toBe(
      'This exact package was already imported by a completed transfer. The earlier import landed in the company "Paperclip" (PAPA) — open it from the company switcher. Re-export the package to import it again.',
    );
  });

  it("falls back to the company id when the name is gone and omits an absent prefix", () => {
    expect(
      buildAlreadyImportedMessage({ id: "company-2", name: null, issuePrefix: null }),
    ).toBe(
      'This exact package was already imported by a completed transfer. The earlier import landed in the company "company-2" — open it from the company switcher. Re-export the package to import it again.',
    );
  });

  it("keeps the original message when no company is known", () => {
    expect(buildAlreadyImportedMessage(null)).toBe(
      "This exact package was already imported by a completed transfer. Re-export the package to import it again.",
    );
    expect(buildAlreadyImportedMessage(undefined)).toBe(
      "This exact package was already imported by a completed transfer. Re-export the package to import it again.",
    );
  });
});
