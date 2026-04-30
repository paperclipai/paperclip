"""
A Describer is a stateful utility for creating RDF statements in a
semi-declarative manner. It has methods for creating literal values, rel and
rev resource relations (somewhat resembling RDFa).

The `Describer.rel` and `Describer.rev` methods return a context manager which sets the current
about to the referenced resource for the context scope (for use with the
`with` statement).

Full example in the `to_rdf` method below:

```python
>>> import datetime
>>> from rdflib.graph import Graph
>>> from rdflib.namespace import Namespace, RDFS, FOAF

>>> ORG_URI = "http://example.org/"

>>> CV = Namespace("http://purl.org/captsolo/resume-rdf/0.2/cv#")

>>> class Person:
...     def __init__(self):
...         self.first_name = "Some"
...         self.last_name = "Body"
...         self.username = "some1"
...         self.presentation = "Just a Python & RDF hacker."
...         self.image = "/images/persons/" + self.username + ".jpg"
...         self.site = "http://example.net/"
...         self.start_date = datetime.date(2009, 9, 4)
...     def get_full_name(self):
...         return " ".join([self.first_name, self.last_name])
...     def get_absolute_url(self):
...         return "/persons/" + self.username
...     def get_thumbnail_url(self):
...         return self.image.replace('.jpg', '-thumb.jpg')
...
...     def to_rdf(self):
...         graph = Graph()
...         graph.bind('foaf', FOAF)
...         graph.bind('cv', CV)
...         lang = 'en'
...         d = Describer(graph, base=ORG_URI)
...         d.about(self.get_absolute_url()+'#person')
...         d.rdftype(FOAF.Person)
...         d.value(FOAF.name, self.get_full_name())
...         d.value(FOAF.givenName, self.first_name)
...         d.value(FOAF.familyName, self.last_name)
...         d.rel(FOAF.homepage, self.site)
...         d.value(RDFS.comment, self.presentation, lang=lang)
...         with d.rel(FOAF.depiction, self.image):
...             d.rdftype(FOAF.Image)
...             d.rel(FOAF.thumbnail, self.get_thumbnail_url())
...         with d.rev(CV.aboutPerson):
...             d.rdftype(CV.CV)
...             with d.rel(CV.hasWorkHistory):
...                 d.value(CV.startDate, self.start_date)
...                 d.rel(CV.employedIn, ORG_URI+"#company")
...         return graph
...
>>> person_graph = Person().to_rdf()
>>> expected = Graph().parse(data='''<?xml version="1.0" encoding="utf-8"?>
... <rdf:RDF
...   xmlns:foaf="http://xmlns.com/foaf/0.1/"
...   xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
...   xmlns:cv="http://purl.org/captsolo/resume-rdf/0.2/cv#"
...   xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#">
...   <foaf:Person rdf:about="http://example.org/persons/some1#person">
...     <foaf:name>Some Body</foaf:name>
...     <foaf:givenName>Some</foaf:givenName>
...     <foaf:familyName>Body</foaf:familyName>
...     <foaf:depiction>
...       <foaf:Image
...         rdf:about=
...             "http://example.org/images/persons/some1.jpg">
...         <foaf:thumbnail
...         rdf:resource=
...             "http://example.org/images/persons/some1-thumb.jpg"/>
...       </foaf:Image>
...     </foaf:depiction>
...     <rdfs:comment xml:lang="en">
...             Just a Python &amp; RDF hacker.
...     </rdfs:comment>
...     <foaf:homepage rdf:resource="http://example.net/"/>
...   </foaf:Person>
...   <cv:CV>
...     <cv:aboutPerson
...         rdf:resource="http://example.org/persons/some1#person">
...     </cv:aboutPerson>
...     <cv:hasWorkHistory>
...       <rdf:Description>
...         <cv:startDate
...             rdf:datatype="http://www.w3.org/2001/XMLSchema#date"
...             >2009-09-04</cv:startDate>
...         <cv:employedIn rdf:resource="http://example.org/#company"/>
...       </rdf:Description>
...     </cv:hasWorkHistory>
...   </cv:CV>
... </rdf:RDF>
... ''', format="xml")

>>> from rdflib.compare import isomorphic
>>> isomorphic(person_graph, expected)  #doctest: +SKIP
True

```
"""

from contextlib import contextmanager

from rdflib.graph import Graph
from rdflib.namespace import RDF
from rdflib.term import BNode, Identifier, Literal, URIRef


class Describer:
    def __init__(self, graph=None, about=None, base=None):
        if graph is None:
            graph = Graph()
        self.graph = graph
        self.base = base
        self._subjects = []
        self.about(about or None)

    def about(self, subject, **kws):
        """
        Sets the current subject. Will convert the given object into an
        `URIRef` if it's not an `Identifier`.

        Example:
            ```python
            >>> d = Describer()
            >>> d._current() #doctest: +ELLIPSIS
            rdflib.term.BNode(...)
            >>> d.about("http://example.org/")
            >>> d._current()
            rdflib.term.URIRef('http://example.org/')

            ```
        """
        kws.setdefault("base", self.base)
        subject = cast_identifier(subject, **kws)
        if self._subjects:
            self._subjects[-1] = subject
        else:
            self._subjects.append(subject)

    def value(self, p, v, **kws):
        """
        Set a literal value for the given property. Will cast the value to an
        `Literal` if a plain literal is given.

        Example:
            ```python
            >>> from rdflib import URIRef
            >>> from rdflib.namespace import RDF, RDFS
            >>> d = Describer(about="http://example.org/")
            >>> d.value(RDFS.label, "Example")
            >>> d.graph.value(URIRef('http://example.org/'), RDFS.label)
            rdflib.term.Literal('Example')

            ```
        """
        v = cast_value(v, **kws)
        self.graph.add((self._current(), p, v))

    def rel(self, p, o=None, **kws):
        """Set an object for the given property. Will convert the given object
        into an `URIRef` if it's not an `Identifier`. If none is given, a
        new `BNode` is used.

        Returns a context manager for use in a `with` block, within which the
        given object is used as current subject.

        Example:
            ```python
            >>> from rdflib import URIRef
            >>> from rdflib.namespace import RDF, RDFS
            >>> d = Describer(about="/", base="http://example.org/")
            >>> _ctxt = d.rel(RDFS.seeAlso, "/about")
            >>> d.graph.value(URIRef('http://example.org/'), RDFS.seeAlso)
            rdflib.term.URIRef('http://example.org/about')

            >>> with d.rel(RDFS.seeAlso, "/more"):
            ...     d.value(RDFS.label, "More")
            >>> (URIRef('http://example.org/'), RDFS.seeAlso,
            ...         URIRef('http://example.org/more')) in d.graph
            True
            >>> d.graph.value(URIRef('http://example.org/more'), RDFS.label)
            rdflib.term.Literal('More')

            ```
        """

        kws.setdefault("base", self.base)
        p = cast_identifier(p)
        o = cast_identifier(o, **kws)
        self.graph.add((self._current(), p, o))
        return self._subject_stack(o)

    def rev(self, p, s=None, **kws):
        """
        Same as `rel`, but uses current subject as *object* of the relation.
        The given resource is still used as subject in the returned context
        manager.

        Example:
            ```python
            >>> from rdflib import URIRef
            >>> from rdflib.namespace import RDF, RDFS
            >>> d = Describer(about="http://example.org/")
            >>> with d.rev(RDFS.seeAlso, "http://example.net/"):
            ...     d.value(RDFS.label, "Net")
            >>> (URIRef('http://example.net/'), RDFS.seeAlso,
            ...         URIRef('http://example.org/')) in d.graph
            True
            >>> d.graph.value(URIRef('http://example.net/'), RDFS.label)
            rdflib.term.Literal('Net')

            ```
        """
        kws.setdefault("base", self.base)
        p = cast_identifier(p)
        s = cast_identifier(s, **kws)
        self.graph.add((s, p, self._current()))
        return self._subject_stack(s)

    def rdftype(self, t):
        """Shorthand for setting rdf:type of the current subject.

        Example:
            ```python
            >>> from rdflib import URIRef
            >>> from rdflib.namespace import RDF, RDFS
            >>> d = Describer(about="http://example.org/")
            >>> d.rdftype(RDFS.Resource)
            >>> (URIRef('http://example.org/'),
            ...     RDF.type, RDFS.Resource) in d.graph
            True

            ```
        """
        self.graph.add((self._current(), RDF.type, t))

    def _current(self):
        return self._subjects[-1]

    @contextmanager
    def _subject_stack(self, subject):
        self._subjects.append(subject)
        yield None
        self._subjects.pop()


def cast_value(v, **kws):
    if not isinstance(v, Literal):
        v = Literal(v, **kws)
    return v


def cast_identifier(ref, **kws):
    ref = ref or BNode()
    if not isinstance(ref, Identifier):
        ref = URIRef(ref, **kws)
    return ref
