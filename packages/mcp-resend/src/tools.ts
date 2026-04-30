import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ResendClient } from "./client.js";
import { formatErrorResponse, formatTextResponse } from "./format.js";

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.AnyZodObject;
  execute: (input: Record<string, unknown>) => Promise<CallToolResult>;
}

function makeTool<TSchema extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: z.ZodObject<TSchema>,
  execute: (input: z.infer<typeof schema>, client: ResendClient) => Promise<unknown>,
  client: ResendClient,
): ToolDefinition {
  return {
    name,
    description,
    schema,
    execute: async (input) => {
      try {
        const parsed = schema.parse(input);
        return formatTextResponse(await execute(parsed, client));
      } catch (error) {
        return formatErrorResponse(error);
      }
    },
  };
}

const emailStr = z.string().email();

const tagsSchema = z
  .array(z.object({ name: z.string(), value: z.string() }))
  .optional()
  .describe("Resend analytics tags (max 50 per email)");

const singleEmailSchema = z.object({
  from: z
    .string()
    .describe(
      "Verified sender. Must use medicodio.site domain. Format: 'Name <address@medicodio.site>' or 'address@medicodio.site'. E.g. 'Medicodio <noreply@medicodio.site>'.",
    ),
  to: z.array(emailStr).min(1).describe("Recipient email address(es)"),
  subject: z.string().describe("Email subject line"),
  html: z.string().describe("HTML body. Always use HTML — never plain text."),
  cc: z.array(emailStr).optional().describe("CC recipients"),
  bcc: z.array(emailStr).optional().describe("BCC recipients"),
  reply_to: z.string().email().optional().describe("Reply-to address"),
  tags: tagsSchema,
});

export function createToolDefinitions(client: ResendClient): ToolDefinition[] {
  return [
    makeTool(
      "resend_send_email",
      "Send a single outbound email via Resend. Use for marketing and bulk sends — Resend has no rate limits unlike Outlook. The 'from' address must use the medicodio.site domain (verified in Resend). For reading replies or 1:1 transactional emails, use outlook_send_email instead.",
      singleEmailSchema,
      async (payload, c) => {
        const result = await c.sendEmail(payload);
        return { sent: true, id: result.id };
      },
      client,
    ),

    makeTool(
      "resend_send_batch",
      "Send up to 100 emails in a single Resend API call. Each email is independent (different to/subject/body). Use for bulk outreach campaigns. All 'from' addresses must use the medicodio.site domain.",
      z.object({
        emails: z
          .array(singleEmailSchema)
          .min(1)
          .max(100)
          .describe("Array of emails to send. Max 100 per batch."),
      }),
      async ({ emails }, c) => {
        const result = await c.sendBatch(emails);
        const ids = result.data.map((r) => r.id);
        return { sent: true, count: ids.length, ids };
      },
      client,
    ),
  ];
}
