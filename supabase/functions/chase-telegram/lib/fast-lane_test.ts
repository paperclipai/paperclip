import { assertEquals } from "std/testing/asserts.ts";
import { isFastLaneMessage } from "./fast-lane.ts";

Deno.test({
  name: "isFastLaneMessage returns true for greetings",
  fn() {
    assertEquals(isFastLaneMessage("hello"), true);
    assertEquals(isFastLaneMessage("hi"), true);
    assertEquals(isFastLaneMessage("hey"), true);
    assertEquals(isFastLaneMessage("good morning"), true);
    assertEquals(isFastLaneMessage("Good afternoon"), true);
    assertEquals(isFastLaneMessage("good evening"), true);
    assertEquals(isFastLaneMessage("what's up"), true);
    assertEquals(isFastLaneMessage("howdy"), true);
    assertEquals(isFastLaneMessage("Chase"), true);
    assertEquals(isFastLaneMessage("Hi, Chase!"), true);
    assertEquals(isFastLaneMessage("Hey there"), true);
    assertEquals(isFastLaneMessage("yo"), true);
  },
});

Deno.test({
  name: "isFastLaneMessage returns true for identity questions",
  fn() {
    assertEquals(isFastLaneMessage("who are you"), true);
    assertEquals(isFastLaneMessage("what are you"), true);
    assertEquals(isFastLaneMessage("who's Chase"), true);
    assertEquals(isFastLaneMessage("what is this bot"), true);
    assertEquals(isFastLaneMessage("who are you?"), true);
  },
});

Deno.test({
  name: "isFastLaneMessage returns true for acknowledgments",
  fn() {
    assertEquals(isFastLaneMessage("thanks"), true);
    assertEquals(isFastLaneMessage("thank you"), true);
    assertEquals(isFastLaneMessage("ok"), true);
    assertEquals(isFastLaneMessage("okay"), true);
    assertEquals(isFastLaneMessage("sure"), true);
    assertEquals(isFastLaneMessage("got it"), true);
    assertEquals(isFastLaneMessage("great, thanks"), true);
    assertEquals(isFastLaneMessage("awesome, thanks!"), true);
    assertEquals(isFastLaneMessage("nice, thanks!"), true);
  },
});

Deno.test({
  name: "isFastLaneMessage returns true for simple slash commands",
  fn() {
    assertEquals(isFastLaneMessage("/start"), true);
    assertEquals(isFastLaneMessage("/help"), true);
    assertEquals(isFastLaneMessage("/blocked"), true);
    assertEquals(isFastLaneMessage("/overview"), true);
    assertEquals(isFastLaneMessage("/approvals"), true);
    assertEquals(isFastLaneMessage("/agents"), true);
    assertEquals(isFastLaneMessage("/commands"), true);
    assertEquals(isFastLaneMessage("/about"), true);
    assertEquals(isFastLaneMessage("/ping"), true);
    assertEquals(isFastLaneMessage("/version"), true);
    assertEquals(isFastLaneMessage("/spend"), true);
    assertEquals(isFastLaneMessage("/recent"), true);
    assertEquals(isFastLaneMessage("/company"), true);
  },
});

Deno.test({
  name: "isFastLaneMessage returns true for /help and /commands regardless of trailing content (matches router \b)",
  fn() {
    assertEquals(isFastLaneMessage("/help me"), true);
    assertEquals(isFastLaneMessage("/commands list"), true);
    assertEquals(isFastLaneMessage("/help "), true);
    assertEquals(isFastLaneMessage("/commands "), true);
    assertEquals(isFastLaneMessage("/help!"), true);
  },
});

Deno.test({
  name: "isFastLaneMessage returns true for simple NL lookup queries",
  fn() {
    assertEquals(isFastLaneMessage("what's blocked"), true);
    assertEquals(isFastLaneMessage("show blocked issues"), true);
    assertEquals(isFastLaneMessage("pending approvals"), true);
    assertEquals(isFastLaneMessage("company overview"), true);
    assertEquals(isFastLaneMessage("list agents"), true);
    assertEquals(isFastLaneMessage("what is Hunter working on"), true);
    assertEquals(isFastLaneMessage("how is Quinn doing"), true);
    assertEquals(isFastLaneMessage("what's the status of CRE-301"), true);
    assertEquals(isFastLaneMessage("who is on the team"), true);
    assertEquals(isFastLaneMessage("show agents"), true);
    assertEquals(isFastLaneMessage("detail CRE-301"), true);
  },
});

Deno.test({
  name: "isFastLaneMessage returns false for complex/action queries",
  fn() {
    assertEquals(isFastLaneMessage("create a new task for Hunter to review the PR"), false);
    assertEquals(isFastLaneMessage("have Christie send a report"), false);
    assertEquals(isFastLaneMessage("tell Quinn to check quality"), false);
    assertEquals(isFastLaneMessage("ask Hunter to review the PR"), false);
    assertEquals(isFastLaneMessage("METAR KDFW"), false);
    assertEquals(isFastLaneMessage("weather at KJFK"), false);
    assertEquals(isFastLaneMessage("TAF KLAX"), false);
    assertEquals(isFastLaneMessage("restaurants near downtown Austin"), false);
    assertEquals(isFastLaneMessage("search the web for AI news"), false);
    assertEquals(isFastLaneMessage("delete CRE-549"), false);
    assertEquals(isFastLaneMessage("mark CRE-301 done"), false);
    assertEquals(isFastLaneMessage("can you close CRE-301"), false);
  },
});

Deno.test({
  name: "isFastLaneMessage returns false for empty or short gibberish",
  fn() {
    assertEquals(isFastLaneMessage(""), false);
    assertEquals(isFastLaneMessage("   "), false);
    assertEquals(isFastLaneMessage("a"), false);
    assertEquals(isFastLaneMessage("lorem ipsum"), false);
  },
});
