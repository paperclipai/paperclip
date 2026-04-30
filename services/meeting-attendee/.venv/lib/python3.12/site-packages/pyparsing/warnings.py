class PyparsingWarning(UserWarning):
    """Base warning class for all pyparsing warnings"""


class PyparsingDeprecationWarning(PyparsingWarning, DeprecationWarning):
    """Base warning class for all pyparsing deprecation warnings"""


class PyparsingDiagnosticWarning(PyparsingWarning):
    """Base warning class for all pyparsing diagnostic warnings"""
