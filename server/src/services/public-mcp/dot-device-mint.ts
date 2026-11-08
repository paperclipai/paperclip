import { createHash } from "node:crypto";
import { z } from "zod";
export const dotDeviceMintSchema = z.object({
  client_id: z.string().min(1).max(2048), resource: z.string().url().max(2048),
  scope: z.string().max(200), company_id: z.uuid().optional(), expected_instance_id: z.string().min(1).max(200),
}).strict();
export type DotDeviceMintBody = z.infer<typeof dotDeviceMintSchema>;
export function dotDeviceMintDigest(body: DotDeviceMintBody) {
  return createHash("sha256").update(JSON.stringify(["mcp-dot-device-mint-v1", body.expected_instance_id,
    body.resource, body.client_id, body.scope, body.company_id ?? null])).digest("hex");
}
