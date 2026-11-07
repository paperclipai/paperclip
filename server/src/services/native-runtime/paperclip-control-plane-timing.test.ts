import { expect,it,vi } from "vitest";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { CONTROL_PLANE_CONFORMANCE_OPEN as OPEN,CONTROL_PLANE_CONFORMANCE_RESULT as result,CONTROL_PLANE_CONFORMANCE_TERMINAL as terminal } from "../../vendor/paperclip-runner/testing.js";

it.each(["inserted","replayed","failed"])("marks only a new result after transaction success (%s)",async(outcome)=>{
 let resolve!:(inserted:boolean)=>void,reject!:(error:unknown)=>void;
 const transaction=vi.fn(()=>new Promise<boolean>((yes,no)=>{resolve=yes;reject=no;}));
 const committed=vi.fn(async()=>{});
 const port=new PaperclipControlPlanePort({transaction} as never,{...OPEN.identity,completionContractId:"fixture",completionContractSha256:"fixture",sourceInstanceId:"fixture",controlPlaneSourceInstanceId:"fixture"},{onResultCommitted:committed});
 const pending=port.completeRun({result,terminal});
 expect(transaction).toHaveBeenCalledOnce();expect(committed).not.toHaveBeenCalled();
 if(outcome === "failed"){const error=Error("transaction rejected");reject(error);await expect(pending).rejects.toBe(error);expect(committed).not.toHaveBeenCalled();}
 else{resolve(outcome === "inserted");await pending;expect(committed).toHaveBeenCalledTimes(outcome === "inserted" ? 1 : 0);}
});
