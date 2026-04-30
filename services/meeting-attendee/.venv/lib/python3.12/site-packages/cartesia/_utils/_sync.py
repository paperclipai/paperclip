from __future__ import annotations

import asyncio
import functools
from typing import TypeVar, Callable, Awaitable
from typing_extensions import ParamSpec

import anyio
import sniffio
import anyio.to_thread

T_Retval = TypeVar("T_Retval")
T_ParamSpec = ParamSpec("T_ParamSpec")


async def to_thread(
    func: Callable[T_ParamSpec, T_Retval], /, *args: T_ParamSpec.args, **kwargs: T_ParamSpec.kwargs
) -> T_Retval:
    if sniffio.current_async_library() == "asyncio":
        return await asyncio.to_thread(func, *args, **kwargs)

    return await anyio.to_thread.run_sync(
        functools.partial(func, *args, **kwargs),
    )


# inspired by `asyncer`, https://github.com/tiangolo/asyncer
def asyncify(function: Callable[T_ParamSpec, T_Retval]) -> Callable[T_ParamSpec, Awaitable[T_Retval]]:
    """
    Take a blocking function and create an async one that receives the same
    positional and keyword arguments.

    Usage:

    ```python
    def blocking_func(arg1, arg2, kwarg1=None):
        # blocking code
        return result


    result = asyncify(blocking_function)(arg1, arg2, kwarg1=value1)
    ```

    ## Arguments

    `function`: a blocking regular callable (e.g. a function)

    ## Return

    An async function that takes the same positional and keyword arguments as the
    original one, that when called runs the same original function in a thread worker
    and returns the result.
    """

    async def wrapper(*args: T_ParamSpec.args, **kwargs: T_ParamSpec.kwargs) -> T_Retval:
        return await to_thread(function, *args, **kwargs)

    return wrapper
