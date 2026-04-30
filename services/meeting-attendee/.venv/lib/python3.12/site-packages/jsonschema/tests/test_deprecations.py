from contextlib import contextmanager
from io import BytesIO
from unittest import TestCase, mock
import importlib.metadata
import json
import subprocess
import sys
import urllib.request

import referencing.exceptions

from jsonschema import FormatChecker, exceptions, protocols, validators


class TestDeprecations(TestCase):
    def test_version(self):
        """
        As of v4.0.0, __version__ is deprecated in favor of importlib.metadata.
        """

        message = "Accessing jsonschema.__version__ is deprecated"
        with self.assertWarnsRegex(DeprecationWarning, message) as w:
            from jsonschema import __version__

        self.assertEqual(__version__, importlib.metadata.version("jsonschema"))
        self.assertEqual(w.filename, __file__)

    def test_validators_ErrorTree(self):
        """
        As of v4.0.0, importing ErrorTree from jsonschema.validators is
        deprecated in favor of doing so from jsonschema.exceptions.
        """

        message = "Importing ErrorTree from jsonschema.validators is "
        with self.assertWarnsRegex(DeprecationWarning, message) as w:
            from jsonschema.validators import ErrorTree

        self.assertEqual(ErrorTree, exceptions.ErrorTree)
        self.assertEqual(w.filename, __file__)

    def test_import_ErrorTree(self):
        """
        As of v4.18.0, importing ErrorTree from the package root is
        deprecated in favor of doing so from jsonschema.exceptions.
        """

        message = "Importing ErrorTree directly from the jsonschema package "
        with self.assertWarnsRegex(DeprecationWarning, message) as w:
            from jsonschema import ErrorTree

        self.assertEqual(ErrorTree, exceptions.ErrorTree)
        self.assertEqual(w.filename, __file__)

    def test_ErrorTree_setitem(self):
        """
        As of v4.20.0, setting items on an ErrorTree is deprecated.
        """

        e = exceptions.ValidationError("some error", path=["foo"])
        tree = exceptions.ErrorTree()
        subtree = exceptions.ErrorTree(errors=[e])

        message = "ErrorTree.__setitem__ is "
        with self.assertWarnsRegex(DeprecationWarning, message) as w:
            tree["foo"] = subtree

        self.assertEqual(tree["foo"], subtree)
        self.assertEqual(w.filename, __file__)

    def test_import_FormatError(self):
        """
        As of v4.18.0, importing FormatError from the package root is
        deprecated in favor of doing so from jsonschema.exceptions.
        """

        message = "Importing FormatError directly from the jsonschema package "
        with self.assertWarnsRegex(DeprecationWarning, message) as w:
            from jsonschema import FormatError

        self.assertEqual(FormatError, exceptions.FormatError)
        self.assertEqual(w.filename, __file__)

    def test_import_Validator(self):
        """
        As of v4.19.0, importing Validator from the package root is
        deprecated in favor of doing so from jsonschema.protocols.
        """

        message = "Importing Validator directly from the jsonschema package "
        with self.assertWarnsRegex(DeprecationWarning, message) as w:
            from jsonschema import Validator

        self.assertEqual(Validator, protocols.Validator)
        self.assertEqual(w.filename, __file__)

    def test_validators_validators(self):
        """
        As of v4.0.0, accessing jsonschema.validators.validators is
        deprecated.
        """

        message = "Accessing jsonschema.validators.validators is deprecated"
        with self.assertWarnsRegex(DeprecationWarning, message) as w:
            value = validators.validators

        self.assertEqual(value, validators._VALIDATORS)
        self.assertEqual(w.filename, __file__)

    def test_validators_meta_schemas(self):
        """
        As of v4.0.0, accessing jsonschema.validators.meta_schemas is
        deprecated.
        """

        message = "Accessing jsonschema.validators.meta_schemas is deprecated"
        with self.assertWarnsRegex(DeprecationWarning, message) as w:
            value = validators.meta_schemas

        self.assertEqual(value, validators._META_SCHEMAS)
        self.assertEqual(w.filename, __file__)

    def test_RefResolver_in_scope(self):
        """
        As of v4.0.0, RefResolver.in_scope is deprecated.
        """

        resolver = validators._RefResolver.from_schema({})
        message = "jsonschema.RefResolver.in_scope is deprecated "
        with self.assertWarnsRegex(DeprecationWarning, message) as w:  # noqa: SIM117
            with resolver.in_scope("foo"):
                pass

        self.assertEqual(w.filename, __file__)

    def test_Validator_is_valid_two_arguments(self):
        """
        As of v4.0.0, calling is_valid with two arguments (to provide a
        different schema) is deprecated.
        """

        validator = validators.Draft7Validator({})
        message = "Passing a schema to Validator.is_valid is deprecated "
        with self.assertWarnsRegex(DeprecationWarning, message) as w:
            result = validator.is_valid("foo", {"type": "number"})

        self.assertFalse(result)
        self.assertEqual(w.filename, __file__)

    def test_Validator_iter_errors_two_arguments(self):
        """
        As of v4.0.0, calling iter_errors with two arguments (to provide a
        different schema) is deprecated.
        """

        validator = validators.Draft7Validator({})
        message = "Passing a schema to Validator.iter_errors is deprecated "
        with self.assertWarnsRegex(DeprecationWarning, message) as w:
            error, = validator.iter_errors("foo", {"type": "number"})

        self.assertEqual(error.validator, "type")
        self.assertEqual(w.filename, __file__)

    def test_Validator_resolver(self):
        """
        As of v4.18.0, accessing Validator.resolver is deprecated.
        """

        validator = validators.Draft7Validator({})
        message = "Accessing Draft7Validator.resolver is "
        with self.assertWarnsRegex(DeprecationWarning, message) as w:
            self.assertIsInstance(validator.resolver, validators._RefResolver)

        self.assertEqual(w.filename, __file__)

    def test_RefResolver(self):
        """
        As of v4.18.0, RefResolver is fully deprecated.
        """

        message = "jsonschema.RefResolver is deprecated"
        with self.assertWarnsRegex(DeprecationWarning, message) as w:
            from jsonschema import RefResolver
        self.assertEqual(w.filename, __file__)

        with self.assertWarnsRegex(DeprecationWarning, message) as w:
            from jsonschema.validators import RefResolver  # noqa: F401
        self.assertEqual(w.filename, __file__)

    def test_RefResolutionError(self):
        """
        As of v4.18.0, RefResolutionError is deprecated in favor of directly
        catching errors from the referencing library.
        """

        message = "jsonschema.exceptions.RefResolutionError is deprecated"
        with self.assertWarnsRegex(DeprecationWarning, message) as w:
            from jsonschema import RefResolutionError

        self.assertEqual(RefResolutionError, exceptions._RefResolutionError)
        self.assertEqual(w.filename, __file__)

        with self.assertWarnsRegex(DeprecationWarning, message) as w:
            from jsonschema.exceptions import RefResolutionError

        self.assertEqual(RefResolutionError, exceptions._RefResolutionError)
        self.assertEqual(w.filename, __file__)

    def test_catching_Unresolvable_directly(self):
        """
        This behavior is the intended behavior (i.e. it's not deprecated), but
        given we do "tricksy" things in the iterim to wrap exceptions in a
        multiple inheritance subclass, we need to be extra sure it works and
        stays working.
        """
        validator = validators.Draft202012Validator({"$ref": "urn:nothing"})

        with self.assertRaises(referencing.exceptions.Unresolvable) as e:
            validator.validate(12)

        expected = referencing.exceptions.Unresolvable(ref="urn:nothing")
        self.assertEqual(
            (e.exception, str(e.exception)),
            (expected, "Unresolvable: urn:nothing"),
        )

    def test_catching_Unresolvable_via_RefResolutionError(self):
        """
        Until RefResolutionError is removed, it is still possible to catch
        exceptions from reference resolution using it, even though they may
        have been raised by referencing.
        """
        with self.assertWarns(DeprecationWarning):
            from jsonschema import RefResolutionError

        validator = validators.Draft202012Validator({"$ref": "urn:nothing"})

        with self.assertRaises(referencing.exceptions.Unresolvable) as u:
            validator.validate(12)

        with self.assertRaises(RefResolutionError) as e:
            validator.validate(12)

        self.assertEqual(
            (e.exception, str(e.exception)),
            (u.exception, "Unresolvable: urn:nothing"),
        )

    def test_WrappedReferencingError_hashability(self):
        """
        Ensure the wrapped referencing errors are hashable when possible.
        """
        with self.assertWarns(DeprecationWarning):
            from jsonschema import RefResolutionError

        validator = validators.Draft202012Validator({"$ref": "urn:nothing"})

        with self.assertRaises(referencing.exceptions.Unresolvable) as u:
            validator.validate(12)

        with self.assertRaises(RefResolutionError) as e:
            validator.validate(12)

        self.assertIn(e.exception, {u.exception})
        self.assertIn(u.exception, {e.exception})

    def test_Validator_subclassing(self):
        """
        As of v4.12.0, subclassing a validator class produces an explicit
        deprecation warning.

        This was never intended to be public API (and some comments over the
        years in issues said so, but obviously that's not a great way to make
        sure it's followed).

        A future version will explicitly raise an error.
        """

        message = "Subclassing validator classes is "
        with self.assertWarnsRegex(DeprecationWarning, message) as w:
            class Subclass(validators.Draft202012Validator):
                pass

        self.assertEqual(w.filename, __file__)

        with self.assertWarnsRegex(DeprecationWarning, message) as w:
            class AnotherSubclass(validators.create(meta_schema={})):
                pass

    def test_FormatChecker_cls_checks(self):
        """
        As of v4.14.0, FormatChecker.cls_checks is deprecated without
        replacement.
        """

        self.addCleanup(FormatChecker.checkers.pop, "boom", None)

        message = "FormatChecker.cls_checks "
        with self.assertWarnsRegex(DeprecationWarning, message) as w:
            FormatChecker.cls_checks("boom")

        self.assertEqual(w.filename, __file__)

    def test_draftN_format_checker(self):
        """
        As of v4.16.0, accessing jsonschema.draftn_format_checker is deprecated
        in favor of Validator.FORMAT_CHECKER.
        """

        message = "Accessing jsonschema.draft202012_format_checker is "
        with self.assertWarnsRegex(DeprecationWarning, message) as w:
            from jsonschema import draft202012_format_checker

        self.assertIs(
            draft202012_format_checker,
            validators.Draft202012Validator.FORMAT_CHECKER,
        )
        self.assertEqual(w.filename, __file__)

        message = "Accessing jsonschema.draft201909_format_checker is "
        with self.assertWarnsRegex(DeprecationWarning, message) as w:
            from jsonschema import draft201909_format_checker

        self.assertIs(
            draft201909_format_checker,
            validators.Draft201909Validator.FORMAT_CHECKER,
        )
        self.assertEqual(w.filename, __file__)

        message = "Accessing jsonschema.draft7_format_checker is "
        with self.assertWarnsRegex(DeprecationWarning, message) as w:
            from jsonschema import draft7_format_checker

        self.assertIs(
            draft7_format_checker,
            validators.Draft7Validator.FORMAT_CHECKER,
        )
        self.assertEqual(w.filename, __file__)

        message = "Accessing jsonschema.draft6_format_checker is "
        with self.assertWarnsRegex(DeprecationWarning, message) as w:
            from jsonschema import draft6_format_checker

        self.assertIs(
            draft6_format_checker,
            validators.Draft6Validator.FORMAT_CHECKER,
        )
        self.assertEqual(w.filename, __file__)

        message = "Accessing jsonschema.draft4_format_checker is "
        with self.assertWarnsRegex(DeprecationWarning, message) as w:
            from jsonschema import draft4_format_checker

        self.assertIs(
            draft4_format_checker,
            validators.Draft4Validator.FORMAT_CHECKER,
        )
        self.assertEqual(w.filename, __file__)

        message = "Accessing jsonschema.draft3_format_checker is "
        with self.assertWarnsRegex(DeprecationWarning, message) as w:
            from jsonschema import draft3_format_checker

        self.assertIs(
            draft3_format_checker,
            validators.Draft3Validator.FORMAT_CHECKER,
        )
        self.assertEqual(w.filename, __file__)

        with self.assertRaises(ImportError):
            from jsonschema import draft1234_format_checker  # noqa: F401

    def test_import_cli(self):
        """
        As of v4.17.0, importing jsonschema.cli is deprecated.
        """

        message = "The jsonschema CLI is deprecated and will be removed "
        with self.assertWarnsRegex(DeprecationWarning, message) as w:
            import jsonschema.cli
            importlib.reload(jsonschema.cli)

        self.assertEqual(w.filename, importlib.__file__)

    def test_cli(self):
        """
        As of v4.17.0, the jsonschema CLI is deprecated.
        """

        process = subprocess.run(
            [sys.executable, "-m", "jsonschema"],
            capture_output=True,
            check=True,
        )
        self.assertIn(b"The jsonschema CLI is deprecated ", process.stderr)

    def test_automatic_remote_retrieval(self):
        """
        Automatic retrieval of remote references is deprecated as of v4.18.0.
        """
        ref = "http://bar#/$defs/baz"
        schema = {"$defs": {"baz": {"type": "integer"}}}

        if "requests" in sys.modules:  # pragma: no cover
            self.addCleanup(
                sys.modules.__setitem__, "requests", sys.modules["requests"],
            )
        sys.modules["requests"] = None

        @contextmanager
        def fake_urlopen(request):
            self.assertIsInstance(request, urllib.request.Request)
            self.assertEqual(request.full_url, "http://bar")

            # Ha ha urllib.request.Request "normalizes" header names and
            # Request.get_header does not also normalize them...
            (header, value), = request.header_items()
            self.assertEqual(header.lower(), "user-agent")
            self.assertEqual(
                value, "python-jsonschema (deprecated $ref resolution)",
            )
            yield BytesIO(json.dumps(schema).encode("utf8"))

        validator = validators.Draft202012Validator({"$ref": ref})

        message = "Automatically retrieving remote references "
        patch = mock.patch.object(urllib.request, "urlopen", new=fake_urlopen)

        with patch, self.assertWarnsRegex(DeprecationWarning, message):
            self.assertEqual(
                (validator.is_valid({}), validator.is_valid(37)),
                (False, True),
            )
