import itertools

import pytest

from referencing import Resource, exceptions


def pairs(choices):
    return itertools.combinations(choices, 2)


TRUE = Resource.opaque(True)


thunks = (
    lambda: exceptions.CannotDetermineSpecification(TRUE),
    lambda: exceptions.NoSuchResource("urn:example:foo"),
    lambda: exceptions.NoInternalID(TRUE),
    lambda: exceptions.InvalidAnchor(resource=TRUE, anchor="foo", ref="a#b"),
    lambda: exceptions.NoSuchAnchor(resource=TRUE, anchor="foo", ref="a#b"),
    lambda: exceptions.PointerToNowhere(resource=TRUE, ref="urn:example:foo"),
    lambda: exceptions.Unresolvable("urn:example:foo"),
    lambda: exceptions.Unretrievable("urn:example:foo"),
)


@pytest.mark.parametrize("one, two", pairs(each() for each in thunks))
def test_eq_incompatible_types(one, two):
    assert one != two


@pytest.mark.parametrize("thunk", thunks)
def test_hash(thunk):
    assert thunk() in {thunk()}
