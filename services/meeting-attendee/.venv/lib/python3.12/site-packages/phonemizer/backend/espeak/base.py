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
"""Base class of espeak backends for the phonemizer"""

import abc
from logging import Logger
from typing import Optional, Union, Pattern

from phonemizer.backend.base import BaseBackend
from phonemizer.backend.espeak.wrapper import EspeakWrapper
from phonemizer.logger import get_logger
from phonemizer.punctuation import Punctuation
from phonemizer.separator import Separator


class BaseEspeakBackend(BaseBackend):
    """Abstract espeak backend for the phonemizer

    Base class of the concrete backends Espeak and EspeakMbrola. It provides
    facilities to find espeak library and read espeak version.

    """
    def __init__(self, language: str,
                 punctuation_marks: Optional[Union[str, Pattern]] = None,
                 preserve_punctuation: bool = False,
                 logger: Optional[Logger] = None):
        super().__init__(
            language,
            punctuation_marks=punctuation_marks,
            preserve_punctuation=preserve_punctuation,
            logger=logger)

        self._espeak = EspeakWrapper()
        self.logger.debug('loaded %s', self._espeak.library_path)


    @classmethod
    def set_library(cls, library):
        """Sets the espeak backend to use `library`

        If this is not set, the backend uses the default espeak shared library
        from the system installation.

        Parameters
        ----------
        library (str or None) : the path to the espeak shared library to use as
            backend. Set `library` to None to restore the default.

        """
        EspeakWrapper.set_library(library)

    @classmethod
    def library(cls):
        """Returns the espeak library used as backend

        The following precedence rule applies for library lookup:

        1. As specified by BaseEspeakBackend.set_library()
        2. Or as specified by the environment variable
           PHONEMIZER_ESPEAK_LIBRARY
        3. Or the default espeak library found on the system

        Raises
        ------
        RuntimeError if the espeak library cannot be found or if the
            environment variable PHONEMIZER_ESPEAK_LIBRARY is set to a
            non-readable file

        """
        return EspeakWrapper.library()

    @classmethod
    def is_available(cls) -> bool:
        try:
            EspeakWrapper()
        except RuntimeError:  # pragma: nocover
            return False
        return True

    @classmethod
    def is_espeak_ng(cls) -> bool:
        """Returns True if using espeak-ng, False otherwise"""
        # espeak-ng starts with version 1.49
        return cls.version() >= (1, 49)

    @classmethod
    def version(cls):
        """Espeak version as a tuple (major, minor, patch)

        Raises
        ------
        RuntimeError if BaseEspeakBackend.is_available() is False or if the
            version cannot be extracted for some reason.

        """
        return EspeakWrapper().version

    @abc.abstractmethod
    def _postprocess_line(self, line: str, num: int,
                          separator: Separator, strip: bool) -> str:
        pass
