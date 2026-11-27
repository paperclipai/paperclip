import {appendFile} from "node:fs/promises";
import {performance} from "node:perf_hooks";
import {eq,sql} from "drizzle-orm";
import {afterEach,beforeAll,beforeEach,describe,expect,it} from "vitest";
import {applyPendingMigrations,createDb,instanceSettings,type Db} from "@paperclipai/db";
import {resolveExternalTestDatabaseUrl} from "../../lib/dedicated-test-database-url.js";
import {externalBotEnabled} from "../../services/external-bot-authority.js";
import {instanceSettingsService} from "../../services/instance-settings.js";
import {museIdentity} from "../../services/muse-identity.js";

const url=resolveExternalTestDatabaseUrl("PAPERCLIP_FEATURE_OWNER_TEST_DATABASE_URL");
type QueryOwner=Pick<Db,"select">;
type Provider="openai_dot"|"grok_bot"|"muse";
const cases=[
  {provider:"openai_dot",enabled:true},
  {provider:"openai_dot",enabled:false},
  {provider:"grok_bot",enabled:true},
  {provider:"grok_bot",enabled:false},
  {provider:"muse",enabled:true},
  {provider:"muse",enabled:false},
] satisfies Array<{provider:Provider;enabled:boolean}>;
const states=new Set(["57014","40P01","55P03","08006","25P02"]);
function sqlState(error:unknown){
  let current=error;
  for(let depth=0;depth<3&&current&&typeof current==="object";depth++){
    if("code"in current&&typeof current.code==="string"&&states.has(current.code))return current.code;
    current="cause"in current?current.cause:undefined;
  }
  return "other";
}

describe.skipIf(!url)("existing external feature readers keep the admitted query owner",()=>{
  let db:Db;
  beforeAll(async()=>{await applyPendingMigrations(url!);},90_000);
  beforeEach(()=>{db=createDb(url!,{maxConnections:2,applicationName:"feature-owner-pool2"});});
  afterEach(async()=>{await db.$client.end({timeout:5});},30_000);
  for(const item of cases)it(`reads ${item.provider} enabled=${item.enabled} with both pool2 slots owned`,async()=>{
    const artifact=process.env.PAPERCLIP_FEATURE_OWNER_TRACE;
    if(!artifact)throw new Error("Explicit owned feature trace path required");
    const row=await instanceSettingsService(db).updateExperimental({
      enablePublicMcp:true,enableNativeRunner:true,
      enableOpenAiDot:item.provider==="openai_dot"?item.enabled:true,
      enableGrokBot:item.provider==="grok_bot"?item.enabled:true,
      enableMuse:item.provider==="muse"?item.enabled:true,
    });
    const started=performance.now(),events:Array<{phase:string;atMs:number}>=[];
    function mark(phase:string){
      if(events.length>=16)throw new Error("Feature owner trace overflow");
      events.push({phase,atMs:performance.now()-started});
      console.log(JSON.stringify({kind:"feature-owner-phase",provider:item.provider,enabled:item.enabled,phase}));
    }
    let competing:Promise<void>|undefined,competingError:string|null=null,observed:boolean|undefined;
    try{
      await db.transaction(async tx=>{
        mark("admission-transaction-entered");
        expect(await tx.select({id:instanceSettings.id}).from(instanceSettings).where(eq(instanceSettings.id,row.id)).for("update")).toHaveLength(1);
        mark("admission-row-locked");
        let occupiedResolve!:()=>void,occupiedReject!:(error:unknown)=>void;
        const occupied=new Promise<void>((resolve,reject)=>{occupiedResolve=resolve;occupiedReject=reject;});
        mark("competing-connection-requested");
        competing=db.transaction(async other=>{
          mark("competing-transaction-entered");
          await other.execute(sql`set local statement_timeout = '2000ms'`);
          mark("competing-timeout-installed");
          await other.execute(sql`select pg_backend_pid()`);
          mark("second-connection-owned");occupiedResolve();
          mark("competing-row-lock-requested");
          expect(await other.select({id:instanceSettings.id}).from(instanceSettings).where(eq(instanceSettings.id,row.id)).for("update")).toHaveLength(1);
          mark("competing-row-lock-acquired");
        }).then(()=>{mark("competing-committed");},error=>{
          competingError=sqlState(error);mark("competing-failed");occupiedReject(error);
        });
        await occupied;
        mark("feature-read-start");
        if(item.provider==="muse"){
          const read:(owner:QueryOwner)=>Promise<boolean>=museIdentity(db).enabled;
          observed=await read(tx);
        }else{
          const read:(root:Db,provider:"openai_dot"|"grok_bot",owner:QueryOwner)=>Promise<boolean>=externalBotEnabled;
          observed=await read(db,item.provider,tx);
        }
        mark("feature-read-finished");
      });
      mark("admission-committed");await competing;
      expect(competingError,JSON.stringify({events,competingError,observed})).toBeNull();
      expect(observed).toBe(item.enabled);
      const names=events.map(event=>event.phase);
      expect(names.indexOf("feature-read-finished")).toBeLessThan(names.indexOf("competing-row-lock-acquired"));
      expect(names).toContain("competing-committed");
      expect(await instanceSettingsService(db).getExperimentalReadOnly()).toMatchObject({
        enableOpenAiDot:item.provider==="openai_dot"?item.enabled:true,
        enableGrokBot:item.provider==="grok_bot"?item.enabled:true,
        enableMuse:item.provider==="muse"?item.enabled:true,
      });
    }finally{
      await competing;
      await appendFile(artifact,JSON.stringify({kind:"feature-owner-result",provider:item.provider,enabled:item.enabled,events,competingError,observed})+"\n",{mode:0o600});
    }
  },10_000);
});
