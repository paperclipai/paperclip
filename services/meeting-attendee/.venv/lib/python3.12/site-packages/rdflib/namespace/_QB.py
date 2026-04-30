from rdflib.namespace import DefinedNamespace, Namespace
from rdflib.term import URIRef


class QB(DefinedNamespace):
    """
    Vocabulary for multi-dimensional (e.g. statistical) data publishing

    This vocabulary allows multi-dimensional data, such as statistics, to be published in RDF. It is based on the
    core information model from SDMX (and thus also DDI).

    Generated from: http://purl.org/linked-data/cube#
    Date: 2020-05-26 14:20:05.485176

    """

    _fail = True

    # http://www.w3.org/1999/02/22-rdf-syntax-ns#Property
    attribute: URIRef  # An alternative to qb:componentProperty which makes explicit that the component is a attribute
    codeList: URIRef  # gives the code list associated with a CodedProperty
    component: URIRef  # indicates a component specification which is included in the structure of the dataset
    componentAttachment: URIRef  # Indicates the level at which the component property should be attached, this might an qb:DataSet, qb:Slice or qb:Observation, or a qb:MeasureProperty.
    componentProperty: URIRef  # indicates a ComponentProperty (i.e. attribute/dimension) expected on a DataSet, or a dimension fixed in a SliceKey
    componentRequired: URIRef  # Indicates whether a component property is required (true) or optional (false) in the context of a DSD. Only applicable     to components correspond to an attribute. Defaults to false (optional).
    concept: URIRef  # gives the concept which is being measured or indicated by a ComponentProperty
    dataSet: URIRef  # indicates the data set of which this observation is a part
    dimension: URIRef  # An alternative to qb:componentProperty which makes explicit that the component is a dimension
    hierarchyRoot: URIRef  # Specifies a root of the hierarchy. A hierarchy may have multiple roots but must have at least one.
    measure: URIRef  # An alternative to qb:componentProperty which makes explicit that the component is a measure
    measureDimension: URIRef  # An alternative to qb:componentProperty which makes explicit that the component is a measure dimension
    measureType: URIRef  # Generic measure dimension, the value of this dimension indicates which measure (from the set of measures in the DSD) is being given by the obsValue (or other primary measure)
    observation: (
        URIRef  # indicates a observation contained within this slice of the data set
    )
    observationGroup: URIRef  # Indicates a group of observations. The domain of this property is left open so that a group may be attached to different resources and need not be restricted to a single DataSet
    order: URIRef  # indicates a priority order for the components of sets with this structure, used to guide presentations - lower order numbers come before higher numbers, un-numbered components come last
    parentChildProperty: URIRef  # Specifies a property which relates a parent concept in the hierarchy to a child concept.
    slice: URIRef  # Indicates a subset of a DataSet defined by fixing a subset of the dimensional values
    sliceKey: URIRef  # indicates a slice key which is used for slices in this dataset
    sliceStructure: URIRef  # indicates the sub-key corresponding to this slice
    structure: URIRef  # indicates the structure to which this data set conforms

    # http://www.w3.org/2000/01/rdf-schema#Class
    Attachable: URIRef  # Abstract superclass for everything that can have attributes and dimensions
    AttributeProperty: URIRef  # The class of components which represent attributes of observations in the cube, e.g. unit of measurement
    CodedProperty: URIRef  # Superclass of all coded ComponentProperties
    ComponentProperty: URIRef  # Abstract super-property of all properties representing dimensions, attributes or measures
    ComponentSet: URIRef  # Abstract class of things which reference one or more ComponentProperties
    ComponentSpecification: URIRef  # Used to define properties of a component (attribute, dimension etc) which are specific to its usage in a DSD.
    DataSet: URIRef  # Represents a collection of observations, possibly organized into various slices, conforming to some common dimensional structure.
    DataStructureDefinition: URIRef  # Defines the structure of a DataSet or slice
    DimensionProperty: (
        URIRef  # The class of components which represent the dimensions of the cube
    )
    HierarchicalCodeList: URIRef  # Represents a generalized hierarchy of concepts which can be used for coding. The hierarchy is defined by one or more roots together with a property which relates concepts in the hierarchy to their child concept .  The same concepts may be members of multiple hierarchies provided that different qb:parentChildProperty values are used for each hierarchy.
    MeasureProperty: URIRef  # The class of components which represent the measured value of the phenomenon being observed
    Observation: URIRef  # A single observation in the cube, may have one or more associated measured values
    ObservationGroup: URIRef  # A, possibly arbitrary, group of observations.
    Slice: URIRef  # Denotes a subset of a DataSet defined by fixing a subset of the dimensional values, component properties on the Slice
    SliceKey: URIRef  # Denotes a subset of the component properties of a DataSet which are fixed in the corresponding slices

    _NS = Namespace("http://purl.org/linked-data/cube#")
