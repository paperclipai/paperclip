import { assertEquals, assertStringIncludes } from "std/testing/asserts.ts";
import { routeQuery } from "./router.ts";
import {
  setupMockFetch,
  teardownMockFetch,
  setupPaperclipApiMocks,
  mockJsonResponse,
  mockFetch,
  mockTextResponse,
  SAMPLE_ISSUES,
  SAMPLE_AGENTS,
  SAMPLE_APPROVALS,
  SAMPLE_ISSUE_DETAIL,
} from "./test_helpers.ts";

// ─── Routing dispatch tests (existing) ─────────────────────────────

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

Deno.test("routeQuery: NL 'have Christie send a report' → preview (requiresAi=false)", () => {
  const result = routeQuery("have Christie send a report", undefined, 12345);
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: NL 'tell Christie to send a report' → preview (requiresAi=false)", () => {
  const result = routeQuery("tell Christie to send a report", undefined, 12345);
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: NL 'ask Quinn to review CRE-306' → preview (requiresAi=false)", () => {
  const result = routeQuery("ask Quinn to review CRE-306", undefined, 12345);
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

Deno.test("routeQuery: 'thanks' routes to acknowledgment (requiresAi=false)", () => {
  const result = routeQuery("thanks");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: 'thank you' routes to acknowledgment (requiresAi=false)", () => {
  const result = routeQuery("thank you");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: 'ty' routes to acknowledgment (requiresAi=false)", () => {
  const result = routeQuery("ty");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: 'thanks!' punctuation ok (requiresAi=false)", () => {
  const result = routeQuery("thanks!");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: 'ok' routes to acknowledgment (requiresAi=false)", () => {
  const result = routeQuery("ok");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: 'okay' routes to acknowledgment (requiresAi=false)", () => {
  const result = routeQuery("okay");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: 'roger' routes to acknowledgment (requiresAi=false)", () => {
  const result = routeQuery("roger");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: 'roger that' routes to acknowledgment (requiresAi=false)", () => {
  const result = routeQuery("roger that");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: 'copy' routes to acknowledgment (requiresAi=false)", () => {
  const result = routeQuery("copy");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: 'got it' routes to acknowledgment (requiresAi=false)", () => {
  const result = routeQuery("got it");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: 'understood' routes to acknowledgment (requiresAi=false)", () => {
  const result = routeQuery("understood");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: 'gotcha' routes to acknowledgment (requiresAi=false)", () => {
  const result = routeQuery("gotcha");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: 'nice' routes to acknowledgment (requiresAi=false)", () => {
  const result = routeQuery("nice");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: 'great' routes to acknowledgment (requiresAi=false)", () => {
  const result = routeQuery("great");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: 'awesome' routes to acknowledgment (requiresAi=false)", () => {
  const result = routeQuery("awesome");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: 'you're welcome' alone does not match ack but falls to LLM (requiresAi=true)", () => {
  const result = routeQuery("you're welcome");
  assertEquals(result.requiresAi, true);
});

Deno.test("routeQuery: 'Great! Thanks!' compound ack routes to acknowledgment (requiresAi=false)", () => {
  const result = routeQuery("Great! Thanks!");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: 'awesome, thanks!' compound ack routes to acknowledgment (requiresAi=false)", () => {
  const result = routeQuery("awesome, thanks!");
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

// ── Places slash commands ──

Deno.test("routeQuery: /movies location returns places (requiresAi=false)", () => {
  const result = routeQuery("/movies Austin");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: /restaurants location returns places (requiresAi=false)", () => {
  const result = routeQuery("/restaurants Brooklyn");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: /hotels location returns places (requiresAi=false)", () => {
  const result = routeQuery("/hotels Soho London");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: /movies with multiple words (requiresAi=false)", () => {
  const result = routeQuery("/movies downtown Austin");
  assertEquals(result.requiresAi, false);
});

// ── NL places queries ──

Deno.test("routeQuery: NL 'restaurants near Brooklyn' routes to places (requiresAi=false)", () => {
  const result = routeQuery("restaurants near Brooklyn");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: NL 'food around downtown Austin' routes to places (requiresAi=false)", () => {
  const result = routeQuery("food around downtown Austin");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: NL 'movies near Soho London' routes to places (requiresAi=false)", () => {
  const result = routeQuery("movies near Soho London");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: NL 'cinemas in Paris' routes to places (requiresAi=false)", () => {
  const result = routeQuery("cinemas in Paris");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: NL 'hotels close to airport' routes to places (requiresAi=false)", () => {
  const result = routeQuery("hotels close to airport");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: NL 'theatres near Times Square' routes to places (requiresAi=false)", () => {
  const result = routeQuery("theatres near Times Square");
  assertEquals(result.requiresAi, false);
});

Deno.test("routeQuery: NL 'places to eat near me' asks user to share location (requiresAi=true)", () => {
  const result = routeQuery("places to eat near me");
  assertEquals(result.requiresAi, true);
});

Deno.test("routeQuery: NL 'accommodation near beach' routes to places (requiresAi=false)", () => {
  const result = routeQuery("accommodation near beach");
  assertEquals(result.requiresAi, false);
});

// ─── Handler output verification tests (NEW) ───────────────────────

Deno.test({
  name: "routeQuery /start handler returns welcome text",
  async fn() {
    const { handler } = routeQuery("/start");
    const result = await handler();
    assertStringIncludes(result.text, "Jeff's Paperclip operations assistant");
    assertStringIncludes(result.text, "blocked work");
    assertStringIncludes(result.text, "/help");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery /help handler returns operations help text",
  async fn() {
    const { handler } = routeQuery("/help");
    const result = await handler();
    assertStringIncludes(result.text, "Jeff's Paperclip operations assistant");
    assertStringIncludes(result.text, "Checking Paperclip system status");
    assertStringIncludes(result.text, "blocked work");
    assertStringIncludes(result.text, "/commands");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery /commands handler returns commands list",
  async fn() {
    const { handler } = routeQuery("/commands");
    const result = await handler();
    assertStringIncludes(result.text, "Available commands");
    assertStringIncludes(result.text, "Instant commands");
    assertStringIncludes(result.text, "Paperclip lookup commands");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery hello handler returns greeting",
  async fn() {
    const { handler } = routeQuery("hello");
    const result = await handler();
    assertEquals(typeof result.text, "string");
    assertEquals(result.text.includes("?"), true);
    assertEquals(result.text.length > 10, true);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery greeting with firstName uses name",
  async fn() {
    const { handler } = routeQuery("hello", "Bob");
    const result = await handler();
    assertStringIncludes(result.text, "Bob");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery 'who are you' handler returns identity text",
  async fn() {
    const { handler } = routeQuery("who are you");
    const result = await handler();
    assertStringIncludes(result.text, "Jeff's Paperclip operations assistant");
    assertStringIncludes(result.text, "/help");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery 'thanks' handler returns ack",
  async fn() {
    const { handler } = routeQuery("thanks");
    const result = await handler();
    assertEquals(typeof result.text, "string");
    assertEquals(result.text.length > 10, true);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery /blocked handler returns blocked issues via API",
  async fn() {
    setupMockFetch();
    mockFetch(/status=blocked/, () => mockJsonResponse(
      SAMPLE_ISSUES.filter((i) => i.status === "blocked"),
    ));
    const { handler } = routeQuery("/blocked");
    const result = await handler();
    assertStringIncludes(result.text, "Blocked Issues");
    assertStringIncludes(result.text, "CRE-301");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery /approvals handler returns approvals via API",
  async fn() {
    setupMockFetch();
    mockFetch(/approvals/, () => mockJsonResponse(SAMPLE_APPROVALS));
    const { handler } = routeQuery("/approvals");
    const result = await handler();
    assertStringIncludes(result.text, "Pending Approvals");
    assertStringIncludes(result.text, "Deploy");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery /agents handler returns agents via API",
  async fn() {
    setupMockFetch();
    mockFetch(/agents/, () => mockJsonResponse(SAMPLE_AGENTS));
    const { handler } = routeQuery("/agents");
    const result = await handler();
    assertStringIncludes(result.text, "Agents");
    assertStringIncludes(result.text, "Jeff");
    assertStringIncludes(result.text, "Hayes");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery /detail handler returns issue via API",
  async fn() {
    setupMockFetch();
    mockFetch(/q=CRE-301/, () => mockJsonResponse([SAMPLE_ISSUE_DETAIL]));
    mockFetch(/\/api\/issues\/issue-1/, () => mockJsonResponse(SAMPLE_ISSUE_DETAIL));
    const { handler } = routeQuery("/detail CRE-301");
    const result = await handler();
    assertStringIncludes(result.text, "CRE-301");
    assertStringIncludes(result.text, "Fix login timeout bug");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery /search handler returns search results via API",
  async fn() {
    setupMockFetch();
    mockFetch(/q=login/, () => mockJsonResponse(SAMPLE_ISSUES));
    const { handler } = routeQuery("/search login");
    const result = await handler();
    assertStringIncludes(result.text, "Search results");
    assertStringIncludes(result.text, "login");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery /overview handler returns overview via API",
  async fn() {
    setupMockFetch();
    mockFetch(/agents/, () => mockJsonResponse(SAMPLE_AGENTS));
    mockFetch(/status=blocked/, () => mockJsonResponse(
      SAMPLE_ISSUES.filter((i) => i.status === "blocked"),
    ));
    const { handler } = routeQuery("/overview");
    const result = await handler();
    assertStringIncludes(result.text, "Company Overview");
    assertStringIncludes(result.text, "Agents:");
    assertStringIncludes(result.text, "Blocked issues:");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery /metar handler returns weather via API",
  async fn() {
    setupMockFetch();
    mockFetch(/aviationweather\.gov\/api\/data\/metar/, () =>
      mockTextResponse("KJFK 151651Z 21015G25KT 10SM FEW025")
    );
    const { handler } = routeQuery("/metar KJFK");
    const result = await handler();
    assertStringIncludes(result.text, "METAR for KJFK");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery /taf handler returns TAF via API",
  async fn() {
    setupMockFetch();
    mockFetch(/aviationweather\.gov\/api\/data\/taf/, () =>
      mockTextResponse("KJFK 151120Z 1512/1618 20012G20KT P6SM")
    );
    const { handler } = routeQuery("/taf KJFK");
    const result = await handler();
    assertStringIncludes(result.text, "TAF for KJFK");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery 'what is X working on' handler returns agent issues",
  async fn() {
    setupMockFetch();
    mockFetch(/agents/, () => mockJsonResponse(SAMPLE_AGENTS));
    mockFetch(/assigneeAgentId=agent-hunter/, () => mockJsonResponse(
      SAMPLE_ISSUES.filter((i) => i.assigneeAgentId === "agent-hunter"),
    ));
    const { handler } = routeQuery("what is Hunter working on?");
    const result = await handler();
    assertStringIncludes(result.text, "Hunter");
    assertStringIncludes(result.text, "CRE-301");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery 'have X do Y' shows task preview with confirmation",
  async fn() {
    setupMockFetch();
    mockFetch(/agents/, () => mockJsonResponse(SAMPLE_AGENTS));
    const { handler } = routeQuery("have Christie send a report", undefined, 12345);
    const result = await handler();
    assertStringIncludes(result.text, "I can create that task");
    assertStringIncludes(result.text, "Christie");
    assertStringIncludes(result.text, "a report");
    assertStringIncludes(result.text, "YES");
    teardownMockFetch();
    const { clearPendingTask } = await import("./lib/pending-tasks.ts");
    await clearPendingTask(12345);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery 'tell me about Hunter' handler returns agent issues",
  async fn() {
    setupMockFetch();
    mockFetch(/agents/, () => mockJsonResponse(SAMPLE_AGENTS));
    mockFetch(/assigneeAgentId=agent-hunter/, () => mockJsonResponse(
      SAMPLE_ISSUES.filter((i) => i.assigneeAgentId === "agent-hunter"),
    ));
    const { handler } = routeQuery("tell me about Hunter");
    const result = await handler();
    assertStringIncludes(result.text, "Hunter");
    assertStringIncludes(result.text, "Issues");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery 'tell me about blocked' handler returns blocked issues",
  async fn() {
    setupMockFetch();
    mockFetch(/status=blocked/, () => mockJsonResponse(
      SAMPLE_ISSUES.filter((i) => i.status === "blocked"),
    ));
    const { handler } = routeQuery("tell me about blocked");
    const result = await handler();
    assertStringIncludes(result.text, "Blocked Issues");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery 'what about Hunter' handler returns agent issues",
  async fn() {
    setupMockFetch();
    mockFetch(/agents/, () => mockJsonResponse(SAMPLE_AGENTS));
    mockFetch(/assigneeAgentId=agent-hunter/, () => mockJsonResponse(
      SAMPLE_ISSUES.filter((i) => i.assigneeAgentId === "agent-hunter"),
    ));
    const { handler } = routeQuery("what about Hunter");
    const result = await handler();
    assertStringIncludes(result.text, "Hunter");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery bare number handler resolves to issue detail",
  async fn() {
    setupMockFetch();
    mockFetch(/q=CRE-301/, () => mockJsonResponse([SAMPLE_ISSUE_DETAIL]));
    mockFetch(/\/api\/issues\/issue-1/, () => mockJsonResponse(SAMPLE_ISSUE_DETAIL));
    const { handler } = routeQuery("301");
    const result = await handler();
    assertStringIncludes(result.text, "CRE-301");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery 'good morning' handler returns greeting",
  async fn() {
    const { handler } = routeQuery("good morning");
    const result = await handler();
    assertEquals(result.text.includes("?"), true);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery 'Chase' alone handler returns greeting",
  async fn() {
    const { handler } = routeQuery("Chase");
    const result = await handler();
    assertEquals(result.text.includes("?"), true);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery NL weather 'weather at KLAX' returns METAR",
  async fn() {
    setupMockFetch();
    mockFetch(/aviationweather\.gov\/api\/data\/metar/, () =>
      mockTextResponse("KLAX 151651Z 21015KT 10SM FEW025 22/14 A3002")
    );
    const { handler } = routeQuery("weather at KLAX");
    const result = await handler();
    assertStringIncludes(result.text, "METAR for KLAX");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery 'what about blocked' handler routes to blocked (requiresAi=false)",
  async fn() {
    const result = routeQuery("what about blocked");
    assertEquals(result.requiresAi, false);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ── Web search ──

Deno.test({
  name: "routeQuery: /websearch routes to web search (requiresAi=false)",
  async fn() {
    const result = routeQuery("/websearch latest AI news");
    assertEquals(result.requiresAi, false);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery: /websearch with query routes to web search",
  async fn() {
    setupMockFetch();
    Deno.env.set("TAVILY_API_KEY", "test-key");
    mockFetch(/tavily/, () =>
      mockJsonResponse({
        results: [{ title: "AI News", url: "https://example.com", content: "Latest AI developments." }],
      })
    );

    const { handler } = routeQuery("/websearch AI news");
    const result = await handler();
    assertStringIncludes(result.text, "Search results");
    assertStringIncludes(result.text, "AI News");
    Deno.env.delete("TAVILY_API_KEY");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ── "near me" routing ──

Deno.test({
  name: "routeQuery: 'restaurants near me' asks user to share location (requiresAi=true)",
  async fn() {
    const result = routeQuery("restaurants near me");
    assertEquals(result.requiresAi, true);
    const handlerResult = await result.handler();
    assertStringIncludes(handlerResult.text, "share your location");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery: 'food near me' asks user to share location (requiresAi=true)",
  async fn() {
    const result = routeQuery("food near me");
    assertEquals(result.requiresAi, true);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery: 'movies around me' asks user to share location (requiresAi=true)",
  async fn() {
    const result = routeQuery("movies around me");
    assertEquals(result.requiresAi, true);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery: 'hotels near me' asks user to share location (requiresAi=true)",
  async fn() {
    const result = routeQuery("hotels near me");
    assertEquals(result.requiresAi, true);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery: 'places to eat near me' asks user to share location (requiresAi=true)",
  async fn() {
    const result = routeQuery("places to eat near me");
    assertEquals(result.requiresAi, true);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ── routeLocation ──

Deno.test({
  name: "routeLocation with no text returns acknowledgment on first share",
  async fn() {
    const { routeLocation } = await import("./router.ts");

    const handler = routeLocation(99991, 30.2672, -97.7431);
    const result = await handler();
    assertStringIncludes(result.text, "Location received");
    assertStringIncludes(result.text, "30.2672");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeLocation with no text returns empty text on subsequent share (live update)",
  async fn() {
    const { routeLocation } = await import("./router.ts");

    routeLocation(99992, 30.2672, -97.7431);
    const handler = routeLocation(99992, 30.2673, -97.7432);
    const result = await handler();
    assertEquals(result.text, "");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeLocation with 'restaurant' text returns restaurants",
  async fn() {
    setupMockFetch();
    const { routeLocation } = await import("./router.ts");
    mockFetch(/overpass-api/, () =>
      mockJsonResponse({
        elements: [{ tags: { name: "Taco Place", "addr:street": "Oak St" } }],
      })
    );

    const handler = routeLocation(99993, 40.7128, -74.006, "restaurants near me");
    const result = await handler();
    assertStringIncludes(result.text, "Restaurants");
    assertStringIncludes(result.text, "Taco Place");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeLocation with 'movie' text returns cinemas",
  async fn() {
    setupMockFetch();
    const { routeLocation } = await import("./router.ts");
    mockFetch(/overpass-api/, () =>
      mockJsonResponse({
        elements: [{ tags: { name: "Cineplex", "addr:street": "Broadway" } }],
      })
    );

    const handler = routeLocation(99994, 51.5074, -0.1278, "movies near me");
    const result = await handler();
    assertStringIncludes(result.text, "Cinemas");
    assertStringIncludes(result.text, "Cineplex");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeLocation with 'hotel' text returns hotels",
  async fn() {
    setupMockFetch();
    const { routeLocation } = await import("./router.ts");
    mockFetch(/overpass-api/, () =>
      mockJsonResponse({
        elements: [{ tags: { name: "The Plaza", "addr:street": "Park Ave" } }],
      })
    );

    const handler = routeLocation(99995, 48.8566, 2.3522, "hotels near me");
    const result = await handler();
    assertStringIncludes(result.text, "Hotels");
    assertStringIncludes(result.text, "The Plaza");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeLocation with /movies command returns cinemas",
  async fn() {
    setupMockFetch();
    const { routeLocation } = await import("./router.ts");
    mockFetch(/overpass-api/, () =>
      mockJsonResponse({
        elements: [{ tags: { name: "AMC" } }],
      })
    );

    const handler = routeLocation(99996, 35.0, -115.0, "/movies");
    const result = await handler();
    assertStringIncludes(result.text, "Cinemas");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeLocation with /restaurants command returns restaurants",
  async fn() {
    setupMockFetch();
    const { routeLocation } = await import("./router.ts");
    mockFetch(/overpass-api/, () =>
      mockJsonResponse({
        elements: [{ tags: { name: "Diner" } }],
      })
    );

    const handler = routeLocation(99997, 35.0, -115.0, "/restaurants");
    const result = await handler();
    assertStringIncludes(result.text, "Restaurants");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeLocation with /hotels command returns hotels",
  async fn() {
    setupMockFetch();
    const { routeLocation } = await import("./router.ts");
    mockFetch(/overpass-api/, () =>
      mockJsonResponse({
        elements: [{ tags: { name: "Motel" } }],
      })
    );

    const handler = routeLocation(99998, 35.0, -115.0, "/hotels");
    const result = await handler();
    assertStringIncludes(result.text, "Hotels");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ── routeVenue ──

Deno.test({
  name: "routeVenue stores location and returns venue acknowledgment",
  async fn() {
    const { routeVenue } = await import("./router.ts");

    const handler = routeVenue(99001, 40.7128, -74.006, "Test Venue", "123 Main St, NYC");
    const result = await handler();
    assertStringIncludes(result.text, "Location noted");
    assertStringIncludes(result.text, "Test Venue");
    assertStringIncludes(result.text, "123 Main St, NYC");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ── routeQuery with chatId: /mylocation ──

Deno.test({
  name: "routeQuery: /mylocation with no stored location says unknown",
  async fn() {
    const { clearAllLocations } = await import("./lib/location.ts");
    clearAllLocations();

    const result = routeQuery("/mylocation", undefined, 99010);
    assertEquals(result.requiresAi, false);
    const text = await result.handler().then(r => r.text);
    assertStringIncludes(text, "don't know your location");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery: /mylocation with stored location shows coordinates",
  async fn() {
    const { setUserLocation } = await import("./lib/location.ts");
    setUserLocation(99011, 51.5074, -0.1278, "manual");

    const result = routeQuery("/mylocation", undefined, 99011);
    assertEquals(result.requiresAi, false);
    const text = await result.handler().then(r => r.text);
    assertStringIncludes(text, "Your current location");
    assertStringIncludes(text, "51.5074");
    assertStringIncludes(text, "-0.1278");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery: /mylocation with venue stored shows venue info",
  async fn() {
    const { setUserLocation } = await import("./lib/location.ts");
    setUserLocation(99012, 48.8566, 2.3522, "venue", { title: "Louvre Museum", address: "Paris" });

    const result = routeQuery("/mylocation", undefined, 99012);
    const text = await result.handler().then(r => r.text);
    assertStringIncludes(text, "Louvre Museum");
    assertStringIncludes(text, "Paris");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ── routeQuery: near me with stored location ──

Deno.test({
  name: "routeQuery: near me with stored location routes to places search",
  async fn() {
    setupMockFetch();
    const { setUserLocation } = await import("./lib/location.ts");
    setUserLocation(99020, 40.7128, -74.006, "manual");

    mockFetch(/overpass-api/, () =>
      mockJsonResponse({
        elements: [{ tags: { name: "NYC Diner", "addr:street": "5th Ave" } }],
      })
    );

    const result = routeQuery("restaurants near me", undefined, 99020);
    assertEquals(result.requiresAi, false);
    const text = await result.handler().then(r => r.text);
    assertStringIncludes(text, "Restaurants");
    assertStringIncludes(text, "NYC Diner");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery: near me without stored location asks to share",
  async fn() {
    const { clearAllLocations } = await import("./lib/location.ts");
    clearAllLocations();

    const result = routeQuery("restaurants near me", undefined, 99021);
    assertEquals(result.requiresAi, true);
    const text = await result.handler().then(r => r.text);
    assertStringIncludes(text, "please share your location");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ── Location store unit tests ──

Deno.test({
  name: "location store: set and get user location",
  async fn() {
    const { setUserLocation, getUserLocation } = await import("./lib/location.ts");

    setUserLocation(99030, 10.0, 20.0, "manual");
    const loc = getUserLocation(99030);
    assertEquals(loc?.latitude, 10.0);
    assertEquals(loc?.longitude, 20.0);
    assertEquals(typeof loc?.updatedAt, "number");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "location store: venue info is stored",
  async fn() {
    const { setUserLocation, getUserLocation } = await import("./lib/location.ts");

    setUserLocation(99031, 10.0, 20.0, "venue", { title: "Cafe", address: "123 St" });
    const loc = getUserLocation(99031);
    assertEquals(loc?.venueTitle, "Cafe");
    assertEquals(loc?.venueAddress, "123 St");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "location store: clear user location",
  async fn() {
    const { setUserLocation, getUserLocation, clearUserLocation } = await import("./lib/location.ts");

    setUserLocation(99032, 10.0, 20.0, "manual");
    assertEquals(getUserLocation(99032) !== undefined, true);
    clearUserLocation(99032);
    assertEquals(getUserLocation(99032), undefined);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "location store: formatLocationDisplay formats correctly",
  async fn() {
    const { formatLocationDisplay } = await import("./lib/location.ts");

    const result = formatLocationDisplay({ latitude: 40.7128, longitude: -74.006, updatedAt: 0 });
    assertEquals(result, "40.7128, -74.0060");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "location store: getLocationContextString returns null when no location",
  async fn() {
    const { getLocationContextString, clearAllLocations } = await import("./lib/location.ts");
    clearAllLocations();

    const result = getLocationContextString(99999);
    assertEquals(result, null);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "location store: getLocationContextString returns formatted string",
  async fn() {
    const { setUserLocation, getLocationContextString, clearAllLocations } = await import("./lib/location.ts");
    clearAllLocations();

    setUserLocation(99040, 40.7128, -74.006, "manual");
    const result = getLocationContextString(99040);
    assertStringIncludes(result!, "40.7128");
    assertStringIncludes(result!, "-74.0060");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ── CRE-551: Fix capability-question false positives ──

Deno.test({
  name: "routeQuery: 'So do you now have Internet or AI access?' routes to AI chat (requiresAi=true) — no task",
  async fn() {
    const result = routeQuery("So do you now have Internet or AI access?", undefined, 12345);
    assertEquals(result.requiresAi, true);
  },
  sanitizeResources: false,
});

Deno.test({
  name: "routeQuery: 'Do you have Internet access?' routes to AI chat (requiresAi=true) — no task",
  async fn() {
    const result = routeQuery("Do you have Internet access?", undefined, 12345);
    assertEquals(result.requiresAi, true);
  },
  sanitizeResources: false,
});

Deno.test({
  name: "routeQuery: 'Do you have AI access?' routes to AI chat (requiresAi=true) — no task",
  async fn() {
    const result = routeQuery("Do you have AI access?", undefined, 12345);
    assertEquals(result.requiresAi, true);
  },
  sanitizeResources: false,
});

Deno.test({
  name: "routeQuery: 'Can you search the web?' routes to AI chat (requiresAi=true) — no task",
  async fn() {
    const result = routeQuery("Can you search the web?", undefined, 12345);
    assertEquals(result.requiresAi, true);
  },
  sanitizeResources: false,
});

Deno.test({
  name: "routeQuery: 'What can you do?' routes to AI chat (requiresAi=true) — no task",
  async fn() {
    const result = routeQuery("What can you do?", undefined, 12345);
    assertEquals(result.requiresAi, true);
  },
  sanitizeResources: false,
});

Deno.test({
  name: "routeQuery: 'Do you have my location?' routes to AI chat (requiresAi=true) — no task",
  async fn() {
    const result = routeQuery("Do you have my location?", undefined, 12345);
    assertEquals(result.requiresAi, true);
  },
  sanitizeResources: false,
});

// ── CRE-551: Fix task-request confirmation behavior ──

Deno.test({
  name: "routeQuery: 'Can you have Miles delete that last task?' shows preview (requiresAi=false) — no direct creation",
  async fn() {
    const result = routeQuery("Can you have Miles delete that last task?", undefined, 12345);
    assertEquals(result.requiresAi, false);
  },
  sanitizeResources: false,
});

Deno.test({
  name: "routeQuery: 'Can you have Miles delete that last task?' handler returns task preview with Miles assignee",
  async fn() {
    setupMockFetch();
    mockFetch(/agents/, () => mockJsonResponse(SAMPLE_AGENTS));
    const { handler } = routeQuery("Can you have Miles delete that last task?", undefined, 12345);
    const result = await handler();
    assertStringIncludes(result.text, "I can create that task");
    assertStringIncludes(result.text, "Miles");
    assertStringIncludes(result.text, "that last task");
    assertStringIncludes(result.text, "YES");
    teardownMockFetch();
    const { clearPendingTask } = await import("./lib/pending-tasks.ts");
    await clearPendingTask(12345);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery: 'Can you have Christie send a report' shows preview with Christie",
  async fn() {
    setupMockFetch();
    mockFetch(/agents/, () => mockJsonResponse(SAMPLE_AGENTS));
    const { handler } = routeQuery("Can you have Christie send a report", undefined, 12345);
    const result = await handler();
    assertStringIncludes(result.text, "I can create that task");
    assertStringIncludes(result.text, "Christie");
    teardownMockFetch();
    const { clearPendingTask } = await import("./lib/pending-tasks.ts");
    await clearPendingTask(12345);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery: non-confirmation message while pending reminds about pending task instead of routing",
  async fn() {
    const { setPendingTask } = await import("./lib/pending-tasks.ts");
    await setPendingTask(99051, {
      title: "Test task",
      description: "Test description",
      sourceMessage: "create a test task",
      createdAt: Date.now(),
    });
    // A query that would normally route to /blocked must instead remind about pending task
    const result = routeQuery("what is blocked?", undefined, 99051);
    assertEquals(result.requiresAi, false);
    const text = await result.handler().then(r => r.text);
    assertStringIncludes(text, "pending task");
    assertStringIncludes(text, "YES");
    const { clearPendingTask } = await import("./lib/pending-tasks.ts");
    await clearPendingTask(99051);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "routeQuery: vague acknowledgment while pending asks for clearer confirmation",
  async fn() {
    // First, set up a pending task
    const { setPendingTask } = await import("./lib/pending-tasks.ts");
    await setPendingTask(99050, {
      title: "Test task",
      description: "Test description",
      sourceMessage: "create a test task",
      createdAt: Date.now(),
    });
    const result = routeQuery("ok", undefined, 99050);
    assertEquals(result.requiresAi, false);
    const text = await result.handler().then(r => r.text);
    assertStringIncludes(text, "clear confirmation");
    assertStringIncludes(text, "YES");
    // Clean up
    const { clearPendingTask } = await import("./lib/pending-tasks.ts");
    await clearPendingTask(99050);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ── CRE-551: Malformed colon titles don't appear from capability questions ──

Deno.test({
  name: "routeQuery: capability question does not produce colon-title preview",
  async fn() {
    const result = routeQuery("So do you now have Internet or AI access?", undefined, 12345);
    assertEquals(result.requiresAi, true);
  },
  sanitizeResources: false,
});

Deno.test({
  name: "routeQuery: 'have' in middle of question does not trigger createIssueMatch",
  async fn() {
    // Previously matched unanchored /(?:have|...)/ → parsed "Internet" as agent → "Internet: or AI access?"
    // Anchored regex should no longer match
    const result = routeQuery("So do you now have Internet or AI access?", undefined, 12345);
    assertEquals(result.requiresAi, true);
  },
  sanitizeResources: false,
});
