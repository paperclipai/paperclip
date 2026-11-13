import type { ToolGatewayDescriptor, ToolGatewayService } from "../src/services/tool-gateway.js";
import { createAssignedMcpTools } from "../src/services/native-runtime/assigned-mcp-tools.js";

function option(name: string, fallback: number) {
  const index = process.argv.indexOf(name);
  const value = Number(index < 0 ? fallback : process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`Expected a positive integer for ${name}`);
  return value;
}
const toolCount = option("--tools", 80);
const schemaBytes = option("--schema-bytes", 2048);
const sessions = option("--sessions", 200);
const turns = option("--turns", 20);
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("Run with node --expose-gc");

function listing(): ToolGatewayDescriptor[] {
  return Array.from({ length: toolCount }, (_, index) => {
    const properties: Record<string, unknown> = {};
    for (let field = 0; JSON.stringify(properties).length < schemaBytes; field += 1) {
      properties[`field_${field}`] = { type: "string", description: `Field ${field} of tool ${index} with representative documentation text.` };
    }
    return {
      name: `fixture_app:tool_${index}`, displayName: `Tool ${index}`, description: `Fixture tool ${index}`,
      parametersSchema: { type: "object", properties, required: ["field_0"] },
      pluginId: "fixture", providerType: "mcp_remote_http", risk: "read",
    } as ToolGatewayDescriptor;
  });
}

const gateway = { listToolsForNamedGateway: async () => listing() } as unknown as ToolGatewayService;
const create = () => createAssignedMcpTools({ gateway, gatewayPublicId: "benchmark", bearerToken: "benchmark" });

function heap() {
  gc!(); gc!();
  return process.memoryUsage().heapUsed;
}

function schemaIdentities(definitions: Array<Record<string, unknown>>) {
  return definitions.map(definition => definition.inputSchema);
}

async function measureSessions(baseline: number) {
  const held: Array<Awaited<ReturnType<typeof create>>> = [];
  for (let index = 0; index < sessions; index += 1) held.push(await create());
  const retainedBytesPerSession = Math.round((heap() - baseline) / sessions);
  const turnResults: Array<Array<Record<string, unknown>>> = [];
  const beforeTurns = heap();
  for (let index = 0; index < turns; index += 1) turnResults.push(held[0]!.definitions());
  const retainedBytesPerTurn = Math.round((heap() - beforeTurns) / turns);
  const first = schemaIdentities(turnResults[0]!);
  const schemaObjectsAfterTurns = new Set(turnResults.flatMap(schemaIdentities)).size;
  const sharedAcrossTurns = turnResults.every(result => schemaIdentities(result).every((schema, index) => schema === first[index]));
  return { retainedBytesPerSession, retainedBytesPerTurn, schemaObjectsAfterTurns, sharedAcrossTurns };
}

async function main() {
  await create();
  const baseline = heap();
  const measured = await measureSessions(baseline);
  const released = heap();
  console.log(JSON.stringify({
    tools: toolCount, schemaBytes, sessions, turns,
    ...measured,
    schemaObjectsPerTurn: measured.schemaObjectsAfterTurns / turns,
    bytesStillHeldAfterRelease: Math.max(0, released - baseline),
  }, null, 2));
}

await main();
