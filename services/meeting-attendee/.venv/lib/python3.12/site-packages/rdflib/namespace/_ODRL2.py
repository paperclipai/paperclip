from rdflib.namespace import DefinedNamespace, Namespace
from rdflib.term import URIRef


class ODRL2(DefinedNamespace):
    """
    ODRL Version 2.2

    The ODRL Vocabulary and Expression defines a set of concepts and terms (the vocabulary) and encoding mechanism
    (the expression) for permissions and obligations statements describing digital content usage based on the ODRL
    Information Model.

    Generated from: https://www.w3.org/ns/odrl/2/ODRL22.ttl
    Date: 2020-05-26 14:20:02.352356

    """

    _fail = True

    # http://www.w3.org/1999/02/22-rdf-syntax-ns#Property
    action: URIRef  # The operation relating to the Asset for which the Rule is being subjected.
    andSequence: URIRef  # The relation is satisfied when each of the Constraints are satisfied in the order specified.
    assignee: URIRef  # The Party is the recipient of the Rule.
    assigneeOf: URIRef  # Identifies an ODRL Policy for which the identified Party undertakes the assignee functional role.
    assigner: URIRef  # The Party is the issuer of the Rule.
    assignerOf: URIRef  # Identifies an ODRL Policy for which the identified Party undertakes the assigner functional role.
    attributedParty: URIRef  # The Party to be attributed.
    attributingParty: URIRef  # The Party who undertakes the attribution.
    compensatedParty: URIRef  # The Party is the recipient of the compensation.
    compensatingParty: URIRef  # The Party that is the provider of the compensation.
    conflict: URIRef  # The conflict-resolution strategy for a Policy.
    consentedParty: URIRef  # The Party who obtains the consent.
    consentingParty: URIRef  # The Party to obtain consent from.
    consequence: URIRef  # Relates a Duty to another Duty, the latter being a consequence of not fulfilling the former.
    constraint: URIRef  # Constraint applied to a Rule
    contractedParty: URIRef  # The Party who is being contracted.
    contractingParty: URIRef  # The Party who is offering the contract.
    dataType: URIRef  # The datatype of the value of the rightOperand or rightOperandReference of a Constraint.
    duty: URIRef  # Relates an individual Duty to a Permission.
    failure: URIRef  # Failure is an abstract property that defines the violation (or unmet) relationship between Rules.
    function: URIRef  # Function is an abstract property whose sub-properties define the functional roles which may be fulfilled by a party in relation to a Rule.
    hasPolicy: URIRef  # Identifies an ODRL Policy for which the identified Asset is the target Asset to all the Rules.
    implies: URIRef  # An Action asserts that another Action is not prohibited to enable its operational semantics.
    includedIn: URIRef  # An Action transitively asserts that another Action that encompasses its operational semantics.
    informedParty: URIRef  # The Party to be informed of all uses.
    informingParty: URIRef  # The Party who provides the inform use data.
    inheritAllowed: URIRef  # Indicates if the Policy entity can be inherited.
    inheritFrom: URIRef  # Relates a (child) policy to another (parent) policy from which terms are inherited.
    inheritRelation: URIRef  # Identifies the type of inheritance.
    leftOperand: URIRef  # The left operand in a constraint expression.
    obligation: URIRef  # Relates an individual Duty to a Policy.
    operand: URIRef  # Operand is an abstract property for a logical relationship.
    operator: URIRef  # The operator function applied to operands of a Constraint
    output: URIRef  # The output property specifies the Asset which is created from the output of the Action.
    partOf: URIRef  # Identifies an Asset/PartyCollection that the Asset/Party is a member of.
    payeeParty: URIRef  # The Party is the recipient of the payment.
    permission: URIRef  # Relates an individual Permission to a Policy.
    profile: URIRef  # The identifier(s) of an ODRL Profile that the Policy conforms to.
    prohibition: URIRef  # Relates an individual Prohibition to a Policy.
    proximity: URIRef  # An value indicating the closeness or nearness.
    refinement: URIRef  # Constraint used to refine the semantics of an Action, or Party/Asset Collection
    relation: URIRef  # Relation is an abstract property which creates an explicit link between an Action and an Asset.
    remedy: URIRef  # Relates an individual remedy Duty to a Prohibition.
    rightOperand: URIRef  # The value of the right operand in a constraint expression.
    rightOperandReference: URIRef  # A reference to a web resource providing the value for the right operand of a Constraint.
    scope: URIRef  # The identifier of a scope that provides context to the extent of the entity.
    source: URIRef  # Reference to a Asset/PartyCollection
    status: URIRef  # the value generated from the leftOperand action or a value related to the leftOperand set as the reference for the comparison.
    target: URIRef  # The target property indicates the Asset that is the primary subject to which the Rule action directly applies.
    timedCount: URIRef  # The number of seconds after which timed metering use of the asset begins.
    trackedParty: URIRef  # The Party whose usage is being tracked.
    trackingParty: URIRef  # The Party who is tracking usage.
    uid: URIRef  # An unambiguous identifier
    undefined: (
        URIRef  # Relates the strategy used for handling undefined actions to a Policy.
    )
    unit: URIRef  # The unit of measurement of the value of the rightOperand or rightOperandReference of a Constraint.
    xone: URIRef  # The relation is satisfied when only one, and not more, of the Constraints is satisfied

    # http://www.w3.org/2002/07/owl#NamedIndividual
    All: URIRef  # Specifies that the scope of the relationship is all of the collective individuals within a context.
    All2ndConnections: URIRef  # Specifies that the scope of the relationship is all of the second-level connections to the Party.
    AllConnections: URIRef  # Specifies that the scope of the relationship is all of the first-level connections of the Party.
    AllGroups: URIRef  # Specifies that the scope of the relationship is all of the group connections of the Party.
    Group: URIRef  # Specifies that the scope of the relationship is the defined group with multiple individual members.
    Individual: URIRef  # Specifies that the scope of the relationship is the single Party individual.
    absolutePosition: URIRef  # A point in space or time defined with absolute coordinates for the positioning of the target Asset.
    absoluteSize: URIRef  # Measure(s) of one or two axes for 2D-objects or measure(s) of one to tree axes for 3D-objects of the target Asset.
    absoluteSpatialPosition: URIRef  # The absolute spatial positions of four corners of a rectangle on a 2D-canvas or the eight corners of a cuboid in a 3D-space for the target Asset to fit.
    absoluteTemporalPosition: URIRef  # The absolute temporal positions in a media stream the target Asset has to fit.
    count: URIRef  # Numeric count of executions of the action of the Rule.
    dateTime: URIRef  # The date (and optional time and timezone) of exercising the action of the Rule. Right operand value MUST be an xsd:date or xsd:dateTime as defined by [[xmlschema11-2]].
    delayPeriod: URIRef  # A time delay period prior to exercising the action of the Rule. The point in time triggering this period MAY be defined by another temporal Constraint combined by a Logical Constraint (utilising the odrl:andSequence operand). Right operand value MUST be an xsd:duration as defined by [[xmlschema11-2]].
    deliveryChannel: (
        URIRef  # The delivery channel used for exercising the action of the Rule.
    )
    device: URIRef  # An identified device used for exercising the action of the Rule.
    elapsedTime: URIRef  # A continuous elapsed time period which may be used for exercising of the action of the Rule. Right operand value MUST be an xsd:duration as defined by [[xmlschema11-2]].
    eq: URIRef  # Indicating that a given value equals the right operand of the Constraint.
    event: URIRef  # An identified event setting a context for exercising the action of the Rule.
    fileFormat: URIRef  # A transformed file format of the target Asset.
    gt: URIRef  # Indicating that a given value is greater than the right operand of the Constraint.
    gteq: URIRef  # Indicating that a given value is greater than or equal to the right operand of the Constraint.
    hasPart: URIRef  # A set-based operator indicating that a given value contains the right operand of the Constraint.
    ignore: URIRef  # The Action is to be ignored and is not part of the policy – and the policy remains valid.
    industry: URIRef  # A defined industry sector setting a context for exercising the action of the Rule.
    invalid: URIRef  # The policy is void.
    isA: URIRef  # A set-based operator indicating that a given value is an instance of the right operand of the Constraint.
    isAllOf: URIRef  # A set-based operator indicating that a given value is all of the right operand of the Constraint.
    isAnyOf: URIRef  # A set-based operator indicating that a given value is any of the right operand of the Constraint.
    isNoneOf: URIRef  # A set-based operator indicating that a given value is none of the right operand of the Constraint.
    isPartOf: URIRef  # A set-based operator indicating that a given value is contained by the right operand of the Constraint.
    language: URIRef  # A natural language used by the target Asset.
    lt: URIRef  # Indicating that a given value is less than the right operand of the Constraint.
    lteq: URIRef  # Indicating that a given value is less than or equal to the right operand of the Constraint.
    media: URIRef  # Category of a media asset setting a context for exercising the action of the Rule.
    meteredTime: URIRef  # An accumulated amount of one to many metered time periods which were used for exercising the action of the Rule. Right operand value MUST be an xsd:duration as defined by [[xmlschema11-2]].
    neq: URIRef  # Indicating that a given value is not equal to the right operand of the Constraint.
    payAmount: URIRef  # The amount of a financial payment. Right operand value MUST be an xsd:decimal.
    percentage: URIRef  # A percentage amount of the target Asset relevant for exercising the action of the Rule. Right operand value MUST be an xsd:decimal from 0 to 100.
    perm: URIRef  # Permissions take preference over prohibitions.
    policyUsage: (
        URIRef  # Indicates the actual datetime the action of the Rule was exercised.
    )
    product: URIRef  # Category of product or service setting a context for exercising the action of the Rule.
    prohibit: URIRef  # Prohibitions take preference over permissions.
    purpose: URIRef  # A defined purpose for exercising the action of the Rule.
    recipient: URIRef  # The party receiving the result/outcome of exercising the action of the Rule.
    relativePosition: URIRef  # A point in space or time defined with coordinates relative to full measures the positioning of the target Asset.
    relativeSize: URIRef  # Measure(s) of one or two axes for 2D-objects or measure(s) of one to tree axes for 3D-objects - expressed as percentages of full values - of the target Asset.
    relativeSpatialPosition: URIRef  # The relative spatial positions - expressed as percentages of full values - of four corners of a rectangle on a 2D-canvas or the eight corners of a cuboid in a 3D-space of the target Asset.
    relativeTemporalPosition: URIRef  # A point in space or time defined with coordinates relative to full measures the positioning of the target Asset.
    resolution: URIRef  # Resolution of the rendition of the target Asset.
    spatial: URIRef  # A named and identified geospatial area with defined borders which is used for exercising the action of the Rule. An IRI MUST be used to represent this value.
    spatialCoordinates: URIRef  # A set of coordinates setting the borders of a geospatial area used for exercising the action of the Rule. The coordinates MUST include longitude and latitude, they MAY include altitude and the geodetic datum.
    support: URIRef  # The Action is to be supported as part of the policy – and the policy remains valid.
    system: URIRef  # An identified computing system used for exercising the action of the Rule.
    systemDevice: URIRef  # An identified computing system or computing device used for exercising the action of the Rule.
    timeInterval: URIRef  # A recurring period of time before the next execution of the action of the Rule. Right operand value MUST be an xsd:duration as defined by [[xmlschema11-2]].
    unitOfCount: URIRef  # The unit of measure used for counting the executions of the action of the Rule.
    version: URIRef  # The version of the target Asset.
    virtualLocation: URIRef  # An identified location of the IT communication space which is relevant for exercising the action of the Rule.

    # http://www.w3.org/2004/02/skos/core#Collection

    # http://www.w3.org/2004/02/skos/core#Concept
    Action: URIRef  # An operation on an Asset.
    Agreement: URIRef  # A Policy that grants the assignee a Rule over an Asset from an assigner.
    Assertion: URIRef  # A Policy that asserts a Rule over an Asset from parties.
    Asset: URIRef  # A resource or a collection of resources that are the subject of a Rule.
    AssetCollection: URIRef  # An Asset that is collection of individual resources
    AssetScope: URIRef  # Scopes for Asset Scope expressions.
    ConflictTerm: URIRef  # Used to establish strategies to resolve conflicts that arise from the merging of Policies or conflicts between Permissions and Prohibitions in the same Policy.
    Constraint: URIRef  # A boolean expression that refines the semantics of an Action and Party/Asset Collection or declare the conditions applicable to a Rule.
    Duty: URIRef  # The obligation to perform an Action
    LeftOperand: URIRef  # Left operand for a constraint expression.
    LogicalConstraint: URIRef  # A logical expression that refines the semantics of an Action and Party/Asset Collection or declare the conditions applicable to a Rule.
    Offer: URIRef  # A Policy that proposes a Rule over an Asset from an assigner.
    Operator: URIRef  # Operator for constraint expression.
    Party: (
        URIRef  # An entity or a collection of entities that undertake Roles in a Rule.
    )
    PartyCollection: URIRef  # A Party that is a group of individual entities
    PartyScope: URIRef  # Scopes for Party Scope expressions.
    Permission: URIRef  # The ability to perform an Action over an Asset.
    Policy: URIRef  # A non-empty group of Permissions and/or Prohibitions.
    Privacy: URIRef  # A Policy that expresses a Rule over an Asset containing personal information.
    Prohibition: URIRef  # The inability to perform an Action over an Asset.
    Request: URIRef  # A Policy that proposes a Rule over an Asset from an assignee.
    RightOperand: URIRef  # Right operand for constraint expression.
    Rule: URIRef  # An abstract concept that represents the common characteristics of Permissions, Prohibitions, and Duties.
    Set: URIRef  # A Policy that expresses a Rule over an Asset.
    Ticket: (
        URIRef  # A Policy that grants the holder a Rule over an Asset from an assigner.
    )
    UndefinedTerm: URIRef  # Is used to indicate how to support Actions that are not part of any vocabulary or profile in the policy expression system.
    acceptTracking: URIRef  # To accept that the use of the Asset may be tracked.
    adHocShare: URIRef  # The act of sharing the asset to parties in close proximity to the owner.
    aggregate: (
        URIRef  # To use the Asset or parts of it as part of a composite collection.
    )
    annotate: URIRef  # To add explanatory notations/commentaries to the Asset without modifying the Asset in any other way.
    anonymize: URIRef  # To anonymize all or parts of the Asset.
    append: URIRef  # The act of adding to the end of an asset.
    appendTo: URIRef  # The act of appending data to the Asset without modifying the Asset in any other way.
    archive: URIRef  # To store the Asset (in a non-transient form).
    attachPolicy: URIRef  # The act of keeping the policy notice with the asset.
    attachSource: (
        URIRef  # The act of attaching the source of the asset and its derivatives.
    )
    attribute: URIRef  # To attribute the use of the Asset.
    commercialize: URIRef  # The act of using the asset in a business environment.
    compensate: URIRef  # To compensate by transfer of some amount of value, if defined, for using or selling the Asset.
    concurrentUse: URIRef  # To create multiple copies of the Asset that are being concurrently used.
    copy: URIRef  # The act of making an exact reproduction of the asset.
    core: URIRef  # Identifier for the ODRL Core Profile
    delete: (
        URIRef  # To permanently remove all copies of the Asset after it has been used.
    )
    derive: URIRef  # To create a new derivative Asset from this Asset and to edit or modify the derivative.
    digitize: URIRef  # To produce a digital copy of (or otherwise digitize) the Asset from its analogue form.
    display: URIRef  # To create a static and transient rendition of an Asset.
    distribute: URIRef  # To supply the Asset to third-parties.
    ensureExclusivity: URIRef  # To ensure that the Rule on the Asset is exclusive.
    execute: URIRef  # To run the computer program Asset.
    export: URIRef  # The act of transforming the asset into a new form.
    extract: URIRef  # To extract parts of the Asset and to use it as a new Asset.
    extractChar: URIRef  # The act of extracting (replicating) unchanged characters from the asset.
    extractPage: (
        URIRef  # The act of extracting (replicating) unchanged pages from the asset.
    )
    extractWord: (
        URIRef  # The act of extracting (replicating) unchanged words from the asset.
    )
    give: URIRef  # To transfer the ownership of the Asset to a third party without compensation and while deleting the original asset.
    grantUse: URIRef  # To grant the use of the Asset to third parties.
    include: URIRef  # To include other related assets in the Asset.
    index: URIRef  # To record the Asset in an index.
    inform: URIRef  # To inform that an action has been performed on or in relation to the Asset.
    install: URIRef  # To load the computer program Asset onto a storage device which allows operating or running the Asset.
    lease: URIRef  # The act of making available the asset to a third-party for a fixed period of time with exchange of value.
    lend: URIRef  # The act of making available the asset to a third-party for a fixed period of time without exchange of value.
    license: URIRef  # The act of granting the right to use the asset to a third-party.
    modify: URIRef  # To change existing content of the Asset. A new asset is not created by this action.
    move: URIRef  # To move the Asset from one digital location to another including deleting the original copy.
    nextPolicy: URIRef  # To grant the specified Policy to a third party for their use of the Asset.
    obtainConsent: URIRef  # To obtain verifiable consent to perform the requested action in relation to the Asset.
    pay: URIRef  # The act of paying a financial amount to a party for use of the asset.
    play: URIRef  # To create a sequential and transient rendition of an Asset.
    present: URIRef  # To publicly perform the Asset.
    preview: URIRef  # The act of providing a short preview of the asset.
    print: URIRef  # To create a tangible and permanent rendition of an Asset.
    read: URIRef  # To obtain data from the Asset.
    reproduce: URIRef  # To make duplicate copies the Asset in any material form.
    reviewPolicy: URIRef  # To review the Policy applicable to the Asset.
    secondaryUse: URIRef  # The act of using the asset for a purpose other than the purpose it was intended for.
    sell: URIRef  # To transfer the ownership of the Asset to a third party with compensation and while deleting the original asset.
    share: URIRef  # The act of the non-commercial reproduction and distribution of the asset to third-parties.
    shareAlike: URIRef  # The act of distributing any derivative asset under the same terms as the original asset.
    stream: URIRef  # To deliver the Asset in real-time.
    synchronize: URIRef  # To use the Asset in timed relations with media (audio/visual) elements of another Asset.
    textToSpeech: URIRef  # To have a text Asset read out loud.
    transfer: URIRef  # To transfer the ownership of the Asset in perpetuity.
    transform: URIRef  # To convert the Asset into a different format.
    translate: URIRef  # To translate the original natural language of an Asset into another natural language.
    uninstall: URIRef  # To unload and delete the computer program Asset from a storage device and disable its readiness for operation.
    use: URIRef  # To use the Asset
    watermark: URIRef  # To apply a watermark to the Asset.
    write: URIRef  # The act of writing to the Asset.
    writeTo: URIRef  # The act of adding data to the Asset.

    # Valid non-python identifiers
    _extras = [
        "and",
        "or",
        "#actionConcepts",
        "#actions",
        "#actionsCommon",
        "#assetConcepts",
        "#assetParty",
        "#assetRelations",
        "#assetRelationsCommon",
        "#conflictConcepts",
        "#constraintLeftOperandCommon",
        "#constraintLogicalOperands",
        "#constraintRelationalOperators",
        "#constraintRightOpCommon",
        "#constraints",
        "#deprecatedTerms",
        "#duties",
        "#logicalConstraints",
        "#partyConcepts",
        "#partyRoles",
        "#partyRolesCommon",
        "#permissions",
        "#policyConcepts",
        "#policySubClasses",
        "#policySubClassesCommon",
        "#prohibitions",
        "#ruleConcepts",
    ]

    _NS = Namespace("http://www.w3.org/ns/odrl/2/")
