from rdflib.namespace import DefinedNamespace, Namespace
from rdflib.term import URIRef


class XSD(DefinedNamespace):
    """
    W3C XML Schema Definition Language (XSD) 1.1 Part 2: Datatypes

    Generated from: ../schemas/datatypes.xsd
    Date: 2021-09-05 20:37+10

    """

    _NS = Namespace("http://www.w3.org/2001/XMLSchema#")

    ENTITIES: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#ENTITIES
    ENTITY: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#ENTITY
    ID: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#ID
    IDREF: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#IDREF
    IDREFS: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#IDREFS
    NCName: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#NCName
    NMTOKEN: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#NMTOKEN
    NMTOKENS: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#NMTOKENS
    NOTATION: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#NOTATIONNOTATION cannot be used directly in a schema; rather a type
    Name: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#Name
    QName: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#QName
    anyURI: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#anyURI
    base64Binary: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#base64Binary
    boolean: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#boolean
    byte: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#byte
    date: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#date
    dateTime: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#dateTime
    dateTimeStamp: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#dateTimeStamp
    dayTimeDuration: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#dayTimeDuration
    decimal: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#decimal
    double: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#double
    duration: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#duration
    float: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#float
    gDay: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#gDay
    gMonth: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#gMonth
    gMonthDay: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#gMonthDay
    gYear: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#gYear
    gYearMonth: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#gYearMonth
    hexBinary: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#binary
    int: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#int
    integer: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#integer
    language: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#language
    long: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#long
    negativeInteger: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#negativeInteger
    nonNegativeInteger: (
        URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#nonNegativeInteger
    )
    nonPositiveInteger: (
        URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#nonPositiveInteger
    )
    normalizedString: (
        URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#normalizedString
    )
    positiveInteger: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#positiveInteger
    short: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#short
    string: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#string
    time: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#time
    token: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#token
    unsignedByte: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#unsignedByte
    unsignedInt: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#unsignedInt
    unsignedLong: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#unsignedLong
    unsignedShort: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#unsignedShort
    yearMonthDuration: (
        URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#yearMonthDuration
    )

    # fundamental facets - https://www.w3.org/TR/xmlschema11-2/#rf-fund-facets
    ordered: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#rf-ordered
    bounded: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#rf-bounded
    cardinality: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#rf-cardinality
    numeric: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#rf-numeric

    # constraining facets - https://www.w3.org/TR/xmlschema11-2/#rf-facets
    length: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#rf-length
    minLength: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#rf-minLength
    maxLength: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#rf-maxLength
    pattern: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#rf-pattern
    enumeration: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#rf-enumeration
    whiteSpace: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#rf-whiteSpace
    maxExclusive: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#rf-maxExclusive
    maxInclusive: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#rf-maxInclusive
    minExclusive: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#rf-minExclusive
    minInclusive: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#rf-minInclusive
    totalDigits: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#rf-totalDigits
    fractionDigits: URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#rf-fractionDigits
    Assertions: URIRef  # see: https://www.w3.org/TR/xmlschema11-2/#rf-assertions
    explicitTimezone: (
        URIRef  # see: http://www.w3.org/TR/xmlschema11-2/#rf-explicitTimezone
    )

    # The Seven-property Model - https://www.w3.org/TR/xmlschema11-2/#theSevenPropertyModel
    year: URIRef  # see: https://www.w3.org/TR/xmlschema11-2/#vp-dt-http://www.w3.org/TR/xmlschema11-2/#rf-whiteSpace
    month: URIRef  # see: https://www.w3.org/TR/xmlschema11-2/#vp-dt-month
    day: URIRef  # see: https://www.w3.org/TR/xmlschema11-2/#vp-dt-day
    hour: URIRef  # see: https://www.w3.org/TR/xmlschema11-2/#vp-dt-hour
    minute: URIRef  # see: https://www.w3.org/TR/xmlschema11-2/#vp-dt-minute
    second: URIRef  # see: https://www.w3.org/TR/xmlschema11-2/#vp-dt-second
    timezoneOffset: URIRef  # see: https://www.w3.org/TR/xmlschema11-2/#vp-dt-timezone
