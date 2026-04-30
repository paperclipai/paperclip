from rdflib.namespace import DefinedNamespace, Namespace
from rdflib.term import URIRef


class PROF(DefinedNamespace):
    """
    Profiles Vocabulary

    This vocabulary is for describing relationships between standards/specifications, profiles of them and
    supporting artifacts such as validating resources.  This model starts with
    [http://dublincore.org/2012/06/14/dcterms#Standard](dct:Standard) entities which can either be Base
    Specifications (a standard not profiling any other Standard) or Profiles (Standards which do profile others).
    Base Specifications or Profiles can have Resource Descriptors associated with them that defines implementing
    rules for the it. Resource Descriptors must indicate the role they play (to guide, to validate etc.) and the
    formalism they adhere to (dct:format) to allow for content negotiation. A vocabulary of Resource Roles are
    provided alongside this vocabulary but that list is extensible.

    Generated from: https://www.w3.org/ns/dx/prof/profilesont.ttl
    Date: 2020-05-26 14:20:03.542924

    """

    # http://www.w3.org/2002/07/owl#Class
    Profile: URIRef  # A named set of constraints on one or more identified base specifications or other profiles, including the identification of any implementing subclasses of datatypes, semantic interpretations, vocabularies, options and parameters of those base specifications necessary to accomplish a particular function.  This definition includes what are often called "application profiles", "metadata application profiles", or "metadata profiles".
    ResourceDescriptor: URIRef  # A resource that defines an aspect - a particular part or feature - of a Profile
    ResourceRole: URIRef  # The role that an Resource plays

    # http://www.w3.org/2002/07/owl#DatatypeProperty
    hasToken: URIRef  # A preferred alternative identifier for the Profile

    # http://www.w3.org/2002/07/owl#ObjectProperty
    hasArtifact: URIRef  # The URL of a downloadable file with particulars such as its format and role indicated by a Resource Descriptor
    hasResource: URIRef  # A resource which describes the nature of an artifact and the role it plays in relation to a profile
    hasRole: URIRef  # The function of the described artifactresource in the expression of the Profile, such as a specification, guidance documentation, SHACL file etc.
    isInheritedFrom: URIRef  # This property indicates a Resource Descriptor described by this Profile’s base specification that is to be considered a Resource Descriptor for this Profile also
    isProfileOf: URIRef  # A Profile is a profile of a dct:Standard (or a Base Specification or another Profile)
    isTransitiveProfileOf: URIRef  # A base specification an Profile conforms to

    _NS = Namespace("http://www.w3.org/ns/dx/prof/")
