# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, TypedDict

from ..._types import SequenceNotStr

__all__ = ["BetaPackagesParams"]


class BetaPackagesParams(TypedDict, total=False):
    """Specify packages (and optionally their versions) available in this environment.

    When versioning, use the version semantics relevant for the package manager, e.g. for `pip` use `package==1.0.0`. You are responsible for validating the package and version exist. Unversioned installs the latest.
    """

    apt: Optional[SequenceNotStr[str]]
    """Ubuntu/Debian packages to install"""

    cargo: Optional[SequenceNotStr[str]]
    """Rust packages to install"""

    gem: Optional[SequenceNotStr[str]]
    """Ruby packages to install"""

    go: Optional[SequenceNotStr[str]]
    """Go packages to install"""

    npm: Optional[SequenceNotStr[str]]
    """Node.js packages to install"""

    pip: Optional[SequenceNotStr[str]]
    """Python packages to install"""

    type: Literal["packages"]
    """Package configuration type"""
