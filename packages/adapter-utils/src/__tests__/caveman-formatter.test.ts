import { describe, it, expect } from "vitest";
import { formatCaveman } from "../caveman-formatter.js";

describe("Caveman Formatting", () => {
  it("should remove conversational fillers", () => {
    const input = "I'd be happy to help you with that. Sure thing! Let me see what I can do.";
    const result = formatCaveman(input, { intensity: 'lite' });

    expect(result).not.toContain("I'd be happy");
    expect(result).not.toContain("Sure thing");
  });

  it("should remove articles", () => {
    const input = "The reason is that the component is not rendering properly.";
    const result = formatCaveman(input, { intensity: 'full' });

    expect(result).not.toContain(" the ");
  });

  it("should use symbols for common phrases", () => {
    const input = "This leads to an error. This results in a crash.";
    const result = formatCaveman(input, { intensity: 'full' });

    expect(result).toContain("→");
  });

  it("should preserve code blocks", () => {
    const input = `
Here's the fix:
\`\`\`javascript
function test() {
  return true;
}
\`\`\`
This should work.
    `;
    const result = formatCaveman(input, { preserveCodeBlocks: true });

    expect(result).toContain("function test()");
    expect(result).toContain("return true;");
  });

  it("should handle ultra intensity", () => {
    const input = "Please help me with this issue. I would be grateful if you could assist.";
    const result = formatCaveman(input, { intensity: 'ultra' });

    expect(result).not.toContain("Please");
    expect(result).not.toContain("would be grateful");
  });

  it("should reduce token count significantly", () => {
    const input = "I'd be happy to help you. The reason this is happening is likely because you are using an outdated version of the library. Furthermore, the configuration might not be set correctly. Additionally, there could be permission issues.";
    const result = formatCaveman(input, { intensity: 'full' });

    const inputTokens = Math.ceil(input.length / 4);
    const outputTokens = Math.ceil(result.length / 4);

    expect(outputTokens).toBeLessThan(inputTokens * 0.6); // At least 40% reduction
  });
});