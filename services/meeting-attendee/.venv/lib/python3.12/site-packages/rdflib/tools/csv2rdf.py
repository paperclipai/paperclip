"""
A commandline tool for semi-automatically converting CSV to RDF.

See also https://github.com/RDFLib/pyTARQL in the RDFlib family of tools

try: `csv2rdf --help`
"""

from __future__ import annotations

import codecs
import configparser
import csv
import datetime
import fileinput
import getopt
import re
import sys
import time
import warnings
from typing import Any, Dict, List, Optional, Tuple, Union
from urllib.parse import quote

import rdflib
from rdflib.namespace import RDF, RDFS, split_uri
from rdflib.term import URIRef

__all__ = ["CSV2RDF"]

HELP = """
csv2rdf.py \
    -b <instance-base> \
    -p <property-base> \
    [-D <default>] \
    [-c <classname>] \
    [-i <identity column(s)>] \
    [-l <label columns>] \
    [-s <N>] [-o <output>] \
    [-f configfile] \
    [--col<N> <colspec>] \
    [--prop<N> <property>] \
    <[-d <delim>] \
    [-C] [files...]"

Reads csv files from stdin or given files
if -d is given, use this delimiter
if -s is given, skips N lines at the start
Creates a URI from the columns given to -i, or automatically by numbering if
none is given
Outputs RDFS labels from the columns given to -l
if -c is given adds a type triple with the given classname
if -C is given, the class is defined as rdfs:Class
Outputs one RDF triple per column in each row.
Output is in n3 format.
Output is stdout, unless -o is specified

Long options also supported: \
    --base, \
    --propbase, \
    --ident, \
    --class, \
    --label, \
    --out, \
    --defineclass

Long options --col0, --col1, ...
can be used to specify conversion for columns.
Conversions can be:
    ignore, float(), int(), split(sep, [more]), uri(base, [class]), date(format)

Long options --prop0, --prop1, ...
can be used to use specific properties, rather than ones auto-generated
from the headers

-D sets the default conversion for columns not listed

-f says to read config from a .ini/config file - the file must contain one
section called csv2rdf, with keys like the long options, i.e.:

[csv2rdf]
out=output.n3
base=http://example.org/
col0=split(";")
col1=split(";", uri("http://example.org/things/",
                    "http://xmlns.com/foaf/0.1/Person"))
col2=float()
col3=int()
col4=date("%Y-%b-%d %H:%M:%S")

"""

# bah - ugly global
uris: Dict[Any, Tuple[URIRef, Optional[URIRef]]] = {}


def toProperty(label: str):  # noqa: N802
    """
    CamelCase + lowercase initial a string


    FIRST_NM => firstNm

    firstNm => firstNm

    """
    label = re.sub(r"[^\w]", " ", label)
    label = re.sub("([a-z])([A-Z])", "\\1 \\2", label)
    # type error: Incompatible types in assignment (expression has type "None", variable has type "BinaryIO")
    label = label.split(" ")  # type: ignore[assignment]
    return "".join([label[0].lower()] + [x.capitalize() for x in label[1:]])


def toPropertyLabel(label):  # noqa: N802
    if not label[1:2].isupper():
        return label[0:1].lower() + label[1:]
    return label


def index(l_: List[int], i: Tuple[int, ...]) -> Tuple[int, ...]:
    """return a set of indexes from a list
    >>> index([1,2,3],(0,2))
    (1, 3)
    """
    return tuple([l_[x] for x in i])


def csv_reader(csv_data, dialect=csv.excel, **kwargs):
    csv_reader = csv.reader(csv_data, dialect=dialect, **kwargs)
    for row in csv_reader:
        yield row


def prefixuri(x, prefix, class_: Optional[URIRef] = None):
    if prefix:
        r = rdflib.URIRef(prefix + quote(x.encode("utf8").replace(" ", "_"), safe=""))
    else:
        r = rdflib.URIRef(x)
    uris[x] = (r, class_)
    return r


# meta-language for config


class NodeMaker:
    def range(self):
        return rdflib.RDFS.Literal

    def __call__(self, x: Any):
        return rdflib.Literal(x)


class NodeUri(NodeMaker):
    def __init__(self, prefix, class_):
        self.class_: Optional[URIRef] = None
        self.prefix = prefix
        if class_:
            self.class_ = rdflib.URIRef(class_)
        else:
            self.class_ = None

    def __call__(self, x):
        return prefixuri(x, self.prefix, self.class_)

    def range(self):
        return self.class_ or rdflib.RDF.Resource


class NodeLiteral(NodeMaker):
    def __init__(self, f=None):
        self.f = f


class NodeFloat(NodeLiteral):
    def __call__(self, x):
        if not self.f:
            return rdflib.Literal(float(x))
        if callable(self.f):
            return rdflib.Literal(float(self.f(x)))
        raise Exception("Function passed to float is not callable")

    def range(self):
        return rdflib.XSD.double


class NodeInt(NodeLiteral):
    def __call__(self, x):
        if not self.f:
            return rdflib.Literal(int(x))
        if callable(self.f):
            return rdflib.Literal(int(self.f(x)))
        raise Exception("Function passed to int is not callable")

    def range(self):
        return rdflib.XSD.int


class NodeBool(NodeLiteral):
    def __call__(self, x):
        if not self.f:
            return rdflib.Literal(bool(x))
        if callable(self.f):
            return rdflib.Literal(bool(self.f(x)))
        raise Exception("Function passed to bool is not callable")

    def range(self):
        return rdflib.XSD.bool


class NodeReplace(NodeMaker):
    def __init__(self, a, b):
        self.a = a
        self.b = b

    def __call__(self, x):
        return x.replace(self.a, self.b)


class NodeDate(NodeLiteral):
    def __call__(self, x):
        return rdflib.Literal(datetime.datetime.strptime(x, self.f))

    def range(self):
        return rdflib.XSD.dateTime


class NodeSplit(NodeMaker):
    def __init__(self, sep, f):
        self.sep = sep
        self.f = f

    def __call__(self, x):
        if not self.f:
            self.f = rdflib.Literal
        if not callable(self.f):
            raise Exception("Function passed to split is not callable!")
        return [self.f(y.strip()) for y in x.split(self.sep) if y.strip() != ""]

    def range(self):
        if self.f and isinstance(self.f, NodeMaker):
            return self.f.range()
        return NodeMaker.range(self)


default_node_make = NodeMaker()


def _config_ignore(*args, **kwargs):
    return "ignore"


def _config_uri(prefix=None, class_=None):
    return NodeUri(prefix, class_)


def _config_literal():
    return NodeLiteral()


def _config_float(f=None):
    return NodeFloat(f)


def _config_replace(a, b):
    return NodeReplace(a, b)


def _config_int(f=None):
    return NodeInt(f)


def _config_bool(f=None):
    return NodeBool(f)


def _config_date(format_):
    return NodeDate(format_)


def _config_split(sep=None, f=None):
    return NodeSplit(sep, f)


config_functions = {
    "ignore": _config_ignore,
    "uri": _config_uri,
    "literal": _config_literal,
    "float": _config_float,
    "int": _config_int,
    "date": _config_date,
    "split": _config_split,
    "replace": _config_replace,
    "bool": _config_bool,
}


def column(v):
    """Return a function for column mapping"""

    return eval(v, config_functions)


class CSV2RDF:
    def __init__(self):
        self.CLASS = None
        self.BASE = None
        self.PROPBASE = None
        self.IDENT: Union[Tuple[str, ...], str] = "auto"
        self.LABEL = None
        self.DEFINECLASS = False
        self.SKIP = 0
        self.DELIM = ","
        self.DEFAULT = None

        self.COLUMNS = {}
        self.PROPS = {}

        self.OUT = sys.stdout

        self.triples = 0

    def triple(self, s, p, o):
        self.OUT.write("%s %s %s .\n" % (s.n3(), p.n3(), o.n3()))
        self.triples += 1

    def convert(self, csvreader):
        start = time.time()

        if self.OUT:
            sys.stderr.write("Output to %s\n" % self.OUT.name)

        if self.IDENT != "auto" and not isinstance(self.IDENT, tuple):
            self.IDENT = (self.IDENT,)

        if not self.BASE:
            warnings.warn("No base given, using http://example.org/instances/")
            self.BASE = rdflib.Namespace("http://example.org/instances/")

        if not self.PROPBASE:
            warnings.warn("No property base given, using http://example.org/property/")
            self.PROPBASE = rdflib.Namespace("http://example.org/props/")

        # skip lines at the start
        for x in range(self.SKIP):
            next(csvreader)

        # read header line
        header_labels = list(next(csvreader))
        headers = dict(enumerate([self.PROPBASE[toProperty(x)] for x in header_labels]))
        # override header properties if some are given
        for k, v in self.PROPS.items():
            headers[k] = v
            header_labels[k] = split_uri(v)[1]

        if self.DEFINECLASS:
            # output class/property definitions
            self.triple(self.CLASS, RDF.type, RDFS.Class)
            for i in range(len(headers)):
                h, l_ = headers[i], header_labels[i]
                if h == "" or l_ == "":
                    continue
                if self.COLUMNS.get(i, self.DEFAULT) == "ignore":
                    continue
                self.triple(h, RDF.type, RDF.Property)
                self.triple(h, RDFS.label, rdflib.Literal(toPropertyLabel(l_)))
                self.triple(h, RDFS.domain, self.CLASS)
                self.triple(
                    h, RDFS.range, self.COLUMNS.get(i, default_node_make).range()
                )

        rows = 0
        for l_ in csvreader:
            try:
                if self.IDENT == "auto":
                    uri = self.BASE["%d" % rows]
                else:
                    uri = self.BASE[
                        "_".join(
                            [
                                # type error: "int" has no attribute "encode"
                                quote(x.encode("utf8").replace(" ", "_"), safe="")  # type: ignore[attr-defined]
                                # type error: Argument 2 to "index" has incompatible type "Union[Tuple[str, ...], str]"; expected "Tuple[int, ...]"
                                for x in index(l_, self.IDENT)  # type: ignore[arg-type]
                            ]
                        )
                    ]

                if self.LABEL:
                    self.triple(
                        # type error: Argument 1 to "join" of "str" has incompatible type "Tuple[int, ...]"; expected "Iterable[str]"
                        uri,
                        RDFS.label,
                        rdflib.Literal(" ".join(index(l_, self.LABEL))),  # type: ignore[arg-type]
                    )

                if self.CLASS:
                    # type triple
                    self.triple(uri, RDF.type, self.CLASS)

                for i, x in enumerate(l_):
                    # type error: "int" has no attribute "strip"
                    x = x.strip()  # type: ignore[attr-defined]
                    if x != "":
                        if self.COLUMNS.get(i, self.DEFAULT) == "ignore":
                            continue
                        try:
                            o = self.COLUMNS.get(i, rdflib.Literal)(x)
                            if isinstance(o, list):
                                for _o in o:
                                    self.triple(uri, headers[i], _o)
                            else:
                                self.triple(uri, headers[i], o)

                        except Exception as e:
                            warnings.warn(
                                "Could not process value for column "
                                + "%d:%s in row %d, ignoring: %s "
                                # type error: "Exception" has no attribute "message"
                                % (i, headers[i], rows, e.message)  # type: ignore[attr-defined]
                            )

                rows += 1
                if rows % 100000 == 0:
                    sys.stderr.write(
                        "%d rows, %d triples, elapsed %.2fs.\n"
                        % (rows, self.triples, time.time() - start)
                    )
            except Exception:
                sys.stderr.write("Error processing line: %d\n" % rows)
                raise

        # output types/labels for generated URIs
        classes = set()
        # type error: Incompatible types in assignment (expression has type "Tuple[URIRef, Optional[URIRef]]", variable has type "int")
        for l_, x in uris.items():  # type: ignore[assignment]
            # type error: "int" object is not iterable
            u, c = x  # type: ignore[misc]
            # type error: Cannot determine type of "u"
            self.triple(u, RDFS.label, rdflib.Literal(l_))  # type: ignore[has-type]
            # type error: Cannot determine type of "c"
            if c:  # type: ignore[has-type]
                # type error: Cannot determine type of "c"
                c = rdflib.URIRef(c)  # type: ignore[has-type]
                classes.add(c)
                # type error: Cannot determine type of "u"
                self.triple(u, RDF.type, c)  # type: ignore[has-type]

        for c in classes:
            self.triple(c, RDF.type, RDFS.Class)

        self.OUT.close()
        sys.stderr.write("Converted %d rows into %d triples.\n" % (rows, self.triples))
        sys.stderr.write("Took %.2f seconds.\n" % (time.time() - start))


def main():
    csv2rdf = CSV2RDF()

    opts: Union[Dict[str, str], List[Tuple[str, str]]]
    opts, files = getopt.getopt(
        sys.argv[1:],
        "hc:b:p:i:o:Cf:l:s:d:D:",
        [
            "out=",
            "base=",
            "delim=",
            "propbase=",
            "class=",
            "default=" "ident=",
            "label=",
            "skip=",
            "defineclass",
            "help",
        ],
    )
    opts = dict(opts)

    if "-h" in opts or "--help" in opts:
        print(HELP)
        sys.exit(-1)

    if "-f" in opts:
        config = configparser.ConfigParser()
        config.read_file(open(opts["-f"]))
        for k, v in config.items("csv2rdf"):
            if k == "out":
                csv2rdf.OUT = codecs.open(v, "w", "utf-8")
            elif k == "base":
                csv2rdf.BASE = rdflib.Namespace(v)
            elif k == "propbase":
                csv2rdf.PROPBASE = rdflib.Namespace(v)
            elif k == "class":
                csv2rdf.CLASS = rdflib.URIRef(v)
            elif k == "defineclass":
                csv2rdf.DEFINECLASS = bool(v)
            elif k == "ident":
                csv2rdf.IDENT = eval(v)
            elif k == "label":
                csv2rdf.LABEL = eval(v)
            elif k == "delim":
                csv2rdf.DELIM = v
            elif k == "skip":
                csv2rdf.SKIP = int(v)
            elif k == "default":
                csv2rdf.DEFAULT = column(v)
            elif k.startswith("col"):
                csv2rdf.COLUMNS[int(k[3:])] = column(v)
            elif k.startswith("prop"):
                csv2rdf.PROPS[int(k[4:])] = rdflib.URIRef(v)

    if "-o" in opts:
        csv2rdf.OUT = codecs.open(opts["-o"], "w", "utf-8")
    if "--out" in opts:
        csv2rdf.OUT = codecs.open(opts["--out"], "w", "utf-8")

    if "-b" in opts:
        csv2rdf.BASE = rdflib.Namespace(opts["-b"])
    if "--base" in opts:
        csv2rdf.BASE = rdflib.Namespace(opts["--base"])

    if "-d" in opts:
        csv2rdf.DELIM = opts["-d"]
    if "--delim" in opts:
        csv2rdf.DELIM = opts["--delim"]

    if "-D" in opts:
        csv2rdf.DEFAULT = column(opts["-D"])
    if "--default" in opts:
        csv2rdf.DEFAULT = column(opts["--default"])

    if "-p" in opts:
        csv2rdf.PROPBASE = rdflib.Namespace(opts["-p"])
    if "--propbase" in opts:
        csv2rdf.PROPBASE = rdflib.Namespace(opts["--propbase"])

    if "-l" in opts:
        csv2rdf.LABEL = eval(opts["-l"])
    if "--label" in opts:
        csv2rdf.LABEL = eval(opts["--label"])

    if "-i" in opts:
        csv2rdf.IDENT = eval(opts["-i"])
    if "--ident" in opts:
        csv2rdf.IDENT = eval(opts["--ident"])

    if "-s" in opts:
        csv2rdf.SKIP = int(opts["-s"])
    if "--skip" in opts:
        csv2rdf.SKIP = int(opts["--skip"])

    if "-c" in opts:
        csv2rdf.CLASS = rdflib.URIRef(opts["-c"])
    if "--class" in opts:
        csv2rdf.CLASS = rdflib.URIRef(opts["--class"])

    for k, v in opts.items():
        if k.startswith("--col"):
            csv2rdf.COLUMNS[int(k[5:])] = column(v)
        elif k.startswith("--prop"):
            csv2rdf.PROPS[int(k[6:])] = rdflib.URIRef(v)

    if csv2rdf.CLASS and ("-C" in opts or "--defineclass" in opts):
        csv2rdf.DEFINECLASS = True

    csv2rdf.convert(csv_reader(fileinput.input(files), delimiter=csv2rdf.DELIM))


if __name__ == "__main__":
    main()
