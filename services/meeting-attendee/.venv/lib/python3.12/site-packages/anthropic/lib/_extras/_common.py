from ..._exceptions import AnthropicError

INSTRUCTIONS = """

Anthropic error: missing required dependency `{library}`.

    $ pip install anthropic[{extra}]
"""


class MissingDependencyError(AnthropicError):
    def __init__(self, *, library: str, extra: str) -> None:
        super().__init__(INSTRUCTIONS.format(library=library, extra=extra))
