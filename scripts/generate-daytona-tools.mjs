import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sources = {
  api: "https://www.daytona.io/docs/openapi.json",
  toolbox: "https://www.daytona.io/docs/toolbox-openapi.json",
};
const verbs = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const snake = value => value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase();

/** Retain only reachable input definitions, rather than copying the whole API
 * schema into every action. Provider response schemas are not tool inputs. */
function inputSchema(value, schemas) {
  const definitions = {};
  function visit(node) {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== "object") return node;
    if (node.$ref) {
      const prefix = "#/components/schemas/";
      if (!node.$ref.startsWith(prefix)) throw new Error(`Unsupported schema reference: ${node.$ref}`);
      const key = node.$ref.slice(prefix.length);
      if (!Object.hasOwn(schemas, key)) throw new Error(`Missing schema: ${key}`);
      if (!Object.hasOwn(definitions, key)) {
        definitions[key] = {};
        definitions[key] = visit(schemas[key]);
      }
      return { $ref: `#/definitions/${key}`, ...Object.fromEntries(Object.entries(node).filter(([k]) => k !== "$ref").map(([k,v]) => [k,visit(v)])) };
    }
    const result = Object.fromEntries(Object.entries(node).filter(([key]) => !["nullable", "example", "xml", "discriminator"].includes(key)).map(([key,child]) => [key,visit(child)]));
    if (result.format === "binary") {
      delete result.format;
      result.contentEncoding = "base64";
      result.description = `${result.description ?? "File bytes"} (base64; never a host file path)`;
    }
    // OpenAPI formats that Ajv does not define do not constrain JSON values.
    if (["int32", "int64", "float", "double", "byte"].includes(result.format)) delete result.format;
    return node.nullable ? { anyOf: [result, { type: "null" }] } : result;
  }
  const root = visit(value);
  if (Object.keys(definitions).length) root.definitions = definitions;
  return root;
}

export function generateDaytonaCatalog(specs) {
  const tools = [];
  const streaming = [];
  for (const [kind, spec] of Object.entries(specs)) {
    for (const [route, item] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (!verbs.has(method)) continue;
        if (!operation.operationId) throw new Error(`Missing operationId: ${kind} ${method} ${route}`);
        const name = `daytona_${kind}_${snake(operation.operationId)}`;
        // These are protocol upgrades, not request/response MCP actions. Keep
        // them in the inventory so an update cannot silently lose an operation.
        if (operation.responses?.["101"]) {
          streaming.push({ name, kind, path: route, method: method.toUpperCase(), transport: "websocket" });
          continue;
        }
        const properties = {}, required = [], parameters = [];
        const groups = { path: { type: "object", properties: {}, required: [], additionalProperties: false },
          query: { type: "object", properties: {}, required: [], additionalProperties: false },
          headers: { type: "object", properties: {}, required: [], additionalProperties: false } };
        for (const parameter of [...(item.parameters ?? []), ...(operation.parameters ?? [])]) {
          const group = parameter.in === "header" ? "headers" : parameter.in;
          if (!groups[group]) throw new Error(`Unsupported parameter: ${name} ${parameter.in}`);
          // Organization and invocation authorization come from the selected
          // connection, never an action argument.
          if (group === "headers" && /^(authorization|cookie|host|x-daytona-organization-id)$/i.test(parameter.name)) continue;
          groups[group].properties[parameter.name] = { ...(parameter.schema ?? parameter.content?.["application/json"]?.schema ?? {}),
            ...(parameter.description ? { description: parameter.description } : {}) };
          if (parameter.required) groups[group].required.push(parameter.name);
          // The audit API documents bracket-key filters despite declaring form
          // style for its referenced filter objects in the OpenAPI document.
          const auditFilter = kind === "api" && operation.operationId === "getOrganizationAuditLogs"
            && group === "query" && /Filter$/.test(parameter.schema?.$ref ?? "");
          parameters.push({ name: parameter.name, group, style: auditFilter ? "deepObject" : parameter.style ?? "form", explode: parameter.explode ?? true,
            json: Boolean(parameter.content?.["application/json"]) });
        }
        for (const [group, schema] of Object.entries(groups)) {
          if (!Object.keys(schema.properties).length) continue;
          properties[group] = schema;
          if (schema.required.length) required.push(group);
        }
        if (kind === "toolbox") { properties.sandboxId = { type: "string", minLength: 1, maxLength: 200 }; required.push("sandboxId"); }
        const content = operation.requestBody?.content ?? {};
        let bodyContentType = Object.hasOwn(content, "application/json") ? "application/json" : Object.keys(content)[0];
        if (bodyContentType) {
          properties.body = content[bodyContentType].schema ?? {};
          if (operation.requestBody.required) required.push("body");
        }
        // Daytona's bulk upload endpoint omits its multipart body from the
        // OpenAPI input. Its published SDK supplies repeated file parts whose
        // filename is the destination path. No host filesystem is exposed.
        if (kind === "toolbox" && operation.operationId === "UploadFiles") {
          bodyContentType = "multipart/form-data";
          properties.files = { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false,
            properties: { path: { type: "string", minLength: 1 }, contentBase64: { type: "string", contentEncoding: "base64" } },
            required: ["path", "contentBase64"] } };
          required.push("files");
        }
        const sensitive = /signing.?key|secrets?|push.?access|api.?key|credentials|ssh.?access|signed.?port.?preview|admin.?portal|app.?portal/i.test(operation.operationId)
          || /\/(secret|docker-registry)(\/|$)/.test(route);
        const readOnly = (method === "get" || method === "head" || ["DownloadFiles", "FindAccessibilityNodes", "Completions"].includes(operation.operationId)) && !sensitive;
        const accessChange = !readOnly && /\/(roles|invitations|identity-providers|linked-accounts|pending-sso-links)(\/|$)|\/users\/[^/]+\/access$/.test(route);
        const interactiveInput = kind === "toolbox" && !readOnly
          && (/^\/computeruse\//.test(route) || route === "/process/pty" || /\/command\/[^/]+\/input$/.test(route));
        const destructive = method === "delete" || sensitive || accessChange || interactiveInput
          || /execute|code.?run|push.?changes|reset.?changes|restore.?files|initialize|update.?env|public.?status|network.?settings|authenticate|set.?ttl|auto.?delete|file.?permissions/i.test(operation.operationId);
        tools.push({ name, kind, path: route, method: method.toUpperCase(), parameters,
          ...(bodyContentType ? { bodyContentType } : {}),
          title: operation.summary || operation.operationId,
          description: operation.description || operation.summary || operation.operationId,
          inputSchema: inputSchema({ type: "object", additionalProperties: false, properties, required }, spec.components?.schemas ?? {}),
          annotations: { readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: readOnly, openWorldHint: true } });
      }
    }
  }
  const names = tools.map(tool => tool.name);
  if (new Set(names).size !== names.length) throw new Error("Duplicate Daytona action name");
  return { tools, streaming };
}

async function main() {
  const inputIndex = process.argv.indexOf("--input-dir");
  const inputDir = inputIndex < 0 ? undefined : process.argv[inputIndex + 1];
  const specs = {}, provenance = {};
  for (const [kind, url] of Object.entries(sources)) {
    const raw = inputDir ? await readFile(path.join(inputDir, `daytona-${kind}-openapi.json`))
      : Buffer.from(await (await fetch(url)).arrayBuffer());
    specs[kind] = JSON.parse(raw.toString("utf8"));
    provenance[kind] = { url, sha256: createHash("sha256").update(raw).digest("hex") };
  }
  const output = { schemaVersion: 1, sources: provenance, ...generateDaytonaCatalog(specs) };
  const target = fileURLToPath(new URL("../server/src/services/daytona/operations.generated.json", import.meta.url));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(output, null, 2) + "\n");
  console.log(`Generated ${output.tools.length} Daytona actions; recorded ${output.streaming.length} protocol upgrade endpoints.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
