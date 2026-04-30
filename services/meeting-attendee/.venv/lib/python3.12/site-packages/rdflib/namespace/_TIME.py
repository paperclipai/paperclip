from rdflib.namespace import DefinedNamespace, Namespace
from rdflib.term import URIRef


class TIME(DefinedNamespace):
    """
    OWL-Time

    Generated from: http://www.w3.org/2006/time#
    Date: 2020-05-26 14:20:10.531265

    """

    # http://www.w3.org/2000/01/rdf-schema#Datatype
    generalDay: URIRef  # Day of month - formulated as a text string with a pattern constraint to reproduce the same lexical form as gDay, except that values up to 99 are permitted, in order to support calendars with more than 31 days in a month.  Note that the value-space is not defined, so a generic OWL2 processor cannot compute ordering relationships of values of this type.
    generalMonth: URIRef  # Month of year - formulated as a text string with a pattern constraint to reproduce the same lexical form as gMonth, except that values up to 20 are permitted, in order to support calendars with more than 12 months in the year.  Note that the value-space is not defined, so a generic OWL2 processor cannot compute ordering relationships of values of this type.
    generalYear: URIRef  # Year number - formulated as a text string with a pattern constraint to reproduce the same lexical form as gYear, but not restricted to values from the Gregorian calendar.  Note that the value-space is not defined, so a generic OWL2 processor cannot compute ordering relationships of values of this type.

    # http://www.w3.org/2002/07/owl#Class
    DateTimeDescription: URIRef  # Description of date and time structured with separate values for the various elements of a calendar-clock system. The temporal reference system is fixed to Gregorian Calendar, and the range of year, month, day properties restricted to corresponding XML Schema types xsd:gYear, xsd:gMonth and xsd:gDay, respectively.
    DateTimeInterval: URIRef  # DateTimeInterval is a subclass of ProperInterval, defined using the multi-element DateTimeDescription.
    DayOfWeek: URIRef  # The day of week
    Duration: URIRef  # Duration of a temporal extent expressed as a number scaled by a temporal unit
    DurationDescription: URIRef  # Description of temporal extent structured with separate values for the various elements of a calendar-clock system. The temporal reference system is fixed to Gregorian Calendar, and the range of each of the numeric properties is restricted to xsd:decimal
    GeneralDateTimeDescription: URIRef  # Description of date and time structured with separate values for the various elements of a calendar-clock system
    GeneralDurationDescription: URIRef  # Description of temporal extent structured with separate values for the various elements of a calendar-clock system.
    Instant: URIRef  # A temporal entity with zero extent or duration
    Interval: URIRef  # A temporal entity with an extent or duration
    MonthOfYear: URIRef  # The month of the year
    ProperInterval: URIRef  # A temporal entity with non-zero extent or duration, i.e. for which the value of the beginning and end are different
    TRS: URIRef  # A temporal reference system, such as a temporal coordinate system (with an origin, direction, and scale), a calendar-clock combination, or a (possibly hierarchical) ordinal system.   This is a stub class, representing the set of all temporal reference systems.
    TemporalDuration: URIRef  # Time extent; duration of a time interval separate from its particular start position
    TemporalEntity: URIRef  # A temporal interval or instant.
    TemporalPosition: URIRef  # A position on a time-line
    TemporalUnit: URIRef  # A standard duration, which provides a scale factor for a time extent, or the granularity or precision for a time position.
    TimePosition: URIRef  # A temporal position described using either a (nominal) value from an ordinal reference system, or a (numeric) value in a temporal coordinate system.
    TimeZone: URIRef  # A Time Zone specifies the amount by which the local time is offset from UTC.  	A time zone is usually denoted geographically (e.g. Australian Eastern Daylight Time), with a constant value in a given region.  The region where it applies and the offset from UTC are specified by a locally recognised governing authority.

    # http://www.w3.org/2002/07/owl#DatatypeProperty
    day: URIRef  # Day position in a calendar-clock system.  The range of this property is not specified, so can be replaced by any specific representation of a calendar day from any calendar.
    dayOfYear: URIRef  # The number of the day within the year
    days: URIRef  # length of, or element of the length of, a temporal extent expressed in days
    hasXSDDuration: URIRef  # Extent of a temporal entity, expressed using xsd:duration
    hour: URIRef  # Hour position in a calendar-clock system.
    hours: URIRef  # length of, or element of the length of, a temporal extent expressed in hours
    inXSDDate: URIRef  # Position of an instant, expressed using xsd:date
    inXSDDateTimeStamp: (
        URIRef  # Position of an instant, expressed using xsd:dateTimeStamp
    )
    inXSDgYear: URIRef  # Position of an instant, expressed using xsd:gYear
    inXSDgYearMonth: URIRef  # Position of an instant, expressed using xsd:gYearMonth
    minute: URIRef  # Minute position in a calendar-clock system.
    minutes: URIRef  # length, or element of, a temporal extent expressed in minutes
    month: URIRef  # Month position in a calendar-clock system.  The range of this property is not specified, so can be replaced by any specific representation of a calendar month from any calendar.
    months: URIRef  # length of, or element of the length of, a temporal extent expressed in months
    nominalPosition: URIRef  # The (nominal) value indicating temporal position in an ordinal reference system
    numericDuration: URIRef  # Value of a temporal extent expressed as a decimal number scaled by a temporal unit
    numericPosition: URIRef  # The (numeric) value indicating position within a temporal coordinate system
    second: URIRef  # Second position in a calendar-clock system.
    seconds: URIRef  # length of, or element of the length of, a temporal extent expressed in seconds
    week: URIRef  # Week number within the year.
    weeks: URIRef  # length of, or element of the length of, a temporal extent expressed in weeks
    year: URIRef  # Year position in a calendar-clock system.  The range of this property is not specified, so can be replaced by any specific representation of a calendar year from any calendar.
    years: URIRef  # length of, or element of the length of, a temporal extent expressed in years

    # http://www.w3.org/2002/07/owl#DeprecatedClass
    January: URIRef  # January
    Year: URIRef  # Year duration

    # http://www.w3.org/2002/07/owl#DeprecatedProperty
    inXSDDateTime: URIRef  # Position of an instant, expressed using xsd:dateTime
    xsdDateTime: URIRef  # Value of DateTimeInterval expressed as a compact value.

    # http://www.w3.org/2002/07/owl#FunctionalProperty
    hasTRS: URIRef  # The temporal reference system used by a temporal position or extent description.

    # http://www.w3.org/2002/07/owl#ObjectProperty
    after: URIRef  # Gives directionality to time. If a temporal entity T1 is after another temporal entity T2, then the beginning of T1 is after the end of T2.
    dayOfWeek: (
        URIRef  # The day of week, whose value is a member of the class time:DayOfWeek
    )
    hasBeginning: URIRef  # Beginning of a temporal entity.
    hasDateTimeDescription: URIRef  # Value of DateTimeInterval expressed as a structured value. The beginning and end of the interval coincide with the limits of the shortest element in the description.
    hasDuration: URIRef  # Duration of a temporal entity, event or activity, or thing, expressed as a scaled value
    hasDurationDescription: URIRef  # Duration of a temporal entity, expressed using a structured description
    hasEnd: URIRef  # End of a temporal entity.
    hasTemporalDuration: URIRef  # Duration of a temporal entity.
    hasTime: URIRef  # Supports the association of a temporal entity (instant or interval) to any thing
    inDateTime: (
        URIRef  # Position of an instant, expressed using a structured description
    )
    inTemporalPosition: URIRef  # Position of a time instant
    inTimePosition: URIRef  # Position of a time instant expressed as a TimePosition
    inside: URIRef  # An instant that falls inside the interval. It is not intended to include beginnings and ends of intervals.
    intervalAfter: URIRef  # If a proper interval T1 is intervalAfter another proper interval T2, then the beginning of T1 is after the end of T2.
    intervalBefore: URIRef  # If a proper interval T1 is intervalBefore another proper interval T2, then the end of T1 is before the beginning of T2.
    intervalContains: URIRef  # If a proper interval T1 is intervalContains another proper interval T2, then the beginning of T1 is before the beginning of T2, and the end of T1 is after the end of T2.
    intervalDisjoint: URIRef  # If a proper interval T1 is intervalDisjoint another proper interval T2, then the beginning of T1 is after the end of T2, or the end of T1 is before the beginning of T2, i.e. the intervals do not overlap in any way, but their ordering relationship is not known.
    intervalDuring: URIRef  # If a proper interval T1 is intervalDuring another proper interval T2, then the beginning of T1 is after the beginning of T2, and the end of T1 is before the end of T2.
    intervalEquals: URIRef  # If a proper interval T1 is intervalEquals another proper interval T2, then the beginning of T1 is coincident with the beginning of T2, and the end of T1 is coincident with the end of T2.
    intervalFinishedBy: URIRef  # If a proper interval T1 is intervalFinishedBy another proper interval T2, then the beginning of T1 is before the beginning of T2, and the end of T1 is coincident with the end of T2.
    intervalFinishes: URIRef  # If a proper interval T1 is intervalFinishes another proper interval T2, then the beginning of T1 is after the beginning of T2, and the end of T1 is coincident with the end of T2.
    intervalIn: URIRef  # If a proper interval T1 is intervalIn another proper interval T2, then the beginning of T1 is after the beginning of T2 or is coincident with the beginning of T2, and the end of T1 is before the end of T2, or is coincident with the end of T2, except that end of T1 may not be coincident with the end of T2 if the beginning of T1 is coincident with the beginning of T2.
    intervalMeets: URIRef  # If a proper interval T1 is intervalMeets another proper interval T2, then the end of T1 is coincident with the beginning of T2.
    intervalMetBy: URIRef  # If a proper interval T1 is intervalMetBy another proper interval T2, then the beginning of T1 is coincident with the end of T2.
    intervalOverlappedBy: URIRef  # If a proper interval T1 is intervalOverlappedBy another proper interval T2, then the beginning of T1 is after the beginning of T2, the beginning of T1 is before the end of T2, and the end of T1 is after the end of T2.
    intervalOverlaps: URIRef  # If a proper interval T1 is intervalOverlaps another proper interval T2, then the beginning of T1 is before the beginning of T2, the end of T1 is after the beginning of T2, and the end of T1 is before the end of T2.
    intervalStartedBy: URIRef  # If a proper interval T1 is intervalStarted another proper interval T2, then the beginning of T1 is coincident with the beginning of T2, and the end of T1 is after the end of T2.
    intervalStarts: URIRef  # If a proper interval T1 is intervalStarts another proper interval T2, then the beginning of T1 is coincident with the beginning of T2, and the end of T1 is before the end of T2.
    monthOfYear: URIRef  # The month of the year, whose value is a member of the class time:MonthOfYear
    timeZone: URIRef  # The time zone for clock elements in the temporal position
    unitType: URIRef  # The temporal unit which provides the precision of a date-time value or scale of a temporal extent

    # http://www.w3.org/2002/07/owl#TransitiveProperty
    before: URIRef  # Gives directionality to time. If a temporal entity T1 is before another temporal entity T2, then the end of T1 is before the beginning of T2. Thus, "before" can be considered to be basic to instants and derived for intervals.

    # http://www.w3.org/2006/time#DayOfWeek
    Friday: URIRef  # Friday
    Monday: URIRef  # Monday
    Saturday: URIRef  # Saturday
    Sunday: URIRef  # Sunday
    Thursday: URIRef  # Thursday
    Tuesday: URIRef  # Tuesday
    Wednesday: URIRef  # Wednesday

    # http://www.w3.org/2006/time#TemporalUnit
    unitDay: URIRef  # day
    unitHour: URIRef  # hour
    unitMinute: URIRef  # minute
    unitMonth: URIRef  # month
    unitSecond: URIRef  # second
    unitWeek: URIRef  # week
    unitYear: URIRef  # year

    _NS = Namespace("http://www.w3.org/2006/time#")
