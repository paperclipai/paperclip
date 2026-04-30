class Doc:
    """Define the documentation of a type annotation using `Annotated`, to be
        used in class attributes, function and method parameters, return values,
        and variables.

    The value should be a positional-only string literal to allow static tools
    like editors and documentation generators to use it.

    This complements docstrings.

    The string value passed is available in the attribute `documentation`.

    Example:

    ```Python
    from typing import Annotated
    from annotated_doc import Doc

    def hi(name: Annotated[str, Doc("Who to say hi to")]) -> None:
        print(f"Hi, {name}!")
    ```
    """

    def __init__(self, documentation: str, /) -> None:
        self.documentation = documentation

    def __repr__(self) -> str:
        return f"Doc({self.documentation!r})"

    def __hash__(self) -> int:
        return hash(self.documentation)

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Doc):
            return NotImplemented
        return self.documentation == other.documentation
