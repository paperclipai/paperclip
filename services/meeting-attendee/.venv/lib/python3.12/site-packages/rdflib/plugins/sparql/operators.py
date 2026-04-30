"""
This contains evaluation functions for expressions

They get bound as instances-methods to the CompValue objects from parserutils
using setEvalFn
"""

from __future__ import annotations

import datetime as py_datetime  # naming conflict with function within this module
import hashlib
import math
import operator as pyop  # python operators
import random
import re
import uuid
import warnings
from decimal import ROUND_HALF_DOWN, ROUND_HALF_UP, Decimal, InvalidOperation
from functools import reduce
from typing import Any, Callable, Dict, NoReturn, Optional, Tuple, Union, overload
from urllib.parse import quote

from pyparsing import ParseResults

from rdflib.namespace import RDF, XSD
from rdflib.plugins.sparql.datatypes import (
    XSD_DateTime_DTs,
    XSD_DTs,
    XSD_Duration_DTs,
    type_promotion,
)
from rdflib.plugins.sparql.parserutils import CompValue, Expr
from rdflib.plugins.sparql.sparql import (
    FrozenBindings,
    QueryContext,
    SPARQLError,
    SPARQLTypeError,
)
from rdflib.term import (
    BNode,
    IdentifiedNode,
    Identifier,
    Literal,
    Node,
    URIRef,
    Variable,
)
from rdflib.xsd_datetime import Duration, parse_datetime  # type: ignore[attr-defined]


def Builtin_IRI(expr: Expr, ctx: FrozenBindings) -> URIRef:
    """
    http://www.w3.org/TR/sparql11-query/#func-iri
    """

    a = expr.arg

    if isinstance(a, URIRef):
        return a
    if isinstance(a, Literal):
        # type error: Item "None" of "Optional[Prologue]" has no attribute "absolutize"
        # type error: Incompatible return value type (got "Union[CompValue, str, None, Any]", expected "URIRef")
        return ctx.prologue.absolutize(URIRef(a))  # type: ignore[union-attr,return-value]

    raise SPARQLError("IRI function only accepts URIRefs or Literals/Strings!")


def Builtin_isBLANK(expr: Expr, ctx: FrozenBindings) -> Literal:
    return Literal(isinstance(expr.arg, BNode))


def Builtin_isLITERAL(expr, ctx) -> Literal:
    return Literal(isinstance(expr.arg, Literal))


def Builtin_isIRI(expr, ctx) -> Literal:
    return Literal(isinstance(expr.arg, URIRef))


def Builtin_isNUMERIC(expr, ctx) -> Literal:
    try:
        numeric(expr.arg)
        return Literal(True)
    except:  # noqa: E722
        return Literal(False)


def Builtin_BNODE(expr, ctx) -> BNode:
    """
    http://www.w3.org/TR/sparql11-query/#func-bnode
    """

    a = expr.arg

    if a is None:
        return BNode()

    if isinstance(a, Literal):
        return ctx.bnodes[a]  # defaultdict does the right thing

    raise SPARQLError("BNode function only accepts no argument or literal/string")


def Builtin_ABS(expr: Expr, ctx) -> Literal:
    """
    http://www.w3.org/TR/sparql11-query/#func-abs
    """

    return Literal(abs(numeric(expr.arg)))


def Builtin_IF(expr: Expr, ctx):
    """
    http://www.w3.org/TR/sparql11-query/#func-if
    """

    return expr.arg2 if EBV(expr.arg1) else expr.arg3


def Builtin_RAND(expr: Expr, ctx) -> Literal:
    """
    http://www.w3.org/TR/sparql11-query/#idp2133952
    """

    return Literal(random.random())


def Builtin_UUID(expr: Expr, ctx) -> URIRef:
    """
    http://www.w3.org/TR/sparql11-query/#func-strdt
    """

    return URIRef(uuid.uuid4().urn)


def Builtin_STRUUID(expr, ctx) -> Literal:
    """
    http://www.w3.org/TR/sparql11-query/#func-strdt
    """

    return Literal(str(uuid.uuid4()))


def Builtin_MD5(expr: Expr, ctx) -> Literal:
    s = string(expr.arg).encode("utf-8")
    return Literal(hashlib.md5(s).hexdigest())


def Builtin_SHA1(expr: Expr, ctx) -> Literal:
    s = string(expr.arg).encode("utf-8")
    return Literal(hashlib.sha1(s).hexdigest())


def Builtin_SHA256(expr: Expr, ctx) -> Literal:
    s = string(expr.arg).encode("utf-8")
    return Literal(hashlib.sha256(s).hexdigest())


def Builtin_SHA384(expr: Expr, ctx) -> Literal:
    s = string(expr.arg).encode("utf-8")
    return Literal(hashlib.sha384(s).hexdigest())


def Builtin_SHA512(expr: Expr, ctx) -> Literal:
    s = string(expr.arg).encode("utf-8")
    return Literal(hashlib.sha512(s).hexdigest())


def Builtin_COALESCE(expr: Expr, ctx):
    """
    http://www.w3.org/TR/sparql11-query/#func-coalesce
    """
    for x in expr.get("arg", variables=True):
        if x is not None and not isinstance(x, (SPARQLError, Variable)):
            return x
    raise SPARQLError("COALESCE got no arguments that did not evaluate to an error")


def Builtin_CEIL(expr: Expr, ctx) -> Literal:
    """
    http://www.w3.org/TR/sparql11-query/#func-ceil
    """

    l_ = expr.arg
    return Literal(int(math.ceil(numeric(l_))), datatype=l_.datatype)


def Builtin_FLOOR(expr: Expr, ctx) -> Literal:
    """
    http://www.w3.org/TR/sparql11-query/#func-floor
    """
    l_ = expr.arg
    return Literal(int(math.floor(numeric(l_))), datatype=l_.datatype)


def Builtin_ROUND(expr: Expr, ctx) -> Literal:
    """
    http://www.w3.org/TR/sparql11-query/#func-round
    """

    # This used to be just math.bound
    # but in py3k bound was changed to
    # "round-to-even" behaviour
    # this is an ugly work-around
    l_ = expr.arg
    v = numeric(l_)
    v = int(Decimal(v).quantize(1, ROUND_HALF_UP if v > 0 else ROUND_HALF_DOWN))
    return Literal(v, datatype=l_.datatype)


def Builtin_REGEX(expr: Expr, ctx) -> Literal:
    """
    http://www.w3.org/TR/sparql11-query/#func-regex
    Invokes the XPath fn:matches function to match text against a regular
    expression pattern.
    The regular expression language is defined in XQuery 1.0 and XPath 2.0
    Functions and Operators section 7.6.1 Regular Expression Syntax
    """

    text = string(expr.text)
    pattern = string(expr.pattern)
    flags = expr.flags

    cFlag = 0
    if flags:
        # Maps XPath REGEX flags (http://www.w3.org/TR/xpath-functions/#flags)
        # to Python's re flags
        flagMap = dict([("i", re.IGNORECASE), ("s", re.DOTALL), ("m", re.MULTILINE)])
        cFlag = reduce(pyop.or_, [flagMap.get(f, 0) for f in flags])

    return Literal(bool(re.search(str(pattern), text, cFlag)))


def Builtin_REPLACE(expr: Expr, ctx) -> Literal:
    """
    http://www.w3.org/TR/sparql11-query/#func-substr
    """
    text = string(expr.arg)
    pattern = string(expr.pattern)
    replacement = string(expr.replacement)
    flags = expr.flags

    # python uses \1, xpath/sparql uses $1
    # type error: Incompatible types in assignment (expression has type "str", variable has type "Literal")
    replacement = re.sub("\\$([0-9]*)", r"\\\1", replacement)  # type: ignore[assignment]

    cFlag = 0
    if flags:
        # Maps XPath REGEX flags (http://www.w3.org/TR/xpath-functions/#flags)
        # to Python's re flags
        flagMap = dict([("i", re.IGNORECASE), ("s", re.DOTALL), ("m", re.MULTILINE)])
        cFlag = reduce(pyop.or_, [flagMap.get(f, 0) for f in flags])

        # @@FIXME@@ either datatype OR lang, NOT both

    return Literal(
        re.sub(str(pattern), replacement, text, cFlag),
        datatype=text.datatype,
        lang=text.language,
    )


def Builtin_STRDT(expr: Expr, ctx) -> Literal:
    """
    http://www.w3.org/TR/sparql11-query/#func-strdt
    """

    return Literal(str(expr.arg1), datatype=expr.arg2)


def Builtin_STRLANG(expr: Expr, ctx) -> Literal:
    """
    http://www.w3.org/TR/sparql11-query/#func-strlang
    """

    s = string(expr.arg1)
    if s.language or s.datatype:
        raise SPARQLError("STRLANG expects a simple literal")

    # TODO: normalisation of lang tag to lower-case
    # should probably happen in literal __init__
    return Literal(str(s), lang=str(expr.arg2).lower())


def Builtin_CONCAT(expr: Expr, ctx) -> Literal:
    """
    http://www.w3.org/TR/sparql11-query/#func-concat
    """

    # dt/lang passed on only if they all match

    dt = set(x.datatype for x in expr.arg if isinstance(x, Literal))
    # type error: Incompatible types in assignment (expression has type "Optional[str]", variable has type "Set[Optional[str]]")
    dt = dt.pop() if len(dt) == 1 else None  # type: ignore[assignment]

    lang = set(x.language for x in expr.arg if isinstance(x, Literal))
    # type error: error: Incompatible types in assignment (expression has type "Optional[str]", variable has type "Set[Optional[str]]")
    lang = lang.pop() if len(lang) == 1 else None  # type: ignore[assignment]

    # NOTE on type errors: this is because same variable is used for two incompatibel types
    # type error: Argument "datatype" to "Literal" has incompatible type "Set[Any]"; expected "Optional[str]"  [arg-type]
    # type error: Argument "lang" to "Literal" has incompatible type "Set[Any]"; expected "Optional[str]"
    return Literal("".join(string(x) for x in expr.arg), datatype=dt, lang=lang)  # type: ignore[arg-type]


def _compatibleStrings(a: Literal, b: Literal) -> None:
    string(a)
    string(b)

    if b.language and a.language != b.language:
        raise SPARQLError("incompatible arguments to str functions")


def Builtin_STRSTARTS(expr: Expr, ctx) -> Literal:
    """
    http://www.w3.org/TR/sparql11-query/#func-strstarts
    """

    a = expr.arg1
    b = expr.arg2
    _compatibleStrings(a, b)

    return Literal(a.startswith(b))


def Builtin_STRENDS(expr: Expr, ctx) -> Literal:
    """
    http://www.w3.org/TR/sparql11-query/#func-strends
    """
    a = expr.arg1
    b = expr.arg2

    _compatibleStrings(a, b)

    return Literal(a.endswith(b))


def Builtin_STRBEFORE(expr: Expr, ctx) -> Literal:
    """
    http://www.w3.org/TR/sparql11-query/#func-strbefore
    """

    a = expr.arg1
    b = expr.arg2
    _compatibleStrings(a, b)

    i = a.find(b)
    if i == -1:
        return Literal("")
    else:
        return Literal(a[:i], lang=a.language, datatype=a.datatype)


def Builtin_STRAFTER(expr: Expr, ctx) -> Literal:
    """
    http://www.w3.org/TR/sparql11-query/#func-strafter
    """

    a = expr.arg1
    b = expr.arg2
    _compatibleStrings(a, b)

    i = a.find(b)
    if i == -1:
        return Literal("")
    else:
        return Literal(a[i + len(b) :], lang=a.language, datatype=a.datatype)


def Builtin_CONTAINS(expr: Expr, ctx) -> Literal:
    """
    http://www.w3.org/TR/sparql11-query/#func-strcontains
    """

    a = expr.arg1
    b = expr.arg2
    _compatibleStrings(a, b)

    return Literal(b in a)


def Builtin_ENCODE_FOR_URI(expr: Expr, ctx) -> Literal:
    return Literal(quote(string(expr.arg).encode("utf-8"), safe=""))


def Builtin_SUBSTR(expr: Expr, ctx) -> Literal:
    """
    http://www.w3.org/TR/sparql11-query/#func-substr
    """

    a = string(expr.arg)

    start = numeric(expr.start) - 1

    length = expr.length
    if length is not None:
        length = numeric(length) + start

    return Literal(a[start:length], lang=a.language, datatype=a.datatype)


def Builtin_STRLEN(e: Expr, ctx) -> Literal:
    l_ = string(e.arg)

    return Literal(len(l_))


def Builtin_STR(e: Expr, ctx) -> Literal:
    arg = e.arg
    if isinstance(arg, SPARQLError):
        raise arg
    return Literal(str(arg))  # plain literal


def Builtin_LCASE(e: Expr, ctx) -> Literal:
    l_ = string(e.arg)

    return Literal(l_.lower(), datatype=l_.datatype, lang=l_.language)


def Builtin_LANGMATCHES(e: Expr, ctx) -> Literal:
    """
    http://www.w3.org/TR/sparql11-query/#func-langMatches


    """
    langTag = string(e.arg1)
    langRange = string(e.arg2)

    if str(langTag) == "":
        return Literal(False)  # nothing matches empty!

    return Literal(_lang_range_check(langRange, langTag))


def Builtin_NOW(e: Expr, ctx) -> Literal:
    """
    http://www.w3.org/TR/sparql11-query/#func-now
    """
    return Literal(ctx.now)


def Builtin_YEAR(e: Expr, ctx) -> Literal:
    d = date(e.arg)
    return Literal(d.year)


def Builtin_MONTH(e: Expr, ctx) -> Literal:
    d = date(e.arg)
    return Literal(d.month)


def Builtin_DAY(e: Expr, ctx) -> Literal:
    d = date(e.arg)
    return Literal(d.day)


def Builtin_HOURS(e: Expr, ctx) -> Literal:
    d = datetime(e.arg)
    return Literal(d.hour)


def Builtin_MINUTES(e: Expr, ctx) -> Literal:
    d = datetime(e.arg)
    return Literal(d.minute)


def Builtin_SECONDS(e: Expr, ctx) -> Literal:
    """
    http://www.w3.org/TR/sparql11-query/#func-seconds
    """
    d = datetime(e.arg)
    result_value = Decimal(d.second)
    if d.microsecond:
        result_value += Decimal(d.microsecond) / Decimal(1000000)
    return Literal(result_value, datatype=XSD.decimal)


def Builtin_TIMEZONE(e: Expr, ctx) -> Literal:
    """
    http://www.w3.org/TR/sparql11-query/#func-timezone

    Returns:
        The timezone part of arg as an xsd:dayTimeDuration.

    Raises:
        An error if there is no timezone.
    """
    dt = datetime(e.arg)
    if not dt.tzinfo:
        raise SPARQLError("datatime has no timezone: %r" % dt)

    delta = dt.utcoffset()

    # type error: Item "None" of "Optional[timedelta]" has no attribute "days"
    d = delta.days  # type: ignore[union-attr]
    # type error: Item "None" of "Optional[timedelta]" has no attribute "seconds"
    s = delta.seconds  # type: ignore[union-attr]
    neg = ""

    if d < 0:
        s = -24 * 60 * 60 * d - s
        d = 0
        neg = "-"

    h = s / (60 * 60)
    m = (s - h * 60 * 60) / 60
    s = s - h * 60 * 60 - m * 60

    tzdelta = "%sP%sT%s%s%s" % (
        neg,
        "%dD" % d if d else "",
        "%dH" % h if h else "",
        "%dM" % m if m else "",
        "%dS" % s if not d and not h and not m else "",
    )

    return Literal(tzdelta, datatype=XSD.dayTimeDuration)


def Builtin_TZ(e: Expr, ctx) -> Literal:
    d = datetime(e.arg)
    if not d.tzinfo:
        return Literal("")
    n = d.tzinfo.tzname(d)
    if n is None:
        n = ""
    elif n == "UTC":
        n = "Z"
    elif n.startswith("UTC"):
        # Replace tzname like "UTC-05:00" with simply "-05:00" to match Jena tz fn
        n = n[3:]
    return Literal(n)


def Builtin_UCASE(e: Expr, ctx) -> Literal:
    l_ = string(e.arg)

    return Literal(l_.upper(), datatype=l_.datatype, lang=l_.language)


def Builtin_LANG(e: Expr, ctx) -> Literal:
    """http://www.w3.org/TR/sparql11-query/#func-lang

    Returns the language tag of ltrl, if it has one. It returns "" if ltrl has
    no language tag. Note that the RDF data model does not include literals
    with an empty language tag.
    """

    l_ = literal(e.arg)
    return Literal(l_.language or "")


def Builtin_DATATYPE(e: Expr, ctx) -> Optional[str]:
    l_ = e.arg
    if not isinstance(l_, Literal):
        raise SPARQLError("Can only get datatype of literal: %r" % l_)
    if l_.language:
        return RDF.langString
    if not l_.datatype and not l_.language:
        return XSD.string
    return l_.datatype


def Builtin_sameTerm(e: Expr, ctx) -> Literal:
    a = e.arg1
    b = e.arg2
    return Literal(a == b)


def Builtin_BOUND(e: Expr, ctx) -> Literal:
    """
    http://www.w3.org/TR/sparql11-query/#func-bound
    """
    n = e.get("arg", variables=True)

    return Literal(not isinstance(n, Variable))


def Builtin_EXISTS(e: Expr, ctx: FrozenBindings) -> Literal:
    # damn...
    from rdflib.plugins.sparql.evaluate import evalPart

    exists = e.name == "Builtin_EXISTS"

    # type error: Incompatible types in assignment (expression has type "QueryContext", variable has type "FrozenBindings")
    ctx = ctx.ctx.thaw(ctx)  # type: ignore[assignment] # hmm
    # type error: Argument 1 to "evalPart" has incompatible type "FrozenBindings"; expected "QueryContext"
    for x in evalPart(ctx, e.graph):  # type: ignore[arg-type]
        return Literal(exists)
    return Literal(not exists)


_CustomFunction = Callable[[Expr, FrozenBindings], Node]

_CUSTOM_FUNCTIONS: Dict[URIRef, Tuple[_CustomFunction, bool]] = {}


def register_custom_function(
    uri: URIRef, func: _CustomFunction, override: bool = False, raw: bool = False
) -> None:
    """Register a custom SPARQL function.

    By default, the function will be passed the RDF terms in the argument list.
    If raw is True, the function will be passed an Expression and a Context.

    The function must return an RDF term, or raise a SparqlError.
    """
    if not override and uri in _CUSTOM_FUNCTIONS:
        raise ValueError("A function is already registered as %s" % uri.n3())
    _CUSTOM_FUNCTIONS[uri] = (func, raw)


def custom_function(
    uri: URIRef, override: bool = False, raw: bool = False
) -> Callable[[_CustomFunction], _CustomFunction]:
    """
    Decorator version of :func:`register_custom_function`.
    """

    def decorator(func: _CustomFunction) -> _CustomFunction:
        register_custom_function(uri, func, override=override, raw=raw)
        return func

    return decorator


def unregister_custom_function(
    uri: URIRef, func: Optional[Callable[..., Any]] = None
) -> None:
    """
    The 'func' argument is included for compatibility with existing code.
    A previous implementation checked that the function associated with
    the given uri was actually 'func', but this is not necessary as the
    uri should uniquely identify the function.
    """
    if _CUSTOM_FUNCTIONS.get(uri):
        del _CUSTOM_FUNCTIONS[uri]
    else:
        warnings.warn("This function is not registered as %s" % uri.n3())


def Function(e: Expr, ctx: FrozenBindings) -> Node:
    """
    Custom functions and casts
    """
    pair = _CUSTOM_FUNCTIONS.get(e.iri)
    if pair is None:
        # no such function is registered
        raise SPARQLError("Unknown function %r" % e.iri)
    func, raw = pair
    if raw:
        # function expects expression and context
        return func(e, ctx)
    else:
        # function expects the argument list
        try:
            return func(*e.expr)
        except TypeError as ex:
            # wrong argument number
            raise SPARQLError(*ex.args)


@custom_function(XSD.string, raw=True)
@custom_function(XSD.dateTime, raw=True)
@custom_function(XSD.float, raw=True)
@custom_function(XSD.double, raw=True)
@custom_function(XSD.decimal, raw=True)
@custom_function(XSD.integer, raw=True)
@custom_function(XSD.boolean, raw=True)
def default_cast(e: Expr, ctx: FrozenBindings) -> Literal:  # type: ignore[return]
    if not e.expr:
        raise SPARQLError("Nothing given to cast.")
    if len(e.expr) > 1:
        raise SPARQLError("Cannot cast more than one thing!")

    x = e.expr[0]

    if e.iri == XSD.string:
        if isinstance(x, (URIRef, Literal)):
            return Literal(x, datatype=XSD.string)
        else:
            raise SPARQLError("Cannot cast term %r of type %r" % (x, type(x)))

    if not isinstance(x, Literal):
        raise SPARQLError("Can only cast Literals to non-string data-types")

    if x.datatype and not x.datatype in XSD_DTs:  # noqa: E713
        raise SPARQLError("Cannot cast literal with unknown datatype: %r" % x.datatype)

    if e.iri == XSD.dateTime:
        if x.datatype and x.datatype not in (XSD.dateTime, XSD.string):
            raise SPARQLError("Cannot cast %r to XSD:dateTime" % x.datatype)
        try:
            return Literal(parse_datetime(x), datatype=e.iri)
        except:  # noqa: E722
            raise SPARQLError("Cannot interpret '%r' as datetime" % x)

    if x.datatype == XSD.dateTime:
        raise SPARQLError("Cannot cast XSD.dateTime to %r" % e.iri)

    if e.iri in (XSD.float, XSD.double):
        try:
            return Literal(float(x), datatype=e.iri)
        except:  # noqa: E722
            raise SPARQLError("Cannot interpret '%r' as float" % x)

    elif e.iri == XSD.decimal:
        if "e" in x or "E" in x:  # SPARQL/XSD does not allow exponents in decimals
            raise SPARQLError("Cannot interpret '%r' as decimal" % x)
        try:
            return Literal(Decimal(x), datatype=e.iri)
        except:  # noqa: E722
            raise SPARQLError("Cannot interpret '%r' as decimal" % x)

    elif e.iri == XSD.integer:
        try:
            return Literal(int(x), datatype=XSD.integer)
        except:  # noqa: E722
            raise SPARQLError("Cannot interpret '%r' as int" % x)

    elif e.iri == XSD.boolean:
        # # I would argue that any number is True...
        # try:
        #     return Literal(bool(int(x)), datatype=XSD.boolean)
        # except:
        if x.lower() in ("1", "true"):
            return Literal(True)
        if x.lower() in ("0", "false"):
            return Literal(False)
        raise SPARQLError("Cannot interpret '%r' as bool" % x)


def UnaryNot(expr: Expr, ctx: FrozenBindings) -> Literal:
    return Literal(not EBV(expr.expr))


def UnaryMinus(expr: Expr, ctx: FrozenBindings) -> Literal:
    return Literal(-numeric(expr.expr))


def UnaryPlus(expr: Expr, ctx: FrozenBindings) -> Literal:
    return Literal(+numeric(expr.expr))


def MultiplicativeExpression(
    e: Expr, ctx: Union[QueryContext, FrozenBindings]
) -> Literal:
    expr = e.expr
    other = e.other

    # because of the way the mul-expr production handled operator precedence
    # we sometimes have nothing to do
    if other is None:
        return expr
    try:
        res: Union[Decimal, float]
        res = Decimal(numeric(expr))
        for op, f in zip(e.op, other):
            f = numeric(f)

            if type(f) == float:  # noqa: E721
                res = float(res)

            if op == "*":
                res *= f
            else:
                res /= f
    except (InvalidOperation, ZeroDivisionError):
        raise SPARQLError("divide by 0")

    return Literal(res)


# type error: Missing return statement
def AdditiveExpression(e: Expr, ctx: Union[QueryContext, FrozenBindings]) -> Literal:  # type: ignore[return]
    expr = e.expr
    other = e.other

    # because of the way the add-expr production handled operator precedence
    # we sometimes have nothing to do
    if other is None:
        return expr

    # handling arithmetic(addition/subtraction) of dateTime, date, time
    # and duration datatypes (if any)
    if hasattr(expr, "datatype") and (
        expr.datatype in XSD_DateTime_DTs or expr.datatype in XSD_Duration_DTs
    ):
        res = dateTimeObjects(expr)
        dt = expr.datatype

        for op, term in zip(e.op, other):
            # check if operation is datetime,date,time operation over
            # another datetime,date,time datatype
            if dt in XSD_DateTime_DTs and dt == term.datatype and op == "-":
                # checking if there are more than one datetime operands -
                # in that case it doesn't make sense for example
                # ( dateTime1 - dateTime2 - dateTime3 ) is an invalid operation
                if len(other) > 1:
                    error_message = "Can't evaluate multiple %r arguments"
                    # type error: Too many arguments for "SPARQLError"
                    raise SPARQLError(error_message, dt.datatype)  # type: ignore[call-arg]
                else:
                    n = dateTimeObjects(term)
                    res = calculateDuration(res, n)
                    return res

            # datetime,date,time +/- duration,dayTimeDuration,yearMonthDuration
            elif dt in XSD_DateTime_DTs and term.datatype in XSD_Duration_DTs:
                n = dateTimeObjects(term)
                res = calculateFinalDateTime(res, dt, n, term.datatype, op)
                return res

            # duration,dayTimeDuration,yearMonthDuration + datetime,date,time
            elif dt in XSD_Duration_DTs and term.datatype in XSD_DateTime_DTs:
                if op == "+":
                    n = dateTimeObjects(term)
                    res = calculateFinalDateTime(res, dt, n, term.datatype, op)
                    return res

            # rest are invalid types
            else:
                raise SPARQLError("Invalid DateTime Operations")

    # handling arithmetic(addition/subtraction) of numeric datatypes (if any)
    else:
        res = numeric(expr)

        dt = expr.datatype

        for op, term in zip(e.op, other):
            n = numeric(term)
            if isinstance(n, Decimal) and isinstance(res, float):
                n = float(n)
            if isinstance(n, float) and isinstance(res, Decimal):
                res = float(res)

            dt = type_promotion(dt, term.datatype)

            if op == "+":
                res += n
            else:
                res -= n

        return Literal(res, datatype=dt)


def RelationalExpression(e: Expr, ctx: Union[QueryContext, FrozenBindings]) -> Literal:
    expr = e.expr
    other = e.other
    op = e.op

    # because of the way the add-expr production handled operator precedence
    # we sometimes have nothing to do
    if other is None:
        return expr

    ops = dict(
        [
            (">", lambda x, y: x.__gt__(y)),
            ("<", lambda x, y: x.__lt__(y)),
            ("=", lambda x, y: x.eq(y)),
            ("!=", lambda x, y: x.neq(y)),
            (">=", lambda x, y: x.__ge__(y)),
            ("<=", lambda x, y: x.__le__(y)),
            ("IN", pyop.contains),
            ("NOT IN", lambda x, y: not pyop.contains(x, y)),
        ]
    )

    if op in ("IN", "NOT IN"):
        res = op == "NOT IN"

        error: Union[bool, SPARQLError] = False

        if other == RDF.nil:
            other = []

        for x in other:
            try:
                if x == expr:
                    return Literal(True ^ res)
            except SPARQLError as e:
                error = e
        if not error:
            return Literal(False ^ res)
        else:
            # Note on type error: this is because variable is Union[bool, SPARQLError]
            # type error: Exception must be derived from BaseException
            raise error  # type: ignore[misc]

    if op not in ("=", "!=", "IN", "NOT IN"):
        if not isinstance(expr, Literal):
            raise SPARQLError(
                "Compare other than =, != of non-literals is an error: %r" % expr
            )
        if not isinstance(other, Literal):
            raise SPARQLError(
                "Compare other than =, != of non-literals is an error: %r" % other
            )
    else:
        if not isinstance(expr, Node):
            raise SPARQLError("I cannot compare this non-node: %r" % expr)
        if not isinstance(other, Node):
            raise SPARQLError("I cannot compare this non-node: %r" % other)

    if isinstance(expr, Literal) and isinstance(other, Literal):
        if (
            expr.datatype is not None
            and expr.datatype not in XSD_DTs
            and other.datatype is not None
            and other.datatype not in XSD_DTs
        ):
            # in SPARQL for non-XSD DT Literals we can only do =,!=
            if op not in ("=", "!="):
                raise SPARQLError("Can only do =,!= comparisons of non-XSD Literals")

    try:
        r = ops[op](expr, other)
        if r == NotImplemented:
            raise SPARQLError("Error when comparing")
    except TypeError as te:
        raise SPARQLError(*te.args)
    return Literal(r)


def ConditionalAndExpression(
    e: Expr, ctx: Union[QueryContext, FrozenBindings]
) -> Literal:
    # TODO: handle returned errors

    expr = e.expr
    other = e.other

    # because of the way the add-expr production handled operator precedence
    # we sometimes have nothing to do
    if other is None:
        return expr

    return Literal(all(EBV(x) for x in [expr] + other))


def ConditionalOrExpression(
    e: Expr, ctx: Union[QueryContext, FrozenBindings]
) -> Literal:
    # TODO: handle errors

    expr = e.expr
    other = e.other

    # because of the way the add-expr production handled operator precedence
    # we sometimes have nothing to do
    if other is None:
        return expr
    # A logical-or that encounters an error on only one branch
    # will return TRUE if the other branch is TRUE and an error
    # if the other branch is FALSE.
    error = None
    for x in [expr] + other:
        try:
            if EBV(x):
                return Literal(True)
        except SPARQLError as e:
            error = e
    if error:
        raise error
    return Literal(False)


def not_(arg) -> Expr:
    return Expr("UnaryNot", UnaryNot, expr=arg)


def and_(*args: Expr) -> Expr:
    if len(args) == 1:
        return args[0]

    return Expr(
        "ConditionalAndExpression",
        ConditionalAndExpression,
        expr=args[0],
        other=list(args[1:]),
    )


TrueFilter = Expr("TrueFilter", lambda _1, _2: Literal(True))


def simplify(expr: Any) -> Any:
    if isinstance(expr, ParseResults) and len(expr) == 1:
        return simplify(expr[0])

    if isinstance(expr, (list, ParseResults)):
        return list(map(simplify, expr))
    if not isinstance(expr, CompValue):
        return expr
    if expr.name.endswith("Expression"):
        if expr.other is None:
            return simplify(expr.expr)

    for k in expr.keys():
        expr[k] = simplify(expr[k])
        # expr['expr']=simplify(expr.expr)
        #    expr['other']=simplify(expr.other)

    return expr


def literal(s: Literal) -> Literal:
    if not isinstance(s, Literal):
        raise SPARQLError("Non-literal passed as string: %r" % s)
    return s


def datetime(e: Literal) -> py_datetime.datetime:
    if not isinstance(e, Literal):
        raise SPARQLError("Non-literal passed as datetime: %r" % e)
    if not e.datatype == XSD.dateTime:
        raise SPARQLError("Literal with wrong datatype passed as datetime: %r" % e)
    return e.toPython()


def date(e: Literal) -> py_datetime.date:
    if not isinstance(e, Literal):
        raise SPARQLError("Non-literal passed as date: %r" % e)
    if e.datatype not in (XSD.date, XSD.dateTime):
        raise SPARQLError("Literal with wrong datatype passed as date: %r" % e)
    result = e.toPython()
    if isinstance(result, py_datetime.datetime):
        return result.date()
    return result


def string(s: Literal) -> Literal:
    """
    Make sure the passed thing is a string literal
    i.e. plain literal, xsd:string literal or lang-tagged literal
    """
    if not isinstance(s, Literal):
        raise SPARQLError("Non-literal passes as string: %r" % s)
    if s.datatype and s.datatype != XSD.string:
        raise SPARQLError("Non-string datatype-literal passes as string: %r" % s)
    return s


def numeric(expr: Literal) -> Any:
    """
    return a number from a literal
    http://www.w3.org/TR/xpath20/#promotion

    or TypeError
    """

    if not isinstance(expr, Literal):
        raise SPARQLTypeError("%r is not a literal!" % expr)

    if expr.datatype not in (
        XSD.float,
        XSD.double,
        XSD.decimal,
        XSD.integer,
        XSD.nonPositiveInteger,
        XSD.negativeInteger,
        XSD.nonNegativeInteger,
        XSD.positiveInteger,
        XSD.unsignedLong,
        XSD.unsignedInt,
        XSD.unsignedShort,
        XSD.unsignedByte,
        XSD.long,
        XSD.int,
        XSD.short,
        XSD.byte,
    ):
        raise SPARQLTypeError("%r does not have a numeric datatype!" % expr)

    return expr.toPython()


def dateTimeObjects(expr: Literal) -> Any:
    """
    return a dataTime/date/time/duration/dayTimeDuration/yearMonthDuration python objects from a literal
    """
    return expr.toPython()


# type error: Missing return statement
def isCompatibleDateTimeDatatype(  # type: ignore[return]
    obj1: Union[py_datetime.date, py_datetime.datetime],
    dt1: URIRef,
    obj2: Union[Duration, py_datetime.timedelta],
    dt2: URIRef,
) -> bool:
    """
    Returns a boolean indicating if first object is compatible
    with operation(+/-) over second object.
    """
    if dt1 == XSD.date:
        if dt2 == XSD.yearMonthDuration:
            return True
        elif dt2 == XSD.dayTimeDuration or dt2 == XSD.Duration:
            # checking if the dayTimeDuration has no Time Component
            # else it won't be compatible with Date Literal
            if "T" in str(obj2):
                return False
            else:
                return True

    if dt1 == XSD.time:
        if dt2 == XSD.yearMonthDuration:
            return False
        elif dt2 == XSD.dayTimeDuration or dt2 == XSD.Duration:
            # checking if the dayTimeDuration has no Date Component
            # (by checking if the format is "PT...." )
            # else it won't be compatible with Time Literal
            if "T" == str(obj2)[1]:
                return True
            else:
                return False

    if dt1 == XSD.dateTime:
        # compatible with all
        return True


def calculateDuration(
    obj1: Union[py_datetime.date, py_datetime.datetime],
    obj2: Union[py_datetime.date, py_datetime.datetime],
) -> Literal:
    """
    returns the duration Literal between two datetime
    """
    date1 = obj1
    date2 = obj2
    # type error: No overload variant of "__sub__" of "datetime" matches argument type "date"
    difference = date1 - date2  # type: ignore[operator]
    return Literal(difference, datatype=XSD.duration)


def calculateFinalDateTime(
    obj1: Union[py_datetime.date, py_datetime.datetime],
    dt1: URIRef,
    obj2: Union[Duration, py_datetime.timedelta],
    dt2: URIRef,
    operation: str,
) -> Literal:
    """
    Calculates the final dateTime/date/time resultant after addition/
    subtraction of duration/dayTimeDuration/yearMonthDuration
    """

    # checking compatibility of datatypes (duration types and date/time/dateTime)
    if isCompatibleDateTimeDatatype(obj1, dt1, obj2, dt2):
        # proceed
        if operation == "-":
            ans = obj1 - obj2
            return Literal(ans, datatype=dt1)
        else:
            ans = obj1 + obj2
            return Literal(ans, datatype=dt1)

    else:
        raise SPARQLError("Incompatible Data types to DateTime Operations")


@overload
def EBV(rt: Literal) -> bool: ...


@overload
def EBV(rt: Union[Variable, IdentifiedNode, SPARQLError, Expr]) -> NoReturn: ...


@overload
def EBV(rt: Union[Identifier, SPARQLError, Expr]) -> Union[bool, NoReturn]: ...


def EBV(rt: Union[Identifier, SPARQLError, Expr]) -> bool:
    """Effective Boolean Value (EBV)

    * If the argument is a typed literal with a datatype of xsd:boolean,
      the EBV is the value of that argument.
    * If the argument is a plain literal or a typed literal with a
      datatype of xsd:string, the EBV is false if the operand value
      has zero length; otherwise the EBV is true.
    * If the argument is a numeric type or a typed literal with a datatype
      derived from a numeric type, the EBV is false if the operand value is
      NaN or is numerically equal to zero; otherwise the EBV is true.
    * All other arguments, including unbound arguments, produce a type error.
    """

    if isinstance(rt, Literal):
        if rt.datatype == XSD.boolean:
            return rt.toPython()

        elif rt.datatype == XSD.string or rt.datatype is None:
            return len(rt) > 0

        else:
            pyRT = rt.toPython()

            if isinstance(pyRT, Literal):
                # Type error, see: http://www.w3.org/TR/rdf-sparql-query/#ebv
                raise SPARQLTypeError(
                    "http://www.w3.org/TR/rdf-sparql-query/#ebv - ' + \
                    'Could not determine the EBV for : %r"
                    % rt
                )
            else:
                return bool(pyRT)

    else:
        raise SPARQLTypeError(
            "http://www.w3.org/TR/rdf-sparql-query/#ebv - ' + \
            'Only literals have Boolean values! %r"
            % rt
        )


def _lang_range_check(range: Literal, lang: Literal) -> bool:
    """
    Implementation of the extended filtering algorithm, as defined in point
    3.3.2, of [RFC 4647](http://www.rfc-editor.org/rfc/rfc4647.txt), on
    matching language ranges and language tags.
    Needed to handle the `rdf:PlainLiteral` datatype.

    Args:
        range: language range
        lang: language tag

    Author: [Ivan Herman](http://www.w3.org/People/Ivan/)

    Taken from [`RDFClosure/RestrictedDatatype.py`](http://dev.w3.org/2004/PythonLib-IH/RDFClosure/RestrictedDatatype.py)
    """

    def _match(r: str, l_: str) -> bool:
        """
        Matching of a range and language item: either range is a wildcard
        or the two are equal

        Args:
            r: language range item
            l_: language tag item
        """
        return r == "*" or r == l_

    rangeList = range.strip().lower().split("-")
    langList = lang.strip().lower().split("-")
    if not _match(rangeList[0], langList[0]):
        return False
    if len(rangeList) > len(langList):
        return False

    return all(_match(*x) for x in zip(rangeList, langList))
