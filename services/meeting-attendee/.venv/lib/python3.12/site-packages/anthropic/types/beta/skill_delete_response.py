# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from ..._models import BaseModel

__all__ = ["SkillDeleteResponse"]


class SkillDeleteResponse(BaseModel):
    id: str
    """Unique identifier for the skill.

    The format and length of IDs may change over time.
    """

    type: str
    """Deleted object type.

    For Skills, this is always `"skill_deleted"`.
    """
