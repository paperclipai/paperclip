"""
babel.lists
~~~~~~~~~~~

Locale dependent formatting of lists.

The default locale for the functions in this module is determined by the
following environment variables, in that order:

 * ``LC_ALL``, and
 * ``LANG``

:copyright: (c) 2015-2026 by the Babel Team.
:license: BSD, see LICENSE for more details.
"""

from __future__ import annotations

import warnings
from collections.abc import Sequence
from typing import Literal

from babel.core import Locale, default_locale

_DEFAULT_LOCALE = default_locale()  # TODO(3.0): Remove this.


def __getattr__(name):
    if name == "DEFAULT_LOCALE":
        warnings.warn(
            "The babel.lists.DEFAULT_LOCALE constant is deprecated and will be removed.",
            DeprecationWarning,
            stacklevel=2,
        )
        return _DEFAULT_LOCALE
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def format_list(
    lst: Sequence[str],
    style: Literal[
        'standard',
        'standard-short',
        'or',
        'or-short',
        'unit',
        'unit-short',
        'unit-narrow',
    ] = 'standard',
    locale: Locale | str | None = None,
) -> str:
    """
    Format the items in `lst` as a list.

    >>> format_list(['apples', 'oranges', 'pears'], locale='en')
    'apples, oranges, and pears'
    >>> format_list(['apples', 'oranges', 'pears'], locale='zh')
    'apples、oranges和pears'
    >>> format_list(['omena', 'peruna', 'aplari'], style='or', locale='fi')
    'omena, peruna tai aplari'

    Not all styles are necessarily available in all locales.
    The function will attempt to fall back to replacement styles according to the rules
    set forth in the CLDR root XML file, and raise a ValueError if no suitable replacement
    can be found.

    The following text is verbatim from the Unicode TR35-49 spec [1].

    * standard:
      A typical 'and' list for arbitrary placeholders.
      eg. "January, February, and March"
    * standard-short:
      A short version of an 'and' list, suitable for use with short or abbreviated placeholder values.
      eg. "Jan., Feb., and Mar."
    * or:
      A typical 'or' list for arbitrary placeholders.
      eg. "January, February, or March"
    * or-short:
      A short version of an 'or' list.
      eg. "Jan., Feb., or Mar."
    * unit:
      A list suitable for wide units.
      eg. "3 feet, 7 inches"
    * unit-short:
      A list suitable for short units
      eg. "3 ft, 7 in"
    * unit-narrow:
      A list suitable for narrow units, where space on the screen is very limited.
      eg. "3′ 7″"

    [1]: https://www.unicode.org/reports/tr35/tr35-49/tr35-general.html#ListPatterns

    :param lst: a sequence of items to format in to a list
    :param style: the style to format the list with. See above for description.
    :param locale: the locale. Defaults to the system locale.
    """
    locale = Locale.parse(locale or _DEFAULT_LOCALE)
    if not lst:
        return ''
    if len(lst) == 1:
        return lst[0]

    patterns = _resolve_list_style(locale, style)

    if len(lst) == 2 and '2' in patterns:
        return patterns['2'].format(*lst)

    result = patterns['start'].format(lst[0], lst[1])
    for elem in lst[2:-1]:
        result = patterns['middle'].format(result, elem)
    result = patterns['end'].format(result, lst[-1])

    return result


# Based on CLDR 45's root.xml file's `<alias>`es.
# The root file defines both `standard` and `or`,
# so they're always available.
# TODO: It would likely be better to use the
#       babel.localedata.Alias mechanism for this,
#       but I'm not quite sure how it's supposed to
#       work with inheritance and data in the root.
_style_fallbacks = {
    "or-narrow": ["or-short", "or"],
    "or-short": ["or"],
    "standard-narrow": ["standard-short", "standard"],
    "standard-short": ["standard"],
    "unit": ["unit-short", "standard"],
    "unit-narrow": ["unit-short", "unit", "standard"],
    "unit-short": ["standard"],
}


def _resolve_list_style(locale: Locale, style: str):
    for style in (style, *(_style_fallbacks.get(style, []))):  # noqa: B020
        if style in locale.list_patterns:
            return locale.list_patterns[style]
    raise ValueError(
        f"Locale {locale} does not support list formatting style {style!r} "
        f"(supported are {sorted(locale.list_patterns)})",
    )
