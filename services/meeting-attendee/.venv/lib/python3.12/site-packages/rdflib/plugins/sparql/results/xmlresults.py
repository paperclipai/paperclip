"""A Parser for SPARQL results in XML:

http://www.w3.org/TR/rdf-sparql-XMLres/

Bits and pieces borrowed from:
http://projects.bigasterisk.com/sparqlhttp/

Authors: Drew Perttula, Gunnar Aastrand Grimnes
"""

from __future__ import annotations

import logging
import xml.etree.ElementTree as xml_etree  # noqa: N813
from io import BytesIO
from typing import (
    IO,
    TYPE_CHECKING,
    Any,
    BinaryIO,
    Dict,
    Optional,
    Sequence,
    TextIO,
    Tuple,
    Union,
    cast,
)
from xml.dom import XML_NAMESPACE
from xml.sax.saxutils import XMLGenerator
from xml.sax.xmlreader import AttributesNSImpl

from rdflib.query import Result, ResultException, ResultParser, ResultSerializer
from rdflib.term import BNode, Identifier, Literal, URIRef, Variable

try:
    # https://adamj.eu/tech/2021/12/29/python-type-hints-optional-imports/
    import lxml.etree as lxml_etree

    FOUND_LXML = True
except ImportError:
    FOUND_LXML = False

SPARQL_XML_NAMESPACE = "http://www.w3.org/2005/sparql-results#"
RESULTS_NS_ET = "{%s}" % SPARQL_XML_NAMESPACE

log = logging.getLogger(__name__)


class XMLResultParser(ResultParser):
    """A Parser for SPARQL results in XML."""

    # TODO FIXME: content_type should be a keyword only arg.
    def parse(self, source: IO, content_type: Optional[str] = None) -> Result:  # type: ignore[override]
        return XMLResult(source)


class XMLResult(Result):
    def __init__(self, source: IO, content_type: Optional[str] = None):
        parser_encoding: Optional[str] = None
        if hasattr(source, "encoding"):
            if TYPE_CHECKING:
                assert isinstance(source, TextIO)
            parser_encoding = "utf-8"
            source_str = source.read()
            source = BytesIO(source_str.encode(parser_encoding))
        else:
            if TYPE_CHECKING:
                assert isinstance(source, BinaryIO)

        if FOUND_LXML:
            lxml_parser = lxml_etree.XMLParser(huge_tree=True, encoding=parser_encoding)
            tree = cast(
                xml_etree.ElementTree,
                lxml_etree.parse(source, parser=lxml_parser),
            )
        else:
            xml_parser = xml_etree.XMLParser(encoding=parser_encoding)
            tree = xml_etree.parse(source, parser=xml_parser)

        boolean = tree.find(RESULTS_NS_ET + "boolean")
        results = tree.find(RESULTS_NS_ET + "results")

        if boolean is not None:
            type_ = "ASK"
        elif results is not None:
            type_ = "SELECT"
        else:
            raise ResultException("No RDF result-bindings or boolean answer found!")

        Result.__init__(self, type_)

        if type_ == "SELECT":
            self.bindings = []
            for result in results:  # type: ignore[union-attr]
                if result.tag != f"{RESULTS_NS_ET}result":
                    # This is here because with lxml this also gets comments,
                    # not just elements. Also this should not operate on non
                    # "result" elements.
                    continue
                r = {}
                for binding in result:
                    if binding.tag != f"{RESULTS_NS_ET}binding":
                        # This is here because with lxml this also gets
                        # comments, not just elements. Also this should not
                        # operate on non "binding" elements.
                        continue
                    # type error: error: Argument 1 to "Variable" has incompatible type "Union[str, None, Any]"; expected "str"
                    # NOTE on type error: Element.get() can return None, and
                    # this will invariably fail if passed into Variable
                    # constructor as value
                    r[Variable(binding.get("name"))] = parseTerm(binding[0])  # type: ignore[arg-type] # FIXME
                self.bindings.append(r)

            self.vars = [
                # type error: Argument 1 to "Variable" has incompatible type "Optional[str]"; expected "str"
                # NOTE on type error: Element.get() can return None, and this
                # will invariably fail if passed into Variable constructor as
                # value
                Variable(x.get("name"))  # type: ignore[arg-type] # FIXME
                for x in tree.findall(
                    "./%shead/%svariable" % (RESULTS_NS_ET, RESULTS_NS_ET)
                )
            ]

        else:
            self.askAnswer = boolean.text.lower().strip() == "true"  # type: ignore[union-attr]


def parseTerm(element: xml_etree.Element) -> Union[URIRef, Literal, BNode]:
    """rdflib object (Literal, URIRef, BNode) for the given
    elementtree element"""
    tag, text = element.tag, element.text
    if tag == RESULTS_NS_ET + "literal":
        if text is None:
            text = ""
        datatype = None
        lang = None
        if element.get("datatype", None):
            # type error: Argument 1 to "URIRef" has incompatible type "Optional[str]"; expected "str"
            datatype = URIRef(element.get("datatype"))  # type: ignore[arg-type]
        elif element.get("{%s}lang" % XML_NAMESPACE, None):
            lang = element.get("{%s}lang" % XML_NAMESPACE)

        ret = Literal(text, datatype=datatype, lang=lang)

        return ret
    elif tag == RESULTS_NS_ET + "uri":
        # type error: Argument 1 to "URIRef" has incompatible type "Optional[str]"; expected "str"
        return URIRef(text)  # type: ignore[arg-type]
    elif tag == RESULTS_NS_ET + "bnode":
        return BNode(text)
    else:
        raise TypeError("unknown binding type %r" % element)


class XMLResultSerializer(ResultSerializer):
    """Serializes SPARQL results into XML format."""

    def __init__(self, result: Result):
        ResultSerializer.__init__(self, result)

    def serialize(self, stream: IO, encoding: str = "utf-8", **kwargs: Any) -> None:
        writer = SPARQLXMLWriter(stream, encoding)
        if self.result.type == "ASK":
            writer.write_header([])
            # type error: Argument 1 to "write_ask" of "SPARQLXMLWriter" has incompatible type "Optional[bool]"; expected "bool"
            writer.write_ask(self.result.askAnswer)  # type: ignore[arg-type]
        else:
            # type error: Argument 1 to "write_header" of "SPARQLXMLWriter" has incompatible type "Optional[List[Variable]]"; expected "Sequence[Variable]"
            writer.write_header(self.result.vars)  # type: ignore[arg-type]
            writer.write_results_header()
            for b in self.result.bindings:
                writer.write_start_result()
                for key, val in b.items():
                    writer.write_binding(key, val)

                writer.write_end_result()

        writer.close()


# TODO: Rewrite with ElementTree?
class SPARQLXMLWriter:
    """
    Python saxutils-based SPARQL XML Writer
    """

    def __init__(self, output: IO, encoding: str = "utf-8"):
        writer = XMLGenerator(output, encoding)
        writer.startDocument()
        writer.startPrefixMapping("", SPARQL_XML_NAMESPACE)
        writer.startPrefixMapping("xml", XML_NAMESPACE)
        writer.startElementNS(
            (SPARQL_XML_NAMESPACE, "sparql"), "sparql", AttributesNSImpl({}, {})
        )
        self.writer = writer
        self._output = output
        self._encoding = encoding
        self._results = False

    def write_header(self, allvarsL: Sequence[Variable]) -> None:
        self.writer.startElementNS(
            (SPARQL_XML_NAMESPACE, "head"), "head", AttributesNSImpl({}, {})
        )
        for i in range(0, len(allvarsL)):
            attr_vals = {
                (None, "name"): str(allvarsL[i]),
            }
            attr_qnames = {
                (None, "name"): "name",
            }
            self.writer.startElementNS(
                (SPARQL_XML_NAMESPACE, "variable"),
                "variable",
                # type error: Argument 1 to "AttributesNSImpl" has incompatible type "Dict[Tuple[None, str], str]"; expected "Mapping[Tuple[str, str], str]"
                # type error: Argument 2 to "AttributesNSImpl" has incompatible type "Dict[Tuple[None, str], str]"; expected "Mapping[Tuple[str, str], str]"  [arg-type]
                AttributesNSImpl(attr_vals, attr_qnames),  # type: ignore[arg-type]
            )
            self.writer.endElementNS((SPARQL_XML_NAMESPACE, "variable"), "variable")
        self.writer.endElementNS((SPARQL_XML_NAMESPACE, "head"), "head")

    def write_ask(self, val: bool) -> None:
        self.writer.startElementNS(
            (SPARQL_XML_NAMESPACE, "boolean"), "boolean", AttributesNSImpl({}, {})
        )
        self.writer.characters(str(val).lower())
        self.writer.endElementNS((SPARQL_XML_NAMESPACE, "boolean"), "boolean")

    def write_results_header(self) -> None:
        self.writer.startElementNS(
            (SPARQL_XML_NAMESPACE, "results"), "results", AttributesNSImpl({}, {})
        )
        self._results = True

    def write_start_result(self) -> None:
        self.writer.startElementNS(
            (SPARQL_XML_NAMESPACE, "result"), "result", AttributesNSImpl({}, {})
        )
        self._resultStarted = True

    def write_end_result(self) -> None:
        assert self._resultStarted
        self.writer.endElementNS((SPARQL_XML_NAMESPACE, "result"), "result")
        self._resultStarted = False

    def write_binding(self, name: Variable, val: Identifier) -> None:
        assert self._resultStarted

        attr_vals: Dict[Tuple[Optional[str], str], str] = {
            (None, "name"): str(name),
        }
        attr_qnames: Dict[Tuple[Optional[str], str], str] = {
            (None, "name"): "name",
        }
        self.writer.startElementNS(
            (SPARQL_XML_NAMESPACE, "binding"),
            "binding",
            # type error: Argument 1 to "AttributesNSImpl" has incompatible type "Dict[Tuple[None, str], str]"; expected "Mapping[Tuple[str, str], str]"
            # type error: Argument 2 to "AttributesNSImpl" has incompatible type "Dict[Tuple[None, str], str]"; expected "Mapping[Tuple[str, str], str]"
            AttributesNSImpl(attr_vals, attr_qnames),  # type: ignore[arg-type, unused-ignore]
        )

        if isinstance(val, URIRef):
            self.writer.startElementNS(
                (SPARQL_XML_NAMESPACE, "uri"), "uri", AttributesNSImpl({}, {})
            )
            self.writer.characters(val)
            self.writer.endElementNS((SPARQL_XML_NAMESPACE, "uri"), "uri")
        elif isinstance(val, BNode):
            self.writer.startElementNS(
                (SPARQL_XML_NAMESPACE, "bnode"), "bnode", AttributesNSImpl({}, {})
            )
            self.writer.characters(val)
            self.writer.endElementNS((SPARQL_XML_NAMESPACE, "bnode"), "bnode")
        elif isinstance(val, Literal):
            attr_vals = {}
            attr_qnames = {}
            if val.language:
                attr_vals[(XML_NAMESPACE, "lang")] = val.language
                attr_qnames[(XML_NAMESPACE, "lang")] = "xml:lang"
            elif val.datatype:
                attr_vals[(None, "datatype")] = val.datatype
                attr_qnames[(None, "datatype")] = "datatype"

            self.writer.startElementNS(
                (SPARQL_XML_NAMESPACE, "literal"),
                "literal",
                # type error: Argument 1 to "AttributesNSImpl" has incompatible type "Dict[Tuple[Optional[str], str], str]"; expected "Mapping[Tuple[str, str], str]"
                # type error: Argument 2 to "AttributesNSImpl" has incompatible type "Dict[Tuple[Optional[str], str], str]"; expected "Mapping[Tuple[str, str], str]"
                AttributesNSImpl(attr_vals, attr_qnames),  # type: ignore[arg-type, unused-ignore]
            )
            self.writer.characters(val)
            self.writer.endElementNS((SPARQL_XML_NAMESPACE, "literal"), "literal")

        else:
            raise Exception("Unsupported RDF term: %s" % val)

        self.writer.endElementNS((SPARQL_XML_NAMESPACE, "binding"), "binding")

    def close(self) -> None:
        if self._results:
            self.writer.endElementNS((SPARQL_XML_NAMESPACE, "results"), "results")
        self.writer.endElementNS((SPARQL_XML_NAMESPACE, "sparql"), "sparql")
        self.writer.endDocument()
