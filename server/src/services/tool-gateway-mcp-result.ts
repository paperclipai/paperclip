import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

/** Project already-governed provider content back into the MCP wire format. */
export function buildGatewayToolCallResult(input: {
  text: string;
  structuredContent: unknown;
  isError?: boolean;
}) {
  const structuredContent = input.structuredContent;
  const data = structuredContent !== null && typeof structuredContent === "object" && !Array.isArray(structuredContent)
    ? structuredContent as Record<string, unknown>
    : null;
  // executeTool has already validated/redacted this value. Never fetch a raw
  // provider response here, or turn persisted replay receipts into live images.
  const provider = data && ["mcp_http", "local_stdio", "cognee_cloud"].includes(String(data.transport))
    ? CallToolResultSchema.safeParse({ content: data.content, isError: data.isError === true })
    : null;
  if (provider?.success && provider.data.content.length > 0) {
    const { content: _content, ...metadata } = data!;
    return {
      content: provider.data.content,
      // Avoid serializing the same image a second time into model-visible JSON.
      structuredContent: metadata,
      isError: input.isError ?? provider.data.isError ?? false,
    };
  }
  return {
    content: [{ type: "text" as const, text: input.text }],
    ...(structuredContent !== null &&
    typeof structuredContent === "object" &&
    !Array.isArray(structuredContent)
      ? { structuredContent: structuredContent as Record<string, unknown> }
      : {}),
    isError: input.isError ?? false,
  };
}
