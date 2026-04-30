from rpds import HashTrieMap
import pytest

from referencing import Anchor, Registry, Resource, Specification, exceptions
from referencing.jsonschema import DRAFT202012

ID_AND_CHILDREN = Specification(
    name="id-and-children",
    id_of=lambda contents: contents.get("ID"),
    subresources_of=lambda contents: contents.get("children", []),
    anchors_in=lambda specification, contents: [
        Anchor(
            name=name,
            resource=specification.create_resource(contents=each),
        )
        for name, each in contents.get("anchors", {}).items()
    ],
    maybe_in_subresource=lambda segments, resolver, subresource: (
        resolver.in_subresource(subresource)
        if not len(segments) % 2
        and all(each == "children" for each in segments[::2])
        else resolver
    ),
)


def blow_up(uri):  # pragma: no cover
    """
    A retriever suitable for use in tests which expect it never to be used.
    """
    raise RuntimeError("This retrieve function expects to never be called!")


class TestRegistry:
    def test_with_resource(self):
        """
        Adding a resource to the registry then allows re-retrieving it.
        """

        resource = Resource.opaque(contents={"foo": "bar"})
        uri = "urn:example"
        registry = Registry().with_resource(uri=uri, resource=resource)
        assert registry[uri] is resource

    def test_with_resources(self):
        """
        Adding multiple resources to the registry is like adding each one.
        """

        one = Resource.opaque(contents={})
        two = Resource(contents={"foo": "bar"}, specification=ID_AND_CHILDREN)
        registry = Registry().with_resources(
            [
                ("http://example.com/1", one),
                ("http://example.com/foo/bar", two),
            ],
        )
        assert registry == Registry().with_resource(
            uri="http://example.com/1",
            resource=one,
        ).with_resource(
            uri="http://example.com/foo/bar",
            resource=two,
        )

    def test_matmul_resource(self):
        uri = "urn:example:resource"
        resource = ID_AND_CHILDREN.create_resource({"ID": uri, "foo": 12})
        registry = resource @ Registry()
        assert registry == Registry().with_resource(uri, resource)

    def test_matmul_many_resources(self):
        one_uri = "urn:example:one"
        one = ID_AND_CHILDREN.create_resource({"ID": one_uri, "foo": 12})

        two_uri = "urn:example:two"
        two = ID_AND_CHILDREN.create_resource({"ID": two_uri, "foo": 12})

        registry = [one, two] @ Registry()
        assert registry == Registry().with_resources(
            [(one_uri, one), (two_uri, two)],
        )

    def test_matmul_resource_without_id(self):
        resource = Resource.opaque(contents={"foo": "bar"})
        with pytest.raises(exceptions.NoInternalID) as e:
            resource @ Registry()
        assert e.value == exceptions.NoInternalID(resource=resource)

    def test_with_contents_from_json_schema(self):
        uri = "urn:example"
        schema = {"$schema": "https://json-schema.org/draft/2020-12/schema"}
        registry = Registry().with_contents([(uri, schema)])

        expected = Resource(contents=schema, specification=DRAFT202012)
        assert registry[uri] == expected

    def test_with_contents_and_default_specification(self):
        uri = "urn:example"
        registry = Registry().with_contents(
            [(uri, {"foo": "bar"})],
            default_specification=Specification.OPAQUE,
        )
        assert registry[uri] == Resource.opaque({"foo": "bar"})

    def test_len(self):
        total = 5
        registry = Registry().with_contents(
            [(str(i), {"foo": "bar"}) for i in range(total)],
            default_specification=Specification.OPAQUE,
        )
        assert len(registry) == total

    def test_bool_empty(self):
        assert not Registry()

    def test_bool_not_empty(self):
        registry = Registry().with_contents(
            [(str(i), {"foo": "bar"}) for i in range(3)],
            default_specification=Specification.OPAQUE,
        )
        assert registry

    def test_iter(self):
        registry = Registry().with_contents(
            [(str(i), {"foo": "bar"}) for i in range(8)],
            default_specification=Specification.OPAQUE,
        )
        assert set(registry) == {str(i) for i in range(8)}

    def test_crawl_still_has_top_level_resource(self):
        resource = Resource.opaque({"foo": "bar"})
        uri = "urn:example"
        registry = Registry({uri: resource}).crawl()
        assert registry[uri] is resource

    def test_crawl_finds_a_subresource(self):
        child_id = "urn:child"
        root = ID_AND_CHILDREN.create_resource(
            {"ID": "urn:root", "children": [{"ID": child_id, "foo": 12}]},
        )
        registry = root @ Registry()
        with pytest.raises(LookupError):
            registry[child_id]

        expected = ID_AND_CHILDREN.create_resource({"ID": child_id, "foo": 12})
        assert registry.crawl()[child_id] == expected

    def test_crawl_finds_anchors_with_id(self):
        resource = ID_AND_CHILDREN.create_resource(
            {"ID": "urn:bar", "anchors": {"foo": 12}},
        )
        registry = resource @ Registry()

        assert registry.crawl().anchor(resource.id(), "foo").value == Anchor(
            name="foo",
            resource=ID_AND_CHILDREN.create_resource(12),
        )

    def test_crawl_finds_anchors_no_id(self):
        resource = ID_AND_CHILDREN.create_resource({"anchors": {"foo": 12}})
        registry = Registry().with_resource("urn:root", resource)

        assert registry.crawl().anchor("urn:root", "foo").value == Anchor(
            name="foo",
            resource=ID_AND_CHILDREN.create_resource(12),
        )

    def test_contents(self):
        resource = Resource.opaque({"foo": "bar"})
        uri = "urn:example"
        registry = Registry().with_resource(uri, resource)
        assert registry.contents(uri) == {"foo": "bar"}

    def test_getitem_strips_empty_fragments(self):
        uri = "http://example.com/"
        resource = ID_AND_CHILDREN.create_resource({"ID": uri + "#"})
        registry = resource @ Registry()
        assert registry[uri] == registry[uri + "#"] == resource

    def test_contents_strips_empty_fragments(self):
        uri = "http://example.com/"
        resource = ID_AND_CHILDREN.create_resource({"ID": uri + "#"})
        registry = resource @ Registry()
        assert (
            registry.contents(uri)
            == registry.contents(uri + "#")
            == {"ID": uri + "#"}
        )

    def test_contents_nonexistent_resource(self):
        registry = Registry()
        with pytest.raises(exceptions.NoSuchResource) as e:
            registry.contents("urn:example")
        assert e.value == exceptions.NoSuchResource(ref="urn:example")

    def test_crawled_anchor(self):
        resource = ID_AND_CHILDREN.create_resource({"anchors": {"foo": "bar"}})
        registry = Registry().with_resource("urn:example", resource)
        retrieved = registry.anchor("urn:example", "foo")
        assert retrieved.value == Anchor(
            name="foo",
            resource=ID_AND_CHILDREN.create_resource("bar"),
        )
        assert retrieved.registry == registry.crawl()

    def test_anchor_in_nonexistent_resource(self):
        registry = Registry()
        with pytest.raises(exceptions.NoSuchResource) as e:
            registry.anchor("urn:example", "foo")
        assert e.value == exceptions.NoSuchResource(ref="urn:example")

    def test_init(self):
        one = Resource.opaque(contents={})
        two = ID_AND_CHILDREN.create_resource({"foo": "bar"})
        registry = Registry(
            {
                "http://example.com/1": one,
                "http://example.com/foo/bar": two,
            },
        )
        assert (
            registry
            == Registry()
            .with_resources(
                [
                    ("http://example.com/1", one),
                    ("http://example.com/foo/bar", two),
                ],
            )
            .crawl()
        )

    def test_dict_conversion(self):
        """
        Passing a `dict` to `Registry` gets converted to a `HashTrieMap`.

        So continuing to use the registry works.
        """

        one = Resource.opaque(contents={})
        two = ID_AND_CHILDREN.create_resource({"foo": "bar"})
        registry = Registry(
            {"http://example.com/1": one},
        ).with_resource("http://example.com/foo/bar", two)
        assert (
            registry.crawl()
            == Registry()
            .with_resources(
                [
                    ("http://example.com/1", one),
                    ("http://example.com/foo/bar", two),
                ],
            )
            .crawl()
        )

    def test_no_such_resource(self):
        registry = Registry()
        with pytest.raises(exceptions.NoSuchResource) as e:
            registry["urn:bigboom"]
        assert e.value == exceptions.NoSuchResource(ref="urn:bigboom")

    def test_combine(self):
        one = Resource.opaque(contents={})
        two = ID_AND_CHILDREN.create_resource({"foo": "bar"})
        three = ID_AND_CHILDREN.create_resource({"baz": "quux"})
        four = ID_AND_CHILDREN.create_resource({"anchors": {"foo": 12}})

        first = Registry({"http://example.com/1": one})
        second = Registry().with_resource("http://example.com/foo/bar", two)
        third = Registry(
            {
                "http://example.com/1": one,
                "http://example.com/baz": three,
            },
        )
        fourth = (
            Registry()
            .with_resource(
                "http://example.com/foo/quux",
                four,
            )
            .crawl()
        )
        assert first.combine(second, third, fourth) == Registry(
            [
                ("http://example.com/1", one),
                ("http://example.com/baz", three),
                ("http://example.com/foo/quux", four),
            ],
            anchors=HashTrieMap(
                {
                    ("http://example.com/foo/quux", "foo"): Anchor(
                        name="foo",
                        resource=ID_AND_CHILDREN.create_resource(12),
                    ),
                },
            ),
        ).with_resource("http://example.com/foo/bar", two)

    def test_combine_self(self):
        """
        Combining a registry with itself short-circuits.

        This is a performance optimization -- otherwise we do lots more work
        (in jsonschema this seems to correspond to making the test suite take
         *3x* longer).
        """

        registry = Registry({"urn:foo": "bar"})
        assert registry.combine(registry) is registry

    def test_combine_with_uncrawled_resources(self):
        one = Resource.opaque(contents={})
        two = ID_AND_CHILDREN.create_resource({"foo": "bar"})
        three = ID_AND_CHILDREN.create_resource({"baz": "quux"})

        first = Registry().with_resource("http://example.com/1", one)
        second = Registry().with_resource("http://example.com/foo/bar", two)
        third = Registry(
            {
                "http://example.com/1": one,
                "http://example.com/baz": three,
            },
        )
        expected = Registry(
            [
                ("http://example.com/1", one),
                ("http://example.com/foo/bar", two),
                ("http://example.com/baz", three),
            ],
        )
        combined = first.combine(second, third)
        assert combined != expected
        assert combined.crawl() == expected

    def test_combine_with_single_retrieve(self):
        one = Resource.opaque(contents={})
        two = ID_AND_CHILDREN.create_resource({"foo": "bar"})
        three = ID_AND_CHILDREN.create_resource({"baz": "quux"})

        def retrieve(uri):  # pragma: no cover
            pass

        first = Registry().with_resource("http://example.com/1", one)
        second = Registry(
            retrieve=retrieve,
        ).with_resource("http://example.com/2", two)
        third = Registry().with_resource("http://example.com/3", three)

        assert first.combine(second, third) == Registry(
            retrieve=retrieve,
        ).with_resources(
            [
                ("http://example.com/1", one),
                ("http://example.com/2", two),
                ("http://example.com/3", three),
            ],
        )
        assert second.combine(first, third) == Registry(
            retrieve=retrieve,
        ).with_resources(
            [
                ("http://example.com/1", one),
                ("http://example.com/2", two),
                ("http://example.com/3", three),
            ],
        )

    def test_combine_with_common_retrieve(self):
        one = Resource.opaque(contents={})
        two = ID_AND_CHILDREN.create_resource({"foo": "bar"})
        three = ID_AND_CHILDREN.create_resource({"baz": "quux"})

        def retrieve(uri):  # pragma: no cover
            pass

        first = Registry(retrieve=retrieve).with_resource(
            "http://example.com/1",
            one,
        )
        second = Registry(
            retrieve=retrieve,
        ).with_resource("http://example.com/2", two)
        third = Registry(retrieve=retrieve).with_resource(
            "http://example.com/3",
            three,
        )

        assert first.combine(second, third) == Registry(
            retrieve=retrieve,
        ).with_resources(
            [
                ("http://example.com/1", one),
                ("http://example.com/2", two),
                ("http://example.com/3", three),
            ],
        )
        assert second.combine(first, third) == Registry(
            retrieve=retrieve,
        ).with_resources(
            [
                ("http://example.com/1", one),
                ("http://example.com/2", two),
                ("http://example.com/3", three),
            ],
        )

    def test_combine_conflicting_retrieve(self):
        one = Resource.opaque(contents={})
        two = ID_AND_CHILDREN.create_resource({"foo": "bar"})
        three = ID_AND_CHILDREN.create_resource({"baz": "quux"})

        def foo_retrieve(uri):  # pragma: no cover
            pass

        def bar_retrieve(uri):  # pragma: no cover
            pass

        first = Registry(retrieve=foo_retrieve).with_resource(
            "http://example.com/1",
            one,
        )
        second = Registry().with_resource("http://example.com/2", two)
        third = Registry(retrieve=bar_retrieve).with_resource(
            "http://example.com/3",
            three,
        )

        with pytest.raises(Exception, match="conflict.*retriev"):
            first.combine(second, third)

    def test_remove(self):
        one = Resource.opaque(contents={})
        two = ID_AND_CHILDREN.create_resource({"foo": "bar"})
        registry = Registry({"urn:foo": one, "urn:bar": two})
        assert registry.remove("urn:foo") == Registry({"urn:bar": two})

    def test_remove_uncrawled(self):
        one = Resource.opaque(contents={})
        two = ID_AND_CHILDREN.create_resource({"foo": "bar"})
        registry = Registry().with_resources(
            [("urn:foo", one), ("urn:bar", two)],
        )
        assert registry.remove("urn:foo") == Registry().with_resource(
            "urn:bar",
            two,
        )

    def test_remove_with_anchors(self):
        one = Resource.opaque(contents={})
        two = ID_AND_CHILDREN.create_resource({"anchors": {"foo": "bar"}})
        registry = (
            Registry()
            .with_resources(
                [("urn:foo", one), ("urn:bar", two)],
            )
            .crawl()
        )
        assert (
            registry.remove("urn:bar")
            == Registry()
            .with_resource(
                "urn:foo",
                one,
            )
            .crawl()
        )

    def test_remove_nonexistent_uri(self):
        with pytest.raises(exceptions.NoSuchResource) as e:
            Registry().remove("urn:doesNotExist")
        assert e.value == exceptions.NoSuchResource(ref="urn:doesNotExist")

    def test_retrieve(self):
        foo = Resource.opaque({"foo": "bar"})
        registry = Registry(retrieve=lambda uri: foo)
        assert registry.get_or_retrieve("urn:example").value == foo

    def test_retrieve_arbitrary_exception(self):
        foo = Resource.opaque({"foo": "bar"})

        def retrieve(uri):
            if uri == "urn:succeed":
                return foo
            raise Exception("Oh no!")

        registry = Registry(retrieve=retrieve)
        assert registry.get_or_retrieve("urn:succeed").value == foo
        with pytest.raises(exceptions.Unretrievable):
            registry.get_or_retrieve("urn:uhoh")

    def test_retrieve_no_such_resource(self):
        foo = Resource.opaque({"foo": "bar"})

        def retrieve(uri):
            if uri == "urn:succeed":
                return foo
            raise exceptions.NoSuchResource(ref=uri)

        registry = Registry(retrieve=retrieve)
        assert registry.get_or_retrieve("urn:succeed").value == foo
        with pytest.raises(exceptions.NoSuchResource):
            registry.get_or_retrieve("urn:uhoh")

    def test_retrieve_cannot_determine_specification(self):
        def retrieve(uri):
            return Resource.from_contents({})

        registry = Registry(retrieve=retrieve)
        with pytest.raises(exceptions.CannotDetermineSpecification):
            registry.get_or_retrieve("urn:uhoh")

    def test_retrieve_already_available_resource(self):
        foo = Resource.opaque({"foo": "bar"})
        registry = Registry({"urn:example": foo}, retrieve=blow_up)
        assert registry["urn:example"] == foo
        assert registry.get_or_retrieve("urn:example").value == foo

    def test_retrieve_first_checks_crawlable_resource(self):
        child = ID_AND_CHILDREN.create_resource({"ID": "urn:child", "foo": 12})
        root = ID_AND_CHILDREN.create_resource({"children": [child.contents]})
        registry = Registry(retrieve=blow_up).with_resource("urn:root", root)
        assert registry.crawl()["urn:child"] == child

    def test_resolver(self):
        one = Resource.opaque(contents={})
        registry = Registry({"http://example.com": one})
        resolver = registry.resolver(base_uri="http://example.com")
        assert resolver.lookup("#").contents == {}

    def test_resolver_with_root_identified(self):
        root = ID_AND_CHILDREN.create_resource({"ID": "http://example.com"})
        resolver = Registry().resolver_with_root(root)
        assert resolver.lookup("http://example.com").contents == root.contents
        assert resolver.lookup("#").contents == root.contents

    def test_resolver_with_root_unidentified(self):
        root = Resource.opaque(contents={})
        resolver = Registry().resolver_with_root(root)
        assert resolver.lookup("#").contents == root.contents

    def test_repr(self):
        one = Resource.opaque(contents={})
        two = ID_AND_CHILDREN.create_resource({"foo": "bar"})
        registry = Registry().with_resources(
            [
                ("http://example.com/1", one),
                ("http://example.com/foo/bar", two),
            ],
        )
        assert repr(registry) == "<Registry (2 uncrawled resources)>"
        assert repr(registry.crawl()) == "<Registry (2 resources)>"

    def test_repr_mixed_crawled(self):
        one = Resource.opaque(contents={})
        two = ID_AND_CHILDREN.create_resource({"foo": "bar"})
        registry = (
            Registry(
                {"http://example.com/1": one},
            )
            .crawl()
            .with_resource(uri="http://example.com/foo/bar", resource=two)
        )
        assert repr(registry) == "<Registry (2 resources, 1 uncrawled)>"

    def test_repr_one_resource(self):
        registry = Registry().with_resource(
            uri="http://example.com/1",
            resource=Resource.opaque(contents={}),
        )
        assert repr(registry) == "<Registry (1 uncrawled resource)>"

    def test_repr_empty(self):
        assert repr(Registry()) == "<Registry (0 resources)>"


class TestResource:
    def test_from_contents_from_json_schema(self):
        schema = {"$schema": "https://json-schema.org/draft/2020-12/schema"}
        resource = Resource.from_contents(schema)
        assert resource == Resource(contents=schema, specification=DRAFT202012)

    def test_from_contents_with_no_discernible_information(self):
        """
        Creating a resource with no discernible way to see what
        specification it belongs to (e.g. no ``$schema`` keyword for JSON
        Schema) raises an error.
        """

        with pytest.raises(exceptions.CannotDetermineSpecification):
            Resource.from_contents({"foo": "bar"})

    def test_from_contents_with_no_discernible_information_and_default(self):
        resource = Resource.from_contents(
            {"foo": "bar"},
            default_specification=Specification.OPAQUE,
        )
        assert resource == Resource.opaque(contents={"foo": "bar"})

    def test_from_contents_unneeded_default(self):
        schema = {"$schema": "https://json-schema.org/draft/2020-12/schema"}
        resource = Resource.from_contents(
            schema,
            default_specification=Specification.OPAQUE,
        )
        assert resource == Resource(
            contents=schema,
            specification=DRAFT202012,
        )

    def test_non_mapping_from_contents(self):
        resource = Resource.from_contents(
            True,
            default_specification=ID_AND_CHILDREN,
        )
        assert resource == Resource(
            contents=True,
            specification=ID_AND_CHILDREN,
        )

    def test_from_contents_with_fallback(self):
        resource = Resource.from_contents(
            {"foo": "bar"},
            default_specification=Specification.OPAQUE,
        )
        assert resource == Resource.opaque(contents={"foo": "bar"})

    def test_id_delegates_to_specification(self):
        specification = Specification(
            name="",
            id_of=lambda contents: "urn:fixedID",
            subresources_of=lambda contents: [],
            anchors_in=lambda specification, contents: [],
            maybe_in_subresource=(
                lambda segments, resolver, subresource: resolver
            ),
        )
        resource = Resource(
            contents={"foo": "baz"},
            specification=specification,
        )
        assert resource.id() == "urn:fixedID"

    def test_id_strips_empty_fragment(self):
        uri = "http://example.com/"
        root = ID_AND_CHILDREN.create_resource({"ID": uri + "#"})
        assert root.id() == uri

    def test_subresources_delegates_to_specification(self):
        resource = ID_AND_CHILDREN.create_resource({"children": [{}, 12]})
        assert list(resource.subresources()) == [
            ID_AND_CHILDREN.create_resource(each) for each in [{}, 12]
        ]

    def test_subresource_with_different_specification(self):
        schema = {"$schema": "https://json-schema.org/draft/2020-12/schema"}
        resource = ID_AND_CHILDREN.create_resource({"children": [schema]})
        assert list(resource.subresources()) == [
            DRAFT202012.create_resource(schema),
        ]

    def test_anchors_delegates_to_specification(self):
        resource = ID_AND_CHILDREN.create_resource(
            {"anchors": {"foo": {}, "bar": 1, "baz": ""}},
        )
        assert list(resource.anchors()) == [
            Anchor(name="foo", resource=ID_AND_CHILDREN.create_resource({})),
            Anchor(name="bar", resource=ID_AND_CHILDREN.create_resource(1)),
            Anchor(name="baz", resource=ID_AND_CHILDREN.create_resource("")),
        ]

    def test_pointer_to_mapping(self):
        resource = Resource.opaque(contents={"foo": "baz"})
        resolver = Registry().resolver()
        assert resource.pointer("/foo", resolver=resolver).contents == "baz"

    def test_pointer_to_array(self):
        resource = Resource.opaque(contents={"foo": {"bar": [3]}})
        resolver = Registry().resolver()
        assert resource.pointer("/foo/bar/0", resolver=resolver).contents == 3

    def test_root_pointer(self):
        contents = {"foo": "baz"}
        resource = Resource.opaque(contents=contents)
        resolver = Registry().resolver()
        assert resource.pointer("", resolver=resolver).contents == contents

    def test_opaque(self):
        contents = {"foo": "bar"}
        assert Resource.opaque(contents) == Resource(
            contents=contents,
            specification=Specification.OPAQUE,
        )


class TestResolver:
    def test_lookup_exact_uri(self):
        resource = Resource.opaque(contents={"foo": "baz"})
        resolver = Registry({"http://example.com/1": resource}).resolver()
        resolved = resolver.lookup("http://example.com/1")
        assert resolved.contents == resource.contents

    def test_lookup_subresource(self):
        root = ID_AND_CHILDREN.create_resource(
            {
                "ID": "http://example.com/",
                "children": [
                    {"ID": "http://example.com/a", "foo": 12},
                ],
            },
        )
        registry = root @ Registry()
        resolved = registry.resolver().lookup("http://example.com/a")
        assert resolved.contents == {"ID": "http://example.com/a", "foo": 12}

    def test_lookup_anchor_with_id(self):
        root = ID_AND_CHILDREN.create_resource(
            {
                "ID": "http://example.com/",
                "anchors": {"foo": 12},
            },
        )
        registry = root @ Registry()
        resolved = registry.resolver().lookup("http://example.com/#foo")
        assert resolved.contents == 12

    def test_lookup_anchor_without_id(self):
        root = ID_AND_CHILDREN.create_resource({"anchors": {"foo": 12}})
        resolver = Registry().with_resource("urn:example", root).resolver()
        resolved = resolver.lookup("urn:example#foo")
        assert resolved.contents == 12

    def test_lookup_unknown_reference(self):
        resolver = Registry().resolver()
        ref = "http://example.com/does/not/exist"
        with pytest.raises(exceptions.Unresolvable) as e:
            resolver.lookup(ref)
        assert e.value == exceptions.Unresolvable(ref=ref)

    def test_lookup_non_existent_pointer(self):
        resource = Resource.opaque({"foo": {}})
        resolver = Registry({"http://example.com/1": resource}).resolver()
        ref = "http://example.com/1#/foo/bar"
        with pytest.raises(exceptions.Unresolvable) as e:
            resolver.lookup(ref)
        assert e.value == exceptions.PointerToNowhere(
            ref="/foo/bar",
            resource=resource,
        )
        assert str(e.value) == "'/foo/bar' does not exist within {'foo': {}}"

    def test_lookup_non_existent_pointer_to_array_index(self):
        resource = Resource.opaque([1, 2, 4, 8])
        resolver = Registry({"http://example.com/1": resource}).resolver()
        ref = "http://example.com/1#/10"
        with pytest.raises(exceptions.Unresolvable) as e:
            resolver.lookup(ref)
        assert e.value == exceptions.PointerToNowhere(
            ref="/10",
            resource=resource,
        )

    def test_lookup_pointer_to_empty_string(self):
        resolver = Registry().resolver_with_root(Resource.opaque({"": {}}))
        assert resolver.lookup("#/").contents == {}

    def test_lookup_non_existent_pointer_to_empty_string(self):
        resource = Resource.opaque({"foo": {}})
        resolver = Registry().resolver_with_root(resource)
        with pytest.raises(
            exceptions.Unresolvable,
            match="^'/' does not exist within {'foo': {}}.*'#'",
        ) as e:
            resolver.lookup("#/")
        assert e.value == exceptions.PointerToNowhere(
            ref="/",
            resource=resource,
        )

    def test_lookup_non_existent_anchor(self):
        root = ID_AND_CHILDREN.create_resource({"anchors": {}})
        resolver = Registry().with_resource("urn:example", root).resolver()
        resolved = resolver.lookup("urn:example")
        assert resolved.contents == root.contents

        ref = "urn:example#noSuchAnchor"
        with pytest.raises(exceptions.Unresolvable) as e:
            resolver.lookup(ref)
        assert "'noSuchAnchor' does not exist" in str(e.value)
        assert e.value == exceptions.NoSuchAnchor(
            ref="urn:example",
            resource=root,
            anchor="noSuchAnchor",
        )

    def test_lookup_invalid_JSON_pointerish_anchor(self):
        resolver = Registry().resolver_with_root(
            ID_AND_CHILDREN.create_resource(
                {
                    "ID": "http://example.com/",
                    "foo": {"bar": 12},
                },
            ),
        )

        valid = resolver.lookup("#/foo/bar")
        assert valid.contents == 12

        with pytest.raises(exceptions.InvalidAnchor) as e:
            resolver.lookup("#foo/bar")
        assert " '#/foo/bar'" in str(e.value)

    def test_lookup_retrieved_resource(self):
        resource = Resource.opaque(contents={"foo": "baz"})
        resolver = Registry(retrieve=lambda uri: resource).resolver()
        resolved = resolver.lookup("http://example.com/")
        assert resolved.contents == resource.contents

    def test_lookup_failed_retrieved_resource(self):
        """
        Unretrievable exceptions are also wrapped in Unresolvable.
        """

        uri = "http://example.com/"

        registry = Registry(retrieve=blow_up)
        with pytest.raises(exceptions.Unretrievable):
            registry.get_or_retrieve(uri)

        resolver = registry.resolver()
        with pytest.raises(exceptions.Unresolvable):
            resolver.lookup(uri)

    def test_repeated_lookup_from_retrieved_resource(self):
        """
        A (custom-)retrieved resource is added to the registry returned by
        looking it up.
        """
        resource = Resource.opaque(contents={"foo": "baz"})
        once = [resource]

        def retrieve(uri):
            return once.pop()

        resolver = Registry(retrieve=retrieve).resolver()
        resolved = resolver.lookup("http://example.com/")
        assert resolved.contents == resource.contents

        resolved = resolved.resolver.lookup("http://example.com/")
        assert resolved.contents == resource.contents

    def test_repeated_anchor_lookup_from_retrieved_resource(self):
        resource = Resource.opaque(contents={"foo": "baz"})
        once = [resource]

        def retrieve(uri):
            return once.pop()

        resolver = Registry(retrieve=retrieve).resolver()
        resolved = resolver.lookup("http://example.com/")
        assert resolved.contents == resource.contents

        resolved = resolved.resolver.lookup("#")
        assert resolved.contents == resource.contents

    # FIXME: The tests below aren't really representable in the current
    #        suite, though we should probably think of ways to do so.

    def test_in_subresource(self):
        root = ID_AND_CHILDREN.create_resource(
            {
                "ID": "http://example.com/",
                "children": [
                    {
                        "ID": "child/",
                        "children": [{"ID": "grandchild"}],
                    },
                ],
            },
        )
        registry = root @ Registry()

        resolver = registry.resolver()
        first = resolver.lookup("http://example.com/")
        assert first.contents == root.contents

        with pytest.raises(exceptions.Unresolvable):
            first.resolver.lookup("grandchild")

        sub = first.resolver.in_subresource(
            ID_AND_CHILDREN.create_resource(first.contents["children"][0]),
        )
        second = sub.lookup("grandchild")
        assert second.contents == {"ID": "grandchild"}

    def test_in_pointer_subresource(self):
        root = ID_AND_CHILDREN.create_resource(
            {
                "ID": "http://example.com/",
                "children": [
                    {
                        "ID": "child/",
                        "children": [{"ID": "grandchild"}],
                    },
                ],
            },
        )
        registry = root @ Registry()

        resolver = registry.resolver()
        first = resolver.lookup("http://example.com/")
        assert first.contents == root.contents

        with pytest.raises(exceptions.Unresolvable):
            first.resolver.lookup("grandchild")

        second = first.resolver.lookup("#/children/0")
        third = second.resolver.lookup("grandchild")
        assert third.contents == {"ID": "grandchild"}

    def test_dynamic_scope(self):
        one = ID_AND_CHILDREN.create_resource(
            {
                "ID": "http://example.com/",
                "children": [
                    {
                        "ID": "child/",
                        "children": [{"ID": "grandchild"}],
                    },
                ],
            },
        )
        two = ID_AND_CHILDREN.create_resource(
            {
                "ID": "http://example.com/two",
                "children": [{"ID": "two-child/"}],
            },
        )
        registry = [one, two] @ Registry()

        resolver = registry.resolver()
        first = resolver.lookup("http://example.com/")
        second = first.resolver.lookup("#/children/0")
        third = second.resolver.lookup("grandchild")
        fourth = third.resolver.lookup("http://example.com/two")
        assert list(fourth.resolver.dynamic_scope()) == [
            ("http://example.com/child/grandchild", fourth.resolver._registry),
            ("http://example.com/child/", fourth.resolver._registry),
            ("http://example.com/", fourth.resolver._registry),
        ]
        assert list(third.resolver.dynamic_scope()) == [
            ("http://example.com/child/", third.resolver._registry),
            ("http://example.com/", third.resolver._registry),
        ]
        assert list(second.resolver.dynamic_scope()) == [
            ("http://example.com/", second.resolver._registry),
        ]
        assert list(first.resolver.dynamic_scope()) == []


class TestSpecification:
    def test_create_resource(self):
        specification = Specification(
            name="",
            id_of=lambda contents: "urn:fixedID",
            subresources_of=lambda contents: [],
            anchors_in=lambda specification, contents: [],
            maybe_in_subresource=(
                lambda segments, resolver, subresource: resolver
            ),
        )
        resource = specification.create_resource(contents={"foo": "baz"})
        assert resource == Resource(
            contents={"foo": "baz"},
            specification=specification,
        )
        assert resource.id() == "urn:fixedID"

    def test_detect_from_json_schema(self):
        schema = {"$schema": "https://json-schema.org/draft/2020-12/schema"}
        specification = Specification.detect(schema)
        assert specification == DRAFT202012

    def test_detect_with_no_discernible_information(self):
        with pytest.raises(exceptions.CannotDetermineSpecification):
            Specification.detect({"foo": "bar"})

    def test_detect_with_non_URI_schema(self):
        with pytest.raises(exceptions.CannotDetermineSpecification):
            Specification.detect({"$schema": 37})

    def test_detect_with_no_discernible_information_and_default(self):
        specification = Specification.OPAQUE.detect({"foo": "bar"})
        assert specification is Specification.OPAQUE

    def test_detect_unneeded_default(self):
        schema = {"$schema": "https://json-schema.org/draft/2020-12/schema"}
        specification = Specification.OPAQUE.detect(schema)
        assert specification == DRAFT202012

    def test_non_mapping_detect(self):
        with pytest.raises(exceptions.CannotDetermineSpecification):
            Specification.detect(True)

    def test_non_mapping_detect_with_default(self):
        specification = ID_AND_CHILDREN.detect(True)
        assert specification is ID_AND_CHILDREN

    def test_detect_with_fallback(self):
        specification = Specification.OPAQUE.detect({"foo": "bar"})
        assert specification is Specification.OPAQUE

    def test_repr(self):
        assert (
            repr(ID_AND_CHILDREN) == "<Specification name='id-and-children'>"
        )


class TestOpaqueSpecification:
    THINGS = [{"foo": "bar"}, True, 37, "foo", object()]

    @pytest.mark.parametrize("thing", THINGS)
    def test_no_id(self, thing):
        """
        An arbitrary thing has no ID.
        """

        assert Specification.OPAQUE.id_of(thing) is None

    @pytest.mark.parametrize("thing", THINGS)
    def test_no_subresources(self, thing):
        """
        An arbitrary thing has no subresources.
        """

        assert list(Specification.OPAQUE.subresources_of(thing)) == []

    @pytest.mark.parametrize("thing", THINGS)
    def test_no_anchors(self, thing):
        """
        An arbitrary thing has no anchors.
        """

        assert list(Specification.OPAQUE.anchors_in(thing)) == []


@pytest.mark.parametrize(
    "cls",
    [Anchor, Registry, Resource, Specification, exceptions.PointerToNowhere],
)
def test_nonsubclassable(cls):
    with pytest.raises(Exception, match="(?i)subclassing"):

        class Boom(cls):  # pragma: no cover
            pass
