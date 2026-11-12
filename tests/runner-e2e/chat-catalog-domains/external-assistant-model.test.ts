import { describe,expect,it } from "vitest";
import { runScopedCompanion } from "./external-assistant-model.js";
const query="Create a website task for Morgan in Acorn.",credential="fixture-private-provider-key";
const tool={name:"paperclip_create_task",description:"Create a task",inputSchema:{type:"object"}};
const response=(id:string,output:unknown[],extra:Record<string,unknown>={})=>new Response(JSON.stringify({id,model:"gpt-5.4-mini",usage:{input_tokens:40,output_tokens:20},output,...extra}));
describe("finite real-provider companion driver controls",()=>{
 it("sends the exact canonical input, dispatches only model-selected admitted calls and preserves provider/model/usage evidence",async()=>{
  const requests:Record<string,unknown>[]=[],calls:string[]=[];let n=0;
  const result=await runScopedCompanion({query,credential,tools:[tool],signal:new AbortController().signal,observe:async()=>{},call:async(name,args)=>{calls.push(name);return {task:{id:"task",title:args.title},url:"http://fixture.invalid/ACORN/issues/TASK-1"};},fetcher:async(_url,init)=>{requests.push(JSON.parse(String(init?.body)));return n++===0?response("resp_one",[{type:"function_call",name:tool.name,call_id:"call",arguments:JSON.stringify({title:"Website",requestId:"request"})}]):response("resp_two",[{type:"message",content:[{type:"output_text",text:"Created http://fixture.invalid/ACORN/issues/TASK-1"}]}]);}});
  expect(requests[0]!.input).toEqual([{role:"user",content:query}]);expect(JSON.stringify(requests)).not.toContain(credential);expect(result.messages.filter(row=>row.role==="user")).toEqual([{role:"user",content:query}]);expect(calls).toEqual([tool.name]);expect(result.providerResponseIds).toEqual(["resp_one","resp_two"]);expect(result.usage).toEqual({inputTokens:80,outputTokens:40});expect(result.links).toEqual(["http://fixture.invalid/ACORN/issues/TASK-1"]);expect(result.reply).not.toContain("requestId");
 });
 it("rejects missing response identity/model/usage, excessive output and unavailable tools before any such tool executes",async()=>{
  for(const body of [
   {id:"",model:"gpt-5.4-mini",usage:{input_tokens:1,output_tokens:1},output:[]},
   {id:"resp_id",model:"another-model",usage:{input_tokens:1,output_tokens:1},output:[]},
   {id:"resp_id",model:"gpt-5.4-mini",output:[]},
   {id:"resp_id",model:"gpt-5.4-mini",usage:{input_tokens:1,output_tokens:2049},output:[]},
   {id:"resp_id",model:"gpt-5.4-mini",usage:{input_tokens:1,output_tokens:1},output:[{type:"function_call",name:"board_rest",call_id:"bad",arguments:"{}"}]},
  ]){let called=false;await expect(runScopedCompanion({query,credential,tools:[tool],signal:new AbortController().signal,observe:async()=>{},call:async()=>{called=true;},fetcher:async()=>new Response(JSON.stringify(body))})).rejects.toThrow();expect(called).toBe(false);}
 });
 it("bounds four actual tool invocations and observes even failed or aborted workflows",async()=>{
  let calls=0,observed=0;
  await expect(runScopedCompanion({query,credential,tools:[tool],signal:new AbortController().signal,observe:async()=>{observed++;},call:async()=>{calls++;return {};},fetcher:async()=>response("resp_loop",Array.from({length:5},(_,i)=>({type:"function_call",name:tool.name,call_id:`call${i}`,arguments:"{}"})))})).rejects.toThrow(/tool-call bound/);
  expect(calls).toBe(4);expect(observed).toBeGreaterThan(0);
  const controller=new AbortController();controller.abort();let fetched=false;
  await expect(runScopedCompanion({query,credential,tools:[tool],signal:controller.signal,observe:async()=>{observed++;},call:async()=>({}),fetcher:async()=>{fetched=true;return response("resp_unexpected",[]);}})).rejects.toThrow();expect(fetched).toBe(false);
 });
});
