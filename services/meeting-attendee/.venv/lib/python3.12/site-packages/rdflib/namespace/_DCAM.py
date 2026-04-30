from rdflib.namespace import DefinedNamespace, Namespace
from rdflib.term import URIRef


class DCAM(DefinedNamespace):
    """
    Metadata terms for vocabulary description

    Generated from: https://www.dublincore.org/specifications/dublin-core/dcmi-terms/dublin_core_abstract_model.ttl
    Date: 2020-05-26 14:20:00.970966

    """

    _fail = True

    # http://www.w3.org/1999/02/22-rdf-syntax-ns#Property
    domainIncludes: URIRef  # A suggested class for subjects of this property.
    memberOf: URIRef  # A relationship between a resource and a vocabulary encoding scheme which indicates that the resource is a member of a set.
    rangeIncludes: URIRef  # A suggested class for values of this property.

    # http://www.w3.org/2000/01/rdf-schema#Class
    VocabularyEncodingScheme: URIRef  # An enumerated set of resources.

    _NS = Namespace("http://purl.org/dc/dcam/")
