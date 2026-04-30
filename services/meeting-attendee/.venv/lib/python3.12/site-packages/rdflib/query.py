from __future__ import annotations

import itertools
import types
import warnings
from io import BytesIO
from typing import (
    IO,
    TYPE_CHECKING,
    Any,
    BinaryIO,
    Dict,
    Iterator,
    List,
    Mapping,
    MutableSequence,
    Optional,
    Tuple,
    Union,
    cast,
    overload,
)
from urllib.parse import urlparse
from urllib.request import url2pathname

__all__ = [
    "Processor",
    "UpdateProcessor",
    "Result",
    "ResultRow",
    "ResultParser",
    "ResultSerializer",
    "ResultException",
    "EncodeOnlyUnicode",
]

import rdflib.term

if TYPE_CHECKING:
    from rdflib.graph import Graph, _TripleType
    from rdflib.plugins.sparql.sparql import Query, Update
    from rdflib.term import Identifier, Variable


class Processor:
    """
    Query plugin interface.

    This module is useful for those wanting to write a query processor
    that can plugin to rdf. If you are wanting to execute a query you
    likely want to do so through the Graph class query method.
    """

    def __init__(self, graph: Graph):
        pass

    # type error: Missing return statement
    def query(  # type: ignore[empty-body]
        self,
        strOrQuery: Union[str, Query],  # noqa: N803
        initBindings: Mapping[str, Identifier] = {},  # noqa: N803
        initNs: Mapping[str, Any] = {},  # noqa: N803
        DEBUG: bool = False,  # noqa: N803
    ) -> Mapping[str, Any]:
        pass


class UpdateProcessor:
    """Update plugin interface.

    This module is useful for those wanting to write an update
    processor that can plugin to rdflib. If you are wanting to execute
    an update statement you likely want to do so through the Graph
    class update method.

    !!! example "New in version 4.0"
    """

    def __init__(self, graph: Graph):
        pass

    def update(
        self,
        strOrQuery: Union[str, Update],  # noqa: N803
        initBindings: Mapping[str, Identifier] = {},  # noqa: N803
        initNs: Mapping[str, Any] = {},  # noqa: N803
    ) -> None:
        pass


class ResultException(Exception):  # noqa: N818
    pass


class EncodeOnlyUnicode:
    """This is a crappy work-around for http://bugs.python.org/issue11649"""

    def __init__(self, stream: BinaryIO):
        self.__stream = stream

    def write(self, arg):
        if isinstance(arg, str):
            self.__stream.write(arg.encode("utf-8"))
        else:
            self.__stream.write(arg)

    def __getattr__(self, name: str) -> Any:
        return getattr(self.__stream, name)


class ResultRow(Tuple[rdflib.term.Identifier, ...]):
    """A single result row allows accessing bindings as attributes or with []

    ```python
    >>> from rdflib import URIRef, Variable
    >>> rr=ResultRow({ Variable('a'): URIRef('urn:cake') }, [Variable('a')])

    >>> rr[0]
    rdflib.term.URIRef('urn:cake')
    >>> rr[1]
    Traceback (most recent call last):
        ...
    IndexError: tuple index out of range

    >>> rr.a
    rdflib.term.URIRef('urn:cake')
    >>> rr.b
    Traceback (most recent call last):
        ...
    AttributeError: b

    >>> rr['a']
    rdflib.term.URIRef('urn:cake')
    >>> rr['b']
    Traceback (most recent call last):
        ...
    KeyError: 'b'

    >>> rr[Variable('a')]
    rdflib.term.URIRef('urn:cake')

    ```

    !!! example "New in version 4.0"
    """

    labels: Mapping[str, int]

    def __new__(cls, values: Mapping[Variable, Identifier], labels: List[Variable]):
        # type error: Value of type variable "Self" of "__new__" of "tuple" cannot be "ResultRow"  [type-var]
        # type error: Generator has incompatible item type "Optional[Identifier]"; expected "_T_co"  [misc]
        instance = super(ResultRow, cls).__new__(cls, (values.get(v) for v in labels))  # type: ignore[type-var, misc, unused-ignore]
        instance.labels = dict((str(x[1]), x[0]) for x in enumerate(labels))
        return instance

    def __getattr__(self, name: str) -> Identifier:
        if name not in self.labels:
            raise AttributeError(name)
        return tuple.__getitem__(self, self.labels[name])

    # type error: Signature of "__getitem__" incompatible with supertype "tuple"
    # type error: Signature of "__getitem__" incompatible with supertype "Sequence"
    def __getitem__(self, name: Union[str, int, Any]) -> Identifier:  # type: ignore[override]
        try:
            # type error: Invalid index type "Union[str, int, Any]" for "tuple"; expected type "int"
            return tuple.__getitem__(self, name)  # type: ignore[index]
        except TypeError:
            if name in self.labels:
                # type error: Invalid index type "Union[str, int, slice, Any]" for "Mapping[str, int]"; expected type "str"
                return tuple.__getitem__(self, self.labels[name])  # type: ignore[index]
            if str(name) in self.labels:  # passing in variable object
                return tuple.__getitem__(self, self.labels[str(name)])
            raise KeyError(name)

    @overload
    def get(self, name: str, default: Identifier) -> Identifier: ...

    @overload
    def get(
        self, name: str, default: Optional[Identifier] = ...
    ) -> Optional[Identifier]: ...

    def get(
        self, name: str, default: Optional[Identifier] = None
    ) -> Optional[Identifier]:
        try:
            return self[name]
        except KeyError:
            return default

    def asdict(self) -> Dict[str, Identifier]:
        return dict((v, self[v]) for v in self.labels if self[v] is not None)


class Result:
    """
    A common class for representing query result.

    There is a bit of magic here that makes this appear like different
    Python objects, depending on the type of result.

    If the type is "SELECT", iterating will yield lists of ResultRow objects

    If the type is "ASK", iterating will yield a single bool (or
    bool(result) will return the same bool)

    If the type is "CONSTRUCT" or "DESCRIBE" iterating will yield the
    triples.

    `len(result)` also works.
    """

    def __init__(self, type_: str):
        if type_ not in ("CONSTRUCT", "DESCRIBE", "SELECT", "ASK"):
            raise ResultException("Unknown Result type: %s" % type_)

        self.type = type_
        #: variables contained in the result.
        self.vars: Optional[List[Variable]] = None
        """a list of variables contained in the result"""
        self._bindings: MutableSequence[Mapping[Variable, Identifier]] = None  # type: ignore[assignment]
        self._genbindings: Optional[Iterator[Mapping[Variable, Identifier]]] = None
        self.askAnswer: Optional[bool] = None
        self.graph: Optional[Graph] = None

    @property
    def bindings(self) -> MutableSequence[Mapping[Variable, Identifier]]:
        """
        a list of variable bindings as dicts
        """
        if self._genbindings:
            self._bindings += list(self._genbindings)
            self._genbindings = None

        return self._bindings

    @bindings.setter
    def bindings(
        self,
        b: Union[
            MutableSequence[Mapping[Variable, Identifier]],
            Iterator[Mapping[Variable, Identifier]],
        ],
    ) -> None:
        if isinstance(b, (types.GeneratorType, itertools.islice)):
            self._genbindings = b
            self._bindings = []
        else:
            # type error: Incompatible types in assignment (expression has type "Union[MutableSequence[Mapping[Variable, Identifier]], Iterator[Mapping[Variable, Identifier]]]", variable has type "MutableSequence[Mapping[Variable, Identifier]]")
            self._bindings = b  # type: ignore[assignment]

    @staticmethod
    def parse(
        source: Optional[IO] = None,
        format: Optional[str] = None,
        content_type: Optional[str] = None,
        **kwargs: Any,
    ) -> Result:
        """Parse a query result from a source."""
        from rdflib import plugin

        if format:
            plugin_key = format
        elif content_type:
            plugin_key = content_type.split(";", 1)[0]
        else:
            plugin_key = "xml"

        parser = plugin.get(plugin_key, ResultParser)()

        # type error: Argument 1 to "parse" of "ResultParser" has incompatible type "Optional[IO[Any]]"; expected "IO[Any]"
        return parser.parse(
            source, content_type=content_type, **kwargs  # type:ignore[arg-type]
        )

    def serialize(
        self,
        destination: Optional[Union[str, IO]] = None,
        encoding: str = "utf-8",
        format: str = "xml",
        **args: Any,
    ) -> Optional[bytes]:
        """
        Serialize the query result.


        Args:
            destination: Path of file output or BufferedIOBase object
                to write the output to. If `None` this function
                will return the output as  `bytes`
            encoding: Encoding of output.
            format: The format used for serialization.
                See [sparql.results module][rdflib.plugins.sparql.results]
                for all builtin SPARQL result serialization.
                Further serializer can be loaded [as plugin][rdflib.plugin].
                Some example formats are
                [csv][rdflib.plugins.sparql.results.csvresults.CSVResultSerializer],
                [json][rdflib.plugins.sparql.results.jsonresults.JSONResultSerializer],
                [txt][rdflib.plugins.sparql.results.txtresults.TXTResultSerializer]
                or
                [xml][rdflib.plugins.sparql.results.xmlresults.XMLResultSerializer]

        Returns:
            Serialized result, when destination is not given.
        """
        if self.type in ("CONSTRUCT", "DESCRIBE"):
            # type error: Item "None" of "Optional[Graph]" has no attribute "serialize"
            # type error: Incompatible return value type (got "Union[bytes, str, Graph, Any]", expected "Optional[bytes]")
            return self.graph.serialize(  # type: ignore[union-attr,return-value]
                destination, encoding=encoding, format=format, **args
            )

        """stolen wholesale from graph.serialize"""
        from rdflib import plugin

        serializer = plugin.get(format, ResultSerializer)(self)
        if destination is None:
            streamb: BytesIO = BytesIO()
            stream2 = EncodeOnlyUnicode(streamb)  # TODO: Remove the need for this
            # TODO: All QueryResult serializers should write to a Bytes Stream.
            # type error: Argument 1 to "serialize" of "ResultSerializer" has incompatible type "EncodeOnlyUnicode"; expected "IO[Any]"
            serializer.serialize(stream2, encoding=encoding, **args)  # type: ignore[arg-type]
            return streamb.getvalue()
        if hasattr(destination, "write"):
            stream = cast(IO[bytes], destination)
            serializer.serialize(stream, encoding=encoding, **args)
        else:
            location = cast(str, destination)
            scheme, netloc, path, params, query, fragment = urlparse(location)
            if scheme == "file":
                if netloc != "":
                    raise ValueError(
                        f"the file URI {location!r} has an authority component which is not supported"
                    )
                os_path = url2pathname(path)
            else:
                os_path = location
            with open(os_path, "wb") as stream:
                serializer.serialize(stream, encoding=encoding, **args)
        return None

    def __len__(self) -> int:
        if self.type == "ASK":
            return 1
        elif self.type == "SELECT":
            return len(self.bindings)
        else:
            # type error: Argument 1 to "len" has incompatible type "Optional[Graph]"; expected "Sized"
            return len(self.graph)  # type: ignore[arg-type]

    def __bool__(self) -> bool:
        if self.type == "ASK":
            # type error: Incompatible return value type (got "Optional[bool]", expected "bool")
            return self.askAnswer  # type: ignore[return-value]
        else:
            return len(self) > 0

    def __iter__(
        self,
    ) -> Iterator[Union[_TripleType, bool, ResultRow]]:
        if self.type in ("CONSTRUCT", "DESCRIBE"):
            # type error: Item "None" of "Optional[Graph]" has no attribute "__iter__" (not iterable)
            for t in self.graph:  # type: ignore[union-attr]
                yield t
        elif self.type == "ASK":
            # type error: Incompatible types in "yield" (actual type "Optional[bool]", expected type "Union[Tuple[Identifier, Identifier, Identifier], bool, ResultRow]")  [misc]
            yield self.askAnswer  # type: ignore[misc]
        elif self.type == "SELECT":
            # this iterates over ResultRows of variable bindings

            if self._genbindings:
                for b in self._genbindings:
                    if b:  # don't add a result row in case of empty binding {}
                        self._bindings.append(b)
                        # type error: Argument 2 to "ResultRow" has incompatible type "Optional[List[Variable]]"; expected "List[Variable]"
                        yield ResultRow(b, self.vars)  # type: ignore[arg-type]
                self._genbindings = None
            else:
                for b in self._bindings:
                    if b:  # don't add a result row in case of empty binding {}
                        # type error: Argument 2 to "ResultRow" has incompatible type "Optional[List[Variable]]"; expected "List[Variable]"
                        yield ResultRow(b, self.vars)  # type: ignore[arg-type]

    def __getattr__(self, name: str) -> Any:
        if self.type in ("CONSTRUCT", "DESCRIBE") and self.graph is not None:
            # type error: "Graph" has no attribute "__getattr__"
            return self.graph.__getattr__(self, name)  # type: ignore[attr-defined]
        elif self.type == "SELECT" and name == "result":
            warnings.warn(
                "accessing the 'result' attribute is deprecated."
                " Iterate over the object instead.",
                DeprecationWarning,
                stacklevel=2,
            )
            # copied from __iter__, above
            # type error: Item "None" of "Optional[List[Variable]]" has no attribute "__iter__" (not iterable)
            return [(tuple(b[v] for v in self.vars)) for b in self.bindings]  # type: ignore[union-attr]
        else:
            raise AttributeError("'%s' object has no attribute '%s'" % (self, name))

    def __eq__(self, other: Any) -> bool:
        try:
            if self.type != other.type:
                return False
            if self.type == "ASK":
                return self.askAnswer == other.askAnswer
            elif self.type == "SELECT":
                return self.vars == other.vars and self.bindings == other.bindings
            else:
                return self.graph == other.graph
        except Exception:
            return False


class ResultParser:
    def __init__(self):
        pass

    # type error: Missing return statement
    def parse(self, source: IO, **kwargs: Any) -> Result:  # type: ignore[empty-body]
        """return a Result object"""
        pass  # abstract


class ResultSerializer:
    def __init__(self, result: Result):
        self.result = result

    def serialize(self, stream: IO, encoding: str = "utf-8", **kwargs: Any) -> None:
        """return a string properly serialized"""
        pass  # abstract
