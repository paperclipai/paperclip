from rdflib.namespace import DefinedNamespace, Namespace
from rdflib.term import URIRef


class VOID(DefinedNamespace):
    """
    Vocabulary of Interlinked Datasets (VoID)

    The Vocabulary of Interlinked Datasets (VoID) is an RDF Schema vocabulary for expressing metadata about RDF
    datasets. It is intended as a bridge between the publishers and users of RDF data, with applications ranging
    from data discovery to cataloging and archiving of datasets. This document provides a formal definition of the
    new RDF classes and properties introduced for VoID. It is a companion to the main specification document for
    VoID, <em><a href="http://www.w3.org/TR/void/">Describing Linked Datasets with the VoID Vocabulary</a></em>.

    Generated from: http://rdfs.org/ns/void#
    Date: 2020-05-26 14:20:11.911298

    """

    _fail = True

    # http://www.w3.org/1999/02/22-rdf-syntax-ns#Property
    classPartition: URIRef  # A subset of a void:Dataset that contains only the entities of a certain rdfs:Class.
    classes: URIRef  # The total number of distinct classes in a void:Dataset. In other words, the number of distinct resources occurring as objects of rdf:type triples in the dataset.
    dataDump: URIRef  # An RDF dump, partial or complete, of a void:Dataset.
    distinctObjects: URIRef  # The total number of distinct objects in a void:Dataset. In other words, the number of distinct resources that occur in the object position of triples in the dataset. Literals are included in this count.
    distinctSubjects: URIRef  # The total number of distinct subjects in a void:Dataset. In other words, the number of distinct resources that occur in the subject position of triples in the dataset.
    documents: URIRef  # The total number of documents, for datasets that are published as a set of individual documents, such as RDF/XML documents or RDFa-annotated web pages. Non-RDF documents, such as web pages in HTML or images, are usually not included in this count. This property is intended for datasets where the total number of triples or entities is hard to determine. void:triples or void:entities should be preferred where practical.
    entities: (
        URIRef  # The total number of entities that are described in a void:Dataset.
    )
    exampleResource: URIRef  # example resource of dataset
    feature: URIRef  # feature
    inDataset: URIRef  # Points to the void:Dataset that a document is a part of.
    linkPredicate: URIRef  # a link predicate
    objectsTarget: URIRef  # The dataset describing the objects of the triples contained in the Linkset.
    openSearchDescription: URIRef  # An OpenSearch description document for a free-text search service over a void:Dataset.
    properties: URIRef  # The total number of distinct properties in a void:Dataset. In other words, the number of distinct resources that occur in the predicate position of triples in the dataset.
    property: URIRef  # The rdf:Property that is the predicate of all triples in a property-based partition.
    propertyPartition: URIRef  # A subset of a void:Dataset that contains only the triples of a certain rdf:Property.
    rootResource: URIRef  # A top concept or entry point for a void:Dataset that is structured in a tree-like fashion. All resources in a dataset can be reached by following links from its root resources in a small number of steps.
    sparqlEndpoint: URIRef  # has a SPARQL endpoint at
    subjectsTarget: URIRef  # The dataset describing the subjects of triples contained in the Linkset.
    subset: URIRef  # has subset
    target: URIRef  # One of the two datasets linked by the Linkset.
    triples: URIRef  # The total number of triples contained in a void:Dataset.
    uriLookupEndpoint: (
        URIRef  # Defines a simple URI look-up protocol for accessing a dataset.
    )
    uriRegexPattern: (
        URIRef  # Defines a regular expression pattern matching URIs in the dataset.
    )
    uriSpace: URIRef  # A URI that is a common string prefix of all the entity URIs in a void:Dataset.
    vocabulary: URIRef  # A vocabulary that is used in the dataset.

    # http://www.w3.org/2000/01/rdf-schema#Class
    Dataset: URIRef  # A set of RDF triples that are published, maintained or aggregated by a single provider.
    DatasetDescription: URIRef  # A web resource whose foaf:primaryTopic or foaf:topics include void:Datasets.
    Linkset: URIRef  # A collection of RDF links between two void:Datasets.
    TechnicalFeature: URIRef  # A technical feature of a void:Dataset, such as a supported RDF serialization format.

    # Valid non-python identifiers
    _extras = ["class"]

    _NS = Namespace("http://rdfs.org/ns/void#")
