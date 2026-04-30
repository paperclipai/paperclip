from __future__ import annotations

import collections
from typing import DefaultDict, Dict, Optional, Set

from rdflib.graph import Graph, _ObjectType, _PredicateType, _SubjectType
from rdflib.namespace import RDF, VOID
from rdflib.term import IdentifiedNode, Literal, URIRef


def generateVoID(  # noqa: N802
    g: Graph,
    dataset: Optional[IdentifiedNode] = None,
    res: Optional[Graph] = None,
    distinctForPartitions: bool = True,  # noqa: N803
):
    """Returns a new graph with a VoID description of the passed dataset

    For more info on Vocabulary of Interlinked Datasets (VoID), see:
    http://vocab.deri.ie/void

    This only makes two passes through the triples (once to detect the types
    of things)

    The tradeoff is that lots of temporary structures are built up in memory
    meaning lots of memory may be consumed :)
    I imagine at least a few copies of your original graph.

    the distinctForPartitions parameter controls whether
    distinctSubjects/objects are tracked for each class/propertyPartition
    this requires more memory again
    """

    typeMap: Dict[_SubjectType, Set[_SubjectType]] = (  # noqa: N806
        collections.defaultdict(set)
    )
    classes: Dict[_ObjectType, Set[_SubjectType]] = collections.defaultdict(set)
    for e, c in g.subject_objects(RDF.type):
        classes[c].add(e)
        typeMap[e].add(c)

    triples = 0
    subjects: Set[_SubjectType] = set()
    objects: Set[_ObjectType] = set()
    properties: Set[_PredicateType] = set()
    classCount: DefaultDict[_SubjectType, int] = collections.defaultdict(  # noqa: N806
        int
    )
    propCount: DefaultDict[_PredicateType, int] = collections.defaultdict(  # noqa: N806
        int
    )

    classProps = collections.defaultdict(set)  # noqa: N806
    classObjects = collections.defaultdict(set)  # noqa: N806
    propSubjects = collections.defaultdict(set)  # noqa: N806
    propObjects = collections.defaultdict(set)  # noqa: N806

    for s, p, o in g:
        triples += 1
        subjects.add(s)
        properties.add(p)
        objects.add(o)

        # class partitions
        if s in typeMap:
            for c in typeMap[s]:
                classCount[c] += 1
                if distinctForPartitions:
                    classObjects[c].add(o)
                    classProps[c].add(p)

        # property partitions
        propCount[p] += 1
        if distinctForPartitions:
            propObjects[p].add(o)
            propSubjects[p].add(s)

    if not dataset:
        dataset = URIRef("http://example.org/Dataset")

    if not res:
        res = Graph()

    res.add((dataset, RDF.type, VOID.Dataset))

    # basic stats
    res.add((dataset, VOID.triples, Literal(triples)))
    res.add((dataset, VOID.classes, Literal(len(classes))))

    res.add((dataset, VOID.distinctObjects, Literal(len(objects))))
    res.add((dataset, VOID.distinctSubjects, Literal(len(subjects))))
    res.add((dataset, VOID.properties, Literal(len(properties))))

    for i, c in enumerate(classes):
        part = URIRef(dataset + "_class%d" % i)
        res.add((dataset, VOID.classPartition, part))
        res.add((part, RDF.type, VOID.Dataset))

        res.add((part, VOID.triples, Literal(classCount[c])))
        res.add((part, VOID.classes, Literal(1)))

        res.add((part, VOID["class"], c))

        res.add((part, VOID.entities, Literal(len(classes[c]))))
        res.add((part, VOID.distinctSubjects, Literal(len(classes[c]))))

        if distinctForPartitions:
            res.add((part, VOID.properties, Literal(len(classProps[c]))))
            res.add((part, VOID.distinctObjects, Literal(len(classObjects[c]))))

    for i, p in enumerate(properties):
        part = URIRef(dataset + "_property%d" % i)
        res.add((dataset, VOID.propertyPartition, part))
        res.add((part, RDF.type, VOID.Dataset))

        res.add((part, VOID.triples, Literal(propCount[p])))
        res.add((part, VOID.properties, Literal(1)))

        res.add((part, VOID.property, p))

        if distinctForPartitions:
            entities = 0
            propClasses = set()  # noqa: N806
            for s in propSubjects[p]:
                if s in typeMap:
                    entities += 1
                for c in typeMap[s]:
                    propClasses.add(c)

            res.add((part, VOID.entities, Literal(entities)))
            res.add((part, VOID.classes, Literal(len(propClasses))))

            res.add((part, VOID.distinctSubjects, Literal(len(propSubjects[p]))))
            res.add((part, VOID.distinctObjects, Literal(len(propObjects[p]))))

    return res, dataset
