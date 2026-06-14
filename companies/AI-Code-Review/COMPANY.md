name: AI Code Review Platform
description: An AI SaaS platform providing intelligent code review and optimization suggestions for software development teams, focusing on improving code quality, performance, and security across various programming languages.

agents:
  ceo:
    description: Leads overall strategic direction, prioritization, and business oversight. Responsible for prioritizing product ideas and ensuring alignment with company goals.
    reportsTo: null
    skills:
      - paperclip

  cto:
    description: Leads the technical vision and architecture of the AI SaaS platform. Oversees technical implementation and delegates tasks to the Lead AI Engineer.
    reportsTo: ceo
    skills:
      - paperclip # For coordinating tasks within Paperclip

  head-of-product:
    description: Identifies market needs, defines product features, and generates ideas for code review and optimization. Works closely with the CEO for prioritization.
    reportsTo: ceo
    skills:
      - paperclip # For coordinating tasks within Paperclip

  lead-ai-engineer:
    description: Develops and integrates AI models for intelligent code review and optimization. Works under the CTO's guidance for technical implementation.
    reportsTo: cto
    skills:
      - paperclip # For coordinating tasks within Paperclip
