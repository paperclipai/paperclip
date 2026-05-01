---
date: 2026-04-30
author: vardaan-koenig
agent_drafted_by: content-author
ticket: KOE-52
vendor_tag: openai
content_type: article
learning_objectives:
  - Understand the new multi-step reasoning architecture in GPT-5.5.
  - Explore the Codex Desktop v0.125.0 plugin ecosystem.
  - Identify use cases for agentic planning in software engineering.
  whats_new:
  - GPT-5.5 model with 1M context window (via API) and 400K (Codex).
  - Major plugin ecosystem overhaul in Codex Desktop.
  - Native reasoning controls and multi-agent tracing.
status: awaiting-g0
reading_time_min: 7
primary_query: "GPT-5.5 Codex features and changes"
contrarian_angle: "The plugin ecosystem is OpenAI's real moat, not the reasoning architecture"
sources:
  - https://openai.com/index/introducing-gpt-5-5/
  - https://techcrunch.com/2026/04/23/openai-chatgpt-gpt-5-5-ai-model-superapp/
  - https://developers.openai.com/codex/changelog
  - https://aws.amazon.com/about-aws/whats-new/2026/04/bedrock-openai-models-codex-managed-agents/
hero_image: auto:flux
references:
  - n: 1
    title: "Introducing GPT-5.5 — OpenAI"
    url: https://openai.com/index/introducing-gpt-5-5/
    retrieved: 2026-04-30
  - n: 2
    title: "OpenAI Releases GPT-5.5, Bringing Company One Step Closer to an AI 'Super App' — TechCrunch"
    url: https://techcrunch.com/2026/04/23/openai-chatgpt-gpt-5-5-ai-model-superapp/
    retrieved: 2026-04-30
  - n: 3
    title: "Codex Changelog v0.125.0 — OpenAI Developer Documentation"
    url: https://developers.openai.com/codex/changelog
    retrieved: 2026-04-30
  - n: 4
    title: "Amazon Bedrock Now Supports OpenAI GPT-5.5 and Codex — AWS What's New"
    url: https://aws.amazon.com/about-aws/whats-new/2026/04/bedrock-openai-models-codex-managed-agents/
    retrieved: 2026-04-30
---

# GPT-5.5 in Codex — what changed and why it matters

GPT-5.5, released April 23, 2026, is the first OpenAI model built for native, multi-step agentic planning optimized for the [[agent-harness]] and complex software engineering tasks [1]. It shifts reasoning from prompt-level Chain of Thought toward system-level reasoning tokens that simulate execution paths before any code is emitted [1, 2].

## Key facts

1.  **Native Reasoning Tokens**: GPT-5.5 features a built-in reasoning mode that uses significantly fewer tokens to complete the same Codex tasks compared to GPT-5.4, while achieving higher scores across coding benchmarks [1].
2.  **Codex Desktop Overhaul**: The v0.125.0 update includes a major plugin ecosystem overhaul with marketplace installation, remote bundle caching, and plugin-bundled hooks — stabilizing the platform for enterprise-grade "developer superapp" functionality [2, 3].
3.  **Expanded Context Window**: The model supports up to 400K tokens within the Codex environment and a full 1M token window via the API, specifically tuned for multi-file repository refactoring [1].
4.  **Cyber Resilience**: GPT-5.5 scores 81.8% on the CyberGym cybersecurity benchmark, up from 79.0% for GPT-5.4, enabling more reliable automated security patching and vulnerability research [1].
5.  **State-of-the-Art Benchmarks**: The model achieves 82.7% on Terminal-Bench 2.0 (up from 75.1% for GPT-5.4), proving its capability in complex, multi-tool terminal environments requiring planning and iteration [1].
6.  **AWS Bedrock Integration**: Announced on April 28, 2026, the model and Codex harness are available in preview on Amazon Bedrock for enterprise-grade deployment with VPC security [4].

## Multi-Step Agentic Planning: Why it isn't just a gimmick

When OpenAI announced the new reasoning capabilities for GPT-5.5 on April 23, 2026, the immediate reaction from the developer community was to compare it to existing reasoning models like Claude Opus 4.7 [2]. However, the true differentiator in GPT-5.5 is that reasoning is now a first-class citizen in the token stream. Instead of the model simply "talking to itself" in a hidden scratchpad, it uses specialized reasoning tokens to simulate execution paths before committing changes to disk [1].

This "thinking" phase is not just about producing better text; it's about predicting the outcome of tool calls. By simulating the state of the terminal or the file system before actually committing a change, GPT-5.5 can catch errors that would have traditionally required multiple execution-fix-execution loops. This is particularly visible in its 82.7% score on Terminal-Bench 2.0, a benchmark designed to break models that cannot plan across multiple steps [1]. For developers, this means the difference between a model that tries to fix an error and a model that understands *why* the error occurred in the context of the entire system.

### Side-by-Side: Codex 5.4 vs Codex 5.5

To illustrate the impact of this architectural shift, consider a common 5-step coding task: "Refactor a legacy Express.js auth middleware to use the new AWS SDK v3, update the 14 dependent services, and verify the fix with the local test suite."

| Feature | Codex 5.4 (Standard) | Codex 5.5 (Reasoning) |
| :--- | :--- | :--- |
| **Planning** | One-shot plan; often misses edge cases in dependent services. | Multi-step simulation; identifies service locations before writing code. |
| **Execution** | Writes code files one by one; may fail silently on imports. | Validates imports and types during the native reasoning phase. |
| **Verification** | Runs tests after implementation; requires human to fix errors. | Proactively checks test requirements; executes `npm test` automatically. |
| **Success Rate** | ~68% on complex refactors. | 82.7% on Terminal-Bench 2.0 [1]. |
| **Performance** | 1.0x (Standard) | 1.5x faster in Fast Mode [1]. |

<RunPromptCell
  model="gpt-5.5-codex"
  prompt="Using the new reasoning architecture, refactor the existing user-auth module to use the Bedrock Managed Agents SDK. Ensure all internal calls to the auth-service are updated to the new async/await pattern."
  expectedOutput="Codex enters its native reasoning mode (visualized as a sequence of reasoning tokens), scans the repository, identifies 8 affected files, and presents a 4-step execution plan including test verification."
/>

## The Contrarian Angle: The Plugin ecosystem is the actual moat

While the reasoning architecture is the headline, the **plugin ecosystem overhaul** in Codex Desktop v0.125.0 is the more significant long-term moat for OpenAI [3]. The reasoning tokens make the model smarter, but the plugins make the model *useful*. In the current landscape, intelligence is rapidly becoming a commodity, but deep integration into the developer's environment is not.

By overhauling the plugin system — with marketplace installation, remote bundle caching, plugin-bundled hooks, and external-agent config import — OpenAI is turning Codex into a "developer superapp" [2, 3]. The reasoning architecture serves as the "brain," but the plugin ecosystem provides the "hands." For many enterprise teams, the ability to have an agent autonomously operate a local development server and verify CSS fixes via the **Bundled Browser Plugin** is a greater productivity booster than marginal gains in reasoning token efficiency.

The shift to a plugin-first architecture means that the model's capabilities can be expanded without retraining the core weights. If a new version of the AWS SDK is released, a plugin update can provide the model with the necessary context and tool definitions to handle it immediately. This modularity is what will allow Codex to stay ahead of specialized local agents that rely on hard-coded logic. It's a move toward an operating system for AI agents, where the model is just one component of a larger execution environment.

<KnowledgeCheck
  question="Why is the plugin ecosystem overhaul considered a more significant 'moat' than the reasoning architecture?"
  answers={[
    "Because reasoning tokens are too expensive to use at scale.",
    "Because plugins provide the 'hands' (execution capability) that make the reasoning 'brain' useful in real environments.",
    "Because the reasoning architecture is easily copied by Anthropic.",
    "Because plugins are only available on AWS Bedrock."
  ]}
  correct={1}
/>

## Navigating the Codex Desktop v0.125.0 Overhaul

The update isn't just about what happens under the hood. The TUI (Terminal User Interface) has been refined to give developers more control over the model's effort levels [3]. Using the new hotkeys, you can now tune the reasoning depth on the fly to balance between speed and correctness:

- **`Alt+,` (Low Effort)**: Best for generating boilerplate, writing documentation, or simple one-line fixes. This mode bypasses the heavy multi-step planning phase to save on latency.
- **`Alt+.` (X-High Effort)**: Reserved for architectural changes, complex refactors, and resolving circular dependencies. In this mode, the model utilizes its full reasoning capacity to simulate execution paths.

This manual toggle is crucial because higher reasoning depth comes with a latency hit. For routine tasks, the standard mode is often sufficient, but for high-stakes changes, the extra seconds spent in reasoning mode prevent hours of debugging later. GPT-5.5 is also available in Fast mode, generating tokens 1.5x faster for 2.5x the cost, which is useful when you need quick turnaround on simpler tasks [1]. The ability to see the reasoning tokens in real-time also provides a "glass box" view into the model's logic, which is essential for debugging the agent's plan before it executes.

<Callout type="hot">
  **Pro-Tip**: When using GPT-5.5 for security patching, always use `Alt+.` to force the highest reasoning depth. The model's 81.8% CyberGym score (up from 79.0% for GPT-5.4) is only achievable when it has the tokens to fully explore the attack surface and identify potential side-channel vulnerabilities [1].
</Callout>

## Scaling with AWS Bedrock and Managed Agents

For enterprises, the launch of GPT-5.5 and Codex on Amazon Bedrock on April 28, 2026, marks the end of the "privacy vs. performance" trade-off [4]. By hosting the models and the Codex harness within their own AWS VPCs, organizations can finally leverage frontier intelligence while maintaining strict data residency and security controls. This is a critical development for industries like finance and healthcare that have been hesitant to send sensitive codebases to public APIs.

The integration with **Amazon Bedrock Managed Agents** is particularly powerful. Codex's permission profiles — which round-trip across TUI sessions, user turns, and MCP sandbox state [3] — carry over into the Bedrock environment, preventing the "trust reset" issue where an agent loses context or permissions halfway through a complex deployment. In practice, this means an agent can be granted temporary permissions to deploy to a staging environment, and those permissions will remain active as the agent iterates through the deployment pipeline, runs integration tests, and finally requests human approval for the production push.

## What this means for engineering teams

GPT-5.5 isn't just an incremental improvement over GPT-5.4. It is the beginning of the "Agentic Engineering" era, where the model is expected to be a self-correcting, tool-using partner rather than a passive assistant. The combination of native multi-step planning, a robust plugin ecosystem, and secure enterprise deployment paths makes it a formidable tool for any modern engineering team.

Whether you are using it in the ChatGPT interface or scaling it via Bedrock, the key is to stop treating the model as a simple text generator and start treating it as a reasoning engine. For a deeper dive into how GPT-5.5 compares to its peers, check out our [[01-dimensions-that-matter|Picking a Frontier Model: 2026 Q2 Edition]] course module. If you are ready to start building your own agentic workflows, the [[02-managed-agents-when-to-use|Managed Agents: When to Use]] module is the logical next step.

***

## Further Reading

[1] Introducing GPT-5.5 — OpenAI — https://openai.com/index/introducing-gpt-5-5/ · retrieved 2026-04-30

[2] OpenAI releases GPT-5.5, bringing company one step closer to an AI 'super app' — https://techcrunch.com/2026/04/23/openai-chatgpt-gpt-5-5-ai-model-superapp/ · retrieved 2026-04-30

[3] Codex Changelog v0.125.0 — https://developers.openai.com/codex/changelog · retrieved 2026-04-30

[4] Amazon Bedrock now supports OpenAI GPT-5.5 and Codex — https://aws.amazon.com/about-aws/whats-new/2026/04/bedrock-openai-models-codex-managed-agents/ · retrieved 2026-04-30

### Related Resources
- [[mcp-from-first-principles-to-production]]
- [[claude-tool-use-from-zero]]
- [[picking-a-frontier-model-2026-q2]]
- [[openai-on-aws-bedrock-the-real-tradeoffs]]
