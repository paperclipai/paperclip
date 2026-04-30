"""Parsers and serializers for SPARQL Result formats

All builtin [SPARQL result serializers][rdflib.query.ResultSerializer] available
after [a query][rdflib.graph.Graph.query] are listed here.
The serializer can be chosen during [serialization of a result][rdflib.query.Result.serialize].

```
import rdflib

result : rdflib.query.Result
g = rdflib.Graph().parse(format="ttl", data=\"\"\"
    @base <http://example.org/> .
    <MyObject> a <MyClass>.
\"\"\")
result = g.query("SELECT ?x ?cls WHERE {?x a ?cls}")
print(result.serialize(format="txt").decode("utf8"))
```

Registration of builtin and external plugins
is described in [`rdflib.plugin`][rdflib.plugin].
"""
