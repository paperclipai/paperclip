import {describe,it,expect} from "vitest";
import {slackCallbackManifest} from "./external-slack-fixture.js";
const webhook="https://isolated.example.test/api/chat-webhooks/actual-public-id/slack";
const original=()=>({oauth_config:{scopes:{bot:["channels:history","chat:write"]}},settings:{event_subscriptions:{request_url:"https://old.example.test/events",bot_events:["message.channels"]},interactivity:{is_enabled:true,request_url:"https://old.example.test/actions"}},features:{slash_commands:[{command:"/owned",url:"https://old.example.test/command"}]}});
describe("actual disposable Slack app callback preparation",()=>{
 it("updates existing callback surfaces while retaining independent scopes/events and original restore manifest",()=>{
  const prior=original(),copy=structuredClone(prior),next=slackCallbackManifest(prior,webhook);
  expect(prior).toEqual(copy);expect(next.oauth_config).toEqual(copy.oauth_config);expect(next.settings.event_subscriptions.bot_events).toEqual(["message.channels"]);
  expect(next.settings.event_subscriptions.request_url).toBe(webhook);expect(next.settings.interactivity.request_url).toBe(webhook);expect(next.features.slash_commands[0].url).toBe(webhook);
 });
 it("cannot turn an unconfigured app or arbitrary callback URL into a passing Slack fixture",()=>{
  const noEvents=original();noEvents.settings.event_subscriptions.bot_events=[];
  expect(()=>slackCallbackManifest(noEvents,webhook)).toThrow(/already have authorized/);
  for(const path of ["http://isolated.example.test/api/chat-webhooks/id/slack","https://elsewhere.example.test/arbitrary-hook","https://isolated.example.test/api/chat-webhooks/id/slack?token=private"])
   expect(()=>slackCallbackManifest(original(),path)).toThrow();
 });
});
