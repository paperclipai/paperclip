import { describe, expect, it } from "vitest";
import { applyTurnBoundary, createTurnBoundaryState } from "./turn-boundary.js";

function run(chunks: string[]): string {
  const state = createTurnBoundaryState();
  return chunks.map((chunk) => applyTurnBoundary(state, chunk)).join("");
}

describe("applyTurnBoundary", () => {
  it("inserts a newline when a closing backtick is followed by a new capitalized turn", () => {
    expect(run(["The user uses `", "ls", "`", "The", " `", "ls", "`", " returned"]))
      .toBe("The user uses `ls`\nThe `ls` returned");
  });

  it("inserts a newline after sentence-ending punctuation glued to a capitalized word", () => {
    expect(run(["returned", ":", "Confirmed", ":", " 4 files"]))
      .toBe("returned:\nConfirmed: 4 files");
  });

  it("does not break apart backtick-wrapped CamelCase identifiers within a turn", () => {
    expect(run(["render `", "React", "` then "]))
      .toBe("render `React` then ");
  });

  it("leaves natural token streams with proper whitespace alone", () => {
    expect(run(["The", " user", " wants", " me", " to", ":\n", "1", ".", " List"]))
      .toBe("The user wants me to:\n1. List");
  });

  it("does not insert a separator when the next chunk starts with whitespace", () => {
    expect(run(["function", ".", " They"]))
      .toBe("function. They");
  });

  it("does not insert a separator when the next chunk starts lowercase", () => {
    expect(run(["`", "ls", "`"]))
      .toBe("`ls`");
  });

  it("does not insert a separator when the next chunk is a single character", () => {
    expect(run([":", "A"]))
      .toBe(":A");
  });

  it("does not insert a separator after a self-contained backtick span in a single chunk", () => {
    // Greptile review: a chunk like "`ls`" is a balanced span; the following
    // capitalized word should be treated as a continuation, not a new turn.
    expect(run(["`ls`", "Then"]))
      .toBe("`ls`Then");
  });
});
