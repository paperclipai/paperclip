import { describe, expect, it } from "vitest";
import {
  linearProjectStateToPaperclip,
  paperclipProjectStateToLinear,
} from "../src/sync.js";

describe("linearProjectStateToPaperclip", () => {
  it("maps planned → planned", () => {
    expect(linearProjectStateToPaperclip("planned")).toBe("planned");
  });

  it("maps backlog → backlog", () => {
    expect(linearProjectStateToPaperclip("backlog")).toBe("backlog");
  });

  it("maps started → in_progress", () => {
    expect(linearProjectStateToPaperclip("started")).toBe("in_progress");
  });

  it("maps 'in progress' → in_progress", () => {
    expect(linearProjectStateToPaperclip("in progress")).toBe("in_progress");
  });

  it("maps paused → backlog", () => {
    expect(linearProjectStateToPaperclip("paused")).toBe("backlog");
  });

  it("maps completed → completed", () => {
    expect(linearProjectStateToPaperclip("completed")).toBe("completed");
  });

  it("maps done → completed", () => {
    expect(linearProjectStateToPaperclip("done")).toBe("completed");
  });

  it("maps canceled → cancelled", () => {
    expect(linearProjectStateToPaperclip("canceled")).toBe("cancelled");
  });

  it("maps cancelled → cancelled", () => {
    expect(linearProjectStateToPaperclip("cancelled")).toBe("cancelled");
  });

  it("is case-insensitive", () => {
    expect(linearProjectStateToPaperclip("Started")).toBe("in_progress");
    expect(linearProjectStateToPaperclip("COMPLETED")).toBe("completed");
  });

  it("falls back to backlog for unknown states", () => {
    expect(linearProjectStateToPaperclip("unknown")).toBe("backlog");
    expect(linearProjectStateToPaperclip("")).toBe("backlog");
  });
});

describe("paperclipProjectStateToLinear", () => {
  it("maps backlog → planned", () => {
    expect(paperclipProjectStateToLinear("backlog")).toBe("planned");
  });

  it("maps planned → planned", () => {
    expect(paperclipProjectStateToLinear("planned")).toBe("planned");
  });

  it("maps in_progress → started", () => {
    expect(paperclipProjectStateToLinear("in_progress")).toBe("started");
  });

  it("maps active → started", () => {
    expect(paperclipProjectStateToLinear("active")).toBe("started");
  });

  it("maps completed → completed", () => {
    expect(paperclipProjectStateToLinear("completed")).toBe("completed");
  });

  it("maps cancelled → canceled", () => {
    expect(paperclipProjectStateToLinear("cancelled")).toBe("canceled");
  });

  it("falls back to planned for unknown statuses", () => {
    expect(paperclipProjectStateToLinear("unknown")).toBe("planned");
    expect(paperclipProjectStateToLinear("")).toBe("planned");
  });
});
