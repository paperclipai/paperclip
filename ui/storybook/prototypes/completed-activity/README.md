# Completed activity proposal

Production runner activity group with deterministic fixtures for the approved completed summaries.

Open **Tasks → Completed activity preview**. Start with Completed conversation, Summary situations, and Desktop live to completed. Mobile and expanded playback variants exercise the same proposal.

## Behavior

- While a group is active, keep the current rolling activity and its target.
- When the next commentary message arrives, or the run ends, replace the collapsed activity with a short taxonomy-based summary.
- Combine repeated categories and retries: “Ran commands”, “Read files, ran commands”. Do not summarize shell arguments or invent outcomes from command text.
- Omit failure counts in both collapsed and expanded groups. Tool details retain the actual output.
- Leave completed collapsed rows free of counts. The chevron opens history; the expanded header shows the ordinary activity count.
- A group with tools omits thoughts and usage from its summary. Thoughts-only groups say “Thought through the task”.
- For unsuccessful reads/edits, use “Checked files” / “Worked on files” instead of claiming a successful read/change. “Ran commands” does not imply exit code zero.
- More than three categories collapse to two categories plus “and more”. The full description is the tooltip; history remains available by click or keyboard.
- Expansion persists while a group transitions from active to settled. History stays single-line, with full output behind an individual disclosure.

All stories render the shared production activity group. No runner or task API calls are made.
