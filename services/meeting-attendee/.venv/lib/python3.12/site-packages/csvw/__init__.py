# csvw - https://w3c.github.io/csvw/primer/

from .metadata import (
    TableGroup, Table, Column, ForeignKey, Link, NaturalLanguage, Datatype, URITemplate, CSVW,
    Dialect)

from .dsv import (UnicodeWriter,
    UnicodeReader, UnicodeReaderWithLineNumber, UnicodeDictReader, NamedTupleReader,
    iterrows, rewrite)

__all__ = [
    'TableGroup',
    'Table', 'Column', 'ForeignKey',
    'Link', 'NaturalLanguage',
    'Datatype',
    'URITemplate',
    'Dialect', 'UnicodeWriter',
    'UnicodeReader', 'UnicodeReaderWithLineNumber', 'UnicodeDictReader', 'NamedTupleReader',
    'iterrows', 'rewrite',
    'CSVW',
]

__title__ = 'csvw'
__version__ = '3.7.0'
__author__ = 'Robert Forkel'
__license__ = 'Apache 2.0, see LICENSE'
__copyright__ = 'Copyright (c) 2025 Robert Forkel'
