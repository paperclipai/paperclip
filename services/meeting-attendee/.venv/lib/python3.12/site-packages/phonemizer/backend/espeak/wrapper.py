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
"""Wrapper on espeak-ng library"""

import ctypes
import ctypes.util
import functools
import os
import pathlib
import sys
import tempfile
import weakref
from typing import Tuple, Dict

from phonemizer.backend.espeak.api import EspeakAPI
from phonemizer.backend.espeak.voice import EspeakVoice


class EspeakWrapper:
    """Wrapper on espeak shared library

    The aim of this wrapper is not to be exhaustive but to encapsulate the
    espeak functions required for phonemization. It relies on a espeak shared
    library (*.so on Linux, *.dylib on Mac and *.dll on Windows) that must be
    installed on the system.

    Use the function `EspeakWrapper.set_library()` before instanciation to
    customize the library to use.

    Raises
    ------
    RuntimeError if the espeak shared library cannot be loaded

    """
    # a static variable used to overload the default espeak library installed
    # on the system. The user can choose an alternative espeak library with
    # the method EspeakWrapper.set_library().
    _ESPEAK_LIBRARY = None
    _ESPEAK_DATA_PATH = None

    def __init__(self):
        # the following attributes are accessed through properties and are
        # lazily initialized
        self._version: Tuple[int, ...] = None
        self._data_path = None
        self._voice = None

        # load the espeak API
        self._espeak = EspeakAPI(self.library(), self.data_path)

        # lazy loading of attributes only required for the synthetize method
        self._libc_ = None
        self._tempfile_ = None

    @property
    def _libc(self):
        if self._libc_ is None:
            self._libc_ = (
                ctypes.windll.msvcrt if sys.platform == 'win32' else
                ctypes.cdll.LoadLibrary(ctypes.util.find_library('c')))
        return self._libc_

    @property
    def _tempfile(self):
        if self._tempfile_ is None:
            # this will automatically removed at exit
            # pylint: disable=consider-using-with
            self._tempfile_ = tempfile.NamedTemporaryFile()
            weakref.finalize(self._tempfile_, self._tempfile_.close)
        return self._tempfile_

    def __getstate__(self):
        """For pickling, when phonemizing on multiple jobs"""
        return {
            'version': self._version,
            'data_path': self._data_path,
            'voice': self._voice}

    def __setstate__(self, state: Dict):
        """For unpickling, when phonemizing on multiple jobs"""
        self.__init__()
        self._version = state['version']
        self._data_path = state['data_path']
        self._voice = state['voice']
        if self._voice:
            if 'mb' in self._voice.identifier:  # mbrola voice
                self.set_voice(self._voice.identifier[3:])
            else:
                self.set_voice(self._voice.language)

    @classmethod
    def set_library(cls, library: str):
        """Sets the espeak backend to use `library`

        If this is not set, the backend uses the default espeak shared library
        from the system installation.

        Parameters
        ----------
        library (str or None) : the path to the espeak shared library to use as
          backend. Set `library` to None to restore the default.

        """
        cls._ESPEAK_LIBRARY = library
        
    @classmethod
    def set_data_path(cls, data_path: str):
        """Sets the path for the data to be used by the espeak backend.

        If this is not set, the backend uses the default data path from the system installation.

        Parameters
        ----------
        data_path : str
            The path to the data to be used by the espeak backend. Set `data_path` to None
            to restore the default.

        """
        cls._ESPEAK_DATA_PATH = data_path

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
        if cls._ESPEAK_LIBRARY:
            return cls._ESPEAK_LIBRARY

        if 'PHONEMIZER_ESPEAK_LIBRARY' in os.environ:
            library = pathlib.Path(os.environ['PHONEMIZER_ESPEAK_LIBRARY'])
            if not (library.is_file() and os.access(library, os.R_OK)):
                raise RuntimeError(  # pragma: nocover
                    f'PHONEMIZER_ESPEAK_LIBRARY={library} '
                    f'is not a readable file')
            return library.resolve()

        library = (
                ctypes.util.find_library('espeak-ng') or
                ctypes.util.find_library('espeak'))
        if not library:  # pragma: nocover
            raise RuntimeError(
                'failed to find espeak library')
        return library

    def _fetch_version_and_path(self):
        """Initializes version and dapa path from the espeak library"""
        version, data_path = self._espeak.info()

        # pylint: disable=no-member
        self._data_path = pathlib.Path(data_path.decode())
        if not self._data_path.is_dir():  # pragma: nocover
            raise RuntimeError('failed to retrieve espeak data directory')

        # espeak-1.48 appends the release date to version number, here we
        # simply ignore it
        version = version.decode().strip().split(' ')[0].replace('-dev', '')
        self._version = tuple(int(v) for v in version.split('.'))

    @property
    def version(self) -> Tuple[int, int, int]:
        """The espeak version as a tuple of integers (major, minor, patch)"""
        if self._version is None:
            self._fetch_version_and_path()
        return self._version

    @property
    def library_path(self):
        """The espeak library as a pathlib.Path instance"""
        return self._espeak.library_path

    @property
    def data_path(self):
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
        if self._ESPEAK_DATA_PATH:
            data_path = pathlib.Path(self._ESPEAK_DATA_PATH)
            if not (data_path.is_dir() and os.access(self._ESPEAK_DATA_PATH, os.R_OK)):
                raise RuntimeError(f'{self._ESPEAK_DATA_PATH} is not a readable directory')
            self._data_path = data_path.resolve()
        elif 'PHONEMIZER_ESPEAK_DATA_PATH' in os.environ:
            data_path = pathlib.Path(os.environ['PHONEMIZER_ESPEAK_DATA_PATH'])
            if not (data_path.is_dir() and os.access(data_path, os.R_OK)):
                raise RuntimeError(  # pragma: nocover
                    f'PHONEMIZER_ESPEAK_DATA_PATH={data_path} '
                    f'is not a readable directory')
            self._data_path = data_path.resolve()
        
        # Fetch path dynamically after initialize
        if self._data_path is None and hasattr(self, '_espeak'):
            self._fetch_version_and_path()
        return self._data_path

    @property
    def voice(self):
        """The configured voice as an EspeakVoice instance

        If `set_voice` has not been called, returns None

        """
        return self._voice

    @functools.lru_cache(maxsize=None)
    def available_voices(self, name=None):
        """Voices available for phonemization, as a list of `EspeakVoice`"""
        if name:
            name = EspeakVoice(language=name).to_ctypes()
        voices = self._espeak.list_voices(name or None)

        index = 0
        available_voices = []
        # voices is an array to pointers, terminated by None
        while voices[index]:
            voice = voices[index].contents
            available_voices.append(EspeakVoice(
                name=os.fsdecode(voice.name).replace('_', ' '),
                language=os.fsdecode(voice.languages)[1:],
                identifier=os.fsdecode(voice.identifier)))
            index += 1
        return available_voices

    def set_voice(self, voice_code):
        """Setup the voice to use for phonemization

        Parameters
        ----------
        voice_code (str) : Must be a valid language code that is actually
          supported by espeak

        Raises
        ------
        RuntimeError if the required voice cannot be initialized

        """
        if 'mb' in voice_code:
            # this is an mbrola voice code. Select the voice by using
            # identifier in the format 'mb/{voice_code}'
            available = {
                voice.identifier[3:]: voice.identifier
                for voice in self.available_voices('mbrola')}
        else:
            # this are espeak voices. Select the voice using it's attached
            # language code. Consider only the first voice of a given code as
            # they are sorted by relevancy
            available = {}
            for voice in self.available_voices():
                if voice.language not in available:
                    available[voice.language] = voice.identifier

        try:
            voice_name = available[voice_code]
        except KeyError:
            raise RuntimeError(f'invalid voice code "{voice_code}"') from None

        if self._espeak.set_voice_by_name(voice_name.encode('utf8')) != 0:
            raise RuntimeError(  # pragma: nocover
                f'failed to load voice "{voice_code}"')

        voice = self._get_voice()
        if not voice:  # pragma: nocover
            raise RuntimeError(f'failed to load voice "{voice_code}"')
        self._voice = voice

    def _get_voice(self):
        """Returns the current voice used for phonemization

        If no voice has been set up, returns None.

        """
        voice = self._espeak.get_current_voice()
        if voice.name:
            return EspeakVoice.from_ctypes(voice)
        return None  # pragma: nocover

    def text_to_phonemes(self, text: str, tie: bool = False) -> str:
        """Translates a text into phonemes, must call set_voice() first.

        This method is used by the Espeak backend. Wrapper on the
        espeak_TextToPhonemes function.

        Parameters
        ----------
        text (str) : the text to phonemize

        tie (bool, optional) : When True use a '͡' character between
          consecutive characters of a single phoneme. Else separate phoneme
          with '_'. This option requires espeak>=1.49. Default to False.

        Returns
        -------
        phonemes (str) : the phonemes for the text encoded in IPA, with '_' as
          phonemes separator (excepted if ``tie`` is True) and ' ' as word
          separator.

        """
        if self.voice is None:  # pragma: nocover
            raise RuntimeError('no voice specified')

        if tie and self.version <= (1, 48, 3):
            raise RuntimeError(  # pragma: nocover
                'tie option only compatible with espeak>=1.49')

        # from Python string to C void** (a pointer to a pointer to chars)
        text_ptr = ctypes.pointer(ctypes.c_char_p(text.encode('utf8')))

        # input text is encoded as UTF8
        text_mode = 1

        # output phonemes in IPA and separated by _, or with a tie character if
        # required. See comments for the function espeak_TextToPhonemes in
        # speak_lib.h of the espeak sources for details.
        if self.version <= (1, 48, 3):  # pragma: nocover
            phonemes_mode = 0x03 | 0x01 << 4
        elif tie:
            phonemes_mode = 0x02 | 0x01 << 7 | ord('͡') << 8
        else:
            phonemes_mode = ord('_') << 8 | 0x02

        result = []
        while text_ptr.contents.value is not None:
            phonemes = self._espeak.text_to_phonemes(
                text_ptr, text_mode, phonemes_mode)
            if phonemes:
                result.append(phonemes.decode())
        return ' '.join(result)

    def synthetize(self, text: str):
        """Translates a text into phonemes, must call set_voice() first.

        Only compatible with espeak>=1.49. This method is used by the
        EspeakMbrola backend. Wrapper on the espeak_Synthesize function.

        Parameters
        ----------
        text (str) : the text to phonemize

        Returns
        -------
        phonemes (str) : the phonemes for the text encoded in SAMPA, with '_'
          as phonemes separator and no word separation.

        """

        if self.version < (1, 49):  # pragma: nocover
            raise RuntimeError('not compatible with espeak<=1.48')
        if self.voice is None:  # pragma: nocover
            raise RuntimeError('no voice specified')

        # init libc fopen and fclose functions
        self._libc.fopen.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
        self._libc.fopen.restype = ctypes.c_void_p
        self._libc.fclose.argtypes = [ctypes.c_void_p]
        self._libc.fclose.restype = ctypes.c_int

        # output phonemes in SAMPA and separated by _. Write the result to a
        # tempfile which is read back after phonemization (seems not possible
        # to redirect to stdout). See comments for the function
        # espeak_SetPhonemeTrace in speak_lib.h of the espeak sources for
        # details.
        self._tempfile.truncate(0)
        file_p = self._libc.fopen(
            self._tempfile.name.encode(),
            self._tempfile.mode.encode())

        self._espeak.set_phoneme_trace(0x01 << 4 | ord('_') << 8, file_p)
        status = self._espeak.synthetize(
            ctypes.c_char_p(text.encode('utf8')),
            ctypes.c_size_t(len(text) + 1),
            ctypes.c_uint(0x01))
        self._libc.fclose(file_p)  # because flush does not work...

        if status != 0:  # pragma: nocover
            raise RuntimeError('failed to synthetize')

        self._tempfile.seek(0)
        phonemized = self._tempfile.read().decode().strip()
        return phonemized
