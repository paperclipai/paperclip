"""
Default implementations for error handlers
"""
import logging

from segments.util import REPLACEMENT_MARKER

log = logging.getLogger(__name__)


def strict(c):  # pylint: disable=C0116
    log.debug('invalid grapheme: %s', c)
    raise ValueError('invalid grapheme')


def replace(c):  # pylint: disable=C0116
    log.debug('replacing grapheme: %s', c)
    return REPLACEMENT_MARKER


def ignore(c):  # pylint: disable=C0116
    log.debug('ignoring grapheme: %s', c)
    return ''
