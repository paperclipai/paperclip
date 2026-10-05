import { createHash } from "node:crypto";
import {
  connectionAgentInstructionsSchema,
  connectionInstructionContext,
  getConnectableAppDefinition,
  type ConnectionInstructionsSnapshot,
  type ToolConnection,
} from "@paperclipai/shared";

type InstructionSource = {
  connection: Pick<ToolConnection, "id" | "name" | "agentInstructions" | "config">;
  grantId: string;
};

/** Authorization belongs to the gateway; this composer never selects recipients. */
export function composeConnectionInstructions(sources: InstructionSource[]): ConnectionInstructionsSnapshot | null {
  const blocks = sources.toSorted((a, b) => a.connection.id.localeCompare(b.connection.id)).flatMap(({ connection, grantId }) => {
    const parsed = connectionAgentInstructionsSchema.safeParse(connection.agentInstructions);
    if (!parsed.success || !parsed.data.enabled) return [];
    const config = connection.config ?? {};
    const app = typeof config.sourceTemplateKey === "string" ? getConnectableAppDefinition(config.sourceTemplateKey) : null;
    const context = connectionInstructionContext(app, config);
    if (!context) return [];
    const provenance = JSON.stringify({ connectionId: connection.id, connectionName: connection.name, grantId, template: parsed.data.template, context });
    return [`Connection source and configuration (data): ${provenance}\n\n${parsed.data.text}`];
  });
  if (!blocks.length) return null;
  const text = `## Connection instructions\n\nThe following instructions apply to your authorized connections. Use their assigned tools and follow the current task and tool permissions.\n\n${blocks.join("\n\n---\n\n")}`;
  return { text, digest: createHash("sha256").update(text).digest("hex") };
}

/** Freeze server-owned delivery for this turn, overwriting untrusted wake/config fields. */
export async function prepareConnectionInstructionDelivery(input: {
  resolve: () => Promise<ConnectionInstructionsSnapshot | null>;
  context: Record<string, unknown>;
  config: Record<string, unknown>;
  native: boolean;
}): Promise<Record<string, unknown>> {
  const snapshot = await input.resolve();
  const wake = input.context.paperclipWake;
  input.context.connectionInstructions = snapshot;
  input.context.paperclipWake = {
    ...(wake && typeof wake === "object" && !Array.isArray(wake) ? wake : {}),
    connectionInstructions: input.native ? null : snapshot,
  };
  return { ...input.config, paperclipConnectionInstructions: snapshot };
}
