from __future__ import annotations

import codecs
import getopt
import sys
import time
from typing import TextIO, Union

import rdflib
from rdflib.util import guess_format


def _help():
    sys.stderr.write(
        """
program.py [-f <format>] [-o <output>] [files...]
Read RDF files given on STDOUT - does something to the resulting graph
If no files are given, read from stdin
-o specifies file for output, if not given stdout is used
-f specifies parser to use, if not given it is guessed from extension

"""
    )


def main(target, _help=_help, options="", stdin=True):
    """
    A main function for tools that read RDF from files given on commandline
    or from STDIN (if stdin parameter is true)
    """

    args, files = getopt.getopt(sys.argv[1:], "hf:o:" + options)
    dargs = dict(args)

    if "-h" in dargs:
        _help()
        sys.exit(-1)

    g = rdflib.Graph()

    if "-f" in dargs:
        f = dargs["-f"]
    else:
        f = None

    out: Union[TextIO, codecs.StreamReaderWriter]
    if "-o" in dargs:
        sys.stderr.write("Output to %s\n" % dargs["-o"])
        out = codecs.open(dargs["-o"], "w", "utf-8")
    else:
        out = sys.stdout

    start = time.time()
    if len(files) == 0 and stdin:
        sys.stderr.write("Reading from stdin as %s..." % f)
        g.parse(sys.stdin, format=f)
        sys.stderr.write("[done]\n")
    else:
        size = 0
        for x in files:
            if f is None:
                f = guess_format(x)
            start1 = time.time()
            sys.stderr.write("Loading %s as %s... " % (x, f))
            g.parse(x, format=f)
            sys.stderr.write(
                "done.\t(%d triples\t%.2f seconds)\n"
                % (len(g) - size, time.time() - start1)
            )
            size = len(g)

    sys.stderr.write(
        "Loaded a total of %d triples in %.2f seconds.\n"
        % (len(g), time.time() - start)
    )

    target(g, out, args)
