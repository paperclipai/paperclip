import { createHmac } from "node:crypto";
import { describe,expect,it } from "vitest";
import { verifiedSlackRelayRequest } from "./external-slack-relay.js";
function signed(){const body=Buffer.from('{"type":"event_callback","event_id":"actual-event-fixture"}'),timestamp="1793050000",secret="synthetic-offline-signing-reference";return {pathname:"/api/chat-webhooks/disposable/slack",expectedPath:"/api/chat-webhooks/disposable/slack",body,headers:{"x-slack-request-timestamp":timestamp,"x-slack-signature":`v0=${createHmac("sha256",secret).update(`v0:${timestamp}:`).update(body).digest("hex")}`},signingSecret:secret,nowMs:Number(timestamp)*1000};}
describe("genuine Slack-signature preserving disposable relay",()=>{
 it("accepts exact signed bytes for its single endpoint",()=>expect(verifiedSlackRelayRequest(signed())).toBe(true));
 it("rejects a different endpoint, modified bytes, stale time and invented signatures",()=>{
  for(const mutate of [
   (i:ReturnType<typeof signed>)=>{i.pathname="/api/chat-webhooks/another/slack";},
   (i:ReturnType<typeof signed>)=>{i.body=Buffer.from('{"event_id":"forged-event"}');},
   (i:ReturnType<typeof signed>)=>{i.nowMs+=301000;},
   (i:ReturnType<typeof signed>)=>{i.headers["x-slack-signature"]="v0="+"0".repeat(64);},
  ]){const i=signed();mutate(i);expect(verifiedSlackRelayRequest(i)).toBe(false);}
 });
});

import {slackHumanConnectPayload} from "./external-slack-relay.js";
it("binds a genuine signed form's connect meaning to the exact selected human/workspace/channel/command",()=>{
 const expected={workspaceId:"T123",senderUserId:"U123",channelId:"C123",command:"/owned-agent"};
 const payload={team_id:"T123",user_id:"U123",channel_id:"C123",command:"/owned-agent",text:"connect"};
 const body=(value:typeof payload)=>Buffer.from(new URLSearchParams(value).toString());
 expect(slackHumanConnectPayload(body(payload),expected)).toBe(true);
 for(const wrong of [{...payload,user_id:"UOTHER"},{...payload,team_id:"TOTHER"},{...payload,channel_id:"COTHER"},{...payload,command:"/unrelated"},{...payload,text:"delete"}])expect(slackHumanConnectPayload(body(wrong),expected)).toBe(false);
 expect(slackHumanConnectPayload(Buffer.from(new URLSearchParams(payload).toString()+"&user_id=UOTHER"),expected)).toBe(false);
});
