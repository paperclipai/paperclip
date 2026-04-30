from __future__ import annotations

import inspect
import typing_extensions
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


def assert_overloads_in_sync(
    source_func: Callable[..., Any],
    overloaded_func: Callable[..., Any],
    *,
    exclude_params: set[str] = set(),
) -> None:
    """Ensure that every @overload of overloaded_func contains all params from source_func."""
    source_sig = inspect.signature(source_func)
    overloads = typing_extensions.get_overloads(overloaded_func)

    if not overloads:
        raise AssertionError(f"No @overload definitions found for {overloaded_func!r}")

    errors: list[str] = []

    for i, overload_fn in enumerate(overloads):
        overload_sig = inspect.signature(overload_fn)
        for name, source_param in source_sig.parameters.items():
            if name in exclude_params:
                continue

            overload_param = overload_sig.parameters.get(name)
            if not overload_param:
                errors.append(f"overload {i}: `{name}` param is missing")
                continue

            if overload_param.annotation != source_param.annotation:
                errors.append(
                    f"overload {i}: types for `{name}` do not match; source={repr(source_param.annotation)} overload={repr(overload_param.annotation)}"
                )

    if errors:
        raise AssertionError(
            f"{len(errors)} errors encountered when comparing overload signatures:\n\n" + "\n\n".join(errors)
        )
