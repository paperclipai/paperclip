import { performance } from "node:perf_hooks";
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
const companies = option("--companies", 1);
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

const rows = listing();
const gateway = { listToolsForNamedGateway: async () => structuredClone(rows) } as unknown as ToolGatewayService;
const create = (companyId: string) => createAssignedMcpTools({
  gateway, gatewayPublicId: "benchmark", bearerToken: "benchmark", companyId,
});

async function heap() {
  await new Promise(resolve => setImmediate(resolve));
  gc!(); gc!();
  return process.memoryUsage().heapUsed;
}

function schemaIdentities(definitions: Array<Record<string, unknown>>) {
  return definitions.map(definition => definition.inputSchema);
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function measureSessions(baseline: number) {
  const held: Array<Awaited<ReturnType<typeof create>>> = [];
  const startMs: number[] = [];
  for (let index = 0; index < sessions; index += 1) {
    const started = performance.now();
    held.push(await create(`company-${index % companies}`));
    startMs.push(performance.now() - started);
  }
  const retainedBytes = await heap() - baseline;
  const retainedBytesPerSession = Math.round(retainedBytes / sessions);
  const turnResults: Array<Array<Record<string, unknown>>> = [];
  const beforeTurns = await heap();
  const definitionsMs: number[] = [];
  for (let index = 0; index < turns; index += 1) {
    const started = performance.now();
    turnResults.push(held[0]!.definitions());
    definitionsMs.push(performance.now() - started);
  }
  const retainedBytesPerTurn = Math.round((await heap() - beforeTurns) / turns);
  const first = schemaIdentities(turnResults[0]!);
  const schemaObjectsAfterTurns = new Set(turnResults.flatMap(schemaIdentities)).size;
  const sharedAcrossTurns = turnResults.every(result => schemaIdentities(result).every((schema, index) => schema === first[index]));
  held.length = 0;
  return {
    retainedBytes, retainedBytesPerSession, retainedBytesPerTurn, schemaObjectsAfterTurns, sharedAcrossTurns,
    firstSessionStartMs: Number(startMs[0]!.toFixed(2)),
    medianSessionStartMs: Number(median(startMs).toFixed(2)),
    medianDefinitionsMs: Number(median(definitionsMs).toFixed(2)),
  };
}

async function main() {
  await create("warm-up");
  const baseline = await heap();
  const measured = await measureSessions(baseline);
  const released = await heap();
  console.log(`RESULT ${JSON.stringify({
    tools: toolCount, schemaBytes, sessions, companies, turns,
    catalogJsonBytes: Buffer.byteLength(JSON.stringify(rows.map(tool => tool.parametersSchema)), "utf8"),
    ...measured,
    schemaObjectsPerTurn: measured.schemaObjectsAfterTurns / turns,
    bytesStillHeldAfterRelease: Math.max(0, released - baseline),
  })}`);
}

await main();
