"""
This module acts as a test that type checkers will allow each validator
class to be assigned to a variable of type `type[Validator]`

The assignation is only valid if type checkers recognize each Validator
implementation as a valid implementer of the protocol.
"""
from jsonschema.protocols import Validator
from jsonschema.validators import (
    Draft3Validator,
    Draft4Validator,
    Draft6Validator,
    Draft7Validator,
    Draft201909Validator,
    Draft202012Validator,
)

my_validator: type[Validator]

my_validator = Draft3Validator
my_validator = Draft4Validator
my_validator = Draft6Validator
my_validator = Draft7Validator
my_validator = Draft201909Validator
my_validator = Draft202012Validator


# in order to confirm that none of the above were incorrectly typed as 'Any'
# ensure that each of these assignments to a non-validator variable requires an
# ignore
none_var: None

none_var = Draft3Validator  # type: ignore[assignment]
none_var = Draft4Validator  # type: ignore[assignment]
none_var = Draft6Validator  # type: ignore[assignment]
none_var = Draft7Validator  # type: ignore[assignment]
none_var = Draft201909Validator  # type: ignore[assignment]
none_var = Draft202012Validator  # type: ignore[assignment]
