"""Private logic for creating models."""

from __future__ import annotations as _annotations

import operator
import sys
import typing
import warnings
import weakref
from abc import ABCMeta
from functools import cache, partial, wraps
from types import FunctionType
from typing import TYPE_CHECKING, Any, Callable, Generic, Literal, NoReturn, TypeVar, cast

from pydantic_core import PydanticUndefined, SchemaSerializer
from typing_extensions import TypeAliasType, dataclass_transform, deprecated, get_args, get_origin
from typing_inspection import typing_objects

from ..errors import PydanticUndefinedAnnotation, PydanticUserError
from ..plugin._schema_validator import create_schema_validator
from ..warnings import GenericBeforeBaseModelWarning, PydanticDeprecatedSince20
from ._config import ConfigWrapper
from ._decorators import DecoratorInfos, PydanticDescriptorProxy, get_attribute_from_bases, unwrap_wrapped_function
from ._fields import collect_model_fields, is_valid_field_name, is_valid_privateattr_name, rebuild_model_fields
from ._generate_schema import GenerateSchema, InvalidSchemaError
from ._generics import PydanticGenericMetadata, get_model_typevars_map
from ._import_utils import import_cached_base_model, import_cached_field_info
from ._mock_val_ser import set_model_mocks
from ._namespace_utils import NsResolver
from ._signature import generate_pydantic_signature
from ._typing_extra import (
    _make_forward_ref,
    eval_type_backport,
    is_classvar_annotation,
    parent_frame_namespace,
)
from ._utils import LazyClassAttribute, SafeGetItemProxy

if TYPE_CHECKING:
    from ..fields import Field as PydanticModelField
    from ..fields import FieldInfo, ModelPrivateAttr
    from ..fields import PrivateAttr as PydanticModelPrivateAttr
    from ..main import BaseModel
    from ._fields import PydanticExtraInfo
else:
    PydanticModelField = object()
    PydanticModelPrivateAttr = object()

object_setattr = object.__setattr__


class _ModelNamespaceDict(dict):
    """A dictionary subclass that intercepts attribute setting on model classes and
    warns about overriding of decorators.
    """

    def __setitem__(self, k: str, v: object) -> None:
        existing: Any = self.get(k, None)
        if existing and v is not existing and isinstance(existing, PydanticDescriptorProxy):
            warnings.warn(
                f'`{k}` overrides an existing Pydantic `{existing.decorator_info.decorator_repr}` decorator',
                stacklevel=2,
            )

        return super().__setitem__(k, v)


def NoInitField(
    *,
    init: Literal[False] = False,
) -> Any:
    """Only for typing purposes. Used as default value of `__pydantic_fields_set__`,
    `__pydantic_extra__`, `__pydantic_private__`, so they could be ignored when
    synthesizing the `__init__` signature.
    """


# For ModelMetaclass.register():
_T = TypeVar('_T')


@dataclass_transform(kw_only_default=True, field_specifiers=(PydanticModelField, PydanticModelPrivateAttr, NoInitField))
class ModelMetaclass(ABCMeta):
    def __new__(
        mcs,
        cls_name: str,
        bases: tuple[type[Any], ...],
        namespace: dict[str, Any],
        __pydantic_generic_metadata__: PydanticGenericMetadata | None = None,
        __pydantic_reset_parent_namespace__: bool = True,
        _create_model_module: str | None = None,
        **kwargs: Any,
    ) -> type:
        """Metaclass for creating Pydantic models.

        Args:
            cls_name: The name of the class to be created.
            bases: The base classes of the class to be created.
            namespace: The attribute dictionary of the class to be created.
            __pydantic_generic_metadata__: Metadata for generic models.
            __pydantic_reset_parent_namespace__: Reset parent namespace.
            _create_model_module: The module of the class to be created, if created by `create_model`.
            **kwargs: Catch-all for any other keyword arguments.

        Returns:
            The new class created by the metaclass.
        """
        # Note `ModelMetaclass` refers to `BaseModel`, but is also used to *create* `BaseModel`, so we rely on the fact
        # that `BaseModel` itself won't have any bases, but any subclass of it will, to determine whether the `__new__`
        # call we're in the middle of is for the `BaseModel` class.
        if bases:
            raw_annotations: dict[str, Any]
            if sys.version_info >= (3, 14):
                if (
                    '__annotations__' in namespace
                ):  # `from __future__ import annotations` was used in the model's module
                    raw_annotations = namespace['__annotations__']
                else:
                    # See https://docs.python.org/3.14/library/annotationlib.html#using-annotations-in-a-metaclass:
                    from annotationlib import Format, call_annotate_function, get_annotate_from_class_namespace

                    if annotate := get_annotate_from_class_namespace(namespace):
                        raw_annotations = call_annotate_function(annotate, format=Format.FORWARDREF)
                    else:
                        raw_annotations = {}
            else:
                raw_annotations = namespace.get('__annotations__', {})

            base_field_names, class_vars, base_private_attributes = mcs._collect_bases_data(bases)

            config_wrapper = ConfigWrapper.for_model(bases, namespace, raw_annotations, kwargs)
            namespace['model_config'] = config_wrapper.config_dict
            private_attributes = inspect_namespace(
                namespace, raw_annotations, config_wrapper.ignored_types, class_vars, base_field_names
            )
            if private_attributes or base_private_attributes:
                original_model_post_init = get_model_post_init(namespace, bases)
                if original_model_post_init is not None:
                    # if there are private attributes and a model_post_init function, we handle both

                    @wraps(original_model_post_init)
                    def wrapped_model_post_init(self: BaseModel, context: Any, /) -> None:
                        """We need to both initialize private attributes and call the user-defined model_post_init
                        method.
                        """
                        init_private_attributes(self, context)
                        original_model_post_init(self, context)

                    namespace['model_post_init'] = wrapped_model_post_init
                else:
                    namespace['model_post_init'] = init_private_attributes

            namespace['__class_vars__'] = class_vars
            namespace['__private_attributes__'] = {**base_private_attributes, **private_attributes}

            cls = cast('type[BaseModel]', super().__new__(mcs, cls_name, bases, namespace, **kwargs))
            BaseModel_ = import_cached_base_model()

            mro = cls.__mro__
            if Generic in mro and mro.index(Generic) < mro.index(BaseModel_):
                warnings.warn(
                    GenericBeforeBaseModelWarning(
                        'Classes should inherit from `BaseModel` before generic classes (e.g. `typing.Generic[T]`) '
                        'for pydantic generics to work properly.'
                    ),
                    stacklevel=2,
                )

            cls.__pydantic_custom_init__ = not getattr(cls.__init__, '__pydantic_base_init__', False)
            cls.__pydantic_post_init__ = (
                None if cls.model_post_init is BaseModel_.model_post_init else 'model_post_init'
            )

            cls.__pydantic_setattr_handlers__ = {}

            cls.__pydantic_decorators__ = DecoratorInfos.build(cls, replace_wrapped_methods=True)
            cls.__pydantic_decorators__.update_from_config(config_wrapper)

            # Use the getattr below to grab the __parameters__ from the `typing.Generic` parent class
            if __pydantic_generic_metadata__:
                cls.__pydantic_generic_metadata__ = __pydantic_generic_metadata__
            else:
                parent_parameters = getattr(cls, '__pydantic_generic_metadata__', {}).get('parameters', ())
                parameters = getattr(cls, '__parameters__', None) or parent_parameters
                if parameters and parent_parameters and not all(x in parameters for x in parent_parameters):
                    from ..root_model import RootModelRootType

                    missing_parameters = tuple(x for x in parameters if x not in parent_parameters)
                    if RootModelRootType in parent_parameters and RootModelRootType not in parameters:
                        # This is a special case where the user has subclassed RootModel, but has not parameterized
                        # RootModel with the generic type identifiers being used. Ex:
                        # class MyModel(RootModel, Generic[T]):
                        #    root: T
                        # Should instead just be:
                        # class MyModel(RootModel[T]):
                        #   root: T
                        parameters_str = ', '.join([x.__name__ for x in missing_parameters])
                        error_message = (
                            f'{cls.__name__} is a subclass of `RootModel`, but does not include the generic type identifier(s) '
                            f'{parameters_str} in its parameters. '
                            f'You should parametrize RootModel directly, e.g., `class {cls.__name__}(RootModel[{parameters_str}]): ...`.'
                        )
                    else:
                        combined_parameters = parent_parameters + missing_parameters
                        parameters_str = ', '.join([str(x) for x in combined_parameters])
                        generic_type_label = f'typing.Generic[{parameters_str}]'
                        error_message = (
                            f'All parameters must be present on typing.Generic;'
                            f' you should inherit from {generic_type_label}.'
                        )
                        if Generic not in bases:  # pragma: no cover
                            # We raise an error here not because it is desirable, but because some cases are mishandled.
                            # It would be nice to remove this error and still have things behave as expected, it's just
                            # challenging because we are using a custom `__class_getitem__` to parametrize generic models,
                            # and not returning a typing._GenericAlias from it.
                            bases_str = ', '.join([x.__name__ for x in bases] + [generic_type_label])
                            error_message += (
                                f' Note: `typing.Generic` must go last: `class {cls.__name__}({bases_str}): ...`)'
                            )
                    raise TypeError(error_message)

                cls.__pydantic_generic_metadata__ = {
                    'origin': None,
                    'args': (),
                    'parameters': parameters,
                }

            cls.__pydantic_complete__ = False  # Ensure this specific class gets completed

            # preserve `__set_name__` protocol defined in https://peps.python.org/pep-0487
            # for attributes not in `new_namespace` (e.g. private attributes)
            for name, obj in private_attributes.items():
                obj.__set_name__(cls, name)

            if __pydantic_reset_parent_namespace__:
                cls.__pydantic_parent_namespace__ = build_lenient_weakvaluedict(parent_frame_namespace())
            parent_namespace: dict[str, Any] | None = getattr(cls, '__pydantic_parent_namespace__', None)
            if isinstance(parent_namespace, dict):
                parent_namespace = unpack_lenient_weakvaluedict(parent_namespace)

            ns_resolver = NsResolver(parent_namespace=parent_namespace)

            set_model_fields(cls, config_wrapper=config_wrapper, ns_resolver=ns_resolver)

            # This is also set in `complete_model_class()`, after schema gen because they are recreated.
            # We set them here as well for backwards compatibility:
            cls.__pydantic_computed_fields__ = {
                k: v.info for k, v in cls.__pydantic_decorators__.computed_fields.items()
            }

            if config_wrapper.defer_build:
                set_model_mocks(cls)
            else:
                # Any operation that requires accessing the field infos instances should be put inside
                # `complete_model_class()`:
                complete_model_class(
                    cls,
                    config_wrapper,
                    ns_resolver,
                    raise_errors=False,
                    create_model_module=_create_model_module,
                )

            if config_wrapper.frozen and '__hash__' not in namespace:
                set_default_hash_func(cls, bases)

            # using super(cls, cls) on the next line ensures we only call the parent class's __pydantic_init_subclass__
            # I believe the `type: ignore` is only necessary because mypy doesn't realize that this code branch is
            # only hit for _proper_ subclasses of BaseModel
            super(cls, cls).__pydantic_init_subclass__(**kwargs)  # type: ignore[misc]
            return cls
        else:
            # These are instance variables, but have been assigned to `NoInitField` to trick the type checker.
            for instance_slot in '__pydantic_fields_set__', '__pydantic_extra__', '__pydantic_private__':
                namespace.pop(
                    instance_slot,
                    None,  # In case the metaclass is used with a class other than `BaseModel`.
                )
            namespace.get('__annotations__', {}).clear()
            return super().__new__(mcs, cls_name, bases, namespace, **kwargs)

    if not TYPE_CHECKING:  # pragma: no branch
        # We put `__getattr__` in a non-TYPE_CHECKING block because otherwise, mypy allows arbitrary attribute access

        def __getattr__(self, item: str) -> Any:
            """This is necessary to keep attribute access working for class attribute access."""
            private_attributes = self.__dict__.get('__private_attributes__')
            if private_attributes and item in private_attributes:
                return private_attributes[item]
            raise AttributeError(item)

    @classmethod
    def __prepare__(cls, *args: Any, **kwargs: Any) -> dict[str, object]:
        return _ModelNamespaceDict()

    # Due to performance and memory issues, in the ABCMeta.__subclasscheck__ implementation, we don't support
    # registered virtual subclasses. See https://github.com/python/cpython/issues/92810#issuecomment-2762454345.
    # This may change once CPython is fixed (possibly in 3.15), in which case we should conditionally
    # define `register()`.
    def register(self, subclass: type[_T]) -> type[_T]:
        warnings.warn(
            f"For performance reasons, virtual subclasses registered using '{self.__qualname__}.register()' "
            "are not supported in 'isinstance()' and 'issubclass()' checks.",
            stacklevel=2,
        )
        return super().register(subclass)

    __instancecheck__ = type.__instancecheck__  # pyright: ignore[reportAssignmentType]
    __subclasscheck__ = type.__subclasscheck__  # pyright: ignore[reportAssignmentType]

    @staticmethod
    def _collect_bases_data(bases: tuple[type[Any], ...]) -> tuple[set[str], set[str], dict[str, ModelPrivateAttr]]:
        BaseModel = import_cached_base_model()

        field_names: set[str] = set()
        class_vars: set[str] = set()
        private_attributes: dict[str, ModelPrivateAttr] = {}
        for base in bases:
            if issubclass(base, BaseModel) and base is not BaseModel:
                # model_fields might not be defined yet in the case of generics, so we use getattr here:
                field_names.update(getattr(base, '__pydantic_fields__', {}).keys())
                class_vars.update(base.__class_vars__)
                private_attributes.update(base.__private_attributes__)
        return field_names, class_vars, private_attributes

    @property
    @deprecated(
        'The `__fields__` attribute is deprecated, use the `model_fields` class property instead.', category=None
    )
    def __fields__(self) -> dict[str, FieldInfo]:
        warnings.warn(
            'The `__fields__` attribute is deprecated, use the `model_fields` class property instead.',
            PydanticDeprecatedSince20,
            stacklevel=2,
        )
        return getattr(self, '__pydantic_fields__', {})

    @property
    def __pydantic_fields_complete__(self) -> bool:
        """Whether the fields were successfully collected (i.e. type hints were successfully resolved).

        This is a private attribute, not meant to be used outside Pydantic.
        """
        if '__pydantic_fields__' not in self.__dict__:
            return False

        field_infos = cast('dict[str, FieldInfo]', self.__pydantic_fields__)  # pyright: ignore[reportAttributeAccessIssue]

        pydantic_extra_info = cast('PydanticExtraInfo | None', self.__pydantic_extra_info__)  # pyright: ignore[reportAttributeAccessIssue]
        if pydantic_extra_info is not None:
            extra_complete = pydantic_extra_info.complete
        else:
            extra_complete = True

        return all(field_info._complete for field_info in field_infos.values()) and extra_complete

    def __dir__(self) -> list[str]:
        attributes = list(super().__dir__())
        if '__fields__' in attributes:
            attributes.remove('__fields__')
        return attributes


def init_private_attributes(self: BaseModel, context: Any, /) -> None:
    """This function is meant to behave like a BaseModel method to initialize private attributes.

    It takes context as an argument since that's what pydantic-core passes when calling it.

    Args:
        self: The BaseModel instance.
        context: The context.
    """
    if getattr(self, '__pydantic_private__', None) is None:
        pydantic_private = {}
        for name, private_attr in self.__private_attributes__.items():
            # Avoid needlessly creating a new dict for the validated data:
            if private_attr.default_factory_takes_validated_data:
                default = private_attr.get_default(
                    call_default_factory=True, validated_data={**self.__dict__, **pydantic_private}
                )
            else:
                default = private_attr.get_default(call_default_factory=True)
            if default is not PydanticUndefined:
                pydantic_private[name] = default
        object_setattr(self, '__pydantic_private__', pydantic_private)


def get_model_post_init(namespace: dict[str, Any], bases: tuple[type[Any], ...]) -> Callable[..., Any] | None:
    """Get the `model_post_init` method from the namespace or the class bases, or `None` if not defined."""
    if 'model_post_init' in namespace:
        return namespace['model_post_init']

    BaseModel = import_cached_base_model()

    model_post_init = get_attribute_from_bases(bases, 'model_post_init')
    if model_post_init is not BaseModel.model_post_init:
        return model_post_init


def inspect_namespace(  # noqa C901
    namespace: dict[str, Any],
    raw_annotations: dict[str, Any],
    ignored_types: tuple[type[Any], ...],
    base_class_vars: set[str],
    base_class_fields: set[str],
) -> dict[str, ModelPrivateAttr]:
    """Iterate over the namespace and:
    * gather private attributes
    * check for items which look like fields but are not (e.g. have no annotation) and warn.

    Args:
        namespace: The attribute dictionary of the class to be created.
        raw_annotations: The (non-evaluated) annotations of the model.
        ignored_types: A tuple of ignore types.
        base_class_vars: A set of base class class variables.
        base_class_fields: A set of base class fields.

    Returns:
        A dict containing private attributes info.

    Raises:
        TypeError: If there is a `__root__` field in model.
        NameError: If private attribute name is invalid.
        PydanticUserError:
            - If a field does not have a type annotation.
            - If a field on base class was overridden by a non-annotated attribute.
    """
    from ..fields import ModelPrivateAttr, PrivateAttr

    FieldInfo = import_cached_field_info()

    all_ignored_types = ignored_types + default_ignored_types()

    private_attributes: dict[str, ModelPrivateAttr] = {}

    if '__root__' in raw_annotations or '__root__' in namespace:
        raise TypeError("To define root models, use `pydantic.RootModel` rather than a field called '__root__'")

    ignored_names: set[str] = set()
    for var_name, value in list(namespace.items()):
        if var_name == 'model_config' or var_name == '__pydantic_extra__':
            continue
        elif (
            isinstance(value, type)
            and value.__module__ == namespace['__module__']
            and '__qualname__' in namespace
            and value.__qualname__.startswith(f'{namespace["__qualname__"]}.')
        ):
            # `value` is a nested type defined in this namespace; don't error
            continue
        elif isinstance(value, all_ignored_types) or value.__class__.__module__ == 'functools':
            ignored_names.add(var_name)
            continue
        elif isinstance(value, ModelPrivateAttr):
            if var_name.startswith('__'):
                raise NameError(
                    'Private attributes must not use dunder names;'
                    f' use a single underscore prefix instead of {var_name!r}.'
                )
            elif is_valid_field_name(var_name):
                raise NameError(
                    'Private attributes must not use valid field names;'
                    f' use sunder names, e.g. {"_" + var_name!r} instead of {var_name!r}.'
                )
            private_attributes[var_name] = value
            del namespace[var_name]
        elif isinstance(value, FieldInfo) and not is_valid_field_name(var_name):
            suggested_name = var_name.lstrip('_') or 'my_field'  # don't suggest '' for all-underscore name
            raise NameError(
                f'Fields must not use names with leading underscores;'
                f' e.g., use {suggested_name!r} instead of {var_name!r}.'
            )

        elif var_name.startswith('__'):
            continue
        elif is_valid_privateattr_name(var_name):
            if var_name not in raw_annotations or not is_classvar_annotation(raw_annotations[var_name]):
                private_attributes[var_name] = cast(ModelPrivateAttr, PrivateAttr(default=value))
                del namespace[var_name]
        elif var_name in base_class_vars:
            continue
        elif var_name not in raw_annotations:
            if var_name in base_class_fields:
                raise PydanticUserError(
                    f'Field {var_name!r} defined on a base class was overridden by a non-annotated attribute. '
                    f'All field definitions, including overrides, require a type annotation.',
                    code='model-field-overridden',
                )
            elif isinstance(value, FieldInfo):
                raise PydanticUserError(
                    f'Field {var_name!r} requires a type annotation', code='model-field-missing-annotation'
                )
            else:
                raise PydanticUserError(
                    f'A non-annotated attribute was detected: `{var_name} = {value!r}`. All model fields require a '
                    f'type annotation; if `{var_name}` is not meant to be a field, you may be able to resolve this '
                    f"error by annotating it as a `ClassVar` or updating `model_config['ignored_types']`.",
                    code='model-field-missing-annotation',
                )

    for ann_name, ann_type in raw_annotations.items():
        if (
            is_valid_privateattr_name(ann_name)
            and ann_name not in private_attributes
            and ann_name not in ignored_names
            # This condition can be a false negative when `ann_type` is stringified,
            # but it is handled in most cases in `set_model_fields`:
            and not is_classvar_annotation(ann_type)
            and ann_type not in all_ignored_types
            and getattr(ann_type, '__module__', None) != 'functools'
        ):
            if isinstance(ann_type, str):
                # Walking up the frames to get the module namespace where the model is defined
                # (as the model class wasn't created yet, we unfortunately can't use `cls.__module__`):
                frame = sys._getframe(2)
                if frame is not None:
                    try:
                        ann_type = eval_type_backport(
                            _make_forward_ref(ann_type, is_argument=False, is_class=True),
                            globalns=frame.f_globals,
                            localns=frame.f_locals,
                        )
                    except (NameError, TypeError):
                        pass

            if typing_objects.is_annotated(get_origin(ann_type)):
                _, *metadata = get_args(ann_type)
                private_attr = next((v for v in metadata if isinstance(v, ModelPrivateAttr)), None)
                if private_attr is not None:
                    private_attributes[ann_name] = private_attr
                    continue
            private_attributes[ann_name] = PrivateAttr()

    return private_attributes


def set_default_hash_func(cls: type[BaseModel], bases: tuple[type[Any], ...]) -> None:
    base_hash_func = get_attribute_from_bases(bases, '__hash__')
    new_hash_func = make_hash_func(cls)
    if base_hash_func in {None, object.__hash__} or getattr(base_hash_func, '__code__', None) == new_hash_func.__code__:
        # If `__hash__` is some default, we generate a hash function.
        # It will be `None` if not overridden from BaseModel.
        # It may be `object.__hash__` if there is another
        # parent class earlier in the bases which doesn't override `__hash__` (e.g. `typing.Generic`).
        # It may be a value set by `set_default_hash_func` if `cls` is a subclass of another frozen model.
        # In the last case we still need a new hash function to account for new `model_fields`.
        cls.__hash__ = new_hash_func


def make_hash_func(cls: type[BaseModel]) -> Any:
    getter = operator.itemgetter(*cls.__pydantic_fields__.keys()) if cls.__pydantic_fields__ else lambda _: 0

    def hash_func(self: Any) -> int:
        try:
            return hash(getter(self.__dict__))
        except KeyError:
            # In rare cases (such as when using the deprecated copy method), the __dict__ may not contain
            # all model fields, which is how we can get here.
            # getter(self.__dict__) is much faster than any 'safe' method that accounts for missing keys,
            # and wrapping it in a `try` doesn't slow things down much in the common case.
            return hash(getter(SafeGetItemProxy(self.__dict__)))

    return hash_func


def set_model_fields(
    cls: type[BaseModel],
    config_wrapper: ConfigWrapper,
    ns_resolver: NsResolver,
) -> None:
    """Collect and set `cls.__pydantic_fields__` and `cls.__class_vars__`.

    Args:
        cls: BaseModel or dataclass.
        config_wrapper: The config wrapper instance.
        ns_resolver: Namespace resolver to use when getting model annotations.
    """
    typevars_map = get_model_typevars_map(cls)
    fields, pydantic_extra_info, class_vars = collect_model_fields(
        cls, config_wrapper, ns_resolver, typevars_map=typevars_map
    )

    cls.__pydantic_fields__ = fields
    cls.__pydantic_extra_info__ = pydantic_extra_info
    cls.__class_vars__.update(class_vars)

    for k in class_vars:
        # Class vars should not be private attributes
        #     We remove them _here_ and not earlier because we rely on inspecting the class to determine its classvars,
        #     but private attributes are determined by inspecting the namespace _prior_ to class creation.
        #     In the case that a classvar with a leading-'_' is defined via a ForwardRef (e.g., when using
        #     `__future__.annotations`), we want to remove the private attribute which was detected _before_ we knew it
        #     evaluated to a classvar

        value = cls.__private_attributes__.pop(k, None)
        if value is not None and value.default is not PydanticUndefined:
            setattr(cls, k, value.default)


def complete_model_class(
    cls: type[BaseModel],
    config_wrapper: ConfigWrapper,
    ns_resolver: NsResolver,
    *,
    raise_errors: bool = True,
    call_on_complete_hook: bool = True,
    create_model_module: str | None = None,
    is_force_rebuild: bool = False,
) -> bool:
    """Finish building a model class.

    This logic must be called after class has been created since validation functions must be bound
    and `get_type_hints` requires a class object.

    Args:
        cls: BaseModel or dataclass.
        config_wrapper: The config wrapper instance.
        ns_resolver: The namespace resolver instance to use during schema building.
        raise_errors: Whether to raise errors.
        call_on_complete_hook: Whether to call the `__pydantic_on_complete__` hook.
        create_model_module: The module of the class to be created, if created by `create_model`.
        is_force_rebuild: Whether the model is being force-rebuilt (if True, pre-built serializers and
                          validators are not used, to avoid stale references).

    Returns:
        `True` if the model is successfully completed, else `False`.

    Raises:
        PydanticUndefinedAnnotation: If PydanticUndefinedAnnotation occurs in __get_pydantic_core_schema__
            and `raise_errors=True`.
    """
    typevars_map = get_model_typevars_map(cls)

    if not cls.__pydantic_fields_complete__:
        # Note: when coming from `ModelMetaclass.__new__()`, this results in fields being built twice.
        # We do so a second time here so that we can get the ``NameError`` for the specific undefined annotation.
        # Alternatively, we could let `GenerateSchema()` raise the error, but there are cases where incomplete
        # fields are inherited in `collect_model_fields()` and can actually have their annotation resolved in the
        # generate schema process. As we want to avoid having `__pydantic_fields_complete__` set to `False`
        # when `__pydantic_complete__` is `True`, we rebuild here:
        try:
            cls.__pydantic_fields__, cls.__pydantic_extra_info__ = rebuild_model_fields(
                cls,
                config_wrapper=config_wrapper,
                ns_resolver=ns_resolver,
                typevars_map=typevars_map,
            )
        except NameError as e:
            exc = PydanticUndefinedAnnotation.from_name_error(e)
            set_model_mocks(cls, f'`{exc.name}`')
            if raise_errors:
                raise exc from e

        if not raise_errors and not cls.__pydantic_fields_complete__:
            # No need to continue with schema gen, it is guaranteed to fail
            return False

        assert cls.__pydantic_fields_complete__

    gen_schema = GenerateSchema(
        config_wrapper,
        ns_resolver,
        typevars_map,
    )

    try:
        schema = gen_schema.generate_schema(cls)
    except PydanticUndefinedAnnotation as e:
        if raise_errors:
            raise
        set_model_mocks(cls, f'`{e.name}`')
        return False

    core_config = config_wrapper.core_config(title=cls.__name__)

    try:
        schema = gen_schema.clean_schema(schema)
    except InvalidSchemaError:
        set_model_mocks(cls)
        return False

    # This needs to happen *after* model schema generation, as the return types
    # of the properties are evaluated and the `ComputedFieldInfo` are recreated:
    cls.__pydantic_computed_fields__ = {k: v.info for k, v in cls.__pydantic_decorators__.computed_fields.items()}

    set_deprecated_descriptors(cls)

    cls.__pydantic_core_schema__ = schema

    cls.__pydantic_validator__ = create_schema_validator(
        schema,
        cls,
        create_model_module or cls.__module__,
        cls.__qualname__,
        'create_model' if create_model_module else 'BaseModel',
        core_config,
        config_wrapper.plugin_settings,
        _use_prebuilt=not is_force_rebuild,
    )
    cls.__pydantic_serializer__ = SchemaSerializer(schema, core_config, _use_prebuilt=not is_force_rebuild)

    # set __signature__ attr only for model class, but not for its instances
    # (because instances can define `__call__`, and `inspect.signature` shouldn't
    # use the `__signature__` attribute and instead generate from `__call__`).
    cls.__signature__ = LazyClassAttribute(
        '__signature__',
        partial(
            generate_pydantic_signature,
            init=cls.__init__,
            fields=cls.__pydantic_fields__,
            validate_by_name=config_wrapper.validate_by_name,
            extra=config_wrapper.extra,
        ),
    )

    cls.__pydantic_complete__ = True

    if call_on_complete_hook:
        cls.__pydantic_on_complete__()

    return True


def set_deprecated_descriptors(cls: type[BaseModel]) -> None:
    """Set data descriptors on the class for deprecated fields."""
    for field, field_info in cls.__pydantic_fields__.items():
        if (msg := field_info.deprecation_message) is not None:
            desc = _DeprecatedFieldDescriptor(msg)
            desc.__set_name__(cls, field)
            setattr(cls, field, desc)

    for field, computed_field_info in cls.__pydantic_computed_fields__.items():
        if (
            (msg := computed_field_info.deprecation_message) is not None
            # Avoid having two warnings emitted:
            and not hasattr(unwrap_wrapped_function(computed_field_info.wrapped_property), '__deprecated__')
        ):
            desc = _DeprecatedFieldDescriptor(msg, computed_field_info.wrapped_property)
            desc.__set_name__(cls, field)
            setattr(cls, field, desc)


class _DeprecatedFieldDescriptor:
    """Read-only data descriptor used to emit a runtime deprecation warning before accessing a deprecated field.

    Attributes:
        msg: The deprecation message to be emitted.
        wrapped_property: The property instance if the deprecated field is a computed field, or `None`.
        field_name: The name of the field being deprecated.
    """

    field_name: str

    def __init__(self, msg: str, wrapped_property: property | None = None) -> None:
        self.msg = msg
        self.wrapped_property = wrapped_property

    def __set_name__(self, cls: type[BaseModel], name: str) -> None:
        self.field_name = name

    def __get__(self, obj: BaseModel | None, obj_type: type[BaseModel] | None = None) -> Any:
        if obj is None:
            if self.wrapped_property is not None:
                return self.wrapped_property.__get__(None, obj_type)
            raise AttributeError(self.field_name)

        warnings.warn(self.msg, DeprecationWarning, stacklevel=2)

        if self.wrapped_property is not None:
            return self.wrapped_property.__get__(obj, obj_type)
        return obj.__dict__[self.field_name]

    # Defined to make it a data descriptor and take precedence over the instance's dictionary.
    # Note that it will not be called when setting a value on a model instance
    # as `BaseModel.__setattr__` is defined and takes priority.
    def __set__(self, obj: Any, value: Any) -> NoReturn:
        raise AttributeError(self.field_name)


class _PydanticWeakRef:
    """Wrapper for `weakref.ref` that enables `pickle` serialization.

    Cloudpickle fails to serialize weakref.ref objects due to an arcane error related to
    to abstract base classes (`abc.ABC`). This class works around the issue by wrapping
    `weakref.ref` instead of subclassing it.

    See https://github.com/pydantic/pydantic/issues/6763 for context.

    Semantics:
        - If not pickled, behaves the same as a `weakref.ref`.
        - If pickled along with the referenced object, the same `weakref.ref` behavior
          will be maintained between them after unpickling.
        - If pickled without the referenced object, after unpickling the underlying
          reference will be cleared (`__call__` will always return `None`).
    """

    def __init__(self, obj: Any):
        if obj is None:
            # The object will be `None` upon deserialization if the serialized weakref
            # had lost its underlying object.
            self._wr = None
        else:
            self._wr = weakref.ref(obj)

    def __call__(self) -> Any:
        if self._wr is None:
            return None
        else:
            return self._wr()

    def __reduce__(self) -> tuple[Callable, tuple[weakref.ReferenceType | None]]:
        return _PydanticWeakRef, (self(),)


def build_lenient_weakvaluedict(d: dict[str, Any] | None) -> dict[str, Any] | None:
    """Takes an input dictionary, and produces a new value that (invertibly) replaces the values with weakrefs.

    We can't just use a WeakValueDictionary because many types (including int, str, etc.) can't be stored as values
    in a WeakValueDictionary.

    The `unpack_lenient_weakvaluedict` function can be used to reverse this operation.
    """
    if d is None:
        return None
    result = {}
    for k, v in d.items():
        try:
            proxy = _PydanticWeakRef(v)
        except TypeError:
            proxy = v
        result[k] = proxy
    return result


def unpack_lenient_weakvaluedict(d: dict[str, Any] | None) -> dict[str, Any] | None:
    """Inverts the transform performed by `build_lenient_weakvaluedict`."""
    if d is None:
        return None

    result = {}
    for k, v in d.items():
        if isinstance(v, _PydanticWeakRef):
            v = v()
            if v is not None:
                result[k] = v
        else:
            result[k] = v
    return result


@cache
def default_ignored_types() -> tuple[type[Any], ...]:
    from ..fields import ComputedFieldInfo

    ignored_types = [
        FunctionType,
        property,
        classmethod,
        staticmethod,
        PydanticDescriptorProxy,
        ComputedFieldInfo,
        TypeAliasType,  # from `typing_extensions`
    ]

    if sys.version_info >= (3, 12):
        ignored_types.append(typing.TypeAliasType)

    return tuple(ignored_types)
