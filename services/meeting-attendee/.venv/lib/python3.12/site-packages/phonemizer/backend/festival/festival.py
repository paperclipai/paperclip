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
"""Festival backend for the phonemizer"""

import os
import pathlib
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from logging import Logger
from pathlib import Path
from typing import Optional, Dict, List, IO, Union, Pattern

from phonemizer.backend.base import BaseBackend
from phonemizer.backend.festival import lispy
from phonemizer.separator import Separator
from phonemizer.utils import get_package_resource, version_as_tuple


class FestivalBackend(BaseBackend):
    """Festival backend for the phonemizer"""
    # a static variable used to overload the default festival binary installed
    # on the system. The user can choose an alternative festival binary with
    # the method FestivalBackend.set_executable().
    _FESTIVAL_EXECUTABLE = None

    def __init__(self, language: str,
                 punctuation_marks: Optional[Union[str, Pattern]] = None,
                 preserve_punctuation: bool = False,
                 logger: Optional[Logger] = None):
        super().__init__(
            language,
            punctuation_marks=punctuation_marks,
            preserve_punctuation=preserve_punctuation,
            logger=logger)

        self.logger.debug('festival executable is %s', self.executable())

        # the Scheme script to be send to festival
        script_file = get_package_resource('festival/phonemize.scm')
        with open(script_file, 'r') as fscript:
            self._script = fscript.read()
        self.logger.debug('loaded %s', script_file)

    @staticmethod
    def name():
        return 'festival'

    @classmethod
    def set_executable(cls, executable: str):
        """Sets the festival backend to use `executable`

        If this is not set, the backend uses the default festival executable
        from the system installation.

        Parameters
        ----------
        executable (str) : the path to the festival executable to use as
            backend. Set `executable` to None to restore the default.

        Raises
        ------
        RuntimeError if `executable` is not an executable file.

        """
        if executable is None:
            cls._FESTIVAL_EXECUTABLE = None
            return

        executable = pathlib.Path(executable)
        if not (executable.is_file() and os.access(executable, os.X_OK)):
            raise RuntimeError(
                f'{executable} is not an executable file')

        cls._FESTIVAL_EXECUTABLE = executable.resolve()

    @classmethod
    def executable(cls) -> Path:
        """Returns the absolute path to the festival executable used as backend

        The following precedence rule applies for executable lookup:

        1. As specified by FestivalBackend.set_executable()
        2. Or as specified by the environment variable
           PHONEMIZER_FESTIVAL_EXECUTABLE
        3. Or the default 'festival' binary found on the system with ``shutil.which('festival')``


        Raises
        ------
        RuntimeError
            if the festival executable cannot be found or if the
            environment variable PHONEMIZER_FESTIVAL_EXECUTABLE is set to a
            non-executable file

        """
        if cls._FESTIVAL_EXECUTABLE:
            return cls._FESTIVAL_EXECUTABLE

        if 'PHONEMIZER_FESTIVAL_EXECUTABLE' in os.environ:
            executable = pathlib.Path(os.environ[
                                          'PHONEMIZER_FESTIVAL_EXECUTABLE'])
            if not (
                    executable.is_file()
                    and os.access(executable, mode=os.X_OK)
            ):
                raise RuntimeError(
                    f'PHONEMIZER_FESTIVAL_EXECUTABLE={executable} '
                    f'is not an executable file')
            return executable.resolve()

        executable = shutil.which('festival')
        if not executable:  # pragma: nocover
            raise RuntimeError(
                'failed to find festival executable')
        return Path(executable).resolve()

    @classmethod
    def is_available(cls):
        """True if the festival executable is available, False otherwise"""
        try:
            cls.executable()
        except RuntimeError:  # pragma: nocover
            return False
        return True

    @classmethod
    def version(cls):
        """Festival version as a tupe of integers (major, minor, patch)

        Raises
        ------
        RuntimeError if FestivalBackend.is_available() is False or if the
            version cannot be extracted for some reason.

        """

        festival = cls.executable()

        # the full version version string includes extra information
        # we don't need
        long_version = subprocess.check_output(
            [festival, '--version']).decode('latin1').strip()

        # extract the version number with a regular expression
        festival_version_re = r'.* ([0-9\.]+[0-9]):'
        try:
            version = re.match(festival_version_re, long_version).group(1)
        except AttributeError:
            raise RuntimeError(
                f'cannot extract festival version from {festival}') from None

        return version_as_tuple(version)

    @staticmethod
    def supported_languages() -> Dict[str, str]:
        """A dictionnary of language codes -> name supported by festival

        Actually only en-us (American English) is supported.

        """
        return {'en-us': 'english-us'}

    # pylint: disable=unused-argument
    def _phonemize_aux(self, text: List[str], offset: int, separator: Separator, strip: bool) -> List[str]:
        """Return a phonemized version of `text` with festival

        This function is a wrapper on festival, a text to speech
        program, allowing simple phonemization of some English
        text. The US phoneset we use is the default one in festival,
        as described at http://www.festvox.org/bsv/c4711.html

        Any opening and closing parenthesis in `text` are removed, as
        they interfer with the Scheme expression syntax. Moreover
        double quotes are replaced by simple quotes because double
        quotes denotes utterances boundaries in festival.

        Parsing a ill-formed Scheme expression during post-processing
        (typically with unbalanced parenthesis) raises an IndexError.

        """
        text = self._preprocess(text)
        if len(text) == 0:
            return []
        text = self._process(text)
        text = self._postprocess(text, separator, strip)
        return text

    @staticmethod
    def _double_quoted(line: str) -> str:
        """Return the string `line` surrounded by double quotes"""
        return '"' + line + '"'

    @staticmethod
    def _cleaned(line: str):
        """Remove 'forbidden' characters from the line"""
        # special case (very unlikely but causes a crash in festival)
        # where a line is only made of '
        if set(line) == set("'"):
            line = ''

        # remove forbidden characters (reserved for scheme, ie festival
        # scripting language)
        return line.replace('"', '').replace('(', '').replace(')', '').strip()

    @classmethod
    def _preprocess(cls, text: List[str]):
        """Returns the contents of `text` formatted for festival input

        This function adds double quotes to begining and end of each
        line in text, if not already presents. The returned result is
        a multiline string. Empty lines in inputs are ignored.

        """
        cleaned_text = (
            cls._cleaned(line) for line in text if line != '')

        return '\n'.join(
            cls._double_quoted(line) for line in cleaned_text if line != '')

    def _process(self, text: str):
        """Return the raw phonemization of `text`

        This function delegates to festival the text analysis and
        syllabic structure extraction.

        Return a string containing the "SylStructure" relation tree of
        the text, as a scheme expression.

        """
        with tempfile.NamedTemporaryFile('w+', delete=False) as data:
            try:
                # save the text as a tempfile
                data.write(text)
                data.close()

                # fix the path name for windows
                name = data.name
                if sys.platform == 'win32':  # pragma: nocover
                    name = name.replace('\\', '\\\\')

                with tempfile.NamedTemporaryFile('w+', delete=False) as scm:
                    try:
                        scm.write(self._script.format(name))
                        scm.close()

                        cmd = f'{self.executable()} -b {scm.name}'
                        if self.logger:
                            self.logger.debug('running %s', cmd)

                        # redirect stderr to a tempfile and displaying it only
                        # on errors. Messages are something like: "UniSyn:
                        # using default diphone ax-ax for y-pau". This is
                        # related to wave synthesis (done by festival during
                        # phonemization).
                        with tempfile.TemporaryFile('w+') as fstderr:
                            return self._run_festival(cmd, fstderr)
                    finally:
                        os.remove(scm.name)
            finally:
                os.remove(data.name)

    @staticmethod
    def _run_festival(cmd: str, fstderr: IO) -> str:
        """Runs the festival command for phonemization

        Returns the raw phonemized output (need to be postprocesses). Raises a
        RuntimeError if festival fails.

        """
        try:
            output = subprocess.check_output(
                shlex.split(cmd, posix=False), stderr=fstderr)

            # festival seems to use latin1 and not utf8
            return re.sub(' +', ' ', output.decode('latin1'))

        except subprocess.CalledProcessError as err:  # pragma: nocover
            fstderr.seek(0)
            raise RuntimeError(
                f'Command "{cmd}" returned exit status {err.returncode}, '
                f'output is:\n{fstderr.read()}') from None

    @staticmethod
    def _postprocess_syll(syll: List[str], separator: Separator, strip: bool) -> str:
        """Parse a syllable from festival to phonemized output"""
        sep = separator.phone
        out = (phone[0][0].replace('"', '') for phone in syll[1:])
        out = sep.join(o for o in out if o != '')
        return out if strip else out + sep

    @classmethod
    def _postprocess_word(cls, word: List[List[str]], separator: Separator, strip: bool) -> str:
        """Parse a word from festival to phonemized output"""
        sep = separator.syllable
        out = sep.join(
            cls._postprocess_syll(syll, separator, strip)
            for syll in word[1:])
        return out if strip else out + sep

    @classmethod
    def _postprocess_line(cls, line: str, separator, strip: bool) -> str:
        """Parse a line from festival to phonemized output"""
        sep = separator.word
        out = []
        for word in lispy.parse(line):
            word = cls._postprocess_word(word, separator, strip)
            if word != '':
                out.append(word)
        out = sep.join(out)

        return out if strip else out + sep

    @classmethod
    def _postprocess(cls, tree: str, separator: Separator, strip: bool) -> List[str]:
        """Conversion from festival syllable tree to desired format"""
        return [cls._postprocess_line(line, separator, strip)
                for line in tree.split('\n')
                if line not in ['', '(nil nil nil)']]
