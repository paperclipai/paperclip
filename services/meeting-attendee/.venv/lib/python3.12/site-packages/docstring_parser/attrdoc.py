"""Attribute docstrings parsing.

.. seealso:: https://peps.python.org/pep-0257/#what-is-a-docstring
"""

import ast
import inspect
import textwrap
import typing as T
from types import ModuleType

from .common import Docstring, DocstringParam


def ast_get_constant_value(node: ast.AST) -> T.Any:
    """Return the constant's value if the given node is a constant."""
    return getattr(node, "value")


def ast_unparse(node: ast.AST) -> T.Optional[str]:
    """Convert the AST node to source code as a string."""
    if hasattr(ast, "unparse"):
        return ast.unparse(node)
    # Support simple cases in Python < 3.9
    if isinstance(node, ast.Constant):
        return str(ast_get_constant_value(node))
    if isinstance(node, ast.Name):
        return node.id
    return None


def ast_is_literal_str(node: ast.AST) -> bool:
    """Return True if the given node is a literal string."""
    return (
        isinstance(node, ast.Expr)
        and isinstance(node.value, ast.Constant)
        and isinstance(ast_get_constant_value(node.value), str)
    )


def ast_get_attribute(
    node: ast.AST,
) -> T.Optional[T.Tuple[str, T.Optional[str], T.Optional[str]]]:
    """Return name, type and default if the given node is an attribute."""
    if isinstance(node, (ast.Assign, ast.AnnAssign)):
        target = (
            node.targets[0] if isinstance(node, ast.Assign) else node.target
        )
        if isinstance(target, ast.Name):
            type_str = None
            if isinstance(node, ast.AnnAssign):
                type_str = ast_unparse(node.annotation)
            default = None
            if node.value:
                default = ast_unparse(node.value)
            return target.id, type_str, default
    return None


class AttributeDocstrings(ast.NodeVisitor):
    """An ast.NodeVisitor that collects attribute docstrings."""

    attr_docs = None
    prev_attr = None

    def visit(self, node):
        if self.prev_attr and ast_is_literal_str(node):
            attr_name, attr_type, attr_default = self.prev_attr
            self.attr_docs[attr_name] = (
                ast_get_constant_value(node.value),
                attr_type,
                attr_default,
            )
        self.prev_attr = ast_get_attribute(node)
        if isinstance(node, (ast.ClassDef, ast.Module)):
            self.generic_visit(node)

    def get_attr_docs(
        self, component: T.Any
    ) -> T.Dict[str, T.Tuple[str, T.Optional[str], T.Optional[str]]]:
        """Get attribute docstrings from the given component.

        :param component: component to process (class or module)
        :returns: for each attribute docstring, a tuple with (description,
            type, default)
        """
        self.attr_docs = {}
        self.prev_attr = None
        try:
            source = textwrap.dedent(inspect.getsource(component))
        except OSError:
            pass
        else:
            tree = ast.parse(source)
            if inspect.ismodule(component):
                self.visit(tree)
            elif isinstance(tree, ast.Module) and isinstance(
                tree.body[0], ast.ClassDef
            ):
                self.visit(tree.body[0])
        return self.attr_docs


def add_attribute_docstrings(
    obj: T.Union[type, ModuleType], docstring: Docstring
) -> None:
    """Add attribute docstrings found in the object's source code.

    :param obj: object from which to parse attribute docstrings
    :param docstring: Docstring object where found attributes are added
    :returns: list with names of added attributes
    """
    params = set(p.arg_name for p in docstring.params)
    for arg_name, (description, type_name, default) in (
        AttributeDocstrings().get_attr_docs(obj).items()
    ):
        if arg_name not in params:
            param = DocstringParam(
                args=["attribute", arg_name],
                description=description,
                arg_name=arg_name,
                type_name=type_name,
                is_optional=default is not None,
                default=default,
            )
            docstring.meta.append(param)
