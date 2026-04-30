#!/usr/bin/env python

"""
A commandline tool for parsing RDF in different formats and serializing the
resulting graph to a chosen format.
"""
from __future__ import annotations

import logging
import sys
from optparse import OptionParser
from typing import BinaryIO, Optional

import rdflib
from rdflib import plugin
from rdflib.graph import ConjunctiveGraph
from rdflib.parser import Parser
from rdflib.serializer import Serializer
from rdflib.store import Store
from rdflib.util import guess_format

DEFAULT_INPUT_FORMAT = "xml"
DEFAULT_OUTPUT_FORMAT = "n3"


def parse_and_serialize(
    input_files,
    input_format,
    guess,
    outfile,
    output_format,
    ns_bindings,
    store_conn="",
    store_type=None,
):
    if store_type:
        store = plugin.get(store_type, Store)()
        store.open(store_conn)
        graph = ConjunctiveGraph(store)
    else:
        store = None
        graph = ConjunctiveGraph()

    for prefix, uri in ns_bindings.items():
        graph.namespace_manager.bind(prefix, uri, override=False)

    for fpath in input_files:
        use_format, kws = _format_and_kws(input_format)
        if fpath == "-":
            fpath = sys.stdin
        elif not input_format and guess:
            use_format = guess_format(fpath) or DEFAULT_INPUT_FORMAT
        graph.parse(fpath, format=use_format, **kws)

    if outfile:
        output_format, kws = _format_and_kws(output_format)
        kws.setdefault("base", None)
        graph.serialize(destination=outfile, format=output_format, **kws)

    if store:
        store.rollback()


def _format_and_kws(fmt):
    """
    ```python
    >>> _format_and_kws("fmt")
    ('fmt', {})
    >>> _format_and_kws("fmt:+a")
    ('fmt', {'a': True})
    >>> _format_and_kws("fmt:a")
    ('fmt', {'a': True})
    >>> _format_and_kws("fmt:+a,-b") #doctest: +SKIP
    ('fmt', {'a': True, 'b': False})
    >>> _format_and_kws("fmt:c=d")
    ('fmt', {'c': 'd'})
    >>> _format_and_kws("fmt:a=b:c")
    ('fmt', {'a': 'b:c'})

    ```
    """
    fmt, kws = fmt, {}
    if fmt and ":" in fmt:
        fmt, kwrepr = fmt.split(":", 1)
        for kw in kwrepr.split(","):
            if "=" in kw:
                k, v = kw.split("=")
                kws[k] = v
            elif kw.startswith("-"):
                kws[kw[1:]] = False
            elif kw.startswith("+"):
                kws[kw[1:]] = True
            else:  # same as "+"
                kws[kw] = True
    return fmt, kws


def make_option_parser():
    parser_names = _get_plugin_names(Parser)
    serializer_names = _get_plugin_names(Serializer)
    kw_example = "FORMAT:(+)KW1,-KW2,KW3=VALUE"

    oparser = OptionParser(
        "%prog [-h] [-i INPUT_FORMAT] [-o OUTPUT_FORMAT] "
        + "[--ns=PFX=NS ...] [-] [FILE ...]",
        description=__doc__.strip()
        + (
            " Reads file system paths, URLs or from stdin if '-' is given."
            " The result is serialized to stdout."
        ),
        version="%prog " + "(using rdflib %s)" % rdflib.__version__,
    )

    oparser.add_option(
        "-i",
        "--input-format",
        type=str,  # default=DEFAULT_INPUT_FORMAT,
        help="Format of the input document(s)."
        " Available input formats are: %s." % parser_names
        + " If no format is given, it will be "
        + "guessed from the file name extension."
        + " Keywords to parser can be given after format like: %s." % kw_example,
        metavar="INPUT_FORMAT",
    )

    oparser.add_option(
        "-o",
        "--output-format",
        type=str,
        default=DEFAULT_OUTPUT_FORMAT,
        help="Format of the graph serialization."
        " Available output formats are: %s." % serializer_names
        + " Default format is: '%default'."
        + " Keywords to serializer can be given after format like: %s." % kw_example,
        metavar="OUTPUT_FORMAT",
    )

    oparser.add_option(
        "--ns",
        action="append",
        type=str,
        help="Register a namespace binding (QName prefix to a base URI). "
        "This can be used more than once.",
        metavar="PREFIX=NAMESPACE",
    )

    oparser.add_option(
        "--no-guess",
        dest="guess",
        action="store_false",
        default=True,
        help="Don't guess format based on file suffix.",
    )

    oparser.add_option(
        "--no-out",
        action="store_true",
        default=False,
        help="Don't output the resulting graph "
        + "(useful for checking validity of input).",
    )

    oparser.add_option(
        "-w",
        "--warn",
        action="store_true",
        default=False,
        help="Output warnings to stderr (by default only critical errors).",
    )

    return oparser


def _get_plugin_names(kind):
    return ", ".join(p.name for p in plugin.plugins(kind=kind))


def main():
    oparser = make_option_parser()
    opts, args = oparser.parse_args()
    if len(args) < 1:
        oparser.print_usage()
        oparser.exit()

    if opts.warn:
        loglevel = logging.WARNING
    else:
        loglevel = logging.CRITICAL
    logging.basicConfig(level=loglevel)

    ns_bindings = {}
    if opts.ns:
        for ns_kw in opts.ns:
            pfx, uri = ns_kw.split("=")
            ns_bindings[pfx] = uri

    outfile: Optional[BinaryIO] = sys.stdout.buffer

    if opts.no_out:
        outfile = None

    parse_and_serialize(
        args, opts.input_format, opts.guess, outfile, opts.output_format, ns_bindings
    )


if __name__ == "__main__":
    main()
