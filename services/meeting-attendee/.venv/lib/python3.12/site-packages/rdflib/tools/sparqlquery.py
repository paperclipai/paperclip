#!/usr/bin/env python
"""
A commandline tool for querying with SPARQL on local files and remote sparql endpoints with custom serialization.

example usage:
```bash
    sq path/to/data.ttl -q "SELECT ?x WHERE {?x a foaf:Person. }"
    rdfpipe test.ttl | sparqlquery - -q "SELECT ?x WHERE {?x a foaf:Person. }" --format json
    sq data.ttl -q "ASK {:john a foaf:Person}" --format xml | grep true
    sq path/to/data.ttl --query-file query.rq
    sq data1.ttl data2.ttl -q "DESCRIBE <http://example.com/john>" --format turtle:+spacious
    sq http://example.com/sparqlendpoint --query-file query.rq
    sq http://example.com/sparqlendpoint --query-file query.rq --username user --password secret
    sq /pyth/to/berkeley.db -q "SELECT ?x WHERE {?x a foaf:Person. }" --remote-storetype BerkeleyDB
```

Tip: You can check the truth value for an ASK query, by regex in stdout for 'true'
or 'false'.
"""
from __future__ import annotations

import argparse
import inspect
import logging
import os
import sys
from inspect import Parameter
from typing import Any, Dict, List, Optional, Tuple, Type
from urllib.parse import urlparse

try:
    # Pyparsing >=3.0.0
    from pyparsing.exceptions import ParseException
except ImportError:
    # Pyparsing 2
    from pyparsing import ParseException

from rdflib.graph import Dataset, Graph
from rdflib.plugin import PluginException
from rdflib.plugin import get as get_plugin
from rdflib.plugin import plugins as get_plugins
from rdflib.query import Result, ResultSerializer
from rdflib.serializer import Serializer
from rdflib.store import Store

from .rdfpipe import _format_and_kws

__all__ = ["sparqlquery"]


class _ArgumentError(Exception):
    pass


class _PrintHelpError(Exception):
    pass


class InvalidQueryError(Exception):
    pass


def sparqlquery(
    endpoints: List[str],
    query: str,
    result_format: Optional[str] = None,
    result_keywords: Dict[str, str] = {},
    auth: Optional[Tuple[str, str]] = None,
    use_stdin: bool = False,
    remote_storetype: Optional[str] = None,
):
    if use_stdin:
        g = Graph().parse(sys.stdin)
    else:
        g = _get_graph(endpoints, auth, remote_storetype)
    try:
        results: Result = g.query(query)
    except ParseException as err:
        raise InvalidQueryError(query) from err

    if result_format is not None:
        ret_bytes = results.serialize(format=result_format, **result_keywords)
    else:
        ret_bytes = results.serialize(**result_keywords)
    if ret_bytes is not None:
        print(ret_bytes.decode())


def _dest_is_local(dest: str):
    if os.path.isabs(dest):
        return True

    q = urlparse(dest)
    # Handle Windows drive letters (single letter followed by colon)
    if len(q.scheme) == 1 and q.scheme.isalpha():
        return True

    return q.scheme in ["", "file"]


def _dest_is_internet_addr(dest: str):
    q = urlparse(dest)
    return q.scheme in ["http", "https"]


def _get_graph(
    endpoints, auth: Optional[Tuple[str, str]], remote_storetype: Optional[str]
) -> Graph:
    graph: Graph
    if remote_storetype is not None:
        storeplugin = get_plugin(remote_storetype, Store)
        if auth:
            store = storeplugin(endpoints[0], auth=auth)  # type: ignore[call-arg]
        else:
            store = storeplugin(endpoints[0])
        graph = Dataset(store)
    else:
        graph = Graph()
        for x in endpoints:
            graph.parse(location=x)
    return graph


def _extract_query_and_format(parser) -> Tuple[Dict[str, Any], Optional[str]]:
    opts: Dict[str, Any] = {}
    tmp_args, rest_args = parser.parse_known_args()
    if tmp_args.query and tmp_args.queryfile is None:
        query = tmp_args.query
    elif tmp_args.queryfile and tmp_args.query is None:
        with open(tmp_args.queryfile, "r") as f:
            query = f.read()
    else:
        query = None

    if query is None:
        construct = False
    elif "DESCRIBE" in query or "CONSTRUCT" in query:
        construct = True
    else:
        construct = False

    if tmp_args.format is not None:
        format_, format_keywords = _format_and_kws(tmp_args.format)
    elif construct:
        format_keywords = {}
        format_ = "turtle"
        construct = True
    else:
        format_keywords = {}
        format_ = "json"
    epilog = _create_epilog_from_format(format_, construct)
    opts = {
        "query": query,
        "result_format": format_,
        "result_keywords": format_keywords,
    }
    return opts, epilog


def parse_args():
    extra_kwargs: Dict[str, Any] = {}
    if sys.version_info > (3, 9):
        extra_kwargs["exit_on_error"] = False
    parser = argparse.ArgumentParser(
        prog="sparqlquery",
        description=__doc__,
        add_help=False,  # add dynamic epilog before help is added
        formatter_class=argparse.RawDescriptionHelpFormatter,
        # else __doc__ wont be printed on error:
        **extra_kwargs,
    )
    parser.add_argument(
        "-q",
        "--query",
        type=str,
        help="Sparql query. Cannot be set together with -qf/--queryfile.",
    )
    parser.add_argument(
        "-qf",
        "--queryfile",
        type=str,
        help="File from where the sparql query is read. "
        "Cannot be set together with -q/--query",
    )
    parser.add_argument(
        "-f",
        "--format",
        type=str,
        help="Print sparql result in given format. "
        "Defaults to 'json' on SELECT, to 'xml' on ASK "
        "and to 'turtle' on DESCRIBE and CONSTRUCT. "
        "Keywords as described in epilog can be given "
        "after format like: "
        "FORMAT:(+)KW1,-KW2,KW3=VALUE.",
    )
    opts: Dict[str, Any]
    opts, parser.epilog = _extract_query_and_format(parser)

    parser.add_argument(
        "endpoint",
        nargs="+",
        type=str,
        help="Endpoints for sparql query. "
        "Can be set to multiple files. "
        "Reads from stdin if '-' is given. ",
    )
    parser.add_argument(
        "-w",
        "--warn",
        action="store_true",
        default=False,
        help="Output warnings to stderr " "(by default only critical errors).",
    )
    parser.add_argument(
        "-h",
        "--help",
        # action="store_true",
        # default=False,
        action="help",
        help="show help message and exit. "
        "Also prints information about given format.",
    )
    parser.add_argument(
        "-u", "--username", type=str, help="Username used during authentication."
    )
    parser.add_argument(
        "-p", "--password", type=str, help="Password used during authentication."
    )
    parser.add_argument(
        "-rs",
        "--remote-storetype",
        type=str,
        help="You can specify which storetype should be used. "
        "Can only be set, when using a single endpoint and not stdin. "
        "Will default to 'SparqlStore' when endpoint is an internetaddress.",
    )

    try:  # catch error because exit_on_error=False
        args = parser.parse_args()
    except argparse.ArgumentError as err:
        parser.print_help()
        raise err

    forbidden_format_keywords = [
        x
        for x in opts.get("result_keywords", dict())
        if x in {"self", "stream", "encoding", "format"}
    ]
    if forbidden_format_keywords:
        raise _ArgumentError(
            "'self', 'stream', 'encoding' and 'format' "
            "mustnt be used as keywords for format."
        )

    if opts.get("query") is None:
        parser.print_help()
        raise _ArgumentError("Either -q/--query or -qf/--queryfile must be provided")

    remote_storetype = args.remote_storetype

    if len(args.endpoint) == 1:
        if args.endpoint[0] == "-":
            if remote_storetype is not None:
                raise _ArgumentError(
                    "Cant us remote graphtype, when endpoint is stdin(-)"
                )
            endpoints = []
            opts["use_stdin"] = True
        elif _dest_is_internet_addr(args.endpoint[0]):
            endpoints = args.endpoint
            if remote_storetype is None:
                remote_storetype = "SPARQLStore"
        else:
            endpoints = args.endpoint
    else:
        if remote_storetype is not None:
            raise _ArgumentError(
                "If remote graphtype is set, only a single endpoint is valid."
            )
        endpoints = list(args.endpoint)
        if any(not (_dest_is_local(x)) for x in args.endpoint):
            raise NotImplementedError(
                "If multiple endpoints are given, all must be local files."
            )

    if args.username is not None and args.password is not None:
        if remote_storetype not in ["SPARQLStore"]:
            raise _ArgumentError(
                "Can use password and username only, "
                "when remote-storetype is 'SPARQLStore'."
            )
        opts["auth"] = (args.username, args.password)
    elif args.username is None and args.password is None:
        pass
    else:
        parser.print_help()
        raise _ArgumentError("User only provided one of password and username")

    return endpoints, remote_storetype, args.warn, opts


def _create_epilog_from_format(format_, construct) -> Optional[str]:
    serializer_plugin_type: Type[ResultSerializer | Serializer]
    if construct:
        serializer_plugin_type = Serializer
    else:
        serializer_plugin_type = ResultSerializer
    try:
        plugin = get_plugin(format_, serializer_plugin_type)
    except PluginException:
        available_plugins = [x.name for x in get_plugins(None, ResultSerializer)]
        return (
            f"No plugin registered for sparql result in format '{format_}'. "
            f"available plugins: {available_plugins}"
        )
    serialize_method = plugin.serialize  # type: ignore[attr-defined]
    module = inspect.getmodule(serialize_method)
    if module is None:
        return None
    pydoc_target = ".".join([module.__name__, serialize_method.__qualname__])
    sig = inspect.signature(serialize_method)
    available_keywords = [
        x
        for x, y in sig.parameters.items()
        if y.kind in [Parameter.KEYWORD_ONLY, Parameter.POSITIONAL_OR_KEYWORD]
    ]
    available_keywords.pop(0)  # pop self
    available_keywords.pop(0)  # pop stream
    if serializer_plugin_type == Serializer:
        available_keywords.pop(1)  # pop encoding
    else:
        available_keywords.pop(0)  # pop encoding

    epilog = (
        f"For more customization for format '{format_}' "
        f"use `pydoc {pydoc_target}`. "
    )
    if len(available_keywords) > 0:
        epilog += f"Known keywords are {available_keywords}."
    # there is always **kwargs in .serialize
    epilog += " Further keywords might be valid."
    return epilog


def main():
    try:
        (
            endpoints,
            remote_storetype,
            warn,
            opts,
        ) = parse_args()
    except _PrintHelpError:
        exit()
    except (_ArgumentError, argparse.ArgumentError) as err:
        print(err, file=sys.stderr)
        exit(2)

    if warn:
        loglevel = logging.WARNING
    else:
        loglevel = logging.CRITICAL
    logging.basicConfig(level=loglevel)

    sparqlquery(
        endpoints,
        remote_storetype=remote_storetype,
        **opts,
    )


if __name__ == "__main__":
    main()
