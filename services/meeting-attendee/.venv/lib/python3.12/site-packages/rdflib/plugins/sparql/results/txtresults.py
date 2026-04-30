from __future__ import annotations

from io import StringIO
from typing import IO, List, Optional, Union

from rdflib.namespace import NamespaceManager
from rdflib.query import ResultSerializer
from rdflib.term import BNode, Literal, URIRef, Variable


def _termString(
    t: Optional[Union[URIRef, Literal, BNode]],
    namespace_manager: Optional[NamespaceManager],
) -> str:
    if t is None:
        return "-"
    if namespace_manager:
        if isinstance(t, URIRef):
            return namespace_manager.normalizeUri(t)
        elif isinstance(t, BNode):
            return t.n3()
        elif isinstance(t, Literal):
            return t._literal_n3(qname_callback=namespace_manager.normalizeUri)
    else:
        return t.n3()


class TXTResultSerializer(ResultSerializer):
    """
    A write-only QueryResult serializer for text/ascii tables
    """

    def serialize(
        self,
        stream: IO,
        encoding: str = "utf-8",
        *,
        namespace_manager: Optional[NamespaceManager] = None,
        **kwargs,
    ) -> None:
        """
        return a text table of query results
        """

        def c(s, w):
            """
            center the string s in w wide string
            """
            w -= len(s)
            h1 = h2 = w // 2
            if w % 2:
                h2 += 1
            return " " * h1 + s + " " * h2

        if self.result.type != "SELECT":
            raise Exception("Can only pretty print SELECT results!")
        string_stream = StringIO()
        if not self.result:
            string_stream.write("(no results)\n")
        else:
            keys: List[Variable] = self.result.vars  # type: ignore[assignment]
            maxlen = [0] * len(keys)
            b = [
                # type error: Value of type "Union[Tuple[Node, Node, Node], bool, ResultRow]" is not indexable
                # type error: Argument 1 to "_termString" has incompatible type "Union[Node, Any]"; expected "Union[URIRef, Literal, BNode, None]"  [arg-type]
                # type error: No overload variant of "__getitem__" of "tuple" matches argument type "Variable"
                # NOTE on type error: The problem here is that r can be more types than _termString expects because result can be a result of multiple types.
                [_termString(r[k], namespace_manager) for k in keys]  # type: ignore[index, arg-type, call-overload]
                for r in self.result
            ]
            for r in b:
                for i in range(len(keys)):
                    maxlen[i] = max(maxlen[i], len(r[i]))
            string_stream.write(
                "|".join([c(k, maxlen[i]) for i, k in enumerate(keys)]) + "\n"
            )
            string_stream.write("-" * (len(maxlen) + sum(maxlen)) + "\n")
            for r in sorted(b):
                string_stream.write(
                    "|".join([t + " " * (i - len(t)) for i, t in zip(maxlen, r)]) + "\n"
                )
        text_val = string_stream.getvalue()
        try:
            stream.write(text_val.encode(encoding))
        except (TypeError, ValueError):
            stream.write(text_val)
