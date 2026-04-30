"""
The ``jsonschema`` command line.
"""

from importlib import metadata
from json import JSONDecodeError
from pkgutil import resolve_name
from textwrap import dedent
import argparse
import json
import sys
import traceback
import warnings

from attrs import define, field

from jsonschema.exceptions import SchemaError
from jsonschema.validators import _RefResolver, validator_for

warnings.warn(
    (
        "The jsonschema CLI is deprecated and will be removed in a future "
        "version. Please use check-jsonschema instead, which can be installed "
        "from https://pypi.org/project/check-jsonschema/"
    ),
    DeprecationWarning,
    stacklevel=2,
)


class _CannotLoadFile(Exception):
    pass


@define
class _Outputter:

    _formatter = field()
    _stdout = field()
    _stderr = field()

    @classmethod
    def from_arguments(cls, arguments, stdout, stderr):
        if arguments["output"] == "plain":
            formatter = _PlainFormatter(arguments["error_format"])
        elif arguments["output"] == "pretty":
            formatter = _PrettyFormatter()
        return cls(formatter=formatter, stdout=stdout, stderr=stderr)

    def load(self, path):
        try:
            file = open(path)  # noqa: SIM115, PTH123
        except FileNotFoundError as error:
            self.filenotfound_error(path=path, exc_info=sys.exc_info())
            raise _CannotLoadFile() from error

        with file:
            try:
                return json.load(file)
            except JSONDecodeError as error:
                self.parsing_error(path=path, exc_info=sys.exc_info())
                raise _CannotLoadFile() from error

    def filenotfound_error(self, **kwargs):
        self._stderr.write(self._formatter.filenotfound_error(**kwargs))

    def parsing_error(self, **kwargs):
        self._stderr.write(self._formatter.parsing_error(**kwargs))

    def validation_error(self, **kwargs):
        self._stderr.write(self._formatter.validation_error(**kwargs))

    def validation_success(self, **kwargs):
        self._stdout.write(self._formatter.validation_success(**kwargs))


@define
class _PrettyFormatter:

    _ERROR_MSG = dedent(
        """\
        ===[{type}]===({path})===

        {body}
        -----------------------------
        """,
    )
    _SUCCESS_MSG = "===[SUCCESS]===({path})===\n"

    def filenotfound_error(self, path, exc_info):
        return self._ERROR_MSG.format(
            path=path,
            type="FileNotFoundError",
            body=f"{path!r} does not exist.",
        )

    def parsing_error(self, path, exc_info):
        exc_type, exc_value, exc_traceback = exc_info
        exc_lines = "".join(
            traceback.format_exception(exc_type, exc_value, exc_traceback),
        )
        return self._ERROR_MSG.format(
            path=path,
            type=exc_type.__name__,
            body=exc_lines,
        )

    def validation_error(self, instance_path, error):
        return self._ERROR_MSG.format(
            path=instance_path,
            type=error.__class__.__name__,
            body=error,
        )

    def validation_success(self, instance_path):
        return self._SUCCESS_MSG.format(path=instance_path)


@define
class _PlainFormatter:

    _error_format = field()

    def filenotfound_error(self, path, exc_info):
        return f"{path!r} does not exist.\n"

    def parsing_error(self, path, exc_info):
        return "Failed to parse {}: {}\n".format(
            "<stdin>" if path == "<stdin>" else repr(path),
            exc_info[1],
        )

    def validation_error(self, instance_path, error):
        return self._error_format.format(file_name=instance_path, error=error)

    def validation_success(self, instance_path):
        return ""


def _resolve_name_with_default(name):
    if "." not in name:
        name = "jsonschema." + name
    return resolve_name(name)


parser = argparse.ArgumentParser(
    description="JSON Schema Validation CLI",
)
parser.add_argument(
    "-i", "--instance",
    action="append",
    dest="instances",
    help="""
        a path to a JSON instance (i.e. filename.json) to validate (may
        be specified multiple times). If no instances are provided via this
        option, one will be expected on standard input.
    """,
)
parser.add_argument(
    "-F", "--error-format",
    help="""
        the format to use for each validation error message, specified
        in a form suitable for str.format. This string will be passed
        one formatted object named 'error' for each ValidationError.
        Only provide this option when using --output=plain, which is the
        default. If this argument is unprovided and --output=plain is
        used, a simple default representation will be used.
    """,
)
parser.add_argument(
    "-o", "--output",
    choices=["plain", "pretty"],
    default="plain",
    help="""
        an output format to use. 'plain' (default) will produce minimal
        text with one line for each error, while 'pretty' will produce
        more detailed human-readable output on multiple lines.
    """,
)
parser.add_argument(
    "-V", "--validator",
    type=_resolve_name_with_default,
    help="""
        the fully qualified object name of a validator to use, or, for
        validators that are registered with jsonschema, simply the name
        of the class.
    """,
)
parser.add_argument(
    "--base-uri",
    help="""
        a base URI to assign to the provided schema, even if it does not
        declare one (via e.g. $id). This option can be used if you wish to
        resolve relative references to a particular URI (or local path)
    """,
)
parser.add_argument(
    "--version",
    action="version",
    version=metadata.version("jsonschema"),
)
parser.add_argument(
    "schema",
    help="the path to a JSON Schema to validate with (i.e. schema.json)",
)


def parse_args(args):  # noqa: D103
    arguments = vars(parser.parse_args(args=args or ["--help"]))
    if arguments["output"] != "plain" and arguments["error_format"]:
        raise parser.error(
            "--error-format can only be used with --output plain",
        )
    if arguments["output"] == "plain" and arguments["error_format"] is None:
        arguments["error_format"] = "{error.instance}: {error.message}\n"
    return arguments


def _validate_instance(instance_path, instance, validator, outputter):
    invalid = False
    for error in validator.iter_errors(instance):
        invalid = True
        outputter.validation_error(instance_path=instance_path, error=error)

    if not invalid:
        outputter.validation_success(instance_path=instance_path)
    return invalid


def main(args=sys.argv[1:]):  # noqa: D103
    sys.exit(run(arguments=parse_args(args=args)))


def run(arguments, stdout=sys.stdout, stderr=sys.stderr, stdin=sys.stdin):  # noqa: D103
    outputter = _Outputter.from_arguments(
        arguments=arguments,
        stdout=stdout,
        stderr=stderr,
    )

    try:
        schema = outputter.load(arguments["schema"])
    except _CannotLoadFile:
        return 1

    Validator = arguments["validator"]
    if Validator is None:
        Validator = validator_for(schema)

    try:
        Validator.check_schema(schema)
    except SchemaError as error:
        outputter.validation_error(
            instance_path=arguments["schema"],
            error=error,
        )
        return 1

    if arguments["instances"]:
        load, instances = outputter.load, arguments["instances"]
    else:
        def load(_):
            try:
                return json.load(stdin)
            except JSONDecodeError as error:
                outputter.parsing_error(
                    path="<stdin>", exc_info=sys.exc_info(),
                )
                raise _CannotLoadFile() from error
        instances = ["<stdin>"]

    resolver = _RefResolver(
        base_uri=arguments["base_uri"],
        referrer=schema,
    ) if arguments["base_uri"] is not None else None

    validator = Validator(schema, resolver=resolver)
    exit_code = 0
    for each in instances:
        try:
            instance = load(each)
        except _CannotLoadFile:
            exit_code = 1
        else:
            exit_code |= _validate_instance(
                instance_path=each,
                instance=instance,
                validator=validator,
                outputter=outputter,
            )

    return exit_code
