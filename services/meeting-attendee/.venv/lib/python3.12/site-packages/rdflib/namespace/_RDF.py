from rdflib.namespace import DefinedNamespace, Namespace
from rdflib.term import URIRef


class RDF(DefinedNamespace):
    """
    The RDF Concepts Vocabulary (RDF)

    This is the RDF Schema for the RDF vocabulary terms in the RDF Namespace, defined in RDF 1.1 Concepts.

    Generated from: http://www.w3.org/1999/02/22-rdf-syntax-ns#
    Date: 2020-05-26 14:20:05.642859

    dc:date "2019-12-16"

    """

    _fail = True
    _underscore_num = True

    # http://www.w3.org/1999/02/22-rdf-syntax-ns#List
    nil: URIRef  # The empty list, with no items in it. If the rest of a list is nil then the list has no more items in it.

    # http://www.w3.org/1999/02/22-rdf-syntax-ns#Property
    direction: URIRef  # The base direction component of a CompoundLiteral.
    first: URIRef  # The first item in the subject RDF list.
    language: URIRef  # The language component of a CompoundLiteral.
    object: URIRef  # The object of the subject RDF statement.
    predicate: URIRef  # The predicate of the subject RDF statement.
    rest: URIRef  # The rest of the subject RDF list after the first item.
    subject: URIRef  # The subject of the subject RDF statement.
    type: URIRef  # The subject is an instance of a class.
    value: URIRef  # Idiomatic property used for structured values.

    # http://www.w3.org/2000/01/rdf-schema#Class
    Alt: URIRef  # The class of containers of alternatives.
    Bag: URIRef  # The class of unordered containers.
    CompoundLiteral: URIRef  # A class representing a compound literal.
    List: URIRef  # The class of RDF Lists.
    Property: URIRef  # The class of RDF properties.
    Seq: URIRef  # The class of ordered containers.
    Statement: URIRef  # The class of RDF statements.

    # http://www.w3.org/2000/01/rdf-schema#Datatype
    HTML: URIRef  # The datatype of RDF literals storing fragments of HTML content
    JSON: URIRef  # The datatype of RDF literals storing JSON content.
    PlainLiteral: URIRef  # The class of plain (i.e. untyped) literal values, as used in RIF and OWL 2
    XMLLiteral: URIRef  # The datatype of XML literal values.
    langString: URIRef  # The datatype of language-tagged string values

    _NS = Namespace("http://www.w3.org/1999/02/22-rdf-syntax-ns#")
