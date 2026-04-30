"""
Tokenizer of Unicode characters, grapheme clusters and tailored grapheme clusters
(of orthographies) given an orthography profile.
"""
from typing import Union, Callable, Optional, Literal, Any
import pathlib
import unicodedata
from collections.abc import Generator

import regex
from csvw.dsv import reader

from segments.util import nfd, grapheme_pattern
from segments import errors as err
from segments.profile import Profile

PathType = Union[pathlib.Path, str]


def iterlines(p: PathType) -> Generator[str, None, None]:
    """Yield lines from a file suitable for feeding into dsv.reader."""
    with pathlib.Path(p).open(encoding='utf-8') as fp:
        for line in fp.readlines():
            line = line.strip()
            if line and not line.startswith('#'):
                yield unicodedata.normalize('NFD', line)


class Rules:
    """
    Rules are given in tuple format, comma delimited.
    Regular expressions are given in Python syntax.

    >>> r = Rules(('a+', 'a'))
    >>> r.apply('aaabaaa')
    'aba'
    """
    def __init__(self, *rules: tuple[str, str]):
        self._rules = [(regex.compile(rule), replacement) for rule, replacement in rules]

    @classmethod
    def from_file(cls, fname: PathType) -> 'Rules':
        """Read rules from a file."""
        return cls(*list(reader(list(iterlines(fname)))))

    def apply(self, s: str) -> str:
        """Apply rules to string."""
        for rule, replacement in self._rules:
            s = rule.sub(replacement, s)
        return s


class Tokenizer:
    """
    Class for Unicode character and grapheme tokenization.

    This class provides extended functionality for
    orthography-specific tokenization with orthography profiles.

    Parameters
    ----------

    profile : string or pathlib.Path or Profile instance (default = None)
        Specifies an orthography profile to use.

    rules : string (default = None)
        Filename of a rules file.

    Notes
    -----
    The tokenizer can be used for pure Unicode character and grapheme
    tokenization, i.e. it uses the Unicode standard grapheme parsing rules, as
    implemented in the Python regex package by Matthew Barnett, to do basic tokenization
    with the "\\X" grapheme regular expression match. This grapheme match
    combines one or more Combining Diacritical Marks to their base character.
    These are called "grapheme clusters" in Unicode parlance. With these functions
    the Tokenizer is meant to do basic rudimentary parsing for things like generating
    unigram models (segments and their counts) from input data.

    When a profile is passed, the Tokenizer reads the orthography profile and calls a helper
    class to build a tree data structure, which stores the possible Unicode
    character combinations that are specified in the orthography profile
    (i.e. tailored grapheme clusters) that appear in the data source.

    For example, an orthography profile might specify that in source X
    <uu> is a single grapheme (Unicode parlance: tailored grapheme) and
    therefore it should be chunked as so. Given an orthography profile and
    some data to tokenize, the process would look like this:

    input string example: uubo uubo
    output string example: uu b o # uu b o

    >>> prf = Profile({'Grapheme': 'uu'}, {'Grapheme': 'b'}, {'Grapheme': 'o'})
    >>> t = Tokenizer(profile=prf)
    >>> t('uubo uubo')
    'uu b o # uu b o'

    See also the test orthography profile and rules in the test directory.

    An additional method "combine_modifiers" handles the case where there are
    Unicode Spacing Modifier Letters, which are not explicitly
    combined to their base character in the Unicode Standard. These graphemes
    are called "Tailored grapheme clusters" in Unicode. For more information
    see the Unicode Standard Annex #29: Unicode Text Segmentation:

    * http://www.unicode.org/reports/tr29/

    Additionally, the Tokenizer provides functionality to transform graphemes
    into associated character(s) specified in additional columns in the orthography
    profile. A dictionary is created that keeps a mapping between source-specific
    graphemes and their counterparts (e.g. an IPA column in the orthography profile).

    Lastly, the Tokenizer can be used to transform text as specified in an
    orthography rules file. These transformations are specified in a separate
    file from the orthography profile (that specifics the document specific graphemes,
    and possibly their IPA counterparts) and the orthography rules should
    be applied to the output of a grapheme tokenization.

    In an orthography rules file, rules are given in order as regular
    expressions, e.g. this rule replaces a vowel followed by an <n>
    followed by <space> followed by a second vowel with first vowel
    <space> <n> <space> second vowel, e.g.::

        $ (a|á|e|é|i|í|o|ó|u|ú)(n)(\\s)(a|á|e|é|i|í|o|ó|u|ú), \\1 \\2 \\4

    """
    def __init__(self,  # pylint: disable=R0913,R0917
                 profile: Optional[Union[PathType, Profile]] = None,
                 rules: Optional[PathType] = None,
                 errors_strict: Callable[[str], Optional[str]] = err.strict,
                 errors_replace: Callable[[str], Optional[str]] = err.replace,
                 errors_ignore: Callable[[str], Optional[str]] = err.ignore):
        self.op = None
        if isinstance(profile, Profile):
            self.op = profile
        elif profile is not None:
            self.op = Profile.from_file(profile)
        if not rules and self.op and self.op.fname:
            _rules = self.op.fname.parent / (self.op.fname.stem + '.rules')
            if _rules.exists():
                rules = _rules
        self._rules = Rules.from_file(rules) if rules else None
        self._errors = {
            'strict': errors_strict,
            'replace': errors_replace,
            'ignore': errors_ignore,
        }

    def __call__(self,  # pylint: disable=R0913,R0917
                 string: str,
                 column: str = Profile.GRAPHEME_COL,
                 form: Optional[Literal['NFC', 'NFKC', 'NFD', 'NFKD']] = None,
                 ipa: bool = False,
                 segment_separator: str = ' ',
                 separator: str = ' # ',
                 errors: Literal['replace', 'strict', 'ignore'] = 'replace') -> str:
        """
        The main task of a Tokenizer is tokenizing! This is what happens when called.

        This function determines what to do given any combination
        of orthography profile and rules or not orthography profile
        or rules.

        Parameters
        ----------
        string : str
            The input string to be tokenized.

        column : str (default = "graphemes")
            The column label for the transformation, if specified.

        form : None or unicode normalization form
            Normalize return value if form is not None.

        ipa : bool
            Tokenize IPA (work in progress)

        Returns
        -------
        result : str
            Result of the tokenization.

        """
        res = []
        for word in string.split():
            if ipa:
                res.append(self.combine_modifiers(self.grapheme_clusters(nfd(word))))
            else:
                if self.op:
                    res.append(
                        self.transform(word, column=column, error=self._errors[errors]))
                else:
                    res.append(self.grapheme_clusters(nfd(word)))

        def pp(word):
            res = segment_separator.join(word).strip()
            res = self._rules.apply(res) if self._rules else res
            return unicodedata.normalize(form, res) if form else res

        return separator.join(pp(word) for word in res)

    def characters(self, string: str, segment_separator: str = ' ', separator: str = ' # ',) -> str:
        """
        Given a string as input, return a space-delimited string of Unicode characters
        (code points rendered as glyphs).
        Parameters
        ----------
        string : str
            A Unicode string to be tokenized into graphemes.
        Returns
        -------
        result : str
            String returned is space-delimited on Unicode characters and contains "#" to
            mark word boundaries.
            The string is in NFD.
        Notes
        -----
        Input is first normalized according to Normalization Ford D(ecomposition).
        String returned contains "#" to mark word boundaries.
        """
        return separator.join(segment_separator.join(word) for word in nfd(string).split())

    def grapheme_clusters(self, word: str) -> list[Any]:
        """
        See: Unicode Standard Annex #29: UNICODE TEXT SEGMENTATION
        http://www.unicode.org/reports/tr29/

        Given a string as input, return a list of Unicode graphemes using the
        "\\X" regular expression.

        Parameters
        ----------
        word : str
            A Unicode string to be tokenized into graphemes.

        Returns
        -------
        result : list
            List of Unicode graphemes in NFD.

        """
        # init the regex Unicode grapheme cluster match
        return grapheme_pattern.findall(word)

    def transform(
            self,
            word: str,
            column: str = Profile.GRAPHEME_COL,
            error=err.replace,
    ) -> list[str]:
        """
        Transform a string's graphemes into the mappings given in a different column
        in the orthography profile.

        Parameters
        ----------
        word : str
            The input string to be tokenized.

        column : str (default = "Grapheme")
            The label of the column to transform to. Default it to tokenize with
            orthography profile.

        Returns
        -------
        result : list of lists
            Result of the transformation.

        """
        assert self.op, 'method can only be called with orthography profile.'

        if column != Profile.GRAPHEME_COL and column not in self.op.column_labels:
            raise ValueError(f"Column {column} not found in profile.")

        word = self.op.tree.parse(word, error)
        if column == Profile.GRAPHEME_COL:
            return word
        out = []
        for token in word:
            try:
                target = self.op.graphemes[token][column]
            except KeyError:
                target = self._errors['replace'](token)
            if target is not None:
                if isinstance(target, (tuple, list)):
                    out.extend(target)
                else:
                    out.append(target)
        return out

    def rules(self, word: str) -> str:
        """
        Function to tokenize input string and return output of str with ortho rules
        applied.

        Parameters
        ----------
        word : str
            The input string to be tokenized.

        Returns
        -------
        result : str
            Result of the orthography rules applied to the input str.

        """
        return self._rules.apply(word) if self._rules else word

    def combine_modifiers(self, graphemes: list[str]) -> list[str]:
        """
        Given a string that is space-delimited on Unicode grapheme clusters,
        group Unicode modifier letters with their preceding base characters,
        deal with tie bars, etc.

        Parameters
        ----------
        string : str
            A Unicode string tokenized into grapheme clusters to be tokenized into simple
            IPA.

        """
        result = []
        temp = ""
        count = len(graphemes)
        for grapheme in reversed(graphemes):
            count -= 1
            if len(grapheme) == 1 and unicodedata.category(grapheme) == "Lm" \
                    and not ord(grapheme) in [712, 716] and len(graphemes) > 1:
                temp = grapheme + temp
                # hack for the cases where a space modifier is the first character in the
                # string
                if count == 0:
                    result[-1] = temp + result[-1]
                continue  # pragma: no cover

            # catch and repair stress marks
            if len(grapheme) == 1 and (ord(grapheme) in [712, 716]) and result:
                # If result == [], there's nothing to combine with ...
                result[-1] = grapheme + result[-1]
                temp = ""
                continue

            # combine contour tone marks (non-accents)
            if len(grapheme) == 1 and unicodedata.category(grapheme) == "Sk":
                if len(result) == 0:
                    result.append(grapheme)
                    temp = ""
                    continue
                if unicodedata.category(result[-1][0]) == "Sk":
                    result[-1] = grapheme + temp + result[-1]
                    temp = ""
                    continue

            result.append(grapheme + temp)
            temp = ""

        # last check for tie bars
        segments = result[::-1]
        i = 0
        r = []
        while i < len(segments):
            # tie bars
            if ord(segments[i][-1]) in [865, 860]:
                r.append(segments[i] + segments[i + 1])
                i += 2
            else:
                r.append(segments[i])
                i += 1
        return r
