import { parseBobShellOutput, generateBobShellSummary } from "./parse-stdout.js";

// Example Bob Shell output (realistic format)
const exampleOutput = `[system]
run started
[system]
Reading file: /path/to/file.ts

<thinking>
**Analyzing the task**
I need to create a summary document explaining Bob Shell integration with Paperclip.
</thinking>

<write_to_file>
<file_path>/Users/dsoldo/workspace/IBM_BOB_SUMMARY.md</file_path>
<content>
# Bob Shell Integration with Paperclip

## Overview
Bob Shell is a powerful AI coding assistant that integrates seamlessly with Paperclip.

## Key Features
- Paperclip integration details
- Key principles and technical expertise
- Common use cases

## Getting Started
Follow the setup guide to begin using Bob Shell with Paperclip.
</content>
</write_to_file>

Tool <write_to_file> status: Success
restore ID before tool use: 0 (can be used with restore tool)

tool response is wrapped in 'response' xml tag:
<response>Successfully wrote content to new file: /Users/dsoldo/workspace/IBM_BOB_SUMMARY.md.</response>

<attempt_completion>
<result>
# Bob Shell Integration with Paperclip

## Overview
Bob Shell is a powerful AI coding assistant that integrates seamlessly with Paperclip.

## Key Features
- Paperclip integration details
- Key principles and technical expertise
- Common use cases

## Getting Started
Follow the setup guide to begin using Bob Shell with Paperclip.

The markdown file is ready and located at: /Users/dsoldo/workspace/IBM_BOB_SUMMARY.md
</result>
</attempt_completion>

[system]
Run completed successfully`;

console.log("=== Testing Bob Shell Parser ===\n");

const parsed = parseBobShellOutput(exampleOutput);

console.log("Parsed Output:");
console.log("- Assistant Messages:", parsed.assistantMessages.length);
parsed.assistantMessages.forEach((msg, i) => {
  console.log(`  [${i}]:`, msg.substring(0, 100) + (msg.length > 100 ? "..." : ""));
});

console.log("\n- Thinking Messages:", parsed.thinkingMessages.length);
parsed.thinkingMessages.forEach((msg, i) => {
  console.log(`  [${i}]:`, msg.substring(0, 100) + (msg.length > 100 ? "..." : ""));
});

console.log("\n- Tool Calls:", parsed.toolCalls.length);
console.log("- Tool Results:", parsed.toolResults.length);
console.log("\n- Final Result:", parsed.finalResult ? "YES" : "NO");
if (parsed.finalResult) {
  console.log("  Content:", parsed.finalResult.substring(0, 200) + (parsed.finalResult.length > 200 ? "..." : ""));
}

console.log("\n=== Generated Summary ===");
const summary = generateBobShellSummary(parsed);
console.log(summary);

console.log("\n=== Expected Summary ===");
console.log("Should show the markdown content WITHOUT the file path line");
