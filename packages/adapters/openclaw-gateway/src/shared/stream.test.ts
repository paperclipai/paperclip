import { describe, it, expect } from "vitest";
import { normalizeOpenClawGatewayStreamLine } from "./stream.js";

describe("normalizeOpenClawGatewayStreamLine", () => {
  it("returns null stream and empty line for an empty string", () => {
    expect(normalizeOpenClawGatewayStreamLine("")).toEqual({ stream: null, line: "" });
  });

  it("returns null stream and empty line for whitespace-only input", () => {
    expect(normalizeOpenClawGatewayStreamLine("   \t  ")).toEqual({ stream: null, line: "" });
  });

  it("returns null stream and trimmed line for a plain message", () => {
    expect(normalizeOpenClawGatewayStreamLine("hello world")).toEqual({
      stream: null,
      line: "hello world",
    });
  });

  it("returns null stream and trimmed line for a line with leading/trailing whitespace", () => {
    expect(normalizeOpenClawGatewayStreamLine("  plain output  ")).toEqual({
      stream: null,
      line: "plain output",
    });
  });

  it("detects stdout prefix with colon separator", () => {
    expect(normalizeOpenClawGatewayStreamLine("stdout: hello")).toEqual({
      stream: "stdout",
      line: "hello",
    });
  });

  it("detects stderr prefix with colon separator", () => {
    expect(normalizeOpenClawGatewayStreamLine("stderr: error message")).toEqual({
      stream: "stderr",
      line: "error message",
    });
  });

  it("detects stdout prefix with equals separator", () => {
    expect(normalizeOpenClawGatewayStreamLine("stdout= output text")).toEqual({
      stream: "stdout",
      line: "output text",
    });
  });

  it("detects stderr prefix with equals separator", () => {
    expect(normalizeOpenClawGatewayStreamLine("stderr= warning")).toEqual({
      stream: "stderr",
      line: "warning",
    });
  });

  it("detects stdout prefix with no separator", () => {
    expect(normalizeOpenClawGatewayStreamLine("stdout some text")).toEqual({
      stream: "stdout",
      line: "some text",
    });
  });

  it("is case-insensitive for the prefix", () => {
    expect(normalizeOpenClawGatewayStreamLine("STDOUT: caps line")).toEqual({
      stream: "stdout",
      line: "caps line",
    });
    expect(normalizeOpenClawGatewayStreamLine("STDERR: caps error")).toEqual({
      stream: "stderr",
      line: "caps error",
    });
  });

  it("strips surrounding whitespace from the extracted line", () => {
    expect(normalizeOpenClawGatewayStreamLine("stdout:   padded   ")).toEqual({
      stream: "stdout",
      line: "padded",
    });
  });

  it("returns empty string as line when prefix has no content after it", () => {
    const result = normalizeOpenClawGatewayStreamLine("stdout:");
    expect(result.stream).toBe("stdout");
    expect(result.line).toBe("");
  });
});
