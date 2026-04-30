---
chapter_num: 3
title: "Multi-Agent Orchestration with Vertex"
course_slug: gemini-enterprise-agent-platform-hands-on-tour
prerequisites_chapters: [1, 2]
duration_min: 60
reading_time_min: 60
date: 2026-04-30
status: draft-for-review
author: Koenig AI Academy
agent_drafted_by: course-author
content_type: course-chapter
ticket: KOE-33
vendor_tag: google
learning_objectives:
  - "Explain the difference between deterministic and generative orchestration patterns in GEAP"
  - "Wire a supervisor agent that delegates to two specialist sub-agents"
  - "Use Agent Registry to discover and call a registered agent by name"
  - "Read an Agent Observability trace to debug a failed agent handoff"
sources:
  - https://cloud.google.com/blog/products/ai-machine-learning/introducing-gemini-enterprise-agent-platform
  - https://adk.dev/
  - https://cloud.google.com/vertex-ai/docs/generative-ai/agent-builder/multi-agent
  - https://cloud.google.com/vertex-ai/docs/generative-ai/agent-builder/agent-registry
  - https://cloud.google.com/vertex-ai/docs/generative-ai/agent-builder/observability
---

# Multi-Agent Orchestration with Vertex

GEAP's agent-to-agent orchestration system, available since Gemini Enterprise Agent Platform's general availability on 23 April 2026, lets a single coordinator delegate work to 2 or more specialist sub-agents — turning a fragile 20-tool monolith into a testable, independently-deployable network. Production breaks the single-agent model fast: a customer-support agent covering account management, billing, and technical support accumulates enough tools and instruction length to produce correlated hallucinations. The correct answer is **decomposition** — split the monolith into specialist agents and give them a coordinator.

This chapter builds that coordinator. By the end you will have a two-agent research pipeline: a Planner that decomposes a question into sub-questions, and a Retriever that answers each one. You will wire them through Agent Registry so the Planner discovers the Retriever by name rather than by hardcoded import, and you will use Agent Observability to walk through a trace when the handoff breaks.

## Key facts

1. GEAP supports two orchestration patterns: **deterministic** (you define routing logic in code) and **generative** (the orchestrator model decides routing at runtime)
2. Sub-agents are ADK Agent instances — same class, different instruction and tools
3. `transfer_to_agent(agent_name)` is the built-in ADK mechanism for generative handoff; the orchestrator calls it as a tool
4. Agent Registry is a GCP-managed catalogue; agents discover sub-agents by name via the Registry API, not by Python import
5. Agent Anomaly Detection flags unusual reasoning patterns — including infinite handoff loops — without you writing watchdog code [1]
6. ADK's `SequentialAgent` and `ParallelAgent` are the code primitives for deterministic orchestration
7. Observability traces are available in the GCP console under GEAP > Observability within seconds of a completed invocation

---

## Two orchestration patterns, one choice to make

Before writing code, you need to decide which pattern fits your use case. The choice has downstream consequences for debugging, cost, and reliability.

### Deterministic orchestration

You write the routing logic. Sub-agent A always runs first, then sub-agent B gets A's output. Or: A and B run in parallel; their outputs are merged by a deterministic merge function.

ADK provides `SequentialAgent` and `ParallelAgent` for this:

```python
from google.adk.agents import SequentialAgent, ParallelAgent

# Sequential: planner output → retriever
pipeline = SequentialAgent(
    name="research_pipeline",
    agents=[planner_agent, retriever_agent],
)

# Parallel: both agents run simultaneously, results merged
parallel_lookup = ParallelAgent(
    name="parallel_lookup",
    agents=[weather_agent, news_agent],
)
```

**When to use**: When the routing logic is stable and you want predictable costs (you know exactly which agents run). Good for ETL-style pipelines, data enrichment, and report generation.

**Tradeoff**: Brittle under changing inputs. If the Planner sometimes determines that no sub-questions are needed, a rigid sequential pipeline still invokes the Retriever anyway.

### Generative orchestration

The orchestrator is an Agent with a strong instruction and a special `transfer_to_agent` tool. The model reads the user's request and decides at runtime which sub-agent to invoke, whether to invoke multiple, and in what order.

**When to use**: When routing decisions depend on the content of user input in ways you cannot enumerate. Good for customer support triage, intent-based routing, and dynamic workflows.

**Tradeoff**: Non-deterministic costs (you do not know how many sub-agent calls occur), harder to test exhaustively, and more susceptible to jailbreak if the orchestrator instruction is weak.

For this chapter we build a generative orchestration pipeline, because it showcases more GEAP-specific features. The Chapter 3 hands-on exercise includes a note on when to prefer the deterministic version.

---

## Building the sub-agent: Retriever

Create `research_pipeline/retriever.py`:

```python
from google.adk import Agent


def search_knowledge_base(query: str) -> str:
    """Search the internal knowledge base for information relevant to a query.

    Use this tool when you have a specific factual question to answer.

    Args:
        query: The specific question to answer.

    Returns:
        A string containing the most relevant information found, or a
        'no results' message if nothing was found.
    """
    # In production, this calls a vector database, RAG pipeline, or search API.
    # For demo purposes, we return canned responses.
    knowledge = {
        "gemini enterprise agent platform ga date": "GEAP reached general availability on 23 April 2026.",
        "geap memory bank purpose": "Memory Bank stores long-term cross-session context as distilled Memory Profiles, enabling agents to recall user preferences and history across conversations.",
        "adk install command": "Install the Agent Development Kit with: pip install google-adk",
        "agent registry purpose": "Agent Registry is a centralized catalogue of approved tools, agents, and capabilities. Agents discover sub-agents by name via Registry rather than hardcoded imports.",
    }
    # Simple keyword match for demo; real implementation uses semantic search.
    query_lower = query.lower()
    for key, value in knowledge.items():
        if any(word in query_lower for word in key.split()):
            return value
    return f"No results found for: {query}"


retriever_agent = Agent(
    name="retriever",
    model="gemini-flash-latest",
    description="A specialist agent that answers specific factual questions by searching the knowledge base.",
    instruction="""You are a precise factual retriever. 

When given a question, call search_knowledge_base with the question text.
Return only what you found — do not add interpretation or speculation.
If the search returns no results, say so clearly.""",
    tools=[search_knowledge_base],
)
```

---

## Building the orchestrator: Planner

The Planner does two things: it decomposes a complex question into sub-questions, and it hands each sub-question to the Retriever using `transfer_to_agent`.

Create `research_pipeline/planner.py`:

```python
from google.adk import Agent
from google.adk.tools import transfer_to_agent


planner_agent = Agent(
    name="planner",
    model="gemini-pro-latest",  # use a stronger model for orchestration reasoning
    description="An orchestrator that decomposes research questions and coordinates specialist agents.",
    instruction="""You are a research coordinator. Your job:

1. DECOMPOSE: When given a complex question, break it into 2-4 specific sub-questions.
2. DELEGATE: For each sub-question, transfer to the 'retriever' agent to get the answer.
3. SYNTHESISE: After all sub-questions are answered, compile a clear, complete response.

Rules:
- Always decompose before delegating. Never answer factual questions yourself.
- Transfer one sub-question at a time; wait for the result before the next transfer.
- If the original question is already specific enough (one fact to look up), skip decomposition and delegate directly.
- Your final response must cite which sub-questions were answered.""",
    tools=[transfer_to_agent],
    # Register sub-agents that this orchestrator can delegate to.
    # ADK resolves these by name at runtime; they do not need to be imported.
    sub_agents=["retriever"],
)
```

`transfer_to_agent` is a built-in ADK tool. When the Planner calls it with `agent_name="retriever"` and a message, ADK routes the message to the Retriever agent and returns the Retriever's response to the Planner. The Planner then continues its reasoning with that answer in context.

<Callout type="info">
**Why `sub_agents` matters**: Declaring `sub_agents=["retriever"]` tells ADK which agents this orchestrator is allowed to delegate to. It is both a security boundary and a documentation aid — Agent Registry uses this declaration to build the graph of agent dependencies.
</Callout>

---

## Step 3: Wire the pipeline

Create `research_pipeline/agent.py`:

```python
from research_pipeline.planner import planner_agent
from research_pipeline.retriever import retriever_agent
from google.adk.sessions import InMemorySessionService

session_service = InMemorySessionService()

# The entry point is the planner. ADK will start here and let it delegate to retriever.
root_agent = planner_agent
```

Run it:

```bash
adk web research_pipeline/
```

<RunPromptCell
  model="gemini-pro-latest"
  tools={["transfer_to_agent", "search_knowledge_base"]}
  prompt="Tell me about Gemini Enterprise Agent Platform: when it launched, how to install it, and what Memory Bank does."
  expectedOutput={`I'll break this into three specific questions.

**Sub-question 1**: When did GEAP launch?
[transfer_to_agent: retriever]
→ "GEAP reached general availability on 23 April 2026."

**Sub-question 2**: How do I install the ADK?
[transfer_to_agent: retriever]
→ "Install the Agent Development Kit with: pip install google-adk"

**Sub-question 3**: What does Memory Bank do?
[transfer_to_agent: retriever]
→ "Memory Bank stores long-term cross-session context as distilled Memory Profiles, enabling agents to recall user preferences and history across conversations."

---

Here's what I found:

**Gemini Enterprise Agent Platform** launched on **23 April 2026** (GA). 

To get started, install the ADK: \`pip install google-adk\`

**Memory Bank** provides long-term cross-session memory — instead of rebuilding context from raw conversation history, it stores distilled "Memory Profiles" so agents can recall what they need at low latency.`}
/>

<KnowledgeCheck
  questions={[
    {
      question: "The Planner agent calls transfer_to_agent('retriever', question). Where does ADK look to find the retriever agent at runtime?",
      answers: [
        "It imports the retriever module directly from the Python path",
        "It queries Agent Registry, resolving 'retriever' to a registered agent definition",
        "It looks for a class named RetrieverAgent in the same file",
        "It sends an HTTP request to a hardcoded localhost endpoint"
      ],
      correct: 1,
      explanation: "In production on Vertex, ADK resolves agent names through Agent Registry — a centralized catalogue of approved agents. Locally, ADK uses the sub_agents declaration to resolve names within the same session."
    },
    {
      question: "You are building a data enrichment pipeline where step B always runs after step A, regardless of what A returns. Which orchestration pattern is more appropriate?",
      answers: [
        "Generative — use transfer_to_agent and let the model decide",
        "Deterministic — use SequentialAgent to define the fixed routing",
        "Either — they produce identical results for this case",
        "Neither — GEAP does not support data pipelines"
      ],
      correct: 1,
      explanation: "When routing is fixed and predictable, deterministic orchestration (SequentialAgent) is the right choice. It gives predictable costs, easier testing, and no risk of the model skipping or reordering steps."
    }
  ]}
/>

---

## Step 4: Register agents in Agent Registry

In local development, agent resolution is handled in-process. In production on Vertex, you register agents in Agent Registry so the platform manages discovery, versioning, and access control.

Register the retriever via ADK CLI (requires a deployed Agent Runtime):

```bash
adk agents register retriever \
  --engine-id=YOUR_ENGINE_ID \
  --project=YOUR_PROJECT \
  --location=us-central1 \
  --description="Answers factual questions via knowledge base search"
```

After registration, any other agent in the same project can call `transfer_to_agent("retriever", ...)` and ADK resolves it through Registry — no hardcoded endpoints, no shared Python modules. This is the key governance benefit: the Registry owner controls which agents are discoverable and which are retired.

<Callout type="warning">
**Registry is not import control.** Agent Registry controls discovery, not execution security. A rogue agent that knows a sub-agent's name directly can still call it if it has the right IAM permissions. For true isolation, combine Registry with Agent Gateway policies that restrict which caller identities can invoke which agents.
</Callout>

---

## Step 5: Reading an Observability trace

When the Planner hands off to the Retriever and the Retriever returns the wrong answer, how do you debug it? The Agent Observability console shows the full execution trace.

A trace for a multi-agent call looks like this:

```
Trace: user-request-7f3a
├─ [0.000s] planner: received user message
│    input: "Tell me about GEAP..."
├─ [0.312s] planner: model reasoning
│    thinking: "Decompose into 3 sub-questions..."
├─ [0.891s] planner: tool_call transfer_to_agent
│    args: {agent_name: "retriever", message: "When did GEAP launch?"}
│    ├─ [0.892s] retriever: received delegation
│    ├─ [0.904s] retriever: tool_call search_knowledge_base
│    │    args: {query: "gemini enterprise agent platform ga date"}
│    │    result: "GEAP reached general availability on 23 April 2026."
│    └─ [0.967s] retriever: returned result
├─ [1.201s] planner: received sub-answer
│    content: "GEAP reached GA on 23 April 2026."
├─ [1.203s] planner: tool_call transfer_to_agent (sub-question 2)
│    ...
└─ [2.891s] planner: final response assembled
```

Each node in the trace is clickable in the GCP console — you can inspect the exact input and output of every model call and every tool call. When a handoff fails (the Retriever returns "no results" unexpectedly), you click the `search_knowledge_base` node and see exactly what query string it received.

**Common failure patterns in traces**:
1. **Query transformation**: The Planner rephrases the sub-question before handing it to the Retriever, and the rephrased query does not match your knowledge base. Fix: tighten the Planner instruction to pass questions verbatim.
2. **Infinite delegation**: The Planner calls `transfer_to_agent` with the Retriever, the Retriever calls `transfer_to_agent` back to the Planner (because its instruction is too loose). Agent Anomaly Detection flags this within 2-3 hops.
3. **Silent tool failure**: A tool returns an empty string instead of raising an exception. The model treats the empty string as a valid (if useless) result and continues. Always return explicit "no results" messages.

<RunPromptCell
  model="gemini-pro-latest"
  tools={["transfer_to_agent", "search_knowledge_base"]}
  prompt="What is the Agent Registry and why does it matter for production multi-agent systems?"
  expectedOutput={`[transfer_to_agent: retriever]
message: "What is Agent Registry and what is its purpose?"

→ "Agent Registry is a centralized catalogue of approved tools, agents, and capabilities. Agents discover sub-agents by name via Registry rather than hardcoded imports."

**Agent Registry** is GEAP's centralized catalogue of agents and tools. In practice, it matters because it separates *discovery* from *implementation*: your Planner agent doesn't import the Retriever — it asks Registry for an agent named 'retriever'. 

This means:
- **Versioning**: Update the Retriever without touching the Planner's code
- **Governance**: The Registry owner controls which agents are visible to which callers
- **Auditability**: Registry logs show exactly which agents called which sub-agents`}
/>

<KnowledgeCheck
  questions={[
    {
      question: "An Agent Observability trace shows the Planner calling transfer_to_agent three times in a row before the Retriever responds to the first call. What is the most likely cause?",
      answers: [
        "The Planner instruction is missing the 'wait for result' constraint, causing it to fire multiple delegations simultaneously",
        "The Retriever is rate-limited, causing the Planner to retry",
        "Agent Registry is down",
        "The gemini-pro-latest model does not support multi-step tool use"
      ],
      correct: 0,
      explanation: "Without an explicit instruction to wait for each result before the next transfer, a generative orchestrator can issue multiple transfer_to_agent calls before processing any results. Fix: add 'wait for the result before the next transfer' to the Planner's instruction."
    },
    {
      question: "Why is Agent Gateway recommended alongside Agent Registry in production multi-agent systems?",
      answers: [
        "Gateway improves model response quality for sub-agent calls",
        "Registry controls discovery but not execution security; Gateway enforces IAM-backed access policies",
        "Gateway is required for Memory Bank to function",
        "Gateway reduces cold-start latency for sub-agent invocations"
      ],
      correct: 1,
      explanation: "Agent Registry controls which agents are discoverable by name. Agent Gateway enforces which callers are actually allowed to invoke them. For production security, you need both: Registry for governance and Gateway for enforcement."
    }
  ]}
/>

---

## Hands-on exercise: Build the research pipeline

**Goal**: A two-agent system where the Planner decomposes questions and the Retriever answers them.

**Steps**:
1. Create the directory structure: `research_pipeline/__init__.py`, `research_pipeline/retriever.py`, `research_pipeline/planner.py`, `research_pipeline/agent.py`
2. Implement the Retriever with `search_knowledge_base` as shown. Add at least 3 additional knowledge base entries on a topic of your choice.
3. Implement the Planner with `transfer_to_agent` and the `sub_agents=["retriever"]` declaration.
4. Run `adk web research_pipeline/` and ask a question that requires at least 2 sub-questions to answer fully.
5. In the ADK web UI, click on the trace view and identify the exact point where the Planner transferred to the Retriever.
6. **Extension**: Add a third agent — a `Formatter` that takes the Planner's synthesis and formats it as a structured markdown report. Wire it as a deterministic last step using `SequentialAgent`.

**Success criteria**:
- Planner correctly decomposes a multi-part question (visible in the trace)
- Retriever is called once per sub-question (not once per user message)
- Synthesis addresses all sub-questions without hallucinating new facts
- Trace in the UI shows the delegation chain clearly

---

## What's next

You have now built a two-agent system on GEAP. Before going deeper into the platform, it is worth asking: is GEAP the right platform for your use case? Chapter 4 puts GEAP in an honest comparison with Claude Agent SDK and Cloudflare Agents — covering state management, deployment topology, lock-in, and the workloads each platform wins. For reference on the [[glossary/memory-bank|Memory Bank]] and session state primitives powering these agents, or for [[course/vertex-ai-fundamentals|Vertex AI fundamentals]], see the linked resources.

See [[gemini-enterprise-agent-platform-hands-on-tour/04-comparing-to-claude-agent-sdk-and-cloudflare-agents]] to continue.

---

## References

[1] Google Cloud Blog. "Introducing Gemini Enterprise Agent Platform." 23 April 2026. — https://cloud.google.com/blog/products/ai-machine-learning/introducing-gemini-enterprise-agent-platform · retrieved 2026-04-30

[2] Google Agent Development Kit. Agent-to-agent orchestration guide. — https://adk.dev/ · retrieved 2026-04-30

[3] Google Cloud. Multi-agent documentation. — https://cloud.google.com/vertex-ai/docs/generative-ai/agent-builder/multi-agent · retrieved 2026-04-30

[4] Google Cloud. Agent Registry guide. — https://cloud.google.com/vertex-ai/docs/generative-ai/agent-builder/agent-registry · retrieved 2026-04-30

[5] Google Cloud. Agent Observability documentation. — https://cloud.google.com/vertex-ai/docs/generative-ai/agent-builder/observability · retrieved 2026-04-30
