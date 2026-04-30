"""
SPARQL 1.1 Parser

based on pyparsing
"""

from __future__ import annotations  # noqa: I001

import re
import sys
from typing import Any, BinaryIO, List
from typing import Optional as OptionalType
from typing import TextIO, Tuple, Union

from pyparsing import CaselessKeyword as Keyword  # watch out :)
from pyparsing import (
    Combine,
    Forward,
    Group,
    Literal,
    OneOrMore,
    Optional,
    ParseResults,
    Regex,
    Suppress,
    ZeroOrMore,
)

import rdflib
from rdflib.compat import decodeUnicodeEscape

from . import operators as op
from .pyparsing_compat import DelimitedList, combine_join_kwargs, rest_of_line
from .parserutils import Comp, CompValue, Param, ParamList

# from pyparsing import Keyword as CaseSensitiveKeyword


DEBUG = False

# ---------------- ACTIONS


def neg(literal: rdflib.Literal) -> rdflib.Literal:
    return rdflib.Literal(-literal, datatype=literal.datatype)


def setLanguage(terms: Tuple[Any, OptionalType[str]]) -> rdflib.Literal:
    return rdflib.Literal(terms[0], lang=terms[1])


def setDataType(terms: Tuple[Any, OptionalType[str]]) -> rdflib.Literal:
    return rdflib.Literal(terms[0], datatype=terms[1])


def expandTriples(terms: ParseResults) -> List[Any]:
    """
    Expand ; and , syntax for repeat predicates, subjects
    """
    # import pdb; pdb.set_trace()
    last_subject, last_predicate = None, None  # Used for ; and ,
    try:
        res: List[Any] = []
        if DEBUG:
            print("Terms", terms)
        l_ = len(terms)
        for i, t in enumerate(terms):
            if t == ",":
                res.extend([last_subject, last_predicate])
            elif t == ";":
                if i + 1 == len(terms) or terms[i + 1] == ";" or terms[i + 1] == ".":
                    continue  # this semicolon is spurious
                res.append(last_subject)
            elif isinstance(t, list):
                # BlankNodePropertyList
                # is this bnode the object of previous triples?
                if (len(res) % 3) == 2:
                    res.append(t[0])
                # is this a single [] ?
                if len(t) > 1:
                    res += t  # Don't update last_subject/last_predicate
                # is this bnode the subject of more triples?
                if i + 1 < l_ and terms[i + 1] not in [
                    ".",
                    ",",
                    ";",
                ]:  # term might not be a string
                    last_subject, last_predicate = t[0], None
                    res.append(t[0])
            elif isinstance(t, ParseResults):
                res += t.as_list()
            elif t != ".":
                res.append(t)
                if (len(res) % 3) == 1:
                    last_subject = t
                elif (len(res) % 3) == 2:
                    last_predicate = t
            if DEBUG:
                print(len(res), t)
        if DEBUG:
            import json

            print(json.dumps(res, indent=2))

        return res
        # print res
        # assert len(res)%3 == 0, \
        #       "Length of triple-list is not divisible by 3: %d!"%len(res)

        # return [tuple(res[i:i+3]) for i in range(len(res)/3)]
    except:
        if DEBUG:
            import traceback

            traceback.print_exc()
        raise


def expandBNodeTriples(terms: ParseResults) -> List[Any]:
    """
    expand [ ?p ?o ] syntax for implicit bnodes
    """
    # import pdb; pdb.set_trace()
    try:
        if DEBUG:
            print("Bnode terms", terms)
            print("1", terms[0])
            print("2", [rdflib.BNode()] + terms.as_list()[0])
        return [expandTriples([rdflib.BNode()] + terms.as_list()[0])]
    except Exception as e:
        if DEBUG:
            print(">>>>>>>>", e)
        raise


def expandCollection(terms: ParseResults) -> List[List[Any]]:
    """
    expand ( 1 2 3 ) notation for collections
    """
    if DEBUG:
        print("Collection: ", terms)

    res: List[Any] = []
    other = []
    for x in terms:
        if isinstance(x, list):  # is this a [ .. ] ?
            other += x
            x = x[0]

        b = rdflib.BNode()
        if res:
            res += [res[-3], rdflib.RDF.rest, b, b, rdflib.RDF.first, x]
        else:
            res += [b, rdflib.RDF.first, x]
    res += [b, rdflib.RDF.rest, rdflib.RDF.nil]

    res += other

    if DEBUG:
        print("CollectionOut", res)
    return [res]


# SPARQL Grammar from http://www.w3.org/TR/sparql11-query/#grammar
# ------ TERMINALS --------------
# [139] IRIREF ::= '<' ([^<>"{}|^`\]-[#x00-#x20])* '>'
IRIREF = Combine(
    Suppress("<")
    + Regex(r'[^<>"{}|^`\\%s]*' % "".join("\\x%02X" % i for i in range(33)))
    + Suppress(">")
)
IRIREF.set_parse_action(lambda x: rdflib.URIRef(x[0]))

# [164] P_CHARS_BASE ::= [A-Z] | [a-z] | [#x00C0-#x00D6] | [#x00D8-#x00F6] | [#x00F8-#x02FF] | [#x0370-#x037D] | [#x037F-#x1FFF] | [#x200C-#x200D] | [#x2070-#x218F] | [#x2C00-#x2FEF] | [#x3001-#xD7FF] | [#xF900-#xFDCF] | [#xFDF0-#xFFFD] | [#x10000-#xEFFFF]

if sys.maxunicode == 0xFFFF:
    # this is narrow python build (default on windows/osx)
    # this means that unicode code points over 0xffff are stored
    # as several characters, which in turn means that regex character
    # ranges with these characters do not work.
    # See
    # * http://bugs.python.org/issue12729
    # * http://bugs.python.org/issue12749
    # * http://bugs.python.org/issue3665
    #
    # Here we simple skip the [#x10000-#xEFFFF] part
    # this means that some SPARQL queries will not parse :(
    # We *could* generate a new regex with \U00010000|\U00010001 ...
    # but it would be quite long :)
    #
    # in py3.3 this is fixed

    PN_CHARS_BASE_re = "A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD"
else:
    # wide python build
    PN_CHARS_BASE_re = "A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\U00010000-\U000EFFFF"

# [165] PN_CHARS_U ::= PN_CHARS_BASE | '_'
PN_CHARS_U_re = "_" + PN_CHARS_BASE_re

# [167] PN_CHARS ::= PN_CHARS_U | '-' | [0-9] | #x00B7 | [#x0300-#x036F] | [#x203F-#x2040]
PN_CHARS_re = "\\-0-9\u00B7\u0300-\u036F\u203F-\u2040" + PN_CHARS_U_re
# PN_CHARS = Regex(u'[%s]'%PN_CHARS_re, flags=re.U)

# [168] PN_PREFIX ::= PN_CHARS_BASE ((PN_CHARS|'.')* PN_CHARS)?
PN_PREFIX = Regex(
    "[%s](?:[%s\\.]*[%s])?" % (PN_CHARS_BASE_re, PN_CHARS_re, PN_CHARS_re), flags=re.U
)

# [140] PNAME_NS ::= PN_PREFIX? ':'
PNAME_NS = Optional(Param("prefix", PN_PREFIX)) + Suppress(":").leave_whitespace()

# [173] PN_LOCAL_ESC ::= '\' ( '_' | '~' | '.' | '-' | '!' | '$' | '&' | "'" | '(' | ')' | '*' | '+' | ',' | ';' | '=' | '/' | '?' | '#' | '@' | '%' )

PN_LOCAL_ESC_re = "\\\\[_~\\.\\-!$&\"'()*+,;=/?#@%]"
# PN_LOCAL_ESC = Regex(PN_LOCAL_ESC_re) # regex'd
# PN_LOCAL_ESC.set_parse_action(lambda x: x[0][1:])

# [172] HEX ::= [0-9] | [A-F] | [a-f]
# HEX = Regex('[0-9A-Fa-f]') # not needed

# [171] PERCENT ::= '%' HEX HEX
PERCENT_re = "%[0-9a-fA-F]{2}"
# PERCENT = Regex(PERCENT_re) # regex'd
# PERCENT.set_parse_action(lambda x: chr(int(x[0][1:], 16)))

# [170] PLX ::= PERCENT | PN_LOCAL_ESC
PLX_re = "(%s|%s)" % (PN_LOCAL_ESC_re, PERCENT_re)
# PLX = PERCENT | PN_LOCAL_ESC # regex'd


# [169] PN_LOCAL ::= (PN_CHARS_U | ':' | [0-9] | PLX ) ((PN_CHARS | '.' | ':' | PLX)* (PN_CHARS | ':' | PLX) )?

PN_LOCAL = Regex(
    """([%(PN_CHARS_U)s:0-9]|%(PLX)s)
                     (([%(PN_CHARS)s\\.:]|%(PLX)s)*
                      ([%(PN_CHARS)s:]|%(PLX)s) )?"""
    % dict(PN_CHARS_U=PN_CHARS_U_re, PN_CHARS=PN_CHARS_re, PLX=PLX_re),
    flags=re.X | re.UNICODE,
)


# [141] PNAME_LN ::= PNAME_NS PN_LOCAL
PNAME_LN = PNAME_NS + Param("localname", PN_LOCAL.leave_whitespace())

# [142] BLANK_NODE_LABEL ::= '_:' ( PN_CHARS_U | [0-9] ) ((PN_CHARS|'.')* PN_CHARS)?
BLANK_NODE_LABEL = Regex(
    "_:[0-9%s](?:[\\.%s]*[%s])?" % (PN_CHARS_U_re, PN_CHARS_re, PN_CHARS_re),
    flags=re.U,
)
BLANK_NODE_LABEL.set_parse_action(lambda x: rdflib.BNode(x[0][2:]))


# [166] VARNAME ::= ( PN_CHARS_U | [0-9] ) ( PN_CHARS_U | [0-9] | #x00B7 | [#x0300-#x036F] | [#x203F-#x2040] )*
VARNAME = Regex(
    "[%s0-9][%s0-9\u00B7\u0300-\u036F\u203F-\u2040]*" % (PN_CHARS_U_re, PN_CHARS_U_re),
    flags=re.U,
)

# [143] VAR1 ::= '?' VARNAME
VAR1 = Combine(Suppress("?") + VARNAME)

# [144] VAR2 ::= '$' VARNAME
VAR2 = Combine(Suppress("$") + VARNAME)

# [145] LANGTAG ::= '@' [a-zA-Z]+ ('-' [a-zA-Z0-9]+)*
LANGTAG = Combine(Suppress("@") + Regex("[a-zA-Z]+(?:-[a-zA-Z0-9]+)*"))

# [146] INTEGER ::= [0-9]+
INTEGER = Regex(r"[0-9]+")
# INTEGER.set_results_name('integer')
INTEGER.set_parse_action(lambda x: rdflib.Literal(x[0], datatype=rdflib.XSD.integer))

# [155] EXPONENT ::= [eE] [+-]? [0-9]+
EXPONENT_re = "[eE][+-]?[0-9]+"

# [147] DECIMAL ::= [0-9]* '.' [0-9]+
DECIMAL = Regex(r"[0-9]*\.[0-9]+")  # (?![eE])
# DECIMAL.set_results_name('decimal')
DECIMAL.set_parse_action(lambda x: rdflib.Literal(x[0], datatype=rdflib.XSD.decimal))

# [148] DOUBLE ::= [0-9]+ '.' [0-9]* EXPONENT | '.' ([0-9])+ EXPONENT | ([0-9])+ EXPONENT
DOUBLE = Regex(r"[0-9]+\.[0-9]*%(e)s|\.([0-9])+%(e)s|[0-9]+%(e)s" % {"e": EXPONENT_re})
# DOUBLE.set_results_name('double')
DOUBLE.set_parse_action(lambda x: rdflib.Literal(x[0], datatype=rdflib.XSD.double))


# [149] INTEGER_POSITIVE ::= '+' INTEGER
INTEGER_POSITIVE = Suppress("+") + INTEGER.copy().leave_whitespace()
INTEGER_POSITIVE.set_parse_action(
    lambda x: rdflib.Literal("+" + x[0], datatype=rdflib.XSD.integer)
)

# [150] DECIMAL_POSITIVE ::= '+' DECIMAL
DECIMAL_POSITIVE = Suppress("+") + DECIMAL.copy().leave_whitespace()

# [151] DOUBLE_POSITIVE ::= '+' DOUBLE
DOUBLE_POSITIVE = Suppress("+") + DOUBLE.copy().leave_whitespace()

# [152] INTEGER_NEGATIVE ::= '-' INTEGER
INTEGER_NEGATIVE = Suppress("-") + INTEGER.copy().leave_whitespace()
INTEGER_NEGATIVE.set_parse_action(lambda x: neg(x[0]))

# [153] DECIMAL_NEGATIVE ::= '-' DECIMAL
DECIMAL_NEGATIVE = Suppress("-") + DECIMAL.copy().leave_whitespace()
DECIMAL_NEGATIVE.set_parse_action(lambda x: neg(x[0]))

# [154] DOUBLE_NEGATIVE ::= '-' DOUBLE
DOUBLE_NEGATIVE = Suppress("-") + DOUBLE.copy().leave_whitespace()
DOUBLE_NEGATIVE.set_parse_action(lambda x: neg(x[0]))

# [160] ECHAR ::= '\' [tbnrf\"']
# ECHAR = Regex('\\\\[tbnrf"\']')


# [158] STRING_LITERAL_LONG1 ::= "'''" ( ( "'" | "''" )? ( [^'\] | ECHAR ) )* "'''"
# STRING_LITERAL_LONG1 = Literal("'''") + ( Optional( Literal("'") | "''"
# ) + ZeroOrMore( ~ Literal("'\\") | ECHAR ) ) + "'''"
STRING_LITERAL_LONG1 = Regex("'''((?:'|'')?(?:[^'\\\\]|\\\\['ntbrf\\\\]))*'''")
STRING_LITERAL_LONG1.set_parse_action(
    lambda x: rdflib.Literal(decodeUnicodeEscape(x[0][3:-3]))
)

# [159] STRING_LITERAL_LONG2 ::= '"""' ( ( '"' | '""' )? ( [^"\] | ECHAR ) )* '"""'
# STRING_LITERAL_LONG2 = Literal('"""') + ( Optional( Literal('"') | '""'
# ) + ZeroOrMore( ~ Literal('"\\') | ECHAR ) ) +  '"""'
STRING_LITERAL_LONG2 = Regex('"""(?:(?:"|"")?(?:[^"\\\\]|\\\\["ntbrf\\\\]))*"""')
STRING_LITERAL_LONG2.set_parse_action(
    lambda x: rdflib.Literal(decodeUnicodeEscape(x[0][3:-3]))
)

# [156] STRING_LITERAL1 ::= "'" ( ([^#x27#x5C#xA#xD]) | ECHAR )* "'"
# STRING_LITERAL1 = Literal("'") + ZeroOrMore(
# Regex(u'[^\u0027\u005C\u000A\u000D]',flags=re.U) | ECHAR ) + "'"

STRING_LITERAL1 = Regex("'(?:[^'\\n\\r\\\\]|\\\\['ntbrf\\\\])*'(?!')", flags=re.U)
STRING_LITERAL1.set_parse_action(
    lambda x: rdflib.Literal(decodeUnicodeEscape(x[0][1:-1]))
)

# [157] STRING_LITERAL2 ::= '"' ( ([^#x22#x5C#xA#xD]) | ECHAR )* '"'
# STRING_LITERAL2 = Literal('"') + ZeroOrMore (
# Regex(u'[^\u0022\u005C\u000A\u000D]',flags=re.U) | ECHAR ) + '"'

STRING_LITERAL2 = Regex('"(?:[^"\\n\\r\\\\]|\\\\["ntbrf\\\\])*"(?!")', flags=re.U)
STRING_LITERAL2.set_parse_action(
    lambda x: rdflib.Literal(decodeUnicodeEscape(x[0][1:-1]))
)

# [161] NIL ::= '(' WS* ')'
NIL = Literal("(") + ")"
NIL.set_parse_action(lambda x: rdflib.RDF.nil)

# [162] WS ::= #x20 | #x9 | #xD | #xA
# Not needed?
# WS = #x20 | #x9 | #xD | #xA
# [163] ANON ::= '[' WS* ']'
ANON = Literal("[") + "]"
ANON.set_parse_action(lambda x: rdflib.BNode())

# A = CaseSensitiveKeyword('a')
A = Literal("a")
A.set_parse_action(lambda x: rdflib.RDF.type)


# ------ NON-TERMINALS --------------

# [5] BaseDecl ::= 'BASE' IRIREF
BaseDecl = Comp("Base", Keyword("BASE") + Param("iri", IRIREF))

# [6] PrefixDecl ::= 'PREFIX' PNAME_NS IRIREF
PrefixDecl = Comp("PrefixDecl", Keyword("PREFIX") + PNAME_NS + Param("iri", IRIREF))

# [4] Prologue ::= ( BaseDecl | PrefixDecl )*
Prologue = Group(ZeroOrMore(BaseDecl | PrefixDecl))

# [108] Var ::= VAR1 | VAR2
Var = VAR1 | VAR2
Var.set_parse_action(lambda x: rdflib.term.Variable(x[0]))

# [137] PrefixedName ::= PNAME_LN | PNAME_NS
PrefixedName = Comp("pname", PNAME_LN | PNAME_NS)

# [136] iri ::= IRIREF | PrefixedName
iri = IRIREF | PrefixedName

# [135] String ::= STRING_LITERAL1 | STRING_LITERAL2 | STRING_LITERAL_LONG1 | STRING_LITERAL_LONG2
String = STRING_LITERAL_LONG1 | STRING_LITERAL_LONG2 | STRING_LITERAL1 | STRING_LITERAL2

# [129] RDFLiteral ::= String ( LANGTAG | ( '^^' iri ) )?

RDFLiteral = Comp(
    "literal",
    Param("string", String)
    + Optional(
        Param("lang", LANGTAG.leave_whitespace())
        | Literal("^^").leave_whitespace() + Param("datatype", iri).leave_whitespace()
    ),
)

# [132] NumericLiteralPositive ::= INTEGER_POSITIVE | DECIMAL_POSITIVE | DOUBLE_POSITIVE
NumericLiteralPositive = DOUBLE_POSITIVE | DECIMAL_POSITIVE | INTEGER_POSITIVE

# [133] NumericLiteralNegative ::= INTEGER_NEGATIVE | DECIMAL_NEGATIVE | DOUBLE_NEGATIVE
NumericLiteralNegative = DOUBLE_NEGATIVE | DECIMAL_NEGATIVE | INTEGER_NEGATIVE

# [131] NumericLiteralUnsigned ::= INTEGER | DECIMAL | DOUBLE
NumericLiteralUnsigned = DOUBLE | DECIMAL | INTEGER

# [130] NumericLiteral ::= NumericLiteralUnsigned | NumericLiteralPositive | NumericLiteralNegative
NumericLiteral = (
    NumericLiteralUnsigned | NumericLiteralPositive | NumericLiteralNegative
)

# [134] BooleanLiteral ::= 'true' | 'false'
BooleanLiteral = Keyword("true").set_parse_action(
    lambda: rdflib.Literal(True)
) | Keyword("false").set_parse_action(lambda: rdflib.Literal(False))

# [138] BlankNode ::= BLANK_NODE_LABEL | ANON
BlankNode = BLANK_NODE_LABEL | ANON

# [109] GraphTerm ::= iri | RDFLiteral | NumericLiteral | BooleanLiteral | BlankNode | NIL
GraphTerm = iri | RDFLiteral | NumericLiteral | BooleanLiteral | BlankNode | NIL

# [106] VarOrTerm ::= Var | GraphTerm
VarOrTerm = Var | GraphTerm

# [107] VarOrIri ::= Var | iri
VarOrIri = Var | iri

# [46] GraphRef ::= 'GRAPH' iri
GraphRef = Keyword("GRAPH") + Param("graphiri", iri)

# [47] GraphRefAll ::= GraphRef | 'DEFAULT' | 'NAMED' | 'ALL'
GraphRefAll = (
    GraphRef
    | Param("graphiri", Keyword("DEFAULT"))
    | Param("graphiri", Keyword("NAMED"))
    | Param("graphiri", Keyword("ALL"))
)

# [45] GraphOrDefault ::= 'DEFAULT' | 'GRAPH'? iri
GraphOrDefault = ParamList("graph", Keyword("DEFAULT")) | Optional(
    Keyword("GRAPH")
) + ParamList("graph", iri)

# [65] DataBlockValue ::= iri | RDFLiteral | NumericLiteral | BooleanLiteral | 'UNDEF'
DataBlockValue = iri | RDFLiteral | NumericLiteral | BooleanLiteral | Keyword("UNDEF")

# [78] Verb ::= VarOrIri | A
Verb = VarOrIri | A


# [85] VerbSimple ::= Var
VerbSimple = Var

# [97] Integer ::= INTEGER
Integer = INTEGER


TriplesNode = Forward()
TriplesNodePath = Forward()

# [104] GraphNode ::= VarOrTerm | TriplesNode
GraphNode = VarOrTerm | TriplesNode

# [105] GraphNodePath ::= VarOrTerm | TriplesNodePath
GraphNodePath = VarOrTerm | TriplesNodePath


# [93] PathMod ::= '?' | '*' | '+'
PathMod = Literal("?") | "*" | "+"

# [96] PathOneInPropertySet ::= iri | A | '^' ( iri | A )
PathOneInPropertySet = iri | A | Comp("InversePath", "^" + (iri | A))

Path = Forward()

# [95] PathNegatedPropertySet ::= PathOneInPropertySet | '(' ( PathOneInPropertySet ( '|' PathOneInPropertySet )* )? ')'
PathNegatedPropertySet = Comp(
    "PathNegatedPropertySet",
    ParamList("part", PathOneInPropertySet)
    | "("
    + Optional(
        ParamList("part", PathOneInPropertySet)
        + ZeroOrMore("|" + ParamList("part", PathOneInPropertySet))
    )
    + ")",
)

# [94] PathPrimary ::= iri | A | '!' PathNegatedPropertySet | '(' Path ')' | 'DISTINCT' '(' Path ')'
PathPrimary = (
    iri
    | A
    | Suppress("!") + PathNegatedPropertySet
    | Suppress("(") + Path + Suppress(")")
    | Comp("DistinctPath", Keyword("DISTINCT") + "(" + Param("part", Path) + ")")
)

# [91] PathElt ::= PathPrimary Optional(PathMod)
PathElt = Comp(
    "PathElt",
    Param("part", PathPrimary) + Optional(Param("mod", PathMod.leave_whitespace())),
)

# [92] PathEltOrInverse ::= PathElt | '^' PathElt
PathEltOrInverse = PathElt | Suppress("^") + Comp(
    "PathEltOrInverse", Param("part", PathElt)
)

# [90] PathSequence ::= PathEltOrInverse ( '/' PathEltOrInverse )*
PathSequence = Comp(
    "PathSequence",
    ParamList("part", PathEltOrInverse)
    + ZeroOrMore("/" + ParamList("part", PathEltOrInverse)),
)


# [89] PathAlternative ::= PathSequence ( '|' PathSequence )*
PathAlternative = Comp(
    "PathAlternative",
    ParamList("part", PathSequence) + ZeroOrMore("|" + ParamList("part", PathSequence)),
)

# [88] Path ::= PathAlternative
Path <<= PathAlternative

# [84] VerbPath ::= Path
VerbPath = Path

# [87] ObjectPath ::= GraphNodePath
ObjectPath = GraphNodePath

# [86] ObjectListPath ::= ObjectPath ( ',' ObjectPath )*
ObjectListPath = ObjectPath + ZeroOrMore("," + ObjectPath)


GroupGraphPattern = Forward()


# [102] Collection ::= '(' OneOrMore(GraphNode) ')'
Collection = Suppress("(") + OneOrMore(GraphNode) + Suppress(")")
Collection.set_parse_action(expandCollection)

# [103] CollectionPath ::= '(' OneOrMore(GraphNodePath) ')'
CollectionPath = Suppress("(") + OneOrMore(GraphNodePath) + Suppress(")")
CollectionPath.set_parse_action(expandCollection)

# [80] Object ::= GraphNode
Object = GraphNode

# [79] ObjectList ::= Object ( ',' Object )*
ObjectList = Object + ZeroOrMore("," + Object)

# [83] PropertyListPathNotEmpty ::= ( VerbPath | VerbSimple ) ObjectListPath ( ';' ( ( VerbPath | VerbSimple ) ObjectList )? )*
PropertyListPathNotEmpty = (
    (VerbPath | VerbSimple)
    + ObjectListPath
    + ZeroOrMore(";" + Optional((VerbPath | VerbSimple) + ObjectListPath))
)

# [82] PropertyListPath ::= Optional(PropertyListPathNotEmpty)
PropertyListPath = Optional(PropertyListPathNotEmpty)

# [77] PropertyListNotEmpty ::= Verb ObjectList ( ';' ( Verb ObjectList )? )*
PropertyListNotEmpty = Verb + ObjectList + ZeroOrMore(";" + Optional(Verb + ObjectList))


# [76] PropertyList ::= Optional(PropertyListNotEmpty)
PropertyList = Optional(PropertyListNotEmpty)

# [99] BlankNodePropertyList ::= '[' PropertyListNotEmpty ']'
BlankNodePropertyList = Group(Suppress("[") + PropertyListNotEmpty + Suppress("]"))
BlankNodePropertyList.set_parse_action(expandBNodeTriples)

# [101] BlankNodePropertyListPath ::= '[' PropertyListPathNotEmpty ']'
BlankNodePropertyListPath = Group(
    Suppress("[") + PropertyListPathNotEmpty + Suppress("]")
)
BlankNodePropertyListPath.set_parse_action(expandBNodeTriples)

# [98] TriplesNode ::= Collection | BlankNodePropertyList
TriplesNode <<= Collection | BlankNodePropertyList

# [100] TriplesNodePath ::= CollectionPath | BlankNodePropertyListPath
TriplesNodePath <<= CollectionPath | BlankNodePropertyListPath

# [75] TriplesSameSubject ::= VarOrTerm PropertyListNotEmpty | TriplesNode PropertyList
TriplesSameSubject = VarOrTerm + PropertyListNotEmpty | TriplesNode + PropertyList
TriplesSameSubject.set_parse_action(expandTriples)

# [52] TriplesTemplate ::= TriplesSameSubject ( '.' TriplesTemplate? )?
# NOTE: pyparsing.py handling of recursive rules is limited by python's recursion
# limit.
# (https://docs.python.org/3/library/sys.html#sys.setrecursionlimit)
# To accommodate arbitrary amounts of triples this rule is rewritten to not be
# recursive:
# [52*] TriplesTemplate ::= TriplesSameSubject ( '.' TriplesSameSubject? )*
TriplesTemplate = ParamList("triples", TriplesSameSubject) + ZeroOrMore(
    Suppress(".") + Optional(ParamList("triples", TriplesSameSubject))
)

# [51] QuadsNotTriples ::= 'GRAPH' VarOrIri '{' Optional(TriplesTemplate) '}'
QuadsNotTriples = Comp(
    "QuadsNotTriples",
    Keyword("GRAPH") + Param("term", VarOrIri) + "{" + Optional(TriplesTemplate) + "}",
)

# [50] Quads ::= Optional(TriplesTemplate) ( QuadsNotTriples '.'? Optional(TriplesTemplate) )*
Quads = Comp(
    "Quads",
    Optional(TriplesTemplate)
    + ZeroOrMore(
        ParamList("quadsNotTriples", QuadsNotTriples)
        + Optional(Suppress("."))
        + Optional(TriplesTemplate)
    ),
)

# [48] QuadPattern ::= '{' Quads '}'
QuadPattern = "{" + Param("quads", Quads) + "}"

# [49] QuadData ::= '{' Quads '}'
QuadData = "{" + Param("quads", Quads) + "}"

# [81] TriplesSameSubjectPath ::= VarOrTerm PropertyListPathNotEmpty | TriplesNodePath PropertyListPath
TriplesSameSubjectPath = (
    VarOrTerm + PropertyListPathNotEmpty | TriplesNodePath + PropertyListPath
)
TriplesSameSubjectPath.set_parse_action(expandTriples)

# [55] TriplesBlock ::= TriplesSameSubjectPath ( '.' Optional(TriplesBlock) )?
TriplesBlock = Forward()
TriplesBlock <<= ParamList("triples", TriplesSameSubjectPath) + Optional(
    Suppress(".") + Optional(TriplesBlock)
)


# [66] MinusGraphPattern ::= 'MINUS' GroupGraphPattern
MinusGraphPattern = Comp(
    "MinusGraphPattern", Keyword("MINUS") + Param("graph", GroupGraphPattern)
)

# [67] GroupOrUnionGraphPattern ::= GroupGraphPattern ( 'UNION' GroupGraphPattern )*
GroupOrUnionGraphPattern = Comp(
    "GroupOrUnionGraphPattern",
    ParamList("graph", GroupGraphPattern)
    + ZeroOrMore(Keyword("UNION") + ParamList("graph", GroupGraphPattern)),
)


Expression = Forward()

# [72] ExpressionList ::= NIL | '(' Expression ( ',' Expression )* ')'
ExpressionList = NIL | Group(Suppress("(") + DelimitedList(Expression) + Suppress(")"))

# [122] RegexExpression ::= 'REGEX' '(' Expression ',' Expression ( ',' Expression )? ')'
RegexExpression = Comp(
    "Builtin_REGEX",
    Keyword("REGEX")
    + "("
    + Param("text", Expression)
    + ","
    + Param("pattern", Expression)
    + Optional("," + Param("flags", Expression))
    + ")",
)
RegexExpression.setEvalFn(op.Builtin_REGEX)

# [123] SubstringExpression ::= 'SUBSTR' '(' Expression ',' Expression ( ',' Expression )? ')'
SubstringExpression = Comp(
    "Builtin_SUBSTR",
    Keyword("SUBSTR")
    + "("
    + Param("arg", Expression)
    + ","
    + Param("start", Expression)
    + Optional("," + Param("length", Expression))
    + ")",
).setEvalFn(op.Builtin_SUBSTR)

# [124] StrReplaceExpression ::= 'REPLACE' '(' Expression ',' Expression ',' Expression ( ',' Expression )? ')'
StrReplaceExpression = Comp(
    "Builtin_REPLACE",
    Keyword("REPLACE")
    + "("
    + Param("arg", Expression)
    + ","
    + Param("pattern", Expression)
    + ","
    + Param("replacement", Expression)
    + Optional("," + Param("flags", Expression))
    + ")",
).setEvalFn(op.Builtin_REPLACE)

# [125] ExistsFunc ::= 'EXISTS' GroupGraphPattern
ExistsFunc = Comp(
    "Builtin_EXISTS", Keyword("EXISTS") + Param("graph", GroupGraphPattern)
).setEvalFn(op.Builtin_EXISTS)

# [126] NotExistsFunc ::= 'NOT' 'EXISTS' GroupGraphPattern
NotExistsFunc = Comp(
    "Builtin_NOTEXISTS",
    Keyword("NOT") + Keyword("EXISTS") + Param("graph", GroupGraphPattern),
).setEvalFn(op.Builtin_EXISTS)


# [127] Aggregate ::= 'COUNT' '(' 'DISTINCT'? ( '*' | Expression ) ')'
# | 'SUM' '(' Optional('DISTINCT') Expression ')'
# | 'MIN' '(' Optional('DISTINCT') Expression ')'
# | 'MAX' '(' Optional('DISTINCT') Expression ')'
# | 'AVG' '(' Optional('DISTINCT') Expression ')'
# | 'SAMPLE' '(' Optional('DISTINCT') Expression ')'
# | 'GROUP_CONCAT' '(' Optional('DISTINCT') Expression ( ';' 'SEPARATOR' '=' String )? ')'

_Distinct = Optional(Keyword("DISTINCT"))
_AggregateParams = "(" + Param("distinct", _Distinct) + Param("vars", Expression) + ")"

Aggregate = (
    Comp(
        "Aggregate_Count",
        Keyword("COUNT")
        + "("
        + Param("distinct", _Distinct)
        + Param("vars", "*" | Expression)
        + ")",
    )
    | Comp("Aggregate_Sum", Keyword("SUM") + _AggregateParams)
    | Comp("Aggregate_Min", Keyword("MIN") + _AggregateParams)
    | Comp("Aggregate_Max", Keyword("MAX") + _AggregateParams)
    | Comp("Aggregate_Avg", Keyword("AVG") + _AggregateParams)
    | Comp("Aggregate_Sample", Keyword("SAMPLE") + _AggregateParams)
    | Comp(
        "Aggregate_GroupConcat",
        Keyword("GROUP_CONCAT")
        + "("
        + Param("distinct", _Distinct)
        + Param("vars", Expression)
        + Optional(";" + Keyword("SEPARATOR") + "=" + Param("separator", String))
        + ")",
    )
)

# [121] BuiltInCall ::= Aggregate
# | 'STR' '(' + Expression + ')'
# | 'LANG' '(' + Expression + ')'
# | 'LANGMATCHES' '(' + Expression + ',' + Expression + ')'
# | 'DATATYPE' '(' + Expression + ')'
# | 'BOUND' '(' Var ')'
# | 'IRI' '(' + Expression + ')'
# | 'URI' '(' + Expression + ')'
# | 'BNODE' ( '(' + Expression + ')' | NIL )
# | 'RAND' NIL
# | 'ABS' '(' + Expression + ')'
# | 'CEIL' '(' + Expression + ')'
# | 'FLOOR' '(' + Expression + ')'
# | 'ROUND' '(' + Expression + ')'
# | 'CONCAT' ExpressionList
# | SubstringExpression
# | 'STRLEN' '(' + Expression + ')'
# | StrReplaceExpression
# | 'UCASE' '(' + Expression + ')'
# | 'LCASE' '(' + Expression + ')'
# | 'ENCODE_FOR_URI' '(' + Expression + ')'
# | 'CONTAINS' '(' + Expression + ',' + Expression + ')'
# | 'STRSTARTS' '(' + Expression + ',' + Expression + ')'
# | 'STRENDS' '(' + Expression + ',' + Expression + ')'
# | 'STRBEFORE' '(' + Expression + ',' + Expression + ')'
# | 'STRAFTER' '(' + Expression + ',' + Expression + ')'
# | 'YEAR' '(' + Expression + ')'
# | 'MONTH' '(' + Expression + ')'
# | 'DAY' '(' + Expression + ')'
# | 'HOURS' '(' + Expression + ')'
# | 'MINUTES' '(' + Expression + ')'
# | 'SECONDS' '(' + Expression + ')'
# | 'TIMEZONE' '(' + Expression + ')'
# | 'TZ' '(' + Expression + ')'
# | 'NOW' NIL
# | 'UUID' NIL
# | 'STRUUID' NIL
# | 'MD5' '(' + Expression + ')'
# | 'SHA1' '(' + Expression + ')'
# | 'SHA256' '(' + Expression + ')'
# | 'SHA384' '(' + Expression + ')'
# | 'SHA512' '(' + Expression + ')'
# | 'COALESCE' ExpressionList
# | 'IF' '(' Expression ',' Expression ',' Expression ')'
# | 'STRLANG' '(' + Expression + ',' + Expression + ')'
# | 'STRDT' '(' + Expression + ',' + Expression + ')'
# | 'sameTerm' '(' + Expression + ',' + Expression + ')'
# | 'isIRI' '(' + Expression + ')'
# | 'isURI' '(' + Expression + ')'
# | 'isBLANK' '(' + Expression + ')'
# | 'isLITERAL' '(' + Expression + ')'
# | 'isNUMERIC' '(' + Expression + ')'
# | RegexExpression
# | ExistsFunc
# | NotExistsFunc

BuiltInCall = (
    Aggregate
    | Comp(
        "Builtin_STR", Keyword("STR") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_STR)
    | Comp(
        "Builtin_LANG", Keyword("LANG") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_LANG)
    | Comp(
        "Builtin_LANGMATCHES",
        Keyword("LANGMATCHES")
        + "("
        + Param("arg1", Expression)
        + ","
        + Param("arg2", Expression)
        + ")",
    ).setEvalFn(op.Builtin_LANGMATCHES)
    | Comp(
        "Builtin_DATATYPE", Keyword("DATATYPE") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_DATATYPE)
    | Comp("Builtin_BOUND", Keyword("BOUND") + "(" + Param("arg", Var) + ")").setEvalFn(
        op.Builtin_BOUND
    )
    | Comp(
        "Builtin_IRI", Keyword("IRI") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_IRI)
    | Comp(
        "Builtin_URI", Keyword("URI") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_IRI)
    | Comp(
        "Builtin_BNODE", Keyword("BNODE") + ("(" + Param("arg", Expression) + ")" | NIL)
    ).setEvalFn(op.Builtin_BNODE)
    | Comp("Builtin_RAND", Keyword("RAND") + NIL).setEvalFn(op.Builtin_RAND)
    | Comp(
        "Builtin_ABS", Keyword("ABS") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_ABS)
    | Comp(
        "Builtin_CEIL", Keyword("CEIL") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_CEIL)
    | Comp(
        "Builtin_FLOOR", Keyword("FLOOR") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_FLOOR)
    | Comp(
        "Builtin_ROUND", Keyword("ROUND") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_ROUND)
    | Comp(
        "Builtin_CONCAT", Keyword("CONCAT") + Param("arg", ExpressionList)
    ).setEvalFn(op.Builtin_CONCAT)
    | SubstringExpression
    | Comp(
        "Builtin_STRLEN", Keyword("STRLEN") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_STRLEN)
    | StrReplaceExpression
    | Comp(
        "Builtin_UCASE", Keyword("UCASE") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_UCASE)
    | Comp(
        "Builtin_LCASE", Keyword("LCASE") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_LCASE)
    | Comp(
        "Builtin_ENCODE_FOR_URI",
        Keyword("ENCODE_FOR_URI") + "(" + Param("arg", Expression) + ")",
    ).setEvalFn(op.Builtin_ENCODE_FOR_URI)
    | Comp(
        "Builtin_CONTAINS",
        Keyword("CONTAINS")
        + "("
        + Param("arg1", Expression)
        + ","
        + Param("arg2", Expression)
        + ")",
    ).setEvalFn(op.Builtin_CONTAINS)
    | Comp(
        "Builtin_STRSTARTS",
        Keyword("STRSTARTS")
        + "("
        + Param("arg1", Expression)
        + ","
        + Param("arg2", Expression)
        + ")",
    ).setEvalFn(op.Builtin_STRSTARTS)
    | Comp(
        "Builtin_STRENDS",
        Keyword("STRENDS")
        + "("
        + Param("arg1", Expression)
        + ","
        + Param("arg2", Expression)
        + ")",
    ).setEvalFn(op.Builtin_STRENDS)
    | Comp(
        "Builtin_STRBEFORE",
        Keyword("STRBEFORE")
        + "("
        + Param("arg1", Expression)
        + ","
        + Param("arg2", Expression)
        + ")",
    ).setEvalFn(op.Builtin_STRBEFORE)
    | Comp(
        "Builtin_STRAFTER",
        Keyword("STRAFTER")
        + "("
        + Param("arg1", Expression)
        + ","
        + Param("arg2", Expression)
        + ")",
    ).setEvalFn(op.Builtin_STRAFTER)
    | Comp(
        "Builtin_YEAR", Keyword("YEAR") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_YEAR)
    | Comp(
        "Builtin_MONTH", Keyword("MONTH") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_MONTH)
    | Comp(
        "Builtin_DAY", Keyword("DAY") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_DAY)
    | Comp(
        "Builtin_HOURS", Keyword("HOURS") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_HOURS)
    | Comp(
        "Builtin_MINUTES", Keyword("MINUTES") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_MINUTES)
    | Comp(
        "Builtin_SECONDS", Keyword("SECONDS") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_SECONDS)
    | Comp(
        "Builtin_TIMEZONE", Keyword("TIMEZONE") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_TIMEZONE)
    | Comp(
        "Builtin_TZ", Keyword("TZ") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_TZ)
    | Comp("Builtin_NOW", Keyword("NOW") + NIL).setEvalFn(op.Builtin_NOW)
    | Comp("Builtin_UUID", Keyword("UUID") + NIL).setEvalFn(op.Builtin_UUID)
    | Comp("Builtin_STRUUID", Keyword("STRUUID") + NIL).setEvalFn(op.Builtin_STRUUID)
    | Comp(
        "Builtin_MD5", Keyword("MD5") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_MD5)
    | Comp(
        "Builtin_SHA1", Keyword("SHA1") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_SHA1)
    | Comp(
        "Builtin_SHA256", Keyword("SHA256") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_SHA256)
    | Comp(
        "Builtin_SHA384", Keyword("SHA384") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_SHA384)
    | Comp(
        "Builtin_SHA512", Keyword("SHA512") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_SHA512)
    | Comp(
        "Builtin_COALESCE", Keyword("COALESCE") + Param("arg", ExpressionList)
    ).setEvalFn(op.Builtin_COALESCE)
    | Comp(
        "Builtin_IF",
        Keyword("IF")
        + "("
        + Param("arg1", Expression)
        + ","
        + Param("arg2", Expression)
        + ","
        + Param("arg3", Expression)
        + ")",
    ).setEvalFn(op.Builtin_IF)
    | Comp(
        "Builtin_STRLANG",
        Keyword("STRLANG")
        + "("
        + Param("arg1", Expression)
        + ","
        + Param("arg2", Expression)
        + ")",
    ).setEvalFn(op.Builtin_STRLANG)
    | Comp(
        "Builtin_STRDT",
        Keyword("STRDT")
        + "("
        + Param("arg1", Expression)
        + ","
        + Param("arg2", Expression)
        + ")",
    ).setEvalFn(op.Builtin_STRDT)
    | Comp(
        "Builtin_sameTerm",
        Keyword("sameTerm")
        + "("
        + Param("arg1", Expression)
        + ","
        + Param("arg2", Expression)
        + ")",
    ).setEvalFn(op.Builtin_sameTerm)
    | Comp(
        "Builtin_isIRI", Keyword("isIRI") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_isIRI)
    | Comp(
        "Builtin_isURI", Keyword("isURI") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_isIRI)
    | Comp(
        "Builtin_isBLANK", Keyword("isBLANK") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_isBLANK)
    | Comp(
        "Builtin_isLITERAL", Keyword("isLITERAL") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_isLITERAL)
    | Comp(
        "Builtin_isNUMERIC", Keyword("isNUMERIC") + "(" + Param("arg", Expression) + ")"
    ).setEvalFn(op.Builtin_isNUMERIC)
    | RegexExpression
    | ExistsFunc
    | NotExistsFunc
)

# [71] ArgList ::= NIL | '(' 'DISTINCT'? Expression ( ',' Expression )* ')'
ArgList = (
    NIL
    | "("
    + Param("distinct", _Distinct)
    + DelimitedList(ParamList("expr", Expression))
    + ")"
)

# [128] iriOrFunction ::= iri Optional(ArgList)
iriOrFunction = (
    Comp("Function", Param("iri", iri) + ArgList).setEvalFn(op.Function)
) | iri

# [70] FunctionCall ::= iri ArgList
FunctionCall = Comp("Function", Param("iri", iri) + ArgList).setEvalFn(op.Function)


# [120] BrackettedExpression ::= '(' Expression ')'
BrackettedExpression = Suppress("(") + Expression + Suppress(")")

# [119] PrimaryExpression ::= BrackettedExpression | BuiltInCall | iriOrFunction | RDFLiteral | NumericLiteral | BooleanLiteral | Var
PrimaryExpression = (
    BrackettedExpression
    | BuiltInCall
    | iriOrFunction
    | RDFLiteral
    | NumericLiteral
    | BooleanLiteral
    | Var
)

# [118] UnaryExpression ::= '!' PrimaryExpression
# | '+' PrimaryExpression
# | '-' PrimaryExpression
# | PrimaryExpression
UnaryExpression = (
    Comp("UnaryNot", "!" + Param("expr", PrimaryExpression)).setEvalFn(op.UnaryNot)
    | Comp("UnaryPlus", "+" + Param("expr", PrimaryExpression)).setEvalFn(op.UnaryPlus)
    | Comp("UnaryMinus", "-" + Param("expr", PrimaryExpression)).setEvalFn(
        op.UnaryMinus
    )
    | PrimaryExpression
)

# [117] MultiplicativeExpression ::= UnaryExpression ( '*' UnaryExpression | '/' UnaryExpression )*
MultiplicativeExpression = Comp(
    "MultiplicativeExpression",
    Param("expr", UnaryExpression)
    + ZeroOrMore(
        ParamList("op", "*") + ParamList("other", UnaryExpression)
        | ParamList("op", "/") + ParamList("other", UnaryExpression)
    ),
).setEvalFn(op.MultiplicativeExpression)

# [116] AdditiveExpression ::= MultiplicativeExpression ( '+' MultiplicativeExpression | '-' MultiplicativeExpression | ( NumericLiteralPositive | NumericLiteralNegative ) ( ( '*' UnaryExpression ) | ( '/' UnaryExpression ) )* )*

# NOTE: The second part of this production is there because:
# "In signed numbers, no white space is allowed between the sign and the number. The AdditiveExpression grammar rule allows for this by covering the two cases of an expression followed by a signed number. These produce an addition or subtraction of the unsigned number as appropriate."

# Here (I think) this is not necessary since pyparsing doesn't separate
# tokenizing and parsing


AdditiveExpression = Comp(
    "AdditiveExpression",
    Param("expr", MultiplicativeExpression)
    + ZeroOrMore(
        ParamList("op", "+") + ParamList("other", MultiplicativeExpression)
        | ParamList("op", "-") + ParamList("other", MultiplicativeExpression)
    ),
).setEvalFn(op.AdditiveExpression)


# [115] NumericExpression ::= AdditiveExpression
NumericExpression = AdditiveExpression

# [114] RelationalExpression ::= NumericExpression ( '=' NumericExpression | '!=' NumericExpression | '<' NumericExpression | '>' NumericExpression | '<=' NumericExpression | '>=' NumericExpression | 'IN' ExpressionList | 'NOT' 'IN' ExpressionList )?
RelationalExpression = Comp(
    "RelationalExpression",
    Param("expr", NumericExpression)
    + Optional(
        Param("op", "=") + Param("other", NumericExpression)
        | Param("op", "!=") + Param("other", NumericExpression)
        | Param("op", "<") + Param("other", NumericExpression)
        | Param("op", ">") + Param("other", NumericExpression)
        | Param("op", "<=") + Param("other", NumericExpression)
        | Param("op", ">=") + Param("other", NumericExpression)
        | Param("op", Keyword("IN")) + Param("other", ExpressionList)
        | Param(
            "op",
            Combine(
                Keyword("NOT") + Keyword("IN"),
                adjacent=False,
                **combine_join_kwargs(" "),
            ),
        )
        + Param("other", ExpressionList)
    ),
).setEvalFn(op.RelationalExpression)


# [113] ValueLogical ::= RelationalExpression
ValueLogical = RelationalExpression

# [112] ConditionalAndExpression ::= ValueLogical ( '&&' ValueLogical )*
ConditionalAndExpression = Comp(
    "ConditionalAndExpression",
    Param("expr", ValueLogical) + ZeroOrMore("&&" + ParamList("other", ValueLogical)),
).setEvalFn(op.ConditionalAndExpression)

# [111] ConditionalOrExpression ::= ConditionalAndExpression ( '||' ConditionalAndExpression )*
ConditionalOrExpression = Comp(
    "ConditionalOrExpression",
    Param("expr", ConditionalAndExpression)
    + ZeroOrMore("||" + ParamList("other", ConditionalAndExpression)),
).setEvalFn(op.ConditionalOrExpression)

# [110] Expression ::= ConditionalOrExpression
Expression <<= ConditionalOrExpression


# [69] Constraint ::= BrackettedExpression | BuiltInCall | FunctionCall
Constraint = BrackettedExpression | BuiltInCall | FunctionCall

# [68] Filter ::= 'FILTER' Constraint
Filter = Comp("Filter", Keyword("FILTER") + Param("expr", Constraint))


# [16] SourceSelector ::= iri
SourceSelector = iri

# [14] DefaultGraphClause ::= SourceSelector
DefaultGraphClause = SourceSelector

# [15] NamedGraphClause ::= 'NAMED' SourceSelector
NamedGraphClause = Keyword("NAMED") + Param("named", SourceSelector)

# [13] DatasetClause ::= 'FROM' ( DefaultGraphClause | NamedGraphClause )
DatasetClause = Comp(
    "DatasetClause",
    Keyword("FROM") + (Param("default", DefaultGraphClause) | NamedGraphClause),
)

# [20] GroupCondition ::= BuiltInCall | FunctionCall | '(' Expression ( 'AS' Var )? ')' | Var
GroupCondition = (
    BuiltInCall
    | FunctionCall
    | Comp(
        "GroupAs",
        "("
        + Param("expr", Expression)
        + Optional(Keyword("AS") + Param("var", Var))
        + ")",
    )
    | Var
)

# [19] GroupClause ::= 'GROUP' 'BY' GroupCondition+
GroupClause = Comp(
    "GroupClause",
    Keyword("GROUP")
    + Keyword("BY")
    + OneOrMore(ParamList("condition", GroupCondition)),
)


_Silent = Optional(Param("silent", Keyword("SILENT")))

# [31] Load ::= 'LOAD' 'SILENT'? iri ( 'INTO' GraphRef )?
Load = Comp(
    "Load",
    Keyword("LOAD")
    + _Silent
    + Param("iri", iri)
    + Optional(Keyword("INTO") + GraphRef),
)

# [32] Clear ::= 'CLEAR' 'SILENT'? GraphRefAll
Clear = Comp("Clear", Keyword("CLEAR") + _Silent + GraphRefAll)

# [33] Drop ::= 'DROP' _Silent GraphRefAll
Drop = Comp("Drop", Keyword("DROP") + _Silent + GraphRefAll)

# [34] Create ::= 'CREATE' _Silent GraphRef
Create = Comp("Create", Keyword("CREATE") + _Silent + GraphRef)

# [35] Add ::= 'ADD' _Silent GraphOrDefault 'TO' GraphOrDefault
Add = Comp(
    "Add", Keyword("ADD") + _Silent + GraphOrDefault + Keyword("TO") + GraphOrDefault
)

# [36] Move ::= 'MOVE' _Silent GraphOrDefault 'TO' GraphOrDefault
Move = Comp(
    "Move", Keyword("MOVE") + _Silent + GraphOrDefault + Keyword("TO") + GraphOrDefault
)

# [37] Copy ::= 'COPY' _Silent GraphOrDefault 'TO' GraphOrDefault
Copy = Comp(
    "Copy", Keyword("COPY") + _Silent + GraphOrDefault + Keyword("TO") + GraphOrDefault
)

# [38] InsertData ::= 'INSERT DATA' QuadData
InsertData = Comp("InsertData", Keyword("INSERT") + Keyword("DATA") + QuadData)

# [39] DeleteData ::= 'DELETE DATA' QuadData
DeleteData = Comp("DeleteData", Keyword("DELETE") + Keyword("DATA") + QuadData)

# [40] DeleteWhere ::= 'DELETE WHERE' QuadPattern
DeleteWhere = Comp("DeleteWhere", Keyword("DELETE") + Keyword("WHERE") + QuadPattern)

# [42] DeleteClause ::= 'DELETE' QuadPattern
DeleteClause = Comp("DeleteClause", Keyword("DELETE") + QuadPattern)

# [43] InsertClause ::= 'INSERT' QuadPattern
InsertClause = Comp("InsertClause", Keyword("INSERT") + QuadPattern)

# [44] UsingClause ::= 'USING' ( iri | 'NAMED' iri )
UsingClause = Comp(
    "UsingClause",
    Keyword("USING") + (Param("default", iri) | Keyword("NAMED") + Param("named", iri)),
)

# [41] Modify ::= ( 'WITH' iri )? ( DeleteClause Optional(InsertClause) | InsertClause ) ZeroOrMore(UsingClause) 'WHERE' GroupGraphPattern
Modify = Comp(
    "Modify",
    Optional(Keyword("WITH") + Param("withClause", iri))
    + (
        Param("delete", DeleteClause) + Optional(Param("insert", InsertClause))
        | Param("insert", InsertClause)
    )
    + ZeroOrMore(ParamList("using", UsingClause))
    + Keyword("WHERE")
    + Param("where", GroupGraphPattern),
)


# [30] Update1 ::= Load | Clear | Drop | Add | Move | Copy | Create | InsertData | DeleteData | DeleteWhere | Modify
Update1 = (
    Load
    | Clear
    | Drop
    | Add
    | Move
    | Copy
    | Create
    | InsertData
    | DeleteData
    | DeleteWhere
    | Modify
)


# [63] InlineDataOneVar ::= Var '{' ZeroOrMore(DataBlockValue) '}'
InlineDataOneVar = (
    ParamList("var", Var) + "{" + ZeroOrMore(ParamList("value", DataBlockValue)) + "}"
)

# [64] InlineDataFull ::= ( NIL | '(' ZeroOrMore(Var) ')' ) '{' ( '(' ZeroOrMore(DataBlockValue) ')' | NIL )* '}'
InlineDataFull = (
    (NIL | "(" + ZeroOrMore(ParamList("var", Var)) + ")")
    + "{"
    + ZeroOrMore(
        ParamList(
            "value",
            Group(Suppress("(") + ZeroOrMore(DataBlockValue) + Suppress(")") | NIL),
        )
    )
    + "}"
)

# [62] DataBlock ::= InlineDataOneVar | InlineDataFull
DataBlock = InlineDataOneVar | InlineDataFull


# [28] ValuesClause ::= ( 'VALUES' DataBlock )?
ValuesClause = Optional(
    Param("valuesClause", Comp("ValuesClause", Keyword("VALUES") + DataBlock))
)


# [74] ConstructTriples ::= TriplesSameSubject ( '.' Optional(ConstructTriples) )?
ConstructTriples = Forward()
ConstructTriples <<= ParamList("template", TriplesSameSubject) + Optional(
    Suppress(".") + Optional(ConstructTriples)
)

# [73] ConstructTemplate ::= '{' Optional(ConstructTriples) '}'
ConstructTemplate = Suppress("{") + Optional(ConstructTriples) + Suppress("}")


# [57] OptionalGraphPattern ::= 'OPTIONAL' GroupGraphPattern
OptionalGraphPattern = Comp(
    "OptionalGraphPattern", Keyword("OPTIONAL") + Param("graph", GroupGraphPattern)
)

# [58] GraphGraphPattern ::= 'GRAPH' VarOrIri GroupGraphPattern
GraphGraphPattern = Comp(
    "GraphGraphPattern",
    Keyword("GRAPH") + Param("term", VarOrIri) + Param("graph", GroupGraphPattern),
)

# [59] ServiceGraphPattern ::= 'SERVICE' _Silent VarOrIri GroupGraphPattern
ServiceGraphPattern = Comp(
    "ServiceGraphPattern",
    Keyword("SERVICE")
    + _Silent
    + Param("term", VarOrIri)
    + Param("graph", GroupGraphPattern),
)

# [60] Bind ::= 'BIND' '(' Expression 'AS' Var ')'
Bind = Comp(
    "Bind",
    Keyword("BIND")
    + "("
    + Param("expr", Expression)
    + Keyword("AS")
    + Param("var", Var)
    + ")",
)

# [61] InlineData ::= 'VALUES' DataBlock
InlineData = Comp("InlineData", Keyword("VALUES") + DataBlock)

# [56] GraphPatternNotTriples ::= GroupOrUnionGraphPattern | OptionalGraphPattern | MinusGraphPattern | GraphGraphPattern | ServiceGraphPattern | Filter | Bind | InlineData
GraphPatternNotTriples = (
    GroupOrUnionGraphPattern
    | OptionalGraphPattern
    | MinusGraphPattern
    | GraphGraphPattern
    | ServiceGraphPattern
    | Filter
    | Bind
    | InlineData
)

# [54] GroupGraphPatternSub ::= Optional(TriplesBlock) ( GraphPatternNotTriples '.'? Optional(TriplesBlock) )*
GroupGraphPatternSub = Comp(
    "GroupGraphPatternSub",
    Optional(ParamList("part", Comp("TriplesBlock", TriplesBlock)))
    + ZeroOrMore(
        ParamList("part", GraphPatternNotTriples)
        + Optional(".")
        + Optional(ParamList("part", Comp("TriplesBlock", TriplesBlock)))
    ),
)


# ----------------
# [22] HavingCondition ::= Constraint
HavingCondition = Constraint

# [21] HavingClause ::= 'HAVING' HavingCondition+
HavingClause = Comp(
    "HavingClause",
    Keyword("HAVING") + OneOrMore(ParamList("condition", HavingCondition)),
)

# [24] OrderCondition ::= ( ( 'ASC' | 'DESC' ) BrackettedExpression )
# | ( Constraint | Var )
OrderCondition = Comp(
    "OrderCondition",
    Param("order", Keyword("ASC") | Keyword("DESC"))
    + Param("expr", BrackettedExpression)
    | Param("expr", Constraint | Var),
)

# [23] OrderClause ::= 'ORDER' 'BY' OneOrMore(OrderCondition)
OrderClause = Comp(
    "OrderClause",
    Keyword("ORDER")
    + Keyword("BY")
    + OneOrMore(ParamList("condition", OrderCondition)),
)

# [26] LimitClause ::= 'LIMIT' INTEGER
LimitClause = Keyword("LIMIT") + Param("limit", INTEGER)

# [27] OffsetClause ::= 'OFFSET' INTEGER
OffsetClause = Keyword("OFFSET") + Param("offset", INTEGER)

# [25] LimitOffsetClauses ::= LimitClause Optional(OffsetClause) | OffsetClause Optional(LimitClause)
LimitOffsetClauses = Comp(
    "LimitOffsetClauses",
    LimitClause + Optional(OffsetClause) | OffsetClause + Optional(LimitClause),
)

# [18] SolutionModifier ::= GroupClause? HavingClause? OrderClause? LimitOffsetClauses?
SolutionModifier = (
    Optional(Param("groupby", GroupClause))
    + Optional(Param("having", HavingClause))
    + Optional(Param("orderby", OrderClause))
    + Optional(Param("limitoffset", LimitOffsetClauses))
)


# [9] SelectClause ::= 'SELECT' ( 'DISTINCT' | 'REDUCED' )? ( ( Var | ( '(' Expression 'AS' Var ')' ) )+ | '*' )
SelectClause = (
    Keyword("SELECT")
    + Optional(Param("modifier", Keyword("DISTINCT") | Keyword("REDUCED")))
    + (
        OneOrMore(
            ParamList(
                "projection",
                Comp(
                    "vars",
                    Param("var", Var)
                    | (
                        Literal("(")
                        + Param("expr", Expression)
                        + Keyword("AS")
                        + Param("evar", Var)
                        + ")"
                    ),
                ),
            )
        )
        | "*"
    )
)

# [17] WhereClause ::= 'WHERE'? GroupGraphPattern
WhereClause = Optional(Keyword("WHERE")) + Param("where", GroupGraphPattern)

# [8] SubSelect ::= SelectClause WhereClause SolutionModifier ValuesClause
SubSelect = Comp(
    "SubSelect", SelectClause + WhereClause + SolutionModifier + ValuesClause
)

# [53] GroupGraphPattern ::= '{' ( SubSelect | GroupGraphPatternSub ) '}'
GroupGraphPattern <<= Suppress("{") + (SubSelect | GroupGraphPatternSub) + Suppress("}")

# [7] SelectQuery ::= SelectClause DatasetClause* WhereClause SolutionModifier
SelectQuery = Comp(
    "SelectQuery",
    SelectClause
    + ZeroOrMore(ParamList("datasetClause", DatasetClause))
    + WhereClause
    + SolutionModifier
    + ValuesClause,
)

# [10] ConstructQuery ::= 'CONSTRUCT' ( ConstructTemplate DatasetClause* WhereClause SolutionModifier | DatasetClause* 'WHERE' '{' TriplesTemplate? '}' SolutionModifier )
# NOTE: The CONSTRUCT WHERE alternative has unnecessarily many Comp/Param pairs
# to allow it to through the same algebra translation process
ConstructQuery = Comp(
    "ConstructQuery",
    Keyword("CONSTRUCT")
    + (
        ConstructTemplate
        + ZeroOrMore(ParamList("datasetClause", DatasetClause))
        + WhereClause
        + SolutionModifier
        + ValuesClause
        | ZeroOrMore(ParamList("datasetClause", DatasetClause))
        + Keyword("WHERE")
        + "{"
        + Optional(
            Param(
                "where",
                Comp(
                    "FakeGroupGraphPatten",
                    ParamList("part", Comp("TriplesBlock", TriplesTemplate)),
                ),
            )
        )
        + "}"
        + SolutionModifier
        + ValuesClause
    ),
)

# [12] AskQuery ::= 'ASK' DatasetClause* WhereClause SolutionModifier
AskQuery = Comp(
    "AskQuery",
    Keyword("ASK")
    + ZeroOrMore(ParamList("datasetClause", DatasetClause))
    + WhereClause
    + SolutionModifier
    + ValuesClause,
)

# [11] DescribeQuery ::= 'DESCRIBE' ( VarOrIri+ | '*' ) DatasetClause* WhereClause? SolutionModifier
DescribeQuery = Comp(
    "DescribeQuery",
    Keyword("DESCRIBE")
    + (OneOrMore(ParamList("var", VarOrIri)) | "*")
    + ZeroOrMore(ParamList("datasetClause", DatasetClause))
    + Optional(WhereClause)
    + SolutionModifier
    + ValuesClause,
)

# [29] Update ::= Prologue ( Update1 ( ';' Update )? )?
Update = Forward()
Update <<= ParamList("prologue", Prologue) + Optional(
    ParamList("request", Update1) + Optional(";" + Update)
)


# [2] Query ::= Prologue
# ( SelectQuery | ConstructQuery | DescribeQuery | AskQuery )
# ValuesClause
# NOTE: ValuesClause was moved to individual queries
Query = Prologue + (SelectQuery | ConstructQuery | DescribeQuery | AskQuery)

# [3] UpdateUnit ::= Update
UpdateUnit = Comp("Update", Update)

# [1] QueryUnit ::= Query
QueryUnit = Query

QueryUnit.ignore("#" + rest_of_line)
UpdateUnit.ignore("#" + rest_of_line)


expandUnicodeEscapes_re: re.Pattern = re.compile(
    r"\\u([0-9a-f]{4}(?:[0-9a-f]{4})?)", flags=re.I
)


def expandUnicodeEscapes(q: str) -> str:
    r"""
    The syntax of the SPARQL Query Language is expressed over code points in Unicode [UNICODE]. The encoding is always UTF-8 [RFC3629].
    Unicode code points may also be expressed using an \ uXXXX (U+0 to U+FFFF) or \ UXXXXXXXX syntax (for U+10000 onwards) where X is a hexadecimal digit [0-9A-F]
    """

    def expand(m: re.Match) -> str:
        try:
            return chr(int(m.group(1), 16))
        except (ValueError, OverflowError) as e:
            raise ValueError("Invalid unicode code point: " + m.group(1)) from e

    return expandUnicodeEscapes_re.sub(expand, q)


def parseQuery(q: Union[str, bytes, TextIO, BinaryIO]) -> ParseResults:
    if hasattr(q, "read"):
        q = q.read()
    if isinstance(q, bytes):
        q = q.decode("utf-8")

    q = expandUnicodeEscapes(q)
    return Query.parse_string(q, parse_all=True)


def parseUpdate(q: Union[str, bytes, TextIO, BinaryIO]) -> CompValue:
    if hasattr(q, "read"):
        q = q.read()

    if isinstance(q, bytes):
        q = q.decode("utf-8")

    q = expandUnicodeEscapes(q)
    return UpdateUnit.parse_string(q, parse_all=True)[0]
