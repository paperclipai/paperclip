from rdflib.namespace import DefinedNamespace, Namespace
from rdflib.term import URIRef


class SOSA(DefinedNamespace):
    """
    Sensor, Observation, Sample, and Actuator (SOSA) Ontology

    This ontology is based on the SSN Ontology by the W3C Semantic Sensor Networks Incubator Group (SSN-XG),
    together with considerations from the W3C/OGC Spatial Data on the Web Working Group.

    Generated from: http://www.w3.org/ns/sosa/
    Date: 2020-05-26 14:20:08.792504

    """

    # http://www.w3.org/2000/01/rdf-schema#Class
    ActuatableProperty: URIRef  # An actuatable quality (property, characteristic) of a FeatureOfInterest.
    Actuation: URIRef  # An Actuation carries out an (Actuation) Procedure to change the state of the world using an Actuator.
    Actuator: URIRef  # A device that is used by, or implements, an (Actuation) Procedure that changes the state of the world.
    FeatureOfInterest: URIRef  # The thing whose property is being estimated or calculated in the course of an Observation to arrive at a Result or whose property is being manipulated by an Actuator, or which is being sampled or transformed in an act of Sampling.
    ObservableProperty: URIRef  # An observable quality (property, characteristic) of a FeatureOfInterest.
    Observation: URIRef  # Act of carrying out an (Observation) Procedure to estimate or calculate a value of a property of a FeatureOfInterest. Links to a Sensor to describe what made the Observation and how; links to an ObservableProperty to describe what the result is an estimate of, and to a FeatureOfInterest to detail what that property was associated with.
    ObservationCollection: URIRef  # Collection of one or more observations, whose members share a common value for one or more property
    Platform: URIRef  # A Platform is an entity that hosts other entities, particularly Sensors, Actuators, Samplers, and other Platforms.
    Procedure: URIRef  # A workflow, protocol, plan, algorithm, or computational method specifying how to make an Observation, create a Sample, or make a change to the state of the world (via an Actuator). A Procedure is re-usable, and might be involved in many Observations, Samplings, or Actuations. It explains the steps to be carried out to arrive at reproducible results.
    Result: URIRef  # The Result of an Observation, Actuation, or act of Sampling. To store an observation's simple result value one can use the hasSimpleResult property.
    Sample: URIRef  # Feature which is intended to be representative of a FeatureOfInterest on which Observations may be made.
    Sampler: URIRef  # A device that is used by, or implements, a Sampling Procedure to create or transform one or more samples.
    Sampling: URIRef  # An act of Sampling carries out a sampling Procedure to create or transform one or more samples.
    Sensor: URIRef  # Device, agent (including humans), or software (simulation) involved in, or implementing, a Procedure. Sensors respond to a stimulus, e.g., a change in the environment, or input data composed from the results of prior Observations, and generate a Result. Sensors can be hosted by Platforms.

    # http://www.w3.org/2002/07/owl#DatatypeProperty
    hasSimpleResult: (
        URIRef  # The simple value of an Observation or Actuation or act of Sampling.
    )
    resultTime: URIRef  # The result time is the instant of time when the Observation, Actuation or Sampling activity was completed.

    # http://www.w3.org/2002/07/owl#ObjectProperty
    actsOnProperty: URIRef  # Relation between an Actuation and the property of a FeatureOfInterest it is acting upon.
    hasFeatureOfInterest: URIRef  # A relation between an Observation and the entity whose quality was observed, or between an Actuation and the entity whose property was modified, or between an act of Sampling and the entity that was sampled.
    hasMember: URIRef  # Link to a member of a collection of observations that share the same value for one or more of the characteristic properties
    hasOriginalSample: URIRef  # link to the original sample that is related to the context sample through a chain of isSampleOf relations
    hasResult: URIRef  # Relation linking an Observation or Actuation or act of Sampling and a Result or Sample.
    hasSample: URIRef  # Relation between a FeatureOfInterest and the Sample used to represent it.
    hasSampledFeature: URIRef  # link to the ultimate feature of interest of the context sample - i.e. the end of a chain of isSampleOf relations
    hasUltimateFeatureOfInterest: URIRef  # link to the ultimate feature of interest of an observation or act of sampling. This is useful when the proximate feature of interest is a sample of the ultimate feature of interest, directly or trasntitively.
    hosts: URIRef  # Relation between a Platform and a Sensor, Actuator, Sampler, or Platform, hosted or mounted on it.
    isActedOnBy: URIRef  # Relation between an ActuatableProperty of a FeatureOfInterest and an Actuation changing its state.
    isFeatureOfInterestOf: URIRef  # A relation between a FeatureOfInterest and an Observation about it, an Actuation acting on it, or an act of Sampling that sampled it.
    isHostedBy: URIRef  # Relation between a Sensor, Actuator, Sampler, or Platform, and the Platform that it is mounted on or hosted by.
    isObservedBy: URIRef  # Relation between an ObservableProperty and the Sensor able to observe it.
    isResultOf: URIRef  # Relation linking a Result to the Observation or Actuation or act of Sampling that created or caused it.
    isSampleOf: URIRef  # Relation from a Sample to the FeatureOfInterest that it is intended to be representative of.
    madeActuation: URIRef  # Relation between an Actuator and the Actuation it has made.
    madeByActuator: URIRef  # Relation linking an Actuation to the Actuator that made that Actuation.
    madeBySampler: URIRef  # Relation linking an act of Sampling to the Sampler (sampling device or entity) that made it.
    madeBySensor: URIRef  # Relation between an Observation and the Sensor which made the Observation.
    madeObservation: (
        URIRef  # Relation between a Sensor and an Observation made by the Sensor.
    )
    madeSampling: URIRef  # Relation between a Sampler (sampling device or entity) and the Sampling act it performed.
    observedProperty: URIRef  # Relation linking an Observation to the property that was observed. The ObservableProperty should be a property of the FeatureOfInterest (linked by hasFeatureOfInterest) of this Observation.
    observes: URIRef  # Relation between a Sensor and an ObservableProperty that it is capable of sensing.
    phenomenonTime: URIRef  # The time that the Result of an Observation, Actuation or Sampling applies to the FeatureOfInterest. Not necessarily the same as the resultTime. May be an Interval or an Instant, or some other compound TemporalEntity.
    usedProcedure: URIRef  # A relation to link to a re-usable Procedure used in making an Observation, an Actuation, or a Sample, typically through a Sensor, Actuator or Sampler.

    _NS = Namespace("http://www.w3.org/ns/sosa/")
