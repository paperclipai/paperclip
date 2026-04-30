import pytest

from referencing import Registry, Resource, Specification
import referencing.jsonschema


@pytest.mark.parametrize(
    "uri, expected",
    [
        (
            "https://json-schema.org/draft/2020-12/schema",
            referencing.jsonschema.DRAFT202012,
        ),
        (
            "https://json-schema.org/draft/2019-09/schema",
            referencing.jsonschema.DRAFT201909,
        ),
        (
            "http://json-schema.org/draft-07/schema#",
            referencing.jsonschema.DRAFT7,
        ),
        (
            "http://json-schema.org/draft-06/schema#",
            referencing.jsonschema.DRAFT6,
        ),
        (
            "http://json-schema.org/draft-04/schema#",
            referencing.jsonschema.DRAFT4,
        ),
        (
            "http://json-schema.org/draft-03/schema#",
            referencing.jsonschema.DRAFT3,
        ),
    ],
)
def test_schemas_with_explicit_schema_keywords_are_detected(uri, expected):
    """
    The $schema keyword in JSON Schema is a dialect identifier.
    """
    contents = {"$schema": uri}
    resource = Resource.from_contents(contents)
    assert resource == Resource(contents=contents, specification=expected)


def test_unknown_dialect():
    dialect_id = "http://example.com/unknown-json-schema-dialect-id"
    with pytest.raises(referencing.jsonschema.UnknownDialect) as excinfo:
        Resource.from_contents({"$schema": dialect_id})
    assert excinfo.value.uri == dialect_id


@pytest.mark.parametrize(
    "id, specification",
    [
        ("$id", referencing.jsonschema.DRAFT202012),
        ("$id", referencing.jsonschema.DRAFT201909),
        ("$id", referencing.jsonschema.DRAFT7),
        ("$id", referencing.jsonschema.DRAFT6),
        ("id", referencing.jsonschema.DRAFT4),
        ("id", referencing.jsonschema.DRAFT3),
    ],
)
def test_id_of_mapping(id, specification):
    uri = "http://example.com/some-schema"
    assert specification.id_of({id: uri}) == uri


@pytest.mark.parametrize(
    "specification",
    [
        referencing.jsonschema.DRAFT202012,
        referencing.jsonschema.DRAFT201909,
        referencing.jsonschema.DRAFT7,
        referencing.jsonschema.DRAFT6,
    ],
)
@pytest.mark.parametrize("value", [True, False])
def test_id_of_bool(specification, value):
    assert specification.id_of(value) is None


@pytest.mark.parametrize(
    "specification",
    [
        referencing.jsonschema.DRAFT202012,
        referencing.jsonschema.DRAFT201909,
        referencing.jsonschema.DRAFT7,
        referencing.jsonschema.DRAFT6,
    ],
)
@pytest.mark.parametrize("value", [True, False])
def test_anchors_in_bool(specification, value):
    assert list(specification.anchors_in(value)) == []


@pytest.mark.parametrize(
    "specification",
    [
        referencing.jsonschema.DRAFT202012,
        referencing.jsonschema.DRAFT201909,
        referencing.jsonschema.DRAFT7,
        referencing.jsonschema.DRAFT6,
    ],
)
@pytest.mark.parametrize("value", [True, False])
def test_subresources_of_bool(specification, value):
    assert list(specification.subresources_of(value)) == []


@pytest.mark.parametrize(
    "uri, expected",
    [
        (
            "https://json-schema.org/draft/2020-12/schema",
            referencing.jsonschema.DRAFT202012,
        ),
        (
            "https://json-schema.org/draft/2019-09/schema",
            referencing.jsonschema.DRAFT201909,
        ),
        (
            "http://json-schema.org/draft-07/schema#",
            referencing.jsonschema.DRAFT7,
        ),
        (
            "http://json-schema.org/draft-06/schema#",
            referencing.jsonschema.DRAFT6,
        ),
        (
            "http://json-schema.org/draft-04/schema#",
            referencing.jsonschema.DRAFT4,
        ),
        (
            "http://json-schema.org/draft-03/schema#",
            referencing.jsonschema.DRAFT3,
        ),
    ],
)
def test_specification_with(uri, expected):
    assert referencing.jsonschema.specification_with(uri) == expected


@pytest.mark.parametrize(
    "uri, expected",
    [
        (
            "http://json-schema.org/draft-07/schema",
            referencing.jsonschema.DRAFT7,
        ),
        (
            "http://json-schema.org/draft-06/schema",
            referencing.jsonschema.DRAFT6,
        ),
        (
            "http://json-schema.org/draft-04/schema",
            referencing.jsonschema.DRAFT4,
        ),
        (
            "http://json-schema.org/draft-03/schema",
            referencing.jsonschema.DRAFT3,
        ),
    ],
)
def test_specification_with_no_empty_fragment(uri, expected):
    assert referencing.jsonschema.specification_with(uri) == expected


def test_specification_with_unknown_dialect():
    dialect_id = "http://example.com/unknown-json-schema-dialect-id"
    with pytest.raises(referencing.jsonschema.UnknownDialect) as excinfo:
        referencing.jsonschema.specification_with(dialect_id)
    assert excinfo.value.uri == dialect_id


def test_specification_with_default():
    dialect_id = "http://example.com/unknown-json-schema-dialect-id"
    specification = referencing.jsonschema.specification_with(
        dialect_id,
        default=Specification.OPAQUE,
    )
    assert specification is Specification.OPAQUE


# FIXME: The tests below should move to the referencing suite but I haven't yet
#        figured out how to represent dynamic (& recursive) ref lookups in it.
def test_lookup_trivial_dynamic_ref():
    one = referencing.jsonschema.DRAFT202012.create_resource(
        {"$dynamicAnchor": "foo"},
    )
    resolver = Registry().with_resource("http://example.com", one).resolver()
    resolved = resolver.lookup("http://example.com#foo")
    assert resolved.contents == one.contents


def test_multiple_lookup_trivial_dynamic_ref():
    TRUE = referencing.jsonschema.DRAFT202012.create_resource(True)
    root = referencing.jsonschema.DRAFT202012.create_resource(
        {
            "$id": "http://example.com",
            "$dynamicAnchor": "fooAnchor",
            "$defs": {
                "foo": {
                    "$id": "foo",
                    "$dynamicAnchor": "fooAnchor",
                    "$defs": {
                        "bar": True,
                        "baz": {
                            "$dynamicAnchor": "fooAnchor",
                        },
                    },
                },
            },
        },
    )
    resolver = (
        Registry()
        .with_resources(
            [
                ("http://example.com", root),
                ("http://example.com/foo/", TRUE),
                ("http://example.com/foo/bar", root),
            ],
        )
        .resolver()
    )

    first = resolver.lookup("http://example.com")
    second = first.resolver.lookup("foo/")
    resolver = second.resolver.lookup("bar").resolver
    fourth = resolver.lookup("#fooAnchor")
    assert fourth.contents == root.contents


def test_multiple_lookup_dynamic_ref_to_nondynamic_ref():
    one = referencing.jsonschema.DRAFT202012.create_resource(
        {"$anchor": "fooAnchor"},
    )
    two = referencing.jsonschema.DRAFT202012.create_resource(
        {
            "$id": "http://example.com",
            "$dynamicAnchor": "fooAnchor",
            "$defs": {
                "foo": {
                    "$id": "foo",
                    "$dynamicAnchor": "fooAnchor",
                    "$defs": {
                        "bar": True,
                        "baz": {
                            "$dynamicAnchor": "fooAnchor",
                        },
                    },
                },
            },
        },
    )
    resolver = (
        Registry()
        .with_resources(
            [
                ("http://example.com", two),
                ("http://example.com/foo/", one),
                ("http://example.com/foo/bar", two),
            ],
        )
        .resolver()
    )

    first = resolver.lookup("http://example.com")
    second = first.resolver.lookup("foo/")
    resolver = second.resolver.lookup("bar").resolver
    fourth = resolver.lookup("#fooAnchor")
    assert fourth.contents == two.contents


def test_lookup_trivial_recursive_ref():
    one = referencing.jsonschema.DRAFT201909.create_resource(
        {"$recursiveAnchor": True},
    )
    resolver = Registry().with_resource("http://example.com", one).resolver()
    first = resolver.lookup("http://example.com")
    resolved = referencing.jsonschema.lookup_recursive_ref(
        resolver=first.resolver,
    )
    assert resolved.contents == one.contents


def test_lookup_recursive_ref_to_bool():
    TRUE = referencing.jsonschema.DRAFT201909.create_resource(True)
    registry = Registry({"http://example.com": TRUE})
    resolved = referencing.jsonschema.lookup_recursive_ref(
        resolver=registry.resolver(base_uri="http://example.com"),
    )
    assert resolved.contents == TRUE.contents


def test_multiple_lookup_recursive_ref_to_bool():
    TRUE = referencing.jsonschema.DRAFT201909.create_resource(True)
    root = referencing.jsonschema.DRAFT201909.create_resource(
        {
            "$id": "http://example.com",
            "$recursiveAnchor": True,
            "$defs": {
                "foo": {
                    "$id": "foo",
                    "$recursiveAnchor": True,
                    "$defs": {
                        "bar": True,
                        "baz": {
                            "$recursiveAnchor": True,
                            "$anchor": "fooAnchor",
                        },
                    },
                },
            },
        },
    )
    resolver = (
        Registry()
        .with_resources(
            [
                ("http://example.com", root),
                ("http://example.com/foo/", TRUE),
                ("http://example.com/foo/bar", root),
            ],
        )
        .resolver()
    )

    first = resolver.lookup("http://example.com")
    second = first.resolver.lookup("foo/")
    resolver = second.resolver.lookup("bar").resolver
    fourth = referencing.jsonschema.lookup_recursive_ref(resolver=resolver)
    assert fourth.contents == root.contents


def test_multiple_lookup_recursive_ref_with_nonrecursive_ref():
    one = referencing.jsonschema.DRAFT201909.create_resource(
        {"$recursiveAnchor": True},
    )
    two = referencing.jsonschema.DRAFT201909.create_resource(
        {
            "$id": "http://example.com",
            "$recursiveAnchor": True,
            "$defs": {
                "foo": {
                    "$id": "foo",
                    "$recursiveAnchor": True,
                    "$defs": {
                        "bar": True,
                        "baz": {
                            "$recursiveAnchor": True,
                            "$anchor": "fooAnchor",
                        },
                    },
                },
            },
        },
    )
    three = referencing.jsonschema.DRAFT201909.create_resource(
        {"$recursiveAnchor": False},
    )
    resolver = (
        Registry()
        .with_resources(
            [
                ("http://example.com", three),
                ("http://example.com/foo/", two),
                ("http://example.com/foo/bar", one),
            ],
        )
        .resolver()
    )

    first = resolver.lookup("http://example.com")
    second = first.resolver.lookup("foo/")
    resolver = second.resolver.lookup("bar").resolver
    fourth = referencing.jsonschema.lookup_recursive_ref(resolver=resolver)
    assert fourth.contents == two.contents


def test_empty_registry():
    assert referencing.jsonschema.EMPTY_REGISTRY == Registry()
