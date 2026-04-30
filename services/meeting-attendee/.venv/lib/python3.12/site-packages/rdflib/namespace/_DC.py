from rdflib.namespace import DefinedNamespace, Namespace
from rdflib.term import URIRef


class DC(DefinedNamespace):
    """
    Dublin Core Metadata Element Set, Version 1.1

    Generated from: https://www.dublincore.org/specifications/dublin-core/dcmi-terms/dublin_core_elements.ttl
    Date: 2020-05-26 14:19:58.671906

    """

    _fail = True

    # http://www.w3.org/1999/02/22-rdf-syntax-ns#Property
    contributor: (
        URIRef  # An entity responsible for making contributions to the resource.
    )
    coverage: URIRef  # The spatial or temporal topic of the resource, spatial applicability of the resource, or jurisdiction under which the resource is relevant.
    creator: URIRef  # An entity primarily responsible for making the resource.
    date: URIRef  # A point or period of time associated with an event in the lifecycle of the resource.
    description: URIRef  # An account of the resource.
    format: URIRef  # The file format, physical medium, or dimensions of the resource.
    identifier: (
        URIRef  # An unambiguous reference to the resource within a given context.
    )
    language: URIRef  # A language of the resource.
    publisher: URIRef  # An entity responsible for making the resource available.
    relation: URIRef  # A related resource.
    rights: URIRef  # Information about rights held in and over the resource.
    source: URIRef  # A related resource from which the described resource is derived.
    subject: URIRef  # The topic of the resource.
    title: URIRef  # A name given to the resource.
    type: URIRef  # The nature or genre of the resource.

    _NS = Namespace("http://purl.org/dc/elements/1.1/")
