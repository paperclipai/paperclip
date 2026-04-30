from rdflib.namespace import DefinedNamespace, Namespace
from rdflib.term import URIRef


class DCTERMS(DefinedNamespace):
    """
    DCMI Metadata Terms - other

    Generated from: https://www.dublincore.org/specifications/dublin-core/dcmi-terms/dublin_core_terms.ttl
    Date: 2020-05-26 14:20:00.590514

    """

    _fail = True

    # http://purl.org/dc/dcam/VocabularyEncodingScheme
    DCMIType: URIRef  # The set of classes specified by the DCMI Type Vocabulary, used to categorize the nature or genre of the resource.
    DDC: URIRef  # The set of conceptual resources specified by the Dewey Decimal Classification.
    IMT: URIRef  # The set of media types specified by the Internet Assigned Numbers Authority.
    LCC: URIRef  # The set of conceptual resources specified by the Library of Congress Classification.
    LCSH: URIRef  # The set of labeled concepts specified by the Library of Congress Subject Headings.
    MESH: (
        URIRef  # The set of labeled concepts specified by the Medical Subject Headings.
    )
    NLM: URIRef  # The set of conceptual resources specified by the National Library of Medicine Classification.
    TGN: URIRef  # The set of places specified by the Getty Thesaurus of Geographic Names.
    UDC: URIRef  # The set of conceptual resources specified by the Universal Decimal Classification.

    # http://www.w3.org/1999/02/22-rdf-syntax-ns#Property
    abstract: URIRef  # A summary of the resource.
    accessRights: URIRef  # Information about who access the resource or an indication of its security status.
    accrualMethod: URIRef  # The method by which items are added to a collection.
    accrualPeriodicity: (
        URIRef  # The frequency with which items are added to a collection.
    )
    accrualPolicy: URIRef  # The policy governing the addition of items to a collection.
    alternative: URIRef  # An alternative name for the resource.
    audience: URIRef  # A class of agents for whom the resource is intended or useful.
    available: URIRef  # Date that the resource became or will become available.
    bibliographicCitation: URIRef  # A bibliographic reference for the resource.
    conformsTo: (
        URIRef  # An established standard to which the described resource conforms.
    )
    contributor: (
        URIRef  # An entity responsible for making contributions to the resource.
    )
    coverage: URIRef  # The spatial or temporal topic of the resource, spatial applicability of the resource, or jurisdiction under which the resource is relevant.
    created: URIRef  # Date of creation of the resource.
    creator: URIRef  # An entity responsible for making the resource.
    date: URIRef  # A point or period of time associated with an event in the lifecycle of the resource.
    dateAccepted: URIRef  # Date of acceptance of the resource.
    dateCopyrighted: URIRef  # Date of copyright of the resource.
    dateSubmitted: URIRef  # Date of submission of the resource.
    description: URIRef  # An account of the resource.
    educationLevel: URIRef  # A class of agents, defined in terms of progression through an educational or training context, for which the described resource is intended.
    extent: URIRef  # The size or duration of the resource.
    format: URIRef  # The file format, physical medium, or dimensions of the resource.
    hasFormat: URIRef  # A related resource that is substantially the same as the pre-existing described resource, but in another format.
    hasPart: URIRef  # A related resource that is included either physically or logically in the described resource.
    hasVersion: URIRef  # A related resource that is a version, edition, or adaptation of the described resource.
    identifier: (
        URIRef  # An unambiguous reference to the resource within a given context.
    )
    instructionalMethod: URIRef  # A process, used to engender knowledge, attitudes and skills, that the described resource is designed to support.
    isFormatOf: URIRef  # A pre-existing related resource that is substantially the same as the described resource, but in another format.
    isPartOf: URIRef  # A related resource in which the described resource is physically or logically included.
    isReferencedBy: URIRef  # A related resource that references, cites, or otherwise points to the described resource.
    isReplacedBy: URIRef  # A related resource that supplants, displaces, or supersedes the described resource.
    isRequiredBy: URIRef  # A related resource that requires the described resource to support its function, delivery, or coherence.
    isVersionOf: URIRef  # A related resource of which the described resource is a version, edition, or adaptation.
    issued: URIRef  # Date of formal issuance of the resource.
    language: URIRef  # A language of the resource.
    license: URIRef  # A legal document giving official permission to do something with the resource.
    mediator: URIRef  # An entity that mediates access to the resource.
    medium: URIRef  # The material or physical carrier of the resource.
    modified: URIRef  # Date on which the resource was changed.
    provenance: URIRef  # A statement of any changes in ownership and custody of the resource since its creation that are significant for its authenticity, integrity, and interpretation.
    publisher: URIRef  # An entity responsible for making the resource available.
    references: URIRef  # A related resource that is referenced, cited, or otherwise pointed to by the described resource.
    relation: URIRef  # A related resource.
    replaces: URIRef  # A related resource that is supplanted, displaced, or superseded by the described resource.
    requires: URIRef  # A related resource that is required by the described resource to support its function, delivery, or coherence.
    rights: URIRef  # Information about rights held in and over the resource.
    rightsHolder: (
        URIRef  # A person or organization owning or managing rights over the resource.
    )
    source: URIRef  # A related resource from which the described resource is derived.
    spatial: URIRef  # Spatial characteristics of the resource.
    subject: URIRef  # A topic of the resource.
    tableOfContents: URIRef  # A list of subunits of the resource.
    temporal: URIRef  # Temporal characteristics of the resource.
    title: URIRef  # A name given to the resource.
    type: URIRef  # The nature or genre of the resource.
    valid: URIRef  # Date (often a range) of validity of a resource.

    # http://www.w3.org/2000/01/rdf-schema#Class
    Agent: URIRef  # A resource that acts or has the power to act.
    AgentClass: URIRef  # A group of agents.
    BibliographicResource: URIRef  # A book, article, or other documentary resource.
    FileFormat: URIRef  # A digital resource format.
    Frequency: URIRef  # A rate at which something recurs.
    Jurisdiction: (
        URIRef  # The extent or range of judicial, law enforcement, or other authority.
    )
    LicenseDocument: URIRef  # A legal document giving official permission to do something with a resource.
    LinguisticSystem: URIRef  # A system of signs, symbols, sounds, gestures, or rules used in communication.
    Location: URIRef  # A spatial region or named place.
    LocationPeriodOrJurisdiction: URIRef  # A location, period of time, or jurisdiction.
    MediaType: URIRef  # A file format or physical medium.
    MediaTypeOrExtent: URIRef  # A media type or extent.
    MethodOfAccrual: URIRef  # A method by which resources are added to a collection.
    MethodOfInstruction: (
        URIRef  # A process that is used to engender knowledge, attitudes, and skills.
    )
    PeriodOfTime: URIRef  # An interval of time that is named or defined by its start and end dates.
    PhysicalMedium: URIRef  # A physical material or carrier.
    PhysicalResource: URIRef  # A material thing.
    Policy: URIRef  # A plan or course of action by an authority, intended to influence and determine decisions, actions, and other matters.
    ProvenanceStatement: URIRef  # Any changes in ownership and custody of a resource since its creation that are significant for its authenticity, integrity, and interpretation.
    RightsStatement: URIRef  # A statement about the intellectual property rights (IPR) held in or over a resource, a legal document giving official permission to do something with a resource, or a statement about access rights.
    SizeOrDuration: URIRef  # A dimension or extent, or a time taken to play or execute.
    Standard: URIRef  # A reference point against which other things can be evaluated or compared.

    # http://www.w3.org/2000/01/rdf-schema#Datatype
    Box: URIRef  # The set of regions in space defined by their geographic coordinates according to the DCMI Box Encoding Scheme.
    ISO3166: URIRef  # The set of codes listed in ISO 3166-1 for the representation of names of countries.
    Period: URIRef  # The set of time intervals defined by their limits according to the DCMI Period Encoding Scheme.
    Point: URIRef  # The set of points in space defined by their geographic coordinates according to the DCMI Point Encoding Scheme.
    RFC1766: URIRef  # The set of tags, constructed according to RFC 1766, for the identification of languages.
    RFC3066: URIRef  # The set of tags constructed according to RFC 3066 for the identification of languages.
    RFC4646: URIRef  # The set of tags constructed according to RFC 4646 for the identification of languages.
    RFC5646: URIRef  # The set of tags constructed according to RFC 5646 for the identification of languages.
    URI: URIRef  # The set of identifiers constructed according to the generic syntax for Uniform Resource Identifiers as specified by the Internet Engineering Task Force.
    W3CDTF: URIRef  # The set of dates and times constructed according to the W3C Date and Time Formats Specification.

    # Valid non-python identifiers
    _extras = ["ISO639-2", "ISO639-3"]

    _NS = Namespace("http://purl.org/dc/terms/")
