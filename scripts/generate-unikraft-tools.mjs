import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inputSchema } from "./generate-daytona-tools.mjs";

// The official specification repository has no tags or releases. Pin a
// reviewed commit so a provider update needs explicit regeneration and review.
const commit = "5dd107ea1cd8716b83cb86a83ed2a6ee46f99b5b";
const sources = {
  platform: `https://raw.githubusercontent.com/unikraft-cloud/openapi/${commit}/platform.json`,
  sandbox: `https://raw.githubusercontent.com/unikraft-cloud/openapi/${commit}/plugins/sandbox.json`,
};
const verbs = new Set(["get", "post", "put", "patch", "delete"]);
const snake = value => value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
  .replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase();
// Requests that wait, read, or list without changing provider state.
const readOnlyPosts = new Set(["ReadFile", "ReadRawFile", "WaitForCommand", "WaitForCommandWithTimeout"]);
// Reversible but disruptive lifecycle changes, and code execution in a sandbox.
const destructiveOperations = /^(Stop|Suspend|Detach|Unpin)|^(RunCommand|SignalCommand|WriteCommandStdin)$/;

function parameterDefinition(parameter, spec) {
  if (!parameter.$ref) return parameter;
  const prefix = "#/components/parameters/";
  if (!parameter.$ref.startsWith(prefix)) throw new Error(`Unsupported parameter reference: ${parameter.$ref}`);
  const resolved = spec.components?.parameters?.[parameter.$ref.slice(prefix.length)];
  if (!resolved) throw new Error(`Missing parameter: ${parameter.$ref}`);
  return resolved;
}

/** Ajv does not define OpenAPI's unsigned integer formats. Keep their sign
 * constraint instead of an unknown format that would not validate anything.
 * Some unsigned fields document -1 as a sentinel (for example, the longest
 * drain time); keep that value valid. */
function unsignedFormats(node) {
  if (Array.isArray(node)) return node.forEach(unsignedFormats);
  if (!node || typeof node !== "object") return;
  if (/^uint(8|16|32|64)$/.test(node.format ?? "")) {
    delete node.format;
    node.minimum ??= /(^|\s)-1\b/.test(node.description ?? "") ? -1 : 0;
  }
  Object.values(node).forEach(unsignedFormats);
}

function streamingOperation(operation) {
  return Object.values(operation.responses ?? {}).some(response => Object.hasOwn(response.content ?? {}, "text/event-stream"));
}

export function generateUnikraftCatalog(specs) {
  const metros = (specs.platform?.servers ?? []).map(server => new URL(server.url).hostname.match(/^api\.([a-z0-9]+)\.unikraft\.cloud$/)?.[1])
    .filter(Boolean).sort();
  const tools = [];
  const streaming = [];
  for (const [kind, spec] of Object.entries(specs)) {
    for (const [route, item] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (!verbs.has(method)) continue;
        if (!operation.operationId) throw new Error(`Missing operationId: ${kind} ${method} ${route}`);
        const name = kind === "platform" ? `unikraft_${snake(operation.operationId)}` : `unikraft_${kind}_${snake(operation.operationId)}`;
        // Server-sent event streams hold a connection open; they are not
        // request/response actions. Keep them in the inventory so an update
        // cannot silently lose an operation.
        if (streamingOperation(operation)) {
          streaming.push({ name, kind, path: route, method: method.toUpperCase(), transport: "server-sent-events" });
          continue;
        }
        const properties = {}, required = [], parameters = [];
        const groups = { path: { type: "object", properties: {}, required: [], additionalProperties: false },
          query: { type: "object", properties: {}, required: [], additionalProperties: false },
          headers: { type: "object", properties: {}, required: [], additionalProperties: false } };
        for (const reference of [...(item.parameters ?? []), ...(operation.parameters ?? [])]) {
          const parameter = parameterDefinition(reference, spec);
          const group = parameter.in === "header" ? "headers" : parameter.in;
          if (!groups[group]) throw new Error(`Unsupported parameter: ${name} ${parameter.in}`);
          // Authorization comes from the selected connection, never an argument.
          if (group === "headers" && /^(authorization|cookie|host)$/i.test(parameter.name)) continue;
          groups[group].properties[parameter.name] = { ...(parameter.schema ?? {}),
            ...(parameter.description ? { description: parameter.description } : {}) };
          if (parameter.required) groups[group].required.push(parameter.name);
          parameters.push({ name: parameter.name, group, style: parameter.style ?? "form", explode: parameter.explode ?? true });
        }
        for (const [group, schema] of Object.entries(groups)) {
          if (!Object.keys(schema.properties).length) continue;
          properties[group] = schema;
          if (schema.required.length) required.push(group);
        }
        properties.metro = { type: "string", enum: metros, description: "Unikraft Cloud metro. Defaults to the connection's default metro." };
        if (kind === "sandbox") {
          properties.instance = { type: "string", minLength: 1, maxLength: 200, description: "Name or UUID of the instance running the sandbox plugin." };
          required.push("instance");
        }
        const content = operation.requestBody?.content ?? {};
        const bodyContentType = Object.hasOwn(content, "application/json") ? "application/json" : Object.keys(content)[0];
        if (bodyContentType && bodyContentType !== "application/json") throw new Error(`Unsupported request body: ${name} ${bodyContentType}`);
        if (bodyContentType) {
          properties.body = content[bodyContentType].schema ?? {};
          if (operation.requestBody.required) required.push("body");
        }
        const readOnly = method === "get" || readOnlyPosts.has(operation.operationId);
        const destructive = !readOnly && (method === "delete" || destructiveOperations.test(operation.operationId));
        const schema = inputSchema({ type: "object", additionalProperties: false, properties, required }, spec.components?.schemas ?? {});
        unsignedFormats(schema);
        tools.push({ name, kind, path: route, method: method.toUpperCase(), parameters,
          ...(bodyContentType ? { bodyContentType } : {}),
          title: operation.summary || operation.operationId,
          description: operation.description || operation.summary || operation.operationId,
          inputSchema: schema,
          annotations: { readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: readOnly, openWorldHint: true } });
      }
    }
  }
  if (!metros.length) throw new Error("The platform specification lists no Unikraft Cloud metros");
  const names = tools.map(tool => tool.name);
  if (new Set(names).size !== names.length) throw new Error("Duplicate Unikraft action name");
  return { metros, tools, streaming };
}

async function main() {
  const inputIndex = process.argv.indexOf("--input-dir");
  const inputDir = inputIndex < 0 ? undefined : process.argv[inputIndex + 1];
  const specs = {}, provenance = {};
  for (const [kind, url] of Object.entries(sources)) {
    const raw = inputDir ? await readFile(path.join(inputDir, `unikraft-${kind}-openapi.json`))
      : Buffer.from(await (await fetch(url)).arrayBuffer());
    specs[kind] = JSON.parse(raw.toString("utf8"));
    provenance[kind] = { url, sha256: createHash("sha256").update(raw).digest("hex") };
  }
  const output = { schemaVersion: 1, sources: provenance, ...generateUnikraftCatalog(specs) };
  const target = fileURLToPath(new URL("../server/src/services/connectors/unikraft/operations.generated.json", import.meta.url));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(output, null, 2) + "\n");
  console.log(`Generated ${output.tools.length} Unikraft actions across ${output.metros.length} metros; recorded ${output.streaming.length} streaming endpoints.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
