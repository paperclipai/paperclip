# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import List, Optional
from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaPackages"]


class BetaPackages(BaseModel):
    """Packages (and their versions) available in this environment."""

    apt: List[str]
    """Ubuntu/Debian packages to install"""

    cargo: List[str]
    """Rust packages to install"""

    gem: List[str]
    """Ruby packages to install"""

    go: List[str]
    """Go packages to install"""

    npm: List[str]
    """Node.js packages to install"""

    pip: List[str]
    """Python packages to install"""

    type: Optional[Literal["packages"]] = None
    """Package configuration type"""
