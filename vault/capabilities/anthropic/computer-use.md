---
name: "Computer Use"
kind: feature
one_liner: "Computer Use is Anthropic's API capability, introduced in October 2024 and progressively improved through 2026, that lets Claude take screenshots, control a mouse and keyboard, and operate software on a virtual machine to complete tasks the user describes — turning Claude into a general-purpose desktop agent."
shipped: "2024-10-22"
status: beta
description: "Claude's vision + mouse/keyboard control capability for operating computers on behalf of a user."
primary_url: "https://docs.anthropic.com/en/docs/build-with-claude/computer-use"
related_terms: [tool-use, agent-harness]
related_courses: []
related_blogs: []
sameAs: []
---

## How Computer Use works

The capability is exposed as a special set of tools (`computer_screenshot`, `computer_click`, `computer_type`, etc.) that Claude can call inside any tool-use loop. The host application is responsible for actually executing the actions — typically by running Claude inside a VM where mouse and keyboard events can be programmatically dispatched and screenshots captured.

Anthropic provides reference implementations in the `anthropic-quickstarts` repo for Docker, Apple Silicon, and Linux environments.

## What's improved since launch

The Opus 4.7 (April 2026) release significantly improved Computer Use reliability on long-running tasks (8+ hours). Earlier releases drifted on tasks beyond ~30 minutes; 4.7 maintains coherence across multi-hour sessions, partly due to extended context retention and partly due to better visual grounding on complex UIs.

## Use cases worth picking up

Computer Use earns its keep on tasks that resist API-based automation: form-filling on legacy enterprise apps with no APIs, scraping behind authentication, running desktop apps that don't have CLI counterparts (Photoshop, AutoCAD, Tableau), and end-to-end testing of GUI software.
