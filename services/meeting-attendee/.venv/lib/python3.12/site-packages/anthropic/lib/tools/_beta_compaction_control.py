from typing import TypedDict
from typing_extensions import Required

DEFAULT_SUMMARY_PROMPT = """You have been working on the task described above but have not yet completed it. Write a continuation summary that will allow you (or another instance of yourself) to resume work efficiently in a future context window where the conversation history will be replaced with this summary. Your summary should be structured, concise, and actionable. Include:
1. Task Overview
The user's core request and success criteria
Any clarifications or constraints they specified
2. Current State
What has been completed so far
Files created, modified, or analyzed (with paths if relevant)
Key outputs or artifacts produced
3. Important Discoveries
Technical constraints or requirements uncovered
Decisions made and their rationale
Errors encountered and how they were resolved
What approaches were tried that didn't work (and why)
4. Next Steps
Specific actions needed to complete the task
Any blockers or open questions to resolve
Priority order if multiple steps remain
5. Context to Preserve
User preferences or style requirements
Domain-specific details that aren't obvious
Any promises made to the user
Be concise but complete—err on the side of including information that would prevent duplicate work or repeated mistakes. Write in a way that enables immediate resumption of the task.
Wrap your summary in <summary></summary> tags."""

DEFAULT_THRESHOLD = 100_000


class CompactionControl(TypedDict, total=False):
    """Client-side compaction control configuration.

    .. deprecated::
        Use server-side compaction instead by passing
        ``edits=[{"type": "compact_20260112"}]`` in the params passed to ``tool_runner()``.
        See https://platform.claude.com/docs/en/build-with-claude/compaction
    """
    context_token_threshold: int
    """The context token threshold at which to trigger compaction.

    When the cumulative token count (input + output) across all messages exceeds this threshold,
    the message history will be automatically summarized and compressed. Defaults to 100,000 tokens.
    """

    model: str
    """
    The model to use for generating the compaction summary.
    If not specified, defaults to the same model used for the tool runner.
    """

    summary_prompt: str
    """The prompt used to instruct the model on how to generate the summary."""

    enabled: Required[bool]
