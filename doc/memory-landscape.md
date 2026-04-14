# Memory Landscape

Date: 2026-03-17

This document summarizes the memory systems referenced in task `PAP-530` and extracts the design patterns that matter for Paperclip.

## What Paperclip Needs From This Survey

Paperclip is not trying to become a single opinionated memory engine. The more useful target is a control-plane memory surface that:

- stays company-scoped
- lets each company choose a default memory provider
- lets specific agents override that default
- keeps provenance back to Paperclip runs, issues, comments, and documents
- records memory-related cost and latency the same way the rest of the control plane records work
- works with plugin-provided providers, not only built-ins

The question is not "which memory project wins?" The question is "what is the smallest Paperclip contract that can sit above several very different memory systems without flattening away the useful differences?"

## Quick Grouping

### Hosted memory APIs

- `mem0`
- `AWS Bedrock AgentCore Memory`
- `supermemory`
- `Memori`

These optimize for a simple application integration story: send conversation/content plus an identity, then query for relevant memory or user context later.

### Agent-centric memory frameworks / memory OSes

- `MemOS`
- `memU`
- `EverMemOS`
- `OpenViking`

These treat memory as an agent runtime subsystem, not only as a search index. They usually add task memory, profiles, filesystem-style organization, async ingestion, or skill/resource management.

### Local-first memory stores / indexes

- `nuggets`
- `memsearch`

These emphasize local persistence, inspectability, and low operational overhead. They are useful because Paperclip is local-first today and needs at least one zero-config path.

## Per-Project Notes

| Project | Shape | Notable API / model | Strong fit for Paperclip | Main mismatch |
|---|---|---|---|---|
| [nuggets](https://github.com/NeoVertex1/nuggets) | local memory engine + messaging gateway | topic-scoped HRR memory with `remember`, `recall`, `forget`, fact promotion into `MEMORY.md` | good example of lightweight local memory and automatic promotion | very specific architecture; not a general multi-tenant service |
| [mem0](https://github.com/mem0ai/mem0) | hosted + OSS SDK | `add`, `search`, `getAll`, `get`, `update`, `delete`, `deleteAll`; entity partitioning via `user_id`, `agent_id`, `run_id`, `app_id` | closest to a clean provider API with identities and metadata filters | provider owns extraction heavily; Paperclip should not assume every backend behaves like mem0 |
| [AWS Bedrock AgentCore Memory](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html) | AWS-managed memory service | explicit short-term and long-term memories, actor/session/event APIs, memory strategies, namespace templates, optional self-managed extraction pipeline | strong example of provider-managed memory with clear scoped ids, retention controls, and standalone API access outside a single agent framework | AWS-hosted and IAM-centric; Paperclip would still need its own company/run/comment provenance, cost rollups, and likely a plugin wrapper instead of baking AWS semantics into core |
| [MemOS](https://github.com/MemTensor/MemOS) | memory OS / framework | unified add-retrieve-edit-delete, memory cubes, multimodal memory, tool memory, async scheduler, feedback/correction | strong source for optional capabilities beyond plain search | much broader than the minimal contract Paperclip should standardize first |
| [supermemory](https://github.com/supermemoryai/supermemory) | hosted memory + context API | `add`, `profile`, `search.memories`, `search.documents`, document upload, settings; automatic profile building and forgetting | strong example of "context bundle" rather than raw search results | heavily productized around its own ontology and hosted flow |
| [memU](https://github.com/NevaMind-AI/memU) | proactive agent memory framework | file-system metaphor, proactive loop, intent prediction, always-on companion model | good source for when memory should trigger agent behavior, not just retrieval | proactive assistant framing is broader than Paperclip's task-centric control plane |
| [Memori](https://github.com/MemoriLabs/Memori) | hosted memory fabric + SDK wrappers | registers against LLM SDKs, attribution via `entity_id` + `process_id`, sessions, cloud + BYODB | strong example of automatic capture around model clients | wrapper-centric design does not map 1:1 to Paperclip's run / issue / comment lifecycle |
| [EverMemOS](https://github.com/EverMind-AI/EverMemOS) | conversational long-term memory system | MemCell extraction, structured narratives, user profiles, hybrid retrieval / reranking | useful model for provenance-rich structured memories and evolving profiles | focused on conversational memory rather than generalized control-plane events |
| [memsearch](https://github.com/zilliztech/memsearch) | markdown-first local memory index | markdown as source of truth, `index`, `search`, `watch`, transcript parsing, plugin hooks | excellent baseline for a local built-in provider and inspectable provenance | intentionally simple; no hosted service semantics or rich correction workflow |
| [OpenViking](https://github.com/volcengine/OpenViking) | context database | filesystem-style organization of memories/resources/skills, tiered loading, visualized retrieval trajectories | strong source for browse/inspect UX and context provenance | treats "context database" as a larger product surface than Paperclip should own |

## Common Primitives Across The Landscape

Even though the systems disagree on architecture, they converge on a few primitives:

- `ingest`: add memory from text, messages, documents, or transcripts
- `query`: search or retrieve memory given a task, question, or scope
- `scope`: partition memory by user, agent, project, process, or session
- `provenance`: carry enough metadata to explain where a memory came from
- `maintenance`: update, forget, dedupe, compact, or correct memories over time
- `context assembly`: turn raw memories into a prompt-ready bundle for the agent

If Paperclip does not expose these, it will not adapt well to the systems above.

## Where The Systems Differ

These differences are exactly why Paperclip needs a layered contract instead of a single hard-coded engine.

### 1. Who owns extraction?

- `mem0`, `supermemory`, and `Memori` expect the provider to infer memories from conversations.
- `AWS Bedrock AgentCore Memory` supports both provider-managed extraction and self-managed pipelines where the host writes curated long-term memory records.
- `memsearch` expects the host to decide what markdown to write, then indexes it.
- `MemOS`, `memU`, `EverMemOS`, and `OpenViking` sit somewhere in between and often expose richer memory construction pipelines.

Paperclip should support both:

- provider-managed extraction
- Paperclip-managed extraction with provider-managed storage / retrieval

### 2. What is the source of truth?

- `memsearch` and `nuggets` make the source inspectable on disk.
- hosted APIs often make the provider store canonical.
- filesystem-style systems like `OpenViking` and `memU` treat hierarchy itself as part of the memory model.

Paperclip should not require a single storage shape. It should require normalized references back to Paperclip entities.

### 3. Is memory just search, or also profile and planning state?

- `mem0` and `memsearch` center search and CRUD.
- `supermemory` adds user profiles as a first-class output.
- `MemOS`, `memU`, `EverMemOS`, and `OpenViking` expand into tool traces, task memory, resources, and skills.

Paperclip should make plain search the minimum contract and richer outputs optional capabilities.

### 4. Is memory synchronous or asynchronous?

- local tools often work synchronously in-process.
- `AWS Bedrock AgentCore Memory` is synchronous at the API edge, but its long-term memory path includes background extraction/indexing behavior and retention policies managed by the provider.
- larger systems add schedulers, background indexing, compaction, or sync jobs.

Paperclip needs both direct request/response operations and background maintenance hooks.

## Paperclip-Specific Takeaways

### Paperclip should own these concerns

- binding a provider to a company and optionally overriding it per agent
- mapping Paperclip entities into provider scopes
- provenance back to issue comments, documents, runs, and activity
- cost / token / latency reporting for memory work
- browse and inspect surfaces in the Paperclip UI
- governance on destructive operations

### Providers should own these concerns

- extraction heuristics
- embedding / indexing strategy
- ranking and reranking
- profile synthesis
- contradiction resolution and forgetting logic
- storage engine details

### The control-plane contract should stay small

Paperclip does not need to standardize every feature from every provider. It needs:

- a required portable core
- optional capability flags for richer providers
- a way to record provider-native ids and metadata without pretending all providers are equivalent internally

## Recommended Direction

Paperclip should adopt a two-layer memory model:

1. `Memory binding + control plane layer`
   Paperclip decides which provider key is in effect for a company, agent, or project, and it logs every memory operation with provenance and usage.

2. `Provider adapter layer`
   A built-in or plugin-supplied adapter turns Paperclip memory requests into provider-specific calls.

The portable core should cover:

- ingest / write
- search / recall
- browse / inspect
- get by provider record handle
- forget / correction
- usage reporting

Optional capabilities can cover:

- profile synthesis
- async ingestion
- multimodal content
- tool / resource / skill memory
- provider-native graph browsing

That is enough to support:

- a local markdown-first baseline similar to `memsearch`
- hosted services similar to `mem0`, `supermemory`, or `Memori`
- richer agent-memory systems like `MemOS` or `OpenViking`

without forcing Paperclip itself to become a monolithic memory engine.
