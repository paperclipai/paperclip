import { createHmac,timingSafeEqual } from "node:crypto";
import { createServer,type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";

interface Captured {body:Buffer;headers:Record<string,string>;eventId:string}
export function verifiedSlackRelayRequest(input:{pathname:string;expectedPath:string;body:Buffer;headers:IncomingHttpHeaders;signingSecret:string;nowMs?:number}){
 if(input.pathname!==input.expectedPath||input.body.length>2*1024*1024)return false;
 const timestamp=input.headers["x-slack-request-timestamp"],signature=input.headers["x-slack-signature"];
 if(typeof timestamp!=="string"||!/^\d{10,13}$/.test(timestamp)||Math.abs((input.nowMs??Date.now())/1000-Number(timestamp))>300||typeof signature!=="string"||!/^v0=[a-f0-9]{64}$/.test(signature))return false;
 const expected=`v0=${createHmac("sha256",input.signingSecret).update(`v0:${timestamp}:`).update(input.body).digest("hex")}`;
 return timingSafeEqual(Buffer.from(signature),Buffer.from(expected));
}
/** A finite webhook relay for the designated disposable app, never a provider
 * emulator. Only genuine Slack-signed bytes for one actual endpoint are
 * forwarded. The one captured canonical delivery stays private in this closure
 * and may be replayed once to prove product idempotency. */
export function slackHumanConnectPayload(body:Buffer,expected:{workspaceId:string;senderUserId:string;channelId:string;command:string}){
 const form=new URLSearchParams(body.toString("utf8"));
 return ["team_id","user_id","channel_id","command","text"].every(key=>form.getAll(key).length===1)&&form.get("team_id")===expected.workspaceId&&form.get("user_id")===expected.senderUserId&&form.get("channel_id")===expected.channelId&&form.get("command")===expected.command&&form.get("text")==="connect";
}
export async function startSlackRelay(input:{port:number;endpointPublicId:string;baseURL:string;signingSecret:string;workspaceId:string;senderUserId:string;channelId:string}){
 if(!Number.isInteger(input.port)||input.port<1024||input.port>65535||!/^[a-zA-Z0-9_-]+$/.test(input.endpointPublicId)||!input.signingSecret)throw new Error("Setup blocker: a designated disposable Slack webhook relay port and signing reference are required");
 const target=new URL(input.baseURL);if(target.origin!==input.baseURL||target.hostname!=="127.0.0.1"||target.protocol!=="http:")throw new Error("Slack relay target must be the isolated loopback application");
 const expectedPath=`/api/chat-webhooks/${input.endpointPublicId}/slack`;let capture:Captured|undefined,expectedQuery:string|undefined,expectedThread:string|undefined,replayed=false;let forwarded=0,attempts=0;let humanCommand:string|undefined,humanConnectCaptured=false;
 async function forward(body:Buffer,headers:Record<string,string>,retry=false){
  if(++attempts>80)throw new Error("Slack relay exceeded its bounded callback count");
  const response=await fetch(new URL(expectedPath,target),{method:"POST",redirect:"error",signal:AbortSignal.timeout(20000),headers:{...headers,...retry?{"x-slack-retry-num":"1","x-slack-retry-reason":"http_timeout"}:{}},body:new Uint8Array(body)});
  const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>2*1024*1024)throw new Error("Slack relay response exceeds bounds");return {status:response.status,bytes,contentType:response.headers.get("content-type")??"application/json"};
 }
 const server=createServer(async(request,response)=>{
  try{
   if(request.method!=="POST"||request.url!==expectedPath){response.writeHead(404);response.end();return;}
   const chunks:Buffer[]=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>2*1024*1024)throw new Error("Webhook exceeds bounds");chunks.push(Buffer.from(chunk));}const body=Buffer.concat(chunks);
   if(!verifiedSlackRelayRequest({pathname:request.url,expectedPath,body,headers:request.headers,signingSecret:input.signingSecret})){response.writeHead(403);response.end();return;}
   const headers={"content-type":request.headers["content-type"]??"application/json","x-slack-signature":String(request.headers["x-slack-signature"]),"x-slack-request-timestamp":String(request.headers["x-slack-request-timestamp"])};
   if(headers["content-type"].split(";")[0]?.trim()==="application/x-www-form-urlencoded"){
    if(humanCommand&&slackHumanConnectPayload(body,{workspaceId:input.workspaceId,senderUserId:input.senderUserId,channelId:input.channelId,command:humanCommand}))humanConnectCaptured=true;
    const result=await forward(body,headers);forwarded++;response.writeHead(result.status,{"content-type":result.contentType});response.end(result.bytes);return;
   }
   const payload=JSON.parse(body.toString("utf8")) as {type?:string;team_id?:string;event_id?:string;event?:{type?:string;user?:string;channel?:string;thread_ts?:string;ts?:string;text?:string}};
   if(payload.type==="event_callback"&&payload.team_id!==input.workspaceId){response.writeHead(403);response.end();return;}
   const event=payload.event;if(expectedQuery&&payload.type==="event_callback"&&typeof payload.event_id==="string"&&event?.user===input.senderUserId&&event.channel===input.channelId&&event.text===expectedQuery&&(event.thread_ts??event.ts)===expectedThread){
    if(capture&&capture.eventId!==payload.event_id)throw new Error("More than one canonical provider event was captured");capture={body,headers,eventId:payload.event_id};
   }
   const result=await forward(body,headers);forwarded++;response.writeHead(result.status,{"content-type":result.contentType});response.end(result.bytes);
  }catch{response.writeHead(502);response.end("Disposable Slack relay failed; private details withheld");}
 });
 server.listen(input.port,"127.0.0.1");await once(server,"listening");
 return {expectedPath,
  expectHumanConnect(command:string){if(humanCommand||!/^\/[a-zA-Z0-9_-]{1,100}$/.test(command))throw new Error("Exactly one finite saved Slack human connect command is allowed");humanCommand=command;},
  expectCanonical(query:string,threadId:string){if(!query||capture||!/^\d+\.\d{6}$/.test(threadId))throw new Error("Slack relay capture has an invalid finite canonical phase");expectedQuery=query;expectedThread=threadId;},
  receipt(){return {forwarded,canonicalDeliveryCaptured:!!capture,duplicateReplayed:replayed,humanConnectCaptured};},
  async replayCanonicalOnce(){if(!capture||replayed)throw new Error("Exactly one genuine captured canonical Slack delivery may be replayed");replayed=true;const result=await forward(capture.body,capture.headers,true);return {status:result.status,providerEventCaptured:true};},
  nextFilePhase(){if(!capture)throw new Error("Cannot advance before a genuine canonical Slack event");capture=undefined;expectedQuery=undefined;expectedThread=undefined;replayed=false;},
  async close(){capture=undefined;expectedQuery=undefined;server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(new Error("Slack relay cleanup failed")):resolve()));},
 };
}
