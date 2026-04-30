from rdflib.namespace import DefinedNamespace, Namespace
from rdflib.term import URIRef


class WGS(DefinedNamespace):
    """
    Basic Geo (WGS84 lat/long) Vocabulary

    The HTML Specification for the vocabulary can be found
    here <https://www.w3.org/2003/01/geo/>.
    """

    _NS = Namespace("https://www.w3.org/2003/01/geo/wgs84_pos#")

    # http://www.w3.org/2000/01/rdf-schema#Class
    SpatialThing: URIRef
    Point: URIRef

    # http://www.w3.org/2002/07/owl#DatatypeProperty
    alt: URIRef

    lat: URIRef  # http://www.w3.org/2003/01/geo/wgs84_pos#lat
    lat_long: URIRef
    location: URIRef
    long: URIRef
