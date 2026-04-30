from __future__ import annotations

import xml.dom.minidom
from typing import IO, Any, Dict, Generator, Optional, Set, Tuple
from xml.sax.saxutils import escape, quoteattr

from rdflib.collection import Collection
from rdflib.graph import Graph
from rdflib.namespace import RDF, RDFS, Namespace  # , split_uri
from rdflib.plugins.parsers.RDFVOC import RDFVOC
from rdflib.plugins.serializers.xmlwriter import XMLWriter
from rdflib.serializer import Serializer
from rdflib.term import BNode, IdentifiedNode, Identifier, Literal, Node, URIRef
from rdflib.util import first, more_than

from .xmlwriter import ESCAPE_ENTITIES

__all__ = ["fix", "XMLSerializer", "PrettyXMLSerializer"]


class XMLSerializer(Serializer):
    """RDF/XML RDF graph serializer."""

    def __init__(self, store: Graph):
        super(XMLSerializer, self).__init__(store)

    def __bindings(self) -> Generator[Tuple[str, URIRef], None, None]:
        store = self.store
        nm = store.namespace_manager
        bindings: Dict[str, URIRef] = {}

        for predicate in set(store.predicates()):
            # type error: Argument 1 to "compute_qname_strict" of "NamespaceManager" has incompatible type "Node"; expected "str"
            prefix, namespace, name = nm.compute_qname_strict(predicate)  # type: ignore[arg-type]
            bindings[prefix] = URIRef(namespace)

        RDFNS = URIRef("http://www.w3.org/1999/02/22-rdf-syntax-ns#")  # noqa: N806

        if "rdf" in bindings:
            assert bindings["rdf"] == RDFNS
        else:
            bindings["rdf"] = RDFNS

        for prefix, namespace in bindings.items():
            yield prefix, namespace

    def serialize(
        self,
        stream: IO[bytes],
        base: Optional[str] = None,
        encoding: Optional[str] = None,
        **kwargs: Any,
    ) -> None:
        # if base is given here, use that, if not and a base is set for the graph use that
        if base is not None:
            self.base = base
        elif self.store.base is not None:
            self.base = self.store.base
        self.__stream = stream
        self.__serialized: Dict[Identifier, int] = {}
        encoding = self.encoding
        self.write = write = lambda uni: stream.write(uni.encode(encoding, "replace"))

        # startDocument
        write('<?xml version="1.0" encoding="%s"?>\n' % self.encoding)

        # startRDF
        write("<rdf:RDF\n")

        # If provided, write xml:base attribute for the RDF
        if "xml_base" in kwargs:
            write('   xml:base="%s"\n' % kwargs["xml_base"])
        elif self.base:
            write('   xml:base="%s"\n' % self.base)
        # TODO:
        # assert(
        #    namespaces["http://www.w3.org/1999/02/22-rdf-syntax-ns#"]=='rdf')
        bindings = list(self.__bindings())
        bindings.sort()

        for prefix, namespace in bindings:
            if prefix:
                write('   xmlns:%s="%s"\n' % (prefix, namespace))
            else:
                write('   xmlns="%s"\n' % namespace)
        write(">\n")

        # write out triples by subject
        for subject in self.store.subjects():
            # type error: Argument 1 to "subject" of "XMLSerializer" has incompatible type "Node"; expected "Identifier"
            self.subject(subject, 1)  # type: ignore[arg-type]

        # endRDF
        write("</rdf:RDF>\n")

        # Set to None so that the memory can get garbage collected.
        # self.__serialized = None
        del self.__serialized

    def subject(self, subject: Identifier, depth: int = 1) -> None:
        if subject not in self.__serialized:
            self.__serialized[subject] = 1

            if isinstance(subject, (BNode, URIRef)):
                write = self.write
                indent = "  " * depth
                element_name = "rdf:Description"

                if isinstance(subject, BNode):
                    write('%s<%s rdf:nodeID="%s"' % (indent, element_name, subject))
                else:
                    uri = quoteattr(self.relativize(subject))
                    write("%s<%s rdf:about=%s" % (indent, element_name, uri))

                if (subject, None, None) in self.store:
                    write(">\n")

                    for predicate, object in self.store.predicate_objects(subject):
                        # type error: Argument 1 to "predicate" of "XMLSerializer" has incompatible type "Node"; expected "Identifier"
                        # type error: Argument 2 to "predicate" of "XMLSerializer" has incompatible type "Node"; expected "Identifier"
                        self.predicate(predicate, object, depth + 1)  # type: ignore[arg-type]
                    write("%s</%s>\n" % (indent, element_name))

                else:
                    write("/>\n")

    def predicate(
        self, predicate: Identifier, object: Identifier, depth: int = 1
    ) -> None:
        write = self.write
        indent = "  " * depth
        qname = self.store.namespace_manager.qname_strict(predicate)

        if isinstance(object, Literal):
            attributes = ""

            if object.language:
                attributes += ' xml:lang="%s"' % object.language

            if object.datatype:
                attributes += ' rdf:datatype="%s"' % object.datatype

            write(
                "%s<%s%s>%s</%s>\n"
                % (indent, qname, attributes, escape(object, ESCAPE_ENTITIES), qname)
            )
        else:
            if isinstance(object, BNode):
                write('%s<%s rdf:nodeID="%s"/>\n' % (indent, qname, object))
            else:
                write(
                    "%s<%s rdf:resource=%s/>\n"
                    % (indent, qname, quoteattr(self.relativize(object)))
                )


XMLLANG = "http://www.w3.org/XML/1998/namespacelang"
XMLBASE = "http://www.w3.org/XML/1998/namespacebase"
OWL_NS = Namespace("http://www.w3.org/2002/07/owl#")


# TODO:
def fix(val: str) -> str:
    "strip off _: from nodeIDs... as they are not valid NCNames"
    if val.startswith("_:"):
        return val[2:]
    else:
        return val


class PrettyXMLSerializer(Serializer):
    """Pretty RDF/XML RDF graph serializer."""

    def __init__(self, store: Graph, max_depth=3):
        super(PrettyXMLSerializer, self).__init__(store)
        self.forceRDFAbout: Set[URIRef] = set()

    def serialize(
        self,
        stream: IO[bytes],
        base: Optional[str] = None,
        encoding: Optional[str] = None,
        **kwargs: Any,
    ) -> None:
        self.__serialized: Dict[Identifier, int] = {}
        store = self.store
        # if base is given here, use that, if not and a base is set for the graph use that
        if base is not None:
            self.base = base
        elif store.base is not None:
            self.base = store.base
        self.max_depth = kwargs.get("max_depth", 3)
        assert self.max_depth > 0, "max_depth must be greater than 0"

        self.nm = nm = store.namespace_manager
        self.writer = writer = XMLWriter(stream, nm, encoding)
        namespaces = {}

        possible: Set[Node] = set(store.predicates()).union(
            store.objects(None, RDF.type)
        )

        for predicate in possible:
            # type error: Argument 1 to "compute_qname_strict" of "NamespaceManager" has incompatible type "Node"; expected "str"
            prefix, namespace, local = nm.compute_qname_strict(predicate)  # type: ignore[arg-type]
            namespaces[prefix] = namespace

        namespaces["rdf"] = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"

        writer.push(RDFVOC.RDF)

        if "xml_base" in kwargs:
            writer.attribute(XMLBASE, kwargs["xml_base"])
        elif self.base:
            writer.attribute(XMLBASE, self.base)

        writer.namespaces(namespaces.items())

        subject: IdentifiedNode
        # Write out subjects that can not be inline
        # type error: Incompatible types in assignment (expression has type "Node", variable has type "IdentifiedNode")
        for subject in store.subjects():  # type: ignore[assignment]
            if (None, None, subject) in store:
                if (subject, None, subject) in store:
                    self.subject(subject, 1)
            else:
                self.subject(subject, 1)

        # write out anything that has not yet been reached
        # write out BNodes last (to ensure they can be inlined where possible)
        bnodes = set()

        # type error: Incompatible types in assignment (expression has type "Node", variable has type "IdentifiedNode")
        for subject in store.subjects():  # type: ignore[assignment]
            if isinstance(subject, BNode):
                bnodes.add(subject)
                continue
            self.subject(subject, 1)

        # now serialize only those BNodes that have not been serialized yet
        for bnode in bnodes:
            if bnode not in self.__serialized:
                self.subject(subject, 1)

        writer.pop(RDFVOC.RDF)
        stream.write("\n".encode("latin-1"))

        # Set to None so that the memory can get garbage collected.
        self.__serialized = None  # type: ignore[assignment]

    def subject(self, subject: Identifier, depth: int = 1):
        store = self.store
        writer = self.writer

        if subject in self.forceRDFAbout:
            writer.push(RDFVOC.Description)
            writer.attribute(RDFVOC.about, self.relativize(subject))
            writer.pop(RDFVOC.Description)
            self.forceRDFAbout.remove(subject)  # type: ignore[arg-type]

        elif subject not in self.__serialized:
            self.__serialized[subject] = 1
            type = first(store.objects(subject, RDF.type))

            try:
                # type error: Argument 1 to "qname" of "NamespaceManager" has incompatible type "Optional[Node]"; expected "str"
                self.nm.qname(type)  # type: ignore[arg-type]
            except Exception:
                type = None

            element = type or RDFVOC.Description
            # type error: Argument 1 to "push" of "XMLWriter" has incompatible type "Node"; expected "str"
            writer.push(element)  # type: ignore[arg-type]

            if isinstance(subject, BNode):

                def subj_as_obj_more_than(ceil):
                    return True
                    # more_than(store.triples((None, None, subject)), ceil)

                # here we only include BNode labels if they are referenced
                # more than once (this reduces the use of redundant BNode
                # identifiers)
                if subj_as_obj_more_than(1):
                    writer.attribute(RDFVOC.nodeID, fix(subject))

            else:
                writer.attribute(RDFVOC.about, self.relativize(subject))

            if (subject, None, None) in store:
                for predicate, object in store.predicate_objects(subject):
                    if not (predicate == RDF.type and object == type):
                        # type error: Argument 1 to "predicate" of "PrettyXMLSerializer" has incompatible type "Node"; expected "Identifier"
                        # type error: Argument 2 to "predicate" of "PrettyXMLSerializer" has incompatible type "Node"; expected "Identifier"
                        self.predicate(predicate, object, depth + 1)  # type: ignore[arg-type]

            # type error: Argument 1 to "pop" of "XMLWriter" has incompatible type "Node"; expected "Optional[str]"
            writer.pop(element)  # type: ignore[arg-type]

        elif subject in self.forceRDFAbout:
            # TODO FIXME?: this looks like a duplicate of first condition
            writer.push(RDFVOC.Description)
            writer.attribute(RDFVOC.about, self.relativize(subject))
            writer.pop(RDFVOC.Description)
            self.forceRDFAbout.remove(subject)  # type: ignore[arg-type]

    def predicate(
        self, predicate: Identifier, object: Identifier, depth: int = 1
    ) -> None:
        writer = self.writer
        store = self.store
        writer.push(predicate)

        if isinstance(object, Literal):
            if object.language:
                writer.attribute(XMLLANG, object.language)

            if object.datatype == RDF.XMLLiteral and isinstance(
                object.value, xml.dom.minidom.Document
            ):
                writer.attribute(RDFVOC.parseType, "Literal")
                writer.text("")
                writer.stream.write(object)
            else:
                if object.datatype:
                    writer.attribute(RDFVOC.datatype, object.datatype)
                writer.text(object)

        elif (
            object in self.__serialized
            or not (object, None, None) in store  # noqa: E713
        ):
            if isinstance(object, BNode):
                if more_than(store.triples((None, None, object)), 0):
                    writer.attribute(RDFVOC.nodeID, fix(object))
            else:
                writer.attribute(RDFVOC.resource, self.relativize(object))

        else:
            if first(store.objects(object, RDF.first)):  # may not have type
                # RDF.List

                self.__serialized[object] = 1

                # Warn that any assertions on object other than
                # RDF.first and RDF.rest are ignored... including RDF.List
                import warnings

                warnings.warn(
                    "Assertions on %s other than RDF.first " % repr(object)
                    + "and RDF.rest are ignored ... including RDF.List",
                    UserWarning,
                    stacklevel=2,
                )
                writer.attribute(RDFVOC.parseType, "Collection")

                col = Collection(store, object)

                for item in col:
                    if isinstance(item, URIRef):
                        self.forceRDFAbout.add(item)
                    # type error: Argument 1 to "subject" of "PrettyXMLSerializer" has incompatible type "Node"; expected "Identifier"
                    self.subject(item)  # type: ignore[arg-type]

                    if not isinstance(item, URIRef):
                        # type error: Invalid index type "Node" for "Dict[Identifier, int]"; expected type "Identifier"
                        self.__serialized[item] = 1  # type: ignore[index]
            else:
                if first(
                    store.triples_choices(
                        # type error: Argument 1 to "triples_choices" of "Graph" has incompatible type "Tuple[Identifier, URIRef, List[URIRef]]"; expected "Union[Tuple[List[Node], Node, Node], Tuple[Node, List[Node], Node], Tuple[Node, Node, List[Node]]]"
                        (object, RDF.type, [OWL_NS.Class, RDFS.Class])  # type: ignore[arg-type]
                    )
                ) and isinstance(object, URIRef):
                    writer.attribute(RDFVOC.resource, self.relativize(object))

                elif depth <= self.max_depth:
                    self.subject(object, depth + 1)

                elif isinstance(object, BNode):
                    if (
                        object not in self.__serialized
                        and (object, None, None) in store
                        and len(list(store.subjects(object=object))) == 1
                    ):
                        # inline blank nodes if they haven't been serialized yet
                        # and are only referenced once (regardless of depth)
                        self.subject(object, depth + 1)
                    else:
                        writer.attribute(RDFVOC.nodeID, fix(object))

                else:
                    writer.attribute(RDFVOC.resource, self.relativize(object))

        writer.pop(predicate)
