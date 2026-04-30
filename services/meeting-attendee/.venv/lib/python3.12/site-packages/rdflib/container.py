import warnings
from random import randint

from rdflib.namespace import RDF
from rdflib.term import BNode, URIRef

__all__ = ["Container", "Bag", "Seq", "Alt", "NoElementException"]


class Container:
    """A class for constructing RDF containers, as per <https://www.w3.org/TR/rdf11-mt/#rdf-containers>

    Basic usage, creating a `Bag` and adding to it:

    ```python
    >>> from rdflib import Graph, BNode, Literal, Bag
    >>> g = Graph()
    >>> b = Bag(g, BNode(), [Literal("One"), Literal("Two"), Literal("Three")])
    >>> print(g.serialize(format="turtle"))
    @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
    <BLANKLINE>
    [] a rdf:Bag ;
        rdf:_1 "One" ;
        rdf:_2 "Two" ;
        rdf:_3 "Three" .
    <BLANKLINE>
    <BLANKLINE>

    >>> # print out an item using an index reference
    >>> print(b[2])
    Two

    >>> # add a new item
    >>> b.append(Literal("Hello")) # doctest: +ELLIPSIS
    <rdflib.container.Bag object at ...>
    >>> print(g.serialize(format="turtle"))
    @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
    <BLANKLINE>
    [] a rdf:Bag ;
        rdf:_1 "One" ;
        rdf:_2 "Two" ;
        rdf:_3 "Three" ;
        rdf:_4 "Hello" .
    <BLANKLINE>
    <BLANKLINE>

    ```
    """

    def __init__(self, graph, uri, seq=[], rtype="Bag"):
        """Creates a Container

        Args:
            graph: a Graph instance
            uri: URI or Blank Node of the Container
            seq: the elements of the Container
            rtype: the type of Container, one of "Bag", "Seq" or "Alt"
        """

        self.graph = graph
        self.uri = uri or BNode()
        self._len = 0
        self._rtype = rtype  # rdf:Bag or rdf:Seq or rdf:Alt

        self.append_multiple(seq)

        # adding triple corresponding to container type
        self.graph.add((self.uri, RDF.type, RDF[self._rtype]))

    def n3(self):
        items = []
        for i in range(len(self)):
            v = self[i + 1]
            items.append(v)

        return "( %s )" % " ".join([a.n3() for a in items])

    def _get_container(self):
        """Returns the URI of the container"""

        return self.uri

    def __len__(self):
        """Number of items in container"""

        return self._len

    def type_of_conatiner(self):
        warnings.warn(
            "rdflib.container.Container.type_of_conatiner is deprecated. "
            "Use type_of_container method instead.",
            DeprecationWarning,
            stacklevel=2,
        )
        return self._rtype

    def type_of_container(self):
        return self._rtype

    def index(self, item):
        """Returns the 1-based numerical index of the item in the container"""

        pred = self.graph.predicates(self.uri, item)
        if not pred:
            raise ValueError("%s is not in %s" % (item, "container"))
        li_index = URIRef(str(RDF) + "_")

        i = None
        for p in pred:
            i = int(p.replace(li_index, ""))
        return i

    def __getitem__(self, key):
        """Returns item of the container at index key"""

        c = self._get_container()

        assert isinstance(key, int)
        elem_uri = str(RDF) + "_" + str(key)
        if key <= 0 or key > len(self):
            raise KeyError(key)
        v = self.graph.value(c, URIRef(elem_uri))
        if v:
            return v
        else:
            raise KeyError(key)

    def __setitem__(self, key, value):
        """Sets the item at index key or predicate rdf:_key of the container to value"""

        assert isinstance(key, int)

        c = self._get_container()
        elem_uri = str(RDF) + "_" + str(key)
        if key <= 0 or key > len(self):
            raise KeyError(key)

        self.graph.set((c, URIRef(elem_uri), value))

    def __delitem__(self, key):
        """Removing the item with index key or predicate rdf:_key"""

        assert isinstance(key, int)
        if key <= 0 or key > len(self):
            raise KeyError(key)

        graph = self.graph
        container = self.uri
        elem_uri = str(RDF) + "_" + str(key)
        graph.remove((container, URIRef(elem_uri), None))
        for j in range(key + 1, len(self) + 1):
            elem_uri = str(RDF) + "_" + str(j)
            v = graph.value(container, URIRef(elem_uri))
            graph.remove((container, URIRef(elem_uri), v))
            elem_uri = str(RDF) + "_" + str(j - 1)
            graph.add((container, URIRef(elem_uri), v))

        self._len -= 1

    def items(self):
        """Returns a list of all items in the container"""

        l_ = []
        container = self.uri
        i = 1
        while True:
            elem_uri = str(RDF) + "_" + str(i)

            if (container, URIRef(elem_uri), None) in self.graph:
                i += 1
                l_.append(self.graph.value(container, URIRef(elem_uri)))
            else:
                break
        return l_

    def end(self):  #
        # find end index (1-based) of container

        container = self.uri
        i = 1
        while True:
            elem_uri = str(RDF) + "_" + str(i)

            if (container, URIRef(elem_uri), None) in self.graph:
                i += 1
            else:
                return i - 1

    def append(self, item):
        """Adding item to the end of the container"""

        end = self.end()
        elem_uri = str(RDF) + "_" + str(end + 1)
        container = self.uri
        self.graph.add((container, URIRef(elem_uri), item))
        self._len += 1

        return self

    def append_multiple(self, other):
        """Adding multiple elements to the container to the end which are in python list other"""

        end = self.end()  # it should return the last index

        container = self.uri
        for item in other:
            end += 1
            self._len += 1
            elem_uri = str(RDF) + "_" + str(end)
            self.graph.add((container, URIRef(elem_uri), item))

        return self

    def clear(self):
        """Removing all elements from the container"""

        container = self.uri
        graph = self.graph
        i = 1
        while True:
            elem_uri = str(RDF) + "_" + str(i)
            if (container, URIRef(elem_uri), None) in self.graph:
                graph.remove((container, URIRef(elem_uri), None))
                i += 1
            else:
                break
        self._len = 0
        return self


class Bag(Container):
    """Unordered container (no preference order of elements)"""

    def __init__(self, graph, uri, seq=[]):
        Container.__init__(self, graph, uri, seq, "Bag")


class Alt(Container):
    def __init__(self, graph, uri, seq=[]):
        Container.__init__(self, graph, uri, seq, "Alt")

    def anyone(self):
        if len(self) == 0:
            raise NoElementException()
        else:
            p = randint(1, len(self))
            item = self.__getitem__(p)
            return item


class Seq(Container):
    def __init__(self, graph, uri, seq=[]):
        Container.__init__(self, graph, uri, seq, "Seq")

    def add_at_position(self, pos, item):
        assert isinstance(pos, int)
        if pos <= 0 or pos > len(self) + 1:
            raise ValueError("Invalid Position for inserting element in rdf:Seq")

        if pos == len(self) + 1:
            self.append(item)
        else:
            for j in range(len(self), pos - 1, -1):
                container = self._get_container()
                elem_uri = str(RDF) + "_" + str(j)
                v = self.graph.value(container, URIRef(elem_uri))
                self.graph.remove((container, URIRef(elem_uri), v))
                elem_uri = str(RDF) + "_" + str(j + 1)
                self.graph.add((container, URIRef(elem_uri), v))
            elem_uri_pos = str(RDF) + "_" + str(pos)
            self.graph.add((container, URIRef(elem_uri_pos), item))
            self._len += 1
        return self


class NoElementException(Exception):  # noqa: N818
    def __init__(self, message="rdf:Alt Container is empty"):
        self.message = message

    def __str__(self):
        return self.message
