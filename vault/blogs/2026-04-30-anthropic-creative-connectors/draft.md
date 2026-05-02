---
date: 2026-04-30
author: koenig-ai
agent_drafted_by: content-author
ticket: KOEA-24
vendor_tag: anthropic
content_type: article
primary_query: "anthropic claude creative connectors blender adobe ableton 2026"
learning_objectives:
  - Identify the 9 new creative software connectors for Claude
  - Understand how the Blender MCP connector enables Python API interaction
  - Map specific creative workflows (audio, 3D, design) to Claude's new capabilities
whats_new:
  - Updated Resolume and Blender descriptions for accuracy
  - Standardized "Adobe for creativity" branding
  - Fixed broken Academy course links
  - Rev 5: Resolume Wire connector #9 corrected — now describes Wire's node-based visual programming domain instead of incorrectly claiming Arena/Avenue control
status: g0-passed
reading_time_min: 4
sources:
  - https://www.anthropic.com/news/claude-for-creative-work
  - https://modelcontextprotocol.io/introduction
  - https://docs.blender.org/api/current/
hero_image: auto:flux
references:
  - n: 1
    title: "Claude for Creative Work — Anthropic Announcement"
    url: https://www.anthropic.com/news/claude-for-creative-work
    retrieved: 2026-04-30
  - n: 2
    title: "Introduction — Model Context Protocol"
    url: https://modelcontextprotocol.io/introduction
    retrieved: 2026-05-01
  - n: 3
    title: "Blender Python API Reference"
    url: https://docs.blender.org/api/current/
    retrieved: 2026-05-01
---

# How to use Anthropic’s 9 new creative connectors in your workflow

Claude for Creative Work is Anthropic’s April 2026 launch of nine MCP-based connectors that integrate Claude directly into professional creative software. On April 28, 2026, the company announced the initiative, bringing Claude into the tools artists, designers, and musicians use every day.

## Key facts

1. Nine connectors launched April 28, 2026, spanning 3D modeling, audio production, graphic design, and live AV performance.
2. All connectors are built on the **Model Context Protocol (MCP)**, enabling Claude to read documentation and interact with software APIs natively.
3. Adobe integration covers 50+ tools including Photoshop, Premiere, and Express.
4. University partnerships announced with RISD, Ringling College of Art and Design, and Goldsmiths, University of London.
5. Anthropic positions the connectors as creativity amplifiers—automating repetitive toil so human taste and imagination remain central.

These aren’t just simple chat interfaces; they are functional bridges. By leveraging the **Model Context Protocol (MCP)**, these connectors allow Claude to read documentation, interact with APIs, and even generate 3D models or audio search queries directly within specialized software [[source](https://www.anthropic.com/news/claude-for-creative-work)].

Below is a breakdown of what each connector brings to the creative table.

## What each of the 9 connectors enables

The launch covers the full spectrum of creative production, from 3D modeling to live AV performance.

1.  **Blender**: A natural-language interface to Blender’s Python API. Claude can now analyze scenes, debug scripts, and interact with complex setups through conversational exploration.
2.  **Adobe for creativity**: Direct integration with over 50 tools including Photoshop, Premiere, and Express.
3.  **Ableton**: Claude is now grounded in official product documentation for Live and Push, acting as a real-time technical tutor.
4.  **Autodesk Fusion**: Enables designers to create and modify 3D models through conversational prompts.
5.  **SketchUp**: Describe a room or furniture piece to Claude and have it generate a starting point you can open and refine in 3D.
6.  **Splice**: Search the massive Splice catalog of royalty-free samples directly from the Claude interface.
7.  **Affinity by Canva**: Automate repetitive tasks like batch layer renaming, adjustments, and file exports.
8.  **Resolume Arena**: Control live visuals in real-time using natural language—letting VJs trigger clips and layers without touching the keyboard.
9.  **Resolume Wire**: Claude assists in building and debugging node-based visual patches inside Resolume Wire, helping artists create custom effects and generative visuals within Wire's visual programming environment.

## How Blender's Python API becomes conversational through MCP

The Blender connector is particularly powerful because it is built on the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). This allows Claude to provide a natural-language interface to its Python API, designed to allow users to explore, understand, and interact with complex setups.

For instance, a user can prompt Claude to "find all point lights in the scene" or "explain how the current node setup calculates displacement." Claude uses the `bpy` API to inspect the scene state and provide context-aware guidance or script suggestions.

<RunPromptCell
  model="claude-sonnet-4-6"
  prompt="Using the Blender Python API, write a script that generates a 10x10 grid of cubes, where each cube's height is determined by its distance from the center of the grid (creating a wave pattern)."
  expectedOutput="A Python script using `bpy` that iterates through a grid and scales cubes on the Z-axis based on a math function."
/>

## How Claude connects Blender, SketchUp, and Premiere into one pipeline

One of the biggest friction points in creative work is moving assets between tools—the "manual handoff." Anthropic is positioning Claude as the "glue" for these pipelines. Because Claude can translate formats and restructure data, it can help move work from SketchUp (architecture) to Blender (rendering) to Adobe Premiere (editing) without losing context.

<KnowledgeCheck
  question="Which connector allows music producers to search for royalty-free samples directly within Claude?"
  answers={["Ableton", "Splice", "Resolume", "Affinity"]}
  correct={1}
/>

## How RISD, Ringling, and Goldsmiths are embedding Claude in their curricula

To support this rollout, Anthropic is partnering with leading art and design programs, including **RISD**, **Ringling College of Art and Design**, and **Goldsmiths, University of London** [[source](https://www.anthropic.com/news/claude-for-creative-work)]. These institutions will integrate Claude and the new connectors into their curricula, helping students master "creative computation"—the intersection of traditional art and AI-driven automation.

## Focus on ideation by automating creative toil

Anthropic is careful to note that Claude isn't here to replace the "taste" of the artist. As the announcement states: "Claude can't replace taste or imagination, but it can open up new ways of working—faster and more ambitious ideation, a more expansive skill set, and the ability for creatives to take on larger-scale projects." [[1]](https://www.anthropic.com/news/claude-for-creative-work) Whether it's batch-processing layers in Affinity or debugging a complex animation script in Blender, these connectors are about eliminating toil so creatives can focus on ideation.

For more on integrating Claude into your technical stack, check out the [[course/mcp-from-first-principles-to-production]] Academy course. To see these connectors in action inside a production workflow, explore [[course/production-agents-claude-agent-sdk-mcp-connector]].

---

### Internal Links
- [[course/claude-tool-use-from-zero]]
- [[course/mcp-from-first-principles-to-production]]
- [[course/production-agents-claude-agent-sdk-mcp-connector]]
- [[2026-04-29]]

## References

[1] Claude for Creative Work — Anthropic · https://www.anthropic.com/news/claude-for-creative-work · retrieved 2026-04-30
[2] Introduction — Model Context Protocol · https://modelcontextprotocol.io/introduction · retrieved 2026-05-01
[3] Blender Python API Reference · https://docs.blender.org/api/current/ · retrieved 2026-05-01
