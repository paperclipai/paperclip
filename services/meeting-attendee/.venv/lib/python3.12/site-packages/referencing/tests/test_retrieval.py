from functools import lru_cache
import json

import pytest

from referencing import Registry, Resource, exceptions
from referencing.jsonschema import DRAFT202012
from referencing.retrieval import to_cached_resource


class TestToCachedResource:
    def test_it_caches_retrieved_resources(self):
        contents = {"$schema": "https://json-schema.org/draft/2020-12/schema"}
        stack = [json.dumps(contents)]

        @to_cached_resource()
        def retrieve(uri):
            return stack.pop()

        registry = Registry(retrieve=retrieve)

        expected = Resource.from_contents(contents)

        got = registry.get_or_retrieve("urn:example:schema")
        assert got.value == expected

        # And a second time we get the same value.
        again = registry.get_or_retrieve("urn:example:schema")
        assert again.value is got.value

    def test_custom_loader(self):
        contents = {"$schema": "https://json-schema.org/draft/2020-12/schema"}
        stack = [json.dumps(contents)[::-1]]

        @to_cached_resource(loads=lambda s: json.loads(s[::-1]))
        def retrieve(uri):
            return stack.pop()

        registry = Registry(retrieve=retrieve)

        expected = Resource.from_contents(contents)

        got = registry.get_or_retrieve("urn:example:schema")
        assert got.value == expected

        # And a second time we get the same value.
        again = registry.get_or_retrieve("urn:example:schema")
        assert again.value is got.value

    def test_custom_from_contents(self):
        contents = {}
        stack = [json.dumps(contents)]

        @to_cached_resource(from_contents=DRAFT202012.create_resource)
        def retrieve(uri):
            return stack.pop()

        registry = Registry(retrieve=retrieve)

        expected = DRAFT202012.create_resource(contents)

        got = registry.get_or_retrieve("urn:example:schema")
        assert got.value == expected

        # And a second time we get the same value.
        again = registry.get_or_retrieve("urn:example:schema")
        assert again.value is got.value

    def test_custom_cache(self):
        schema = {"$schema": "https://json-schema.org/draft/2020-12/schema"}
        mapping = {
            "urn:example:1": dict(schema, foo=1),
            "urn:example:2": dict(schema, foo=2),
            "urn:example:3": dict(schema, foo=3),
        }

        resources = {
            uri: Resource.from_contents(contents)
            for uri, contents in mapping.items()
        }

        @to_cached_resource(cache=lru_cache(maxsize=2))
        def retrieve(uri):
            return json.dumps(mapping.pop(uri))

        registry = Registry(retrieve=retrieve)

        got = registry.get_or_retrieve("urn:example:1")
        assert got.value == resources["urn:example:1"]
        assert registry.get_or_retrieve("urn:example:1").value is got.value
        assert registry.get_or_retrieve("urn:example:1").value is got.value

        got = registry.get_or_retrieve("urn:example:2")
        assert got.value == resources["urn:example:2"]
        assert registry.get_or_retrieve("urn:example:2").value is got.value
        assert registry.get_or_retrieve("urn:example:2").value is got.value

        # This still succeeds, but evicts the first URI
        got = registry.get_or_retrieve("urn:example:3")
        assert got.value == resources["urn:example:3"]
        assert registry.get_or_retrieve("urn:example:3").value is got.value
        assert registry.get_or_retrieve("urn:example:3").value is got.value

        # And now this fails (as we popped the value out of `mapping`)
        with pytest.raises(exceptions.Unretrievable):
            registry.get_or_retrieve("urn:example:1")
