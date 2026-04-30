"""Private logic for creating pydantic dataclasses."""

from __future__ import annotations as _annotations

import copy
import dataclasses
import sys
import warnings
from collections.abc import Generator
from contextlib import contextmanager
from functools import partial
from typing import TYPE_CHECKING, Any, ClassVar, Protocol, cast

from pydantic_core import (
    ArgsKwargs,
    SchemaSerializer,
    SchemaValidator,
    core_schema,
)
from typing_extensions import TypeAlias, TypeIs

from ..errors import PydanticUndefinedAnnotation
from ..fields import FieldInfo
from ..plugin._schema_validator import PluggableSchemaValidator, create_schema_validator
from ..warnings import PydanticDeprecatedSince20
from . import _config, _decorators
from ._fields import collect_dataclass_fields
from ._generate_schema import GenerateSchema, InvalidSchemaError
from ._generics import get_standard_typevars_map
from ._mock_val_ser import set_dataclass_mocks
from ._namespace_utils import NsResolver
from ._signature import generate_pydantic_signature
from ._utils import LazyClassAttribute

if TYPE_CHECKING:
    from _typeshed import DataclassInstance as StandardDataclass

    from ..config import ConfigDict

    class PydanticDataclass(StandardDataclass, Protocol):
        """A protocol containing attributes only available once a class has been decorated as a Pydantic dataclass.

        Attributes:
            __pydantic_config__: Pydantic-specific configuration settings for the dataclass.
            __pydantic_complete__: Whether dataclass building is completed, or if there are still undefined fields.
            __pydantic_core_schema__: The pydantic-core schema used to build the SchemaValidator and SchemaSerializer.
            __pydantic_decorators__: Metadata containing the decorators defined on the dataclass.
            __pydantic_fields__: Metadata about the fields defined on the dataclass.
            __pydantic_serializer__: The pydantic-core SchemaSerializer used to dump instances of the dataclass.
            __pydantic_validator__: The pydantic-core SchemaValidator used to validate instances of the dataclass.
        """

        __pydantic_config__: ClassVar[ConfigDict]
        __pydantic_complete__: ClassVar[bool]
        __pydantic_core_schema__: ClassVar[core_schema.CoreSchema]
        __pydantic_decorators__: ClassVar[_decorators.DecoratorInfos]
        __pydantic_fields__: ClassVar[dict[str, FieldInfo]]
        __pydantic_serializer__: ClassVar[SchemaSerializer]
        __pydantic_validator__: ClassVar[SchemaValidator | PluggableSchemaValidator]

        @classmethod
        def __pydantic_fields_complete__(cls) -> bool: ...


def set_dataclass_fields(
    cls: type[StandardDataclass],
    config_wrapper: _config.ConfigWrapper,
    ns_resolver: NsResolver | None = None,
) -> None:
    """Collect and set `cls.__pydantic_fields__`.

    Args:
        cls: The class.
        config_wrapper: The config wrapper instance.
        ns_resolver: Namespace resolver to use when getting dataclass annotations.
    """
    typevars_map = get_standard_typevars_map(cls)
    fields = collect_dataclass_fields(
        cls, ns_resolver=ns_resolver, typevars_map=typevars_map, config_wrapper=config_wrapper
    )

    cls.__pydantic_fields__ = fields  # type: ignore


def complete_dataclass(
    cls: type[Any],
    config_wrapper: _config.ConfigWrapper,
    *,
    raise_errors: bool = True,
    ns_resolver: NsResolver | None = None,
    _force_build: bool = False,
) -> bool:
    """Finish building a pydantic dataclass.

    This logic is called on a class which has already been wrapped in `dataclasses.dataclass()`.

    This is somewhat analogous to `pydantic._internal._model_construction.complete_model_class`.

    Args:
        cls: The class.
        config_wrapper: The config wrapper instance.
        raise_errors: Whether to raise errors, defaults to `True`.
        ns_resolver: The namespace resolver instance to use when collecting dataclass fields
            and during schema building.
        _force_build: Whether to force building the dataclass, no matter if
            [`defer_build`][pydantic.config.ConfigDict.defer_build] is set.

    Returns:
        `True` if building a pydantic dataclass is successfully completed, `False` otherwise.

    Raises:
        PydanticUndefinedAnnotation: If `raise_error` is `True` and there is an undefined annotations.
    """
    original_init = cls.__init__

    # dataclass.__init__ must be defined here so its `__qualname__` can be changed since functions can't be copied,
    # and so that the mock validator is used if building was deferred:
    def __init__(__dataclass_self__: PydanticDataclass, *args: Any, **kwargs: Any) -> None:
        __tracebackhide__ = True
        s = __dataclass_self__
        s.__pydantic_validator__.validate_python(ArgsKwargs(args, kwargs), self_instance=s)

    __init__.__qualname__ = f'{cls.__qualname__}.__init__'

    cls.__init__ = __init__  # type: ignore
    cls.__pydantic_config__ = config_wrapper.config_dict  # type: ignore

    set_dataclass_fields(cls, config_wrapper=config_wrapper, ns_resolver=ns_resolver)

    if not _force_build and config_wrapper.defer_build:
        set_dataclass_mocks(cls)
        return False

    if hasattr(cls, '__post_init_post_parse__'):
        warnings.warn(
            'Support for `__post_init_post_parse__` has been dropped, the method will not be called',
            PydanticDeprecatedSince20,
        )

    typevars_map = get_standard_typevars_map(cls)
    gen_schema = GenerateSchema(
        config_wrapper,
        ns_resolver=ns_resolver,
        typevars_map=typevars_map,
    )

    # set __signature__ attr only for the class, but not for its instances
    # (because instances can define `__call__`, and `inspect.signature` shouldn't
    # use the `__signature__` attribute and instead generate from `__call__`).
    cls.__signature__ = LazyClassAttribute(
        '__signature__',
        partial(
            generate_pydantic_signature,
            # It's important that we reference the `original_init` here,
            # as it is the one synthesized by the stdlib `dataclass` module:
            init=original_init,
            fields=cls.__pydantic_fields__,  # type: ignore
            validate_by_name=config_wrapper.validate_by_name,
            extra=config_wrapper.extra,
            is_dataclass=True,
        ),
    )

    try:
        schema = gen_schema.generate_schema(cls)
    except PydanticUndefinedAnnotation as e:
        if raise_errors:
            raise
        set_dataclass_mocks(cls, f'`{e.name}`')
        return False

    core_config = config_wrapper.core_config(title=cls.__name__)

    try:
        schema = gen_schema.clean_schema(schema)
    except InvalidSchemaError:
        set_dataclass_mocks(cls)
        return False

    # We are about to set all the remaining required properties expected for this cast;
    # __pydantic_decorators__ and __pydantic_fields__ should already be set
    cls = cast('type[PydanticDataclass]', cls)

    cls.__pydantic_core_schema__ = schema
    cls.__pydantic_validator__ = create_schema_validator(
        schema, cls, cls.__module__, cls.__qualname__, 'dataclass', core_config, config_wrapper.plugin_settings
    )
    cls.__pydantic_serializer__ = SchemaSerializer(schema, core_config)
    cls.__pydantic_complete__ = True
    return True


def is_stdlib_dataclass(cls: type[Any], /) -> TypeIs[type[StandardDataclass]]:
    """Returns `True` if the class is a stdlib dataclass and *not* a Pydantic dataclass.

    Unlike the stdlib `dataclasses.is_dataclass()` function, this does *not* include subclasses
    of a dataclass that are themselves not dataclasses.

    Args:
        cls: The class.

    Returns:
        `True` if the class is a stdlib dataclass, `False` otherwise.
    """
    return '__dataclass_fields__' in cls.__dict__ and not hasattr(cls, '__pydantic_validator__')


def as_dataclass_field(pydantic_field: FieldInfo) -> dataclasses.Field[Any]:
    field_args: dict[str, Any] = {'default': pydantic_field}

    # Needed because if `doc` is set, the dataclass slots will be a dict (field name -> doc) instead of a tuple:
    if sys.version_info >= (3, 14) and pydantic_field.description is not None:
        field_args['doc'] = pydantic_field.description

    # Needed as the stdlib dataclass module processes kw_only in a specific way during class construction:
    if sys.version_info >= (3, 10) and pydantic_field.kw_only is not None:
        field_args['kw_only'] = pydantic_field.kw_only

    # Needed as the stdlib dataclass modules generates `__repr__()` during class construction:
    if pydantic_field.repr is not True:
        field_args['repr'] = pydantic_field.repr

    return dataclasses.field(**field_args)


DcFields: TypeAlias = dict[str, dataclasses.Field[Any]]


@contextmanager
def patch_base_fields(cls: type[Any]) -> Generator[None]:
    """Temporarily patch the stdlib dataclasses bases of `cls` if the Pydantic `Field()` function is used.

    When creating a Pydantic dataclass, it is possible to inherit from stdlib dataclasses, where
    the Pydantic `Field()` function is used. To create this Pydantic dataclass, we first apply
    the stdlib `@dataclass` decorator on it. During the construction of the stdlib dataclass,
    the `kw_only` and `repr` field arguments need to be understood by the stdlib *during* the
    dataclass construction. To do so, we temporarily patch the fields dictionary of the affected
    bases.

    For instance, with the following example:

    ```python {test="skip" lint="skip"}
    import dataclasses as stdlib_dc

    import pydantic
    import pydantic.dataclasses as pydantic_dc

    @stdlib_dc.dataclass
    class A:
        a: int = pydantic.Field(repr=False)

    # Notice that the `repr` attribute of the dataclass field is `True`:
    A.__dataclass_fields__['a']
    #> dataclass.Field(default=FieldInfo(repr=False), repr=True, ...)

    @pydantic_dc.dataclass
    class B(A):
        b: int = pydantic.Field(repr=False)
    ```

    When passing `B` to the stdlib `@dataclass` decorator, it will look for fields in the parent classes
    and reuse them directly. When this context manager is active, `A` will be temporarily patched to be
    equivalent to:

    ```python {test="skip" lint="skip"}
    @stdlib_dc.dataclass
    class A:
        a: int = stdlib_dc.field(default=Field(repr=False), repr=False)
    ```

    !!! note
        This is only applied to the bases of `cls`, and not `cls` itself. The reason is that the Pydantic
        dataclass decorator "owns" `cls` (in the previous example, `B`). As such, we instead modify the fields
        directly (in the previous example, we simply do `setattr(B, 'b', as_dataclass_field(pydantic_field))`).

    !!! note
        This approach is far from ideal, and can probably be the source of unwanted side effects/race conditions.
        The previous implemented approach was mutating the `__annotations__` dict of `cls`, which is no longer a
        safe operation in Python 3.14+, and resulted in unexpected behavior with field ordering anyway.
    """
    # A list of two-tuples, the first element being a reference to the
    # dataclass fields dictionary, the second element being a mapping between
    # the field names that were modified, and their original `Field`:
    original_fields_list: list[tuple[DcFields, DcFields]] = []

    for base in cls.__mro__[1:]:
        dc_fields: dict[str, dataclasses.Field[Any]] = base.__dict__.get('__dataclass_fields__', {})
        dc_fields_with_pydantic_field_defaults = {
            field_name: field
            for field_name, field in dc_fields.items()
            if isinstance(field.default, FieldInfo)
            # Only do the patching if one of the affected attributes is set:
            and (field.default.description is not None or field.default.kw_only or field.default.repr is not True)
        }
        if dc_fields_with_pydantic_field_defaults:
            original_fields_list.append((dc_fields, dc_fields_with_pydantic_field_defaults))
            for field_name, field in dc_fields_with_pydantic_field_defaults.items():
                default = cast(FieldInfo, field.default)
                # `dataclasses.Field` isn't documented as working with `copy.copy()`.
                # It is a class with `__slots__`, so should work (and we hope for the best):
                new_dc_field = copy.copy(field)
                # For base fields, no need to set `doc` from `FieldInfo.description`, this is only relevant
                # for the class under construction and handled in `as_dataclass_field()`.
                if sys.version_info >= (3, 10) and default.kw_only:
                    new_dc_field.kw_only = True
                if default.repr is not True:
                    new_dc_field.repr = default.repr
                dc_fields[field_name] = new_dc_field

    try:
        yield
    finally:
        for fields, original_fields in original_fields_list:
            for field_name, original_field in original_fields.items():
                fields[field_name] = original_field
