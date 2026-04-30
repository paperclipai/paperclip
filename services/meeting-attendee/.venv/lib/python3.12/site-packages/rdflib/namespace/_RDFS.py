from rdflib.namespace import DefinedNamespace, Namespace
from rdflib.term import URIRef


class RDFS(DefinedNamespace):
    """
    The RDF Schema vocabulary (RDFS)

    Generated from: http://www.w3.org/2000/01/rdf-schema#
    Date: 2020-05-26 14:20:05.794866

    """

    _fail = True

    # http://www.w3.org/1999/02/22-rdf-syntax-ns#Property
    comment: URIRef  # A description of the subject resource.
    domain: URIRef  # A domain of the subject property.
    isDefinedBy: URIRef  # The definition of the subject resource.
    label: URIRef  # A human-readable name for the subject.
    member: URIRef  # A member of the subject resource.
    range: URIRef  # A range of the subject property.
    seeAlso: URIRef  # Further information about the subject resource.
    subClassOf: URIRef  # The subject is a subclass of a class.
    subPropertyOf: URIRef  # The subject is a subproperty of a property.

    # http://www.w3.org/2000/01/rdf-schema#Class
    Class: URIRef  # The class of classes.
    Container: URIRef  # The class of RDF containers.
    ContainerMembershipProperty: URIRef  # The class of container membership properties, rdf:_1, rdf:_2, ...,                     all of which are sub-properties of 'member'.
    Datatype: URIRef  # The class of RDF datatypes.
    Literal: URIRef  # The class of literal values, eg. textual strings and integers.
    Resource: URIRef  # The class resource, everything.

    _NS = Namespace("http://www.w3.org/2000/01/rdf-schema#")
