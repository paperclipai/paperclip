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
"""Espeak backend for the phonemizer"""

import itertools
import re
from logging import Logger
from typing import Optional, Tuple, List, Union, Pattern

from phonemizer.backend.espeak.base import BaseEspeakBackend
from phonemizer.backend.espeak.language_switch import (
    get_language_switch_processor, LanguageSwitch, BaseLanguageSwitch)
from phonemizer.backend.espeak.words_mismatch import (
    get_words_mismatch_processor, WordMismatch, BaseWordsMismatch)
from phonemizer.backend.espeak.wrapper import EspeakWrapper
from phonemizer.separator import Separator


class EspeakBackend(BaseEspeakBackend):
    """Espeak backend for the phonemizer"""
    # a regular expression to find phonemes stresses in espeak output
    _ESPEAK_STRESS_RE = re.compile(r"[ˈˌ'-]+")

    # pylint: disable=too-many-arguments
    def __init__(self, language: str,
                 punctuation_marks: Optional[Union[str, Pattern]] = None,
                 preserve_punctuation: bool = False,
                 with_stress: bool = False,
                 tie: Union[bool, str] = False,
                 language_switch: LanguageSwitch = 'keep-flags',
                 words_mismatch: WordMismatch = 'ignore',
                 logger: Optional[Logger] = None):
        super().__init__(
            language, punctuation_marks=punctuation_marks,
            preserve_punctuation=preserve_punctuation, logger=logger)

        self._espeak.set_voice(language)
        self._with_stress = with_stress
        self._tie = self._init_tie(tie)
        self._lang_switch: BaseLanguageSwitch = get_language_switch_processor(
            language_switch, self.logger, self.language)
        self._words_mismatch: BaseWordsMismatch = get_words_mismatch_processor(
            words_mismatch, self.logger)

    @staticmethod
    def _init_tie(tie) -> Optional[str]:
        if not tie:
            return None

        if tie is True:  # default U+361 tie character
            return '͡'

        # non default tie charcacter
        tie = str(tie)
        if len(tie) != 1:
            raise RuntimeError(
                f'explicit tie must be a single charcacter but is {tie}')
        return tie

    @staticmethod
    def name():
        return 'espeak'

    @classmethod
    def supported_languages(cls):
        return {
            voice.language: voice.name
            for voice in EspeakWrapper().available_voices()}

    def _phonemize_aux(self, text, offset, separator, strip):
        if self._tie is not None and separator.phone:
            self.logger.warning(
                'cannot use ties AND phone separation, '
                'ignoring phone separator')

        output = []
        lang_switches = []
        for num, line in enumerate(text, start=1):
            line = self._espeak.text_to_phonemes(line, self._tie)
            line, has_switch = self._postprocess_line(
                line, num, separator, strip)
            output.append(line)
            if has_switch:
                lang_switches.append(num + offset)

        return output, lang_switches

    def _process_stress(self, word):
        if self._with_stress:
            return word
        # remove the stresses on phonemes
        return re.sub(self._ESPEAK_STRESS_RE, '', word)

    def _process_tie(self, word: str, separator: Separator):
        # NOTE a bug in espeak append ties to (en) flags so as (͡e͡n).
        # We do not correct it here.
        if self._tie is not None and self._tie != '͡':
            # replace default '͡' by the requested one
            return word.replace('͡', self._tie)
        return word.replace('_', separator.phone)

    def _postprocess_line(self, line: str, num: int,
                          separator: Separator, strip: bool) -> Tuple[str, bool]:
        # espeak can split an utterance into several lines because
        # of punctuation, here we merge the lines into a single one
        line = line.strip().replace('\n', ' ').replace('  ', ' ')

        # due to a bug in espeak-ng, some additional separators can be
        # added at the end of a word. Here a quick fix to solve that
        # issue. See https://github.com/espeak-ng/espeak-ng/issues/694
        line = re.sub(r'_+', '_', line)
        line = re.sub(r'_ ', ' ', line)

        line, has_switch = self._lang_switch.process(line)
        if not line:
            return '', has_switch

        out_line = ''
        for word in line.split(' '):
            word = self._process_stress(word.strip())
            if not strip and self._tie is None:
                word += '_'
            word = self._process_tie(word, separator)
            out_line += word + separator.word

        if strip and separator.word:
            # erase the last word separator from the line
            out_line = out_line[:-len(separator.word)]

        return out_line, has_switch

    def _phonemize_preprocess(self, text: List[str]) -> Tuple[Union[str, List[str]], List]:
        text, punctuation_marks = super()._phonemize_preprocess(text)
        self._words_mismatch.count_text(text)
        return text, punctuation_marks

    def _phonemize_postprocess(self, phonemized, punctuation_marks, separator: Separator, strip: bool):
        text = phonemized[0]
        switches = phonemized[1]

        self._words_mismatch.count_phonemized(text, separator)
        self._lang_switch.warning(switches)

        phonemized = super()._phonemize_postprocess(text, punctuation_marks, separator, strip)
        return self._words_mismatch.process(phonemized)

    @staticmethod
    def _flatten(phonemized) -> List:
        """Specialization of BaseBackend._flatten for the espeak backend

        From [([1, 2], ['a', 'b']), ([3],), ([4], ['c'])] to [[1, 2, 3, 4],
        ['a', 'b', 'c']].

        """
        flattened = []
        for i in range(len(phonemized[0])):
            flattened.append(
                list(itertools.chain(
                    c for chunk in phonemized for c in chunk[i])))
        return flattened
