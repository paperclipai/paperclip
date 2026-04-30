"""
Turtle RDF graph serializer for RDFLib.
See <http://www.w3.org/TeamSubmission/turtle/> for syntax specification.
"""

from __future__ import annotations

import re
import warnings
from collections import defaultdict
from typing import (
    IO,
    TYPE_CHECKING,
    Any,
    DefaultDict,
    Dict,
    List,
    Mapping,
    Optional,
    Sequence,
    Tuple,
    TypeVar,
    Union,
)

from rdflib.exceptions import Error
from rdflib.graph import Graph
from rdflib.namespace import RDF, RDFS
from rdflib.serializer import Serializer
from rdflib.term import BNode, Literal, Node, URIRef

_StrT = TypeVar("_StrT", bound=str)

if TYPE_CHECKING:
    from rdflib.graph import _PredicateType, _SubjectType, _TripleType

__all__ = ["RecursiveSerializer", "TurtleSerializer"]


class RecursiveSerializer(Serializer):
    """Base class for recursive serializers."""

    topClasses = [RDFS.Class]
    predicateOrder = [RDF.type, RDFS.label]
    maxDepth = 10
    indentString = "  "
    roundtrip_prefixes: Tuple[Any, ...] = ()
    LOCALNAME_PECRENT_CHARACTER_REQUIRING_ESCAPE_REGEX = re.compile(
        r"%(?![0-9A-Fa-f]{2})"
    )

    def __init__(self, store: Graph):
        super(RecursiveSerializer, self).__init__(store)
        self.stream: Optional[IO[bytes]] = None
        self.reset()

    def addNamespace(self, prefix: str, uri: URIRef) -> None:
        if prefix in self.namespaces and self.namespaces[prefix] != uri:
            raise Exception(
                "Trying to override namespace prefix %s => %s, but it's already bound to %s"
                % (prefix, uri, self.namespaces[prefix])
            )
        self.namespaces[prefix] = uri

    def checkSubject(self, subject: _SubjectType) -> bool:
        """Check to see if the subject should be serialized yet"""
        if (
            (self.isDone(subject))
            or (subject not in self._subjects)
            or ((subject in self._topLevels) and (self.depth > 1))
            or (isinstance(subject, URIRef) and (self.depth >= self.maxDepth))
        ):
            return False
        return True

    def isDone(self, subject: _SubjectType) -> bool:
        """Return true if subject is serialized"""
        return subject in self._serialized

    def orderSubjects(self) -> List[_SubjectType]:
        seen: Dict[_SubjectType, bool] = {}
        subjects: List[_SubjectType] = []

        for classURI in self.topClasses:
            members = list(self.store.subjects(RDF.type, classURI))
            # type error: All overload variants of "sort" of "list" require at least one argument
            members.sort()  # type: ignore[call-overload]

            subjects.extend(members)
            for member in members:
                self._topLevels[member] = True
                seen[member] = True

        recursable = [
            (isinstance(subject, BNode), self._references[subject], subject)
            for subject in self._subjects
            if subject not in seen
        ]

        recursable.sort()
        subjects.extend([subject for (isbnode, refs, subject) in recursable])

        return subjects

    def preprocess(self) -> None:
        for triple in self.store.triples((None, None, None)):
            self.preprocessTriple(triple)

    def preprocessTriple(self, spo: _TripleType) -> None:
        s, p, o = spo
        self._references[o] += 1
        self._subjects[s] = True

    def reset(self) -> None:
        self.depth = 0
        # Typed none because nothing is using it ...
        self.lists: Dict[None, None] = {}
        self.namespaces: Dict[str, URIRef] = {}
        self._references: DefaultDict[Node, int] = defaultdict(int)
        self._serialized: Dict[_SubjectType, bool] = {}
        self._subjects: Dict[_SubjectType, bool] = {}
        self._topLevels: Dict[_SubjectType, bool] = {}

        if self.roundtrip_prefixes:
            if hasattr(self.roundtrip_prefixes, "__iter__"):
                for prefix, ns in self.store.namespaces():
                    if prefix in self.roundtrip_prefixes:
                        self.addNamespace(prefix, ns)
            else:
                for prefix, ns in self.store.namespaces():
                    self.addNamespace(prefix, ns)

    def buildPredicateHash(
        self, subject: _SubjectType
    ) -> Mapping[_PredicateType, List[Node]]:
        """
        Build a hash key by predicate to a list of objects for the given
        subject
        """
        properties: Dict[_PredicateType, List[Node]] = {}
        for s, p, o in self.store.triples((subject, None, None)):
            oList = properties.get(p, [])
            oList.append(o)
            properties[p] = oList
        return properties

    def sortProperties(
        self, properties: Mapping[_PredicateType, List[Node]]
    ) -> List[_PredicateType]:
        """Take a hash from predicate uris to lists of values.
        Sort the lists of values.  Return a sorted list of properties."""
        # Sort object lists
        for prop, objects in properties.items():
            # type error: All overload variants of "sort" of "list" require at least one argument
            objects.sort()  # type: ignore[call-overload]

        # Make sorted list of properties
        propList: List[_PredicateType] = []
        seen: Dict[_PredicateType, bool] = {}
        for prop in self.predicateOrder:
            if (prop in properties) and (prop not in seen):
                propList.append(prop)
                seen[prop] = True
        props = list(properties.keys())
        # type error: All overload variants of "sort" of "list" require at least one argument
        props.sort()  # type: ignore[call-overload]
        for prop in props:
            if prop not in seen:
                propList.append(prop)
                seen[prop] = True
        return propList

    def subjectDone(self, subject: _SubjectType) -> None:
        """Mark a subject as done."""
        self._serialized[subject] = True

    def indent(self, modifier: int = 0) -> str:
        """Returns indent string multiplied by the depth"""
        return (self.depth + modifier) * self.indentString

    def write(self, text: str) -> None:
        """Write text in given encoding."""
        # type error: Item "None" of "Optional[IO[bytes]]" has no attribute "write"
        self.stream.write(text.encode(self.encoding, "replace"))  # type: ignore[union-attr]

    def relativize(self, uri: _StrT) -> Union[_StrT, URIRef]:
        base = self.base
        if (
            base is not None
            and uri.startswith(base)
            and "#" not in uri.replace(base, "")
            and "/" not in uri.replace(base, "")
        ):
            # type error: Incompatible types in assignment (expression has type "str", variable has type "Node")
            uri = URIRef(uri.replace(base, "", 1))  # type: ignore[assignment]
        return uri


SUBJECT = 0
VERB = 1
OBJECT = 2

_GEN_QNAME_FOR_DT = False
_SPACIOUS_OUTPUT = False


class TurtleSerializer(RecursiveSerializer):
    """Turtle RDF graph serializer."""

    short_name = "turtle"
    indentString = "    "
    LOCALNAME_PECRENT_CHARACTER_REQUIRING_ESCAPE_REGEX = re.compile(
        r"%(?![0-9A-Fa-f]{2})"
    )

    def __init__(self, store: Graph):
        self._ns_rewrite: Dict[str, str] = {}
        super(TurtleSerializer, self).__init__(store)
        self.keywords: Dict[Node, str] = {RDF.type: "a"}
        self.reset()
        self.stream = None
        self._spacious = _SPACIOUS_OUTPUT

    # type error: Return type "str" of "addNamespace" incompatible with return type "None" in supertype "RecursiveSerializer"
    def addNamespace(self, prefix: str, namespace: URIRef) -> str:  # type: ignore[override]
        # Turtle does not support prefix that start with _
        # if they occur in the graph, rewrite to p_blah
        # this is more complicated since we need to make sure p_blah
        # does not already exist. And we register namespaces as we go, i.e.
        # we may first see a triple with prefix _9 - rewrite it to p_9
        # and then later find a triple with a "real" p_9 prefix

        # so we need to keep track of ns rewrites we made so far.

        if (prefix > "" and prefix[0] == "_") or self.namespaces.get(
            prefix, namespace
        ) != namespace:
            if prefix not in self._ns_rewrite:
                p = "p" + prefix
                while p in self.namespaces:
                    p = "p" + p
                self._ns_rewrite[prefix] = p

            prefix = self._ns_rewrite.get(prefix, prefix)

        super(TurtleSerializer, self).addNamespace(prefix, namespace)
        return prefix

    def reset(self) -> None:
        super(TurtleSerializer, self).reset()
        # typing as Dict[None, None] because nothing seems to be using it
        self._shortNames: Dict[None, None] = {}
        self._started = False
        self._ns_rewrite = {}

    def serialize(
        self,
        stream: IO[bytes],
        base: Optional[str] = None,
        encoding: Optional[str] = None,
        spacious: Optional[bool] = None,
        **kwargs: Any,
    ) -> None:
        self.reset()
        self.stream = stream
        # if base is given here, use that, if not and a base is set for the graph use that
        if base is not None:
            self.base = base
        elif self.store.base is not None:
            self.base = self.store.base

        if spacious is not None:
            self._spacious = spacious

        self.preprocess()
        subjects_list = self.orderSubjects()

        self.startDocument()

        firstTime = True
        for subject in subjects_list:
            if self.isDone(subject):
                continue
            if firstTime:
                firstTime = False
            if self.statement(subject) and not firstTime:
                self.write("\n")

        self.endDocument()
        stream.write("\n".encode("latin-1"))

        self.base = None

    def preprocessTriple(self, triple: _TripleType) -> None:
        super(TurtleSerializer, self).preprocessTriple(triple)
        for i, node in enumerate(triple):
            if i == VERB:
                if node in self.keywords:
                    # predicate is a keyword
                    continue
                if (
                    self.base is not None
                    and isinstance(node, URIRef)
                    and node.startswith(self.base)
                    and "#" not in node.replace(self.base, "")
                    and "/" not in node.replace(self.base, "")
                ):
                    # predicate corresponds to base namespace
                    continue
            # Don't use generated prefixes for subjects and objects
            self.get_pname(node, gen_prefix=(i == VERB))
            if isinstance(node, Literal) and node.datatype:
                self.get_pname(node.datatype, gen_prefix=_GEN_QNAME_FOR_DT)
        p = triple[1]
        if isinstance(p, BNode):  # hmm - when is P ever a bnode?
            self._references[p] += 1

    # Refer to Productions for terminals PNAME_NS and PNAME_LN https://www.w3.org/TR/turtle/#sec-grammar-grammar
    def get_pname(self, uri: Node, gen_prefix: bool = True) -> Optional[str]:
        if not isinstance(uri, URIRef):
            return None

        parts = None

        try:
            parts = self.store.compute_qname(uri, generate=gen_prefix)
        except Exception:
            # is the uri a namespace in itself?
            pfx = self.store.store.prefix(uri)

            if pfx is not None:
                parts = (pfx, uri, "")
            else:
                # nothing worked
                return None

        prefix, namespace, local = parts

        # To understand treatment of % character refer to Productions for terminal PLX at
        # https://www.w3.org/TR/turtle/#grammar-production-PLX
        # Only % NOT followed by two hex chars requires manual backslash escaping
        local = local.replace(r"(", r"\(").replace(r")", r"\)")
        local = self.LOCALNAME_PECRENT_CHARACTER_REQUIRING_ESCAPE_REGEX.sub(
            "\\%", local
        )

        # PName cannot end with .
        if local.endswith("."):
            return None

        prefix = self.addNamespace(prefix, namespace)

        return "%s:%s" % (prefix, local)

    def getQName(self, uri: Node, gen_prefix: bool = True) -> Optional[str]:
        warnings.warn(
            "TurtleSerializer.getQName is deprecated, use TurtleSerializer.get_pname instead.",
            DeprecationWarning,
            stacklevel=2,
        )
        return self.get_pname(uri, gen_prefix)

    def startDocument(self) -> None:
        self._started = True
        ns_list = sorted(self.namespaces.items())

        if self.base:
            self.write(self.indent() + "@base <%s> .\n" % self.base)
        for prefix, uri in ns_list:
            self.write(self.indent() + "@prefix %s: <%s> .\n" % (prefix, uri))
        if ns_list and self._spacious:
            self.write("\n")

    def endDocument(self) -> None:
        if self._spacious:
            self.write("\n")

    def statement(self, subject: _SubjectType) -> bool:
        self.subjectDone(subject)
        return self.s_squared(subject) or self.s_default(subject)

    def s_default(self, subject: _SubjectType) -> bool:
        self.write("\n" + self.indent())
        self.path(subject, SUBJECT)
        self.predicateList(subject)
        self.write(" .")
        return True

    def s_squared(self, subject: _SubjectType) -> bool:
        if (self._references[subject] > 0) or not isinstance(subject, BNode):
            return False
        self.write("\n" + self.indent() + "[]")
        self.predicateList(subject)
        self.write(" .")
        return True

    def path(self, node: Node, position: int, newline: bool = False) -> None:
        if not (
            self.p_squared(node, position, newline)
            or self.p_default(node, position, newline)
        ):
            raise Error("Cannot serialize node '%s'" % (node,))

    def p_default(self, node: Node, position: int, newline: bool = False) -> bool:
        if position != SUBJECT and not newline:
            self.write(" ")
        self.write(self.label(node, position))
        return True

    def label(self, node: Node, position: int) -> str:
        if node == RDF.nil:
            return "()"
        if position is VERB and node in self.keywords:
            return self.keywords[node]
        if isinstance(node, Literal):
            return node._literal_n3(
                use_plain=True,
                qname_callback=lambda dt: self.get_pname(dt, _GEN_QNAME_FOR_DT),
            )
        else:
            node = self.relativize(node)  # type: ignore[type-var]

            return self.get_pname(node, position == VERB) or node.n3()

    def p_squared(self, node: Node, position: int, newline: bool = False) -> bool:
        if (
            not isinstance(node, BNode)
            or node in self._serialized
            or self._references[node] > 1
            or position == SUBJECT
        ):
            return False

        if not newline:
            self.write(" ")

        if self.isValidList(node):
            # this is a list
            self.write("(")
            self.depth += 1  # 2
            self.doList(node)
            self.depth -= 1  # 2
            self.write(" )")
        else:
            self.subjectDone(node)
            self.depth += 2
            # self.write('[\n' + self.indent())
            self.write("[")
            self.depth -= 1
            # self.predicateList(node, newline=True)
            self.predicateList(node, newline=False)
            # self.write('\n' + self.indent() + ']')
            self.write(" ]")
            self.depth -= 1

        return True

    def isValidList(self, l_: Node) -> bool:
        """
        Checks if l is a valid RDF list, i.e. no nodes have other properties.
        """
        try:
            if self.store.value(l_, RDF.first) is None:
                return False
        except Exception:
            return False
        while l_:
            if l_ != RDF.nil and len(list(self.store.predicate_objects(l_))) != 2:
                return False
            # type error: Incompatible types in assignment (expression has type "Optional[Node]", variable has type "Node")
            l_ = self.store.value(l_, RDF.rest)  # type: ignore[assignment]
        return True

    def doList(self, l_: Node) -> None:
        while l_:
            item = self.store.value(l_, RDF.first)
            if item is not None:
                self.path(item, OBJECT)
                self.subjectDone(l_)
            # type error: Incompatible types in assignment (expression has type "Optional[Node]", variable has type "Node")
            l_ = self.store.value(l_, RDF.rest)  # type: ignore[assignment]

    def predicateList(self, subject: Node, newline: bool = False) -> None:
        properties = self.buildPredicateHash(subject)
        propList = self.sortProperties(properties)
        if len(propList) == 0:
            return
        self.verb(propList[0], newline=newline)
        self.objectList(properties[propList[0]])
        for predicate in propList[1:]:
            self.write(" ;\n" + self.indent(1))
            self.verb(predicate, newline=True)
            self.objectList(properties[predicate])

    def verb(self, node: Node, newline: bool = False) -> None:
        self.path(node, VERB, newline)

    def objectList(self, objects: Sequence[Node]) -> None:
        count = len(objects)
        if count == 0:
            return
        depthmod = (count == 1) and 0 or 1
        self.depth += depthmod
        self.path(objects[0], OBJECT)
        for obj in objects[1:]:
            self.write(",\n" + self.indent(1))
            self.path(obj, OBJECT, newline=True)
        self.depth -= depthmod
