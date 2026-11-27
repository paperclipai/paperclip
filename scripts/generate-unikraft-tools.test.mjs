import { test } from "node:test";
import assert from "node:assert/strict";
import { generateUnikraftCatalog } from "./generate-unikraft-tools.mjs";

const servers = [{ url: "https://api.fra.unikraft.cloud" }, { url: "https://api.dal.unikraft.cloud" }];

test("accounts for every HTTP operation and server-sent event stream without dropping methods", () => {
  const result = generateUnikraftCatalog({ platform: { servers, paths: {
    "/v1/instances": { get: { operationId: "GetInstances" }, post: { operationId: "CreateInstance" } },
    "/v1/audit": { get: { operationId: "SubscribeAuditEvents", responses: { default: { content: { "text/event-stream": {} } } } } },
  } } });
  assert.deepEqual(result.metros, ["dal", "fra"]);
  assert.deepEqual(result.tools.map(t => t.name), ["unikraft_get_instances", "unikraft_create_instance"]);
  assert.deepEqual(result.streaming.map(s => s.name), ["unikraft_subscribe_audit_events"]);
  assert.deepEqual(result.tools[0].inputSchema.properties.metro.enum, ["dal", "fra"]);
});

test("resolves shared parameters, keeps GET bodies and replaces unsigned formats", () => {
  const result = generateUnikraftCatalog({ platform: { servers, paths: { "/v1/instances/log": { get: {
    operationId: "GetInstanceLogs",
    parameters: [{ $ref: "#/components/parameters/Uuid" }, { name: "limit", in: "query", schema: { type: "integer", format: "uint32" } },
      { name: "Authorization", in: "header", schema: { type: "string" } }],
    requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Target" } } } },
  } } }, components: {
    parameters: { Uuid: { name: "uuid", in: "query", schema: { type: "array", items: { type: "string" } } } },
    schemas: { Target: { type: "object", properties: { offset: { type: "integer", format: "uint64" },
      drain_timeout_ms: { type: "integer", format: "uint64", description: "No draining if 0. Use -1 for the largest possible value." } } } },
  } } });
  const [tool] = result.tools;
  assert.deepEqual(tool.parameters.map(p => p.name), ["uuid", "limit"]);
  assert.equal(tool.inputSchema.properties.headers, undefined);
  assert.deepEqual(tool.inputSchema.properties.query.properties.limit, { type: "integer", minimum: 0 });
  assert.deepEqual(tool.inputSchema.definitions.Target.properties.offset, { type: "integer", minimum: 0 });
  // A documented -1 sentinel stays valid.
  assert.equal(tool.inputSchema.definitions.Target.properties.drain_timeout_ms.minimum, -1);
  assert.equal(tool.bodyContentType, "application/json");
  assert.ok(tool.inputSchema.required.includes("body"));
  assert.equal(tool.annotations.readOnlyHint, true);
});

test("targets a sandbox instance and treats execution, disruption and deletion as destructive", () => {
  const result = generateUnikraftCatalog({ platform: { servers, paths: {
    "/v1/instances/stop": { put: { operationId: "StopInstances" } },
    "/v1/instances/start": { put: { operationId: "StartInstances" } },
    "/v1/volumes/detach": { put: { operationId: "DetachVolumes" } },
    "/v1/volumes/{uuid}": { delete: { operationId: "DeleteVolumeByUUID" } },
  } }, sandbox: { paths: {
    "/commands": { post: { operationId: "RunCommand" } },
    "/fs/read": { post: { operationId: "ReadFile" } },
    "/fs/write": { post: { operationId: "WriteFile" } },
  } } });
  const risk = Object.fromEntries(result.tools.map(t => [t.name,
    t.annotations.destructiveHint ? "destructive" : t.annotations.readOnlyHint ? "read" : "write"]));
  assert.deepEqual(risk, {
    unikraft_stop_instances: "destructive", unikraft_start_instances: "write", unikraft_detach_volumes: "destructive",
    unikraft_delete_volume_by_uuid: "destructive", unikraft_sandbox_run_command: "destructive",
    unikraft_sandbox_read_file: "read", unikraft_sandbox_write_file: "write",
  });
  const sandbox = result.tools.find(t => t.name === "unikraft_sandbox_run_command");
  assert.ok(sandbox.inputSchema.required.includes("instance"));
});
