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
"""Segments backend for the phonemizer"""

import pathlib
from logging import Logger
from typing import Optional, Dict, List, Union, Pattern

import segments

from phonemizer.backend.base import BaseBackend
from phonemizer.separator import Separator
from phonemizer.utils import get_package_resource, version_as_tuple


class SegmentsBackend(BaseBackend):
    """Segments backends for the phonemizer

    The phonemize method will raise a ValueError when parsing an
    unknown morpheme.

    """

    def __init__(self, language: str,
                 punctuation_marks: Optional[Union[str, Pattern]] = None,
                 preserve_punctuation: bool = False,
                 logger: Optional[Logger] = None):
        # will be initialized in _init_language() from super().__init__()
        self._tokenizer: Optional[segments.Tokenizer] = None
        super().__init__(
            language,
            punctuation_marks=punctuation_marks,
            preserve_punctuation=preserve_punctuation,
            logger=logger)

    def _init_language(self, language):
        # load the grapheme to phoneme mapping
        profile = self._load_g2p_profile(language)
        self._tokenizer = segments.Tokenizer(profile=profile)

        # this is the language code
        return pathlib.Path(language).stem

    @staticmethod
    def name():
        return 'segments'

    @classmethod
    def version(cls):
        return version_as_tuple(segments.__version__)

    @classmethod
    def is_available(cls):
        return True

    @staticmethod
    def supported_languages():
        """Returns a dict of language: file supported by the segments backend

        The supported languages have a grapheme to phoneme conversion file
        bundled with phonemizer. Users can also use their own file as
        parameter of the phonemize() function.

        """
        # directory phonemizer/share/segments
        directory = get_package_resource('segments')

        # supported languages are files with the 'g2p' extension
        return {g2p.stem: g2p
                for g2p in directory.iterdir() if g2p.suffix == '.g2p'}

    @classmethod
    def is_supported_language(cls, language: str) -> bool:
        if pathlib.Path(language).is_file():
            try:
                cls._load_g2p_profile(language)
                return True
            except RuntimeError:
                return False
        return language in cls.supported_languages()

    @classmethod
    def _load_g2p_profile(cls, language: str) -> segments.Profile:
        """Returns a segments profile from a `language`"""
        # make sure the g2p file exists
        if not pathlib.Path(language).is_file():
            try:
                language = cls.supported_languages()[language]
            except KeyError:
                raise RuntimeError(
                    f'grapheme to phoneme file not found: '
                    f'{language}') from None

        # load the mapping grapheme -> phoneme from the file, make sure all
        # lines are well formatted
        g2p: Dict[str, str] = {}
        with open(language, 'r', encoding='utf8') as flang:
            for num, line in enumerate(flang):
                elts = line.strip().split()
                if not len(elts) == 2:
                    raise RuntimeError(
                        'grapheme to phoneme file, line {} must have 2 rows '
                        'but have {}: {}'.format(num + 1, len(elts), language))
                g2p[elts[0]] = elts[1]

        # build the segments profile from the g2p mapping
        return segments.Profile(
            *[{'Grapheme': k, 'mapping': v} for k, v in g2p.items()])

    # pylint: disable=unused-argument
    def _phonemize_aux(self, text: List[str], offset: int, separator: Separator, strip: bool) -> List[str]:
        # tokenize the input text per utterance
        phonemized = (
            self._tokenizer(line, column='mapping', errors='strict')
            for line in text)

        # the output of segments is always strip, so we need to add
        # token separation at the end when strip is False.
        if not strip:
            # add word separator at end of utterance
            phonemized = (p + ' # ' for p in phonemized)
            # add phoneme separator at end of word
            phonemized = (p.replace(' # ', '  # ') for p in phonemized)

        # replace default separators by our custom ones
        phonemized = (p.replace(' # ', '#') for p in phonemized)
        phonemized = (p.replace(' ', separator.phone) for p in phonemized)
        phonemized = (p.replace('#', separator.word) for p in phonemized)

        # return the result as a list of utterances
        return list(phonemized)
