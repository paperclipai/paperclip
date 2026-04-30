"""RDFLib Python binding for OWL Abstract Syntax

| OWL Constructor   | DL Syntax     | Manchester OWL Syntax | Example                          |
|------------------|---------------|------------------------|----------------------------------|
| `intersectionOf` | C ∩ D         | C AND D                | Human AND Male                   |
| `unionOf`        | C ∪ D         | C OR D                 | Man OR Woman                     |
| `complementOf`   | ¬C            | NOT C                  | NOT Male                         |
| `oneOf`          | {a} ∪ {b}...  | {a b ...}              | {England Italy Spain}           |
| `someValuesFrom` | ∃ R C         | R SOME C               | hasColleague SOME Professor      |
| `allValuesFrom`  | ∀ R C         | R ONLY C               | hasColleague ONLY Professor      |
| `minCardinality` | ≥ N R         | R MIN 3                | hasColleague MIN 3               |
| `maxCardinality` | ≤ N R         | R MAX 3                | hasColleague MAX 3               |
| `cardinality`    | = N R         | R EXACTLY 3            | hasColleague EXACTLY 3           |
| `hasValue`       | ∃ R.{a}       | R VALUE a              | hasColleague VALUE Matthew       |

See:
- http://www.w3.org/TR/owl-semantics/syntax.html
- http://owl-workshop.man.ac.uk/acceptedLong/submission_9.pdf

3.2.3 Axioms for complete classes without using owl:equivalentClass

Named class description of type 2 (with owl:oneOf) or type 4-6
(with owl:intersectionOf, owl:unionOf or owl:complementOf

Uses Manchester Syntax for `__repr__`

```python
>>> exNs = Namespace("http://example.com/")
>>> g = Graph()
>>> g.bind("ex", exNs, override=False)

```

Now we have an empty graph, we can construct OWL classes in it
using the Python classes defined in this module

```python
>>> a = Class(exNs.Opera, graph=g)

```

Now we can assert rdfs:subClassOf and owl:equivalentClass relationships
(in the underlying graph) with other classes using the 'subClassOf'
and 'equivalentClass' descriptors which can be set to a list
of objects for the corresponding predicates.

```python
>>> a.subClassOf = [exNs.MusicalWork]

```

We can then access the rdfs:subClassOf relationships

```python
>>> print(list(a.subClassOf))
[Class: ex:MusicalWork ]

```

This can also be used against already populated graphs:

```python
>>> owlGraph = Graph().parse(str(OWL))
>>> list(Class(OWL.Class, graph=owlGraph).subClassOf)
[Class: rdfs:Class ]

```

Operators are also available. For instance we can add ex:Opera to the extension
of the ex:CreativeWork class via the '+=' operator

```python
>>> a
Class: ex:Opera SubClassOf: ex:MusicalWork
>>> b = Class(exNs.CreativeWork, graph=g)
>>> b += a
>>> print(sorted(a.subClassOf, key=lambda c:c.identifier))
[Class: ex:CreativeWork , Class: ex:MusicalWork ]

```

And we can then remove it from the extension as well

```python
>>> b -= a
>>> a
Class: ex:Opera SubClassOf: ex:MusicalWork

```

Boolean class constructions can also  be created with Python operators.
For example, The | operator can be used to construct a class consisting of a
owl:unionOf the operands:

```python
>>> c =  a | b | Class(exNs.Work, graph=g)
>>> c
( ex:Opera OR ex:CreativeWork OR ex:Work )

```

Boolean class expressions can also be operated as lists (using python list
operators)

```python
>>> del c[c.index(Class(exNs.Work, graph=g))]
>>> c
( ex:Opera OR ex:CreativeWork )

```

The '&' operator can be used to construct class intersection:

```python
>>> woman = Class(exNs.Female, graph=g) & Class(exNs.Human, graph=g)
>>> woman.identifier = exNs.Woman
>>> woman
( ex:Female AND ex:Human )
>>> len(woman)
2

```

Enumerated classes can also be manipulated

```python
>>> contList = [Class(exNs.Africa, graph=g), Class(exNs.NorthAmerica, graph=g)]
>>> EnumeratedClass(members=contList, graph=g)
{ ex:Africa ex:NorthAmerica }

```

owl:Restrictions can also be instantiated:

```python
>>> Restriction(exNs.hasParent, graph=g, allValuesFrom=exNs.Human)
( ex:hasParent ONLY ex:Human )

```

Restrictions can also be created using Manchester OWL syntax in 'colloquial' Python

```python
>>> exNs.hasParent @ some @ Class(exNs.Physician, graph=g)
( ex:hasParent SOME ex:Physician )
>>> Property(exNs.hasParent, graph=g) @ max @ Literal(1)
( ex:hasParent MAX 1 )
>>> print(g.serialize(format='pretty-xml'))  # doctest: +SKIP
```
"""

from __future__ import annotations

import itertools
import logging
from typing import Iterable, Union

from rdflib.collection import Collection
from rdflib.graph import Graph, _ObjectType
from rdflib.namespace import OWL, RDF, RDFS, XSD, Namespace, NamespaceManager
from rdflib.term import BNode, Identifier, Literal, URIRef, Variable
from rdflib.util import first

logger = logging.getLogger(__name__)


"""
From: http://aspn.activestate.com/ASPN/Cookbook/Python/Recipe/384122

Python has the wonderful "in" operator and it would be nice to have additional
infix operator like this. This recipe shows how (almost) arbitrary infix
operators can be defined.
"""

__all__ = [
    "ACE_NS",
    "AllClasses",
    "AllDifferent",
    "AllProperties",
    "AnnotatableTerms",
    "BooleanClass",
    "CLASS_RELATIONS",
    "Callable",
    "CastClass",
    "Class",
    "ClassNamespaceFactory",
    "CommonNSBindings",
    "ComponentTerms",
    "DeepClassClear",
    "EnumeratedClass",
    "GetIdentifiedClasses",
    "Individual",
    "Infix",
    "MalformedClass",
    "MalformedClassError",
    "OWLRDFListProxy",
    "Ontology",
    "Property",
    "PropertyAbstractSyntax",
    "Restriction",
    "classOrIdentifier",
    "classOrTerm",
    "exactly",
    "generateQName",
    "manchesterSyntax",
    "max",
    "min",
    "nsBinds",
    "only",
    "propertyOrIdentifier",
    "some",
    "value",
]

# definition of an Infix operator class
# this recipe also works in jython
# calling sequence for the infix is:
#  x @ op @ y


class Infix:
    def __init__(self, function):
        self.function = function

    def __rlshift__(self, other):
        return Infix(lambda x, self=self, other=other: self.function(other, x))

    def __rshift__(self, other):
        return self.function(other)

    def __rmatmul__(self, other):
        return Infix(lambda x, self=self, other=other: self.function(other, x))

    def __matmul__(self, other):
        return self.function(other)

    def __call__(self, value1, value2):
        return self.function(value1, value2)  # pragma: no cover


nsBinds = {  # noqa: N816
    "skos": "http://www.w3.org/2004/02/skos/core#",
    "rdf": RDF,
    "rdfs": RDFS,
    "owl": OWL,
    "list": URIRef("http://www.w3.org/2000/10/swap/list#"),
    "dc": "http://purl.org/dc/elements/1.1/",
}


def generateQName(graph, uri):  # noqa: N802
    prefix, uri, localname = graph.compute_qname(classOrIdentifier(uri))
    return ":".join([prefix, localname])


def classOrTerm(thing):  # noqa: N802
    if isinstance(thing, Class):
        return thing.identifier
    else:
        assert isinstance(thing, (URIRef, BNode, Literal))
        return thing


def classOrIdentifier(thing):  # noqa: N802
    if isinstance(thing, (Property, Class)):
        return thing.identifier
    else:
        assert isinstance(thing, (URIRef, BNode)), (
            "Expecting a Class, Property, URIRef, or BNode.. not a %s" % thing
        )
        return thing


def propertyOrIdentifier(thing):  # noqa: N802
    if isinstance(thing, Property):
        return thing.identifier
    else:
        assert isinstance(thing, URIRef)
        return thing


def manchesterSyntax(  # noqa: N802
    thing, store, boolean=None, transientList=False  # noqa: N803
):
    """
    Core serialization
    thing is a Class and is processed as a subject
    store is an RDFLib Graph to be queried about thing
    """
    assert thing is not None
    if boolean:
        if transientList:
            livechildren = iter(thing)
            children = [manchesterSyntax(child, store) for child in thing]
        else:
            livechildren = iter(Collection(store, thing))
            children = [
                manchesterSyntax(child, store) for child in Collection(store, thing)
            ]
        if boolean == OWL.intersectionOf:
            childlist = []
            named = []
            for child in livechildren:
                if isinstance(child, URIRef):
                    named.append(child)
                else:
                    childlist.append(child)
            if named:

                def castToQName(x):  # noqa: N802
                    prefix, uri, localname = store.compute_qname(x)
                    return ":".join([prefix, localname])

                if len(named) > 1:
                    prefix = "( " + " AND ".join(map(castToQName, named)) + " )"
                else:
                    prefix = manchesterSyntax(named[0], store)
                if childlist:
                    return (
                        str(prefix)
                        + " THAT "
                        + " AND ".join(
                            [str(manchesterSyntax(x, store)) for x in childlist]
                        )
                    )
                else:
                    return prefix
            else:
                return "( " + " AND ".join([str(c) for c in children]) + " )"
        elif boolean == OWL.unionOf:
            return "( " + " OR ".join([str(c) for c in children]) + " )"
        elif boolean == OWL.oneOf:
            return "{ " + " ".join([str(c) for c in children]) + " }"
        else:
            assert boolean == OWL.complementOf
    elif OWL.Restriction in store.objects(subject=thing, predicate=RDF.type):
        prop = list(store.objects(subject=thing, predicate=OWL.onProperty))[0]
        prefix, uri, localname = store.compute_qname(prop)
        propstring = ":".join([prefix, localname])
        label = first(store.objects(subject=prop, predicate=RDFS.label))
        if label:
            propstring = "'%s'" % label
        for onlyclass in store.objects(subject=thing, predicate=OWL.allValuesFrom):
            return "( %s ONLY %s )" % (propstring, manchesterSyntax(onlyclass, store))
        for val in store.objects(subject=thing, predicate=OWL.hasValue):
            return "( %s VALUE %s )" % (propstring, manchesterSyntax(val, store))
        for someclass in store.objects(subject=thing, predicate=OWL.someValuesFrom):
            return "( %s SOME %s )" % (propstring, manchesterSyntax(someclass, store))
        cardlookup = {
            OWL.maxCardinality: "MAX",
            OWL.minCardinality: "MIN",
            OWL.cardinality: "EQUALS",
        }
        for _s, p, o in store.triples_choices((thing, list(cardlookup.keys()), None)):
            return "( %s %s %s )" % (propstring, cardlookup[p], o)
    # is thing a complement of anything
    compl = list(store.objects(subject=thing, predicate=OWL.complementOf))
    if compl:
        return "( NOT %s )" % (manchesterSyntax(compl[0], store))
    else:
        prolog = "\n".join(["PREFIX %s: <%s>" % (k, nsBinds[k]) for k in nsBinds])
        qstr = (
            prolog
            + "\nSELECT ?p ?bool WHERE {?class a owl:Class; ?p ?bool ."
            + "?bool rdf:first ?foo }"
        )
        initb = {Variable("?class"): thing}
        for boolprop, col in store.query(qstr, processor="sparql", initBindings=initb):
            if not isinstance(thing, URIRef):
                return manchesterSyntax(col, store, boolean=boolprop)
        try:
            prefix, uri, localname = store.compute_qname(thing)
            qname = ":".join([prefix, localname])
        except Exception:
            if isinstance(thing, BNode):
                return thing.n3()
            # Expect the unexpected
            return thing.identifier if not isinstance(thing, str) else thing
        label = first(Class(thing, graph=store).label)
        if label:
            return label
        else:
            return qname


def GetIdentifiedClasses(graph):  # noqa: N802
    for c in graph.subjects(predicate=RDF.type, object=OWL.Class):
        if isinstance(c, URIRef):
            yield Class(c)


class TermDeletionHelper:
    def __init__(self, prop):
        self.prop = prop

    def __call__(self, f):
        def _remover(inst):
            inst.graph.remove((inst.identifier, self.prop, None))

        return _remover


class Individual:
    """
    A typed individual, the base class of the InfixOWL classes.
    """

    factoryGraph = Graph()  # noqa: N815

    def serialize(self, graph):
        for fact in self.factoryGraph.triples((self.identifier, None, None)):
            graph.add(fact)

    def __init__(self, identifier=None, graph=None):
        self.__identifier = identifier is not None and identifier or BNode()
        if graph is None:
            self.graph = self.factoryGraph
        else:
            self.graph = graph
        self.qname = None
        if not isinstance(self.identifier, BNode):
            try:
                prefix, uri, localname = self.graph.compute_qname(self.identifier)
                self.qname = ":".join([prefix, localname])
            except Exception:  # pragma: no cover
                pass  # pragma: no cover

    def clearInDegree(self):  # noqa: N802
        """
        Remove references to this individual as an object in the
        backing store.
        """
        self.graph.remove((None, None, self.identifier))

    def clearOutDegree(self):  # noqa: N802
        """
        Remove all statements to this individual as a subject in the
        backing store. Note that this only removes the statements
        themselves, not the blank node closure so there is a chance
        that this will cause orphaned blank nodes to remain in the
        graph.
        """
        self.graph.remove((self.identifier, None, None))

    def delete(self):
        """
        Delete the individual from the graph, clearing the in and
        out degrees.
        """
        self.clearInDegree()
        self.clearOutDegree()

    def replace(self, other):
        """
        Replace the individual in the graph with the given other,
        causing all triples that refer to it to be changed and then
        delete the individual.

        ```python
        >>> g = Graph()
        >>> b = Individual(OWL.Restriction, g)
        >>> b.type = RDFS.Resource
        >>> len(list(b.type))
        1
        >>> del b.type
        >>> len(list(b.type))
        0

        ```
        """
        for s, p, _o in self.graph.triples((None, None, self.identifier)):
            self.graph.add((s, p, classOrIdentifier(other)))
        self.delete()

    def _get_type(self) -> Iterable[_ObjectType]:
        for _t in self.graph.objects(subject=self.identifier, predicate=RDF.type):
            yield _t

    def _set_type(self, kind: Union[Individual, Identifier, Iterable[_ObjectType]]):
        if not kind:
            return
        if isinstance(kind, (Individual, Identifier)):
            self.graph.add((self.identifier, RDF.type, classOrIdentifier(kind)))
        else:
            for c in kind:
                assert isinstance(c, (Individual, Identifier))
                self.graph.add((self.identifier, RDF.type, classOrIdentifier(c)))

    @TermDeletionHelper(RDF.type)
    def _delete_type(self):
        """
        ```python
        >>> g = Graph()
        >>> b = Individual(OWL.Restriction, g)
        >>> b.type = RDFS.Resource
        >>> len(list(b.type))
        1
        >>> del b.type
        >>> len(list(b.type))
        0

        ```
        """
        pass  # pragma: no cover

    type = property(_get_type, _set_type, _delete_type)

    def _get_identifier(self) -> Identifier:
        return self.__identifier

    def _set_identifier(self, i: Identifier):
        assert i
        if i != self.__identifier:
            oldstatements_out = [
                (p, o)
                for s, p, o in self.graph.triples((self.__identifier, None, None))
            ]
            oldstatements_in = [
                (s, p)
                for s, p, o in self.graph.triples((None, None, self.__identifier))
            ]
            for p1, o1 in oldstatements_out:
                self.graph.remove((self.__identifier, p1, o1))
            for s1, p1 in oldstatements_in:
                self.graph.remove((s1, p1, self.__identifier))
            self.__identifier = i
            self.graph.addN([(i, p1, o1, self.graph) for p1, o1 in oldstatements_out])
            self.graph.addN([(s1, p1, i, self.graph) for s1, p1 in oldstatements_in])
        if not isinstance(i, BNode):
            try:
                prefix, uri, localname = self.graph.compute_qname(i)
                self.qname = ":".join([prefix, localname])
            except Exception:  # pragma: no cover
                pass  # pragma: no cover

    identifier = property(_get_identifier, _set_identifier)

    def _get_sameAs(self) -> Iterable[_ObjectType]:  # noqa: N802
        for _t in self.graph.objects(subject=self.identifier, predicate=OWL.sameAs):
            yield _t

    def _set_sameAs(  # noqa: N802
        self, term: Union[Individual, Identifier, Iterable[_ObjectType]]
    ):
        # if not kind:
        #     return
        if isinstance(term, (Individual, Identifier)):
            self.graph.add((self.identifier, OWL.sameAs, classOrIdentifier(term)))
        else:
            for c in term:
                assert isinstance(c, (Individual, Identifier))
                self.graph.add((self.identifier, OWL.sameAs, classOrIdentifier(c)))

    @TermDeletionHelper(OWL.sameAs)
    def _delete_sameAs(self):  # noqa: N802
        pass  # pragma: no cover

    sameAs = property(_get_sameAs, _set_sameAs, _delete_sameAs)  # noqa: N815


ACE_NS = Namespace("http://attempto.ifi.uzh.ch/ace_lexicon#")


class AnnotatableTerms(Individual):
    """Terms in an OWL ontology with rdfs:label and rdfs:comment

    Interface with ATTEMPTO (http://attempto.ifi.uzh.ch/site)

    ## Verbalisation of OWL entity IRIS

    ### How are OWL entity IRIs verbalized?

    The OWL verbalizer maps OWL entity IRIs to ACE content words such
    that

    - OWL individuals map to ACE proper names (PN)
    - OWL classes map to ACE common nouns (CN)
    - OWL properties map to ACE transitive verbs (TV)

    There are 6 morphological categories that determine the surface form
    of an IRI:

    - singular form of a proper name (e.g. John)
    - singular form of a common noun (e.g. man)
    - plural form of a common noun (e.g. men)
    - singular form of a transitive verb (e.g. mans)
    - plural form of a transitive verb (e.g. man)
    - past participle form a transitive verb (e.g. manned)

    The user has full control over the eventual surface forms of the IRIs
    but has to choose them in terms of the above categories.
    Furthermore,

    - the surface forms must be legal ACE content words (e.g. they
      should not contain punctuation symbols);
    - the mapping of IRIs to surface forms must be bidirectional
      within the same word class, in order to be able to (if needed)
      parse the verbalization back into OWL in a semantics preserving
      way.

    ### Using the lexicon

    It is possible to specify the mapping of IRIs to surface forms using
    the following annotation properties:

    ```
    http://attempto.ifi.uzh.ch/ace_lexicon#PN_sg
    http://attempto.ifi.uzh.ch/ace_lexicon#CN_sg
    http://attempto.ifi.uzh.ch/ace_lexicon#CN_pl
    http://attempto.ifi.uzh.ch/ace_lexicon#TV_sg
    http://attempto.ifi.uzh.ch/ace_lexicon#TV_pl
    http://attempto.ifi.uzh.ch/ace_lexicon#TV_vbg
    ```

    For example, the following axioms state that if the IRI "#man" is used
    as a plural common noun, then the wordform men must be used by the
    verbalizer. If, however, it is used as a singular transitive verb,
    then mans must be used.

    ```xml
    <AnnotationAssertion>
        <AnnotationProperty IRI="http://attempto.ifi.uzh.ch/ace_lexicon#CN_pl"/>
        <IRI>#man</IRI>
        <Literal datatypeIRI="&xsd;string">men</Literal>
    </AnnotationAssertion>

    <AnnotationAssertion>
        <AnnotationProperty IRI="http://attempto.ifi.uzh.ch/ace_lexicon#TV_sg"/>
        <IRI>#man</IRI>
        <Literal datatypeIRI="&xsd;string">mans</Literal>
    </AnnotationAssertion>
    ```
    """

    def __init__(
        self,
        identifier,
        graph=None,
        nameAnnotation=None,  # noqa: N803
        nameIsLabel=False,  # noqa: N803
    ):
        super(AnnotatableTerms, self).__init__(identifier, graph)
        if nameAnnotation:
            self.setupACEAnnotations()
            self.PN_sgprop.extent = [
                (self.identifier, self.handleAnnotation(nameAnnotation))
            ]
            if nameIsLabel:
                self.label = [nameAnnotation]

    def handleAnnotation(self, val):  # noqa: N802
        return val if isinstance(val, Literal) else Literal(val)

    def setupACEAnnotations(self):  # noqa: N802
        self.graph.bind("ace", ACE_NS, override=False)

        # PN_sg singular form of a proper name ()
        self.PN_sgprop = Property(
            ACE_NS.PN_sg, baseType=OWL.AnnotationProperty, graph=self.graph
        )

        # CN_sg singular form of a common noun
        self.CN_sgprop = Property(
            ACE_NS.CN_sg, baseType=OWL.AnnotationProperty, graph=self.graph
        )

        # CN_pl plural form of a common noun
        self.CN_plprop = Property(
            ACE_NS.CN_pl, baseType=OWL.AnnotationProperty, graph=self.graph
        )

        # singular form of a transitive verb
        self.tv_sgprop = Property(
            ACE_NS.TV_sg, baseType=OWL.AnnotationProperty, graph=self.graph
        )

        # plural form of a transitive verb
        self.tv_plprop = Property(
            ACE_NS.TV_pl, baseType=OWL.AnnotationProperty, graph=self.graph
        )

        # past participle form a transitive verb
        self.tv_vbgprop = Property(
            ACE_NS.TV_vbg, baseType=OWL.AnnotationProperty, graph=self.graph
        )

    def _get_comment(self):
        for comment in self.graph.objects(
            subject=self.identifier, predicate=RDFS.comment
        ):
            yield comment

    def _set_comment(self, comment):
        if not comment:
            return
        if isinstance(comment, Identifier):
            self.graph.add((self.identifier, RDFS.comment, comment))
        else:
            for c in comment:
                self.graph.add((self.identifier, RDFS.comment, c))

    @TermDeletionHelper(RDFS.comment)
    def _del_comment(self):
        pass  # pragma: no cover

    comment = property(_get_comment, _set_comment, _del_comment)

    def _get_seealso(self):
        for seealso in self.graph.objects(
            subject=self.identifier, predicate=RDFS.seeAlso
        ):
            yield seealso

    def _set_seealso(self, seealsos):
        if not seealsos:
            return
        for s in seealsos:
            self.graph.add((self.identifier, RDFS.seeAlso, s))

    @TermDeletionHelper(RDFS.seeAlso)
    def _del_seealso(self):
        pass  # pragma: no cover

    seeAlso = property(_get_seealso, _set_seealso, _del_seealso)  # noqa: N815

    def _get_label(self):
        for label in self.graph.objects(subject=self.identifier, predicate=RDFS.label):
            yield label

    def _set_label(self, label):
        if not label:
            return
        if isinstance(label, Identifier):
            self.graph.add((self.identifier, RDFS.label, label))
        else:
            for l_ in label:
                self.graph.add((self.identifier, RDFS.label, l_))

    @TermDeletionHelper(RDFS.label)
    def _delete_label(self):
        """
        ```python
        >>> g = Graph()
        >>> b = Individual(OWL.Restriction,g)
        >>> b.label = Literal('boo')
        >>> len(list(b.label))
        1
        >>> del b.label
        >>> len(list(b.label))
        0

        ```
        """
        pass  # pragma: no cover

    label = property(_get_label, _set_label, _delete_label)


class Ontology(AnnotatableTerms):
    """The owl ontology metadata"""

    def __init__(self, identifier=None, imports=None, comment=None, graph=None):
        super(Ontology, self).__init__(identifier, graph)
        self.imports = [] if imports is None else imports
        self.comment = [] if comment is None else comment
        if (self.identifier, RDF.type, OWL.Ontology) not in self.graph:
            self.graph.add((self.identifier, RDF.type, OWL.Ontology))

    def setVersion(self, version):  # noqa: N802
        self.graph.set((self.identifier, OWL.versionInfo, version))

    def _get_imports(self):
        for owl in self.graph.objects(
            subject=self.identifier, predicate=OWL["imports"]
        ):
            yield owl

    def _set_imports(self, other):
        if not other:
            return
        for o in other:
            self.graph.add((self.identifier, OWL["imports"], o))

    @TermDeletionHelper(OWL["imports"])
    def _del_imports(self):
        pass  # pragma: no cover

    imports = property(_get_imports, _set_imports, _del_imports)


def AllClasses(graph):  # noqa: N802
    for c in set(graph.subjects(predicate=RDF.type, object=OWL.Class)):
        yield Class(c)


def AllProperties(graph):  # noqa: N802
    prevprops = set()
    for s, _p, o in graph.triples_choices(
        (
            None,
            RDF.type,
            [
                OWL.SymmetricProperty,
                OWL.FunctionalProperty,
                OWL.InverseFunctionalProperty,
                OWL.TransitiveProperty,
                OWL.DatatypeProperty,
                OWL.ObjectProperty,
                OWL.AnnotationProperty,
            ],
        )
    ):
        if o in [
            OWL.SymmetricProperty,
            OWL.InverseFunctionalProperty,
            OWL.TransitiveProperty,
            OWL.ObjectProperty,
        ]:
            bType = OWL.ObjectProperty  # noqa: N806
        else:
            bType = OWL.DatatypeProperty  # noqa: N806
        if s not in prevprops:
            prevprops.add(s)
            yield Property(s, graph=graph, baseType=bType)


class ClassNamespaceFactory(Namespace):
    def term(self, name):
        return Class(URIRef(self + name))

    def __getitem__(self, key, default=None):
        return self.term(key)

    def __getattr__(self, name):
        if name.startswith("__"):  # ignore any special Python names!
            raise AttributeError
        else:
            return self.term(name)


CLASS_RELATIONS = set(
    Namespace("http://www.w3.org/2002/07/owl#resourceProperties")
).difference(
    [
        OWL.onProperty,
        OWL.allValuesFrom,
        OWL.hasValue,
        OWL.someValuesFrom,
        OWL.inverseOf,
        OWL.imports,
        OWL.versionInfo,
        OWL.backwardCompatibleWith,
        OWL.incompatibleWith,
        OWL.unionOf,
        OWL.intersectionOf,
        OWL.oneOf,
    ]
)


def ComponentTerms(cls):  # noqa: N802
    """
    Takes a Class instance and returns a generator over the classes that
    are involved in its definition, ignoring unnamed classes
    """
    if OWL.Restriction in cls.type:
        try:
            cls = CastClass(cls, Individual.factoryGraph)
            for _s, _p, inner_class_id in cls.factoryGraph.triples_choices(
                (cls.identifier, [OWL.allValuesFrom, OWL.someValuesFrom], None)
            ):
                inner_class = Class(inner_class_id, skipOWLClassMembership=True)
                if isinstance(inner_class_id, BNode):
                    for _c in ComponentTerms(inner_class):
                        yield _c
                else:
                    yield inner_class
        except Exception:  # pragma: no cover
            pass  # pragma: no cover
    else:
        cls = CastClass(cls, Individual.factoryGraph)
        if isinstance(cls, BooleanClass):
            for _cls in cls:
                _cls = Class(_cls, skipOWLClassMembership=True)
                if isinstance(_cls.identifier, BNode):
                    for _c in ComponentTerms(_cls):
                        yield _c
                else:
                    yield _cls
        else:
            for inner_class in cls.subClassOf:
                if isinstance(inner_class.identifier, BNode):
                    for _c in ComponentTerms(inner_class):
                        yield _c
                else:
                    yield inner_class
            for _s, _p, o in cls.factoryGraph.triples_choices(
                (classOrIdentifier(cls), CLASS_RELATIONS, None)
            ):
                if isinstance(o, BNode):
                    for _c in ComponentTerms(CastClass(o, Individual.factoryGraph)):
                        yield _c
                else:
                    yield inner_class


def DeepClassClear(class_to_prune):  # noqa: N802
    """
    Recursively clear the given class, continuing
    where any related class is an anonymous class

    ```python
    >>> EX = Namespace("http://example.com/")
    >>> g = Graph()
    >>> g.bind("ex", EX, override=False)
    >>> Individual.factoryGraph = g
    >>> classB = Class(EX.B)
    >>> classC = Class(EX.C)
    >>> classD = Class(EX.D)
    >>> classE = Class(EX.E)
    >>> classF = Class(EX.F)
    >>> anonClass = EX.someProp @ some @ classD
    >>> classF += anonClass
    >>> list(anonClass.subClassOf)
    [Class: ex:F ]
    >>> classA = classE | classF | anonClass
    >>> classB += classA
    >>> classA.equivalentClass = [Class()]
    >>> classB.subClassOf = [EX.someProp @ some @ classC]
    >>> classA
    ( ex:E OR ex:F OR ( ex:someProp SOME ex:D ) )
    >>> DeepClassClear(classA)
    >>> classA
    (  )
    >>> list(anonClass.subClassOf)
    []
    >>> classB
    Class: ex:B SubClassOf: ( ex:someProp SOME ex:C )

    >>> otherClass = classD | anonClass
    >>> otherClass
    ( ex:D OR ( ex:someProp SOME ex:D ) )
    >>> DeepClassClear(otherClass)
    >>> otherClass
    (  )
    >>> otherClass.delete()
    >>> list(g.triples((otherClass.identifier, None, None)))
    []

    ```
    """

    def deepClearIfBNode(_class):  # noqa: N802
        if isinstance(classOrIdentifier(_class), BNode):
            DeepClassClear(_class)

    class_to_prune = CastClass(class_to_prune, Individual.factoryGraph)
    for c in class_to_prune.subClassOf:
        deepClearIfBNode(c)
    class_to_prune.graph.remove((class_to_prune.identifier, RDFS.subClassOf, None))
    for c in class_to_prune.equivalentClass:
        deepClearIfBNode(c)
    class_to_prune.graph.remove((class_to_prune.identifier, OWL.equivalentClass, None))
    inverse_class = class_to_prune.complementOf
    if inverse_class:
        class_to_prune.graph.remove((class_to_prune.identifier, OWL.complementOf, None))
        deepClearIfBNode(inverse_class)
    if isinstance(class_to_prune, BooleanClass):
        for c in class_to_prune:
            deepClearIfBNode(c)
        class_to_prune.clear()
        class_to_prune.graph.remove(
            (class_to_prune.identifier, class_to_prune._operator, None)
        )


class MalformedClass(ValueError):  # noqa: N818
    """
    !!! warning "Deprecated"
        This class will be removed in version `7.0.0`.
    """

    pass


class MalformedClassError(MalformedClass):
    def __init__(self, msg):
        self.msg = msg

    def __repr__(self):
        return self.msg


def CastClass(c, graph=None):  # noqa: N802
    graph = graph is None and c.factoryGraph or graph
    for kind in graph.objects(subject=classOrIdentifier(c), predicate=RDF.type):
        if kind == OWL.Restriction:
            kwargs = {"identifier": classOrIdentifier(c), "graph": graph}
            for _s, p, o in graph.triples((classOrIdentifier(c), None, None)):
                if p != RDF.type:
                    if p == OWL.onProperty:
                        kwargs["onProperty"] = o
                    else:
                        if p not in Restriction.restrictionKinds:
                            continue
                        kwargs[str(p.split(str(OWL))[-1])] = o
            if not set(
                [str(i.split(str(OWL))[-1]) for i in Restriction.restrictionKinds]
            ).intersection(kwargs):
                raise MalformedClassError("Malformed owl:Restriction")
            return Restriction(**kwargs)
        else:
            for _s, p, _o in graph.triples_choices(
                (
                    classOrIdentifier(c),
                    [OWL.intersectionOf, OWL.unionOf, OWL.oneOf],
                    None,
                )
            ):
                if p == OWL.oneOf:
                    return EnumeratedClass(classOrIdentifier(c), graph=graph)
                else:
                    return BooleanClass(classOrIdentifier(c), operator=p, graph=graph)
            # assert (classOrIdentifier(c),RDF.type,OWL.Class) in graph
            return Class(classOrIdentifier(c), graph=graph, skipOWLClassMembership=True)


class Class(AnnotatableTerms):
    """'General form' for classes:

    The Manchester Syntax (supported in Protege) is used as the basis for the
    form of this class

    See: http://owl-workshop.man.ac.uk/acceptedLong/submission_9.pdf:

    ```
    [Annotation]
    ‘Class:’ classID {Annotation
    ( (‘SubClassOf:’ ClassExpression)
    | (‘EquivalentTo’ ClassExpression)
    | (’DisjointWith’ ClassExpression)) }
    ```

    Appropriate excerpts from OWL Reference:

    ".. Subclass axioms provide us with partial definitions: they represent
     necessary but not sufficient conditions for establishing class
     membership of an individual."

    ".. A class axiom may contain (multiple) owl:equivalentClass statements"

    "..A class axiom may also contain (multiple) owl:disjointWith statements.."

    "..An owl:complementOf property links a class to precisely one class
      description."
    """

    def _serialize(self, graph):
        for cl in self.subClassOf:
            CastClass(cl, self.graph).serialize(graph)
        for cl in self.equivalentClass:
            CastClass(cl, self.graph).serialize(graph)
        for cl in self.disjointWith:
            CastClass(cl, self.graph).serialize(graph)
        if self.complementOf:
            CastClass(self.complementOf, self.graph).serialize(graph)

    def serialize(self, graph):
        for fact in self.graph.triples((self.identifier, None, None)):
            graph.add(fact)
        self._serialize(graph)

    def setupNounAnnotations(self, noun_annotations):  # noqa: N802
        if isinstance(noun_annotations, tuple):
            cn_sgprop, cn_plprop = noun_annotations
        else:
            cn_sgprop = noun_annotations
            cn_plprop = noun_annotations

        if cn_sgprop:
            self.CN_sgprop.extent = [
                (self.identifier, self.handleAnnotation(cn_sgprop))
            ]
        if cn_plprop:
            self.CN_plprop.extent = [
                (self.identifier, self.handleAnnotation(cn_plprop))
            ]

    def __init__(
        self,
        identifier=None,
        subClassOf=None,  # noqa: N803
        equivalentClass=None,  # noqa: N803
        disjointWith=None,  # noqa: N803
        complementOf=None,  # noqa: N803
        graph=None,
        skipOWLClassMembership=False,  # noqa: N803
        comment=None,
        nounAnnotations=None,  # noqa: N803
        nameAnnotation=None,  # noqa: N803
        nameIsLabel=False,  # noqa: N803
    ):
        super(Class, self).__init__(identifier, graph, nameAnnotation, nameIsLabel)

        if nounAnnotations:
            self.setupNounAnnotations(nounAnnotations)
        if (
            not skipOWLClassMembership
            and (self.identifier, RDF.type, OWL.Class) not in self.graph
            and (self.identifier, RDF.type, OWL.Restriction) not in self.graph
        ):
            self.graph.add((self.identifier, RDF.type, OWL.Class))

        self.subClassOf = [] if subClassOf is None else subClassOf
        self.equivalentClass = [] if equivalentClass is None else equivalentClass
        self.disjointWith = [] if disjointWith is None else disjointWith
        if complementOf:
            self.complementOf = complementOf
        self.comment = [] if comment is None else comment

    def _get_extent(self, graph=None):
        for member in (graph is None and self.graph or graph).subjects(
            predicate=RDF.type, object=self.identifier
        ):
            yield member

    def _set_extent(self, other):
        if not other:
            return
        for m in other:
            self.graph.add((classOrIdentifier(m), RDF.type, self.identifier))

    @TermDeletionHelper(RDF.type)
    def _del_type(self):
        pass  # pragma: no cover

    extent = property(_get_extent, _set_extent, _del_type)

    def _get_annotation(self, term=RDFS.label):
        for annotation in self.graph.objects(subject=self.identifier, predicate=term):
            yield annotation

    annotation = property(_get_annotation, lambda x: x)  # type: ignore[arg-type,misc]

    def _get_extentquery(self):
        return (Variable("CLASS"), RDF.type, self.identifier)

    def _set_extentquery(self, other):
        pass  # pragma: no cover

    extentQuery = property(_get_extentquery, _set_extentquery)  # noqa: N815

    def __hash__(self):
        """
        >>> b = Class(OWL.Restriction)
        >>> c = Class(OWL.Restriction)
        >>> len(set([b,c]))
        1
        """
        return hash(self.identifier)

    def __eq__(self, other):
        assert isinstance(other, Class), repr(other)
        return self.identifier == other.identifier

    def __iadd__(self, other):
        assert isinstance(other, Class)
        other.subClassOf = [self]
        return self

    def __isub__(self, other):
        assert isinstance(other, Class)
        self.graph.remove((classOrIdentifier(other), RDFS.subClassOf, self.identifier))
        return self

    def __invert__(self):
        """
        Shorthand for Manchester syntax's not operator
        """
        return Class(complementOf=self)

    def __or__(self, other):
        """
        Construct an anonymous class description consisting of the union of
        this class and 'other' and return it
        """
        return BooleanClass(
            operator=OWL.unionOf, members=[self, other], graph=self.graph
        )

    def __and__(self, other):
        """
        Construct an anonymous class description consisting of the
        intersection of this class and 'other' and return it

        Chaining 3 intersections

        ```python
        >>> exNs = Namespace("http://example.com/")
        >>> g = Graph()
        >>> g.bind("ex", exNs, override=False)
        >>> female = Class(exNs.Female, graph=g)
        >>> human = Class(exNs.Human, graph=g)
        >>> youngPerson = Class(exNs.YoungPerson, graph=g)
        >>> youngWoman = female & human & youngPerson
        >>> youngWoman  # doctest: +SKIP
        ex:YoungPerson THAT ( ex:Female AND ex:Human )
        >>> isinstance(youngWoman, BooleanClass)
        True
        >>> isinstance(youngWoman.identifier, BNode)
        True

        ```
        """
        return BooleanClass(
            operator=OWL.intersectionOf, members=[self, other], graph=self.graph
        )

    def _get_subclassof(self):
        for anc in self.graph.objects(
            subject=self.identifier, predicate=RDFS.subClassOf
        ):
            yield Class(anc, graph=self.graph, skipOWLClassMembership=True)

    def _set_subclassof(self, other):
        if not other:
            return
        for sc in other:
            self.graph.add((self.identifier, RDFS.subClassOf, classOrIdentifier(sc)))

    @TermDeletionHelper(RDFS.subClassOf)
    def _del_subclassof(self):
        pass  # pragma: no cover

    subClassOf = property(  # noqa: N815
        _get_subclassof, _set_subclassof, _del_subclassof
    )

    def _get_equivalentclass(self):
        for ec in self.graph.objects(
            subject=self.identifier, predicate=OWL.equivalentClass
        ):
            yield Class(ec, graph=self.graph)

    def _set_equivalentclass(self, other):
        if not other:
            return
        for sc in other:
            self.graph.add(
                (self.identifier, OWL.equivalentClass, classOrIdentifier(sc))
            )

    @TermDeletionHelper(OWL.equivalentClass)
    def _del_equivalentclass(self):
        pass  # pragma: no cover

    equivalentClass = property(  # noqa: N815
        _get_equivalentclass, _set_equivalentclass, _del_equivalentclass
    )

    def _get_disjointwith(self):
        for dc in self.graph.objects(
            subject=self.identifier, predicate=OWL.disjointWith
        ):
            yield Class(dc, graph=self.graph)

    def _set_disjointwith(self, other):
        if not other:
            return
        for c in other:
            self.graph.add((self.identifier, OWL.disjointWith, classOrIdentifier(c)))

    @TermDeletionHelper(OWL.disjointWith)
    def _del_disjointwith(self):
        pass  # pragma: no cover

    disjointWith = property(  # noqa: N815
        _get_disjointwith, _set_disjointwith, _del_disjointwith
    )

    def _get_complementof(self):
        comp = list(
            self.graph.objects(subject=self.identifier, predicate=OWL.complementOf)
        )
        if not comp:
            return None
        elif len(comp) == 1:
            return Class(comp[0], graph=self.graph)
        else:
            raise Exception(len(comp))

    def _set_complementof(self, other):
        if not other:
            return
        self.graph.add((self.identifier, OWL.complementOf, classOrIdentifier(other)))

    @TermDeletionHelper(OWL.complementOf)
    def _del_complementof(self):
        pass  # pragma: no cover

    complementOf = property(  # noqa: N815
        _get_complementof, _set_complementof, _del_complementof
    )

    def _get_parents(self):
        """
        computed attributes that returns a generator over taxonomic 'parents'
        by disjunction, conjunction, and subsumption

        ```python
        >>> from rdflib.util import first
        >>> exNs = Namespace('http://example.com/')
        >>> g = Graph()
        >>> g.bind("ex", exNs, override=False)
        >>> Individual.factoryGraph = g
        >>> brother = Class(exNs.Brother)
        >>> sister = Class(exNs.Sister)
        >>> sibling = brother | sister
        >>> sibling.identifier = exNs.Sibling
        >>> sibling
        ( ex:Brother OR ex:Sister )
        >>> first(brother.parents)
        Class: ex:Sibling EquivalentTo: ( ex:Brother OR ex:Sister )
        >>> parent = Class(exNs.Parent)
        >>> male = Class(exNs.Male)
        >>> father = parent & male
        >>> father.identifier = exNs.Father
        >>> list(father.parents)
        [Class: ex:Parent , Class: ex:Male ]

        ```
        """
        for parent in itertools.chain(self.subClassOf, self.equivalentClass):
            yield parent

        link = first(self.factoryGraph.subjects(RDF.first, self.identifier))
        if link:
            siblingslist = list(self.factoryGraph.transitive_subjects(RDF.rest, link))
            if siblingslist:
                collectionhead = siblingslist[-1]
            else:
                collectionhead = link
            for disjointclass in self.factoryGraph.subjects(
                OWL.unionOf, collectionhead
            ):
                if isinstance(disjointclass, URIRef):
                    yield Class(disjointclass, skipOWLClassMembership=True)
        for rdf_list in self.factoryGraph.objects(self.identifier, OWL.intersectionOf):
            for member in OWLRDFListProxy([rdf_list], graph=self.factoryGraph):
                if isinstance(member, URIRef):
                    yield Class(member, skipOWLClassMembership=True)

    parents = property(_get_parents)

    def isPrimitive(self):  # noqa: N802
        if (self.identifier, RDF.type, OWL.Restriction) in self.graph:
            return False
        # sc = list(self.subClassOf)
        ec = list(self.equivalentClass)
        for _boolclass, p, rdf_list in self.graph.triples_choices(
            # type error: Argument 1 to "triples_choices" of "Graph" has incompatible type "Tuple[Any, List[URIRef], None]"; expected "Union[Tuple[List[Node], Node, Node], Tuple[Node, List[Node], Node], Tuple[Node, Node, List[Node]]]"
            (self.identifier, [OWL.intersectionOf, OWL.unionOf], None)  # type: ignore[arg-type]
        ):
            ec.append(manchesterSyntax(rdf_list, self.graph, boolean=p))
        for _e in ec:
            return False
        if self.complementOf:
            return False
        return True

    def subSumpteeIds(self):  # noqa: N802
        for s in self.graph.subjects(predicate=RDFS.subClassOf, object=self.identifier):
            yield s

    # def __iter__(self):
    #     for s in self.graph.subjects(
    #        predicate=RDFS.subClassOf,object=self.identifier):
    #         yield Class(s,skipOWLClassMembership=True)

    def __repr__(self):
        return self.manchesterClass(full=False, normalization=True)

    def manchesterClass(self, full=False, normalization=True):  # noqa: N802
        """
        Returns the Manchester Syntax equivalent for this class
        """
        exprs = []
        sc = list(self.subClassOf)
        ec = list(self.equivalentClass)
        for _boolclass, p, rdf_list in self.graph.triples_choices(
            # type error: Argument 1 to "triples_choices" of "Graph" has incompatible type "Tuple[Any, List[URIRef], None]"; expected "Union[Tuple[List[Node], Node, Node], Tuple[Node, List[Node], Node], Tuple[Node, Node, List[Node]]]"
            (self.identifier, [OWL.intersectionOf, OWL.unionOf], None)  # type: ignore[arg-type]
        ):
            ec.append(manchesterSyntax(rdf_list, self.graph, boolean=p))
        dc = list(self.disjointWith)
        c = self.complementOf
        if c:
            dc.append(c)
        klasskind = ""
        label = list(self.graph.objects(self.identifier, RDFS.label))
        # type error: Incompatible types in assignment (expression has type "str", variable has type "List[Node]")
        # type error: Unsupported operand types for + ("str" and "Node")
        label = label and "(" + label[0] + ")" or ""  # type: ignore[assignment, operator]
        if sc:
            if full:
                scjoin = "\n                "
            else:
                scjoin = ", "
            nec_statements = [
                isinstance(s, Class)
                and isinstance(self.identifier, BNode)
                and repr(CastClass(s, self.graph))
                or
                # repr(BooleanClass(classOrIdentifier(s),
                #                  operator=None,
                #                  graph=self.graph)) or
                manchesterSyntax(classOrIdentifier(s), self.graph)
                for s in sc
            ]
            if nec_statements:
                klasskind = "Primitive Type %s" % label
            exprs.append(
                "SubClassOf: %s" % scjoin.join([str(n) for n in nec_statements])
            )
            if full:
                exprs[-1] = "\n    " + exprs[-1]
        if ec:
            nec_suff_statements = [
                isinstance(s, str)
                and s
                or manchesterSyntax(classOrIdentifier(s), self.graph)
                for s in ec
            ]
            if nec_suff_statements:
                klasskind = "A Defined Class %s" % label
            exprs.append("EquivalentTo: %s" % ", ".join(nec_suff_statements))
            if full:
                exprs[-1] = "\n    " + exprs[-1]
        if dc:
            exprs.append(
                "DisjointWith %s\n"
                % "\n                 ".join(
                    [manchesterSyntax(classOrIdentifier(s), self.graph) for s in dc]
                )
            )
            if full:
                exprs[-1] = "\n    " + exprs[-1]
        descr = list(self.graph.objects(self.identifier, RDFS.comment))
        if full and normalization:
            klassdescr = (
                klasskind
                and "\n    ## %s ##" % klasskind
                + (descr and "\n    %s" % descr[0] or "")
                + " . ".join(exprs)
                or " . ".join(exprs)
            )
        else:
            klassdescr = (
                full
                and (descr and "\n    %s" % descr[0] or "")
                or "" + " . ".join(exprs)
            )
        return (
            isinstance(self.identifier, BNode)
            and "Some Class "
            or "Class: %s " % self.qname
        ) + klassdescr


class OWLRDFListProxy:
    def __init__(self, rdf_list, members=None, graph=None):
        if graph:
            self.graph = graph
        members = [] if members is None else members
        if rdf_list:
            self._rdfList = Collection(self.graph, rdf_list[0])
            for member in members:
                if member not in self._rdfList:
                    self._rdfList.append(classOrIdentifier(member))
        else:
            self._rdfList = Collection(
                self.graph, BNode(), [classOrIdentifier(m) for m in members]
            )
            # type error: "OWLRDFListProxy" has no attribute "identifier"
            # type error: "OWLRDFListProxy" has no attribute "_operator"
            self.graph.add((self.identifier, self._operator, self._rdfList.uri))  # type: ignore[attr-defined]

    def __eq__(self, other):
        """
        Equivalence of boolean class constructors is determined by
        equivalence of its members
        """
        assert isinstance(other, Class), repr(other) + repr(type(other))
        if isinstance(other, BooleanClass):
            length = len(self)
            if length != len(other):
                return False
            else:
                for idx in range(length):
                    if self[idx] != other[idx]:
                        return False
                    return True
        else:
            # type error: "OWLRDFListProxy" has no attribute "identifier"
            return self.identifier == other.identifier  # type: ignore[attr-defined]

    # Redirect python list accessors to the underlying Collection instance
    def __len__(self):
        return len(self._rdfList)

    def index(self, item):
        return self._rdfList.index(classOrIdentifier(item))

    def __getitem__(self, key):
        return self._rdfList[key]

    def __setitem__(self, key, value):
        self._rdfList[key] = classOrIdentifier(value)

    def __delitem__(self, key):
        del self._rdfList[key]

    def clear(self):
        self._rdfList.clear()

    def __iter__(self):
        for item in self._rdfList:
            yield item

    def __contains__(self, item):
        for i in self._rdfList:
            if i == classOrIdentifier(item):
                return 1
        return 0

    def append(self, item):
        self._rdfList.append(item)

    def __iadd__(self, other):
        self._rdfList.append(classOrIdentifier(other))
        return self


class EnumeratedClass(OWLRDFListProxy, Class):
    """Class for owl:oneOf forms:

    OWL Abstract Syntax is used

    axiom ::= 'EnumeratedClass('
        classID ['Deprecated'] { annotation } { individualID } ')'

    ```python
    >>> exNs = Namespace("http://example.com/")
    >>> g = Graph()
    >>> g.bind("ex", exNs, override=False)
    >>> Individual.factoryGraph = g
    >>> ogbujiBros = EnumeratedClass(exNs.ogbujicBros,
    ...                              members=[exNs.chime,
    ...                                       exNs.uche,
    ...                                       exNs.ejike])
    >>> ogbujiBros  # doctest: +SKIP
    { ex:chime ex:uche ex:ejike }
    >>> col = Collection(g, first(
    ...    g.objects(predicate=OWL.oneOf, subject=ogbujiBros.identifier)))
    >>> sorted([g.qname(item) for item in col])
    ['ex:chime', 'ex:ejike', 'ex:uche']
    >>> print(g.serialize(format='n3'))  # doctest: +SKIP
    @prefix ex: <http://example.com/> .
    @prefix owl: <http://www.w3.org/2002/07/owl#> .
    @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
    <BLANKLINE>
    ex:ogbujicBros a owl:Class;
        owl:oneOf ( ex:chime ex:uche ex:ejike ) .
    <BLANKLINE>
    <BLANKLINE>

    ```
    """

    _operator = OWL.oneOf

    def isPrimitive(self):  # noqa: N802
        return False

    def __init__(self, identifier=None, members=None, graph=None):
        Class.__init__(self, identifier, graph=graph)
        members = [] if members is None else members
        rdfList = list(  # noqa: N806
            self.graph.objects(predicate=OWL.oneOf, subject=self.identifier)
        )
        OWLRDFListProxy.__init__(self, rdfList, members)

    def __repr__(self):
        """
        Returns the Manchester Syntax equivalent for this class
        """
        return manchesterSyntax(self._rdfList.uri, self.graph, boolean=self._operator)

    def serialize(self, graph):
        clonedlist = Collection(graph, BNode())
        for cl in self._rdfList:
            clonedlist.append(cl)
            CastClass(cl, self.graph).serialize(graph)

        graph.add((self.identifier, self._operator, clonedlist.uri))
        for s, p, o in self.graph.triples((self.identifier, None, None)):
            if p != self._operator:
                graph.add((s, p, o))
        self._serialize(graph)


BooleanPredicates = [OWL.intersectionOf, OWL.unionOf]


class BooleanClassExtentHelper:
    """
    ```python
    >>> testGraph = Graph()
    >>> Individual.factoryGraph = testGraph
    >>> EX = Namespace("http://example.com/")
    >>> testGraph.bind("ex", EX, override=False)
    >>> fire = Class(EX.Fire)
    >>> water = Class(EX.Water)
    >>> testClass = BooleanClass(members=[fire, water])
    >>> testClass2 = BooleanClass(
    ...     operator=OWL.unionOf, members=[fire, water])
    >>> for c in BooleanClass.getIntersections():
    ...     print(c)  # doctest: +SKIP
    ( ex:Fire AND ex:Water )
    >>> for c in BooleanClass.getUnions():
    ...     print(c) #doctest: +SKIP
    ( ex:Fire OR ex:Water )

    ```
    """

    def __init__(self, operator):
        self.operator = operator

    def __call__(self, f):
        def _getExtent():  # noqa: N802
            for c in Individual.factoryGraph.subjects(self.operator):
                yield BooleanClass(c, operator=self.operator)

        return _getExtent


class Callable:
    def __init__(self, anycallable):
        self._callfn = anycallable

    def __call__(self, *args, **kwargs):
        return self._callfn(*args, **kwargs)


class BooleanClass(OWLRDFListProxy, Class):
    """
    See: http://www.w3.org/TR/owl-ref/#Boolean

    owl:complementOf is an attribute of Class, however
    """

    @BooleanClassExtentHelper(OWL.intersectionOf)
    @Callable
    def getIntersections():  # type: ignore[misc]  # noqa: N802
        pass  # pragma: no cover

    getIntersections = Callable(getIntersections)  # noqa: N815

    @BooleanClassExtentHelper(OWL.unionOf)
    @Callable
    def getUnions():  # type: ignore[misc]  # noqa: N802
        pass  # pragma: no cover

    getUnions = Callable(getUnions)  # noqa: N815

    def __init__(
        self, identifier=None, operator=OWL.intersectionOf, members=None, graph=None
    ):
        if operator is None:
            props = []
            for _s, p, _o in graph.triples_choices(
                (identifier, [OWL.intersectionOf, OWL.unionOf], None)
            ):
                props.append(p)
                operator = p
            assert len(props) == 1, repr(props)
        Class.__init__(self, identifier, graph=graph)
        assert operator in [OWL.intersectionOf, OWL.unionOf], str(operator)
        self._operator = operator
        rdf_list = list(self.graph.objects(predicate=operator, subject=self.identifier))
        assert (
            not members or not rdf_list
        ), "This is a previous boolean class description."
        OWLRDFListProxy.__init__(self, rdf_list, members)

    def copy(self):
        """
        Create a copy of this class
        """
        copy_of_class = BooleanClass(
            operator=self._operator, members=list(self), graph=self.graph
        )
        return copy_of_class

    def serialize(self, graph):
        clonedlist = Collection(graph, BNode())
        for cl in self._rdfList:
            clonedlist.append(cl)
            CastClass(cl, self.graph).serialize(graph)

        graph.add((self.identifier, self._operator, clonedlist.uri))

        for s, p, o in self.graph.triples((self.identifier, None, None)):
            if p != self._operator:
                graph.add((s, p, o))
        self._serialize(graph)

    def isPrimitive(self):  # noqa: N802
        return False

    def changeOperator(self, newOperator):  # noqa: N802, N803
        """
        Converts a unionOf / intersectionOf class expression into one
        that instead uses the given operator

        ```python
        >>> testGraph = Graph()
        >>> Individual.factoryGraph = testGraph
        >>> EX = Namespace("http://example.com/")
        >>> testGraph.bind("ex", EX, override=False)
        >>> fire = Class(EX.Fire)
        >>> water = Class(EX.Water)
        >>> testClass = BooleanClass(members=[fire,water])
        >>> testClass
        ( ex:Fire AND ex:Water )
        >>> testClass.changeOperator(OWL.unionOf)
        >>> testClass
        ( ex:Fire OR ex:Water )
        >>> try:
        ...     testClass.changeOperator(OWL.unionOf)
        ... except Exception as e:
        ...     print(e)  # doctest: +SKIP
        The new operator is already being used!

        ```
        """
        assert newOperator != self._operator, "The new operator is already being used!"
        self.graph.remove((self.identifier, self._operator, self._rdfList.uri))
        self.graph.add((self.identifier, newOperator, self._rdfList.uri))
        self._operator = newOperator

    def __repr__(self):
        """
        Returns the Manchester Syntax equivalent for this class
        """
        return manchesterSyntax(
            self._rdfList.uri if isinstance(self._rdfList, Collection) else BNode(),
            self.graph,
            boolean=self._operator,
        )

    def __or__(self, other):
        """
        Adds other to the list and returns self
        """
        assert self._operator == OWL.unionOf
        self._rdfList.append(classOrIdentifier(other))
        return self


def AllDifferent(members):  # noqa: N802
    """
    TODO: implement this function

    DisjointClasses(' description description { description } ')'
    """
    pass  # pragma: no cover


class Restriction(Class):
    """
    ```
    restriction ::= 'restriction('
    datavaluedPropertyID dataRestrictionComponent
    { dataRestrictionComponent } ')'
    | 'restriction(' individualvaluedPropertyID
    individualRestrictionComponent
    { individualRestrictionComponent } ')'
    ```
    """

    restrictionKinds = [  # noqa: N815
        OWL.allValuesFrom,
        OWL.someValuesFrom,
        OWL.hasValue,
        OWL.cardinality,
        OWL.maxCardinality,
        OWL.minCardinality,
    ]

    def __init__(
        self,
        onProperty,  # noqa: N803
        graph=None,
        allValuesFrom=None,  # noqa: N803
        someValuesFrom=None,  # noqa: N803
        value=None,
        cardinality=None,
        maxCardinality=None,  # noqa: N803
        minCardinality=None,  # noqa: N803
        identifier=None,
    ):
        graph = Graph() if graph is None else graph
        super(Restriction, self).__init__(
            identifier, graph=graph, skipOWLClassMembership=True
        )
        if (
            self.identifier,
            OWL.onProperty,
            propertyOrIdentifier(onProperty),
        ) not in graph:
            graph.add(
                (self.identifier, OWL.onProperty, propertyOrIdentifier(onProperty))
            )
        self.onProperty = onProperty
        restr_types = [
            (allValuesFrom, OWL.allValuesFrom),
            (someValuesFrom, OWL.someValuesFrom),
            (value, OWL.hasValue),
            (cardinality, OWL.cardinality),
            (maxCardinality, OWL.maxCardinality),
            (minCardinality, OWL.minCardinality),
        ]
        valid_restr_props = [(i, oterm) for (i, oterm) in restr_types if i is not None]
        if not len(valid_restr_props):
            raise ValueError(
                "Missing value. One of: allValuesFrom, someValuesFrom,"
                "value, cardinality, maxCardinality or minCardinality"
                "must have a value."
            )
        restriction_range, restriction_type = valid_restr_props.pop()
        self.restrictionType = restriction_type
        if isinstance(restriction_range, Identifier):
            self.restrictionRange = restriction_range
        elif isinstance(restriction_range, Class):
            self.restrictionRange = classOrIdentifier(restriction_range)
        else:
            # error: Incompatible types in assignment (expression has type "Optional[Identifier]", variable has type "Identifier")
            self.restrictionRange = first(  # type: ignore[assignment]
                # type error: Argument 1 to "first" has incompatible type "Generator[Node, None, None]"; expected "Iterable[Identifier]"
                self.graph.objects(self.identifier, restriction_type)  # type: ignore[arg-type]
            )
        if (
            self.identifier,
            restriction_type,
            self.restrictionRange,
        ) not in self.graph:
            self.graph.add((self.identifier, restriction_type, self.restrictionRange))
        assert self.restrictionRange is not None, Class(self.identifier)
        if (self.identifier, RDF.type, OWL.Restriction) not in self.graph:
            self.graph.add((self.identifier, RDF.type, OWL.Restriction))
            self.graph.remove((self.identifier, RDF.type, OWL.Class))

    def serialize(self, graph):
        """
        ```python
        >>> g1 = Graph()
        >>> g2 = Graph()
        >>> EX = Namespace("http://example.com/")
        >>> g1.bind("ex", EX, override=False)
        >>> g2.bind("ex", EX, override=False)
        >>> Individual.factoryGraph = g1
        >>> prop = Property(EX.someProp, baseType=OWL.DatatypeProperty)
        >>> restr1 = (Property(
        ...    EX.someProp,
        ...    baseType=OWL.DatatypeProperty)) @ some @ (Class(EX.Foo))
        >>> restr1  # doctest: +SKIP
        ( ex:someProp SOME ex:Foo )
        >>> restr1.serialize(g2)
        >>> Individual.factoryGraph = g2
        >>> list(Property(
        ...     EX.someProp,baseType=None).type
        ... ) #doctest: +NORMALIZE_WHITESPACE +SKIP
        [rdflib.term.URIRef(
            'http://www.w3.org/2002/07/owl#DatatypeProperty')]

        ```
        """
        Property(self.onProperty, graph=self.graph, baseType=None).serialize(graph)
        for s, p, o in self.graph.triples((self.identifier, None, None)):
            graph.add((s, p, o))
            if p in [OWL.allValuesFrom, OWL.someValuesFrom]:
                CastClass(o, self.graph).serialize(graph)

    def isPrimitive(self):  # noqa: N802
        return False

    def __hash__(self):
        return hash((self.onProperty, self.restrictionRange))

    def __eq__(self, other):
        """
        Equivalence of restrictions is determined by equivalence of the
        property in question and the restriction 'range'
        """
        assert isinstance(other, Class), repr(other) + repr(type(other))
        if isinstance(other, Restriction):
            return (
                other.onProperty == self.onProperty
                # type error: "Restriction" has no attribute "restriction_range"; maybe "restrictionRange"?
                and other.restriction_range == self.restrictionRange  # type: ignore[attr-defined]
            )
        else:
            return False

    def _get_onproperty(self):
        return list(
            self.graph.objects(subject=self.identifier, predicate=OWL.onProperty)
        )[0]

    def _set_onproperty(self, prop):
        if not prop:
            return
        triple = (self.identifier, OWL.onProperty, propertyOrIdentifier(prop))
        if triple in self.graph:
            return
        else:
            self.graph.set(triple)

    @TermDeletionHelper(OWL.onProperty)
    def _del_onproperty(self):
        pass  # pragma: no cover

    onProperty = property(  # noqa: N815
        _get_onproperty, _set_onproperty, _del_onproperty
    )

    def _get_allvaluesfrom(self):
        for i in self.graph.objects(
            subject=self.identifier, predicate=OWL.allValuesFrom
        ):
            return Class(i, graph=self.graph)
        return None

    def _set_allvaluesfrom(self, other):
        if not other:
            return
        triple = (self.identifier, OWL.allValuesFrom, classOrIdentifier(other))
        if triple in self.graph:
            return
        else:
            self.graph.set(triple)

    @TermDeletionHelper(OWL.allValuesFrom)
    def _del_allvaluesfrom(self):
        pass  # pragma: no cover

    allValuesFrom = property(  # noqa: N815
        _get_allvaluesfrom, _set_allvaluesfrom, _del_allvaluesfrom
    )

    def _get_somevaluesfrom(self):
        for i in self.graph.objects(
            subject=self.identifier, predicate=OWL.someValuesFrom
        ):
            return Class(i, graph=self.graph)
        return None

    def _set_somevaluesfrom(self, other):
        if not other:
            return
        triple = (self.identifier, OWL.someValuesFrom, classOrIdentifier(other))
        if triple in self.graph:
            return
        else:
            self.graph.set(triple)

    @TermDeletionHelper(OWL.someValuesFrom)
    def _del_somevaluesfrom(self):
        pass  # pragma: no cover

    someValuesFrom = property(  # noqa: N815
        _get_somevaluesfrom, _set_somevaluesfrom, _del_somevaluesfrom
    )

    def _get_hasvalue(self):
        for i in self.graph.objects(subject=self.identifier, predicate=OWL.hasValue):
            return Class(i, graph=self.graph)
        return None

    def _set_hasvalue(self, other):
        if not other:
            return
        triple = (self.identifier, OWL.hasValue, classOrIdentifier(other))
        if triple in self.graph:
            return
        else:
            self.graph.set(triple)

    @TermDeletionHelper(OWL.hasValue)
    def _del_hasvalue(self):
        pass  # pragma: no cover

    hasValue = property(_get_hasvalue, _set_hasvalue, _del_hasvalue)  # noqa: N815

    def _get_cardinality(self):
        for i in self.graph.objects(subject=self.identifier, predicate=OWL.cardinality):
            return Class(i, graph=self.graph)
        return None

    def _set_cardinality(self, other):
        if not other:
            return
        triple = (self.identifier, OWL.cardinality, classOrTerm(other))
        if triple in self.graph:
            return
        else:
            self.graph.set(triple)

    @TermDeletionHelper(OWL.cardinality)
    def _del_cardinality(self):
        pass  # pragma: no cover

    cardinality = property(_get_cardinality, _set_cardinality, _del_cardinality)

    def _get_maxcardinality(self):
        for i in self.graph.objects(
            subject=self.identifier, predicate=OWL.maxCardinality
        ):
            return Class(i, graph=self.graph)
        return None

    def _set_maxcardinality(self, other):
        if not other:
            return
        triple = (self.identifier, OWL.maxCardinality, classOrTerm(other))
        if triple in self.graph:
            return
        else:
            self.graph.set(triple)

    @TermDeletionHelper(OWL.maxCardinality)
    def _del_maxcardinality(self):
        pass  # pragma: no cover

    maxCardinality = property(  # noqa: N815
        _get_maxcardinality, _set_maxcardinality, _del_maxcardinality
    )

    def _get_mincardinality(self):
        for i in self.graph.objects(
            subject=self.identifier, predicate=OWL.minCardinality
        ):
            return Class(i, graph=self.graph)
        return None

    def _set_mincardinality(self, other):
        if not other:
            return
        triple = (self.identifier, OWL.minCardinality, classOrIdentifier(other))
        if triple in self.graph:
            return
        else:
            self.graph.set(triple)

    @TermDeletionHelper(OWL.minCardinality)
    def _del_mincardinality(self):
        pass  # pragma: no cover

    minCardinality = property(  # noqa: N815
        _get_mincardinality, _set_mincardinality, _del_mincardinality
    )

    def restrictionKind(self):  # noqa: N802
        for s, p, o in self.graph.triples_choices(
            # type error: Argument 1 to "triples_choices" of "Graph" has incompatible type "Tuple[Any, List[URIRef], None]"; expected "Union[Tuple[List[Node], Node, Node], Tuple[Node, List[Node], Node], Tuple[Node, Node, List[Node]]]"
            (self.identifier, self.restrictionKinds, None)  # type: ignore[arg-type]
        ):
            # type error: "Node" has no attribute "split"
            return p.split(str(OWL))[-1]  # type: ignore[attr-defined]
        return None

    def __repr__(self):
        """
        Returns the Manchester Syntax equivalent for this restriction
        """
        return manchesterSyntax(self.identifier, self.graph)


# Infix Operators #


some = Infix(
    lambda prop, _class: Restriction(prop, graph=_class.graph, someValuesFrom=_class)
)
only = Infix(
    lambda prop, _class: Restriction(prop, graph=_class.graph, allValuesFrom=_class)
)
max = Infix(
    lambda prop, _class: Restriction(prop, graph=prop.graph, maxCardinality=_class)
)
min = Infix(
    lambda prop, _class: Restriction(prop, graph=prop.graph, minCardinality=_class)
)
exactly = Infix(
    lambda prop, _class: Restriction(prop, graph=prop.graph, cardinality=_class)
)
value = Infix(lambda prop, _class: Restriction(prop, graph=prop.graph, value=_class))

# Unused
PropertyAbstractSyntax = """
%s( %s { %s }
%s
{ 'super(' datavaluedPropertyID ')'} ['Functional']
{ domain( %s ) } { range( %s ) } )"""


class Property(AnnotatableTerms):
    """
    ```
    axiom ::= 'DatatypeProperty(' datavaluedPropertyID ['Deprecated']
                { annotation }
                { 'super(' datavaluedPropertyID ')'} ['Functional']
                { 'domain(' description ')' } { 'range(' dataRange ')' } ')'
                | 'ObjectProperty(' individualvaluedPropertyID ['Deprecated']
                { annotation }
                { 'super(' individualvaluedPropertyID ')' }
                [ 'inverseOf(' individualvaluedPropertyID ')' ] [ 'Symmetric' ]
                [ 'Functional' | 'InverseFunctional' |
                'Functional' 'InverseFunctional' |
                'Transitive' ]
                { 'domain(' description ')' } { 'range(' description ')' } ')
    ```
    """

    def setupVerbAnnotations(self, verb_annotations):  # noqa: N802
        """OWL properties map to ACE transitive verbs (TV)

        There are 6 morphological categories that determine the surface form
        of an IRI:

        - singular form of a transitive verb (e.g. mans)
        - plural form of a transitive verb (e.g. man)
        - past participle form a transitive verb (e.g. manned)
        - http://attempto.ifi.uzh.ch/ace_lexicon#TV_sg
        - http://attempto.ifi.uzh.ch/ace_lexicon#TV_pl
        - http://attempto.ifi.uzh.ch/ace_lexicon#TV_vbg
        """

        if isinstance(verb_annotations, tuple):
            tv_sgprop, tv_plprop, tv_vbg = verb_annotations
        else:
            tv_sgprop = verb_annotations
            tv_plprop = verb_annotations
            tv_vbg = verb_annotations
        if tv_sgprop:
            self.tv_sgprop.extent = [
                (self.identifier, self.handleAnnotation(tv_sgprop))
            ]
        if tv_plprop:
            self.tv_plprop.extent = [
                (self.identifier, self.handleAnnotation(tv_plprop))
            ]
        if tv_vbg:
            self.tv_vbgprop.extent = [(self.identifier, self.handleAnnotation(tv_vbg))]

    def __init__(
        self,
        identifier=None,
        graph=None,
        baseType=OWL.ObjectProperty,  # noqa: N803
        subPropertyOf=None,  # noqa: N803
        domain=None,
        range=None,
        inverseOf=None,  # noqa: N803
        otherType=None,  # noqa: N803
        equivalentProperty=None,  # noqa: N803
        comment=None,
        verbAnnotations=None,  # noqa: N803
        nameAnnotation=None,  # noqa: N803
        nameIsLabel=False,  # noqa: N803
    ):
        super(Property, self).__init__(identifier, graph, nameAnnotation, nameIsLabel)
        if verbAnnotations:
            self.setupVerbAnnotations(verbAnnotations)

        assert not isinstance(self.identifier, BNode)
        if baseType is None:
            # None give, determine via introspection
            self._baseType = first(Individual(self.identifier, graph=self.graph).type)
        else:
            if (self.identifier, RDF.type, baseType) not in self.graph:
                self.graph.add((self.identifier, RDF.type, baseType))
            self._baseType = baseType
        self.subPropertyOf = subPropertyOf
        self.inverseOf = inverseOf
        self.domain = domain
        self.range = range
        self.comment = [] if comment is None else comment

    def serialize(self, graph):
        for fact in self.graph.triples((self.identifier, None, None)):
            graph.add(fact)
        for p in itertools.chain(self.subPropertyOf, self.inverseOf):
            p.serialize(graph)
        for c in itertools.chain(self.domain, self.range):
            CastClass(c, self.graph).serialize(graph)

    def _get_extent(self, graph=None):
        for triple in (graph is None and self.graph or graph).triples(
            (None, self.identifier, None)
        ):
            yield triple

    def _set_extent(self, other):
        if not other:
            return
        for subj, obj in other:
            self.graph.add((subj, self.identifier, obj))

    extent = property(_get_extent, _set_extent)

    def __repr__(self):
        rt = []
        if OWL.ObjectProperty in self.type:
            rt.append(
                "ObjectProperty( %s annotation(%s)"
                % (self.qname, first(self.comment) and first(self.comment) or "")
            )
            if first(self.inverseOf):
                # type error: Item "None" of "Optional[Any]" has no attribute "inverseOf"
                two_link_inverse = first(first(self.inverseOf).inverseOf)  # type: ignore[union-attr]
                if two_link_inverse and two_link_inverse.identifier == self.identifier:
                    # type error: Item "None" of "Optional[Any]" has no attribute "qname"
                    inverserepr = first(self.inverseOf).qname  # type: ignore[union-attr]
                else:
                    inverserepr = repr(first(self.inverseOf))
                rt.append(
                    "  inverseOf( %s )%s"
                    % (
                        inverserepr,
                        OWL.SymmetricProperty in self.type and " Symmetric" or "",
                    )
                )
            for _s, _p, roletype in self.graph.triples_choices(
                # type error: Argument 1 to "triples_choices" of "Graph" has incompatible type "Tuple[Any, URIRef, List[URIRef]]"; expected "Union[Tuple[List[Node], Node, Node], Tuple[Node, List[Node], Node], Tuple[Node, Node, List[Node]]]"
                (  # type: ignore[arg-type]
                    self.identifier,
                    RDF.type,
                    [
                        OWL.FunctionalProperty,
                        OWL.InverseFunctionalProperty,
                        OWL.TransitiveProperty,
                    ],
                )
            ):
                # type error: "Node" has no attribute "split"
                rt.append(str(roletype.split(str(OWL))[-1]))  # type: ignore[attr-defined]
        else:
            rt.append(
                "DatatypeProperty( %s %s"
                % (self.qname, first(self.comment) and first(self.comment) or "")
            )
            for _s, _p, roletype in self.graph.triples(
                (self.identifier, RDF.type, OWL.FunctionalProperty)
            ):
                rt.append("   Functional")

        def canonicalName(term, g):  # noqa: N802
            normalized_name = classOrIdentifier(term)
            if isinstance(normalized_name, BNode):
                return term
            elif normalized_name.startswith(XSD):
                return str(term)
            elif first(
                g.triples_choices(
                    (normalized_name, [OWL.unionOf, OWL.intersectionOf], None)
                )
            ):
                return repr(term)
            else:
                return str(term.qname)

        rt.append(
            " ".join(
                [
                    "   super( %s )" % canonicalName(super_property, self.graph)
                    for super_property in self.subPropertyOf
                ]
            )
        )
        rt.append(
            " ".join(
                [
                    "   domain( %s )" % canonicalName(domain, self.graph)
                    for domain in self.domain
                ]
            )
        )
        rt.append(
            " ".join(
                [
                    "   range( %s )" % canonicalName(range, self.graph)
                    for range in self.range
                ]
            )
        )
        # type error: Incompatible types in assignment (expression has type "str", variable has type "List[str]")
        rt = "\n".join([expr for expr in rt if expr])  # type: ignore[assignment]
        rt += "\n)"
        return rt

    def _get_subpropertyof(self):
        for anc in self.graph.objects(
            subject=self.identifier, predicate=RDFS.subPropertyOf
        ):
            yield Property(anc, graph=self.graph, baseType=None)

    def _set_subpropertyof(self, other):
        if not other:
            return
        for subproperty in other:
            self.graph.add(
                (self.identifier, RDFS.subPropertyOf, classOrIdentifier(subproperty))
            )

    @TermDeletionHelper(RDFS.subPropertyOf)
    def _del_subpropertyof(self):
        pass  # pragma: no cover

    subPropertyOf = property(  # noqa: N815
        _get_subpropertyof, _set_subpropertyof, _del_subpropertyof
    )

    def _get_inverseof(self):
        for anc in self.graph.objects(subject=self.identifier, predicate=OWL.inverseOf):
            yield Property(anc, graph=self.graph, baseType=None)

    def _set_inverseof(self, other):
        if not other:
            return
        self.graph.add((self.identifier, OWL.inverseOf, classOrIdentifier(other)))

    @TermDeletionHelper(OWL.inverseOf)
    def _del_inverseof(self):
        pass  # pragma: no cover

    inverseOf = property(_get_inverseof, _set_inverseof, _del_inverseof)  # noqa: N815

    def _get_domain(self):
        for dom in self.graph.objects(subject=self.identifier, predicate=RDFS.domain):
            yield Class(dom, graph=self.graph)

    def _set_domain(self, other):
        if not other:
            return
        if isinstance(other, (Individual, Identifier)):
            self.graph.add((self.identifier, RDFS.domain, classOrIdentifier(other)))
        else:
            for dom in other:
                self.graph.add((self.identifier, RDFS.domain, classOrIdentifier(dom)))

    @TermDeletionHelper(RDFS.domain)
    def _del_domain(self):
        pass  # pragma: no cover

    domain = property(_get_domain, _set_domain, _del_domain)

    def _get_range(self):
        for ran in self.graph.objects(subject=self.identifier, predicate=RDFS.range):
            yield Class(ran, graph=self.graph)

    def _set_range(self, ranges):
        if not ranges:
            return
        if isinstance(ranges, (Individual, Identifier)):
            self.graph.add((self.identifier, RDFS.range, classOrIdentifier(ranges)))
        else:
            for range in ranges:
                self.graph.add((self.identifier, RDFS.range, classOrIdentifier(range)))

    @TermDeletionHelper(RDFS.range)
    def _del_range(self):
        pass  # pragma: no cover

    range = property(_get_range, _set_range, _del_range)

    def replace(self, other):
        # extension = []
        for s, _p, o in self.extent:
            self.graph.add((s, propertyOrIdentifier(other), o))
        self.graph.remove((None, self.identifier, None))


def CommonNSBindings(graph, additionalNS=None):  # noqa: N802, N803
    """
    Takes a graph and binds the common namespaces (rdf,rdfs, & owl)
    """
    additional_ns = {} if additionalNS is None else additionalNS
    namespace_manager = NamespaceManager(graph)
    namespace_manager.bind("rdfs", RDFS)
    namespace_manager.bind("rdf", RDF)
    namespace_manager.bind("owl", OWL)
    for prefix, uri in list(additional_ns.items()):
        namespace_manager.bind(prefix, uri, override=False)
    graph.namespace_manager = namespace_manager
