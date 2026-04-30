from contextlib import redirect_stderr, redirect_stdout
from importlib import metadata
from io import StringIO
from json import JSONDecodeError
from pathlib import Path
from textwrap import dedent
from unittest import TestCase
import json
import os
import subprocess
import sys
import tempfile
import warnings

from jsonschema import Draft4Validator, Draft202012Validator
from jsonschema.exceptions import (
    SchemaError,
    ValidationError,
    _RefResolutionError,
)
from jsonschema.validators import _LATEST_VERSION, validate

with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    from jsonschema import cli


def fake_validator(*errors):
    errors = list(reversed(errors))

    class FakeValidator:
        def __init__(self, *args, **kwargs):
            pass

        def iter_errors(self, instance):
            if errors:
                return errors.pop()
            return []  # pragma: no cover

        @classmethod
        def check_schema(self, schema):
            pass

    return FakeValidator


def fake_open(all_contents):
    def open(path):
        contents = all_contents.get(path)
        if contents is None:
            raise FileNotFoundError(path)
        return StringIO(contents)
    return open


def _message_for(non_json):
    try:
        json.loads(non_json)
    except JSONDecodeError as error:
        return str(error)
    else:  # pragma: no cover
        raise RuntimeError("Tried and failed to capture a JSON dump error.")


class TestCLI(TestCase):
    def run_cli(
        self, argv, files=None, stdin=StringIO(), exit_code=0, **override,
    ):
        arguments = cli.parse_args(argv)
        arguments.update(override)

        self.assertFalse(hasattr(cli, "open"))
        cli.open = fake_open(files or {})
        try:
            stdout, stderr = StringIO(), StringIO()
            actual_exit_code = cli.run(
                arguments,
                stdin=stdin,
                stdout=stdout,
                stderr=stderr,
            )
        finally:
            del cli.open

        self.assertEqual(
            actual_exit_code, exit_code, msg=dedent(
                f"""
                    Expected an exit code of {exit_code} != {actual_exit_code}.

                    stdout: {stdout.getvalue()}

                    stderr: {stderr.getvalue()}
                """,
            ),
        )
        return stdout.getvalue(), stderr.getvalue()

    def assertOutputs(self, stdout="", stderr="", **kwargs):
        self.assertEqual(
            self.run_cli(**kwargs),
            (dedent(stdout), dedent(stderr)),
        )

    def test_invalid_instance(self):
        error = ValidationError("I am an error!", instance=12)
        self.assertOutputs(
            files=dict(
                some_schema='{"does not": "matter since it is stubbed"}',
                some_instance=json.dumps(error.instance),
            ),
            validator=fake_validator([error]),

            argv=["-i", "some_instance", "some_schema"],

            exit_code=1,
            stderr="12: I am an error!\n",
        )

    def test_invalid_instance_pretty_output(self):
        error = ValidationError("I am an error!", instance=12)
        self.assertOutputs(
            files=dict(
                some_schema='{"does not": "matter since it is stubbed"}',
                some_instance=json.dumps(error.instance),
            ),
            validator=fake_validator([error]),

            argv=["-i", "some_instance", "--output", "pretty", "some_schema"],

            exit_code=1,
            stderr="""\
                ===[ValidationError]===(some_instance)===

                I am an error!
                -----------------------------
            """,
        )

    def test_invalid_instance_explicit_plain_output(self):
        error = ValidationError("I am an error!", instance=12)
        self.assertOutputs(
            files=dict(
                some_schema='{"does not": "matter since it is stubbed"}',
                some_instance=json.dumps(error.instance),
            ),
            validator=fake_validator([error]),

            argv=["--output", "plain", "-i", "some_instance", "some_schema"],

            exit_code=1,
            stderr="12: I am an error!\n",
        )

    def test_invalid_instance_multiple_errors(self):
        instance = 12
        first = ValidationError("First error", instance=instance)
        second = ValidationError("Second error", instance=instance)

        self.assertOutputs(
            files=dict(
                some_schema='{"does not": "matter since it is stubbed"}',
                some_instance=json.dumps(instance),
            ),
            validator=fake_validator([first, second]),

            argv=["-i", "some_instance", "some_schema"],

            exit_code=1,
            stderr="""\
                12: First error
                12: Second error
            """,
        )

    def test_invalid_instance_multiple_errors_pretty_output(self):
        instance = 12
        first = ValidationError("First error", instance=instance)
        second = ValidationError("Second error", instance=instance)

        self.assertOutputs(
            files=dict(
                some_schema='{"does not": "matter since it is stubbed"}',
                some_instance=json.dumps(instance),
            ),
            validator=fake_validator([first, second]),

            argv=["-i", "some_instance", "--output", "pretty", "some_schema"],

            exit_code=1,
            stderr="""\
                ===[ValidationError]===(some_instance)===

                First error
                -----------------------------
                ===[ValidationError]===(some_instance)===

                Second error
                -----------------------------
            """,
        )

    def test_multiple_invalid_instances(self):
        first_instance = 12
        first_errors = [
            ValidationError("An error", instance=first_instance),
            ValidationError("Another error", instance=first_instance),
        ]
        second_instance = "foo"
        second_errors = [ValidationError("BOOM", instance=second_instance)]

        self.assertOutputs(
            files=dict(
                some_schema='{"does not": "matter since it is stubbed"}',
                some_first_instance=json.dumps(first_instance),
                some_second_instance=json.dumps(second_instance),
            ),
            validator=fake_validator(first_errors, second_errors),

            argv=[
                "-i", "some_first_instance",
                "-i", "some_second_instance",
                "some_schema",
            ],

            exit_code=1,
            stderr="""\
                12: An error
                12: Another error
                foo: BOOM
            """,
        )

    def test_multiple_invalid_instances_pretty_output(self):
        first_instance = 12
        first_errors = [
            ValidationError("An error", instance=first_instance),
            ValidationError("Another error", instance=first_instance),
        ]
        second_instance = "foo"
        second_errors = [ValidationError("BOOM", instance=second_instance)]

        self.assertOutputs(
            files=dict(
                some_schema='{"does not": "matter since it is stubbed"}',
                some_first_instance=json.dumps(first_instance),
                some_second_instance=json.dumps(second_instance),
            ),
            validator=fake_validator(first_errors, second_errors),

            argv=[
                "--output", "pretty",
                "-i", "some_first_instance",
                "-i", "some_second_instance",
                "some_schema",
            ],

            exit_code=1,
            stderr="""\
                ===[ValidationError]===(some_first_instance)===

                An error
                -----------------------------
                ===[ValidationError]===(some_first_instance)===

                Another error
                -----------------------------
                ===[ValidationError]===(some_second_instance)===

                BOOM
                -----------------------------
            """,
        )

    def test_custom_error_format(self):
        first_instance = 12
        first_errors = [
            ValidationError("An error", instance=first_instance),
            ValidationError("Another error", instance=first_instance),
        ]
        second_instance = "foo"
        second_errors = [ValidationError("BOOM", instance=second_instance)]

        self.assertOutputs(
            files=dict(
                some_schema='{"does not": "matter since it is stubbed"}',
                some_first_instance=json.dumps(first_instance),
                some_second_instance=json.dumps(second_instance),
            ),
            validator=fake_validator(first_errors, second_errors),

            argv=[
                "--error-format", ":{error.message}._-_.{error.instance}:",
                "-i", "some_first_instance",
                "-i", "some_second_instance",
                "some_schema",
            ],

            exit_code=1,
            stderr=":An error._-_.12::Another error._-_.12::BOOM._-_.foo:",
        )

    def test_invalid_schema(self):
        self.assertOutputs(
            files=dict(some_schema='{"type": 12}'),
            argv=["some_schema"],

            exit_code=1,
            stderr="""\
                12: 12 is not valid under any of the given schemas
            """,
        )

    def test_invalid_schema_pretty_output(self):
        schema = {"type": 12}

        with self.assertRaises(SchemaError) as e:
            validate(schema=schema, instance="")
        error = str(e.exception)

        self.assertOutputs(
            files=dict(some_schema=json.dumps(schema)),
            argv=["--output", "pretty", "some_schema"],

            exit_code=1,
            stderr=(
                "===[SchemaError]===(some_schema)===\n\n"
                + str(error)
                + "\n-----------------------------\n"
            ),
        )

    def test_invalid_schema_multiple_errors(self):
        self.assertOutputs(
            files=dict(some_schema='{"type": 12, "items": 57}'),
            argv=["some_schema"],

            exit_code=1,
            stderr="""\
                57: 57 is not of type 'object', 'boolean'
            """,
        )

    def test_invalid_schema_multiple_errors_pretty_output(self):
        schema = {"type": 12, "items": 57}

        with self.assertRaises(SchemaError) as e:
            validate(schema=schema, instance="")
        error = str(e.exception)

        self.assertOutputs(
            files=dict(some_schema=json.dumps(schema)),
            argv=["--output", "pretty", "some_schema"],

            exit_code=1,
            stderr=(
                "===[SchemaError]===(some_schema)===\n\n"
                + str(error)
                + "\n-----------------------------\n"
            ),
        )

    def test_invalid_schema_with_invalid_instance(self):
        """
        "Validating" an instance that's invalid under an invalid schema
        just shows the schema error.
        """
        self.assertOutputs(
            files=dict(
                some_schema='{"type": 12, "minimum": 30}',
                some_instance="13",
            ),
            argv=["-i", "some_instance", "some_schema"],

            exit_code=1,
            stderr="""\
                12: 12 is not valid under any of the given schemas
            """,
        )

    def test_invalid_schema_with_invalid_instance_pretty_output(self):
        instance, schema = 13, {"type": 12, "minimum": 30}

        with self.assertRaises(SchemaError) as e:
            validate(schema=schema, instance=instance)
        error = str(e.exception)

        self.assertOutputs(
            files=dict(
                some_schema=json.dumps(schema),
                some_instance=json.dumps(instance),
            ),
            argv=["--output", "pretty", "-i", "some_instance", "some_schema"],

            exit_code=1,
            stderr=(
                "===[SchemaError]===(some_schema)===\n\n"
                + str(error)
                + "\n-----------------------------\n"
            ),
        )

    def test_invalid_instance_continues_with_the_rest(self):
        self.assertOutputs(
            files=dict(
                some_schema='{"minimum": 30}',
                first_instance="not valid JSON!",
                second_instance="12",
            ),
            argv=[
                "-i", "first_instance",
                "-i", "second_instance",
                "some_schema",
            ],

            exit_code=1,
            stderr="""\
                Failed to parse 'first_instance': {}
                12: 12 is less than the minimum of 30
            """.format(_message_for("not valid JSON!")),
        )

    def test_custom_error_format_applies_to_schema_errors(self):
        instance, schema = 13, {"type": 12, "minimum": 30}

        with self.assertRaises(SchemaError):
            validate(schema=schema, instance=instance)

        self.assertOutputs(
            files=dict(some_schema=json.dumps(schema)),

            argv=[
                "--error-format", ":{error.message}._-_.{error.instance}:",
                "some_schema",
            ],

            exit_code=1,
            stderr=":12 is not valid under any of the given schemas._-_.12:",
        )

    def test_instance_is_invalid_JSON(self):
        instance = "not valid JSON!"

        self.assertOutputs(
            files=dict(some_schema="{}", some_instance=instance),
            argv=["-i", "some_instance", "some_schema"],

            exit_code=1,
            stderr=f"""\
                Failed to parse 'some_instance': {_message_for(instance)}
            """,
        )

    def test_instance_is_invalid_JSON_pretty_output(self):
        stdout, stderr = self.run_cli(
            files=dict(
                some_schema="{}",
                some_instance="not valid JSON!",
            ),

            argv=["--output", "pretty", "-i", "some_instance", "some_schema"],

            exit_code=1,
        )
        self.assertFalse(stdout)
        self.assertIn(
            "(some_instance)===\n\nTraceback (most recent call last):\n",
            stderr,
        )
        self.assertNotIn("some_schema", stderr)

    def test_instance_is_invalid_JSON_on_stdin(self):
        instance = "not valid JSON!"

        self.assertOutputs(
            files=dict(some_schema="{}"),
            stdin=StringIO(instance),

            argv=["some_schema"],

            exit_code=1,
            stderr=f"""\
                Failed to parse <stdin>: {_message_for(instance)}
            """,
        )

    def test_instance_is_invalid_JSON_on_stdin_pretty_output(self):
        stdout, stderr = self.run_cli(
            files=dict(some_schema="{}"),
            stdin=StringIO("not valid JSON!"),

            argv=["--output", "pretty", "some_schema"],

            exit_code=1,
        )
        self.assertFalse(stdout)
        self.assertIn(
            "(<stdin>)===\n\nTraceback (most recent call last):\n",
            stderr,
        )
        self.assertNotIn("some_schema", stderr)

    def test_schema_is_invalid_JSON(self):
        schema = "not valid JSON!"

        self.assertOutputs(
            files=dict(some_schema=schema),

            argv=["some_schema"],

            exit_code=1,
            stderr=f"""\
                Failed to parse 'some_schema': {_message_for(schema)}
            """,
        )

    def test_schema_is_invalid_JSON_pretty_output(self):
        stdout, stderr = self.run_cli(
            files=dict(some_schema="not valid JSON!"),

            argv=["--output", "pretty", "some_schema"],

            exit_code=1,
        )
        self.assertFalse(stdout)
        self.assertIn(
            "(some_schema)===\n\nTraceback (most recent call last):\n",
            stderr,
        )

    def test_schema_and_instance_are_both_invalid_JSON(self):
        """
        Only the schema error is reported, as we abort immediately.
        """
        schema, instance = "not valid JSON!", "also not valid JSON!"
        self.assertOutputs(
            files=dict(some_schema=schema, some_instance=instance),

            argv=["some_schema"],

            exit_code=1,
            stderr=f"""\
                Failed to parse 'some_schema': {_message_for(schema)}
            """,
        )

    def test_schema_and_instance_are_both_invalid_JSON_pretty_output(self):
        """
        Only the schema error is reported, as we abort immediately.
        """
        stdout, stderr = self.run_cli(
            files=dict(
                some_schema="not valid JSON!",
                some_instance="also not valid JSON!",
            ),

            argv=["--output", "pretty", "-i", "some_instance", "some_schema"],

            exit_code=1,
        )
        self.assertFalse(stdout)
        self.assertIn(
            "(some_schema)===\n\nTraceback (most recent call last):\n",
            stderr,
        )
        self.assertNotIn("some_instance", stderr)

    def test_instance_does_not_exist(self):
        self.assertOutputs(
            files=dict(some_schema="{}"),
            argv=["-i", "nonexisting_instance", "some_schema"],

            exit_code=1,
            stderr="""\
                'nonexisting_instance' does not exist.
            """,
        )

    def test_instance_does_not_exist_pretty_output(self):
        self.assertOutputs(
            files=dict(some_schema="{}"),
            argv=[
                "--output", "pretty",
                "-i", "nonexisting_instance",
                "some_schema",
            ],

            exit_code=1,
            stderr="""\
                ===[FileNotFoundError]===(nonexisting_instance)===

                'nonexisting_instance' does not exist.
                -----------------------------
            """,
        )

    def test_schema_does_not_exist(self):
        self.assertOutputs(
            argv=["nonexisting_schema"],

            exit_code=1,
            stderr="'nonexisting_schema' does not exist.\n",
        )

    def test_schema_does_not_exist_pretty_output(self):
        self.assertOutputs(
            argv=["--output", "pretty", "nonexisting_schema"],

            exit_code=1,
            stderr="""\
                ===[FileNotFoundError]===(nonexisting_schema)===

                'nonexisting_schema' does not exist.
                -----------------------------
            """,
        )

    def test_neither_instance_nor_schema_exist(self):
        self.assertOutputs(
            argv=["-i", "nonexisting_instance", "nonexisting_schema"],

            exit_code=1,
            stderr="'nonexisting_schema' does not exist.\n",
        )

    def test_neither_instance_nor_schema_exist_pretty_output(self):
        self.assertOutputs(
            argv=[
                "--output", "pretty",
                "-i", "nonexisting_instance",
                "nonexisting_schema",
            ],

            exit_code=1,
            stderr="""\
                ===[FileNotFoundError]===(nonexisting_schema)===

                'nonexisting_schema' does not exist.
                -----------------------------
            """,
        )

    def test_successful_validation(self):
        self.assertOutputs(
            files=dict(some_schema="{}", some_instance="{}"),
            argv=["-i", "some_instance", "some_schema"],
            stdout="",
            stderr="",
        )

    def test_successful_validation_pretty_output(self):
        self.assertOutputs(
            files=dict(some_schema="{}", some_instance="{}"),
            argv=["--output", "pretty", "-i", "some_instance", "some_schema"],
            stdout="===[SUCCESS]===(some_instance)===\n",
            stderr="",
        )

    def test_successful_validation_of_stdin(self):
        self.assertOutputs(
            files=dict(some_schema="{}"),
            stdin=StringIO("{}"),
            argv=["some_schema"],
            stdout="",
            stderr="",
        )

    def test_successful_validation_of_stdin_pretty_output(self):
        self.assertOutputs(
            files=dict(some_schema="{}"),
            stdin=StringIO("{}"),
            argv=["--output", "pretty", "some_schema"],
            stdout="===[SUCCESS]===(<stdin>)===\n",
            stderr="",
        )

    def test_successful_validation_of_just_the_schema(self):
        self.assertOutputs(
            files=dict(some_schema="{}", some_instance="{}"),
            argv=["-i", "some_instance", "some_schema"],
            stdout="",
            stderr="",
        )

    def test_successful_validation_of_just_the_schema_pretty_output(self):
        self.assertOutputs(
            files=dict(some_schema="{}", some_instance="{}"),
            argv=["--output", "pretty", "-i", "some_instance", "some_schema"],
            stdout="===[SUCCESS]===(some_instance)===\n",
            stderr="",
        )

    def test_successful_validation_via_explicit_base_uri(self):
        ref_schema_file = tempfile.NamedTemporaryFile(delete=False)  # noqa: SIM115
        ref_schema_file.close()
        self.addCleanup(os.remove, ref_schema_file.name)

        ref_path = Path(ref_schema_file.name)
        ref_path.write_text('{"definitions": {"num": {"type": "integer"}}}')

        schema = f'{{"$ref": "{ref_path.name}#/definitions/num"}}'

        self.assertOutputs(
            files=dict(some_schema=schema, some_instance="1"),
            argv=[
                "-i", "some_instance",
                "--base-uri", ref_path.parent.as_uri() + "/",
                "some_schema",
            ],
            stdout="",
            stderr="",
        )

    def test_unsuccessful_validation_via_explicit_base_uri(self):
        ref_schema_file = tempfile.NamedTemporaryFile(delete=False)  # noqa: SIM115
        ref_schema_file.close()
        self.addCleanup(os.remove, ref_schema_file.name)

        ref_path = Path(ref_schema_file.name)
        ref_path.write_text('{"definitions": {"num": {"type": "integer"}}}')

        schema = f'{{"$ref": "{ref_path.name}#/definitions/num"}}'

        self.assertOutputs(
            files=dict(some_schema=schema, some_instance='"1"'),
            argv=[
                "-i", "some_instance",
                "--base-uri", ref_path.parent.as_uri() + "/",
                "some_schema",
            ],
            exit_code=1,
            stdout="",
            stderr="1: '1' is not of type 'integer'\n",
        )

    def test_nonexistent_file_with_explicit_base_uri(self):
        schema = '{"$ref": "someNonexistentFile.json#definitions/num"}'
        instance = "1"

        with self.assertRaises(_RefResolutionError) as e:
            self.assertOutputs(
                files=dict(
                    some_schema=schema,
                    some_instance=instance,
                ),
                argv=[
                    "-i", "some_instance",
                    "--base-uri", Path.cwd().as_uri(),
                    "some_schema",
                ],
            )
        error = str(e.exception)
        self.assertIn(f"{os.sep}someNonexistentFile.json'", error)

    def test_invalid_explicit_base_uri(self):
        schema = '{"$ref": "foo.json#definitions/num"}'
        instance = "1"

        with self.assertRaises(_RefResolutionError) as e:
            self.assertOutputs(
                files=dict(
                    some_schema=schema,
                    some_instance=instance,
                ),
                argv=[
                    "-i", "some_instance",
                    "--base-uri", "not@UR1",
                    "some_schema",
                ],
            )
        error = str(e.exception)
        self.assertEqual(
            error, "unknown url type: 'foo.json'",
        )

    def test_it_validates_using_the_latest_validator_when_unspecified(self):
        # There isn't a better way now I can think of to ensure that the
        # latest version was used, given that the call to validator_for
        # is hidden inside the CLI, so guard that that's the case, and
        # this test will have to be updated when versions change until
        # we can think of a better way to ensure this behavior.
        self.assertIs(Draft202012Validator, _LATEST_VERSION)

        self.assertOutputs(
            files=dict(some_schema='{"const": "check"}', some_instance='"a"'),
            argv=["-i", "some_instance", "some_schema"],
            exit_code=1,
            stdout="",
            stderr="a: 'check' was expected\n",
        )

    def test_it_validates_using_draft7_when_specified(self):
        """
        Specifically, `const` validation applies for Draft 7.
        """
        schema = """
            {
                "$schema": "http://json-schema.org/draft-07/schema#",
                "const": "check"
            }
        """
        instance = '"foo"'
        self.assertOutputs(
            files=dict(some_schema=schema, some_instance=instance),
            argv=["-i", "some_instance", "some_schema"],
            exit_code=1,
            stdout="",
            stderr="foo: 'check' was expected\n",
        )

    def test_it_validates_using_draft4_when_specified(self):
        """
        Specifically, `const` validation *does not* apply for Draft 4.
        """
        schema = """
            {
                "$schema": "http://json-schema.org/draft-04/schema#",
                "const": "check"
            }
            """
        instance = '"foo"'
        self.assertOutputs(
            files=dict(some_schema=schema, some_instance=instance),
            argv=["-i", "some_instance", "some_schema"],
            stdout="",
            stderr="",
        )


class TestParser(TestCase):

    FakeValidator = fake_validator()

    def test_find_validator_by_fully_qualified_object_name(self):
        arguments = cli.parse_args(
            [
                "--validator",
                "jsonschema.tests.test_cli.TestParser.FakeValidator",
                "--instance", "mem://some/instance",
                "mem://some/schema",
            ],
        )
        self.assertIs(arguments["validator"], self.FakeValidator)

    def test_find_validator_in_jsonschema(self):
        arguments = cli.parse_args(
            [
                "--validator", "Draft4Validator",
                "--instance", "mem://some/instance",
                "mem://some/schema",
            ],
        )
        self.assertIs(arguments["validator"], Draft4Validator)

    def cli_output_for(self, *argv):
        stdout, stderr = StringIO(), StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):  # noqa: SIM117
            with self.assertRaises(SystemExit):
                cli.parse_args(argv)
        return stdout.getvalue(), stderr.getvalue()

    def test_unknown_output(self):
        stdout, stderr = self.cli_output_for(
            "--output", "foo",
            "mem://some/schema",
        )
        self.assertIn("invalid choice: 'foo'", stderr)
        self.assertFalse(stdout)

    def test_useless_error_format(self):
        stdout, stderr = self.cli_output_for(
            "--output", "pretty",
            "--error-format", "foo",
            "mem://some/schema",
        )
        self.assertIn(
            "--error-format can only be used with --output plain",
            stderr,
        )
        self.assertFalse(stdout)


class TestCLIIntegration(TestCase):
    def test_license(self):
        our_metadata = metadata.metadata("jsonschema")
        self.assertEqual(our_metadata.get("License-Expression"), "MIT")

    def test_version(self):
        version = subprocess.check_output(
            [sys.executable, "-W", "ignore", "-m", "jsonschema", "--version"],
            stderr=subprocess.STDOUT,
        )
        version = version.decode("utf-8").strip()
        self.assertEqual(version, metadata.version("jsonschema"))

    def test_no_arguments_shows_usage_notes(self):
        output = subprocess.check_output(
            [sys.executable, "-m", "jsonschema"],
            stderr=subprocess.STDOUT,
        )
        output_for_help = subprocess.check_output(
            [sys.executable, "-m", "jsonschema", "--help"],
            stderr=subprocess.STDOUT,
        )
        self.assertEqual(output, output_for_help)
