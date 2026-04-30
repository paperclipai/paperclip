"""
The JSON Schema meta-schemas and vocabularies, exposed as a Registry.
"""

from referencing.jsonschema import EMPTY_REGISTRY as _EMPTY_REGISTRY

from jsonschema_specifications._core import _schemas

#: A `referencing.jsonschema.SchemaRegistry` containing all of the official
#: meta-schemas and vocabularies.
REGISTRY = (_schemas() @ _EMPTY_REGISTRY).crawl()
__all__ = ["REGISTRY"]
