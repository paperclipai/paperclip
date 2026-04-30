"""Utility functions for working with docstrings."""

import typing as T
from collections import ChainMap
from inspect import Signature
from itertools import chain

from .common import (
    DocstringMeta,
    DocstringParam,
    DocstringReturns,
    DocstringStyle,
    RenderingStyle,
)
from .parser import compose, parse

_Func = T.Callable[..., T.Any]

assert DocstringReturns  # used in docstring


def combine_docstrings(
    *others: _Func,
    exclude: T.Iterable[T.Type[DocstringMeta]] = (),
    style: DocstringStyle = DocstringStyle.AUTO,
    rendering_style: RenderingStyle = RenderingStyle.COMPACT,
) -> _Func:
    """A function decorator that parses the docstrings from `others`,
    programmatically combines them with the parsed docstring of the decorated
    function, and replaces the docstring of the decorated function with the
    composed result. Only parameters that are part of the decorated functions
    signature are included in the combined docstring. When multiple sources for
    a parameter or docstring metadata exists then the decorator will first
    default to the wrapped function's value (when available) and otherwise use
    the rightmost definition from ``others``.

    The following example illustrates its usage:

    >>> def fun1(a, b, c, d):
    ...    '''short_description: fun1
    ...
    ...    :param a: fun1
    ...    :param b: fun1
    ...    :return: fun1
    ...    '''
    >>> def fun2(b, c, d, e):
    ...    '''short_description: fun2
    ...
    ...    long_description: fun2
    ...
    ...    :param b: fun2
    ...    :param c: fun2
    ...    :param e: fun2
    ...    '''
    >>> @combine_docstrings(fun1, fun2)
    >>> def decorated(a, b, c, d, e, f):
    ...     '''
    ...     :param e: decorated
    ...     :param f: decorated
    ...     '''
    >>> print(decorated.__doc__)
    short_description: fun2
    <BLANKLINE>
    long_description: fun2
    <BLANKLINE>
    :param a: fun1
    :param b: fun1
    :param c: fun2
    :param e: fun2
    :param f: decorated
    :returns: fun1
    >>> @combine_docstrings(fun1, fun2, exclude=[DocstringReturns])
    >>> def decorated(a, b, c, d, e, f): pass
    >>> print(decorated.__doc__)
    short_description: fun2
    <BLANKLINE>
    long_description: fun2
    <BLANKLINE>
    :param a: fun1
    :param b: fun1
    :param c: fun2
    :param e: fun2

    :param others: callables from which to parse docstrings.
    :param exclude: an iterable of ``DocstringMeta`` subclasses to exclude when
        combining docstrings.
    :param style: style composed docstring. The default will infer the style
        from the decorated function.
    :param rendering_style: The rendering style used to compose a docstring.
    :return: the decorated function with a modified docstring.
    """

    def wrapper(func: _Func) -> _Func:
        sig = Signature.from_callable(func)

        comb_doc = parse(func.__doc__ or "")
        docs = [parse(other.__doc__ or "") for other in others] + [comb_doc]
        params = dict(
            ChainMap(
                *(
                    {param.arg_name: param for param in doc.params}
                    for doc in docs
                )
            )
        )

        for doc in reversed(docs):
            if not doc.short_description:
                continue
            comb_doc.short_description = doc.short_description
            comb_doc.blank_after_short_description = (
                doc.blank_after_short_description
            )
            break

        for doc in reversed(docs):
            if not doc.long_description:
                continue
            comb_doc.long_description = doc.long_description
            comb_doc.blank_after_long_description = (
                doc.blank_after_long_description
            )
            break

        combined = {}
        for doc in docs:
            metas = {}
            for meta in doc.meta:
                meta_type = type(meta)
                if meta_type in exclude:
                    continue
                metas.setdefault(meta_type, []).append(meta)
            for meta_type, meta in metas.items():
                combined[meta_type] = meta

        combined[DocstringParam] = [
            params[name] for name in sig.parameters if name in params
        ]
        comb_doc.meta = list(chain(*combined.values()))
        func.__doc__ = compose(
            comb_doc, style=style, rendering_style=rendering_style
        )
        return func

    return wrapper
