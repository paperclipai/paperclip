"""
An RDF/XML parser for RDFLib
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict, List, NoReturn, Optional, Tuple
from urllib.parse import urldefrag, urljoin
from xml.sax import handler, make_parser, xmlreader
from xml.sax.handler import ErrorHandler
from xml.sax.saxutils import escape, quoteattr

from rdflib.exceptions import Error, ParserError
from rdflib.graph import Graph
from rdflib.namespace import RDF, is_ncname
from rdflib.parser import InputSource, Parser
from rdflib.plugins.parsers.RDFVOC import RDFVOC
from rdflib.term import BNode, Identifier, Literal, URIRef

if TYPE_CHECKING:
    # from xml.sax.expatreader import ExpatLocator
    from xml.sax.xmlreader import AttributesImpl, Locator

    from rdflib.graph import _ObjectType, _SubjectType, _TripleType

__all__ = ["create_parser", "BagID", "ElementHandler", "RDFXMLHandler", "RDFXMLParser"]

RDFNS = RDFVOC

# http://www.w3.org/TR/rdf-syntax-grammar/#eventterm-attribute-URI
# A mapping from unqualified terms to their qualified version.
UNQUALIFIED = {
    "about": RDFVOC.about,
    "ID": RDFVOC.ID,
    "type": RDFVOC.type,
    "resource": RDFVOC.resource,
    "parseType": RDFVOC.parseType,
}

# http://www.w3.org/TR/rdf-syntax-grammar/#coreSyntaxTerms
CORE_SYNTAX_TERMS = [
    RDFVOC.RDF,
    RDFVOC.ID,
    RDFVOC.about,
    RDFVOC.parseType,
    RDFVOC.resource,
    RDFVOC.nodeID,
    RDFVOC.datatype,
]

# http://www.w3.org/TR/rdf-syntax-grammar/#syntaxTerms
SYNTAX_TERMS = CORE_SYNTAX_TERMS + [RDFVOC.Description, RDFVOC.li]

# http://www.w3.org/TR/rdf-syntax-grammar/#oldTerms
OLD_TERMS = [
    URIRef("http://www.w3.org/1999/02/22-rdf-syntax-ns#aboutEach"),
    URIRef("http://www.w3.org/1999/02/22-rdf-syntax-ns#aboutEachPrefix"),
    URIRef("http://www.w3.org/1999/02/22-rdf-syntax-ns#bagID"),
]

NODE_ELEMENT_EXCEPTIONS = (
    CORE_SYNTAX_TERMS
    + [
        RDFVOC.li,
    ]
    + OLD_TERMS
)
NODE_ELEMENT_ATTRIBUTES = [RDFVOC.ID, RDFVOC.nodeID, RDFVOC.about]

PROPERTY_ELEMENT_EXCEPTIONS = (
    CORE_SYNTAX_TERMS
    + [
        RDFVOC.Description,
    ]
    + OLD_TERMS
)
PROPERTY_ATTRIBUTE_EXCEPTIONS = (
    CORE_SYNTAX_TERMS + [RDFVOC.Description, RDFVOC.li] + OLD_TERMS
)
PROPERTY_ELEMENT_ATTRIBUTES = [RDFVOC.ID, RDFVOC.resource, RDFVOC.nodeID]

XMLNS = "http://www.w3.org/XML/1998/namespace"
BASE = (XMLNS, "base")
LANG = (XMLNS, "lang")


class BagID(URIRef):
    __slots__ = ["li"]

    def __init__(self, val):
        # type error: Too many arguments for "__init__" of "object"
        super(URIRef, self).__init__(val)  # type: ignore[call-arg]
        self.li = 0

    def next_li(self):
        self.li += 1
        # type error: Type expected within [...]
        return RDFNS["_%s" % self.li]  # type: ignore[misc]


class ElementHandler:
    __slots__ = [
        "start",
        "char",
        "end",
        "li",
        "id",
        "base",
        "subject",
        "predicate",
        "object",
        "list",
        "language",
        "datatype",
        "declared",
        "data",
    ]

    def __init__(self):
        self.start = None
        self.char = None
        self.end = None
        self.li = 0
        self.id = None
        self.base = None
        self.subject = None
        self.object = None
        self.list = None
        self.language = None
        self.datatype = None
        self.declared = None
        self.data = None

    def next_li(self):
        self.li += 1
        return RDFVOC["_%s" % self.li]


class RDFXMLHandler(handler.ContentHandler):
    def __init__(self, store: Graph):
        self.store = store
        self.preserve_bnode_ids = False
        self.reset()

    def reset(self) -> None:
        document_element = ElementHandler()
        document_element.start = self.document_element_start
        document_element.end = lambda name, qname: None
        self.stack: List[Optional[ElementHandler]] = [
            None,
            document_element,
        ]
        self.ids: Dict[str, int] = {}  # remember IDs we have already seen
        self.bnode: Dict[str, Identifier] = {}
        self._ns_contexts: List[Dict[str, Optional[str]]] = [
            {}
        ]  # contains uri -> prefix dicts
        self._current_context: Dict[str, Optional[str]] = self._ns_contexts[-1]

    # ContentHandler methods

    def setDocumentLocator(self, locator: Locator):
        self.locator = locator

    def startDocument(self) -> None:
        pass

    def startPrefixMapping(self, prefix: Optional[str], namespace: str) -> None:
        self._ns_contexts.append(self._current_context.copy())
        self._current_context[namespace] = prefix
        self.store.bind(prefix, namespace or "", override=False)

    def endPrefixMapping(self, prefix: Optional[str]) -> None:
        self._current_context = self._ns_contexts[-1]
        del self._ns_contexts[-1]

    def startElementNS(
        self, name: Tuple[Optional[str], str], qname, attrs: AttributesImpl
    ) -> None:
        stack = self.stack
        stack.append(ElementHandler())
        current = self.current
        parent = self.parent
        # type error: No overlaod for "get" of "AttributesImpl" mactches tuple (str, str)
        base = attrs.get(BASE, None)  # type: ignore[call-overload, unused-ignore]
        if base is not None:
            base, frag = urldefrag(base)
            if parent and parent.base:
                base = urljoin(parent.base, base)
            else:
                systemId = self.locator.getPublicId() or self.locator.getSystemId()
                if systemId:
                    base = urljoin(systemId, base)
        else:
            if parent:
                base = parent.base
            if base is None:
                systemId = self.locator.getPublicId() or self.locator.getSystemId()
                if systemId:
                    base, frag = urldefrag(systemId)
        current.base = base
        # type error: No overlaod for "get" of "AttributesImpl" mactches tuple (str, str)
        language = attrs.get(LANG, None)  # type: ignore[call-overload, unused-ignore]
        if language is None:
            if parent:
                language = parent.language
        current.language = language
        current.start(name, qname, attrs)

    def endElementNS(self, name: Tuple[Optional[str], str], qname) -> None:
        self.current.end(name, qname)
        self.stack.pop()

    def characters(self, content: str) -> None:
        char = self.current.char
        if char:
            char(content)

    def ignorableWhitespace(self, content) -> None:
        pass

    def processingInstruction(self, target, data) -> None:
        pass

    def add_reified(self, sid: Identifier, spo: _TripleType):
        s, p, o = spo
        self.store.add((sid, RDF.type, RDF.Statement))
        self.store.add((sid, RDF.subject, s))
        self.store.add((sid, RDF.predicate, p))
        self.store.add((sid, RDF.object, o))

    def error(self, message: str) -> NoReturn:
        locator = self.locator
        info = "%s:%s:%s: " % (
            locator.getSystemId(),
            locator.getLineNumber(),
            locator.getColumnNumber(),
        )
        raise ParserError(info + message)

    def get_current(self) -> Optional[ElementHandler]:
        return self.stack[-2]

    # Create a read only property called current so that self.current
    # give the current element handler.
    current = property(get_current)

    def get_next(self) -> Optional[ElementHandler]:
        return self.stack[-1]

    # Create a read only property that gives the element handler to be
    # used for the next element.
    next = property(get_next)

    def get_parent(self) -> Optional[ElementHandler]:
        return self.stack[-3]

    # Create a read only property that gives the current parent
    # element handler
    parent = property(get_parent)

    def absolutize(self, uri: str) -> URIRef:
        # type error: Argument "allow_fragments" to "urljoin" has incompatible type "int"; expected "bool"
        result = urljoin(self.current.base, uri, allow_fragments=1)  # type: ignore[arg-type]
        if uri and uri[-1] == "#" and result[-1] != "#":
            result = "%s#" % result
        return URIRef(result)

    def convert(
        self, name: Tuple[Optional[str], str], qname, attrs: AttributesImpl
    ) -> Tuple[URIRef, Dict[URIRef, str]]:
        if name[0] is None:
            # type error: Incompatible types in assignment (expression has type "URIRef", variable has type "Tuple[Optional[str], str]")
            name = URIRef(name[1])  # type: ignore[assignment]
        else:
            # type error: Incompatible types in assignment (expression has type "URIRef", variable has type "Tuple[Optional[str], str]")
            # type error: Argument 1 to "join" of "str" has incompatible type "Tuple[Optional[str], str]"; expected "Iterable[str]"
            name = URIRef("".join(name))  # type: ignore[assignment, arg-type]
        atts = {}
        for n, v in attrs.items():
            # mypy error: mypy thinks n[0]==None is unreachable
            if n[0] is None:
                att = n[1]  # type: ignore[unreachable, unused-ignore]
            else:
                att = "".join(n)
            if att.startswith(XMLNS) or att[0:3].lower() == "xml":
                pass
            elif att in UNQUALIFIED:
                # if not RDFNS[att] in atts:
                # type error: Variable "att" is not valid as a type
                atts[RDFNS[att]] = v  # type: ignore[misc, valid-type]
            else:
                atts[URIRef(att)] = v
        # type error: Incompatible return value type (got "Tuple[Tuple[Optional[str], str], Dict[Any, Any]]", expected "Tuple[URIRef, Dict[URIRef, str]]")
        return name, atts  # type: ignore[return-value]

    def document_element_start(
        self, name: Tuple[str, str], qname, attrs: AttributesImpl
    ) -> None:
        if name[0] and URIRef("".join(name)) == RDFVOC.RDF:
            # Cheap hack so 2to3 doesn't turn it into __next__
            next = getattr(self, "next")
            next.start = self.node_element_start
            next.end = self.node_element_end
        else:
            self.node_element_start(name, qname, attrs)
            # self.current.end = self.node_element_end
            # TODO... set end to something that sets start such that
            # another element will cause error

    def node_element_start(
        self, name: Tuple[str, str], qname, attrs: AttributesImpl
    ) -> None:
        # type error: Incompatible types in assignment (expression has type "URIRef", variable has type "Tuple[str, str]")
        name, atts = self.convert(name, qname, attrs)  # type: ignore[assignment]
        current = self.current
        absolutize = self.absolutize

        # Cheap hack so 2to3 doesn't turn it into __next__
        next = getattr(self, "next")
        next.start = self.property_element_start
        next.end = self.property_element_end

        if name in NODE_ELEMENT_EXCEPTIONS:
            # type error: Not all arguments converted during string formatting
            self.error("Invalid node element URI: %s" % name)  # type: ignore[str-format]
        subject: _SubjectType
        if RDFVOC.ID in atts:
            if RDFVOC.about in atts or RDFVOC.nodeID in atts:
                self.error("Can have at most one of rdf:ID, rdf:about, and rdf:nodeID")

            id = atts[RDFVOC.ID]
            if not is_ncname(id):
                self.error("rdf:ID value is not a valid NCName: %s" % id)
            subject = absolutize("#%s" % id)
            if subject in self.ids:
                self.error("two elements cannot use the same ID: '%s'" % subject)
            self.ids[subject] = 1  # IDs can only appear once within a document
        elif RDFVOC.nodeID in atts:
            if RDFVOC.ID in atts or RDFVOC.about in atts:
                self.error("Can have at most one of rdf:ID, rdf:about, and rdf:nodeID")
            nodeID = atts[RDFVOC.nodeID]
            if not is_ncname(nodeID):
                self.error("rdf:nodeID value is not a valid NCName: %s" % nodeID)
            if self.preserve_bnode_ids is False:
                if nodeID in self.bnode:
                    subject = self.bnode[nodeID]
                else:
                    subject = BNode()
                    self.bnode[nodeID] = subject
            else:
                subject = BNode(nodeID)
        elif RDFVOC.about in atts:
            if RDFVOC.ID in atts or RDFVOC.nodeID in atts:
                self.error("Can have at most one of rdf:ID, rdf:about, and rdf:nodeID")
            subject = absolutize(atts[RDFVOC.about])
        else:
            subject = BNode()

        if name != RDFVOC.Description:  # S1
            # error: Argument 1 has incompatible type "Tuple[str, str]"; expected "str"
            self.store.add((subject, RDF.type, absolutize(name)))  # type: ignore[arg-type]

        object: _ObjectType
        language = current.language
        for att in atts:
            if not att.startswith(str(RDFNS)):
                predicate = absolutize(att)
                try:
                    object = Literal(atts[att], language)
                except Error as e:
                    # type error: Argument 1 to "error" of "RDFXMLHandler" has incompatible type "Optional[str]"; expected "str"
                    self.error(e.msg)  # type: ignore[arg-type]
            elif att == RDF.type:  # S2
                predicate = RDF.type
                object = absolutize(atts[RDF.type])
            elif att in NODE_ELEMENT_ATTRIBUTES:
                continue
            elif att in PROPERTY_ATTRIBUTE_EXCEPTIONS:  # S3
                self.error("Invalid property attribute URI: %s" % att)
                # type error: Statement is unreachable
                continue  # type: ignore[unreachable] # for when error does not throw an exception
            else:
                predicate = absolutize(att)
                try:
                    object = Literal(atts[att], language)
                except Error as e:
                    # type error: Argument 1 to "error" of "RDFXMLHandler" has incompatible type "Optional[str]"; expected "str"
                    self.error(e.msg)  # type: ignore[arg-type]
            self.store.add((subject, predicate, object))

        current.subject = subject

    def node_element_end(self, name: Tuple[str, str], qname) -> None:
        # repeat node-elements are only allowed
        # at at top-level

        if self.parent.object and self.current != self.stack[2]:
            self.error(
                "Repeat node-elements inside property elements: %s" % "".join(name)
            )

        self.parent.object = self.current.subject

    def property_element_start(
        self, name: Tuple[str, str], qname, attrs: AttributesImpl
    ) -> None:
        # type error: Incompatible types in assignment (expression has type "URIRef", variable has type "Tuple[str, str]")
        name, atts = self.convert(name, qname, attrs)  # type: ignore[assignment]
        current = self.current
        absolutize = self.absolutize

        # Cheap hack so 2to3 doesn't turn it into __next__
        next = getattr(self, "next")
        object: Optional[_ObjectType] = None
        current.data = None
        current.list = None

        # type error: "Tuple[str, str]" has no attribute "startswith"
        if not name.startswith(str(RDFNS)):  # type: ignore[attr-defined]
            # type error: Argument 1 has incompatible type "Tuple[str, str]"; expected "str"
            current.predicate = absolutize(name)  # type: ignore[arg-type]
        elif name == RDFVOC.li:
            current.predicate = current.next_li()
        elif name in PROPERTY_ELEMENT_EXCEPTIONS:
            # type error: Not all arguments converted during string formatting
            self.error("Invalid property element URI: %s" % name)  # type: ignore[str-format]
        else:
            # type error: Argument 1 has incompatible type "Tuple[str, str]"; expected "str"
            current.predicate = absolutize(name)  # type: ignore[arg-type]

        id = atts.get(RDFVOC.ID, None)
        if id is not None:
            if not is_ncname(id):
                self.error("rdf:ID value is not a value NCName: %s" % id)
            current.id = absolutize("#%s" % id)
        else:
            current.id = None

        resource = atts.get(RDFVOC.resource, None)
        nodeID = atts.get(RDFVOC.nodeID, None)
        parse_type = atts.get(RDFVOC.parseType, None)
        if resource is not None and nodeID is not None:
            self.error("Property element cannot have both rdf:nodeID and rdf:resource")
        if resource is not None:
            object = absolutize(resource)
            next.start = self.node_element_start
            next.end = self.node_element_end
        elif nodeID is not None:
            if not is_ncname(nodeID):
                self.error("rdf:nodeID value is not a valid NCName: %s" % nodeID)
            if self.preserve_bnode_ids is False:
                if nodeID in self.bnode:
                    object = self.bnode[nodeID]
                else:
                    subject = BNode()
                    self.bnode[nodeID] = subject
                    object = subject
            else:
                object = subject = BNode(nodeID)
            next.start = self.node_element_start
            next.end = self.node_element_end
        else:
            if parse_type is not None:
                for att in atts:
                    if att != RDFVOC.parseType and att != RDFVOC.ID:
                        self.error("Property attr '%s' now allowed here" % att)
                if parse_type == "Resource":
                    current.subject = object = BNode()
                    current.char = self.property_element_char
                    next.start = self.property_element_start
                    next.end = self.property_element_end
                elif parse_type == "Collection":
                    current.char = None
                    object = current.list = RDF.nil  # BNode()
                    # self.parent.subject
                    next.start = self.node_element_start
                    next.end = self.list_node_element_end
                else:  # if parse_type=="Literal":
                    # All other values are treated as Literal
                    # See: http://www.w3.org/TR/rdf-syntax-grammar/
                    # parseTypeOtherPropertyElt
                    object = Literal("", datatype=RDFVOC.XMLLiteral)
                    current.char = self.literal_element_char
                    current.declared = {XMLNS: "xml"}
                    next.start = self.literal_element_start
                    next.char = self.literal_element_char
                    next.end = self.literal_element_end
                current.object = object
                return
            else:
                object = None
                current.char = self.property_element_char
                next.start = self.node_element_start
                next.end = self.node_element_end

        datatype = current.datatype = atts.get(RDFVOC.datatype, None)
        language = current.language
        if datatype is not None:
            # TODO: check that there are no atts other than datatype and id
            datatype = absolutize(datatype)
        else:
            for att in atts:
                if not att.startswith(str(RDFNS)):
                    predicate = absolutize(att)
                elif att in PROPERTY_ELEMENT_ATTRIBUTES:
                    continue
                elif att in PROPERTY_ATTRIBUTE_EXCEPTIONS:
                    self.error("""Invalid property attribute URI: %s""" % att)
                else:
                    predicate = absolutize(att)
                o: _ObjectType
                if att == RDF.type:
                    o = URIRef(atts[att])
                else:
                    if datatype is not None:
                        # type error: Statement is unreachable
                        language = None  # type: ignore[unreachable]
                    o = Literal(atts[att], language, datatype)

                if object is None:
                    object = BNode()
                self.store.add((object, predicate, o))
        if object is None:
            current.data = ""
            current.object = None
        else:
            current.data = None
            current.object = object

    def property_element_char(self, data: str) -> None:
        current = self.current
        if current.data is not None:
            current.data += data

    def property_element_end(self, name: Tuple[str, str], qname) -> None:
        current = self.current
        if current.data is not None and current.object is None:
            literalLang = current.language
            if current.datatype is not None:
                literalLang = None
            current.object = Literal(current.data, literalLang, current.datatype)
            current.data = None
        if self.next.end == self.list_node_element_end:
            if current.object != RDF.nil:
                self.store.add((current.list, RDF.rest, RDF.nil))
        if current.object is not None:
            self.store.add((self.parent.subject, current.predicate, current.object))
            if current.id is not None:
                self.add_reified(
                    current.id, (self.parent.subject, current.predicate, current.object)
                )
        current.subject = None

    def list_node_element_end(self, name: Tuple[str, str], qname) -> None:
        current = self.current
        if self.parent.list == RDF.nil:
            list = BNode()
            # Removed between 20030123 and 20030905
            # self.store.add((list, RDF.type, LIST))
            self.parent.list = list
            self.store.add((self.parent.list, RDF.first, current.subject))
            self.parent.object = list
            self.parent.char = None
        else:
            list = BNode()
            # Removed between 20030123 and 20030905
            # self.store.add((list, RDF.type, LIST))
            self.store.add((self.parent.list, RDF.rest, list))
            self.store.add((list, RDF.first, current.subject))
            self.parent.list = list

    def literal_element_start(
        self, name: Tuple[str, str], qname, attrs: AttributesImpl
    ) -> None:
        current = self.current
        self.next.start = self.literal_element_start
        self.next.char = self.literal_element_char
        self.next.end = self.literal_element_end
        current.declared = self.parent.declared.copy()
        if name[0]:
            prefix = self._current_context[name[0]]
            if prefix:
                current.object = "<%s:%s" % (prefix, name[1])
            else:
                current.object = "<%s" % name[1]
            if not name[0] in current.declared:  # noqa: E713
                current.declared[name[0]] = prefix
                if prefix:
                    current.object += ' xmlns:%s="%s"' % (prefix, name[0])
                else:
                    current.object += ' xmlns="%s"' % name[0]
        else:
            current.object = "<%s" % name[1]
        # type error: Incompatible types in assignment (expression has type "str", variable has type "Tuple[str, str]")
        for name, value in attrs.items():  # type: ignore[assignment, unused-ignore]
            if name[0]:
                if not name[0] in current.declared:  # noqa: E713
                    current.declared[name[0]] = self._current_context[name[0]]
                name = current.declared[name[0]] + ":" + name[1]
            else:
                # type error: Incompatible types in assignment (expression has type "str", variable has type "Tuple[str, str]")
                name = name[1]  # type: ignore[assignment]
            current.object += " %s=%s" % (name, quoteattr(value))
        current.object += ">"

    def literal_element_char(self, data: str) -> None:
        self.current.object += escape(data)

    def literal_element_end(self, name: Tuple[str, str], qname) -> None:
        if name[0]:
            prefix = self._current_context[name[0]]
            if prefix:
                end = "</%s:%s>" % (prefix, name[1])
            else:
                end = "</%s>" % name[1]
        else:
            end = "</%s>" % name[1]
        self.parent.object += self.current.object + end


def create_parser(target: InputSource, store: Graph) -> xmlreader.XMLReader:
    parser = make_parser()
    try:
        # Workaround for bug in expatreader.py. Needed when
        # expatreader is trying to guess a prefix.
        parser.start_namespace_decl("xml", "http://www.w3.org/XML/1998/namespace")  # type: ignore[attr-defined]
    except AttributeError:
        pass  # Not present in Jython (at least)
    parser.setFeature(handler.feature_namespaces, 1)
    rdfxml = RDFXMLHandler(store)
    # type error: Argument 1 to "setDocumentLocator" of "RDFXMLHandler" has incompatible type "InputSource"; expected "Locator"
    rdfxml.setDocumentLocator(target)  # type: ignore[arg-type]
    # rdfxml.setDocumentLocator(_Locator(self.url, self.parser))
    parser.setContentHandler(rdfxml)
    parser.setErrorHandler(ErrorHandler())
    return parser


class RDFXMLParser(Parser):
    """An RDF/XML parser."""

    def __init__(self):
        pass

    def parse(self, source: InputSource, sink: Graph, **args: Any) -> None:
        self._parser = create_parser(source, sink)
        content_handler = self._parser.getContentHandler()
        preserve_bnode_ids = args.get("preserve_bnode_ids", None)
        if preserve_bnode_ids is not None:
            # type error: ContentHandler has no attribute "preserve_bnode_ids"
            content_handler.preserve_bnode_ids = preserve_bnode_ids  # type: ignore[attr-defined, unused-ignore]
        # # We're only using it once now
        # content_handler.reset()
        # self._parser.reset()
        self._parser.parse(source)
