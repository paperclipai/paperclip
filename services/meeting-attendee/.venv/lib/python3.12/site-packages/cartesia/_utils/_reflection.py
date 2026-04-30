from __future__ import annotations

import inspect
from typing import Any, Callable


def function_has_argument(func: Callable[..., Any], arg_name: str) -> bool:
    """Returns whether or not the given function has a specific parameter"""
    sig = inspect.signature(func)
    return arg_name in sig.parameters


def assert_signatures_in_sync(
    source_func: Callable[..., Any],
    check_func: Callable[..., Any],
    *,
    exclude_params: set[str] = set(),
) -> None:
    """Ensure that the signature of the second function matches the first."""

    check_sig = inspect.signature(check_func)
    source_sig = inspect.signature(source_func)

    errors: list[str] = []

    for name, source_param in source_sig.parameters.items():
        if name in exclude_params:
            continue

        custom_param = check_sig.parameters.get(name)
        if not custom_param:
            errors.append(f"the `{name}` param is missing")
            continue

        if custom_param.annotation != source_param.annotation:
            errors.append(
                f"types for the `{name}` param are do not match; source={repr(source_param.annotation)} checking={repr(custom_param.annotation)}"
            )
            continue

    if errors:
        raise AssertionError(f"{len(errors)} errors encountered when comparing signatures:\n\n" + "\n\n".join(errors))
