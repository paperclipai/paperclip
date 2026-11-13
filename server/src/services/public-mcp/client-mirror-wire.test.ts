import { mcpClientMirrorClientPages, mcpClientMirrorDevicePages } from "./client-mirror-pages.js";
import assert from "node:assert/strict";
import { test } from "vitest";
import { mcpClientMirrorRequestSchema } from "./client-mirror-contract.js";
import { assertMcpClientMirrorEnvelope, mcpClientMirrorPageFits, mcpClientMirrorRequestByteLimit,
  MCP_MIRROR_NORMAL_PAGE_BYTES, MCP_MIRROR_SINGLE_RECORD_BYTES,
  MCP_MIRROR_MAX_BINDING_BYTES, MCP_MIRROR_MAX_ENVELOPE_BYTES, MCP_MIRROR_MAX_JWS_CHARACTERS,
} from "./client-mirror-wire.js";

const origin="https://tenant.example.test";
const identity={version:1 as const,instanceId:"i".repeat(200),origin,authorizationOrigin:origin,revision:Number.MAX_SAFE_INTEGER,
  baseRevision:Number.MAX_SAFE_INTEGER,expectedRecords:Number.MAX_SAFE_INTEGER,
  deviceStatus:{keyId:"f".repeat(64),generation:"f".repeat(64),count:1000}};
const redirect="https://example.test/"+"\u0000".repeat(2048-21);
const client={id:"c".repeat(2048),name:"\u0000".repeat(100),redirectUris:Array(10).fill(redirect),grantTypes:["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:device_code"]};
const upsert={operation:"upsert",client};
const device={requestId:"00000000-0000-4000-8000-000000000000",fingerprint:"f".repeat(64),clientId:"\u0000".repeat(2048),resource:redirect,ingressOwner:"tenant" as const,status:"consumed" as const,expiresAt:Number.MAX_SAFE_INTEGER};
const size=(value:unknown)=>Buffer.byteLength(JSON.stringify(value),"utf8");

test("derived singleton bounds cover strict upsert, delete and device variants without dropping metadata",()=>{
  const variants=[
    {...identity,operation:"append",sequence:Number.MAX_SAFE_INTEGER,changes:[upsert]},
    {...identity,operation:"append",sequence:Number.MAX_SAFE_INTEGER,changes:[{operation:"delete",clientId:"\u0000".repeat(2048)}]},
    {...identity,operation:"append-device-status",sequence:Number.MAX_SAFE_INTEGER,entries:[device]},
  ];
  assert.ok(size(variants[0])>MCP_MIRROR_NORMAL_PAGE_BYTES);
  for(const value of variants){
    const parsed=mcpClientMirrorRequestSchema.parse(value);
    assert.deepEqual(parsed,value);
    assert.equal(mcpClientMirrorPageFits(value),true);
    assert.ok(size(value)<=mcpClientMirrorRequestByteLimit(value));
  }
  assert.ok(MCP_MIRROR_MAX_BINDING_BYTES>=Math.max(...Object.values(MCP_MIRROR_SINGLE_RECORD_BYTES)));
});

test("singleton exception cannot admit oversized multi-record, invalid, unknown or count-overflow data",()=>{
  assert.equal(mcpClientMirrorRequestSchema.safeParse({...identity,operation:"append",sequence:0,changes:[upsert,upsert]}).success,false);
  assert.equal(mcpClientMirrorRequestSchema.safeParse({...identity,operation:"append",sequence:0,changes:[{operation:"upsert",client:{...client,name:"n".repeat(101)}}]}).success,false);
  assert.equal(mcpClientMirrorRequestSchema.safeParse({...identity,operation:"append",sequence:0,changes:[{...upsert,extra:true}]}).success,false);
  assert.equal(mcpClientMirrorRequestSchema.safeParse({...identity,operation:"append-device-status",sequence:0,entries:[{...device,clientId:"c".repeat(2049)}]}).success,false);
  assert.equal(mcpClientMirrorRequestSchema.safeParse({...identity,operation:"append-device-status",sequence:0,entries:Array(201).fill(device)}).success,false);
  for(const change of [
    {operation:"delete",clientId:"c".repeat(2049)},
    {operation:"upsert",client:{...client,id:"c".repeat(2049)}},
    {operation:"upsert",client:{...client,redirectUris:["https://example.test/"+"a".repeat(2049-21)]}},
    {operation:"upsert",client:{...client,redirectUris:Array(11).fill("https://example.test/")}},
  ])assert.equal(mcpClientMirrorRequestSchema.safeParse({...identity,operation:"append",sequence:0,changes:[change]}).success,false);
  assert.equal(mcpClientMirrorRequestSchema.safeParse({...identity,instanceId:"i".repeat(201),operation:"complete"}).success,false);
  assert.equal(mcpClientMirrorRequestSchema.safeParse({...identity,operation:"append-device-status",sequence:0,entries:[{...device,resource:"https://example.test/"+"a".repeat(2049-21)}]}).success,false);
  for(const field of ["revision","baseRevision","expectedRecords","sequence"])assert.equal(mcpClientMirrorRequestSchema.safeParse({...identity,operation:"append",sequence:0,changes:[{operation:"delete",clientId:"client"}],[field]:-1}).success,false);
  assert.equal(mcpClientMirrorRequestSchema.safeParse({...identity,operation:"append-device-status",sequence:0,entries:[{...device,expiresAt:-1}]}).success,false);
  for(const operation of ["begin","complete","disable"])assert.equal(mcpClientMirrorRequestByteLimit({...identity,operation}),MCP_MIRROR_NORMAL_PAGE_BYTES);
});

test("normal pages keep the byte-and-count contract for escaped and nonASCII metadata",()=>{
  for(const text of ['"\\\n',"漢字🙂","\ud800"]){
    const change={operation:"upsert",client:{id:"c",name:text,redirectUris:["https://example.test/callback"],grantTypes:["authorization_code"]}};
    const candidate={...identity,operation:"append",sequence:0,changes:[change,change]};
    assert.equal(mcpClientMirrorPageFits(candidate),true);
    assert.deepEqual(mcpClientMirrorRequestSchema.parse(candidate),candidate);
  }
});

test("one exact encoded-envelope check enforces outerUTF8 and unchanged JWS bound",()=>{
  const binding=JSON.stringify({...identity,operation:"append",sequence:0,changes:[upsert]});
  const request="a".repeat(MCP_MIRROR_MAX_JWS_CHARACTERS);
  const body=JSON.stringify({request,binding});
  assert.ok(Buffer.byteLength(body)>64000);
  assert.ok(Buffer.byteLength(body)<=MCP_MIRROR_MAX_ENVELOPE_BYTES);
  assert.doesNotThrow(()=>assertMcpClientMirrorEnvelope(request,binding,body));
  assert.throws(()=>assertMcpClientMirrorEnvelope(request+"a",binding,body));
  assert.throws(()=>assertMcpClientMirrorEnvelope(request,"x".repeat(MCP_MIRROR_MAX_BINDING_BYTES+1),body));
  assert.throws(()=>assertMcpClientMirrorEnvelope(request,binding,"x".repeat(MCP_MIRROR_MAX_ENVELOPE_BYTES+1)));
});

test("actual domain packers preserve every record, page sequence and normal200/49152 limits",()=>{
  const clients=Array.from({length:205},(_,index)=>({operation:"delete" as const,clientId:"client-"+index}));
  const pages=mcpClientMirrorClientPages(identity,7,clients);
  assert.deepEqual(pages.map(page=>page.sequence),[7,8]);
  assert.deepEqual(pages.flatMap(page=>page.changes),clients);
  const entries=Array.from({length:1000},(_,index)=>({...device,requestId:`00000000-0000-4000-8000-${String(index).padStart(12,"0")}`,clientId:"legacy-client",resource:origin+"/mcp/paperclip"}));
  const devicePages=mcpClientMirrorDevicePages(identity,entries);
  assert.deepEqual(devicePages.flatMap(page=>page.entries),entries);
  assert.deepEqual(devicePages.map(page=>page.sequence),devicePages.map((_,index)=>index));
  for(const page of [...pages,...devicePages]){
    const count=page.operation==="append"?page.changes.length:page.entries.length;
    assert.ok(count>0&&count<=200);
    assert.ok(size(page)<=MCP_MIRROR_NORMAL_PAGE_BYTES||count===1);
    mcpClientMirrorRequestSchema.parse(page);
  }
});
