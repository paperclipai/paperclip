"""
Aggregation functions
"""

from __future__ import annotations

from decimal import Decimal
from typing import (
    Any,
    Callable,
    Dict,
    Iterable,
    List,
    Mapping,
    MutableMapping,
    Optional,
    Set,
    Tuple,
    TypeVar,
    Union,
    overload,
)

from rdflib.namespace import XSD
from rdflib.plugins.sparql.datatypes import type_promotion
from rdflib.plugins.sparql.evalutils import _eval, _val
from rdflib.plugins.sparql.operators import numeric
from rdflib.plugins.sparql.parserutils import CompValue
from rdflib.plugins.sparql.sparql import FrozenBindings, NotBoundError, SPARQLTypeError
from rdflib.term import BNode, Identifier, Literal, URIRef, Variable


class Accumulator:
    """abstract base class for different aggregation functions"""

    def __init__(self, aggregation: CompValue):
        self.get_value: Callable[[], Optional[Literal]]
        self.update: Callable[[FrozenBindings, Aggregator], None]
        self.var = aggregation.res
        self.expr = aggregation.vars
        if not aggregation.distinct:
            # type error: Cannot assign to a method
            self.use_row = self.dont_care  # type: ignore[method-assign]
            self.distinct = False
        else:
            self.distinct = aggregation.distinct
            self.seen: Set[Any] = set()

    def dont_care(self, row: FrozenBindings) -> bool:
        """skips distinct test"""
        return True

    def use_row(self, row: FrozenBindings) -> bool:
        """tests distinct with set"""
        return _eval(self.expr, row) not in self.seen

    def set_value(self, bindings: MutableMapping[Variable, Identifier]) -> None:
        """sets final value in bindings"""
        # type error: Incompatible types in assignment (expression has type "Optional[Literal]", target has type "Identifier")
        bindings[self.var] = self.get_value()  # type: ignore[assignment]


class Counter(Accumulator):
    def __init__(self, aggregation: CompValue):
        super(Counter, self).__init__(aggregation)
        self.value = 0
        if self.expr == "*":
            # cannot eval "*" => always use the full row
            # type error: Cannot assign to a method
            self.eval_row = self.eval_full_row  # type: ignore[assignment]

    def update(self, row: FrozenBindings, aggregator: Aggregator) -> None:
        try:
            val = self.eval_row(row)
        except NotBoundError:
            # skip UNDEF
            return
        self.value += 1
        if self.distinct:
            self.seen.add(val)

    def get_value(self) -> Literal:
        return Literal(self.value)

    def eval_row(self, row: FrozenBindings) -> Identifier:
        return _eval(self.expr, row)

    def eval_full_row(self, row: FrozenBindings) -> FrozenBindings:
        return row

    def use_row(self, row: FrozenBindings) -> bool:
        try:
            return self.eval_row(row) not in self.seen
        except NotBoundError:
            # happens when counting zero optional nodes. See issue #2229
            return False


@overload
def type_safe_numbers(*args: int) -> Tuple[int]: ...


@overload
def type_safe_numbers(
    *args: Union[Decimal, float, int]
) -> Tuple[Union[float, int]]: ...


def type_safe_numbers(*args: Union[Decimal, float, int]) -> Iterable[Union[float, int]]:
    if any(isinstance(arg, float) for arg in args) and any(
        isinstance(arg, Decimal) for arg in args
    ):
        return map(float, args)
    # type error: Incompatible return value type (got "Tuple[Union[Decimal, float, int], ...]", expected "Iterable[Union[float, int]]")
    # NOTE on type error: if args contains a Decimal it will nopt get here.
    return args  # type: ignore[return-value]


class Sum(Accumulator):
    def __init__(self, aggregation: CompValue):
        super(Sum, self).__init__(aggregation)
        self.value = 0
        self.datatype: Optional[str] = None

    def update(self, row: FrozenBindings, aggregator: Aggregator) -> None:
        try:
            value = _eval(self.expr, row)
            dt = self.datatype
            if dt is None:
                dt = value.datatype
            else:
                # type error: Argument 1 to "type_promotion" has incompatible type "str"; expected "URIRef"
                dt = type_promotion(dt, value.datatype)  # type: ignore[arg-type]
            self.datatype = dt
            self.value = sum(type_safe_numbers(self.value, numeric(value)))
            if self.distinct:
                self.seen.add(value)
        except NotBoundError:
            # skip UNDEF
            pass

    def get_value(self) -> Literal:
        return Literal(self.value, datatype=self.datatype)


class Average(Accumulator):
    def __init__(self, aggregation: CompValue):
        super(Average, self).__init__(aggregation)
        self.counter = 0
        self.sum = 0
        self.datatype: Optional[str] = None

    def update(self, row: FrozenBindings, aggregator: Aggregator) -> None:
        try:
            value = _eval(self.expr, row)
            dt = self.datatype
            self.sum = sum(type_safe_numbers(self.sum, numeric(value)))
            if dt is None:
                dt = value.datatype
            else:
                # type error: Argument 1 to "type_promotion" has incompatible type "str"; expected "URIRef"
                dt = type_promotion(dt, value.datatype)  # type: ignore[arg-type]
            self.datatype = dt
            if self.distinct:
                self.seen.add(value)
            self.counter += 1
        # skip UNDEF or BNode => SPARQLTypeError
        except NotBoundError:
            pass
        except SPARQLTypeError:
            pass

    def get_value(self) -> Literal:
        if self.counter == 0:
            return Literal(0)
        if self.datatype in (XSD.float, XSD.double):
            return Literal(self.sum / self.counter)
        else:
            return Literal(Decimal(self.sum) / Decimal(self.counter))


class Extremum(Accumulator):
    """abstract base class for Minimum and Maximum"""

    def __init__(self, aggregation: CompValue):
        self.compare: Callable[[Any, Any], Any]
        super(Extremum, self).__init__(aggregation)
        self.value: Any = None
        # DISTINCT would not change the value for MIN or MAX
        # type error: Cannot assign to a method
        self.use_row = self.dont_care  # type: ignore[method-assign]

    def set_value(self, bindings: MutableMapping[Variable, Identifier]) -> None:
        if self.value is not None:
            # simply do not set if self.value is still None
            bindings[self.var] = Literal(self.value)

    def update(self, row: FrozenBindings, aggregator: Aggregator) -> None:
        try:
            if self.value is None:
                self.value = _eval(self.expr, row)
            else:
                # self.compare is implemented by Minimum/Maximum
                self.value = self.compare(self.value, _eval(self.expr, row))
        # skip UNDEF or BNode => SPARQLTypeError
        except NotBoundError:
            pass
        except SPARQLTypeError:
            pass


_ValueT = TypeVar("_ValueT", Variable, BNode, URIRef, Literal)


class Minimum(Extremum):
    def compare(self, val1: _ValueT, val2: _ValueT) -> _ValueT:
        return min(val1, val2, key=_val)


class Maximum(Extremum):
    def compare(self, val1: _ValueT, val2: _ValueT) -> _ValueT:
        return max(val1, val2, key=_val)


class Sample(Accumulator):
    """takes the first eligible value"""

    def __init__(self, aggregation):
        super(Sample, self).__init__(aggregation)
        # DISTINCT would not change the value
        # type error: Cannot assign to a method
        self.use_row = self.dont_care  # type: ignore[method-assign]

    def update(self, row: FrozenBindings, aggregator: Aggregator) -> None:
        try:
            # set the value now
            aggregator.bindings[self.var] = _eval(self.expr, row)
            # and skip this accumulator for future rows
            del aggregator.accumulators[self.var]
        except NotBoundError:
            pass

    def get_value(self) -> None:
        # set None if no value was set
        return None


class GroupConcat(Accumulator):
    value: List[Literal]

    def __init__(self, aggregation: CompValue):
        super(GroupConcat, self).__init__(aggregation)
        # only GROUPCONCAT needs to have a list as accumulator
        self.value = []
        if aggregation.separator is None:
            self.separator = " "
        else:
            self.separator = aggregation.separator

    def update(self, row: FrozenBindings, aggregator: Aggregator) -> None:
        try:
            value = _eval(self.expr, row)
            # skip UNDEF
            if isinstance(value, NotBoundError):
                return
            self.value.append(value)
            if self.distinct:
                self.seen.add(value)
        # skip UNDEF
        # NOTE: It seems like this is not the way undefined values occur, they
        # come through not as exceptions but as values. This is left here
        # however as it may occur in some cases.
        # TODO: Consider removing this.
        except NotBoundError:
            pass

    def get_value(self) -> Literal:
        return Literal(self.separator.join(str(v) for v in self.value))


class Aggregator:
    """combines different Accumulator objects"""

    accumulator_classes = {
        "Aggregate_Count": Counter,
        "Aggregate_Sample": Sample,
        "Aggregate_Sum": Sum,
        "Aggregate_Avg": Average,
        "Aggregate_Min": Minimum,
        "Aggregate_Max": Maximum,
        "Aggregate_GroupConcat": GroupConcat,
    }

    def __init__(self, aggregations: List[CompValue]):
        self.bindings: Dict[Variable, Identifier] = {}
        self.accumulators: Dict[str, Accumulator] = {}
        for a in aggregations:
            accumulator_class = self.accumulator_classes.get(a.name)
            if accumulator_class is None:
                raise Exception("Unknown aggregate function " + a.name)
            self.accumulators[a.res] = accumulator_class(a)

    def update(self, row: FrozenBindings) -> None:
        """update all own accumulators"""
        # SAMPLE accumulators may delete themselves
        # => iterate over list not generator

        for acc in list(self.accumulators.values()):
            if acc.use_row(row):
                acc.update(row, self)

    def get_bindings(self) -> Mapping[Variable, Identifier]:
        """calculate and set last values"""
        for acc in self.accumulators.values():
            acc.set_value(self.bindings)
        return self.bindings
