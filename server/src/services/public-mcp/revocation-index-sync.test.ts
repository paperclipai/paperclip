import { beforeEach, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { startMcpRevocationIndexSync } from "./revocation-index-sync.js";

const managed=vi.hoisted(()=>({value:null as {stackId:string;canonicalOrigin:string}|null}));
vi.mock("../cloud-runtime-identity.js",()=>({getCloudRuntimeIdentity:()=>managed.value}));
vi.mock("../paperclip-cloud-connector.js",()=>({paperclipCloudConnectorConfigFromEnv:()=>undefined,createPaperclipCloudConnector:vi.fn()}));
beforeEach(()=>{managed.value=null;});
function unitOwner(db:Db){
  const register=vi.fn(),publish=vi.fn();
  startMcpRevocationIndexSync(db,{register},{key:Buffer.alloc(32,9).toString("base64url"),client:{publish}});
  return{publish,run:()=>register.mock.calls[0]![1].run(new AbortController().signal)};
}
it("unit unmanaged index owner reads and publishes no local grant metadata",async()=>{
  const select=vi.fn(()=>{throw new Error("No unmanaged DB read permitted");});
  const owner=unitOwner({select} as unknown as Db);await owner.run();
  expect(select).not.toHaveBeenCalled();expect(owner.publish).not.toHaveBeenCalled();
});
it("unit current managed index selection uses only its two exact canonical resources",async()=>{
  managed.value={stackId:"managed-stack",canonicalOrigin:"https://managed.example.test"};
  const conditions:unknown[]=[];let reads=0;
  const db={select:()=>({from:()=>({where:(condition:unknown)=>{conditions.push(condition);return{limit:async()=>++reads===1?[{id:"grant"}]:[],orderBy:()=>({limit:async()=>[]})};}})})};
  const owner=unitOwner(db as unknown as Db);await owner.run();
  expect(conditions).toHaveLength(2);
  for(const condition of conditions){const query=new PgDialect().sqlToQuery(condition as Parameters<PgDialect["sqlToQuery"]>[0]);expect(query.params).toContain("https://managed.example.test/mcp/paperclip");expect(query.params).toContain("https://managed.example.test/mcp/runner");expect(query.sql).not.toContain(" ~ ");}
  expect(owner.publish).not.toHaveBeenCalled();
});
it("unit identity loss during a local read refuses the outbound publication",async()=>{
  managed.value={stackId:"managed-stack",canonicalOrigin:"https://managed.example.test"};
  const grant={id:"grant",companyId:"company",userId:"operator",clientId:"client",resource:"https://managed.example.test/mcp/paperclip",revocationRevision:0,revocationIndexReceipt:null};
  const db={select:()=>({from:()=>({where:()=>({limit:async()=>[{id:grant.id}],orderBy:()=>({limit:async()=>{managed.value=null;return[{grant}];}})})})})};
  const owner=unitOwner(db as unknown as Db);await expect(owner.run()).rejects.toThrow("current authority changed");expect(owner.publish).not.toHaveBeenCalled();
});
