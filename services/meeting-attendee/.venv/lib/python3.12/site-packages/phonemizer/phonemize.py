# Copyright 2015-2021 Mathieu Bernard
#
# This file is part of phonemizer: you can redistribute it and/or
# modify it under the terms of the GNU General Public License as
# published by the Free Software Foundation, either version 3 of the
# License, or (at your option) any later version.
#
# Phonemizer is distributed in the hope that it will be useful, but
# WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
# General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with phonemizer. If not, see <http://www.gnu.org/licenses/>.
"""Provides the phonemize function

To use it in your own code, type:

    from phonemizer import phonemize

"""

import os
import sys
from logging import Logger
from typing import Optional, Union, List, Pattern

from typing_extensions import Literal

from phonemizer.backend import BACKENDS
from phonemizer.backend.base import BaseBackend
from phonemizer.backend.espeak.language_switch import LanguageSwitch
from phonemizer.backend.espeak.words_mismatch import WordMismatch
from phonemizer.logger import get_logger
from phonemizer.punctuation import Punctuation
from phonemizer.separator import default_separator, Separator
from phonemizer.utils import list2str, str2list

Backend = Literal['espeak', 'espeak-mbrola', 'festival', 'segments']
_PHONEMIZER_CACHE = {}


def phonemize(  # pylint: disable=too-many-arguments
        text,
        language: str = 'en-us',
        backend: Backend = 'espeak',
        separator: Optional[Separator] = default_separator,
        strip: bool = False,
        prepend_text: bool = False,
        preserve_empty_lines: bool = False,
        preserve_punctuation: bool = False,
        punctuation_marks: Union[str, Pattern] = Punctuation.default_marks(),
        with_stress: bool = False,
        tie: Union[bool, str] = False,
        language_switch: LanguageSwitch = 'keep-flags',
        words_mismatch: WordMismatch = 'ignore',
        njobs: int = 1,
        logger: Logger = get_logger()):
    """Multilingual text to phonemes converter

    Return a phonemized version of an input `text`, given its `language` and a
    phonemization `backend`.

    Note
    ----

    To improve the processing speed it is better to minimize the calls to this
    function: provide the input text as a list and call phonemize() a single
    time is much more efficient than calling it on each element of the list.
    Indeed the initialization of the phonemization backend can be expensive,
    especially for espeak. In one example,

    Do this:

    >>> text = [line1, line2, ...]
    >>> phonemize(text, ...)

    Not this:

    >>> for line in text:
    >>>     phonemize(line, ...)

    Parameters
    ----------

    text: str or list of str
        The text to be phonemized. Any empty line will
        be ignored. If ``text`` is an str, it can be multiline (lines being
        separated by ``\\n``). If ``text`` is a list, each element is considered as a
        separated line. Each line is considered as a text utterance.

    language: str
        The language code of the input text, must be supported by
        the backend. If ``backend`` is 'segments', the language can be a file with
        a grapheme to phoneme mapping.

    backend: str, optional
        The software backend to use for phonemization,
        must be 'festival' (US English only is supported, coded 'en-us'),
        'espeak', 'espeak-mbrola' or 'segments'.

    separator: Separator
        string separators between phonemes, syllables and
        words, default to separator.default_separator. Syllable separator is
        considered only for the festival backend. Word separator is ignored by
        the 'espeak-mbrola' backend. Initialize it as follows:
            >>> from phonemizer.separator import Separator
            >>> separator = Separator(phone='-', word=' ')

    strip: bool, optional
        If True, don't output the last word and phone
        separators of a token, default to False.

    prepend_text: bool, optional
        When True, returns a pair (input utterance,
        phonemized utterance) for each line of the input text. When False,
        returns only the phonemized utterances. Default to False

    preserve_empty_lines: bool, optional
        When True, will keep the empty lines
        in the phonemized output. Default to False and remove all empty lines.

    preserve_punctuation: bool, optional
        When True, will keep the punctuation
        in the phonemized output. Not supported by the 'espeak-mbrola' backend.
        Default to False and remove all the punctuation.

    punctuation_marks: str or re.Pattern, optional
        The punctuation marks to consider when dealing with punctuation,
        either for removal or preservation.  Can be defined as a string or regular expression.
        Default to Punctuation.default_marks().

    with_stress: bool, optional
        This option is only valid for the 'espeak'
        backend. When True the stresses on phonemes are present (stresses
        characters are ˈ'ˌ). When False stresses are removed. Default to False.

    tie: bool or char, optional
        This option is only valid for the 'espeak'
        backend with espeak>=1.49. It is incompatible with phone separator. When
        not False, use a tie character within multi-letter phoneme names. When
        True, the char 'U+361' is used (as in d͡ʒ), 'z' means ZWJ character,
        default to False.

    language_switch: str, optional
        Espeak can output some words in another
        language (typically English) when phonemizing a text. This option setups
        the policy to use when such a language switch occurs. Three values are
        available : 'keep-flags' (the default), 'remove-flags' or
        'remove-utterance'. The 'keep-flags' policy keeps the language switching
        flags, for example "(en) or (jp)", in the output. The 'remove-flags'
        policy removes them and the 'remove-utterance' policy removes the whole
        line of text including a language switch. This option is only valid for
        the 'espeak' backend.

    words_mismatch: str, optional
        Espeak can join two consecutive words or
        drop some words, yielding a word count mismatch between orthographic and
        phonemized text. This option setups the policy to use when such a words
        count mismatch occurs. Three values are available: 'ignore' (the default)
        which do nothing, 'warn' which issue a warning for each mismatched line,
        and 'remove' which remove the mismatched lines from the output.

    njobs: int
        The number of parallel jobs to launch. The input text is split
        in ``njobs`` parts, phonemized on parallel instances of the backend and the
        outputs are finally collapsed.

    logger: logging.Logger
        the logging instance where to send messages. If
        not specified, use the default system logger.

    Returns
    -------
    phonemized text: str or list of str
        The input ``text`` phonemized for the
        given ``language`` and ``backend``. The returned value has the same type of
        the input text (either a list or a string), excepted if ``prepend_input``
        is True where the output is forced as a list of pairs (input_text,
        phonemized text).

    Raises
    ------
    RuntimeError
        if the ``backend`` is not valid or is valid but not installed,
        if the ``language`` is not supported by the ``backend``, if any incompatible options are used.

    """
    # ensure we are using a compatible Python version
    if sys.version_info < (3, 6):  # pragma: nocover
        logger.error(
            'Your are using python-%s which is unsupported by the phonemizer, '
            'please update to python>=3.6', ".".join(sys.version_info))

    # ensure the arguments are valid
    _check_arguments(
        backend, with_stress, tie, separator, language_switch, words_mismatch)

    # preserve_punctuation and word separator not valid for espeak-mbrola
    if backend == 'espeak-mbrola' and preserve_punctuation:
        logger.warning('espeak-mbrola backend cannot preserve punctuation')
    if backend == 'espeak-mbrola' and separator.word:
        logger.warning('espeak-mbrola backend cannot preserve word separation')
        
    # cache handling: if this instance has been created in the past, everything should be A-OK
    # todo: clean cache on __delete__
    cache_key = (
        backend,
        language,
        str(punctuation_marks),
        preserve_punctuation,
        with_stress,
        tie,
        language_switch,
        words_mismatch
    )
    
    if cache_key in _PHONEMIZER_CACHE:
        return _phonemize(_PHONEMIZER_CACHE[cache_key], text, separator, strip, njobs, prepend_text, preserve_empty_lines)

    # initialize the phonemization backend
    if backend == 'espeak':
        phonemizer = BACKENDS[backend](
            language,
            punctuation_marks=punctuation_marks,
            preserve_punctuation=preserve_punctuation,
            with_stress=with_stress,
            tie=tie,
            language_switch=language_switch,
            words_mismatch=words_mismatch,
            logger=logger)
        # cache espeak-ng instance
        _PHONEMIZER_CACHE[cache_key] = phonemizer
    elif backend == 'espeak-mbrola':
        phonemizer = BACKENDS[backend](
            language,
            logger=logger)
    else:  # festival or segments
        phonemizer = BACKENDS[backend](
            language,
            punctuation_marks=punctuation_marks,
            preserve_punctuation=preserve_punctuation,
            logger=logger)

    # do the phonemization
    return _phonemize(phonemizer, text, separator, strip, njobs, prepend_text, preserve_empty_lines)


def _check_arguments(  # pylint: disable=too-many-arguments
        backend: Backend,
        with_stress: bool,
        tie: Union[bool, str],
        separator: Separator,
        language_switch: LanguageSwitch,
        words_mismatch: WordMismatch):
    """Auxiliary function to phonemize()

    Ensures the parameters are compatible with each other, raises a
    RuntimeError the first encountered error.

    """
    # ensure the backend is either espeak, festival or segments
    if backend not in ('espeak', 'espeak-mbrola', 'festival', 'segments'):
        raise RuntimeError(
            '{} is not a supported backend, choose in {}.'
                .format(backend, ', '.join(
                ('espeak', 'espeak-mbrola', 'festival', 'segments'))))

    # with_stress option only valid for espeak
    if with_stress and backend != 'espeak':
        raise RuntimeError(
            'the "with_stress" option is available for espeak backend only, '
            'but you are using {} backend'.format(backend))

    # tie option only valid for espeak
    if tie and backend != 'espeak':
        raise RuntimeError(
            'the "tie" option is available for espeak backend only, '
            'but you are using {} backend'.format(backend))

    # tie option incompatible with phone separator
    if tie and separator.phone:
        raise RuntimeError(
            'the "tie" option is incompatible with phone separator '
            f'(which is "{separator.phone}")')

    # language_switch option only valid for espeak
    if language_switch != 'keep-flags' and backend != 'espeak':
        raise RuntimeError(
            'the "language_switch" option is available for espeak backend '
            'only, but you are using {} backend'.format(backend))

    # words_mismatch option only valid for espeak
    if words_mismatch != 'ignore' and backend != 'espeak':
        raise RuntimeError(
            'the "words_mismatch" option is available for espeak backend '
            'only, but you are using {} backend'.format(backend))


def _phonemize(  # pylint: disable=too-many-arguments
        backend: BaseBackend,
        text: Union[str, List[str]],
        separator: Separator,
        strip: bool,
        njobs: int,
        prepend_text: bool,
        preserve_empty_lines: bool):
    """Auxiliary function to phonemize()

    Does the phonemization and returns the phonemized text. Raises a
    RuntimeError on error.

    """
    # remember the text type for output (either list or string)
    text_type = type(text)

    # force the text as a list
    text = [line.strip(os.linesep) for line in str2list(text)]

    # if preserving empty lines, note the index of each empty line
    if preserve_empty_lines:
        empty_lines = [n for n, line in enumerate(text) if not line.strip()]

    # ignore empty lines
    text = [line for line in text if line.strip()]

    if (text):
        # phonemize the text
        phonemized = backend.phonemize(
            text, separator=separator, strip=strip, njobs=njobs)
    else:
        phonemized = []

    # if preserving empty lines, reinsert them into text and phonemized lists
    if preserve_empty_lines:
        for i in empty_lines: # noqa
            if prepend_text:
                text.insert(i, '')
            phonemized.insert(i, '')

    # at that point, the phonemized text is a list of str. Format it as
    # expected by the parameters
    if prepend_text:
        return list(zip(text, phonemized))
    if text_type == str:
        return list2str(phonemized)
    return phonemized
