# Copyright 2015-2021 Mathieu Bernard
#
# This file is part of phonologizer: you can redistribute it and/or
# modify it under the terms of the GNU General Public License as
# published by the Free Software Foundation, either version 3 of the
# License, or (at your option) any later version.
#
# Phonologizer is distributed in the hope that it will be useful, but
# WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
# General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with phonologizer. If not, see <http://www.gnu.org/licenses/>.
"""Multilingual text to phonemes converter"""

# pylint: disable=unused-import

from .espeak.espeak import EspeakBackend
from .espeak.mbrola import EspeakMbrolaBackend
from .festival.festival import FestivalBackend
from .segments import SegmentsBackend


BACKENDS = {b.name(): b for b in (
    EspeakBackend, FestivalBackend, SegmentsBackend, EspeakMbrolaBackend)}
"""The different phonemization backends as a mapping (name, class)"""
