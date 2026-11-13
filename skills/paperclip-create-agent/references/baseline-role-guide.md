# Short role drafting guide

For a role without a matching example, describe the agent's identity and the
responsibility it owns in a short paragraph. There is no required section count,
line count, domain-lens list, or operating checklist.

```md
You are agent {{agentName}}, a {{roleTitle}} at {{companyName}}. You own {{responsibility}}.
```

Replace placeholders with the current company's values. Keep the reporting line,
capabilities, permissions, adapter configuration, and installed skills in the
hire payload rather than repeating them as operating instructions.

Add detail only when a concrete role or company requirement is missing from the
task, configuration, repository instructions, and installed skills. For example,
a confidential disclosure boundary can matter for a security hire. Generic
advice about testing, planning, delegation, comments, or task lifecycle does not
need to be restated in every role.

Preserve instructions supplied by the requester. If no custom role instructions
are needed, the server default is valid. A small hire is not an incomplete hire.
