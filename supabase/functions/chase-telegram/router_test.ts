import { assertEquals } from "std/testing/asserts.ts";
import { routeQuery } from "./router.ts";

Deno.test("routeQuery: /start returns greeting (requiresAi=false)", () => {
  const result = routeQuery("/start");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: /help returns help text (requiresAi=false)", () => {
  const result = routeQuery("/help");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: /commands routes to help (requiresAi=false)", () => {
  const result = routeQuery("/commands");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: /overview returns overview (requiresAi=false)", () => {
  const result = routeQuery("/overview");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: /blocked returns blocked (requiresAi=false)", () => {
  const result = routeQuery("/blocked");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: /approvals returns approvals (requiresAi=false)", () => {
  const result = routeQuery("/approvals");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: /agents returns agents (requiresAi=false)", () => {
  const result = routeQuery("/agents");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: hello greeting (requiresAi=false)", () => {
  const result = routeQuery("hello");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: hi greeting (requiresAi=false)", () => {
  const result = routeQuery("hi");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: good morning greeting (requiresAi=false)", () => {
  const result = routeQuery("good morning");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: 'Chase' alone is greeting (requiresAi=false)", () => {
  const result = routeQuery("Chase");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: NL blocked query (requiresAi=false)", () => {
  const result = routeQuery("what tasks are blocked?");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: NL approval query (requiresAi=false)", () => {
  const result = routeQuery("show pending approvals");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: NL agent query (requiresAi=false)", () => {
  const result = routeQuery("who is on the team?");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: NL what is X working on (requiresAi=false)", () => {
  const result = routeQuery("what is Hunter working on?");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: NL 'have Christie send a report' → create issue (requiresAi=false)", () => {
  const result = routeQuery("have Christie send a report");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: NL 'tell Christie to send a report' → create issue (requiresAi=false)", () => {
  const result = routeQuery("tell Christie to send a report");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: NL 'ask Quinn to review CRE-306' → create issue (requiresAi=false)", () => {
  const result = routeQuery("ask Quinn to review CRE-306");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: /metar KDFW (requiresAi=false)", () => {
  const result = routeQuery("/metar KDFW");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: /taf KJFK (requiresAi=false)", () => {
  const result = routeQuery("/taf KJFK");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: /detail CRE-123 (requiresAi=false)", () => {
  const result = routeQuery("/detail CRE-123");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: /search something (requiresAi=false)", () => {
  const result = routeQuery("/search bug in router");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: unrecognized text uses LLM (requiresAi=true)", () => {
  const result = routeQuery("tell me about quantum computing");
  assertEquals(result.requiresAi, true);
});

Deno.test("routeQuery: 'who are you' identity question (requiresAi=false)", () => {
  const result = routeQuery("who are you");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: 'what are you' identity question (requiresAi=false)", () => {
  const result = routeQuery("what are you");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: 'who is chase' identity question (requiresAi=false)", () => {
  const result = routeQuery("who is chase");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: bare number routes to detail (requiresAi=false)", () => {
  const result = routeQuery("230");
  assertEquals(result.requiresAi, false);
});
Deno.test("routeQuery: greeting with name passes firstName", async () => {
  const result = routeQuery("hello", "Alice");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: NL 'metar KDFW' routes to weather (requiresAi=false)", () => {
  const result = routeQuery("metar KDFW");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: NL 'METAR for KJFK' routes to weather (requiresAi=false)", () => {
  const result = routeQuery("METAR for KJFK");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: NL 'weather at KLAX' routes to weather (requiresAi=false)", () => {
  const result = routeQuery("weather at KLAX");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: NL 'weather for KDFW' routes to weather (requiresAi=false)", () => {
  const result = routeQuery("weather for KDFW");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: NL 'taf KJFK' routes to TAF (requiresAi=false)", () => {
  const result = routeQuery("taf KJFK");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: NL 'TAF for KLAX' routes to TAF (requiresAi=false)", () => {
  const result = routeQuery("TAF for KLAX");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: NL 'forecast at KJFK' routes to TAF (requiresAi=false)", () => {
  const result = routeQuery("forecast at KJFK");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: NL 'give me the metar for KDFW' routes to weather (requiresAi=false)", () => {
  const result = routeQuery("give me the metar for KDFW");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: unrecognized short text uses LLM (requiresAi=true)", () => {
  const result = routeQuery("this is a random message that does not match any pattern");
  assertEquals(result.requiresAi, true);
});
