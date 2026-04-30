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
"""Manages language switches for the espeak backend

This module is used in phonemizer.backend.EspeakBackend and should be
considered private.

It manages languages switches that occur during phonemization, where a part of
a text is phonemized in a language different from the target language. For
instance the sentence "j'aime le football" in French will be phonemized by
espeak as "ʒɛm lə (en)fʊtbɔːl(fr)", "football" be pronounced as an English
word. This may cause two issues to end users. First it introduces undesirable
(.) language switch flags. It may introduce extra phones that are not present
in the target language phoneset.

This module implements 3 alternative solutions the user can choose when
initializing the espeak backend:
- 'keep-flags' preserves the language switch flags,
- 'remove-flags' removes the flags (.) but preserves the words with alternative
  phoneset,
- 'remove-utterance' removes the utterances where flags are detected.

"""

import abc
import re
from logging import Logger
from typing import List, Tuple
from typing_extensions import TypeAlias, Literal

LanguageSwitch: TypeAlias = Literal['keep-flags', 'remove-flags', 'remove-utterance']


def get_language_switch_processor(mode: LanguageSwitch, logger: Logger, language: str) -> 'BaseLanguageSwitch':
    """Returns a language switch processor initialized from `mode`

    The `mode` can be one of the following:
    - 'keep-flags' to preserve the switch flags
    - 'remove-flags' to suppress the switch flags
    - 'remove-utterance' to suppress the entire utterance

    Raises a RuntimeError if the `mode` is unknown.

    """
    processors = {
        'keep-flags': KeepFlags,
        'remove-flags': RemoveFlags,
        'remove-utterance': RemoveUtterances}

    try:
        return processors[mode](logger, language)
    except KeyError:
        raise RuntimeError(
            f'mode "{mode}" invalid, must be in {", ".join(processors.keys())}'
        ) from None


class BaseLanguageSwitch(abc.ABC):
    """The base class for language switch processors

    Parameters
    ----------
    logger (logging.Logger) : a logger instance to send warnings when language
        switches are detected.
    language (str) : the language code currently in use by the phonemizer, to
        customize warning content

    """
    # a regular expression to find language switch flags in espeak output,
    # Switches have the following form (here a switch from English to French):
    # "something (fr)quelque chose(en) another thing".
    _ESPEAK_FLAGS_RE = re.compile(r'\(.+?\)')

    def __init__(self, logger: Logger, language: str):
        self._logger = logger
        self._language = language

    @classmethod
    def is_language_switch(cls, utterance: str) -> bool:
        """Returns True is a language switch is present in the `utterance`"""
        return bool(cls._ESPEAK_FLAGS_RE.search(utterance))

    @classmethod
    @abc.abstractmethod
    def process(cls, utterance: str) -> Tuple[str, bool]:
        """Detects and process language switches according to the mode

        This method is called on each utterance as a phonemization
        post-processing step.

        Returns
        -------
        processed_utterance (str) : the utterance either preserved, deleted (as
            '') or with the switch removed
        has_switch (bool): True if a language switch flag is found in the
            `utterance` and False otherwise

        """

    @abc.abstractmethod
    def warning(self, switches: List[int]):
        """Sends warnings to the logger with recorded language switches

        This method is called a single time at the very end of the
        phonemization process.

        Parameters
        ----------
        switches (list of int) : the line numbers where language switches has
            been detected during phonemization

        """


class KeepFlags(BaseLanguageSwitch):
    """Preserves utterances even if language switch flags are present"""

    @classmethod
    def process(cls, utterance: str) -> Tuple[str, bool]:
        return utterance, cls.is_language_switch(utterance)

    def warning(self, switches: List[int]):
        if not switches:
            return

        nswitches = len(switches)
        self._logger.warning(
            '%s utterances containing language switches '
            'on lines %s', nswitches,
            ', '.join(str(switch) for switch in sorted(switches)))
        self._logger.warning(
            'extra phones may appear in the "%s" phoneset', self._language)
        self._logger.warning(
            'language switch flags have been kept '
            '(applying "keep-flags" policy)')


class RemoveFlags(BaseLanguageSwitch):
    """Removes the language switch flags when detected"""

    @classmethod
    def process(cls, utterance: str) -> Tuple[str, bool]:
        if cls.is_language_switch(utterance):
            # remove all the (lang) flags in the current utterance
            return re.sub(cls._ESPEAK_FLAGS_RE, '', utterance), True
        return utterance, False

    def warning(self, switches: List[int]):
        if not switches:
            return

        nswitches = len(switches)
        self._logger.warning(
            '%s utterances containing language switches '
            'on lines %s', nswitches,
            ', '.join(str(switch) for switch in sorted(switches)))
        self._logger.warning(
            'extra phones may appear in the "%s" phoneset', self._language)
        self._logger.warning(
            'language switch flags have been removed '
            '(applying "remove-flags" policy)')


class RemoveUtterances(BaseLanguageSwitch):
    """Remove the entire utterance when a language switch flag is detected"""

    @classmethod
    def process(cls, utterance: str) -> Tuple[str, bool]:
        if cls.is_language_switch(utterance):
            # drop the entire utterance
            return '', True
        return utterance, False

    def warning(self, switches: List[int]):
        if not switches:
            return

        nswitches = len(switches)
        self._logger.warning(
            'removed %s utterances containing language switches '
            '(applying "remove-utterance" policy)', nswitches)
