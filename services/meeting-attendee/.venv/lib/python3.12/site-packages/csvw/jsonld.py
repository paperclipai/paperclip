import re
import json
import math
import typing
import decimal
import pathlib
import datetime
import collections

import attr
from rdflib import Graph, URIRef, Literal
from rfc3986 import URIReference
from isodate.duration import Duration

from .utils import is_url

__all__ = ['group_triples', 'to_json', 'Triple', 'format_value']


def format_value(value, col):
    """
    Format values as JSON-LD literals.
    """
    if isinstance(value, (datetime.date, datetime.datetime, datetime.time)):
        res = value.isoformat()
        if col and col.datatype.base == 'time':
            res = res.split('T')[-1]
        if col and col.datatype.base == 'date':
            res = re.sub('T[0-9.:]+', '', res)
        if isinstance(value, (datetime.datetime, datetime.time)):
            stamp, _, milliseconds = res.partition('.')
            return '{}.{}'.format(stamp, milliseconds.rstrip('0')) if milliseconds \
                else stamp.replace('+00:00', 'Z')
        return res  # pragma: no cover
    if isinstance(value, datetime.timedelta):
        return col.datatype.formatted(value)
    if isinstance(value, Duration):
        return col.datatype.formatted(value)
    if isinstance(value, decimal.Decimal):
        value = float(value)
    if isinstance(value, URIReference):
        return value.unsplit()
    if isinstance(value, bytes):
        return col.datatype.formatted(value)
    if isinstance(value, pathlib.Path):
        return str(value)
    if isinstance(value, float):
        return 'NaN' if math.isnan(value) else (
            '{}INF'.format('-' if value < 0 else '') if math.isinf(value) else value)
    return value


@attr.s
class Triple:
    """
    A table cell's data as RDF triple.
    """
    about = attr.ib()
    property = attr.ib()
    value = attr.ib()

    def as_rdflib_triple(self):
        return (
            URIRef(self.about),
            URIRef(self.property),
            URIRef(self.value) if is_url(self.value) else Literal(self.value))

    @classmethod
    def from_col(cls, table, col, row, prop, val, rownum):
        """

        """
        _name = col.header if col else None

        propertyUrl = col.propertyUrl if col else table.inherit('propertyUrl')
        if propertyUrl:
            prop = table.expand(propertyUrl, row, _row=rownum, _name=_name, qname=True)

        is_type = prop == 'rdf:type'
        valueUrl = col.valueUrl if col else table.inherit('valueUrl')
        if valueUrl:
            val = table.expand(valueUrl, row, _row=rownum, _name=_name, qname=is_type)
        val = format_value(val, col)
        s = None
        aboutUrl = col.aboutUrl if col else None
        if aboutUrl:
            s = table.expand(aboutUrl, row, _row=rownum, _name=_name) or s
        return cls(about=s, property=prop, value=val)


def frame(data: list) -> list:
    """
    Inline referenced items to force a deterministic graph layout.

    .. see:: https://w3c.github.io/json-ld-framing/#introduction
    """
    items, refs = collections.OrderedDict(), {}
    for item in data:
        itemid = item.get('@id')
        if itemid:
            items[itemid] = item
        for vs in item.values():
            for v in [vs] if not isinstance(vs, list) else vs:
                if isinstance(v, dict):
                    refid = v.get('@id')
                    if refid:
                        refs.setdefault(refid, (v, []))[1].append(item)
    for ref, subjects in refs.values():
        if len(subjects) == 1 and ref['@id'] in items:
            ref.update(items.pop(ref['@id']))
    return list(items.values())


def to_json(obj, flatten_list=False):
    """
    Simplify JSON-LD data by refactoring trivial objects.
    """
    if isinstance(obj, dict):
        if '@value' in obj:
            obj = obj['@value']
        if len(obj) == 1 and '@id' in obj:
            obj = obj['@id']
    if isinstance(obj, dict):
        return {
            '@type' if k == 'rdf:type' else k: to_json(v, flatten_list=flatten_list)
            for k, v in obj.items()}
    if isinstance(obj, list):
        if len(obj) == 1 and flatten_list:
            return to_json(obj[0], flatten_list=flatten_list)
        return [to_json(v, flatten_list=flatten_list) for v in obj]
    return obj


def group_triples(triples: typing.Iterable[Triple]) -> typing.List[dict]:
    """
    Group and frame triples into a `list` of JSON objects.
    """
    merged = []
    for triple in triples:
        if isinstance(triple.value, list):
            for t in merged:
                if t.property == triple.property and isinstance(t.value, list):
                    t.value.extend(triple.value)
                    break
            else:
                merged.append(triple)
        else:
            merged.append(triple)

    grouped = collections.OrderedDict()
    triples = []
    # First pass: get top-level properties.
    for triple in merged:
        if triple.about is None and triple.property == '@id':
            grouped[triple.property] = triple.value
        else:
            if not triple.about:
                # For test48
                if triple.property in grouped:
                    if not isinstance(grouped[triple.property], list):
                        grouped[triple.property] = [grouped[triple.property]]
                    grouped[triple.property].append(triple.value)
                else:
                    grouped[triple.property] = triple.value
            else:
                triples.append(triple)
    if not triples:
        return [grouped]

    g = Graph()
    for triple in triples:
        g.add(triple.as_rdflib_triple())
    if '@id' in grouped:
        for prop, val in grouped.items():
            if prop != '@id':
                g.add(Triple(about=grouped['@id'], property=prop, value=val).as_rdflib_triple())
    res = g.serialize(format='json-ld')
    # Frame and simplify the resulting objects, augment with list index:
    res = [(i, to_json(v, flatten_list=True)) for i, v in enumerate(frame(json.loads(res)))]
    # Sort the objects making sure the one with the row's aboutUrl as @id comes first:
    res = [k[1] for k in sorted(
        res, key=lambda o: -1 if o[1].get('@id') == grouped.get('@id') else o[0])]
    # If there's no aboutUrl for the row and we have only one object from triples, we just merge
    # the properties into a single object.
    if grouped and ('@id' not in grouped) and len(res) == 1:
        grouped.update(res[0])
        return [grouped]

    return res
