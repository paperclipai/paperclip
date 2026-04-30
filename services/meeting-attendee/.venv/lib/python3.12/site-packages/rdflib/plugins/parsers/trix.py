"""
A TriX parser for RDFLib
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict, List, NoReturn, Optional, Tuple
from xml.sax import handler, make_parser
from xml.sax.handler import ErrorHandler

from rdflib.exceptions import ParserError
from rdflib.graph import Graph
from rdflib.namespace import Namespace
from rdflib.parser import InputSource, Parser
from rdflib.store import Store
from rdflib.term import BNode, Identifier, Literal, URIRef

if TYPE_CHECKING:
    # from xml.sax.expatreader import ExpatLocator
    from xml.sax.xmlreader import AttributesImpl, Locator, XMLReader

__all__ = ["create_parser", "TriXHandler", "TriXParser"]


TRIXNS = Namespace("http://www.w3.org/2004/03/trix/trix-1/")
XMLNS = Namespace("http://www.w3.org/XML/1998/namespace")


class TriXHandler(handler.ContentHandler):
    """An Sax Handler for TriX. See http://sw.nokia.com/trix/"""

    lang: Optional[str]
    datatype: Optional[str]

    def __init__(self, store: Store):
        self.store = store
        self.preserve_bnode_ids = False
        self.reset()

    def reset(self) -> None:
        self.bnode: Dict[str, BNode] = {}
        self.graph: Optional[Graph] = None
        self.triple: Optional[List[Identifier]] = None
        self.state = 0
        self.lang = None
        self.datatype = None

    # ContentHandler methods

    def setDocumentLocator(self, locator: Locator):
        self.locator = locator

    def startDocument(self) -> None:
        pass

    def startPrefixMapping(self, prefix: Optional[str], namespace: str) -> None:
        pass

    def endPrefixMapping(self, prefix: Optional[str]) -> None:
        pass

    def startElementNS(
        self, name: Tuple[Optional[str], str], qname, attrs: AttributesImpl
    ) -> None:
        if name[0] != str(TRIXNS):
            self.error(
                "Only elements in the TriX namespace are allowed. %s!=%s"
                % (name[0], TRIXNS)
            )

        if name[1].lower() == "trix":
            if self.state == 0:
                self.state = 1
            else:
                self.error("Unexpected TriX element")

        elif name[1] == "graph":
            if self.state == 1:
                self.state = 2
            else:
                self.error("Unexpected graph element")

        elif name[1] == "uri":
            if self.state == 2:
                # the context uri
                self.state = 3
            elif self.state == 4:
                # part of a triple
                pass
            else:
                self.error("Unexpected uri element")

        elif name[1] == "triple":
            if self.state == 2:
                if self.graph is None:
                    # anonymous graph, create one with random bnode id
                    self.graph = Graph(store=self.store)
                # start of a triple
                self.triple = []
                self.state = 4
            else:
                self.error("Unexpected triple element")

        elif name[1] == "typedLiteral":
            if self.state == 4:
                # part of triple
                self.lang = None
                self.datatype = None

                try:
                    self.lang = attrs.getValue((str(XMLNS), "lang"))  # type: ignore[arg-type, unused-ignore]
                except Exception:
                    # language not required - ignore
                    pass
                try:
                    self.datatype = attrs.getValueByQName("datatype")  # type: ignore[arg-type, unused-ignore]
                except KeyError:
                    self.error("No required attribute 'datatype'")
            else:
                self.error("Unexpected typedLiteral element")

        elif name[1] == "plainLiteral":
            if self.state == 4:
                # part of triple
                self.lang = None
                self.datatype = None
                try:
                    # type error: Argument 1 to "getValue" of "AttributesImpl" has incompatible type "Tuple[str, str]"; expected "str"
                    self.lang = attrs.getValue((str(XMLNS), "lang"))  # type: ignore[arg-type, unused-ignore]
                except Exception:
                    # language not required - ignore
                    pass

            else:
                self.error("Unexpected plainLiteral element")

        elif name[1] == "id":
            if self.state == 2:
                # the context uri
                self.state = 3

            elif self.state == 4:
                # part of triple
                pass
            else:
                self.error("Unexpected id element")

        else:
            self.error("Unknown element %s in TriX namespace" % name[1])

        self.chars = ""

    def endElementNS(self, name: Tuple[Optional[str], str], qname) -> None:
        if TYPE_CHECKING:
            assert self.triple is not None
        if name[0] != str(TRIXNS):
            self.error(
                "Only elements in the TriX namespace are allowed. %s!=%s"
                % (name[0], TRIXNS)
            )

        if name[1] == "uri":
            if self.state == 3:
                self.graph = Graph(
                    store=self.store, identifier=URIRef(self.chars.strip())
                )
                self.state = 2
            elif self.state == 4:
                self.triple += [URIRef(self.chars.strip())]
            else:
                self.error(
                    "Illegal internal self.state - This should never "
                    + "happen if the SAX parser ensures XML syntax correctness"
                )

        elif name[1] == "id":
            if self.state == 3:
                self.graph = Graph(
                    self.store, identifier=self.get_bnode(self.chars.strip())
                )
                self.state = 2
            elif self.state == 4:
                self.triple += [self.get_bnode(self.chars.strip())]
            else:
                self.error(
                    "Illegal internal self.state - This should never "
                    + "happen if the SAX parser ensures XML syntax correctness"
                )

        elif name[1] == "plainLiteral" or name[1] == "typedLiteral":
            if self.state == 4:
                self.triple += [
                    Literal(self.chars, lang=self.lang, datatype=self.datatype)
                ]
            else:
                self.error(
                    "This should never happen if the SAX parser "
                    + "ensures XML syntax correctness"
                )

        elif name[1] == "triple":
            if self.state == 4:
                if len(self.triple) != 3:
                    self.error(
                        "Triple has wrong length, got %d elements: %s"
                        % (len(self.triple), self.triple)
                    )
                # type error: Item "None" of "Optional[Graph]" has no attribute "add"
                # type error: Argument 1 to "add" of "Graph" has incompatible type "List[Identifier]"; expected "Tuple[Node, Node, Node]"
                self.graph.add(self.triple)  # type: ignore[union-attr, arg-type]
                # self.store.store.add(self.triple,context=self.graph)
                # self.store.addN([self.triple+[self.graph]])
                self.state = 2
            else:
                self.error(
                    "This should never happen if the SAX parser "
                    + "ensures XML syntax correctness"
                )

        elif name[1] == "graph":
            self.graph = None
            self.state = 1

        elif name[1].lower() == "trix":
            self.state = 0

        else:
            self.error("Unexpected close element")

    def get_bnode(self, label: str) -> BNode:
        if self.preserve_bnode_ids:
            bn = BNode(label)
        else:
            if label in self.bnode:
                bn = self.bnode[label]
            else:
                bn = BNode(label)
                self.bnode[label] = bn
        return bn

    def characters(self, content: str) -> None:
        self.chars += content

    def ignorableWhitespace(self, content) -> None:
        pass

    def processingInstruction(self, target, data) -> None:
        pass

    def error(self, message: str) -> NoReturn:
        locator = self.locator
        info = "%s:%s:%s: " % (
            locator.getSystemId(),
            locator.getLineNumber(),
            locator.getColumnNumber(),
        )
        raise ParserError(info + message)


def create_parser(store: Store) -> XMLReader:
    parser = make_parser()
    try:
        # Workaround for bug in expatreader.py. Needed when
        # expatreader is trying to guess a prefix.
        # type error: "XMLReader" has no attribute "start_namespace_decl"
        parser.start_namespace_decl("xml", "http://www.w3.org/XML/1998/namespace")  # type: ignore[attr-defined]
    except AttributeError:
        pass  # Not present in Jython (at least)
    parser.setFeature(handler.feature_namespaces, 1)
    trix = TriXHandler(store)
    parser.setContentHandler(trix)
    parser.setErrorHandler(ErrorHandler())
    return parser


class TriXParser(Parser):
    """A parser for TriX. See http://sw.nokia.com/trix/"""

    def __init__(self):
        pass

    def parse(self, source: InputSource, sink: Graph, **args: Any) -> None:
        assert (
            sink.store.context_aware
        ), "TriXParser must be given a context aware store."

        self._parser = create_parser(sink.store)
        content_handler = self._parser.getContentHandler()
        preserve_bnode_ids = args.get("preserve_bnode_ids", None)
        if preserve_bnode_ids is not None:
            # type error: ContentHandler has no attribute "preserve_bnode_ids"
            content_handler.preserve_bnode_ids = preserve_bnode_ids  # type: ignore[attr-defined, unused-ignore]
        # We're only using it once now
        # content_handler.reset()
        # self._parser.reset()
        self._parser.parse(source)
