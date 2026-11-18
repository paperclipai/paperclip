import { mcpClientMirrorClientPages } from "./client-mirror-pages.js";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { test } from "vitest";
import { createPaperclipCloudConnector } from "../paperclip-cloud-connector.js";
import { mcpClientMirrorRequestSchema } from "./client-mirror-contract.js";
import { MCP_MIRROR_MAX_BINDING_BYTES, MCP_MIRROR_MAX_ENVELOPE_BYTES } from "./client-mirror-wire.js";

function owner(instanceId="unit-mirror-instance") {
  const signing=generateKeyPairSync("ed25519"),sealing=generateKeyPairSync("x25519");
  const captured:string[]=[];
  const connector=createPaperclipCloudConnector({config:{baseUrl:"https://my.paperclip.app",instanceId,environment:"production",
    signPrivateKey:signing.privateKey.export({format:"pem",type:"pkcs8"}).toString(),
    sealPrivateKey:sealing.privateKey.export({format:"pem",type:"pkcs8"}).toString()},
    request:async(_url,init)=>{captured.push(String(init?.body));return new Response(JSON.stringify({mcpClientMirror:{complete:false,nextSequence:0,receivedRecords:0}}),{status:200,headers:{"content-type":"application/json"}});}});
  return{connector,captured,signing};
}

test("unit controlled transport captures the actual signed and escaped MCP singleton body",async()=>{
  const f=owner(),origin="https://tenant.example.test",redirect="https://example.test/"+"\u0000".repeat(2048-21);
  const value=mcpClientMirrorRequestSchema.parse({version:1,instanceId:"unit-mirror-instance",origin,revision:1,baseRevision:null,expectedRecords:1,
    operation:"append",sequence:0,changes:[{operation:"upsert",client:{id:"client",name:"client",redirectUris:Array(10).fill(redirect),grantTypes:["authorization_code"]}}]});
  const binding=JSON.stringify(value);
  await f.connector.syncMcpClientMirror(binding);
  assert.equal(f.captured.length,1);
  const encoded=f.captured[0]!;
  assert.ok(Buffer.byteLength(encoded)>64000);
  assert.ok(Buffer.byteLength(encoded)<=MCP_MIRROR_MAX_ENVELOPE_BYTES);
  const body=JSON.parse(encoded);
  assert.equal(body.binding,binding);
  const [header,payload,signature]=body.request.split(".");
  assert.equal(verify(null,Buffer.from(header+"."+payload),f.signing.publicKey,Buffer.from(signature,"base64url")),true);
  const claims=JSON.parse(Buffer.from(payload,"base64url").toString("utf8"));
  assert.equal(claims.op,"mcp-client-mirror");
  assert.equal(claims.iss,"unit-mirror-instance");
  assert.equal(claims.sub,"instance-client-metadata");
  assert.equal(claims.cid,"instance-client-metadata");
  assert.equal(claims.aud,"https://my.paperclip.app/v1/connector/mcp-client-mirror");
  assert.equal(claims.exp-claims.iat,60);
  assert.equal(claims.sh,createHash("sha256").update(binding).digest("base64url"));
});

test("unit controlled transport refuses oversized MCP binding before invoking request",async()=>{
  const f=owner();
  await assert.rejects(f.connector.syncMcpClientMirror(JSON.stringify({padding:"x".repeat(MCP_MIRROR_MAX_BINDING_BYTES+1)})),/bounded wire contract/);
  assert.deepEqual(f.captured,[]);
});

test("unit controlled transport refuses a JWS beyond the unchanged 12000 character boundary",async()=>{
  const f=owner("i".repeat(12000));
  await assert.rejects(f.connector.syncMcpClientMirror("{}"),/bounded wire contract/);
  assert.deepEqual(f.captured,[]);
});

test("unit actual producer pages traverse the real signer once each with exact lossless bindings",async()=>{
  const f=owner(),origin="https://tenant.example.test";
  const identity={version:1 as const,instanceId:"unit-mirror-instance",origin,revision:1,baseRevision:null,expectedRecords:205};
  const changes=Array.from({length:205},(_,index)=>({operation:"delete" as const,clientId:"client-"+index}));
  const pages=mcpClientMirrorClientPages(identity,0,changes);
  for(const page of pages)await f.connector.syncMcpClientMirror(JSON.stringify(page));
  assert.equal(f.captured.length,pages.length);
  const sent=f.captured.map(encoded=>JSON.parse(JSON.parse(encoded).binding));
  assert.deepEqual(sent,pages);
  assert.deepEqual(sent.flatMap(page=>page.changes),changes);
  for(const body of f.captured)assert.ok(Buffer.byteLength(body)<=MCP_MIRROR_MAX_ENVELOPE_BYTES);
});
