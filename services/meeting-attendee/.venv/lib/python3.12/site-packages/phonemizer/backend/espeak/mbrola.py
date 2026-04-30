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
"""Mbrola backend for the phonemizer"""

import pathlib
import shutil
import sys
from logging import Logger
from pathlib import Path
from typing import Union, Optional, List, Dict

from phonemizer.backend.espeak.base import BaseEspeakBackend
from phonemizer.backend.espeak.wrapper import EspeakWrapper
from phonemizer.separator import Separator


class EspeakMbrolaBackend(BaseEspeakBackend):
    """Espeak-mbrola backend for the phonemizer"""
    # this will be initialized once, at the first call to supported_languages()
    _supported_languages = None

    def __init__(self, language: str, logger: Optional[Logger] = None):
        super().__init__(language, logger=logger)
        self._espeak.set_voice(language)

    @staticmethod
    def name():
        return 'espeak-mbrola'

    @classmethod
    def is_available(cls) -> bool:
        """Mbrola backend is available for espeak>=1.49"""
        return (
                BaseEspeakBackend.is_available() and
                shutil.which('mbrola') and
                BaseEspeakBackend.is_espeak_ng())

    @classmethod
    def _all_supported_languages(cls):
        # retrieve the mbrola voices. This voices must be installed separately.
        voices = EspeakWrapper().available_voices('mbrola')
        return {voice.identifier[3:]: voice.name for voice in voices}

    @classmethod
    def _is_language_installed(cls, language: str, data_path: Union[str, Path]) \
            -> bool:
        """Returns True if the required mbrola voice is installed"""
        # this is a reimplementation of LoadMbrolaTable from espeak
        # synth_mbrola.h sources
        voice = language[3:]  # remove mb- prefix

        if pathlib.Path(data_path / 'mbrola' / voice).is_file():
            return True  # pragma: nocover

        if sys.platform != 'win32':
            candidates = [
                f'/usr/share/mbrola/{voice}',
                f'/usr/share/mbrola/{voice}/{voice}',
                f'/usr/share/mbrola/voices/{voice}']
            for candidate in candidates:
                if pathlib.Path(candidate).is_file():
                    return True

        return False

    @classmethod
    def supported_languages(cls) -> Dict[str, str]:  # pragma: nocover
        """Returns the list of installed mbrola voices"""
        if cls._supported_languages is None:
            data_path = EspeakWrapper().data_path
            cls._supported_languages = {
                k: v for k, v in cls._all_supported_languages().items()
                if cls._is_language_installed(k, data_path)}
        return cls._supported_languages

    def _phonemize_aux(self, text: List[str], offset: int,
                       separator: Separator, strip: bool) -> List[str]:
        output = []
        for num, line in enumerate(text, start=1):
            line = self._espeak.synthetize(line)
            line = self._postprocess_line(line, offset + num, separator, strip)
            output.append(line)
        return output

    def _postprocess_line(self, line: str, num: int,
                          separator: Separator, strip: bool) -> str:
        # retrieve the phonemes with the correct SAMPA alphabet (but
        # without word separation)
        phonemes = (
            phn.split('\t')[0] for phn in line.split('\n') if phn.strip())
        phonemes = separator.phone.join(pho for pho in phonemes if pho != '_')

        if not strip:
            phonemes += separator.phone

        return phonemes
