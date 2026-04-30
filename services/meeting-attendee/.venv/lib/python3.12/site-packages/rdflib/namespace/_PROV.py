from rdflib.namespace import DefinedNamespace, Namespace
from rdflib.term import URIRef


class PROV(DefinedNamespace):
    """
    W3C PROVenance Interchange Ontology (PROV-O)

    This document is published by the Provenance Working Group (http://www.w3.org/2011/prov/wiki/Main_Page).   If
    you wish to make comments regarding this document, please send them to public-prov-comments@w3.org (subscribe
    public-prov-comments-request@w3.org, archives http://lists.w3.org/Archives/Public/public-prov-comments/). All
    feedback is welcome.

    PROV Access and Query Ontology

    This document is published by the Provenance Working Group (http://www.w3.org/2011/prov/wiki/Main_Page).   If
    you wish to make comments regarding this document, please send them to public-prov-comments@w3.org (subscribe
    public-prov-comments-request@w3.org, archives http://lists.w3.org/Archives/Public/public-prov-comments/). All
    feedback is welcome.

    Dublin Core extensions of the W3C PROVenance Interchange Ontology (PROV-O)

    This document is published by the Provenance Working Group (http://www.w3.org/2011/prov/wiki/Main_Page).   If
    you wish to make comments regarding this document, please send them to public-prov-comments@w3.org (subscribe
    public-prov-comments-request@w3.org, archives http://lists.w3.org/Archives/Public/public-prov-comments/). All
    feedback is welcome.

    W3C PROV Linking Across Provenance Bundles Ontology (PROV-LINKS)

    This document is published by the Provenance Working Group (http://www.w3.org/2011/prov/wiki/Main_Page). If
    you wish to make comments regarding this document, please send them to public-prov-comments@w3.org (subscribe
    public-prov-comments-request@w3.org, archives http://lists.w3.org/Archives/Public/public-prov-comments/ ). All
    feedback is welcome.

    W3C PROVenance Interchange Ontology (PROV-O) Dictionary Extension

    This document is published by the Provenance Working Group (http://www.w3.org/2011/prov/wiki/Main_Page).
    If you wish to make comments regarding this document, please send them to public-prov-comments@w3.org
    (subscribe public-prov-comments-request@w3.org, archives http://lists.w3.org/Archives/Public/public-prov-
    comments/). All feedback is welcome.

    W3C PROVenance Interchange

    This document is published by the Provenance Working Group (http://www.w3.org/2011/prov/wiki/Main_Page).  If
    you wish to make comments regarding this document, please send them to public-prov-comments@w3.org (subscribe
    public-prov-comments-request@w3.org, archives http://lists.w3.org/ Archives/Public/public-prov-comments/). All
    feedback is welcome.

    Generated from: http://www.w3.org/ns/prov
    Date: 2020-05-26 14:20:04.650279

    """

    _fail = True

    # http://www.w3.org/2000/01/rdf-schema#Resource
    activityOfInfluence: URIRef  # activityOfInfluence
    agentOfInfluence: URIRef  # agentOfInfluence
    contributed: URIRef  # contributed
    ended: URIRef  # ended
    entityOfInfluence: URIRef  # entityOfInfluence
    generalizationOf: URIRef  # generalizationOf
    generatedAsDerivation: URIRef  # generatedAsDerivation
    hadDelegate: URIRef  # hadDelegate
    hadDerivation: URIRef  # hadDerivation
    hadInfluence: URIRef  # hadInfluence
    hadRevision: URIRef  # hadRevision
    informed: URIRef  # informed
    locationOf: URIRef  # locationOf
    qualifiedAssociationOf: URIRef  # qualifiedAssociationOf
    qualifiedAttributionOf: URIRef  # qualifiedAttributionOf
    qualifiedCommunicationOf: URIRef  # qualifiedCommunicationOf
    qualifiedDelegationOf: URIRef  # qualifiedDelegationOf
    qualifiedDerivationOf: URIRef  # qualifiedDerivationOf
    qualifiedEndOf: URIRef  # qualifiedEndOf
    qualifiedGenerationOf: URIRef  # qualifiedGenerationOf
    qualifiedInfluenceOf: URIRef  # qualifiedInfluenceOf
    qualifiedInvalidationOf: URIRef  # qualifiedInvalidationOf
    qualifiedQuotationOf: URIRef  # qualifiedQuotationOf
    qualifiedSourceOf: URIRef  # qualifiedSourceOf
    qualifiedStartOf: URIRef  # qualifiedStartOf
    qualifiedUsingActivity: URIRef  # qualifiedUsingActivity
    quotedAs: URIRef  # quotedAs
    revisedEntity: URIRef  # revisedEntity
    started: URIRef  # started
    wasActivityOfInfluence: URIRef  # wasActivityOfInfluence
    wasAssociateFor: URIRef  # wasAssociateFor
    wasMemberOf: URIRef  # wasMemberOf
    wasPlanOf: URIRef  # wasPlanOf
    wasPrimarySourceOf: URIRef  # wasPrimarySourceOf
    wasRoleIn: URIRef  # wasRoleIn
    wasUsedBy: URIRef  # wasUsedBy
    wasUsedInDerivation: URIRef  # wasUsedInDerivation

    # http://www.w3.org/2002/07/owl#AnnotationProperty
    aq: URIRef  #
    category: URIRef  # Classify prov-o terms into three categories, including 'starting-point', 'qualifed', and 'extended'. This classification is used by the prov-o html document to gently introduce prov-o terms to its users.
    component: URIRef  # Classify prov-o terms into six components according to prov-dm, including 'agents-responsibility', 'alternate', 'annotations', 'collections', 'derivations', and 'entities-activities'. This classification is used so that readers of prov-o specification can find its correspondence with the prov-dm specification.
    constraints: URIRef  # A reference to the principal section of the PROV-CONSTRAINTS document that describes this concept.
    definition: URIRef  # A definition quoted from PROV-DM or PROV-CONSTRAINTS that describes the concept expressed with this OWL term.
    dm: URIRef  # A reference to the principal section of the PROV-DM document that describes this concept.
    editorialNote: URIRef  # A note by the OWL development team about how this term expresses the PROV-DM concept, or how it should be used in context of semantic web or linked data.
    editorsDefinition: URIRef  # When the prov-o term does not have a definition drawn from prov-dm, and the prov-o editor provides one.
    inverse: URIRef  # PROV-O does not define all property inverses. The directionalities defined in PROV-O should be given preference over those not defined. However, if users wish to name the inverse of a PROV-O property, the local name given by prov:inverse should be used.
    n: URIRef  # A reference to the principal section of the PROV-M document that describes this concept.
    order: URIRef  # The position that this OWL term should be listed within documentation. The scope of the documentation (e.g., among all terms, among terms within a prov:category, among properties applying to a particular class, etc.) is unspecified.
    qualifiedForm: URIRef  # This annotation property links a subproperty of prov:wasInfluencedBy with the subclass of prov:Influence and the qualifying property that are used to qualify it.   Example annotation:      prov:wasGeneratedBy prov:qualifiedForm prov:qualifiedGeneration, prov:Generation .  Then this unqualified assertion:      :entity1 prov:wasGeneratedBy :activity1 .  can be qualified by adding:     :entity1 prov:qualifiedGeneration :entity1Gen .    :entity1Gen         a prov:Generation, prov:Influence;        prov:activity :activity1;        :customValue 1337 .  Note how the value of the unqualified influence (prov:wasGeneratedBy :activity1) is mirrored as the value of the prov:activity (or prov:entity, or prov:agent) property on the influence class.
    sharesDefinitionWith: URIRef  #
    specializationOf: URIRef  # specializationOf
    todo: URIRef  #
    unqualifiedForm: URIRef  # Classes and properties used to qualify relationships are annotated with prov:unqualifiedForm to indicate the property used to assert an unqualified provenance relation.
    wasRevisionOf: URIRef  # A revision is a derivation that revises an entity into a revised version.

    # http://www.w3.org/2002/07/owl#Class
    Accept: URIRef  # Accept
    Activity: URIRef  # Activity
    ActivityInfluence: URIRef  # ActivityInfluence provides additional descriptions of an Activity's binary influence upon any other kind of resource. Instances of ActivityInfluence use the prov:activity property to cite the influencing Activity.
    Agent: URIRef  # Agent
    AgentInfluence: URIRef  # AgentInfluence provides additional descriptions of an Agent's binary influence upon any other kind of resource. Instances of AgentInfluence use the prov:agent property to cite the influencing Agent.
    Association: URIRef  # An instance of prov:Association provides additional descriptions about the binary prov:wasAssociatedWith relation from an prov:Activity to some prov:Agent that had some responsibility for it. For example, :baking prov:wasAssociatedWith :baker; prov:qualifiedAssociation [ a prov:Association; prov:agent :baker; :foo :bar ].
    Attribution: URIRef  # An instance of prov:Attribution provides additional descriptions about the binary prov:wasAttributedTo relation from an prov:Entity to some prov:Agent that had some responsible for it. For example, :cake prov:wasAttributedTo :baker; prov:qualifiedAttribution [ a prov:Attribution; prov:entity :baker; :foo :bar ].
    Bundle: URIRef  # Note that there are kinds of bundles (e.g. handwritten letters, audio recordings, etc.) that are not expressed in PROV-O, but can be still be described by PROV-O.
    Collection: URIRef  # Collection
    Communication: URIRef  # An instance of prov:Communication provides additional descriptions about the binary prov:wasInformedBy relation from an informed prov:Activity to the prov:Activity that informed it. For example, :you_jumping_off_bridge prov:wasInformedBy :everyone_else_jumping_off_bridge; prov:qualifiedCommunication [ a prov:Communication; prov:activity :everyone_else_jumping_off_bridge; :foo :bar ].
    Contribute: URIRef  # Contribute
    Contributor: URIRef  # Contributor
    Copyright: URIRef  # Copyright
    Create: URIRef  # Create
    Creator: URIRef  # Creator
    Delegation: URIRef  # An instance of prov:Delegation provides additional descriptions about the binary prov:actedOnBehalfOf relation from a performing prov:Agent to some prov:Agent for whom it was performed. For example, :mixing prov:wasAssociatedWith :toddler . :toddler prov:actedOnBehalfOf :mother; prov:qualifiedDelegation [ a prov:Delegation; prov:entity :mother; :foo :bar ].
    Derivation: URIRef  # The more specific forms of prov:Derivation (i.e., prov:Revision, prov:Quotation, prov:PrimarySource) should be asserted if they apply.
    Dictionary: URIRef  # This concept allows for the provenance of the dictionary, but also of its constituents to be expressed. Such a notion of dictionary corresponds to a wide variety of concrete data structures, such as a maps or associative arrays.
    DirectQueryService: URIRef  # Type for a generic provenance query service. Mainly for use in RDF provenance query service descriptions, to facilitate discovery in linked data environments.
    EmptyDictionary: URIRef  # Empty Dictionary
    End: URIRef  # An instance of prov:End provides additional descriptions about the binary prov:wasEndedBy relation from some ended prov:Activity to an prov:Entity that ended it. For example, :ball_game prov:wasEndedBy :buzzer; prov:qualifiedEnd [ a prov:End; prov:entity :buzzer; :foo :bar; prov:atTime '2012-03-09T08:05:08-05:00'^^xsd:dateTime ].
    Entity: URIRef  # Entity
    EntityInfluence: URIRef  # It is not recommended that the type EntityInfluence be asserted without also asserting one of its more specific subclasses.
    Generation: URIRef  # An instance of prov:Generation provides additional descriptions about the binary prov:wasGeneratedBy relation from a generated prov:Entity to the prov:Activity that generated it. For example, :cake prov:wasGeneratedBy :baking; prov:qualifiedGeneration [ a prov:Generation; prov:activity :baking; :foo :bar ].
    Influence: URIRef  # Because prov:Influence is a broad relation, its most specific subclasses (e.g. prov:Communication, prov:Delegation, prov:End, prov:Revision, etc.) should be used when applicable.
    Insertion: URIRef  # Insertion
    InstantaneousEvent: URIRef  # An instantaneous event, or event for short, happens in the world and marks a change in the world, in its activities and in its entities. The term 'event' is commonly used in process algebra with a similar meaning. Events represent communications or interactions; they are assumed to be atomic and instantaneous.
    Invalidation: URIRef  # An instance of prov:Invalidation provides additional descriptions about the binary prov:wasInvalidatedBy relation from an invalidated prov:Entity to the prov:Activity that invalidated it. For example, :uncracked_egg prov:wasInvalidatedBy :baking; prov:qualifiedInvalidation [ a prov:Invalidation; prov:activity :baking; :foo :bar ].
    KeyEntityPair: URIRef  # Key-Entity Pair
    Location: URIRef  # Location
    Modify: URIRef  # Modify
    Organization: URIRef  # Organization
    Person: URIRef  # Person
    Plan: URIRef  # There exist no prescriptive requirement on the nature of plans, their representation, the actions or steps they consist of, or their intended goals. Since plans may evolve over time, it may become necessary to track their provenance, so plans themselves are entities. Representing the plan explicitly in the provenance can be useful for various tasks: for example, to validate the execution as represented in the provenance record, to manage expectation failures, or to provide explanations.
    PrimarySource: URIRef  # An instance of prov:PrimarySource provides additional descriptions about the binary prov:hadPrimarySource relation from some secondary prov:Entity to an earlier, primary prov:Entity. For example, :blog prov:hadPrimarySource :newsArticle; prov:qualifiedPrimarySource [ a prov:PrimarySource; prov:entity :newsArticle; :foo :bar ] .
    Publish: URIRef  # Publish
    Publisher: URIRef  # Publisher
    Quotation: URIRef  # An instance of prov:Quotation provides additional descriptions about the binary prov:wasQuotedFrom relation from some taken prov:Entity from an earlier, larger prov:Entity. For example, :here_is_looking_at_you_kid prov:wasQuotedFrom :casablanca_script; prov:qualifiedQuotation [ a prov:Quotation; prov:entity :casablanca_script; :foo :bar ].
    Removal: URIRef  # Removal
    Replace: URIRef  # Replace
    Revision: URIRef  # An instance of prov:Revision provides additional descriptions about the binary prov:wasRevisionOf relation from some newer prov:Entity to an earlier prov:Entity. For example, :draft_2 prov:wasRevisionOf :draft_1; prov:qualifiedRevision [ a prov:Revision; prov:entity :draft_1; :foo :bar ].
    RightsAssignment: URIRef  # RightsAssignment
    RightsHolder: URIRef  # RightsHolder
    Role: URIRef  # Role
    ServiceDescription: URIRef  # Type for a generic provenance query service. Mainly for use in RDF provenance query service descriptions, to facilitate discovery in linked data environments.
    SoftwareAgent: URIRef  # SoftwareAgent
    Start: URIRef  # An instance of prov:Start provides additional descriptions about the binary prov:wasStartedBy relation from some started prov:Activity to an prov:Entity that started it. For example, :foot_race prov:wasStartedBy :bang; prov:qualifiedStart [ a prov:Start; prov:entity :bang; :foo :bar; prov:atTime '2012-03-09T08:05:08-05:00'^^xsd:dateTime ] .
    Submit: URIRef  # Submit
    Usage: URIRef  # An instance of prov:Usage provides additional descriptions about the binary prov:used relation from some prov:Activity to an prov:Entity that it used. For example, :keynote prov:used :podium; prov:qualifiedUsage [ a prov:Usage; prov:entity :podium; :foo :bar ].

    # http://www.w3.org/2002/07/owl#DatatypeProperty
    atTime: URIRef  # The time at which an InstantaneousEvent occurred, in the form of xsd:dateTime.
    endedAtTime: (
        URIRef  # The time at which an activity ended. See also prov:startedAtTime.
    )
    generatedAtTime: URIRef  # The time at which an entity was completely created and is available for use.
    invalidatedAtTime: (
        URIRef  # The time at which an entity was invalidated (i.e., no longer usable).
    )
    provenanceUriTemplate: URIRef  # Relates a provenance service to a URI template string for constructing provenance-URIs.
    removedKey: URIRef  # removedKey
    startedAtTime: (
        URIRef  # The time at which an activity started. See also prov:endedAtTime.
    )
    value: URIRef  # value

    # http://www.w3.org/2002/07/owl#FunctionalProperty
    pairEntity: URIRef  # pairKey
    pairKey: URIRef  # pairKey

    # http://www.w3.org/2002/07/owl#NamedIndividual
    EmptyCollection: URIRef  # EmptyCollection

    # http://www.w3.org/2002/07/owl#ObjectProperty
    actedOnBehalfOf: URIRef  # An object property to express the accountability of an agent towards another agent. The subordinate agent acted on behalf of the responsible agent in an actual activity.
    activity: URIRef  # activity
    agent: URIRef  # agent
    alternateOf: URIRef  # alternateOf
    asInBundle: URIRef  # prov:asInBundle is used to specify which bundle the general entity of a prov:mentionOf property is described.  When :x prov:mentionOf :y and :y is described in Bundle :b, the triple :x prov:asInBundle :b is also asserted to cite the Bundle in which :y was described.
    atLocation: URIRef  # The Location of any resource.
    derivedByInsertionFrom: URIRef  # derivedByInsertionFrom
    derivedByRemovalFrom: URIRef  # derivedByRemovalFrom
    describesService: URIRef  # relates a generic provenance query service resource (type prov:ServiceDescription) to a specific query service description (e.g. a prov:DirectQueryService or a sd:Service).
    dictionary: URIRef  # dictionary
    entity: URIRef  # entity
    generated: URIRef  # generated
    hadActivity: URIRef  # The _optional_ Activity of an Influence, which used, generated, invalidated, or was the responsibility of some Entity. This property is _not_ used by ActivityInfluence (use prov:activity instead).
    hadDictionaryMember: URIRef  # hadDictionaryMember
    hadGeneration: (
        URIRef  # The _optional_ Generation involved in an Entity's Derivation.
    )
    hadMember: URIRef  # hadMember
    hadPlan: URIRef  # The _optional_ Plan adopted by an Agent in Association with some Activity. Plan specifications are out of the scope of this specification.
    hadPrimarySource: URIRef  # hadPrimarySource
    hadRole: URIRef  # This property has multiple RDFS domains to suit multiple OWL Profiles. See <a href="#owl-profile">PROV-O OWL Profile</a>.
    hadUsage: URIRef  # The _optional_ Usage involved in an Entity's Derivation.
    has_anchor: (
        URIRef  # Indicates anchor URI for a potentially dynamic resource instance.
    )
    has_provenance: URIRef  # Indicates a provenance-URI for a resource; the resource identified by this property presents a provenance record about its subject or anchor resource.
    has_query_service: URIRef  # Indicates a provenance query service that can access provenance related to its subject or anchor resource.
    influenced: URIRef  # influenced
    influencer: URIRef  # Subproperties of prov:influencer are used to cite the object of an unqualified PROV-O triple whose predicate is a subproperty of prov:wasInfluencedBy (e.g. prov:used, prov:wasGeneratedBy). prov:influencer is used much like rdf:object is used.
    insertedKeyEntityPair: URIRef  # insertedKeyEntityPair
    invalidated: URIRef  # invalidated
    mentionOf: URIRef  # prov:mentionOf is used to specialize an entity as described in another bundle. It is to be used in conjunction with prov:asInBundle.  prov:asInBundle is used to cite the Bundle in which the generalization was mentioned.
    pingback: URIRef  # Relates a resource to a provenance pingback service that may receive additional provenance links about the resource.
    qualifiedAssociation: URIRef  # If this Activity prov:wasAssociatedWith Agent :ag, then it can qualify the Association using prov:qualifiedAssociation [ a prov:Association;  prov:agent :ag; :foo :bar ].
    qualifiedAttribution: URIRef  # If this Entity prov:wasAttributedTo Agent :ag, then it can qualify how it was influenced using prov:qualifiedAttribution [ a prov:Attribution;  prov:agent :ag; :foo :bar ].
    qualifiedCommunication: URIRef  # If this Activity prov:wasInformedBy Activity :a, then it can qualify how it was influenced using prov:qualifiedCommunication [ a prov:Communication;  prov:activity :a; :foo :bar ].
    qualifiedDelegation: URIRef  # If this Agent prov:actedOnBehalfOf Agent :ag, then it can qualify how with prov:qualifiedResponsibility [ a prov:Responsibility;  prov:agent :ag; :foo :bar ].
    qualifiedDerivation: URIRef  # If this Entity prov:wasDerivedFrom Entity :e, then it can qualify how it was derived using prov:qualifiedDerivation [ a prov:Derivation;  prov:entity :e; :foo :bar ].
    qualifiedEnd: URIRef  # If this Activity prov:wasEndedBy Entity :e1, then it can qualify how it was ended using prov:qualifiedEnd [ a prov:End;  prov:entity :e1; :foo :bar ].
    qualifiedGeneration: URIRef  # If this Activity prov:generated Entity :e, then it can qualify how it performed the Generation using prov:qualifiedGeneration [ a prov:Generation;  prov:entity :e; :foo :bar ].
    qualifiedInfluence: URIRef  # Because prov:qualifiedInfluence is a broad relation, the more specific relations (qualifiedCommunication, qualifiedDelegation, qualifiedEnd, etc.) should be used when applicable.
    qualifiedInsertion: URIRef  # qualifiedInsertion
    qualifiedInvalidation: URIRef  # If this Entity prov:wasInvalidatedBy Activity :a, then it can qualify how it was invalidated using prov:qualifiedInvalidation [ a prov:Invalidation;  prov:activity :a; :foo :bar ].
    qualifiedPrimarySource: URIRef  # If this Entity prov:hadPrimarySource Entity :e, then it can qualify how using prov:qualifiedPrimarySource [ a prov:PrimarySource; prov:entity :e; :foo :bar ].
    qualifiedQuotation: URIRef  # If this Entity prov:wasQuotedFrom Entity :e, then it can qualify how using prov:qualifiedQuotation [ a prov:Quotation;  prov:entity :e; :foo :bar ].
    qualifiedRemoval: URIRef  # qualifiedRemoval
    qualifiedRevision: URIRef  # If this Entity prov:wasRevisionOf Entity :e, then it can qualify how it was revised using prov:qualifiedRevision [ a prov:Revision;  prov:entity :e; :foo :bar ].
    qualifiedStart: URIRef  # If this Activity prov:wasStartedBy Entity :e1, then it can qualify how it was started using prov:qualifiedStart [ a prov:Start;  prov:entity :e1; :foo :bar ].
    qualifiedUsage: URIRef  # If this Activity prov:used Entity :e, then it can qualify how it used it using prov:qualifiedUsage [ a prov:Usage; prov:entity :e; :foo :bar ].
    used: URIRef  # A prov:Entity that was used by this prov:Activity. For example, :baking prov:used :spoon, :egg, :oven .
    wasAssociatedWith: URIRef  # An prov:Agent that had some (unspecified) responsibility for the occurrence of this prov:Activity.
    wasAttributedTo: URIRef  # Attribution is the ascribing of an entity to an agent.
    wasDerivedFrom: URIRef  # The more specific subproperties of prov:wasDerivedFrom (i.e., prov:wasQuotedFrom, prov:wasRevisionOf, prov:hadPrimarySource) should be used when applicable.
    wasEndedBy: URIRef  # End is when an activity is deemed to have ended. An end may refer to an entity, known as trigger, that terminated the activity.
    wasGeneratedBy: URIRef  # wasGeneratedBy
    wasInfluencedBy: URIRef  # This property has multiple RDFS domains to suit multiple OWL Profiles. See <a href="#owl-profile">PROV-O OWL Profile</a>.
    wasInformedBy: URIRef  # An activity a2 is dependent on or informed by another activity a1, by way of some unspecified entity that is generated by a1 and used by a2.
    wasInvalidatedBy: URIRef  # wasInvalidatedBy
    wasQuotedFrom: URIRef  # An entity is derived from an original entity by copying, or 'quoting', some or all of it.
    wasStartedBy: URIRef  # Start is when an activity is deemed to have started. A start may refer to an entity, known as trigger, that initiated the activity.

    _NS = Namespace("http://www.w3.org/ns/prov#")
