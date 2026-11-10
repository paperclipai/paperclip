// PRIVATE finite IPC client, matching only actual fixture commands.
import type { ChildProcess } from "node:child_process";
import type { startNormalDotAppGeneration } from "./normal-app-generation.js";
import type { installDotChildPorts } from "./child-observation.js";
export type ChildSnapshot={owner:ReturnType<Awaited<ReturnType<typeof startNormalDotAppGeneration>>["snapshot"]>;
  database:ReturnType<Awaited<ReturnType<typeof installDotChildPorts>>["snapshot"]>};
export type ChildControl={command:"snapshot"|"inspect"}|{command:"health";value:"ready"|"unavailable"|"wake-once-then-unavailable"}
  |{command:"device-stage";value:"first-select"|"retry-select"|"none"}
  |{command:"drain-run";runId:string}|{command:"stop-checkpointed";runId:string;environmentId:string};
export function attachDotChild(child:ChildProcess,onEvent:(event:Record<string,unknown>)=>void){
  let serial=0,failures=0;const pending=new Map<number,{resolve:(value:ChildSnapshot&{result?:unknown})=>void;reject:(error:Error)=>void}>();
  child.on("message",(value:unknown)=>{
    if(!value||typeof value!=="object")return;const event=value as Record<string,unknown>;
    if(event.kind==="snapshot"&&typeof event.id==="number"){
      const request=pending.get(event.id);if(!request){failures++;return;}pending.delete(event.id);
      if(!event.owner||!event.database){request.reject(new Error("owned_child_snapshot_missing"));return;}
      request.resolve(event as unknown as ChildSnapshot&{result?:unknown});return;
    }
    if(event.kind==="failed"){failures++;for(const request of pending.values())request.reject(new Error("owned_child_control_failed"));pending.clear();}
    onEvent(event);
  });
  child.once("close",()=>{for(const request of pending.values())request.reject(new Error("owned_child_closed_with_pending_control"));pending.clear();});
  return{async request(command:ChildControl,deadline:number){
    const remaining=deadline-performance.now();if(remaining<=0||!child.connected)throw new Error("owned_child_original_deadline_or_transport_unavailable");
    const id=++serial;let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await new Promise<ChildSnapshot&{result?:unknown}>((resolve,reject)=>{
      pending.set(id,{resolve,reject});timer=setTimeout(()=>{pending.delete(id);failures++;reject(new Error("owned_child_original_control_deadline_exhausted"));},remaining);
      child.send({...command,id},error=>{if(error){pending.delete(id);failures++;reject(new Error("owned_child_control_send_failed"));}});
    });}finally{clearTimeout(timer);}
  },snapshot:()=>({pending:pending.size,failures})};
}
