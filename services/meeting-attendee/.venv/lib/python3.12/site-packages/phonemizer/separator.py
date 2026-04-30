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
"""Provides the Separator tuple and its default value"""
from typing import Optional, Union


class Separator:
    """Defines phone, syllable and word boundary tokens"""

    def __init__(self, word: str = ' ',
                 syllable: Optional[str] = None,
                 phone: Optional[str] = None):
        # check we have different separators, None excluded
        sep1 = list(sep for sep in (phone, syllable, word) if sep)
        sep2 = set(sep for sep in (phone, syllable, word) if sep)
        if len(sep1) != len(sep2):
            raise ValueError(
                'illegal separator with word="{}", syllable="{}" and '
                'phone="{}", must be all differents if not empty'
                    .format(phone, syllable, word))

        self._phone = str(phone) if phone else ''
        self._syllable = str(syllable) if syllable else ''
        self._word = str(word) if word else ''

    def __eq__(self, other: 'Separator'):
        return (
                self.phone == other.phone
                and self.syllable == other.syllable
                and self.word == other.word)

    def __str__(self):
        return (
            f'(phone: "{self.phone}", '
            f'syllable: "{self.syllable}", '
            f'word: "{self.word}")')

    @property
    def phone(self):
        """Phones separator"""
        return self._phone

    @property
    def syllable(self):
        """Syllables separator"""
        return self._syllable

    @property
    def word(self):
        """Words separator"""
        return self._word

    def __contains__(self, value: str):
        """Returns True if the separator has `value` as token separation"""
        return value in {self.phone, self.syllable, self.word}

    def input_output_separator(self, field_separator: Union[str, bool]) \
            -> Union[str, bool]:
        """Returns a suitable input/output separator based on token separator

        The input/output separator split orthographic and phonetic texts when
        using the --prepend-text option from command-line.

        Parameters
        ----------

        field_separator: bool or str
            If str, ensures it's value is not
            already defined as a token separator. If True choose one of "|",
            "||", "|||", "||||" (the first one that is not defined as a token
            separator)

        Returns
        -------
        The input/output separator, or False if ``field_separator`` is False

        Raises
        ------
        RuntimeError
            if ``field_separator`` is a str but is already registered as token separator

        """
        if not field_separator:
            return False

        if isinstance(field_separator, str):
            if field_separator in self:
                raise RuntimeError(
                    f'cannot prepend input with "{field_separator}" because '
                    f'it is already a token separator: {self}')
            return field_separator

        if field_separator is True:
            field_separator = '|'
            while field_separator in self:
                field_separator += '|'
            return field_separator

        # not a bool nor a str
        raise RuntimeError(
            'invalid input/output separator, must be bool or str but is'
            f'{field_separator}')


default_separator = Separator(phone='', syllable='', word=' ')
"""The default separation characters for phonemes, syllables and words"""
