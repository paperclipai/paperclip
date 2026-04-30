from __future__ import annotations

from codecs import getreader
from enum import Enum
from typing import TYPE_CHECKING, Any, MutableMapping, Optional, Union

from rdflib.exceptions import ParserError as ParseError
from rdflib.graph import Dataset
from rdflib.parser import InputSource
from rdflib.plugins.parsers.nquads import NQuadsParser

# Build up from the NTriples parser:
from rdflib.plugins.parsers.ntriples import r_nodeid, r_tail, r_uriref, r_wspace
from rdflib.term import BNode, URIRef

if TYPE_CHECKING:
    import typing_extensions as te

__all__ = ["RDFPatchParser", "Operation"]

_BNodeContextType = MutableMapping[str, BNode]


class Operation(Enum):
    """Enum of RDF Patch operations.

    Operations:
    - `AddTripleOrQuad` (A): Adds a triple or quad.
    - `DeleteTripleOrQuad` (D): Deletes a triple or quad.
    - `AddPrefix` (PA): Adds a prefix.
    - `DeletePrefix` (PD): Deletes a prefix.
    - `TransactionStart` (TX): Starts a transaction.
    - `TransactionCommit` (TC): Commits a transaction.
    - `TransactionAbort` (TA): Aborts a transaction.
    - `Header` (H): Specifies a header.
    """

    AddTripleOrQuad = "A"
    DeleteTripleOrQuad = "D"
    AddPrefix = "PA"
    DeletePrefix = "PD"
    TransactionStart = "TX"
    TransactionCommit = "TC"
    TransactionAbort = "TA"
    Header = "H"


class RDFPatchParser(NQuadsParser):
    def parse(  # type: ignore[override]
        self,
        inputsource: InputSource,
        sink: Dataset,
        bnode_context: Optional[_BNodeContextType] = None,
        skolemize: bool = False,
        **kwargs: Any,
    ) -> Dataset:
        """Parse inputsource as an RDF Patch file.

        Args:
            inputsource: the source of RDF Patch formatted data
            sink: where to send parsed data
            bnode_context: a dict mapping blank node identifiers to [`BNode`][rdflib.term.BNode]
                instances. See `.W3CNTriplesParser.parse`
        """
        assert sink.store.context_aware, (
            "RDFPatchParser must be given" " a context aware store."
        )
        # type error: Incompatible types in assignment (expression has type "ConjunctiveGraph", base class "W3CNTriplesParser" defined the type as "Union[DummySink, NTGraphSink]")
        self.sink: Dataset = Dataset(store=sink.store)
        self.skolemize = skolemize

        source = inputsource.getCharacterStream()
        if not source:
            source = inputsource.getByteStream()
            source = getreader("utf-8")(source)

        if not hasattr(source, "read"):
            raise ParseError("Item to parse must be a file-like object.")

        self.file = source
        self.buffer = ""
        while True:
            self.line = __line = self.readline()
            if self.line is None:
                break
            try:
                self.parsepatch(bnode_context)
            except ParseError as msg:
                raise ParseError("Invalid line (%s):\n%r" % (msg, __line))
        return self.sink

    def parsepatch(self, bnode_context: Optional[_BNodeContextType] = None) -> None:
        self.eat(r_wspace)
        #  From spec: "No comments should be included (comments start # and run to end
        #  of line)."
        if (not self.line) or self.line.startswith("#"):
            return  # The line is empty or a comment

        # if header, transaction, skip
        operation = self.operation()
        self.eat(r_wspace)

        if operation in [Operation.AddTripleOrQuad, Operation.DeleteTripleOrQuad]:
            self.add_or_remove_triple_or_quad(operation, bnode_context)
        elif operation == Operation.AddPrefix:
            self.add_prefix()
        elif operation == Operation.DeletePrefix:
            self.delete_prefix()

    def add_or_remove_triple_or_quad(
        self, operation, bnode_context: Optional[_BNodeContextType] = None
    ) -> None:
        self.eat(r_wspace)
        if (not self.line) or self.line.startswith("#"):
            return  # The line is empty or a comment

        subject = self.labeled_bnode() or self.subject(bnode_context)
        self.eat(r_wspace)

        predicate = self.predicate()
        self.eat(r_wspace)

        obj = self.labeled_bnode() or self.object(bnode_context)
        self.eat(r_wspace)

        context = self.labeled_bnode() or self.uriref() or self.nodeid(bnode_context)
        self.eat(r_tail)

        if self.line:
            raise ParseError("Trailing garbage")
        # Must have a context aware store - add on a normal Graph
        # discards anything where the ctx != graph.identifier
        if operation == Operation.AddTripleOrQuad:
            if context:
                self.sink.get_context(context).add((subject, predicate, obj))
            else:
                self.sink.default_context.add((subject, predicate, obj))
        elif operation == Operation.DeleteTripleOrQuad:
            if context:
                self.sink.get_context(context).remove((subject, predicate, obj))
            else:
                self.sink.default_context.remove((subject, predicate, obj))

    def add_prefix(self):
        # Extract prefix and URI from the line
        prefix, ns, _ = self.line.replace('"', "").replace("'", "").split(" ")  # type: ignore[union-attr]
        ns_stripped = ns.strip("<>")
        self.sink.bind(prefix, ns_stripped)

    def delete_prefix(self):
        prefix, _, _ = self.line.replace('"', "").replace("'", "").split(" ")  # type: ignore[union-attr]
        self.sink.namespace_manager.bind(prefix, None, replace=True)

    def operation(self) -> Operation:
        for op in Operation:
            if self.line.startswith(op.value):  # type: ignore[union-attr]
                self.eat_op(op.value)
                return op
        raise ValueError(
            f'Invalid or no Operation found in line: "{self.line}". Valid Operations '
            f"codes are {', '.join([op.value for op in Operation])}"
        )

    def eat_op(self, op: str) -> None:
        self.line = self.line.lstrip(op)  # type: ignore[union-attr]

    def nodeid(
        self, bnode_context: Optional[_BNodeContextType] = None
    ) -> Union[te.Literal[False], BNode, URIRef]:
        if self.peek("_"):
            return BNode(self.eat(r_nodeid).group(1))
        return False

    def labeled_bnode(self):
        if self.peek("<_"):
            plain_uri = self.eat(r_uriref).group(1)
            bnode_id = r_nodeid.match(plain_uri).group(1)  # type: ignore[union-attr]
            return BNode(bnode_id)
        return False
