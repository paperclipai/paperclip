"""
Test runner for the JSON Schema official test suite

Tests comprehensive correctness of each draft's validator.

See https://github.com/json-schema-org/JSON-Schema-Test-Suite for details.
"""


from jsonschema.tests._suite import Suite
import jsonschema

SUITE = Suite()
DRAFT3 = SUITE.version(name="draft3")
DRAFT4 = SUITE.version(name="draft4")
DRAFT6 = SUITE.version(name="draft6")
DRAFT7 = SUITE.version(name="draft7")
DRAFT201909 = SUITE.version(name="draft2019-09")
DRAFT202012 = SUITE.version(name="draft2020-12")


def skip(message, **kwargs):
    def skipper(test):
        if all(value == getattr(test, attr) for attr, value in kwargs.items()):
            return message
    return skipper


def ecmascript_regex(test):
    if test.subject == "ecmascript-regex":
        return "ECMA regex support will be added in #1142."


def missing_format(Validator):
    def missing_format(test):  # pragma: no cover
        schema = test.schema
        if (
            schema is True
            or schema is False
            or "format" not in schema
            or schema["format"] in Validator.FORMAT_CHECKER.checkers
            or test.valid
        ):
            return

        return f"Format checker {schema['format']!r} not found."
    return missing_format


def complex_email_validation(test):
    if test.subject != "email":
        return

    message = "Complex email validation is (intentionally) unsupported."
    return skip(
        message=message,
        description="an invalid domain",
    )(test) or skip(
        message=message,
        description="an invalid IPv4-address-literal",
    )(test) or skip(
        message=message,
        description="dot after local part is not valid",
    )(test) or skip(
        message=message,
        description="dot before local part is not valid",
    )(test) or skip(
        message=message,
        description="two subsequent dots inside local part are not valid",
    )(test)


def leap_second(test):
    message = "Leap seconds are unsupported."
    return skip(
        message=message,
        subject="time",
        description="a valid time string with leap second",
    )(test) or skip(
        message=message,
        subject="time",
        description="a valid time string with leap second, Zulu",
    )(test) or skip(
        message=message,
        subject="time",
        description="a valid time string with leap second with offset",
    )(test) or skip(
        message=message,
        subject="time",
        description="valid leap second, positive time-offset",
    )(test) or skip(
        message=message,
        subject="time",
        description="valid leap second, negative time-offset",
    )(test) or skip(
        message=message,
        subject="time",
        description="valid leap second, large positive time-offset",
    )(test) or skip(
        message=message,
        subject="time",
        description="valid leap second, large negative time-offset",
    )(test) or skip(
        message=message,
        subject="time",
        description="valid leap second, zero time-offset",
    )(test) or skip(
        message=message,
        subject="date-time",
        description="a valid date-time with a leap second, UTC",
    )(test) or skip(
        message=message,
        subject="date-time",
        description="a valid date-time with a leap second, with minus offset",
    )(test)


TestDraft3 = DRAFT3.to_unittest_testcase(
    DRAFT3.cases(),
    DRAFT3.format_cases(),
    DRAFT3.optional_cases_of(name="bignum"),
    DRAFT3.optional_cases_of(name="non-bmp-regex"),
    DRAFT3.optional_cases_of(name="zeroTerminatedFloats"),
    Validator=jsonschema.Draft3Validator,
    format_checker=jsonschema.Draft3Validator.FORMAT_CHECKER,
    skip=lambda test: (
        ecmascript_regex(test)
        or missing_format(jsonschema.Draft3Validator)(test)
        or complex_email_validation(test)
    ),
)


TestDraft4 = DRAFT4.to_unittest_testcase(
    DRAFT4.cases(),
    DRAFT4.format_cases(),
    DRAFT4.optional_cases_of(name="bignum"),
    DRAFT4.optional_cases_of(name="float-overflow"),
    DRAFT4.optional_cases_of(name="id"),
    DRAFT4.optional_cases_of(name="non-bmp-regex"),
    DRAFT4.optional_cases_of(name="zeroTerminatedFloats"),
    Validator=jsonschema.Draft4Validator,
    format_checker=jsonschema.Draft4Validator.FORMAT_CHECKER,
    skip=lambda test: (
        ecmascript_regex(test)
        or leap_second(test)
        or missing_format(jsonschema.Draft4Validator)(test)
        or complex_email_validation(test)
    ),
)


TestDraft6 = DRAFT6.to_unittest_testcase(
    DRAFT6.cases(),
    DRAFT6.format_cases(),
    DRAFT6.optional_cases_of(name="bignum"),
    DRAFT6.optional_cases_of(name="float-overflow"),
    DRAFT6.optional_cases_of(name="id"),
    DRAFT6.optional_cases_of(name="non-bmp-regex"),
    Validator=jsonschema.Draft6Validator,
    format_checker=jsonschema.Draft6Validator.FORMAT_CHECKER,
    skip=lambda test: (
        ecmascript_regex(test)
        or leap_second(test)
        or missing_format(jsonschema.Draft6Validator)(test)
        or complex_email_validation(test)
    ),
)


TestDraft7 = DRAFT7.to_unittest_testcase(
    DRAFT7.cases(),
    DRAFT7.format_cases(),
    DRAFT7.optional_cases_of(name="bignum"),
    DRAFT7.optional_cases_of(name="cross-draft"),
    DRAFT7.optional_cases_of(name="float-overflow"),
    DRAFT6.optional_cases_of(name="id"),
    DRAFT7.optional_cases_of(name="non-bmp-regex"),
    DRAFT7.optional_cases_of(name="unknownKeyword"),
    Validator=jsonschema.Draft7Validator,
    format_checker=jsonschema.Draft7Validator.FORMAT_CHECKER,
    skip=lambda test: (
        ecmascript_regex(test)
        or leap_second(test)
        or missing_format(jsonschema.Draft7Validator)(test)
        or complex_email_validation(test)
    ),
)


TestDraft201909 = DRAFT201909.to_unittest_testcase(
    DRAFT201909.cases(),
    DRAFT201909.optional_cases_of(name="anchor"),
    DRAFT201909.optional_cases_of(name="bignum"),
    DRAFT201909.optional_cases_of(name="cross-draft"),
    DRAFT201909.optional_cases_of(name="float-overflow"),
    DRAFT201909.optional_cases_of(name="id"),
    DRAFT201909.optional_cases_of(name="no-schema"),
    DRAFT201909.optional_cases_of(name="non-bmp-regex"),
    DRAFT201909.optional_cases_of(name="refOfUnknownKeyword"),
    DRAFT201909.optional_cases_of(name="unknownKeyword"),
    Validator=jsonschema.Draft201909Validator,
    skip=skip(
        message="Vocabulary support is still in-progress.",
        subject="vocabulary",
        description=(
            "no validation: invalid number, but it still validates"
        ),
    ),
)


TestDraft201909Format = DRAFT201909.to_unittest_testcase(
    DRAFT201909.format_cases(),
    name="TestDraft201909Format",
    Validator=jsonschema.Draft201909Validator,
    format_checker=jsonschema.Draft201909Validator.FORMAT_CHECKER,
    skip=lambda test: (
        complex_email_validation(test)
        or ecmascript_regex(test)
        or leap_second(test)
        or missing_format(jsonschema.Draft201909Validator)(test)
        or complex_email_validation(test)
    ),
)


TestDraft202012 = DRAFT202012.to_unittest_testcase(
    DRAFT202012.cases(),
    DRAFT201909.optional_cases_of(name="anchor"),
    DRAFT202012.optional_cases_of(name="bignum"),
    DRAFT202012.optional_cases_of(name="cross-draft"),
    DRAFT202012.optional_cases_of(name="float-overflow"),
    DRAFT202012.optional_cases_of(name="id"),
    DRAFT202012.optional_cases_of(name="no-schema"),
    DRAFT202012.optional_cases_of(name="non-bmp-regex"),
    DRAFT202012.optional_cases_of(name="refOfUnknownKeyword"),
    DRAFT202012.optional_cases_of(name="unknownKeyword"),
    Validator=jsonschema.Draft202012Validator,
    skip=skip(
        message="Vocabulary support is still in-progress.",
        subject="vocabulary",
        description=(
            "no validation: invalid number, but it still validates"
        ),
    ),
)


TestDraft202012Format = DRAFT202012.to_unittest_testcase(
    DRAFT202012.format_cases(),
    name="TestDraft202012Format",
    Validator=jsonschema.Draft202012Validator,
    format_checker=jsonschema.Draft202012Validator.FORMAT_CHECKER,
    skip=lambda test: (
        complex_email_validation(test)
        or ecmascript_regex(test)
        or leap_second(test)
        or missing_format(jsonschema.Draft202012Validator)(test)
        or complex_email_validation(test)
    ),
)
