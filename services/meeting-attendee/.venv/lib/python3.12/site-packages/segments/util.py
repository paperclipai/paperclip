"""
Utilities
"""
import functools
import unicodedata

import regex

REPLACEMENT_MARKER = '�'
nfd = functools.partial(unicodedata.normalize, 'NFD')
grapheme_pattern = regex.compile(r"\X", regex.UNICODE)
