# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaAdvisorRedactedResultBlockParam"]


class BetaAdvisorRedactedResultBlockParam(TypedDict, total=False):
    encrypted_content: Required[str]
    """Opaque blob produced by a prior response; must be round-tripped verbatim."""

    type: Required[Literal["advisor_redacted_result"]]
