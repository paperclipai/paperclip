# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional

from ..._models import BaseModel

__all__ = ["SkillListResponse"]


class SkillListResponse(BaseModel):
    id: str
    """Unique identifier for the skill.

    The format and length of IDs may change over time.
    """

    created_at: str
    """ISO 8601 timestamp of when the skill was created."""

    display_title: Optional[str] = None
    """Display title for the skill.

    This is a human-readable label that is not included in the prompt sent to the
    model.
    """

    latest_version: Optional[str] = None
    """The latest version identifier for the skill.

    This represents the most recent version of the skill that has been created.
    """

    source: str
    """Source of the skill.

    This may be one of the following values:

    - `"custom"`: the skill was created by a user
    - `"anthropic"`: the skill was created by Anthropic
    """

    type: str
    """Object type.

    For Skills, this is always `"skill"`.
    """

    updated_at: str
    """ISO 8601 timestamp of when the skill was last updated."""
