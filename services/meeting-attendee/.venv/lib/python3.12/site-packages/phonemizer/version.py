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
"""Phonemizer version description"""

import importlib

from phonemizer.backend import (
    EspeakBackend, EspeakMbrolaBackend, FestivalBackend, SegmentsBackend)


def _version_as_str(vers):
    """From (1, 49, 3) to '1.49.3'"""
    return '.'.join(str(v) for v in vers)


def version():
    """Return version information for front and backends"""
    # version of the phonemizer
    _version = 'phonemizer-' + importlib.metadata.version('phonemizer')

    # for each backend, check if it is available or not. If so get its version
    available = []
    unavailable = []

    if EspeakBackend.is_available():
        available.append(
            'espeak-' + ('ng-' if EspeakBackend.is_espeak_ng() else '')
            + _version_as_str(EspeakBackend.version()))
    else:  # pragma: nocover
        unavailable.append('espeak')

    if EspeakMbrolaBackend.is_available():
        available.append('espeak-mbrola')
    else:  # pragma: nocover
        unavailable.append('espeak-mbrola')

    if FestivalBackend.is_available():
        available.append(
            'festival-' + _version_as_str(FestivalBackend.version()))
    else:  # pragma: nocover
        unavailable.append('festival')

    if SegmentsBackend.is_available():
        available.append(
            'segments-' + _version_as_str(SegmentsBackend.version()))
    else:  # pragma: nocover
        unavailable.append('segments')

    # resumes the backends status in the final version string
    if available:
        _version += '\navailable backends: ' + ', '.join(available)
    if unavailable:  # pragma: nocover
        _version += '\nuninstalled backends: ' + ', '.join(unavailable)

    return _version
