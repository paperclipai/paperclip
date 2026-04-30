from rdflib.contrib.rdf4j import has_httpx

if has_httpx:
    from .client import GraphDBClient

    __all__ = ["GraphDBClient"]
