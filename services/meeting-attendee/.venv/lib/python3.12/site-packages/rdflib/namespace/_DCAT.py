from rdflib.namespace import DefinedNamespace, Namespace
from rdflib.term import URIRef


class DCAT(DefinedNamespace):
    """
    The data catalog vocabulary

    DCAT is an RDF vocabulary designed to facilitate interoperability between data catalogs published on the Web.
    By using DCAT to describe datasets in data catalogs, publishers increase discoverability and enable
    applications easily to consume metadata from multiple catalogs. It further enables decentralized publishing of
    catalogs and facilitates federated dataset search across sites. Aggregated DCAT metadata can serve as a
    manifest file to facilitate digital preservation. DCAT is defined at http://www.w3.org/TR/vocab-dcat/. Any
    variance between that normative document and this schema is an error in this schema.

    Generated from: https://www.w3.org/ns/dcat2.ttl
    Date: 2020-05-26 14:19:59.985854

    """

    # http://www.w3.org/1999/02/22-rdf-syntax-ns#Property
    accessURL: URIRef  # A URL of a resource that gives access to a distribution of the dataset. E.g. landing page, feed, SPARQL endpoint. Use for all cases except a simple download link, in which case downloadURL is preferred.
    bbox: URIRef  # The geographic bounding box of a resource.
    byteSize: URIRef  # The size of a distribution in bytes.
    centroid: URIRef  # The geographic center (centroid) of a resource.
    compressFormat: URIRef  # The compression format of the distribution in which the data is contained in a compressed form, e.g. to reduce the size of the downloadable file.
    contactPoint: URIRef  # Relevant contact information for the catalogued resource. Use of vCard is recommended.
    dataset: URIRef  # A collection of data that is listed in the catalog.
    distribution: URIRef  # An available distribution of the dataset.
    downloadURL: URIRef  # The URL of the downloadable file in a given format. E.g. CSV file or RDF file. The format is indicated by the distribution's dct:format and/or dcat:mediaType.
    endDate: URIRef  # The end of the period.
    keyword: URIRef  # A keyword or tag describing a resource.
    landingPage: URIRef  # A Web page that can be navigated to in a Web browser to gain access to the catalog, a dataset, its distributions and/or additional information.
    mediaType: URIRef  # The media type of the distribution as defined by IANA.
    packageFormat: URIRef  # The package format of the distribution in which one or more data files are grouped together, e.g. to enable a set of related files to be downloaded together.
    record: URIRef  # A record describing the registration of a single dataset or data service that is part of the catalog.
    startDate: URIRef  # The start of the period
    theme: (
        URIRef  # A main category of the resource. A resource can have multiple themes.
    )
    themeTaxonomy: URIRef  # The knowledge organization system (KOS) used to classify catalog's datasets.

    # http://www.w3.org/2000/01/rdf-schema#Class
    Catalog: URIRef  # A curated collection of metadata about resources (e.g., datasets and data services in the context of a data catalog).
    CatalogRecord: URIRef  # A record in a data catalog, describing the registration of a single dataset or data service.
    Dataset: URIRef  # A collection of data, published or curated by a single source, and available for access or download in one or more representations.
    Distribution: URIRef  # A specific representation of a dataset. A dataset might be available in multiple serializations that may differ in various ways, including natural language, media-type or format, schematic organization, temporal and spatial resolution, level of detail or profiles (which might specify any or all of the above).

    # http://www.w3.org/2002/07/owl#Class
    DataService: URIRef  # A site or end-point providing operations related to the discovery of, access to, or processing functions on, data or related resources.
    Relationship: URIRef  # An association class for attaching additional information to a relationship between DCAT Resources.
    Resource: URIRef  # Resource published or curated by a single agent.
    Role: URIRef  # A role is the function of a resource or agent with respect to another resource, in the context of resource attribution or resource relationships.

    # http://www.w3.org/2002/07/owl#DatatypeProperty
    spatialResolutionInMeters: URIRef  # mínima separacíon espacial disponible en un conjunto de datos, medida en metros.
    temporalResolution: URIRef  # minimum time period resolvable in a dataset.

    # http://www.w3.org/2002/07/owl#ObjectProperty
    accessService: URIRef  # A site or end-point that gives access to the distribution of the dataset.
    catalog: URIRef  # A catalog whose contents are of interest in the context of this catalog.
    endpointDescription: URIRef  # A description of the service end-point, including its operations, parameters etc.
    endpointURL: URIRef  # The root location or primary endpoint of the service (a web-resolvable IRI).
    hadRole: URIRef  # The function of an entity or agent with respect to another entity or resource.
    qualifiedRelation: (
        URIRef  # Link to a description of a relationship with another resource.
    )
    servesDataset: URIRef  # A collection of data that this DataService can distribute.
    service: URIRef  # A site or endpoint that is listed in the catalog.

    _NS = Namespace("http://www.w3.org/ns/dcat#")
