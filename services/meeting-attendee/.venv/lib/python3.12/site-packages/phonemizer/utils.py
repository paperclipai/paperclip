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
"""Provides utility functions for the phonemizer"""

import os
from numbers import Number
from pathlib import Path
from typing import Union, List, Tuple, Iterable

import importlib


def cumsum(iterable: Iterable[Number]) -> List[Number]:
    """Returns the cumulative sum of the `iterable` as a list"""
    res = []
    cumulative = 0
    for value in iterable:
        cumulative += value
        res.append(cumulative)
    return res


def str2list(text: Union[str, List[str]]) -> List[str]:
    """Returns the string `text` as a list of lines, split by \n"""
    if isinstance(text, str):
        return text.strip(os.linesep).split(os.linesep)
    return text


def list2str(text: Union[str, List[str]]) -> str:
    """Returns the list of lines `text` as a single string separated by \n"""
    if isinstance(text, str):
        return text
    return os.linesep.join(text)


def chunks(text: Union[str, List[str]], num: int) \
        -> Tuple[List[List[str]], List[int]]:
    """Return a maximum of `num` equally sized chunks of a `text`

    This method is usefull when phonemizing a single text on multiple jobs.

    The exact number of chunks returned is `m = min(num, len(str2list(text)))`.
    Only the m-1 first chunks have equal size. The last chunk can be longer.
    The input `text` can be a list or a string. Return a list of `m` strings.

    Parameters
    ----------
    text (str or list) : The text to divide in chunks

    num (int) : The number of chunks to build, must be a strictly positive
    integer.

    Returns
    -------
    chunks (list of list of str) : The chunked text with utterances separated
        by '\n'.

    offsets (list of int) : offset used below to recover the line numbers in
        the input text wrt the chunks

    """
    text: List[str] = str2list(text)
    size = int(max(1, len(text) / num))  # noqa
    nchunks = min(num, len(text))

    text_chunks = [
        text[i * size:(i + 1) * size] for i in range(nchunks - 1)]

    last = text[(nchunks - 1) * size:]
    if last:
        text_chunks.append(last)

    offsets = [0] + cumsum((len(c) for c in text_chunks[:-1]))
    return text_chunks, offsets


def get_package_resource(path: str) -> Path:
    """Returns the absolute path to a phonemizer resource file or directory

    The packages resource are stored within the source tree in the
    'phonemizer/share' directory and, once the package is installed, are moved
    to another system directory (e.g. /share/phonemizer).

    Parameters
    ----------
    path (str) : the file or directory to get, must be relative to
        'phonemizer/share'.

    Raises
    ------
    ValueError if the required `path` is not found

    Returns
    -------
    The absolute path to the required resource as a `pathlib.Path`

    """
    try:
        # new in python-3.9
        path = importlib.resources.files('phonemizer') / 'share' / path
    except AttributeError:  # pragma: nocover
        with importlib.resources.path('phonemizer', 'share') as share:
            path = share / path

    if not path.exists():  # pragma: nocover
        raise ValueError(f'the requested resource does not exist: {path}')

    return path.resolve()


def version_as_tuple(version: str) -> Tuple[int, ...]:
    """Returns a tuple of integers from a version string

    Any '-dev' in version string is ignored. For instance, returns (1, 2, 3)
    from '1.2.3' or (0, 2) from '0.2-dev'

    """
    return tuple(int(v) for v in version.replace('-dev', '').split('.'))
