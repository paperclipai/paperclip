import decimal
from typing import Any, Literal

def from_json(
    json_data: bytes,
    /,
    *,
    allow_inf_nan: bool = True,
    cache_mode: Literal[True, False, 'all', 'keys', 'none'] = 'all',
    partial_mode: Literal[True, False, 'off', 'on', 'trailing-strings'] = False,
    catch_duplicate_keys: bool = False,
    float_mode: Literal['float', 'decimal', 'lossless-float'] = 'float',
) -> Any:
    """
    Parse input bytes into a JSON object.

    Arguments:
        json_data: The JSON data to parse
        allow_inf_nan: Whether to allow infinity (`Infinity` an `-Infinity`) and `NaN` values to float fields.
            Defaults to True.
        cache_mode: cache Python strings to improve performance at the cost of some memory usage
            - True / 'all' - cache all strings
            - 'keys' - cache only object keys
            - False / 'none' - cache nothing
        partial_mode: How to handle incomplete strings:
            - False / 'off' - raise an exception if the input is incomplete
            - True / 'on' - allow incomplete JSON but discard the last string if it is incomplete
            - 'trailing-strings' - allow incomplete JSON, and include the last incomplete string in the output
        catch_duplicate_keys: if True, raise an exception if objects contain the same key multiple times
        float_mode: How to return floats: as a `float`, `Decimal` or `LosslessFloat`

    Returns:
        Python object built from the JSON input.
    """

def cache_clear() -> None:
    """
    Reset the string cache.
    """

def cache_usage() -> int:
    """
    get the size of the string cache.

    Returns:
        Size of the string cache in bytes.
    """

class LosslessFloat:
    """
    Represents a float from JSON, by holding the underlying bytes representing a float from JSON.
    """
    def __init__(self, json_float: bytes) -> None:
        """Construct a LosslessFloat object from a JSON bytes slice"""

    def as_decimal(self) -> decimal.Decimal:
        """Construct a Python Decimal from the JSON bytes slice"""

    def __float__(self) -> float:
        """Construct a Python float from the JSON bytes slice"""

    def __bytes__(self) -> bytes:
        """Return the JSON bytes slice as bytes"""

    def __str__(self) -> str:
        """Return the JSON bytes slice as a string"""

    def __repr__(self) -> str: ...
