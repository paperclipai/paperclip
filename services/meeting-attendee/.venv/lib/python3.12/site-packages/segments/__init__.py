"""
Functionality to segment data using orthography profiles.
"""
from segments.tokenizer import Tokenizer, Rules  # noqa: F401
from segments.profile import Profile  # noqa: F401
from segments.util import REPLACEMENT_MARKER  # noqa: F401

__version__ = '2.4.0'
__all__ = ['Tokenizer', 'Profile', 'Rules']
