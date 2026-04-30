from rdflib.namespace import DefinedNamespace, Namespace
from rdflib.term import URIRef


class SH(DefinedNamespace):
    """
    W3C Shapes Constraint Language (SHACL) Vocabulary

    This vocabulary defines terms used in SHACL, the W3C Shapes Constraint Language.

    Generated from: https://www.w3.org/ns/shacl.ttl
    Date: 2020-05-26 14:20:08.041103

    """

    _fail = True

    # http://www.w3.org/1999/02/22-rdf-syntax-ns#Property
    alternativePath: URIRef  # The (single) value of this property must be a list of path elements, representing the elements of alternative paths.
    annotationProperty: URIRef  # The annotation property that shall be set.
    annotationValue: URIRef  # The (default) values of the annotation property.
    annotationVarName: URIRef  # The name of the SPARQL variable from the SELECT clause that shall be used for the values.
    ask: URIRef  # The SPARQL ASK query to execute.
    closed: URIRef  # If set to true then the shape is closed.
    condition: URIRef  # The shapes that the focus nodes need to conform to before a rule is executed on them.
    conforms: URIRef  # True if the validation did not produce any validation results, and false otherwise.
    construct: URIRef  # The SPARQL CONSTRUCT query to execute.
    datatype: URIRef  # Specifies an RDF datatype that all value nodes must have.
    deactivated: URIRef  # If set to true then all nodes conform to this.
    declare: URIRef  # Links a resource with its namespace prefix declarations.
    defaultValue: URIRef  # A default value for a property, for example for user interface tools to pre-populate input fields.
    description: URIRef  # Human-readable descriptions for the property in the context of the surrounding shape.
    detail: URIRef  # Links a result with other results that provide more details, for example to describe violations against nested shapes.
    disjoint: URIRef  # Specifies a property where the set of values must be disjoint with the value nodes.
    entailment: URIRef  # An entailment regime that indicates what kind of inferencing is required by a shapes graph.
    equals: URIRef  # Specifies a property that must have the same values as the value nodes.
    expression: URIRef  # The node expression that must return true for the value nodes.
    filterShape: (
        URIRef  # The shape that all input nodes of the expression need to conform to.
    )
    flags: (
        URIRef  # An optional flag to be used with regular expression pattern matching.
    )
    focusNode: URIRef  # The focus node that was validated when the result was produced.
    group: URIRef  # Can be used to link to a property group to indicate that a property shape belongs to a group of related property shapes.
    hasValue: URIRef  # Specifies a value that must be among the value nodes.
    ignoredProperties: URIRef  # An optional RDF list of properties that are also permitted in addition to those explicitly enumerated via sh:property/sh:path.
    intersection: URIRef  # A list of node expressions that shall be intersected.
    inversePath: URIRef  # The (single) value of this property represents an inverse path (object to subject).
    js: URIRef  # Constraints expressed in JavaScript.
    jsFunctionName: URIRef  # The name of the JavaScript function to execute.
    jsLibrary: URIRef  # Declares which JavaScript libraries are needed to execute this.
    jsLibraryURL: URIRef  # Declares the URLs of a JavaScript library. This should be the absolute URL of a JavaScript file. Implementations may redirect those to local files.
    labelTemplate: URIRef  # Outlines how human-readable labels of instances of the associated Parameterizable shall be produced. The values can contain {?paramName} as placeholders for the actual values of the given parameter.
    languageIn: (
        URIRef  # Specifies a list of language tags that all value nodes must have.
    )
    lessThan: URIRef  # Specifies a property that must have smaller values than the value nodes.
    lessThanOrEquals: URIRef  # Specifies a property that must have smaller or equal values than the value nodes.
    maxCount: (
        URIRef  # Specifies the maximum number of values in the set of value nodes.
    )
    maxExclusive: URIRef  # Specifies the maximum exclusive value of each value node.
    maxInclusive: URIRef  # Specifies the maximum inclusive value of each value node.
    maxLength: URIRef  # Specifies the maximum string length of each value node.
    message: URIRef  # A human-readable message (possibly with placeholders for variables) explaining the cause of the result.
    minCount: (
        URIRef  # Specifies the minimum number of values in the set of value nodes.
    )
    minExclusive: URIRef  # Specifies the minimum exclusive value of each value node.
    minInclusive: URIRef  # Specifies the minimum inclusive value of each value node.
    minLength: URIRef  # Specifies the minimum string length of each value node.
    name: URIRef  # Human-readable labels for the property in the context of the surrounding shape.
    namespace: URIRef  # The namespace associated with a prefix in a prefix declaration.
    node: URIRef  # Specifies the node shape that all value nodes must conform to.
    nodeKind: URIRef  # Specifies the node kind (e.g. IRI or literal) each value node.
    nodeValidator: URIRef  # The validator(s) used to evaluate a constraint in the context of a node shape.
    nodes: URIRef  # The node expression producing the input nodes of a filter shape expression.
    object: (
        URIRef  # An expression producing the nodes that shall be inferred as objects.
    )
    oneOrMorePath: URIRef  # The (single) value of this property represents a path that is matched one or more times.
    optional: URIRef  # Indicates whether a parameter is optional.
    order: URIRef  # Specifies the relative order of this compared to its siblings. For example use 0 for the first, 1 for the second.
    parameter: URIRef  # The parameters of a function or constraint component.
    path: URIRef  # Specifies the property path of a property shape.
    pattern: URIRef  # Specifies a regular expression pattern that the string representations of the value nodes must match.
    predicate: URIRef  # An expression producing the properties that shall be inferred as predicates.
    prefix: URIRef  # The prefix of a prefix declaration.
    prefixes: URIRef  # The prefixes that shall be applied before parsing the associated SPARQL query.
    property: URIRef  # Links a shape to its property shapes.
    propertyValidator: URIRef  # The validator(s) used to evaluate a constraint in the context of a property shape.
    qualifiedMaxCount: (
        URIRef  # The maximum number of value nodes that can conform to the shape.
    )
    qualifiedMinCount: (
        URIRef  # The minimum number of value nodes that must conform to the shape.
    )
    qualifiedValueShape: (
        URIRef  # The shape that a specified number of values must conform to.
    )
    qualifiedValueShapesDisjoint: URIRef  # Can be used to mark the qualified value shape to be disjoint with its sibling shapes.
    result: URIRef  # The validation results contained in a validation report.
    resultAnnotation: URIRef  # Links a SPARQL validator with zero or more sh:ResultAnnotation instances, defining how to derive additional result properties based on the variables of the SELECT query.
    resultMessage: URIRef  # Human-readable messages explaining the cause of the result.
    resultPath: URIRef  # The path of a validation result, based on the path of the validated property shape.
    resultSeverity: URIRef  # The severity of the result, e.g. warning.
    returnType: (
        URIRef  # The expected type of values returned by the associated function.
    )
    rule: URIRef  # The rules linked to a shape.
    select: URIRef  # The SPARQL SELECT query to execute.
    severity: URIRef  # Defines the severity that validation results produced by a shape must have. Defaults to sh:Violation.
    shapesGraph: (
        URIRef  # Shapes graphs that should be used when validating this data graph.
    )
    shapesGraphWellFormed: URIRef  # If true then the validation engine was certain that the shapes graph has passed all SHACL syntax requirements during the validation process.
    sourceConstraint: (
        URIRef  # The constraint that was validated when the result was produced.
    )
    sourceConstraintComponent: (
        URIRef  # The constraint component that is the source of the result.
    )
    sourceShape: URIRef  # The shape that is was validated when the result was produced.
    sparql: URIRef  # Links a shape with SPARQL constraints.
    subject: URIRef  # An expression producing the resources that shall be inferred as subjects.
    suggestedShapesGraph: URIRef  # Suggested shapes graphs for this ontology. The values of this property may be used in the absence of specific sh:shapesGraph statements.
    target: URIRef  # Links a shape to a target specified by an extension language, for example instances of sh:SPARQLTarget.
    targetClass: URIRef  # Links a shape to a class, indicating that all instances of the class must conform to the shape.
    targetNode: URIRef  # Links a shape to individual nodes, indicating that these nodes must conform to the shape.
    targetObjectsOf: URIRef  # Links a shape to a property, indicating that all all objects of triples that have the given property as their predicate must conform to the shape.
    targetSubjectsOf: URIRef  # Links a shape to a property, indicating that all subjects of triples that have the given property as their predicate must conform to the shape.
    union: URIRef  # A list of node expressions that shall be used together.
    uniqueLang: URIRef  # Specifies whether all node values must have a unique (or no) language tag.
    update: URIRef  # The SPARQL UPDATE to execute.
    validator: URIRef  # The validator(s) used to evaluate constraints of either node or property shapes.
    value: URIRef  # An RDF node that has caused the result.
    xone: URIRef  # Specifies a list of shapes so that the value nodes must conform to exactly one of the shapes.
    zeroOrMorePath: URIRef  # The (single) value of this property represents a path that is matched zero or more times.
    zeroOrOnePath: URIRef  # The (single) value of this property represents a path that is matched zero or one times.

    # http://www.w3.org/2000/01/rdf-schema#Class
    AbstractResult: URIRef  # The base class of validation results, typically not instantiated directly.
    ConstraintComponent: URIRef  # The class of constraint components.
    Function: URIRef  # The class of SHACL functions.
    JSConstraint: URIRef  # The class of constraints backed by a JavaScript function.
    JSExecutable: URIRef  # Abstract base class of resources that declare an executable JavaScript.
    JSFunction: URIRef  # The class of SHACL functions that execute a JavaScript function when called.
    JSLibrary: URIRef  # Represents a JavaScript library, typically identified by one or more URLs of files to include.
    JSRule: URIRef  # The class of SHACL rules expressed using JavaScript.
    JSTarget: URIRef  # The class of targets that are based on JavaScript functions.
    JSTargetType: URIRef  # The (meta) class for parameterizable targets that are based on JavaScript functions.
    JSValidator: URIRef  # A SHACL validator based on JavaScript. This can be used to declare SHACL constraint components that perform JavaScript-based validation when used.
    NodeKind: URIRef  # The class of all node kinds, including sh:BlankNode, sh:IRI, sh:Literal or the combinations of these: sh:BlankNodeOrIRI, sh:BlankNodeOrLiteral, sh:IRIOrLiteral.
    NodeShape: URIRef  # A node shape is a shape that specifies constraint that need to be met with respect to focus nodes.
    Parameter: URIRef  # The class of parameter declarations, consisting of a path predicate and (possibly) information about allowed value type, cardinality and other characteristics.
    Parameterizable: URIRef  # Superclass of components that can take parameters, especially functions and constraint components.
    PrefixDeclaration: URIRef  # The class of prefix declarations, consisting of pairs of a prefix with a namespace.
    PropertyGroup: URIRef  # Instances of this class represent groups of property shapes that belong together.
    PropertyShape: URIRef  # A property shape is a shape that specifies constraints on the values of a focus node for a given property or path.
    ResultAnnotation: URIRef  # A class of result annotations, which define the rules to derive the values of a given annotation property as extra values for a validation result.
    Rule: URIRef  # The class of SHACL rules. Never instantiated directly.
    SPARQLAskExecutable: (
        URIRef  # The class of SPARQL executables that are based on an ASK query.
    )
    SPARQLAskValidator: URIRef  # The class of validators based on SPARQL ASK queries. The queries are evaluated for each value node and are supposed to return true if the given node conforms.
    SPARQLConstraint: URIRef  # The class of constraints based on SPARQL SELECT queries.
    SPARQLConstructExecutable: (
        URIRef  # The class of SPARQL executables that are based on a CONSTRUCT query.
    )
    SPARQLExecutable: URIRef  # The class of resources that encapsulate a SPARQL query.
    SPARQLFunction: (
        URIRef  # A function backed by a SPARQL query - either ASK or SELECT.
    )
    SPARQLRule: URIRef  # The class of SHACL rules based on SPARQL CONSTRUCT queries.
    SPARQLSelectExecutable: (
        URIRef  # The class of SPARQL executables based on a SELECT query.
    )
    SPARQLSelectValidator: URIRef  # The class of validators based on SPARQL SELECT queries. The queries are evaluated for each focus node and are supposed to produce bindings for all focus nodes that do not conform.
    SPARQLTarget: URIRef  # The class of targets that are based on SPARQL queries.
    SPARQLTargetType: URIRef  # The (meta) class for parameterizable targets that are based on SPARQL queries.
    SPARQLUpdateExecutable: (
        URIRef  # The class of SPARQL executables based on a SPARQL UPDATE.
    )
    Severity: URIRef  # The class of validation result severity levels, including violation and warning levels.
    Shape: URIRef  # A shape is a collection of constraints that may be targeted for certain nodes.
    Target: URIRef  # The base class of targets such as those based on SPARQL queries.
    TargetType: URIRef  # The (meta) class for parameterizable targets.	Instances of this are instantiated as values of the sh:target property.
    TripleRule: URIRef  # A rule based on triple (subject, predicate, object) pattern.
    ValidationReport: URIRef  # The class of SHACL validation reports.
    ValidationResult: URIRef  # The class of validation results.
    Validator: URIRef  # The class of validators, which provide instructions on how to process a constraint definition. This class serves as base class for the SPARQL-based validators and other possible implementations.

    # http://www.w3.org/2000/01/rdf-schema#Resource
    this: URIRef  # A node expression that represents the current focus node.

    # http://www.w3.org/ns/shacl#ConstraintComponent
    AndConstraintComponent: URIRef  # A constraint component that can be used to test whether a value node conforms to all members of a provided list of shapes.
    ClassConstraintComponent: URIRef  # A constraint component that can be used to verify that each value node is an instance of a given type.
    ClosedConstraintComponent: URIRef  # A constraint component that can be used to indicate that focus nodes must only have values for those properties that have been explicitly enumerated via sh:property/sh:path.
    DatatypeConstraintComponent: URIRef  # A constraint component that can be used to restrict the datatype of all value nodes.
    DisjointConstraintComponent: URIRef  # A constraint component that can be used to verify that the set of value nodes is disjoint with the the set of nodes that have the focus node as subject and the value of a given property as predicate.
    EqualsConstraintComponent: URIRef  # A constraint component that can be used to verify that the set of value nodes is equal to the set of nodes that have the focus node as subject and the value of a given property as predicate.
    ExpressionConstraintComponent: URIRef  # A constraint component that can be used to verify that a given node expression produces true for all value nodes.
    HasValueConstraintComponent: URIRef  # A constraint component that can be used to verify that one of the value nodes is a given RDF node.
    InConstraintComponent: URIRef  # A constraint component that can be used to exclusively enumerate the permitted value nodes.
    JSConstraintComponent: URIRef  # A constraint component with the parameter sh:js linking to a sh:JSConstraint containing a sh:script.
    LanguageInConstraintComponent: URIRef  # A constraint component that can be used to enumerate language tags that all value nodes must have.
    LessThanConstraintComponent: URIRef  # A constraint component that can be used to verify that each value node is smaller than all the nodes that have the focus node as subject and the value of a given property as predicate.
    LessThanOrEqualsConstraintComponent: URIRef  # A constraint component that can be used to verify that every value node is smaller than all the nodes that have the focus node as subject and the value of a given property as predicate.
    MaxCountConstraintComponent: URIRef  # A constraint component that can be used to restrict the maximum number of value nodes.
    MaxExclusiveConstraintComponent: URIRef  # A constraint component that can be used to restrict the range of value nodes with a maximum exclusive value.
    MaxInclusiveConstraintComponent: URIRef  # A constraint component that can be used to restrict the range of value nodes with a maximum inclusive value.
    MaxLengthConstraintComponent: URIRef  # A constraint component that can be used to restrict the maximum string length of value nodes.
    MinCountConstraintComponent: URIRef  # A constraint component that can be used to restrict the minimum number of value nodes.
    MinExclusiveConstraintComponent: URIRef  # A constraint component that can be used to restrict the range of value nodes with a minimum exclusive value.
    MinInclusiveConstraintComponent: URIRef  # A constraint component that can be used to restrict the range of value nodes with a minimum inclusive value.
    MinLengthConstraintComponent: URIRef  # A constraint component that can be used to restrict the minimum string length of value nodes.
    NodeConstraintComponent: URIRef  # A constraint component that can be used to verify that all value nodes conform to the given node shape.
    NodeKindConstraintComponent: URIRef  # A constraint component that can be used to restrict the RDF node kind of each value node.
    NotConstraintComponent: URIRef  # A constraint component that can be used to verify that value nodes do not conform to a given shape.
    OrConstraintComponent: URIRef  # A constraint component that can be used to restrict the value nodes so that they conform to at least one out of several provided shapes.
    PatternConstraintComponent: URIRef  # A constraint component that can be used to verify that every value node matches a given regular expression.
    PropertyConstraintComponent: URIRef  # A constraint component that can be used to verify that all value nodes conform to the given property shape.
    QualifiedMaxCountConstraintComponent: URIRef  # A constraint component that can be used to verify that a specified maximum number of value nodes conforms to a given shape.
    QualifiedMinCountConstraintComponent: URIRef  # A constraint component that can be used to verify that a specified minimum number of value nodes conforms to a given shape.
    SPARQLConstraintComponent: URIRef  # A constraint component that can be used to define constraints based on SPARQL queries.
    UniqueLangConstraintComponent: URIRef  # A constraint component that can be used to specify that no pair of value nodes may use the same language tag.
    XoneConstraintComponent: URIRef  # A constraint component that can be used to restrict the value nodes so that they conform to exactly one out of several provided shapes.

    # http://www.w3.org/ns/shacl#NodeKind
    BlankNode: URIRef  # The node kind of all blank nodes.
    BlankNodeOrIRI: URIRef  # The node kind of all blank nodes or IRIs.
    BlankNodeOrLiteral: URIRef  # The node kind of all blank nodes or literals.
    IRI: URIRef  # The node kind of all IRIs.
    IRIOrLiteral: URIRef  # The node kind of all IRIs or literals.
    Literal: URIRef  # The node kind of all literals.

    # http://www.w3.org/ns/shacl#Parameter

    # http://www.w3.org/ns/shacl#Severity
    Info: URIRef  # The severity for an informational validation result.
    Violation: URIRef  # The severity for a violation validation result.
    Warning: URIRef  # The severity for a warning validation result.

    # Valid non-python identifiers
    _extras = [
        "and",
        "class",
        "in",
        "not",
        "or",
        "AndConstraintComponent-and",
        "ClassConstraintComponent-class",
        "ClosedConstraintComponent-closed",
        "ClosedConstraintComponent-ignoredProperties",
        "DatatypeConstraintComponent-datatype",
        "DisjointConstraintComponent-disjoint",
        "EqualsConstraintComponent-equals",
        "ExpressionConstraintComponent-expression",
        "HasValueConstraintComponent-hasValue",
        "InConstraintComponent-in",
        "JSConstraint-js",
        "LanguageInConstraintComponent-languageIn",
        "LessThanConstraintComponent-lessThan",
        "LessThanOrEqualsConstraintComponent-lessThanOrEquals",
        "MaxCountConstraintComponent-maxCount",
        "MaxExclusiveConstraintComponent-maxExclusive",
        "MaxInclusiveConstraintComponent-maxInclusive",
        "MaxLengthConstraintComponent-maxLength",
        "MinCountConstraintComponent-minCount",
        "MinExclusiveConstraintComponent-minExclusive",
        "MinInclusiveConstraintComponent-minInclusive",
        "MinLengthConstraintComponent-minLength",
        "NodeConstraintComponent-node",
        "NodeKindConstraintComponent-nodeKind",
        "NotConstraintComponent-not",
        "OrConstraintComponent-or",
        "PatternConstraintComponent-flags",
        "PatternConstraintComponent-pattern",
        "PropertyConstraintComponent-property",
        "QualifiedMaxCountConstraintComponent-qualifiedMaxCount",
        "QualifiedMaxCountConstraintComponent-qualifiedValueShape",
        "QualifiedMaxCountConstraintComponent-qualifiedValueShapesDisjoint",
        "QualifiedMinCountConstraintComponent-qualifiedMinCount",
        "QualifiedMinCountConstraintComponent-qualifiedValueShape",
        "QualifiedMinCountConstraintComponent-qualifiedValueShapesDisjoint",
        "SPARQLConstraintComponent-sparql",
        "UniqueLangConstraintComponent-uniqueLang",
        "XoneConstraintComponent-xone",
    ]

    _NS = Namespace("http://www.w3.org/ns/shacl#")
