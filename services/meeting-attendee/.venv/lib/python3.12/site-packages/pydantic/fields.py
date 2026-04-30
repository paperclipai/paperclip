"""Defining fields on models."""

from __future__ import annotations as _annotations

import dataclasses
import inspect
import re
import sys
from collections.abc import Callable, Mapping
from copy import copy
from dataclasses import Field as DataclassField
from functools import cached_property
from typing import TYPE_CHECKING, Annotated, Any, ClassVar, Literal, TypeVar, final, overload
from warnings import warn

import annotated_types
import typing_extensions
from pydantic_core import MISSING, PydanticUndefined
from typing_extensions import Self, TypeAlias, TypedDict, Unpack, deprecated
from typing_inspection import typing_objects
from typing_inspection.introspection import UNKNOWN, AnnotationSource, ForbiddenQualifier, Qualifier, inspect_annotation

from . import types
from ._internal import _decorators, _fields, _generics, _internal_dataclass, _repr, _typing_extra, _utils
from ._internal._namespace_utils import GlobalsNamespace, MappingNamespace
from .aliases import AliasChoices, AliasGenerator, AliasPath
from .config import JsonDict
from .errors import PydanticForbiddenQualifier, PydanticUserError
from .json_schema import PydanticJsonSchemaWarning
from .warnings import PydanticDeprecatedSince20

if TYPE_CHECKING:
    from ._internal._config import ConfigWrapper
    from ._internal._repr import ReprArgs


__all__ = 'Field', 'FieldInfo', 'PrivateAttr', 'computed_field'


_Unset: Any = PydanticUndefined

if sys.version_info >= (3, 13):
    import warnings

    Deprecated: TypeAlias = warnings.deprecated | deprecated
else:
    Deprecated: TypeAlias = deprecated


class _FromFieldInfoInputs(TypedDict, total=False):
    """This class exists solely to add type checking for the `**kwargs` in `FieldInfo.from_field`."""

    # TODO PEP 747: use TypeForm:
    annotation: type[Any] | None
    default_factory: Callable[[], Any] | Callable[[dict[str, Any]], Any] | None
    alias: str | None
    alias_priority: int | None
    validation_alias: str | AliasPath | AliasChoices | None
    serialization_alias: str | None
    title: str | None
    field_title_generator: Callable[[str, FieldInfo], str] | None
    description: str | None
    examples: list[Any] | None
    exclude: bool | None
    exclude_if: Callable[[Any], bool] | None
    gt: annotated_types.SupportsGt | None
    ge: annotated_types.SupportsGe | None
    lt: annotated_types.SupportsLt | None
    le: annotated_types.SupportsLe | None
    multiple_of: float | None
    strict: bool | None
    min_length: int | None
    max_length: int | None
    pattern: str | re.Pattern[str] | None
    allow_inf_nan: bool | None
    max_digits: int | None
    decimal_places: int | None
    union_mode: Literal['smart', 'left_to_right'] | None
    discriminator: str | types.Discriminator | None
    deprecated: Deprecated | str | bool | None
    json_schema_extra: JsonDict | Callable[[JsonDict], None] | None
    frozen: bool | None
    validate_default: bool | None
    repr: bool
    init: bool | None
    init_var: bool | None
    kw_only: bool | None
    coerce_numbers_to_str: bool | None
    fail_fast: bool | None


class _FieldInfoInputs(_FromFieldInfoInputs, total=False):
    """This class exists solely to add type checking for the `**kwargs` in `FieldInfo.__init__`."""

    default: Any


class _FieldInfoAsDict(TypedDict, closed=True):
    # TODO PEP 747: use TypeForm:
    annotation: Any
    metadata: list[Any]
    attributes: dict[str, Any]


@final
class FieldInfo(_repr.Representation):
    """This class holds information about a field.

    `FieldInfo` is used for any field definition regardless of whether the [`Field()`][pydantic.fields.Field]
    function is explicitly used.

    !!! warning
        The `FieldInfo` class is meant to expose information about a field in a Pydantic model or dataclass.
        `FieldInfo` instances shouldn't be instantiated directly, nor mutated.

        If you need to derive a new model from another one and are willing to alter `FieldInfo` instances,
        refer to this [dynamic model example](../examples/dynamic_models.md).

    Attributes:
        annotation: The type annotation of the field.
        default: The default value of the field.
        default_factory: A callable to generate the default value. The callable can either take 0 arguments
            (in which case it is called as is) or a single argument containing the already validated data.
        alias: The alias name of the field.
        alias_priority: The priority of the field's alias.
        validation_alias: The validation alias of the field.
        serialization_alias: The serialization alias of the field.
        title: The title of the field.
        field_title_generator: A callable that takes a field name and returns title for it.
        description: The description of the field.
        examples: List of examples of the field.
        exclude: Whether to exclude the field from the model serialization.
        exclude_if: A callable that determines whether to exclude a field during serialization based on its value.
        discriminator: Field name or Discriminator for discriminating the type in a tagged union.
        deprecated: A deprecation message, an instance of `warnings.deprecated` or the `typing_extensions.deprecated` backport,
            or a boolean. If `True`, a default deprecation message will be emitted when accessing the field.
        json_schema_extra: A dict or callable to provide extra JSON schema properties.
        frozen: Whether the field is frozen.
        validate_default: Whether to validate the default value of the field.
        repr: Whether to include the field in representation of the model.
        init: Whether the field should be included in the constructor of the dataclass.
        init_var: Whether the field should _only_ be included in the constructor of the dataclass, and not stored.
        kw_only: Whether the field should be a keyword-only argument in the constructor of the dataclass.
        metadata: The metadata list. Contains all the data that isn't expressed as direct `FieldInfo` attributes, including:

            * Type-specific constraints, such as `gt` or `min_length` (these are converted to metadata classes such as `annotated_types.Gt`).
            * Any other arbitrary object used within [`Annotated`][typing.Annotated] metadata
              (e.g. [custom types handlers](../concepts/types.md#as-an-annotation) or any object not recognized by Pydantic).
    """

    # TODO PEP 747: use TypeForm:
    annotation: type[Any] | None
    default: Any
    default_factory: Callable[[], Any] | Callable[[dict[str, Any]], Any] | None
    alias: str | None
    alias_priority: int | None
    validation_alias: str | AliasPath | AliasChoices | None
    serialization_alias: str | None
    title: str | None
    field_title_generator: Callable[[str, FieldInfo], str] | None
    description: str | None
    examples: list[Any] | None
    exclude: bool | None
    exclude_if: Callable[[Any], bool] | None
    discriminator: str | types.Discriminator | None
    deprecated: Deprecated | str | bool | None
    json_schema_extra: JsonDict | Callable[[JsonDict], None] | None
    frozen: bool | None
    validate_default: bool | None
    repr: bool
    init: bool | None
    init_var: bool | None
    kw_only: bool | None
    metadata: list[Any]

    __slots__ = (
        'annotation',
        'default',
        'default_factory',
        'alias',
        'alias_priority',
        'validation_alias',
        'serialization_alias',
        'title',
        'field_title_generator',
        'description',
        'examples',
        'exclude',
        'exclude_if',
        'discriminator',
        'deprecated',
        'json_schema_extra',
        'frozen',
        'validate_default',
        'repr',
        'init',
        'init_var',
        'kw_only',
        'metadata',
        '_attributes_set',
        '_qualifiers',
        '_complete',
        '_original_assignment',
        '_original_annotation',
        '_final',
    )

    # used to convert kwargs to metadata/constraints,
    # None has a special meaning - these items are collected into a `PydanticGeneralMetadata`
    metadata_lookup: ClassVar[dict[str, Callable[[Any], Any] | None]] = {
        'strict': types.Strict,
        'gt': annotated_types.Gt,
        'ge': annotated_types.Ge,
        'lt': annotated_types.Lt,
        'le': annotated_types.Le,
        'multiple_of': annotated_types.MultipleOf,
        'min_length': annotated_types.MinLen,
        'max_length': annotated_types.MaxLen,
        'pattern': None,
        'allow_inf_nan': None,
        'max_digits': None,
        'decimal_places': None,
        'union_mode': None,
        'coerce_numbers_to_str': None,
        'fail_fast': types.FailFast,
    }

    def __init__(self, **kwargs: Unpack[_FieldInfoInputs]) -> None:
        """This class should generally not be initialized directly; instead, use the `pydantic.fields.Field` function
        or one of the constructor classmethods.

        See the signature of `pydantic.fields.Field` for more details about the expected arguments.
        """
        # Tracking the explicitly set attributes is necessary to correctly merge `Field()` functions
        # (e.g. with `Annotated[int, Field(alias='a'), Field(alias=None)]`, even though `None` is the default value,
        # we need to track that `alias=None` was explicitly set):
        self._attributes_set = {k: v for k, v in kwargs.items() if v is not _Unset and k not in self.metadata_lookup}
        kwargs = {k: _DefaultValues.get(k) if v is _Unset else v for k, v in kwargs.items()}  # type: ignore
        self.annotation = kwargs.get('annotation')

        # Note: in theory, the second `pop()` arguments are not required below, as defaults are already set from `_DefaultsValues`.
        default = kwargs.pop('default', PydanticUndefined)
        if default is Ellipsis:
            self.default = PydanticUndefined
            self._attributes_set.pop('default', None)
        else:
            self.default = default

        self.default_factory = kwargs.pop('default_factory', None)

        if self.default is not PydanticUndefined and self.default_factory is not None:
            raise TypeError('cannot specify both default and default_factory')

        self.alias = kwargs.pop('alias', None)
        self.validation_alias = kwargs.pop('validation_alias', None)
        self.serialization_alias = kwargs.pop('serialization_alias', None)
        alias_is_set = any(alias is not None for alias in (self.alias, self.validation_alias, self.serialization_alias))
        self.alias_priority = kwargs.pop('alias_priority', None) or 2 if alias_is_set else None
        self.title = kwargs.pop('title', None)
        self.field_title_generator = kwargs.pop('field_title_generator', None)
        self.description = kwargs.pop('description', None)
        self.examples = kwargs.pop('examples', None)
        self.exclude = kwargs.pop('exclude', None)
        self.exclude_if = kwargs.pop('exclude_if', None)
        self.discriminator = kwargs.pop('discriminator', None)
        # For compatibility with FastAPI<=0.110.0, we preserve the existing value if it is not overridden
        self.deprecated = kwargs.pop('deprecated', getattr(self, 'deprecated', None))
        self.repr = kwargs.pop('repr', True)
        self.json_schema_extra = kwargs.pop('json_schema_extra', None)
        self.validate_default = kwargs.pop('validate_default', None)
        self.frozen = kwargs.pop('frozen', None)
        # currently only used on dataclasses
        self.init = kwargs.pop('init', None)
        self.init_var = kwargs.pop('init_var', None)
        self.kw_only = kwargs.pop('kw_only', None)

        self.metadata = self._collect_metadata(kwargs)  # type: ignore

        # Private attributes:
        self._qualifiers: set[Qualifier] = set()
        # Used to rebuild FieldInfo instances:
        self._complete = True
        self._original_annotation: Any = PydanticUndefined
        self._original_assignment: Any = PydanticUndefined
        # Used to track whether the `FieldInfo` instance represents the data about a field (and is exposed in `model_fields`/`__pydantic_fields__`),
        # or if it is the result of the `Field()` function being used as metadata in an `Annotated` type/as an assignment
        # (not an ideal pattern, see https://github.com/pydantic/pydantic/issues/11122):
        self._final = False

    @staticmethod
    def from_field(default: Any = PydanticUndefined, **kwargs: Unpack[_FromFieldInfoInputs]) -> FieldInfo:
        """Create a new `FieldInfo` object with the `Field` function.

        Args:
            default: The default value for the field. Defaults to Undefined.
            **kwargs: Additional arguments dictionary.

        Raises:
            TypeError: If 'annotation' is passed as a keyword argument.

        Returns:
            A new FieldInfo object with the given parameters.

        Example:
            This is how you can create a field with default value like this:

            ```python
            import pydantic

            class MyModel(pydantic.BaseModel):
                foo: int = pydantic.Field(4)
            ```
        """
        if 'annotation' in kwargs:
            raise TypeError('"annotation" is not permitted as a Field keyword argument')
        return FieldInfo(default=default, **kwargs)

    @staticmethod
    def from_annotation(annotation: type[Any], *, _source: AnnotationSource = AnnotationSource.ANY) -> FieldInfo:
        """Creates a `FieldInfo` instance from a bare annotation.

        This function is used internally to create a `FieldInfo` from a bare annotation like this:

        ```python
        import pydantic

        class MyModel(pydantic.BaseModel):
            foo: int  # <-- like this
        ```

        We also account for the case where the annotation can be an instance of `Annotated` and where
        one of the (not first) arguments in `Annotated` is an instance of `FieldInfo`, e.g.:

        ```python
        from typing import Annotated

        import annotated_types

        import pydantic

        class MyModel(pydantic.BaseModel):
            foo: Annotated[int, annotated_types.Gt(42)]
            bar: Annotated[int, pydantic.Field(gt=42)]
        ```

        Args:
            annotation: An annotation object.

        Returns:
            An instance of the field metadata.
        """
        try:
            inspected_ann = inspect_annotation(
                annotation,
                annotation_source=_source,
                unpack_type_aliases='skip',
            )
        except ForbiddenQualifier as e:
            raise PydanticForbiddenQualifier(e.qualifier, annotation)

        # TODO check for classvar and error?

        # No assigned value, this happens when using a bare `Final` qualifier (also for other
        # qualifiers, but they shouldn't appear here). In this case we infer the type as `Any`
        # because we don't have any assigned value.
        type_expr: Any = Any if inspected_ann.type is UNKNOWN else inspected_ann.type
        final = 'final' in inspected_ann.qualifiers
        metadata = inspected_ann.metadata

        attr_overrides = {'annotation': type_expr}
        if final:
            attr_overrides['frozen'] = True
        field_info = FieldInfo._construct(metadata, **attr_overrides)
        field_info._qualifiers = inspected_ann.qualifiers
        field_info._final = True
        return field_info

    @staticmethod
    def from_annotated_attribute(
        annotation: type[Any], default: Any, *, _source: AnnotationSource = AnnotationSource.ANY
    ) -> FieldInfo:
        """Create `FieldInfo` from an annotation with a default value.

        This is used in cases like the following:

        ```python
        from typing import Annotated

        import annotated_types

        import pydantic

        class MyModel(pydantic.BaseModel):
            foo: int = 4  # <-- like this
            bar: Annotated[int, annotated_types.Gt(4)] = 4  # <-- or this
            spam: Annotated[int, pydantic.Field(gt=4)] = 4  # <-- or this
        ```

        Args:
            annotation: The type annotation of the field.
            default: The default value of the field.

        Returns:
            A field object with the passed values.
        """
        if annotation is not MISSING and annotation is default:
            raise PydanticUserError(
                'Error when building FieldInfo from annotated attribute. '
                "Make sure you don't have any field name clashing with a type annotation.",
                code='unevaluable-type-annotation',
            )

        try:
            inspected_ann = inspect_annotation(
                annotation,
                annotation_source=_source,
                unpack_type_aliases='skip',
            )
        except ForbiddenQualifier as e:
            raise PydanticForbiddenQualifier(e.qualifier, annotation)

        # TODO check for classvar and error?

        # TODO infer from the default, this can be done in v3 once we treat final fields with
        # a default as proper fields and not class variables:
        type_expr: Any = Any if inspected_ann.type is UNKNOWN else inspected_ann.type
        final = 'final' in inspected_ann.qualifiers
        metadata = inspected_ann.metadata

        # HACK 1: the order in which the metadata is merged is inconsistent; we need to prepend
        # metadata from the assignment at the beginning of the metadata. Changing this is only
        # possible in v3 (at least). See https://github.com/pydantic/pydantic/issues/10507
        prepend_metadata: list[Any] | None = None
        attr_overrides = {'annotation': type_expr}
        if final:
            attr_overrides['frozen'] = True

        # HACK 2: FastAPI is subclassing `FieldInfo` and historically expected the actual
        # instance's type to be preserved when constructing new models with its subclasses as assignments.
        # This code is never reached by Pydantic itself, and in an ideal world this shouldn't be necessary.
        if not metadata and isinstance(default, FieldInfo) and type(default) is not FieldInfo:
            field_info = default._copy()
            field_info._attributes_set.update(attr_overrides)
            for k, v in attr_overrides.items():
                setattr(field_info, k, v)
            return field_info

        if isinstance(default, FieldInfo):
            default_copy = default._copy()  # Copy unnecessary when we remove HACK 1.
            prepend_metadata = default_copy.metadata
            default_copy.metadata = []
            metadata = metadata + [default_copy]
            if 'init_var' in inspected_ann.qualifiers:
                # Only relevant for dataclasses, when `f: InitVar[<type>] = Field(...)`
                # is used:
                attr_overrides['init_var'] = True
        elif isinstance(default, dataclasses.Field):
            from_field = FieldInfo._from_dataclass_field(default)
            prepend_metadata = from_field.metadata  # Unnecessary when we remove HACK 1.
            from_field.metadata = []
            metadata = metadata + [from_field]
            if 'init_var' in inspected_ann.qualifiers:
                attr_overrides['init_var'] = True
            if (init := getattr(default, 'init', None)) is not None:
                attr_overrides['init'] = init
            if (kw_only := getattr(default, 'kw_only', None)) is not None:
                attr_overrides['kw_only'] = kw_only
        else:
            # `default` is the actual default value
            attr_overrides['default'] = default

        field_info = FieldInfo._construct(
            prepend_metadata + metadata if prepend_metadata is not None else metadata, **attr_overrides
        )
        field_info._qualifiers = inspected_ann.qualifiers
        field_info._final = True
        return field_info

    @classmethod
    def _construct(cls, metadata: list[Any], **attr_overrides: Any) -> Self:
        """Construct the final `FieldInfo` instance, by merging the possibly existing `FieldInfo` instances from the metadata.

        With the following example:

        ```python {test="skip" lint="skip"}
        class Model(BaseModel):
            f: Annotated[int, Gt(1), Field(description='desc', lt=2)]
        ```

        `metadata` refers to the metadata elements of the `Annotated` form. This metadata is iterated over from left to right:

        - If the element is a `Field()` function (which is itself a `FieldInfo` instance), the field attributes (such as
          `description`) are saved to be set on the final `FieldInfo` instance.
          On the other hand, some kwargs (such as `lt`) are stored as `metadata` (see `FieldInfo.__init__()`, calling
          `FieldInfo._collect_metadata()`). In this case, the final metadata list is extended with the one from this instance.
        - Else, the element is considered as a single metadata object, and is appended to the final metadata list.

        Args:
            metadata: The list of metadata elements to merge together. If the `FieldInfo` instance to be constructed is for
                a field with an assigned `Field()`, this `Field()` assignment should be added as the last element of the
                provided metadata.
            **attr_overrides: Extra attributes that should be set on the final merged `FieldInfo` instance.

        Returns:
            The final merged `FieldInfo` instance.
        """
        merged_metadata: list[Any] = []
        merged_kwargs: dict[str, Any] = {}

        for meta in metadata:
            if isinstance(meta, FieldInfo):
                merged_metadata.extend(meta.metadata)

                new_js_extra: JsonDict | None = None
                current_js_extra = meta.json_schema_extra
                if current_js_extra is not None and 'json_schema_extra' in merged_kwargs:
                    # We need to merge `json_schema_extra`'s:
                    existing_js_extra = merged_kwargs['json_schema_extra']
                    if isinstance(existing_js_extra, dict):
                        if isinstance(current_js_extra, dict):
                            new_js_extra = {
                                **existing_js_extra,
                                **current_js_extra,
                            }
                        elif callable(current_js_extra):
                            warn(
                                'Composing `dict` and `callable` type `json_schema_extra` is not supported. '
                                'The `callable` type is being ignored. '
                                "If you'd like support for this behavior, please open an issue on pydantic.",
                                UserWarning,
                            )
                    elif callable(existing_js_extra) and isinstance(current_js_extra, dict):
                        warn(
                            'Composing `dict` and `callable` type `json_schema_extra` is not supported. '
                            'The `callable` type is being ignored. '
                            "If you'd like support for this behavior, please open an issue on pydantic.",
                            UserWarning,
                        )

                # HACK: It is common for users to define "make model partial" (or similar) utilities, that
                # convert all model fields to be optional (i.e. have a default value). To do so, they mutate
                # each `FieldInfo` instance from `model_fields` to set a `default`, and use `create_model()`
                # with `Annotated[<orig_type> | None, mutated_field_info]`` as an annotation. However, such
                # mutations (by doing simple assignments) are only accidentally working, because we also
                # need to track attributes explicitly set in `_attributes_set` (relying on default values for
                # each attribute is *not* enough, for instance with `Annotated[int, Field(alias='a'), Field(alias=None)]`
                # the resulting `FieldInfo` should have `alias=None`).
                # To mitigate this, we add a special case when a "final" `FieldInfo` instance (that is an instance coming
                # from `model_fields`) is used in annotated metadata (or assignment). In this case, we assume *all* attributes
                # were explicitly set, and as such we use all of them (and this will correctly pick up the mutations).
                # In theory, this shouldn't really be supported, you are only supposed to use the `Field()` function, not
                # a `FieldInfo` instance directly (granted, `Field()` returns a `FieldInfo`, see
                # https://github.com/pydantic/pydantic/issues/11122):
                if meta._final:
                    merged_kwargs.update({attr: getattr(meta, attr) for attr in _Attrs})
                else:
                    merged_kwargs.update(meta._attributes_set)

                if new_js_extra is not None:
                    merged_kwargs['json_schema_extra'] = new_js_extra
            elif typing_objects.is_deprecated(meta):
                merged_kwargs['deprecated'] = meta
            else:
                merged_metadata.append(meta)

        merged_kwargs.update(attr_overrides)
        merged_field_info = cls(**merged_kwargs)
        merged_field_info.metadata = merged_metadata
        return merged_field_info

    @staticmethod
    @typing_extensions.deprecated(
        "The 'merge_field_infos()' method is deprecated and will be removed in a future version. "
        'If you relied on this method, please open an issue in the Pydantic issue tracker.',
        category=None,
    )
    def merge_field_infos(*field_infos: FieldInfo, **overrides: Any) -> FieldInfo:
        """Merge `FieldInfo` instances keeping only explicitly set attributes.

        Later `FieldInfo` instances override earlier ones.

        Returns:
            FieldInfo: A merged FieldInfo instance.
        """
        if len(field_infos) == 1:
            # No merging necessary, but we still need to make a copy and apply the overrides
            field_info = field_infos[0]._copy()
            field_info._attributes_set.update(overrides)

            default_override = overrides.pop('default', PydanticUndefined)
            if default_override is Ellipsis:
                default_override = PydanticUndefined
            if default_override is not PydanticUndefined:
                field_info.default = default_override

            for k, v in overrides.items():
                setattr(field_info, k, v)
            return field_info  # type: ignore

        merged_field_info_kwargs: dict[str, Any] = {}
        metadata = {}
        for field_info in field_infos:
            attributes_set = field_info._attributes_set.copy()

            try:
                json_schema_extra = attributes_set.pop('json_schema_extra')
                existing_json_schema_extra = merged_field_info_kwargs.get('json_schema_extra')

                if existing_json_schema_extra is None:
                    merged_field_info_kwargs['json_schema_extra'] = json_schema_extra
                if isinstance(existing_json_schema_extra, dict):
                    if isinstance(json_schema_extra, dict):
                        merged_field_info_kwargs['json_schema_extra'] = {
                            **existing_json_schema_extra,
                            **json_schema_extra,
                        }
                    if callable(json_schema_extra):
                        warn(
                            'Composing `dict` and `callable` type `json_schema_extra` is not supported.'
                            'The `callable` type is being ignored.'
                            "If you'd like support for this behavior, please open an issue on pydantic.",
                            PydanticJsonSchemaWarning,
                        )
                elif callable(json_schema_extra):
                    # if ever there's a case of a callable, we'll just keep the last json schema extra spec
                    merged_field_info_kwargs['json_schema_extra'] = json_schema_extra
            except KeyError:
                pass

            # later FieldInfo instances override everything except json_schema_extra from earlier FieldInfo instances
            merged_field_info_kwargs.update(attributes_set)

            for x in field_info.metadata:
                if not isinstance(x, FieldInfo):
                    metadata[type(x)] = x

        merged_field_info_kwargs.update(overrides)
        field_info = FieldInfo(**merged_field_info_kwargs)
        field_info.metadata = list(metadata.values())
        return field_info

    @staticmethod
    def _from_dataclass_field(dc_field: DataclassField[Any]) -> FieldInfo:
        """Return a new `FieldInfo` instance from a `dataclasses.Field` instance.

        Args:
            dc_field: The `dataclasses.Field` instance to convert.

        Returns:
            The corresponding `FieldInfo` instance.

        Raises:
            TypeError: If any of the `FieldInfo` kwargs does not match the `dataclass.Field` kwargs.
        """
        default = dc_field.default
        if default is dataclasses.MISSING:
            default = _Unset

        if dc_field.default_factory is dataclasses.MISSING:
            default_factory = _Unset
        else:
            default_factory = dc_field.default_factory

        # use the `Field` function so in correct kwargs raise the correct `TypeError`
        dc_field_metadata = {k: v for k, v in dc_field.metadata.items() if k in _FIELD_ARG_NAMES}
        if sys.version_info >= (3, 14) and dc_field.doc is not None:
            dc_field_metadata['description'] = dc_field.doc
        return Field(default=default, default_factory=default_factory, repr=dc_field.repr, **dc_field_metadata)  # pyright: ignore[reportCallIssue]

    @staticmethod
    def _collect_metadata(kwargs: dict[str, Any]) -> list[Any]:
        """Collect annotations from kwargs.

        Args:
            kwargs: Keyword arguments passed to the function.

        Returns:
            A list of metadata objects - a combination of `annotated_types.BaseMetadata` and
                `PydanticMetadata`.
        """
        metadata: list[Any] = []
        general_metadata = {}
        for key, value in list(kwargs.items()):
            try:
                marker = FieldInfo.metadata_lookup[key]
            except KeyError:
                continue

            del kwargs[key]
            if value is not None:
                if marker is None:
                    general_metadata[key] = value
                else:
                    metadata.append(marker(value))
        if general_metadata:
            metadata.append(_fields.pydantic_general_metadata(**general_metadata))
        return metadata

    @property
    def deprecation_message(self) -> str | None:
        """The deprecation message to be emitted, or `None` if not set."""
        if self.deprecated is None:
            return None
        if isinstance(self.deprecated, bool):
            return 'deprecated' if self.deprecated else None
        return self.deprecated if isinstance(self.deprecated, str) else self.deprecated.message

    @property
    def default_factory_takes_validated_data(self) -> bool | None:
        """Whether the provided default factory callable has a validated data parameter.

        Returns `None` if no default factory is set.
        """
        if self.default_factory is not None:
            return _fields.takes_validated_data_argument(self.default_factory)

    @overload
    def get_default(
        self, *, call_default_factory: Literal[True], validated_data: dict[str, Any] | None = None
    ) -> Any: ...

    @overload
    def get_default(self, *, call_default_factory: Literal[False] = ...) -> Any: ...

    def get_default(self, *, call_default_factory: bool = False, validated_data: dict[str, Any] | None = None) -> Any:
        """Get the default value.

        We expose an option for whether to call the default_factory (if present), as calling it may
        result in side effects that we want to avoid. However, there are times when it really should
        be called (namely, when instantiating a model via `model_construct`).

        Args:
            call_default_factory: Whether to call the default factory or not.
            validated_data: The already validated data to be passed to the default factory.

        Returns:
            The default value, calling the default factory if requested or `PydanticUndefined` if not set.
        """
        return _fields.resolve_default_value(
            default=self.default,
            default_factory=self.default_factory,
            validated_data=validated_data,
            call_default_factory=call_default_factory,
        )

    def is_required(self) -> bool:
        """Check if the field is required (i.e., does not have a default value or factory).

        Returns:
            `True` if the field is required, `False` otherwise.
        """
        return self.default is PydanticUndefined and self.default_factory is None

    def rebuild_annotation(self) -> Any:
        """Attempts to rebuild the original annotation for use in function signatures.

        If metadata is present, it adds it to the original annotation using
        `Annotated`. Otherwise, it returns the original annotation as-is.

        Note that because the metadata has been flattened, the original annotation
        may not be reconstructed exactly as originally provided, e.g. if the original
        type had unrecognized annotations, or was annotated with a call to `pydantic.Field`.

        Returns:
            The rebuilt annotation.
        """
        if not self.metadata:
            return self.annotation
        else:
            # Annotated arguments must be a tuple
            return Annotated[(self.annotation, *self.metadata)]  # type: ignore

    def apply_typevars_map(
        self,
        typevars_map: Mapping[TypeVar, Any] | None,
        globalns: GlobalsNamespace | None = None,
        localns: MappingNamespace | None = None,
    ) -> None:
        """Apply a `typevars_map` to the annotation.

        This method is used when analyzing parametrized generic types to replace typevars with their concrete types.

        This method applies the `typevars_map` to the annotation in place.

        Args:
            typevars_map: A dictionary mapping type variables to their concrete types.
            globalns: The globals namespace to use during type annotation evaluation.
            localns: The locals namespace to use during type annotation evaluation.

        See Also:
            pydantic._internal._generics.replace_types is used for replacing the typevars with
                their concrete types.
        """
        annotation = _generics.replace_types(self.annotation, typevars_map)
        annotation, evaluated = _typing_extra.try_eval_type(annotation, globalns, localns)
        self.annotation = annotation
        if not evaluated:
            self._complete = False
            self._original_annotation = self.annotation

    def asdict(self) -> _FieldInfoAsDict:
        """Return a dictionary representation of the `FieldInfo` instance.

        The returned value is a dictionary with three items:

        * `annotation`: The type annotation of the field.
        * `metadata`: The metadata list.
        * `attributes`: A mapping of the remaining `FieldInfo` attributes to their values (e.g. `alias`, `title`).
        """
        return {
            'annotation': self.annotation,
            'metadata': self.metadata,
            'attributes': {attr: getattr(self, attr) for attr in _Attrs},
        }

    def _copy(self) -> Self:
        """Return a copy of the `FieldInfo` instance."""
        # Note: we can't define a custom `__copy__()`, as `FieldInfo` is being subclassed
        # by some third-party libraries with extra attributes defined (and as `FieldInfo`
        # is slotted, we can't make a copy of the `__dict__`).
        if type(self) is FieldInfo:
            # Fast-path if the instance isn't a subclass (`copy.copy()` relies on pickling which is slower):
            copied = FieldInfo.__new__(FieldInfo)
            for attr_name in FieldInfo.__slots__:
                setattr(copied, attr_name, getattr(self, attr_name))
        else:
            copied = copy(self)

        for attr_name in ('metadata', '_attributes_set', '_qualifiers'):
            # Apply "deep-copy" behavior on collections attributes:
            setattr(copied, attr_name, getattr(copied, attr_name).copy())

        return copied  # pyright: ignore[reportReturnType]

    def __repr_args__(self) -> ReprArgs:
        yield 'annotation', _repr.PlainRepr(_repr.display_as_type(self.annotation))
        yield 'required', self.is_required()

        for s in self.__slots__:
            # TODO: properly make use of the protocol (https://rich.readthedocs.io/en/stable/pretty.html#rich-repr-protocol)
            # By yielding a three-tuple:
            if s in (
                'annotation',
                '_attributes_set',
                '_qualifiers',
                '_complete',
                '_original_assignment',
                '_original_annotation',
                '_final',
            ):
                continue
            elif s == 'metadata' and not self.metadata:
                continue
            elif s == 'repr' and self.repr is True:
                continue
            if s == 'frozen' and self.frozen is False:
                continue
            if s == 'validation_alias' and self.validation_alias == self.alias:
                continue
            if s == 'serialization_alias' and self.serialization_alias == self.alias:
                continue
            if s == 'default' and self.default is not PydanticUndefined:
                yield 'default', self.default
            elif s == 'default_factory' and self.default_factory is not None:
                yield 'default_factory', _repr.PlainRepr(_repr.display_as_type(self.default_factory))
            else:
                value = getattr(self, s)
                if value is not None and value is not PydanticUndefined:
                    yield s, value


class _EmptyKwargs(TypedDict):
    """This class exists solely to ensure that type checking warns about passing `**extra` in `Field`."""


_Attrs = {
    'default': ...,
    'default_factory': None,
    'alias': None,
    'alias_priority': None,
    'validation_alias': None,
    'serialization_alias': None,
    'title': None,
    'field_title_generator': None,
    'description': None,
    'examples': None,
    'exclude': None,
    'exclude_if': None,
    'discriminator': None,
    'deprecated': None,
    'json_schema_extra': None,
    'frozen': None,
    'validate_default': None,
    'repr': True,
    'init': None,
    'init_var': None,
    'kw_only': None,
}

_DefaultValues = {
    **_Attrs,
    'kw_only': None,
    'pattern': None,
    'strict': None,
    'gt': None,
    'ge': None,
    'lt': None,
    'le': None,
    'multiple_of': None,
    'allow_inf_nan': None,
    'max_digits': None,
    'decimal_places': None,
    'min_length': None,
    'max_length': None,
    'coerce_numbers_to_str': None,
}


_T = TypeVar('_T')


# NOTE: Actual return type is 'FieldInfo', but we want to help type checkers
# to understand the magic that happens at runtime with the following overloads:
@overload  # type hint the return value as `Any` to avoid type checking regressions when using `...`.
def Field(
    default: ellipsis,  # noqa: F821  # TODO: use `_typing_extra.EllipsisType` when we drop Py3.9
    *,
    alias: str | None = _Unset,
    alias_priority: int | None = _Unset,
    validation_alias: str | AliasPath | AliasChoices | None = _Unset,
    serialization_alias: str | None = _Unset,
    title: str | None = _Unset,
    field_title_generator: Callable[[str, FieldInfo], str] | None = _Unset,
    description: str | None = _Unset,
    examples: list[Any] | None = _Unset,
    exclude: bool | None = _Unset,
    exclude_if: Callable[[Any], bool] | None = _Unset,
    discriminator: str | types.Discriminator | None = _Unset,
    deprecated: Deprecated | str | bool | None = _Unset,
    json_schema_extra: JsonDict | Callable[[JsonDict], None] | None = _Unset,
    frozen: bool | None = _Unset,
    validate_default: bool | None = _Unset,
    repr: bool = _Unset,
    init: bool | None = _Unset,
    init_var: bool | None = _Unset,
    kw_only: bool | None = _Unset,
    pattern: str | re.Pattern[str] | None = _Unset,
    strict: bool | None = _Unset,
    coerce_numbers_to_str: bool | None = _Unset,
    gt: annotated_types.SupportsGt | None = _Unset,
    ge: annotated_types.SupportsGe | None = _Unset,
    lt: annotated_types.SupportsLt | None = _Unset,
    le: annotated_types.SupportsLe | None = _Unset,
    multiple_of: float | None = _Unset,
    allow_inf_nan: bool | None = _Unset,
    max_digits: int | None = _Unset,
    decimal_places: int | None = _Unset,
    min_length: int | None = _Unset,
    max_length: int | None = _Unset,
    union_mode: Literal['smart', 'left_to_right'] = _Unset,
    fail_fast: bool | None = _Unset,
    **extra: Unpack[_EmptyKwargs],
) -> Any: ...
@overload  # `default` argument set, validate_default=True (no type checking on the default value)
def Field(
    default: Any,
    *,
    alias: str | None = _Unset,
    alias_priority: int | None = _Unset,
    validation_alias: str | AliasPath | AliasChoices | None = _Unset,
    serialization_alias: str | None = _Unset,
    title: str | None = _Unset,
    field_title_generator: Callable[[str, FieldInfo], str] | None = _Unset,
    description: str | None = _Unset,
    examples: list[Any] | None = _Unset,
    exclude: bool | None = _Unset,
    exclude_if: Callable[[Any], bool] | None = _Unset,
    discriminator: str | types.Discriminator | None = _Unset,
    deprecated: Deprecated | str | bool | None = _Unset,
    json_schema_extra: JsonDict | Callable[[JsonDict], None] | None = _Unset,
    frozen: bool | None = _Unset,
    validate_default: Literal[True],
    repr: bool = _Unset,
    init: bool | None = _Unset,
    init_var: bool | None = _Unset,
    kw_only: bool | None = _Unset,
    pattern: str | re.Pattern[str] | None = _Unset,
    strict: bool | None = _Unset,
    coerce_numbers_to_str: bool | None = _Unset,
    gt: annotated_types.SupportsGt | None = _Unset,
    ge: annotated_types.SupportsGe | None = _Unset,
    lt: annotated_types.SupportsLt | None = _Unset,
    le: annotated_types.SupportsLe | None = _Unset,
    multiple_of: float | None = _Unset,
    allow_inf_nan: bool | None = _Unset,
    max_digits: int | None = _Unset,
    decimal_places: int | None = _Unset,
    min_length: int | None = _Unset,
    max_length: int | None = _Unset,
    union_mode: Literal['smart', 'left_to_right'] = _Unset,
    fail_fast: bool | None = _Unset,
    **extra: Unpack[_EmptyKwargs],
) -> Any: ...
@overload  # `default` argument set, validate_default=False or unset
def Field(
    default: _T,
    *,
    alias: str | None = _Unset,
    alias_priority: int | None = _Unset,
    validation_alias: str | AliasPath | AliasChoices | None = _Unset,
    serialization_alias: str | None = _Unset,
    title: str | None = _Unset,
    field_title_generator: Callable[[str, FieldInfo], str] | None = _Unset,
    description: str | None = _Unset,
    examples: list[Any] | None = _Unset,
    exclude: bool | None = _Unset,
    # NOTE: to get proper type checking on `exclude_if`'s argument, we could use `_T` instead of `Any`. However,
    # this requires (at least for pyright) adding an additional overload where `exclude_if` is required (otherwise
    # `a: int = Field(default_factory=str)` results in a false negative).
    exclude_if: Callable[[Any], bool] | None = _Unset,
    discriminator: str | types.Discriminator | None = _Unset,
    deprecated: Deprecated | str | bool | None = _Unset,
    json_schema_extra: JsonDict | Callable[[JsonDict], None] | None = _Unset,
    frozen: bool | None = _Unset,
    validate_default: Literal[False] = ...,
    repr: bool = _Unset,
    init: bool | None = _Unset,
    init_var: bool | None = _Unset,
    kw_only: bool | None = _Unset,
    pattern: str | re.Pattern[str] | None = _Unset,
    strict: bool | None = _Unset,
    coerce_numbers_to_str: bool | None = _Unset,
    gt: annotated_types.SupportsGt | None = _Unset,
    ge: annotated_types.SupportsGe | None = _Unset,
    lt: annotated_types.SupportsLt | None = _Unset,
    le: annotated_types.SupportsLe | None = _Unset,
    multiple_of: float | None = _Unset,
    allow_inf_nan: bool | None = _Unset,
    max_digits: int | None = _Unset,
    decimal_places: int | None = _Unset,
    min_length: int | None = _Unset,
    max_length: int | None = _Unset,
    union_mode: Literal['smart', 'left_to_right'] = _Unset,
    fail_fast: bool | None = _Unset,
    **extra: Unpack[_EmptyKwargs],
) -> _T: ...
@overload  # `default_factory` argument set, validate_default=True  (no type checking on the default value)
def Field(  # pyright: ignore[reportOverlappingOverload]
    *,
    default_factory: Callable[[], Any] | Callable[[dict[str, Any]], Any],
    alias: str | None = _Unset,
    alias_priority: int | None = _Unset,
    validation_alias: str | AliasPath | AliasChoices | None = _Unset,
    serialization_alias: str | None = _Unset,
    title: str | None = _Unset,
    field_title_generator: Callable[[str, FieldInfo], str] | None = _Unset,
    description: str | None = _Unset,
    examples: list[Any] | None = _Unset,
    exclude: bool | None = _Unset,
    exclude_if: Callable[[Any], bool] | None = _Unset,
    discriminator: str | types.Discriminator | None = _Unset,
    deprecated: Deprecated | str | bool | None = _Unset,
    json_schema_extra: JsonDict | Callable[[JsonDict], None] | None = _Unset,
    frozen: bool | None = _Unset,
    validate_default: Literal[True],
    repr: bool = _Unset,
    init: bool | None = _Unset,
    init_var: bool | None = _Unset,
    kw_only: bool | None = _Unset,
    pattern: str | re.Pattern[str] | None = _Unset,
    strict: bool | None = _Unset,
    coerce_numbers_to_str: bool | None = _Unset,
    gt: annotated_types.SupportsGt | None = _Unset,
    ge: annotated_types.SupportsGe | None = _Unset,
    lt: annotated_types.SupportsLt | None = _Unset,
    le: annotated_types.SupportsLe | None = _Unset,
    multiple_of: float | None = _Unset,
    allow_inf_nan: bool | None = _Unset,
    max_digits: int | None = _Unset,
    decimal_places: int | None = _Unset,
    min_length: int | None = _Unset,
    max_length: int | None = _Unset,
    union_mode: Literal['smart', 'left_to_right'] = _Unset,
    fail_fast: bool | None = _Unset,
    **extra: Unpack[_EmptyKwargs],
) -> Any: ...
@overload  # `default_factory` argument set, validate_default=False or unset
def Field(
    *,
    default_factory: Callable[[], _T] | Callable[[dict[str, Any]], _T],
    alias: str | None = _Unset,
    alias_priority: int | None = _Unset,
    validation_alias: str | AliasPath | AliasChoices | None = _Unset,
    serialization_alias: str | None = _Unset,
    title: str | None = _Unset,
    field_title_generator: Callable[[str, FieldInfo], str] | None = _Unset,
    description: str | None = _Unset,
    examples: list[Any] | None = _Unset,
    exclude: bool | None = _Unset,
    # NOTE: to get proper type checking on `exclude_if`'s argument, we could use `_T` instead of `Any`. However,
    # this requires (at least for pyright) adding an additional overload where `exclude_if` is required (otherwise
    # `a: int = Field(default_factory=str)` results in a false negative).
    exclude_if: Callable[[Any], bool] | None = _Unset,
    discriminator: str | types.Discriminator | None = _Unset,
    deprecated: Deprecated | str | bool | None = _Unset,
    json_schema_extra: JsonDict | Callable[[JsonDict], None] | None = _Unset,
    frozen: bool | None = _Unset,
    validate_default: Literal[False] | None = _Unset,
    repr: bool = _Unset,
    init: bool | None = _Unset,
    init_var: bool | None = _Unset,
    kw_only: bool | None = _Unset,
    pattern: str | re.Pattern[str] | None = _Unset,
    strict: bool | None = _Unset,
    coerce_numbers_to_str: bool | None = _Unset,
    gt: annotated_types.SupportsGt | None = _Unset,
    ge: annotated_types.SupportsGe | None = _Unset,
    lt: annotated_types.SupportsLt | None = _Unset,
    le: annotated_types.SupportsLe | None = _Unset,
    multiple_of: float | None = _Unset,
    allow_inf_nan: bool | None = _Unset,
    max_digits: int | None = _Unset,
    decimal_places: int | None = _Unset,
    min_length: int | None = _Unset,
    max_length: int | None = _Unset,
    union_mode: Literal['smart', 'left_to_right'] = _Unset,
    fail_fast: bool | None = _Unset,
    **extra: Unpack[_EmptyKwargs],
) -> _T: ...
@overload
def Field(  # No default set
    *,
    alias: str | None = _Unset,
    alias_priority: int | None = _Unset,
    validation_alias: str | AliasPath | AliasChoices | None = _Unset,
    serialization_alias: str | None = _Unset,
    title: str | None = _Unset,
    field_title_generator: Callable[[str, FieldInfo], str] | None = _Unset,
    description: str | None = _Unset,
    examples: list[Any] | None = _Unset,
    exclude: bool | None = _Unset,
    exclude_if: Callable[[Any], bool] | None = _Unset,
    discriminator: str | types.Discriminator | None = _Unset,
    deprecated: Deprecated | str | bool | None = _Unset,
    json_schema_extra: JsonDict | Callable[[JsonDict], None] | None = _Unset,
    frozen: bool | None = _Unset,
    validate_default: bool | None = _Unset,
    repr: bool = _Unset,
    init: bool | None = _Unset,
    init_var: bool | None = _Unset,
    kw_only: bool | None = _Unset,
    pattern: str | re.Pattern[str] | None = _Unset,
    strict: bool | None = _Unset,
    coerce_numbers_to_str: bool | None = _Unset,
    gt: annotated_types.SupportsGt | None = _Unset,
    ge: annotated_types.SupportsGe | None = _Unset,
    lt: annotated_types.SupportsLt | None = _Unset,
    le: annotated_types.SupportsLe | None = _Unset,
    multiple_of: float | None = _Unset,
    allow_inf_nan: bool | None = _Unset,
    max_digits: int | None = _Unset,
    decimal_places: int | None = _Unset,
    min_length: int | None = _Unset,
    max_length: int | None = _Unset,
    union_mode: Literal['smart', 'left_to_right'] = _Unset,
    fail_fast: bool | None = _Unset,
    **extra: Unpack[_EmptyKwargs],
) -> Any: ...
def Field(  # noqa: C901
    default: Any = PydanticUndefined,
    *,
    default_factory: Callable[[], Any] | Callable[[dict[str, Any]], Any] | None = _Unset,
    alias: str | None = _Unset,
    alias_priority: int | None = _Unset,
    validation_alias: str | AliasPath | AliasChoices | None = _Unset,
    serialization_alias: str | None = _Unset,
    title: str | None = _Unset,
    field_title_generator: Callable[[str, FieldInfo], str] | None = _Unset,
    description: str | None = _Unset,
    examples: list[Any] | None = _Unset,
    exclude: bool | None = _Unset,
    exclude_if: Callable[[Any], bool] | None = _Unset,
    discriminator: str | types.Discriminator | None = _Unset,
    deprecated: Deprecated | str | bool | None = _Unset,
    json_schema_extra: JsonDict | Callable[[JsonDict], None] | None = _Unset,
    frozen: bool | None = _Unset,
    validate_default: bool | None = _Unset,
    repr: bool = _Unset,
    init: bool | None = _Unset,
    init_var: bool | None = _Unset,
    kw_only: bool | None = _Unset,
    pattern: str | re.Pattern[str] | None = _Unset,
    strict: bool | None = _Unset,
    coerce_numbers_to_str: bool | None = _Unset,
    gt: annotated_types.SupportsGt | None = _Unset,
    ge: annotated_types.SupportsGe | None = _Unset,
    lt: annotated_types.SupportsLt | None = _Unset,
    le: annotated_types.SupportsLe | None = _Unset,
    multiple_of: float | None = _Unset,
    allow_inf_nan: bool | None = _Unset,
    max_digits: int | None = _Unset,
    decimal_places: int | None = _Unset,
    min_length: int | None = _Unset,
    max_length: int | None = _Unset,
    union_mode: Literal['smart', 'left_to_right'] = _Unset,
    fail_fast: bool | None = _Unset,
    **extra: Unpack[_EmptyKwargs],
) -> Any:
    """!!! abstract "Usage Documentation"
        [Fields](../concepts/fields.md)

    Create a field for objects that can be configured.

    Used to provide extra information about a field, either for the model schema or complex validation. Some arguments
    apply only to number fields (`int`, `float`, `Decimal`) and some apply only to `str`.

    Note:
        - Any `_Unset` objects will be replaced by the corresponding value defined in the `_DefaultValues` dictionary. If a key for the `_Unset` object is not found in the `_DefaultValues` dictionary, it will default to `None`

    Args:
        default: Default value if the field is not set.
        default_factory: A callable to generate the default value. The callable can either take 0 arguments
            (in which case it is called as is) or a single argument containing the already validated data.
        alias: The name to use for the attribute when validating or serializing by alias.
            This is often used for things like converting between snake and camel case.
        alias_priority: Priority of the alias. This affects whether an alias generator is used.
        validation_alias: Like `alias`, but only affects validation, not serialization.
        serialization_alias: Like `alias`, but only affects serialization, not validation.
        title: Human-readable title.
        field_title_generator: A callable that takes a field name and returns title for it.
        description: Human-readable description.
        examples: Example values for this field.
        exclude: Whether to exclude the field from the model serialization.
        exclude_if: A callable that determines whether to exclude a field during serialization based on its value.
        discriminator: Field name or Discriminator for discriminating the type in a tagged union.
        deprecated: A deprecation message, an instance of `warnings.deprecated` or the `typing_extensions.deprecated` backport,
            or a boolean. If `True`, a default deprecation message will be emitted when accessing the field.
        json_schema_extra: A dict or callable to provide extra JSON schema properties.
        frozen: Whether the field is frozen. If true, attempts to change the value on an instance will raise an error.
        validate_default: If `True`, apply validation to the default value every time you create an instance.
            Otherwise, for performance reasons, the default value of the field is trusted and not validated.
        repr: A boolean indicating whether to include the field in the `__repr__` output.
        init: Whether the field should be included in the constructor of the dataclass.
            (Only applies to dataclasses.)
        init_var: Whether the field should _only_ be included in the constructor of the dataclass.
            (Only applies to dataclasses.)
        kw_only: Whether the field should be a keyword-only argument in the constructor of the dataclass.
            (Only applies to dataclasses.)
        coerce_numbers_to_str: Whether to enable coercion of any `Number` type to `str` (not applicable in `strict` mode).
        strict: If `True`, strict validation is applied to the field.
            See [Strict Mode](../concepts/strict_mode.md) for details.
        gt: Greater than. If set, value must be greater than this. Only applicable to numbers.
        ge: Greater than or equal. If set, value must be greater than or equal to this. Only applicable to numbers.
        lt: Less than. If set, value must be less than this. Only applicable to numbers.
        le: Less than or equal. If set, value must be less than or equal to this. Only applicable to numbers.
        multiple_of: Value must be a multiple of this. Only applicable to numbers.
        min_length: Minimum length for iterables.
        max_length: Maximum length for iterables.
        pattern: Pattern for strings (a regular expression).
        allow_inf_nan: Allow `inf`, `-inf`, `nan`. Only applicable to float and [`Decimal`][decimal.Decimal] numbers.
        max_digits: Maximum number of allow digits for strings.
        decimal_places: Maximum number of decimal places allowed for numbers.
        union_mode: The strategy to apply when validating a union. Can be `smart` (the default), or `left_to_right`.
            See [Union Mode](../concepts/unions.md#union-modes) for details.
        fail_fast: If `True`, validation will stop on the first error. If `False`, all validation errors will be collected.
            This option can be applied only to iterable types (list, tuple, set, and frozenset).
        extra: (Deprecated) Extra fields that will be included in the JSON schema.

            !!! warning Deprecated
                The `extra` kwargs is deprecated. Use `json_schema_extra` instead.

    Returns:
        A new [`FieldInfo`][pydantic.fields.FieldInfo]. The return annotation is `Any` so `Field` can be used on
            type-annotated fields without causing a type error.
    """
    # Check deprecated and removed params from V1. This logic should eventually be removed.
    const = extra.pop('const', None)  # type: ignore
    if const is not None:
        raise PydanticUserError('`const` is removed, use `Literal` instead', code='removed-kwargs')

    min_items = extra.pop('min_items', None)  # type: ignore
    if min_items is not None:
        warn(
            '`min_items` is deprecated and will be removed, use `min_length` instead',
            PydanticDeprecatedSince20,
            stacklevel=2,
        )
        if min_length in (None, _Unset):
            min_length = min_items  # type: ignore

    max_items = extra.pop('max_items', None)  # type: ignore
    if max_items is not None:
        warn(
            '`max_items` is deprecated and will be removed, use `max_length` instead',
            PydanticDeprecatedSince20,
            stacklevel=2,
        )
        if max_length in (None, _Unset):
            max_length = max_items  # type: ignore

    unique_items = extra.pop('unique_items', None)  # type: ignore
    if unique_items is not None:
        raise PydanticUserError(
            (
                '`unique_items` is removed, use `Set` instead'
                '(this feature is discussed in https://github.com/pydantic/pydantic-core/issues/296)'
            ),
            code='removed-kwargs',
        )

    allow_mutation = extra.pop('allow_mutation', None)  # type: ignore
    if allow_mutation is not None:
        warn(
            '`allow_mutation` is deprecated and will be removed. use `frozen` instead',
            PydanticDeprecatedSince20,
            stacklevel=2,
        )
        if allow_mutation is False:
            frozen = True

    regex = extra.pop('regex', None)  # type: ignore
    if regex is not None:
        raise PydanticUserError('`regex` is removed. use `pattern` instead', code='removed-kwargs')

    if extra:
        warn(
            'Using extra keyword arguments on `Field` is deprecated and will be removed.'
            ' Use `json_schema_extra` instead.'
            f' (Extra keys: {", ".join(k.__repr__() for k in extra.keys())})',
            PydanticDeprecatedSince20,
            stacklevel=2,
        )
        if not json_schema_extra or json_schema_extra is _Unset:
            json_schema_extra = extra  # type: ignore

    if (
        validation_alias
        and validation_alias is not _Unset
        and not isinstance(validation_alias, (str, AliasChoices, AliasPath))
    ):
        raise TypeError('Invalid `validation_alias` type. it should be `str`, `AliasChoices`, or `AliasPath`')

    if serialization_alias in (_Unset, None) and isinstance(alias, str):
        serialization_alias = alias

    if validation_alias in (_Unset, None):
        validation_alias = alias

    include = extra.pop('include', None)  # type: ignore
    if include is not None:
        warn(
            '`include` is deprecated and does nothing. It will be removed, use `exclude` instead',
            PydanticDeprecatedSince20,
            stacklevel=2,
        )

    return FieldInfo.from_field(
        default,
        default_factory=default_factory,
        alias=alias,
        alias_priority=alias_priority,
        validation_alias=validation_alias,
        serialization_alias=serialization_alias,
        title=title,
        field_title_generator=field_title_generator,
        description=description,
        examples=examples,
        exclude=exclude,
        exclude_if=exclude_if,
        discriminator=discriminator,
        deprecated=deprecated,
        json_schema_extra=json_schema_extra,
        frozen=frozen,
        pattern=pattern,
        validate_default=validate_default,
        repr=repr,
        init=init,
        init_var=init_var,
        kw_only=kw_only,
        coerce_numbers_to_str=coerce_numbers_to_str,
        strict=strict,
        gt=gt,
        ge=ge,
        lt=lt,
        le=le,
        multiple_of=multiple_of,
        min_length=min_length,
        max_length=max_length,
        allow_inf_nan=allow_inf_nan,
        max_digits=max_digits,
        decimal_places=decimal_places,
        union_mode=union_mode,
        fail_fast=fail_fast,
    )


_FIELD_ARG_NAMES = set(inspect.signature(Field).parameters)
_FIELD_ARG_NAMES.remove('extra')  # do not include the varkwargs parameter


class ModelPrivateAttr(_repr.Representation):
    """A descriptor for private attributes in class models.

    !!! warning
        You generally shouldn't be creating `ModelPrivateAttr` instances directly, instead use
        `pydantic.fields.PrivateAttr`. (This is similar to `FieldInfo` vs. `Field`.)

    Attributes:
        default: The default value of the attribute if not provided.
        default_factory: A callable to generate the default value. The callable can either take 0 arguments
            (in which case it is called as is) or a single argument containing the validated data (the model's
            [`__dict__`][object.__dict__]) and the already initialized private attributes.
    """

    __slots__ = ('default', 'default_factory')

    def __init__(
        self,
        default: Any = PydanticUndefined,
        *,
        default_factory: Callable[[], Any] | Callable[[dict[str, Any]], Any] | None = None,
    ) -> None:
        if default is Ellipsis:
            self.default = PydanticUndefined
        else:
            self.default = default
        self.default_factory = default_factory

    if not TYPE_CHECKING:
        # We put `__getattr__` in a non-TYPE_CHECKING block because otherwise, mypy allows arbitrary attribute access

        def __getattr__(self, item: str) -> Any:
            """This function improves compatibility with custom descriptors by ensuring delegation happens
            as expected when the default value of a private attribute is a descriptor.
            """
            if item in {'__get__', '__set__', '__delete__'}:
                if hasattr(self.default, item):
                    return getattr(self.default, item)
            raise AttributeError(f'{type(self).__name__!r} object has no attribute {item!r}')

    def __set_name__(self, cls: type[Any], name: str) -> None:
        """Preserve `__set_name__` protocol defined in https://peps.python.org/pep-0487."""
        default = self.default
        if default is PydanticUndefined:
            return
        set_name = getattr(default, '__set_name__', None)
        if callable(set_name):
            set_name(cls, name)

    @property
    def default_factory_takes_validated_data(self) -> bool | None:
        """Whether the provided default factory callable has a validated data parameter.

        Returns `None` if no default factory is set.
        """
        if self.default_factory is not None:
            return _fields.takes_validated_data_argument(self.default_factory)

    @overload
    def get_default(
        self, *, call_default_factory: Literal[True], validated_data: dict[str, Any] | None = None
    ) -> Any: ...

    @overload
    def get_default(self, *, call_default_factory: Literal[False] = ...) -> Any: ...

    def get_default(self, *, call_default_factory: bool = False, validated_data: dict[str, Any] | None = None) -> Any:
        """Get the default value.

        We expose an option for whether to call the default_factory (if present), as calling it may
        result in side effects that we want to avoid. However, there are times when it really should
        be called (namely, when instantiating a model via `model_construct`).

        Args:
            call_default_factory: Whether to call the default factory or not.
            validated_data: The already validated data to be passed to the default factory.

        Returns:
            The default value, calling the default factory if requested or `None` if not set.
        """
        return _fields.resolve_default_value(
            default=self.default,
            default_factory=self.default_factory,
            validated_data=validated_data,
            call_default_factory=call_default_factory,
        )

    def __eq__(self, other: Any) -> bool:
        return isinstance(other, self.__class__) and (self.default, self.default_factory) == (
            other.default,
            other.default_factory,
        )


# NOTE: Actual return type is 'ModelPrivateAttr', but we want to help type checkers
# to understand the magic that happens at runtime.
@overload  # `default` argument set
def PrivateAttr(
    default: _T,
    *,
    init: Literal[False] = False,
) -> _T: ...
@overload  # `default_factory` argument set
def PrivateAttr(
    *,
    default_factory: Callable[[], _T] | Callable[[dict[str, Any]], _T],
    init: Literal[False] = False,
) -> _T: ...
@overload  # No default set
def PrivateAttr(
    *,
    init: Literal[False] = False,
) -> Any: ...
def PrivateAttr(
    default: Any = PydanticUndefined,
    *,
    default_factory: Callable[[], Any] | Callable[[dict[str, Any]], Any] | None = None,
    init: Literal[False] = False,
) -> Any:
    """!!! abstract "Usage Documentation"
        [Private Model Attributes](../concepts/models.md#private-model-attributes)

    Indicates that an attribute is intended for private use and not handled during normal validation/serialization.

    Private attributes are not validated by Pydantic, so it's up to you to ensure they are used in a type-safe manner.

    Private attributes are stored in `__private_attributes__` on the model.

    Args:
        default: The attribute's default value. Defaults to Undefined.
        default_factory: A callable to generate the default value. The callable can either take 0 arguments
            (in which case it is called as is) or a single argument containing the validated data (the model's
            [`__dict__`][object.__dict__]) and the already initialized private attributes.
            If both `default` and `default_factory` are set, an error will be raised.
        init: Whether the attribute should be included in the constructor of the dataclass. Always `False`.

    Returns:
        An instance of [`ModelPrivateAttr`][pydantic.fields.ModelPrivateAttr] class.

    Raises:
        ValueError: If both `default` and `default_factory` are set.
    """
    if default is not PydanticUndefined and default_factory is not None:
        raise TypeError('cannot specify both default and default_factory')

    return ModelPrivateAttr(
        default,
        default_factory=default_factory,
    )


@dataclasses.dataclass(**_internal_dataclass.slots_true)
class ComputedFieldInfo:
    """A container for data from `@computed_field` so that we can access it while building the pydantic-core schema.

    Attributes:
        decorator_repr: A class variable representing the decorator string, '@computed_field'.
        wrapped_property: The wrapped computed field property.
        return_type: The type of the computed field property's return value.
        alias: The alias of the property to be used during serialization.
        alias_priority: The priority of the alias. This affects whether an alias generator is used.
        title: Title of the computed field to include in the serialization JSON schema.
        field_title_generator: A callable that takes a field name and returns title for it.
        description: Description of the computed field to include in the serialization JSON schema.
        deprecated: A deprecation message, an instance of `warnings.deprecated` or the `typing_extensions.deprecated` backport,
            or a boolean. If `True`, a default deprecation message will be emitted when accessing the field.
        examples: Example values of the computed field to include in the serialization JSON schema.
        json_schema_extra: A dict or callable to provide extra JSON schema properties.
        repr: A boolean indicating whether to include the field in the __repr__ output.
    """

    decorator_repr: ClassVar[str] = '@computed_field'
    wrapped_property: property
    return_type: Any
    alias: str | None
    alias_priority: int | None
    exclude_if: Callable[[Any], bool] | None
    title: str | None
    field_title_generator: Callable[[str, ComputedFieldInfo], str] | None
    description: str | None
    deprecated: Deprecated | str | bool | None
    examples: list[Any] | None
    json_schema_extra: JsonDict | Callable[[JsonDict], None] | None
    repr: bool
    # NOTE: if you add a new field, add it to the `__copy__()` implementation.

    def __copy__(self) -> Self:
        return type(self)(
            wrapped_property=self.wrapped_property,
            return_type=self.return_type,
            alias=self.alias,
            alias_priority=self.alias_priority,
            exclude_if=self.exclude_if,
            title=self.title,
            field_title_generator=self.field_title_generator,
            description=self.description,
            deprecated=self.deprecated,
            examples=self.examples.copy() if isinstance(self.examples, list) else self.examples,
            json_schema_extra=self.json_schema_extra.copy()
            if isinstance(self.json_schema_extra, dict)
            else self.json_schema_extra,
            repr=self.repr,
        )

    @property
    def deprecation_message(self) -> str | None:
        """The deprecation message to be emitted, or `None` if not set."""
        if self.deprecated is None:
            return None
        if isinstance(self.deprecated, bool):
            return 'deprecated' if self.deprecated else None
        return self.deprecated if isinstance(self.deprecated, str) else self.deprecated.message

    def _update_from_config(self, config_wrapper: ConfigWrapper, name: str) -> None:
        """Update the instance from the configuration set on the class this computed field belongs to."""
        title_generator = self.field_title_generator or config_wrapper.field_title_generator
        if title_generator is not None and self.title is None:
            self.title = title_generator(name, self)
        if config_wrapper.alias_generator is not None:
            self._apply_alias_generator(config_wrapper.alias_generator, name)

    def _apply_alias_generator(self, alias_generator: Callable[[str], str] | AliasGenerator, name: str) -> None:
        """Apply an alias generator to aliases if appropriate.

        Args:
            alias_generator: A callable that takes a string and returns a string, or an `AliasGenerator` instance.
            name: The name of the computed field from which to generate the alias.
        """
        # Apply an alias_generator if
        # 1. An alias is not specified
        # 2. An alias is specified, but the priority is <= 1

        if self.alias_priority is None or self.alias_priority <= 1 or self.alias is None:
            alias, _, serialization_alias = None, None, None

            if isinstance(alias_generator, AliasGenerator):
                alias, _, serialization_alias = alias_generator.generate_aliases(name)
            elif callable(alias_generator):
                alias = alias_generator(name)

            # if priority is not set, we set to 1
            # which supports the case where the alias_generator from a child class is used
            # to generate an alias for a field in a parent class
            if self.alias_priority is None or self.alias_priority <= 1:
                self.alias_priority = 1

            # if the priority is 1, then we set the aliases to the generated alias
            # note that we use the serialization_alias with priority over alias, as computed_field
            # aliases are used for serialization only (not validation)
            if self.alias_priority == 1:
                self.alias = _utils.get_first_not_none(serialization_alias, alias)


def _wrapped_property_is_private(property_: cached_property | property) -> bool:  # type: ignore
    """Returns true if provided property is private, False otherwise."""
    wrapped_name: str = ''

    if isinstance(property_, property):
        wrapped_name = getattr(property_.fget, '__name__', '')
    elif isinstance(property_, cached_property):  # type: ignore
        wrapped_name = getattr(property_.func, '__name__', '')  # type: ignore

    return wrapped_name.startswith('_') and not wrapped_name.startswith('__')


# this should really be `property[T], cached_property[T]` but property is not generic unlike cached_property
# See https://github.com/python/typing/issues/985 and linked issues
PropertyT = TypeVar('PropertyT')


@overload
def computed_field(func: PropertyT, /) -> PropertyT: ...


@overload
def computed_field(
    *,
    alias: str | None = None,
    alias_priority: int | None = None,
    exclude_if: Callable[[Any], bool] | None = None,
    title: str | None = None,
    field_title_generator: Callable[[str, ComputedFieldInfo], str] | None = None,
    description: str | None = None,
    deprecated: Deprecated | str | bool | None = None,
    examples: list[Any] | None = None,
    json_schema_extra: JsonDict | Callable[[JsonDict], None] | None = None,
    repr: bool = True,
    return_type: Any = PydanticUndefined,
) -> Callable[[PropertyT], PropertyT]: ...


def computed_field(
    func: PropertyT | None = None,
    /,
    *,
    alias: str | None = None,
    alias_priority: int | None = None,
    exclude_if: Callable[[Any], bool] | None = None,
    title: str | None = None,
    field_title_generator: Callable[[str, ComputedFieldInfo], str] | None = None,
    description: str | None = None,
    deprecated: Deprecated | str | bool | None = None,
    examples: list[Any] | None = None,
    json_schema_extra: JsonDict | Callable[[JsonDict], None] | None = None,
    repr: bool | None = None,
    return_type: Any = PydanticUndefined,
) -> PropertyT | Callable[[PropertyT], PropertyT]:
    """!!! abstract "Usage Documentation"
        [The `computed_field` decorator](../concepts/fields.md#the-computed_field-decorator)

    Decorator to include `property` and `cached_property` when serializing models or dataclasses.

    This is useful for fields that are computed from other fields, or for fields that are expensive to compute and should be cached.

    ```python
    from pydantic import BaseModel, computed_field

    class Rectangle(BaseModel):
        width: int
        length: int

        @computed_field
        @property
        def area(self) -> int:
            return self.width * self.length

    print(Rectangle(width=3, length=2).model_dump())
    #> {'width': 3, 'length': 2, 'area': 6}
    ```

    If applied to functions not yet decorated with `@property` or `@cached_property`, the function is
    automatically wrapped with `property`. Although this is more concise, you will lose IntelliSense in your IDE,
    and confuse static type checkers, thus explicit use of `@property` is recommended.

    !!! warning "Mypy Warning"
        Even with the `@property` or `@cached_property` applied to your function before `@computed_field`,
        mypy may throw a `Decorated property not supported` error.
        See [mypy issue #1362](https://github.com/python/mypy/issues/1362), for more information.
        To avoid this error message, add `# type: ignore[prop-decorator]` to the `@computed_field` line.

        [pyright](https://github.com/microsoft/pyright) supports `@computed_field` without error.

    ```python
    import random

    from pydantic import BaseModel, computed_field

    class Square(BaseModel):
        width: float

        @computed_field
        def area(self) -> float:  # converted to a `property` by `computed_field`
            return round(self.width**2, 2)

        @area.setter
        def area(self, new_area: float) -> None:
            self.width = new_area**0.5

        @computed_field(alias='the magic number', repr=False)
        def random_number(self) -> int:
            return random.randint(0, 1_000)

    square = Square(width=1.3)

    # `random_number` does not appear in representation
    print(repr(square))
    #> Square(width=1.3, area=1.69)

    print(square.random_number)
    #> 3

    square.area = 4

    print(square.model_dump_json(by_alias=True))
    #> {"width":2.0,"area":4.0,"the magic number":3}
    ```

    !!! warning "Overriding with `computed_field`"
        You can't override a field from a parent class with a `computed_field` in the child class.
        `mypy` complains about this behavior if allowed, and `dataclasses` doesn't allow this pattern either.
        See the example below:

    ```python
    from pydantic import BaseModel, computed_field

    class Parent(BaseModel):
        a: str

    try:

        class Child(Parent):
            @computed_field
            @property
            def a(self) -> str:
                return 'new a'

    except TypeError as e:
        print(e)
        '''
        Field 'a' of class 'Child' overrides symbol of same name in a parent class. This override with a computed_field is incompatible.
        '''
    ```

    Private properties decorated with `@computed_field` have `repr=False` by default.

    ```python
    from functools import cached_property

    from pydantic import BaseModel, computed_field

    class Model(BaseModel):
        foo: int

        @computed_field
        @cached_property
        def _private_cached_property(self) -> int:
            return -self.foo

        @computed_field
        @property
        def _private_property(self) -> int:
            return -self.foo

    m = Model(foo=1)
    print(repr(m))
    #> Model(foo=1)
    ```

    Args:
        func: the function to wrap.
        alias: alias to use when serializing this computed field, only used when `by_alias=True`
        alias_priority: priority of the alias. This affects whether an alias generator is used
        exclude_if: A callable that determines whether to exclude this computed field during serialization based on its value.
        title: Title to use when including this computed field in JSON Schema
        field_title_generator: A callable that takes a field name and returns title for it.
        description: Description to use when including this computed field in JSON Schema, defaults to the function's
            docstring
        deprecated: A deprecation message (or an instance of `warnings.deprecated` or the `typing_extensions.deprecated` backport).
            to be emitted when accessing the field. Or a boolean. This will automatically be set if the property is decorated with the
            `deprecated` decorator.
        examples: Example values to use when including this computed field in JSON Schema
        json_schema_extra: A dict or callable to provide extra JSON schema properties.
        repr: whether to include this computed field in model repr.
            Default is `False` for private properties and `True` for public properties.
        return_type: optional return for serialization logic to expect when serializing to JSON, if included
            this must be correct, otherwise a `TypeError` is raised.
            If you don't include a return type Any is used, which does runtime introspection to handle arbitrary
            objects.

    Returns:
        A proxy wrapper for the property.
    """

    def dec(f: Any) -> Any:
        nonlocal description, deprecated, return_type, alias_priority
        unwrapped = _decorators.unwrap_wrapped_function(f)

        if description is None and unwrapped.__doc__:
            description = inspect.cleandoc(unwrapped.__doc__)

        if deprecated is None and hasattr(unwrapped, '__deprecated__'):
            deprecated = unwrapped.__deprecated__

        # if the function isn't already decorated with `@property` (or another descriptor), then we wrap it now
        f = _decorators.ensure_property(f)
        alias_priority = (alias_priority or 2) if alias is not None else None

        if repr is None:
            repr_: bool = not _wrapped_property_is_private(property_=f)
        else:
            repr_ = repr

        dec_info = ComputedFieldInfo(
            f,
            return_type,
            alias,
            alias_priority,
            exclude_if,
            title,
            field_title_generator,
            description,
            deprecated,
            examples,
            json_schema_extra,
            repr_,
        )
        return _decorators.PydanticDescriptorProxy(f, dec_info)

    if func is None:
        return dec
    else:
        return dec(func)
