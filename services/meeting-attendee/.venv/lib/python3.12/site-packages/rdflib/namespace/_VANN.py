from rdflib.namespace import DefinedNamespace, Namespace
from rdflib.term import URIRef


class VANN(DefinedNamespace):
    """
    VANN: A vocabulary for annotating vocabulary descriptions

    This document describes a vocabulary for annotating descriptions of vocabularies with examples and usage
    notes.

    Generated from: https://vocab.org/vann/vann-vocab-20100607.rdf
    Date: 2020-05-26 14:21:15.580430

    """

    _fail = True

    # http://www.w3.org/2002/07/owl#AnnotationProperty
    changes: URIRef  # A reference to a resource that describes changes between this version of a vocabulary and the previous.
    example: URIRef  # A reference to a resource that provides an example of how this resource can be used.
    preferredNamespacePrefix: URIRef  # The preferred namespace prefix to use when using terms from this vocabulary in an XML document.
    preferredNamespaceUri: URIRef  # The preferred namespace URI to use when using terms from this vocabulary in an XML document.
    termGroup: URIRef  # A group of related terms in a vocabulary.
    usageNote: URIRef  # A reference to a resource that provides information on how this resource is to be used.

    _NS = Namespace("http://purl.org/vocab/vann/")
