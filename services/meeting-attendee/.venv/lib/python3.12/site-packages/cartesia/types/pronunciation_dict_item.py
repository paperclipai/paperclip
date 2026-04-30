# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from .._models import BaseModel

__all__ = ["PronunciationDictItem"]


class PronunciationDictItem(BaseModel):
    """A pronunciation dictionary item mapping text to a custom pronunciation"""

    alias: str
    """A phonetic representation or text to be said in place of the original text"""

    text: str
    """The original text to be replaced"""
