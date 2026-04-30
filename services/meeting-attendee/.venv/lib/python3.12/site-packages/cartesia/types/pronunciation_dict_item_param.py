# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Required, TypedDict

__all__ = ["PronunciationDictItemParam"]


class PronunciationDictItemParam(TypedDict, total=False):
    """A pronunciation dictionary item mapping text to a custom pronunciation"""

    alias: Required[str]
    """A phonetic representation or text to be said in place of the original text"""

    text: Required[str]
    """The original text to be replaced"""
