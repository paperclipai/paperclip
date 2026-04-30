# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from ...._models import BaseModel

__all__ = ["VersionListResponse"]


class VersionListResponse(BaseModel):
    id: str
    """Unique identifier for the skill version.

    The format and length of IDs may change over time.
    """

    created_at: str
    """ISO 8601 timestamp of when the skill version was created."""

    description: str
    """Description of the skill version.

    This is extracted from the SKILL.md file in the skill upload.
    """

    directory: str
    """Directory name of the skill version.

    This is the top-level directory name that was extracted from the uploaded files.
    """

    name: str
    """Human-readable name of the skill version.

    This is extracted from the SKILL.md file in the skill upload.
    """

    skill_id: str
    """Identifier for the skill that this version belongs to."""

    type: str
    """Object type.

    For Skill Versions, this is always `"skill_version"`.
    """

    version: str
    """Version identifier for the skill.

    Each version is identified by a Unix epoch timestamp (e.g., "1759178010641129").
    """
