"""
Utility functions for supporting the XML Schema Datatypes hierarchy
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Dict, List, Optional, Set

from rdflib.namespace import XSD

if TYPE_CHECKING:
    from rdflib.term import URIRef


XSD_DTs: Set[URIRef] = set(
    (
        XSD.integer,
        XSD.decimal,
        XSD.float,
        XSD.double,
        XSD.string,
        XSD.boolean,
        XSD.dateTime,
        XSD.nonPositiveInteger,
        XSD.negativeInteger,
        XSD.long,
        XSD.int,
        XSD.short,
        XSD.byte,
        XSD.nonNegativeInteger,
        XSD.unsignedLong,
        XSD.unsignedInt,
        XSD.unsignedShort,
        XSD.unsignedByte,
        XSD.positiveInteger,
        XSD.date,
    )
)

# adding dateTime datatypes

XSD_DateTime_DTs = set((XSD.dateTime, XSD.date, XSD.time))

XSD_Duration_DTs = set((XSD.duration, XSD.dayTimeDuration, XSD.yearMonthDuration))

_sub_types: Dict[URIRef, List[URIRef]] = {
    XSD.integer: [
        XSD.nonPositiveInteger,
        XSD.negativeInteger,
        XSD.long,
        XSD.int,
        XSD.short,
        XSD.byte,
        XSD.nonNegativeInteger,
        XSD.positiveInteger,
        XSD.unsignedLong,
        XSD.unsignedInt,
        XSD.unsignedShort,
        XSD.unsignedByte,
    ],
}

_super_types: Dict[URIRef, URIRef] = {}
for superdt in XSD_DTs:
    for subdt in _sub_types.get(superdt, []):
        _super_types[subdt] = superdt

# we only care about float, double, integer, decimal
_typePromotionMap: Dict[URIRef, Dict[URIRef, URIRef]] = {
    XSD.float: {XSD.integer: XSD.float, XSD.decimal: XSD.float, XSD.double: XSD.double},
    XSD.double: {
        XSD.integer: XSD.double,
        XSD.float: XSD.double,
        XSD.decimal: XSD.double,
    },
    XSD.decimal: {
        XSD.integer: XSD.decimal,
        XSD.float: XSD.float,
        XSD.double: XSD.double,
    },
    XSD.integer: {
        XSD.decimal: XSD.decimal,
        XSD.float: XSD.float,
        XSD.double: XSD.double,
    },
}


def type_promotion(t1: URIRef, t2: Optional[URIRef]) -> URIRef:
    if t2 is None:
        return t1
    t1 = _super_types.get(t1, t1)
    t2 = _super_types.get(t2, t2)
    if t1 == t2:
        return t1  # matching super-types
    try:
        if TYPE_CHECKING:
            # type assert because mypy is confused and thinks t2 can be None
            assert t2 is not None
        return _typePromotionMap[t1][t2]
    except KeyError:
        raise TypeError("Operators cannot combine datatypes %s and %s" % (t1, t2))
