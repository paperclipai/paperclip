# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from ...._models import BaseModel

__all__ = ["VersionDeleteResponse"]


class VersionDeleteResponse(BaseModel):
    id: str
    """Version identifier for the skill.

    Each version is identified by a Unix epoch timestamp (e.g., "1759178010641129").
    """

    type: str
    """Deleted object type.

    For Skill Versions, this is always `"skill_version_deleted"`.
    """
