from rdflib.namespace import DefinedNamespace, Namespace
from rdflib.term import URIRef


class GEO(DefinedNamespace):
    """
    An RDF/OWL vocabulary for representing spatial information

    Generated from: http://schemas.opengis.net/geosparql/1.0/geosparql_vocab_all.rdf
    Date: 2021-12-27 17:38:15.101187

    ```turtle
    <http://www.opengis.net/ont/geosparql> dc:creator "Open Geospatial Consortium"^^xsd:string
    dc:date "2012-04-30"^^xsd:date
    dc:source <http://www.opengis.net/doc/IS/geosparql/1.0>
        "OGC GeoSPARQL – A Geographic Query Language for RDF Data OGC 11-052r5"^^xsd:string
    rdfs:seeAlso <http://www.opengis.net/def/function/ogc-geosparql/1.0>
        <http://www.opengis.net/def/rule/ogc-geosparql/1.0>
        <http://www.opengis.net/doc/IS/geosparql/1.0>
    owl:imports dc:
        <http://www.opengis.net/ont/gml>
        <http://www.opengis.net/ont/sf>
        <http://www.w3.org/2004/02/skos/core>
    owl:versionInfo "OGC GeoSPARQL 1.0"^^xsd:string
    ```
    """

    # http://www.w3.org/2000/01/rdf-schema#Datatype
    dggsLiteral: URIRef  # A DGGS serialization of a geometry object.
    geoJSONLiteral: URIRef  # A GeoJSON serialization of a geometry object.
    gmlLiteral: URIRef  # A GML serialization of a geometry object.
    kmlLiteral: URIRef  # A KML serialization of a geometry object.
    wktLiteral: URIRef  # A Well-known Text serialization of a geometry object.

    # http://www.w3.org/2002/07/owl#Class
    Feature: URIRef  # This class represents the top-level feature type. This class is        equivalent to GFI_Feature defined in ISO 19156:2011, and it is        superclass of all feature types.
    FeatureCollection: URIRef  # A collection of individual Features.
    Geometry: URIRef  # The class represents the top-level geometry type. This class is        equivalent to the UML class GM_Object defined in ISO 19107, and        it is superclass of all geometry types.
    GeometryCollection: URIRef  # A collection of individual Geometries.
    SpatialObject: URIRef  # The class spatial-object represents everything that can have        a spatial representation. It is superclass of feature and geometry.
    SpatialObjectCollection: URIRef  # A collection of individual Spatial Objects.  This is the superclass of Feature Collection and Geometry Collection.

    # http://www.w3.org/2002/07/owl#DatatypeProperty
    asGML: URIRef  # The GML serialization of a geometry
    asWKT: URIRef  # The WKT serialization of a geometry
    asGeoJSON: URIRef  # The GeoJSON serialization of a geometry
    asKML: URIRef  # The KML serialization of a geometry
    asDGGS: URIRef  # The DGGS serialization of a geometry
    coordinateDimension: URIRef  # The number of measurements or axes needed to describe the position of this       geometry in a coordinate system.
    dimension: URIRef  # The topological dimension of this geometric object, which        must be less than or equal to the coordinate dimension.        In non-homogeneous collections, this will return the largest        topological dimension of the contained objects.
    hasMetricArea: URIRef  # The area of a Spatial Object in square meters.
    hasMetricLength: URIRef  # The length of a Spatial Object in meters.
    hasMetricPerimeterLength: (
        URIRef  # The length of the perimeter of a Spatial Object in meters.
    )
    hasMetricSpatialAccuracy: URIRef  # The spatial resolution of a Geometry in meters.
    hasMetricSpatialResolution: (
        URIRef  # The spatial resolution of a Geometry in meters.
    )
    hasMetricSize: URIRef  # Subproperties of this property are used to indicate the size of a Spatial Object as a measurement or estimate of one or more dimensions of the Spatial Object's spatial presence. Units are always metric (meter, square meter or cubic meter)
    hasMetricVolume: URIRef  # The volume of a Spatial Object in cubic meters.
    hasSerialization: (
        URIRef  # Connects a geometry object with its text-based serialization.
    )
    isEmpty: URIRef  # (true) if this geometric object is the empty Geometry. If        true, then this geometric object represents the empty point        set for the coordinate space.
    isSimple: URIRef  # (true) if this geometric object has no anomalous geometric        points, such as self intersection or self tangency.
    spatialDimension: URIRef  # The number of measurements or axes needed to describe the spatial position of        this geometry in a coordinate system.

    # http://www.w3.org/2002/07/owl#ObjectProperty
    defaultGeometry: URIRef  # The default geometry to be used in spatial calculations.       It is Usually the most detailed geometry.
    ehContains: URIRef  # Exists if the subject SpatialObject spatially contains the        object SpatialObject. DE-9IM: T*TFF*FF*
    ehCoveredBy: URIRef  # Exists if the subject SpatialObject is spatially covered        by the object SpatialObject. DE-9IM: TFF*TFT**
    ehCovers: URIRef  # Exists if the subject SpatialObject spatially covers the        object SpatialObject. DE-9IM: T*TFT*FF*
    ehDisjoint: URIRef  # Exists if the subject SpatialObject is spatially disjoint       from the object SpatialObject. DE-9IM: FF*FF****
    ehEquals: URIRef  # Exists if the subject SpatialObject spatially equals the        object SpatialObject. DE-9IM: TFFFTFFFT
    ehInside: URIRef  # Exists if the subject SpatialObject is spatially inside        the object SpatialObject. DE-9IM: TFF*FFT**
    ehMeet: URIRef  # Exists if the subject SpatialObject spatially meets the        object SpatialObject.        DE-9IM: FT******* ^ F**T***** ^ F***T****
    ehOverlap: URIRef  # Exists if the subject SpatialObject spatially overlaps the        object SpatialObject. DE-9IM: T*T***T**
    hasArea: URIRef  # The area of a Spatial Object.
    hasBoundingBox: (
        URIRef  # The minimum or smallest bounding or enclosing box of a given Feature.
    )
    hasCentroid: URIRef  # The arithmetic mean position of all the geometry points of a given Feature.
    hasDefaultGeometry: URIRef  # The default geometry to be used in spatial calculations, usually the most detailed geometry.
    hasGeometry: URIRef  # A spatial representation for a given feature.
    hasLength: URIRef  # The length of a Spatial Object.
    hasPerimeterLength: URIRef  # The length of the perimeter of a Spatial Object.
    hasSize: URIRef  #  Subproperties of this property are used to indicate the size of a Spatial Object as a measurement or estimate of one or more dimensions of the Spatial Object's spatial presence.
    hasSpatialAccuracy: (
        URIRef  # The positional accuracy of the coordinates of a Geometry.
    )
    hasSpatialResolution: URIRef  # The spatial resolution of a Geometry.
    hasVolume: URIRef  # he volume of a three-dimensional Spatial Object.
    rcc8dc: URIRef  # Exists if the subject SpatialObject is spatially disjoint       from the object SpatialObject. DE-9IM: FFTFFTTTT
    rcc8ec: URIRef  # Exists if the subject SpatialObject spatially meets the        object SpatialObject. DE-9IM: FFTFTTTTT
    rcc8eq: URIRef  # Exists if the subject SpatialObject spatially equals the        object SpatialObject. DE-9IM: TFFFTFFFT
    rcc8ntpp: URIRef  # Exists if the subject SpatialObject is spatially inside        the object SpatialObject. DE-9IM: TFFTFFTTT
    rcc8ntppi: URIRef  # Exists if the subject SpatialObject spatially contains the        object SpatialObject. DE-9IM: TTTFFTFFT
    rcc8po: URIRef  # Exists if the subject SpatialObject spatially overlaps the        object SpatialObject. DE-9IM: TTTTTTTTT
    rcc8tpp: URIRef  # Exists if the subject SpatialObject is spatially covered        by the object SpatialObject. DE-9IM: TFFTTFTTT
    rcc8tppi: URIRef  # Exists if the subject SpatialObject spatially covers the        object SpatialObject. DE-9IM: TTTFTTFFT
    sfContains: URIRef  # Exists if the subject SpatialObject spatially contains the        object SpatialObject. DE-9IM: T*****FF*
    sfCrosses: URIRef  # Exists if the subject SpatialObject spatially crosses the        object SpatialObject. DE-9IM: T*T******
    sfDisjoint: URIRef  # Exists if the subject SpatialObject is spatially disjoint        from the object SpatialObject. DE-9IM: FF*FF****
    sfEquals: URIRef  # Exists if the subject SpatialObject spatially equals the        object SpatialObject. DE-9IM: TFFFTFFFT
    sfIntersects: URIRef  # Exists if the subject SpatialObject is not spatially disjoint        from the object SpatialObject.       DE-9IM: T******** ^ *T******* ^ ***T***** ^ ****T****
    sfOverlaps: URIRef  # Exists if the subject SpatialObject spatially overlaps the        object SpatialObject. DE-9IM: T*T***T**
    sfTouches: URIRef  # Exists if the subject SpatialObject spatially touches the        object SpatialObject.       DE-9IM: FT******* ^ F**T***** ^ F***T****
    sfWithin: URIRef  # Exists if the subject SpatialObject is spatially within the        object SpatialObject. DE-9IM: T*F**F***

    _NS = Namespace("http://www.opengis.net/ont/geosparql#")
