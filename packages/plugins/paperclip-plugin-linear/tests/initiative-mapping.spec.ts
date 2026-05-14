import { describe, expect, it } from "vitest";
import { linearInitiativeStatusToPaperclip } from "../src/sync.js";

describe("linearInitiativeStatusToPaperclip", () => {
  it("maps completed → achieved", () => {
    expect(linearInitiativeStatusToPaperclip("completed")).toBe("achieved");
  });

  it("maps cancelled → cancelled", () => {
    expect(linearInitiativeStatusToPaperclip("cancelled")).toBe("cancelled");
  });

  it("maps canceled → cancelled (US spelling)", () => {
    expect(linearInitiativeStatusToPaperclip("canceled")).toBe("cancelled");
  });

  it("maps active → active", () => {
    expect(linearInitiativeStatusToPaperclip("active")).toBe("active");
  });

  it("maps started → active", () => {
    expect(linearInitiativeStatusToPaperclip("started")).toBe("active");
  });

  it("maps 'in progress' → active", () => {
    expect(linearInitiativeStatusToPaperclip("in progress")).toBe("active");
  });

  it("is case-insensitive", () => {
    expect(linearInitiativeStatusToPaperclip("Active")).toBe("active");
    expect(linearInitiativeStatusToPaperclip("COMPLETED")).toBe("achieved");
    expect(linearInitiativeStatusToPaperclip("Cancelled")).toBe("cancelled");
  });

  it("treats planned/paused/unknown as planned", () => {
    expect(linearInitiativeStatusToPaperclip("planned")).toBe("planned");
    expect(linearInitiativeStatusToPaperclip("paused")).toBe("planned");
    expect(linearInitiativeStatusToPaperclip("backlog")).toBe("planned");
    expect(linearInitiativeStatusToPaperclip("")).toBe("planned");
  });

  it("treats null/undefined as planned", () => {
    expect(linearInitiativeStatusToPaperclip(null)).toBe("planned");
    expect(linearInitiativeStatusToPaperclip(undefined)).toBe("planned");
  });
});
