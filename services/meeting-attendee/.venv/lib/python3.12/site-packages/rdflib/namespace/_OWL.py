from rdflib.namespace import DefinedNamespace, Namespace
from rdflib.term import URIRef


class OWL(DefinedNamespace):
    """
    The OWL 2 Schema vocabulary (OWL 2)

    This ontology partially describes the built-in classes and    properties that together form the basis of
    the RDF/XML syntax of OWL 2.    The content of this ontology is based on Tables 6.1 and 6.2    in Section 6.4
    of the OWL 2 RDF-Based Semantics specification,    available at http://www.w3.org/TR/owl2-rdf-based-
    semantics/.    Please note that those tables do not include the different annotations    (labels, comments and
    rdfs:isDefinedBy links) used in this file.    Also note that the descriptions provided in this ontology do not
    provide a complete and correct formal description of either the syntax    or the semantics of the introduced
    terms (please see the OWL 2    recommendations for the complete and normative specifications).    Furthermore,
    the information provided by this ontology may be    misleading if not used with care. This ontology SHOULD NOT
    be imported    into OWL ontologies. Importing this file into an OWL 2 DL ontology    will cause it to become
    an OWL 2 Full ontology and may have other,    unexpected, consequences.

    Generated from: http://www.w3.org/2002/07/owl#
    Date: 2020-05-26 14:20:03.193795

    """

    _fail = True

    # http://www.w3.org/1999/02/22-rdf-syntax-ns#Property
    allValuesFrom: URIRef  # The property that determines the class that a universal property restriction refers to.
    annotatedProperty: URIRef  # The property that determines the predicate of an annotated axiom or annotated annotation.
    annotatedSource: URIRef  # The property that determines the subject of an annotated axiom or annotated annotation.
    annotatedTarget: URIRef  # The property that determines the object of an annotated axiom or annotated annotation.
    assertionProperty: URIRef  # The property that determines the predicate of a negative property assertion.
    cardinality: URIRef  # The property that determines the cardinality of an exact cardinality restriction.
    complementOf: URIRef  # The property that determines that a given class is the complement of another class.
    datatypeComplementOf: URIRef  # The property that determines that a given data range is the complement of another data range with respect to the data domain.
    differentFrom: (
        URIRef  # The property that determines that two given individuals are different.
    )
    disjointUnionOf: URIRef  # The property that determines that a given class is equivalent to the disjoint union of a collection of other classes.
    disjointWith: (
        URIRef  # The property that determines that two given classes are disjoint.
    )
    distinctMembers: URIRef  # The property that determines the collection of pairwise different individuals in a owl:AllDifferent axiom.
    equivalentClass: URIRef  # The property that determines that two given classes are equivalent, and that is used to specify datatype definitions.
    equivalentProperty: (
        URIRef  # The property that determines that two given properties are equivalent.
    )
    hasKey: URIRef  # The property that determines the collection of properties that jointly build a key.
    hasSelf: URIRef  # The property that determines the property that a self restriction refers to.
    hasValue: URIRef  # The property that determines the individual that a has-value restriction refers to.
    intersectionOf: URIRef  # The property that determines the collection of classes or data ranges that build an intersection.
    inverseOf: (
        URIRef  # The property that determines that two given properties are inverse.
    )
    maxCardinality: URIRef  # The property that determines the cardinality of a maximum cardinality restriction.
    maxQualifiedCardinality: URIRef  # The property that determines the cardinality of a maximum qualified cardinality restriction.
    members: URIRef  # The property that determines the collection of members in either a owl:AllDifferent, owl:AllDisjointClasses or owl:AllDisjointProperties axiom.
    minCardinality: URIRef  # The property that determines the cardinality of a minimum cardinality restriction.
    minQualifiedCardinality: URIRef  # The property that determines the cardinality of a minimum qualified cardinality restriction.
    onClass: URIRef  # The property that determines the class that a qualified object cardinality restriction refers to.
    onDataRange: URIRef  # The property that determines the data range that a qualified data cardinality restriction refers to.
    onDatatype: URIRef  # The property that determines the datatype that a datatype restriction refers to.
    onProperties: URIRef  # The property that determines the n-tuple of properties that a property restriction on an n-ary data range refers to.
    onProperty: URIRef  # The property that determines the property that a property restriction refers to.
    oneOf: URIRef  # The property that determines the collection of individuals or data values that build an enumeration.
    propertyChainAxiom: URIRef  # The property that determines the n-tuple of properties that build a sub property chain of a given property.
    propertyDisjointWith: (
        URIRef  # The property that determines that two given properties are disjoint.
    )
    qualifiedCardinality: URIRef  # The property that determines the cardinality of an exact qualified cardinality restriction.
    sameAs: URIRef  # The property that determines that two given individuals are equal.
    someValuesFrom: URIRef  # The property that determines the class that an existential property restriction refers to.
    sourceIndividual: URIRef  # The property that determines the subject of a negative property assertion.
    targetIndividual: URIRef  # The property that determines the object of a negative object property assertion.
    targetValue: URIRef  # The property that determines the value of a negative data property assertion.
    unionOf: URIRef  # The property that determines the collection of classes or data ranges that build a union.
    withRestrictions: URIRef  # The property that determines the collection of facet-value pairs that define a datatype restriction.

    # http://www.w3.org/2000/01/rdf-schema#Class
    AllDifferent: URIRef  # The class of collections of pairwise different individuals.
    AllDisjointClasses: URIRef  # The class of collections of pairwise disjoint classes.
    AllDisjointProperties: (
        URIRef  # The class of collections of pairwise disjoint properties.
    )
    Annotation: URIRef  # The class of annotated annotations for which the RDF serialization consists of an annotated subject, predicate and object.
    AnnotationProperty: URIRef  # The class of annotation properties.
    AsymmetricProperty: URIRef  # The class of asymmetric properties.
    Axiom: URIRef  # The class of annotated axioms for which the RDF serialization consists of an annotated subject, predicate and object.
    Class: URIRef  # The class of OWL classes.
    DataRange: URIRef  # The class of OWL data ranges, which are special kinds of datatypes. Note: The use of the IRI owl:DataRange has been deprecated as of OWL 2. The IRI rdfs:Datatype SHOULD be used instead.
    DatatypeProperty: URIRef  # The class of data properties.
    DeprecatedClass: URIRef  # The class of deprecated classes.
    DeprecatedProperty: URIRef  # The class of deprecated properties.
    FunctionalProperty: URIRef  # The class of functional properties.
    InverseFunctionalProperty: URIRef  # The class of inverse-functional properties.
    IrreflexiveProperty: URIRef  # The class of irreflexive properties.
    NamedIndividual: URIRef  # The class of named individuals.
    NegativePropertyAssertion: URIRef  # The class of negative property assertions.
    ObjectProperty: URIRef  # The class of object properties.
    Ontology: URIRef  # The class of ontologies.
    OntologyProperty: URIRef  # The class of ontology properties.
    ReflexiveProperty: URIRef  # The class of reflexive properties.
    Restriction: URIRef  # The class of property restrictions.
    SymmetricProperty: URIRef  # The class of symmetric properties.
    TransitiveProperty: URIRef  # The class of transitive properties.

    # http://www.w3.org/2002/07/owl#AnnotationProperty
    backwardCompatibleWith: URIRef  # The annotation property that indicates that a given ontology is backward compatible with another ontology.
    deprecated: URIRef  # The annotation property that indicates that a given entity has been deprecated.
    incompatibleWith: URIRef  # The annotation property that indicates that a given ontology is incompatible with another ontology.
    priorVersion: URIRef  # The annotation property that indicates the predecessor ontology of a given ontology.
    versionInfo: URIRef  # The annotation property that provides version information for an ontology or another OWL construct.

    # http://www.w3.org/2002/07/owl#Class
    Nothing: URIRef  # This is the empty class.
    Thing: URIRef  # The class of OWL individuals.

    # http://www.w3.org/2002/07/owl#DatatypeProperty
    bottomDataProperty: URIRef  # The data property that does not relate any individual to any data value.
    topDataProperty: (
        URIRef  # The data property that relates every individual to every data value.
    )

    # http://www.w3.org/2002/07/owl#ObjectProperty
    bottomObjectProperty: (
        URIRef  # The object property that does not relate any two individuals.
    )
    topObjectProperty: URIRef  # The object property that relates every two individuals.

    # http://www.w3.org/2002/07/owl#OntologyProperty
    imports: URIRef  # The property that is used for importing other ontologies into a given ontology.
    versionIRI: URIRef  # The property that identifies the version IRI of an ontology.

    # http://www.w3.org/2000/01/rdf-schema#Datatype
    # NOTE: the following two elements don't appear in the OWL RDF documents but are defined in the OWL2 Recommentation
    # at https://www.w3.org/TR/owl2-syntax/#Datatype_Maps
    rational: URIRef  # The value space is the set of all rational numbers. The lexical form is numerator '/' denominator, where both are integers.
    real: URIRef  # The value space is the set of all real numbers. Does not directly provide any lexical forms.

    _NS = Namespace("http://www.w3.org/2002/07/owl#")
