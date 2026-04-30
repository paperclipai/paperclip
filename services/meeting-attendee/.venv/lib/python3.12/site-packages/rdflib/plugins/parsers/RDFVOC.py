from rdflib.namespace import RDF  # noqa: N999
from rdflib.term import URIRef


class RDFVOC(RDF):
    _underscore_num = True
    _fail = True

    # http://www.w3.org/TR/rdf-syntax-grammar/#eventterm-attribute-URI
    # A mapping from unqualified terms to their qualified version.
    RDF: URIRef
    Description: URIRef
    ID: URIRef
    about: URIRef
    parseType: URIRef  # noqa: N815
    resource: URIRef
    li: URIRef
    nodeID: URIRef  # noqa: N815
    datatype: URIRef
