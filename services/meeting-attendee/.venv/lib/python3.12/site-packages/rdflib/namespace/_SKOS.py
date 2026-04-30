from rdflib.namespace import DefinedNamespace, Namespace
from rdflib.term import URIRef


class SKOS(DefinedNamespace):
    """
    SKOS Vocabulary

    An RDF vocabulary for describing the basic structure and content of concept schemes such as thesauri,
    classification schemes, subject heading lists, taxonomies, 'folksonomies', other types of controlled
    vocabulary, and also concept schemes embedded in glossaries and terminologies.

    Generated from: https://www.w3.org/2009/08/skos-reference/skos.rdf
    Date: 2020-05-26 14:20:08.489187

    """

    _fail = True

    # http://www.w3.org/1999/02/22-rdf-syntax-ns#Property
    altLabel: URIRef  # An alternative lexical label for a resource.
    broadMatch: URIRef  # skos:broadMatch is used to state a hierarchical mapping link between two conceptual resources in different concept schemes.
    broader: URIRef  # Relates a concept to a concept that is more general in meaning.
    broaderTransitive: (
        URIRef  # skos:broaderTransitive is a transitive superproperty of skos:broader.
    )
    changeNote: URIRef  # A note about a modification to a concept.
    closeMatch: URIRef  # skos:closeMatch is used to link two concepts that are sufficiently similar that they can be used interchangeably in some information retrieval applications. In order to avoid the possibility of "compound errors" when combining mappings across more than two concept schemes, skos:closeMatch is not declared to be a transitive property.
    definition: URIRef  # A statement or formal explanation of the meaning of a concept.
    editorialNote: (
        URIRef  # A note for an editor, translator or maintainer of the vocabulary.
    )
    exactMatch: URIRef  # skos:exactMatch is used to link two concepts, indicating a high degree of confidence that the concepts can be used interchangeably across a wide range of information retrieval applications. skos:exactMatch is a transitive property, and is a sub-property of skos:closeMatch.
    example: URIRef  # An example of the use of a concept.
    hasTopConcept: URIRef  # Relates, by convention, a concept scheme to a concept which is topmost in the broader/narrower concept hierarchies for that scheme, providing an entry point to these hierarchies.
    hiddenLabel: URIRef  # A lexical label for a resource that should be hidden when generating visual displays of the resource, but should still be accessible to free text search operations.
    historyNote: URIRef  # A note about the past state/use/meaning of a concept.
    inScheme: URIRef  # Relates a resource (for example a concept) to a concept scheme in which it is included.
    mappingRelation: URIRef  # Relates two concepts coming, by convention, from different schemes, and that have comparable meanings
    member: URIRef  # Relates a collection to one of its members.
    memberList: (
        URIRef  # Relates an ordered collection to the RDF list containing its members.
    )
    narrowMatch: URIRef  # skos:narrowMatch is used to state a hierarchical mapping link between two conceptual resources in different concept schemes.
    narrower: URIRef  # Relates a concept to a concept that is more specific in meaning.
    narrowerTransitive: URIRef  # skos:narrowerTransitive is a transitive superproperty of skos:narrower.
    notation: URIRef  # A notation, also known as classification code, is a string of characters such as "T58.5" or "303.4833" used to uniquely identify a concept within the scope of a given concept scheme.
    note: URIRef  # A general note, for any purpose.
    prefLabel: (
        URIRef  # The preferred lexical label for a resource, in a given language.
    )
    related: URIRef  # Relates a concept to a concept with which there is an associative semantic relationship.
    relatedMatch: URIRef  # skos:relatedMatch is used to state an associative mapping link between two conceptual resources in different concept schemes.
    scopeNote: (
        URIRef  # A note that helps to clarify the meaning and/or the use of a concept.
    )
    semanticRelation: URIRef  # Links a concept to a concept related by meaning.
    topConceptOf: URIRef  # Relates a concept to the concept scheme that it is a top level concept of.

    # http://www.w3.org/2002/07/owl#Class
    Collection: URIRef  # A meaningful collection of concepts.
    Concept: URIRef  # An idea or notion; a unit of thought.
    ConceptScheme: URIRef  # A set of concepts, optionally including statements about semantic relationships between those concepts.
    OrderedCollection: URIRef  # An ordered collection of concepts, where both the grouping and the ordering are meaningful.

    _NS = Namespace("http://www.w3.org/2004/02/skos/core#")
