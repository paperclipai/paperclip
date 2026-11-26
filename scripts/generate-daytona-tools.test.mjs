import { test } from "node:test";
import assert from "node:assert/strict";
import { generateDaytonaCatalog } from "./generate-daytona-tools.mjs";

test("accounts for every HTTP operation and protocol upgrade without dropping methods", () => {
  const result = generateDaytonaCatalog({ api: { paths: {
    "/sandbox": { get: { operationId: "listSandboxes" }, post: { operationId: "createSandbox" } },
    "/stream": { get: { operationId: "stream", responses: { 101: {} } } },
  } } });
  assert.deepEqual(result.tools.map(t => t.name), ["daytona_api_list_sandboxes", "daytona_api_create_sandbox"]);
  assert.equal(result.tools[0].annotations.readOnlyHint, true);
  assert.equal(result.tools[1].annotations.readOnlyHint, false);
  assert.equal(result.streaming.length, 1);
});

test("retains reachable recursive input definitions and replaces file paths with bytes", () => {
  const result = generateDaytonaCatalog({ toolbox: { paths: { "/files": { post: { operationId: "UploadFile",
    requestBody: { required: true, content: { "multipart/form-data": { schema: { $ref: "#/components/schemas/File" } } } } } } },
    components: { schemas: { File: { type: "object", properties: { file: { type: "string", format: "binary" },
      next: { $ref: "#/components/schemas/File" } } }, Unused: { type: "string" } } } } });
  const schema = result.tools[0].inputSchema;
  assert.equal(schema.definitions.File.properties.file.contentEncoding, "base64");
  assert.equal(schema.definitions.File.properties.next.$ref, "#/definitions/File");
  assert.equal(schema.definitions.Unused, undefined);
  assert.ok(schema.required.includes("sandboxId"));
});

test("never lets action arguments override selected connection authorization", () => {
  const result = generateDaytonaCatalog({ api: { paths: { "/sandbox": { get: { operationId: "listSandboxes",
    parameters: [{ name: "Authorization", in: "header", schema: { type: "string" } },
      { name: "X-Daytona-Organization-ID", in: "header", schema: { type: "string" } }] } } } } });
  assert.equal(result.tools[0].parameters.length, 0);
  assert.equal(result.tools[0].inputSchema.properties.headers, undefined);
});

test("requires destructive permission for credentials, access changes, and interactive execution", () => {
  const result = generateDaytonaCatalog({ api: { paths: {
    "/secret/{id}": { get: { operationId: "getSecret" } },
    "/organizations/{id}/roles": { post: { operationId: "createRole" } },
    "/sandbox/{id}/ports/{port}/signed-preview-url": { get: { operationId: "getSignedPortPreviewUrl" } },
    "/sandbox/{id}/ttl/{minutes}": { post: { operationId: "setTtl" } },
    "/sandbox/{id}/autodelete/{interval}": { post: { operationId: "setAutoDeleteInterval" } },
  } }, toolbox: { paths: {
    "/computeruse/keyboard/type": { post: { operationId: "TypeText" } },
    "/process/session/{sessionId}/command/{commandId}/input": { post: { operationId: "SendInput" } },
    "/process/pty": { post: { operationId: "CreatePtySession" } },
    "/files/permissions": { post: { operationId: "SetFilePermissions" } },
  } } });
  for (const tool of result.tools) {
    assert.equal(tool.annotations.readOnlyHint, false, tool.name);
    assert.equal(tool.annotations.destructiveHint, true, tool.name);
  }
});
