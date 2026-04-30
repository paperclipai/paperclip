"""
Orthography profiles.
"""
import copy
from typing import Union, Optional, Any
import logging
import pathlib
import warnings
import collections
from collections.abc import Generator
import unicodedata
import json.decoder

from csvw import TableGroup, Column

from segments.tree import Tree
from segments.util import grapheme_pattern

PathType = Union[str, pathlib.Path]


class Profile:
    """
    An Orthography Profile as specified by Moran and Cysouw 2018.
    """
    GRAPHEME_COL = 'Grapheme'
    NULL = "NULL"
    MD = {
        "tables": [
            {
                "dialect": {
                    "delimiter": "\t",
                    "header": True,
                    "encoding": "utf-8"
                },
                "tableSchema": {
                    "columns": [
                        {
                            "name": GRAPHEME_COL,
                            "datatype": "string",
                            "required": True
                        }
                    ],
                    "primaryKey": GRAPHEME_COL
                }
            }
        ]
    }

    @classmethod
    def default_metadata(cls, fname: Optional[PathType] = None) -> dict[str, Any]:
        """The default CSVW metadata to interpret a tab-separated values file as a Profile."""
        md = copy.copy(cls.MD)
        md['tables'][0]['url'] = str(fname or '')
        return md

    def __init__(self, *specs: dict, **kw):
        """

        Parameters
        ----------
        specs : list of dict
            A list of grapheme specifications.
        kw :
            The following keyword arguments are recognized:
            - fname: Path of the profile or profile metadata.
            - form: Unicode normalization to apply to the data in the profile before use.
            - remaining keyword arguments are assigned as dict to `Profile.metadata`.
        """
        self.graphemes = collections.OrderedDict()
        self.column_labels = set()
        self.fname = kw.pop('fname', None)
        self.form = kw.pop('form', None)
        self.metadata = kw

        log = logging.getLogger(__name__)
        for i, spec in enumerate(specs):
            if self.GRAPHEME_COL not in spec:
                raise ValueError('invalid grapheme specification')

            if self.form:
                spec = {
                    unicodedata.normalize(self.form, k):
                        None if v is None else unicodedata.normalize(self.form, v)
                    for k, v in spec.items()}

            grapheme = spec.pop(self.GRAPHEME_COL)
            if not grapheme:
                raise ValueError('Grapheme must not be empty')

            self.column_labels = self.column_labels.union(spec.keys())

            # check for duplicates in the orthography profile (fail if dups)
            if grapheme not in self.graphemes:
                self.graphemes[grapheme] = spec
            else:
                log.warning('line %s:duplicate grapheme in profile: %s', i + 2, grapheme)
        self.tree = Tree(list(self.graphemes.keys()))

    def iteritems(self) -> Generator[dict[str, Any], None, None]:
        """Yield grapheme specs from the Profile."""
        for grapheme, spec in self.graphemes.items():
            res = {self.GRAPHEME_COL: grapheme}
            res.update({k: None for k in self.column_labels})
            res.update(spec.items())
            yield res

    @classmethod
    def from_file(cls, fname: PathType, form: Optional[str] = None) -> 'Profile':
        """
        Read an orthography profile from a metadata file or a default tab-separated profile file.
        """
        try:
            tg = TableGroup.from_file(fname)
            opfname = None
        except json.decoder.JSONDecodeError:
            tg = TableGroup.fromvalue(cls.default_metadata(fname))
            opfname = fname
        if len(tg.tables) != 1:  # pragma: no cover
            raise ValueError('profile description must contain exactly one table')
        metadata = tg.common_props
        metadata.update(fname=pathlib.Path(fname), form=form)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            res = cls(
                *[{k: None if (k != cls.GRAPHEME_COL and v == cls.NULL) else v
                   for k, v in d.items()}
                  for d in tg.tables[0].iterdicts(fname=opfname)],
                **metadata)
        return res

    @classmethod
    def from_text(cls, text: str, mapping: str = 'mapping') -> 'Profile':
        """
        Create a Profile instance from the Unicode graphemes found in `text`.

        Parameters
        ----------
        text
        mapping

        Returns
        -------
        A Profile instance.

        """
        graphemes = collections.Counter(grapheme_pattern.findall(text))
        specs = [
            collections.OrderedDict([
                (cls.GRAPHEME_COL, grapheme),
                ('frequency', frequency),
                (mapping, grapheme)])
            for grapheme, frequency in graphemes.most_common()]
        return cls(*specs)

    @classmethod
    def from_textfile(cls, fname: PathType, mapping: str = 'mapping') -> 'Profile':
        """Initialize a Profile from the graphemes found in a text file."""
        with pathlib.Path(fname).open(encoding='utf-8') as fp:
            lines = fp.readlines()
            return cls.from_text(' '.join(lines), mapping=mapping)

    def __str__(self):
        """
        A Profile is represented as tab-separated lines of grapheme specifications.
        """
        tg = TableGroup.fromvalue(self.default_metadata())
        for col in self.column_labels:
            if col != self.GRAPHEME_COL:
                tg.tables[0].tableSchema.columns.append(
                    Column.fromvalue({"name": col, "null": self.NULL}))

        return tg.tables[0].write(self.iteritems(), fname=None).decode('utf8').strip()
