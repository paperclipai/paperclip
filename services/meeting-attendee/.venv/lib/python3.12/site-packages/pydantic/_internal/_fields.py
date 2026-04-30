"""Private logic related to fields (the `Field()` function and `FieldInfo` class), and arguments to `Annotated`."""

from __future__ import annotations as _annotations

import dataclasses
import warnings
from collections.abc import Mapping
from functools import cache
from inspect import Parameter, ismethoddescriptor
from re import Pattern
from typing import TYPE_CHECKING, Any, Callable, TypeVar, cast

from pydantic_core import PydanticUndefined
from typing_extensions import TypeIs
from typing_inspection.introspection import AnnotationSource

from pydantic import PydanticDeprecatedSince211
from pydantic.errors import PydanticUserError

from ..aliases import AliasGenerator
from . import _generics, _typing_extra
from ._config import ConfigWrapper
from ._docs_extraction import extract_docstrings_from_cls
from ._import_utils import import_cached_base_model, import_cached_field_info
from ._internal_dataclass import slots_true
from ._namespace_utils import NsResolver
from ._repr import Representation
from ._utils import can_be_positional, get_first_not_none

if TYPE_CHECKING:
    from annotated_types import BaseMetadata

    from ..fields import FieldInfo
    from ..main import BaseModel
    from ._dataclasses import PydanticDataclass, StandardDataclass
    from ._decorators import DecoratorInfos


class PydanticMetadata(Representation):
    """Base class for annotation markers like `Strict`."""

    __slots__ = ()


@dataclasses.dataclass(**slots_true)  # TODO: make kw_only when we drop support for 3.9.
class PydanticExtraInfo:
    # TODO: make use of PEP 747:
    annotation: Any
    complete: bool


def pydantic_general_metadata(**metadata: Any) -> BaseMetadata:
    """Create a new `_PydanticGeneralMetadata` class with the given metadata.

    Args:
        **metadata: The metadata to add.

    Returns:
        The new `_PydanticGeneralMetadata` class.
    """
    return _general_metadata_cls()(metadata)  # type: ignore


@cache
def _general_metadata_cls() -> type[BaseMetadata]:
    """Do it this way to avoid importing `annotated_types` at import time."""
    from annotated_types import BaseMetadata

    class _PydanticGeneralMetadata(PydanticMetadata, BaseMetadata):
        """Pydantic general metadata like `max_digits`."""

        def __init__(self, metadata: Any):
            self.__dict__ = metadata

    return _PydanticGeneralMetadata  # type: ignore


def _check_protected_namespaces(
    protected_namespaces: tuple[str | Pattern[str], ...],
    ann_name: str,
    bases: tuple[type[Any], ...],
    cls_name: str,
) -> None:
    BaseModel = import_cached_base_model()

    for protected_namespace in protected_namespaces:
        ns_violation = False
        if isinstance(protected_namespace, Pattern):
            ns_violation = protected_namespace.match(ann_name) is not None
        elif isinstance(protected_namespace, str):
            ns_violation = ann_name.startswith(protected_namespace)

        if ns_violation:
            for b in bases:
                if hasattr(b, ann_name):
                    if not (issubclass(b, BaseModel) and ann_name in getattr(b, '__pydantic_fields__', {})):
                        raise ValueError(
                            f'Field {ann_name!r} conflicts with member {getattr(b, ann_name)}'
                            f' of protected namespace {protected_namespace!r}.'
                        )
            else:
                valid_namespaces: list[str] = []
                for pn in protected_namespaces:
                    if isinstance(pn, Pattern):
                        if not pn.match(ann_name):
                            valid_namespaces.append(f're.compile({pn.pattern!r})')
                    else:
                        if not ann_name.startswith(pn):
                            valid_namespaces.append(f"'{pn}'")

                valid_namespaces_str = f'({", ".join(valid_namespaces)}{",)" if len(valid_namespaces) == 1 else ")"}'

                warnings.warn(
                    f'Field {ann_name!r} in {cls_name!r} conflicts with protected namespace {protected_namespace!r}.\n\n'
                    f"You may be able to solve this by setting the 'protected_namespaces' configuration to {valid_namespaces_str}.",
                    UserWarning,
                    stacklevel=5,
                )


def _update_fields_from_docstrings(cls: type[Any], fields: dict[str, FieldInfo], use_inspect: bool = False) -> None:
    fields_docs = extract_docstrings_from_cls(cls, use_inspect=use_inspect)
    for ann_name, field_info in fields.items():
        if field_info.description is None and ann_name in fields_docs:
            field_info.description = fields_docs[ann_name]


def _apply_field_title_generator_to_field_info(
    title_generator: Callable[[str, FieldInfo], str],
    field_name: str,
    field_info: FieldInfo,
):
    if field_info.title is None:
        title = title_generator(field_name, field_info)
        if not isinstance(title, str):
            raise TypeError(f'field_title_generator {title_generator} must return str, not {title.__class__}')

        field_info.title = title


def _apply_alias_generator_to_field_info(
    alias_generator: Callable[[str], str] | AliasGenerator, field_name: str, field_info: FieldInfo
):
    """Apply an alias generator to aliases on a `FieldInfo` instance if appropriate.

    Args:
        alias_generator: A callable that takes a string and returns a string, or an `AliasGenerator` instance.
        field_name: The name of the field from which to generate the alias.
        field_info: The `FieldInfo` instance to which the alias generator is (maybe) applied.
    """
    # Apply an alias_generator if
    # 1. An alias is not specified
    # 2. An alias is specified, but the priority is <= 1
    if (
        field_info.alias_priority is None
        or field_info.alias_priority <= 1
        or field_info.alias is None
        or field_info.validation_alias is None
        or field_info.serialization_alias is None
    ):
        alias, validation_alias, serialization_alias = None, None, None

        if isinstance(alias_generator, AliasGenerator):
            alias, validation_alias, serialization_alias = alias_generator.generate_aliases(field_name)
        elif callable(alias_generator):
            alias = alias_generator(field_name)
            if not isinstance(alias, str):
                raise TypeError(f'alias_generator {alias_generator} must return str, not {alias.__class__}')

        # if priority is not set, we set to 1
        # which supports the case where the alias_generator from a child class is used
        # to generate an alias for a field in a parent class
        if field_info.alias_priority is None or field_info.alias_priority <= 1:
            field_info.alias_priority = 1

        # if the priority is 1, then we set the aliases to the generated alias
        if field_info.alias_priority == 1:
            field_info.serialization_alias = get_first_not_none(serialization_alias, alias)
            field_info.validation_alias = get_first_not_none(validation_alias, alias)
            field_info.alias = alias

        # if any of the aliases are not set, then we set them to the corresponding generated alias
        if field_info.alias is None:
            field_info.alias = alias
        if field_info.serialization_alias is None:
            field_info.serialization_alias = get_first_not_none(serialization_alias, alias)
        if field_info.validation_alias is None:
            field_info.validation_alias = get_first_not_none(validation_alias, alias)


def update_field_from_config(config_wrapper: ConfigWrapper, field_name: str, field_info: FieldInfo) -> None:
    """Update the `FieldInfo` instance from the configuration set on the model it belongs to.

    This will apply the title and alias generators from the configuration.

    Args:
        config_wrapper: The configuration from the model.
        field_name: The field name the `FieldInfo` instance is attached to.
        field_info: The `FieldInfo` instance to update.
    """
    field_title_generator = field_info.field_title_generator or config_wrapper.field_title_generator
    if field_title_generator is not None:
        _apply_field_title_generator_to_field_info(field_title_generator, field_name, field_info)
    if config_wrapper.alias_generator is not None:
        _apply_alias_generator_to_field_info(config_wrapper.alias_generator, field_name, field_info)


_deprecated_method_names = {'dict', 'json', 'copy', '_iter', '_copy_and_set_values', '_calculate_keys'}

_deprecated_classmethod_names = {
    'parse_obj',
    'parse_raw',
    'parse_file',
    'from_orm',
    'construct',
    'schema',
    'schema_json',
    'validate',
    'update_forward_refs',
    '_get_value',
}


def collect_model_fields(  # noqa: C901
    cls: type[BaseModel],
    config_wrapper: ConfigWrapper,
    ns_resolver: NsResolver,
    *,
    typevars_map: Mapping[TypeVar, Any] | None = None,
) -> tuple[dict[str, FieldInfo], PydanticExtraInfo | None, set[str]]:
    """Collect the fields and class variables names of a nascent Pydantic model.

    The fields collection process is *lenient*, meaning it won't error if string annotations
    fail to evaluate. If this happens, the original annotation (and assigned value, if any)
    is stored on the created `FieldInfo` instance.

    The `rebuild_model_fields()` should be called at a later point (e.g. when rebuilding the model),
    and will make use of these stored attributes.

    Args:
        cls: BaseModel or dataclass.
        config_wrapper: The config wrapper instance.
        ns_resolver: Namespace resolver to use when getting model annotations.
        typevars_map: A dictionary mapping type variables to their concrete types.

    Returns:
        A three-tuple containing the model fields, the `PydanticExtraInfo` instance if the `__pydantic_extra__` annotation is set,
        and class variables names.

    Raises:
        NameError:
            - If there is a conflict between a field name and protected namespaces.
            - If there is a field other than `root` in `RootModel`.
            - If a field shadows an attribute in the parent model.
    """
    FieldInfo_ = import_cached_field_info()
    BaseModel_ = import_cached_base_model()

    bases = cls.__bases__
    parent_fields_lookup: dict[str, FieldInfo] = {}
    for base in reversed(bases):
        if model_fields := getattr(base, '__pydantic_fields__', None):
            parent_fields_lookup.update(model_fields)

    type_hints = _typing_extra.get_model_type_hints(cls, ns_resolver=ns_resolver)

    # `cls_annotations` is only used to determine if an annotation comes from a parent class
    cls_annotations = _typing_extra.safe_get_annotations(cls)

    fields: dict[str, FieldInfo] = {}

    class_vars: set[str] = set()
    for ann_name, (ann_type, evaluated) in type_hints.items():
        if ann_name == 'model_config':
            # We never want to treat `model_config` as a field
            # Note: we may need to change this logic if/when we introduce a `BareModel` class with no
            # protected namespaces (where `model_config` might be allowed as a field name)
            continue

        _check_protected_namespaces(
            protected_namespaces=config_wrapper.protected_namespaces,
            ann_name=ann_name,
            bases=bases,
            cls_name=cls.__name__,
        )

        if _typing_extra.is_classvar_annotation(ann_type):
            class_vars.add(ann_name)
            continue

        assigned_value = getattr(cls, ann_name, PydanticUndefined)
        if assigned_value is not PydanticUndefined and (
            # One of the deprecated instance methods was used as a field name (e.g. `dict()`):
            any(getattr(BaseModel_, depr_name, None) is assigned_value for depr_name in _deprecated_method_names)
            # One of the deprecated class methods was used as a field name (e.g. `schema()`):
            or (
                hasattr(assigned_value, '__func__')
                and any(
                    getattr(getattr(BaseModel_, depr_name, None), '__func__', None) is assigned_value.__func__  # pyright: ignore[reportAttributeAccessIssue]
                    for depr_name in _deprecated_classmethod_names
                )
            )
        ):
            # Then `assigned_value` would be the method, even though no default was specified:
            assigned_value = PydanticUndefined

        if not is_valid_field_name(ann_name):
            continue
        if cls.__pydantic_root_model__ and ann_name != 'root':
            raise NameError(
                f"Unexpected field with name {ann_name!r}; only 'root' is allowed as a field of a `RootModel`"
            )

        for base in bases:
            if hasattr(base, ann_name):
                if ann_name not in cls_annotations:
                    # Don't warn when a field exists in a parent class but has not been defined in the current class
                    continue

                # when building a generic model with `MyModel[int]`, the generic_origin check makes sure we don't get
                # "... shadows an attribute" warnings
                generic_origin = getattr(cls, '__pydantic_generic_metadata__', {}).get('origin')
                if base is generic_origin:
                    # Don't warn when "shadowing" of attributes in parametrized generics
                    continue

                dataclass_fields = {
                    field.name for field in (dataclasses.fields(base) if dataclasses.is_dataclass(base) else ())
                }
                if ann_name in dataclass_fields:
                    # Don't warn when inheriting stdlib dataclasses whose fields are "shadowed" by defaults being set
                    # on the class instance.
                    continue

                warnings.warn(
                    f'Field name "{ann_name}" in "{cls.__qualname__}" shadows an attribute in parent '
                    f'"{base.__qualname__}"',
                    UserWarning,
                    stacklevel=4,
                )

        if assigned_value is PydanticUndefined:  # no assignment, just a plain annotation
            if ann_name in cls_annotations or ann_name not in parent_fields_lookup:
                # field is either:
                # - present in the current model's annotations (and *not* from parent classes)
                # - not found on any base classes; this seems to be caused by fields not getting
                #   generated due to models not being fully defined while initializing recursive models.
                #   Nothing stops us from just creating a `FieldInfo` for this type hint, so we do this.
                field_info = FieldInfo_.from_annotation(ann_type, _source=AnnotationSource.CLASS)
                field_info._original_annotation = ann_type
                if not evaluated:
                    field_info._complete = False
                    # Store the original annotation that should be used to rebuild
                    # the field info later:
            else:
                # The field was present on one of the (possibly multiple) base classes, we make a copy directly from it.
                parent_field_info = parent_fields_lookup[ann_name]._copy()

                # The only case where substituting the type variables is relevant (i.e. when `typevars_map` is not empty)
                # is when a generic class is parameterized (e.g. `MyGenericModel[int, str]`), which creates a new class object
                # (unlike the stdlib genercis that create a generic alias). In this case, we are guaranteed to only have to copy
                # from the origin/parent model (e.g. `MyGenericModel`).
                if typevars_map:
                    field_info = _recreate_field_info(
                        parent_field_info, ns_resolver=ns_resolver, typevars_map=typevars_map, lenient=True
                    )
                else:
                    field_info = parent_field_info

        else:  # An assigned value is present (either the default value, or a `Field()` function)
            if isinstance(assigned_value, FieldInfo_) and ismethoddescriptor(assigned_value.default):
                # `assigned_value` was fetched using `getattr`, which triggers a call to `__get__`
                # for descriptors, so we do the same if the `= field(default=...)` form is used.
                # Note that we only do this for method descriptors for now, we might want to
                # extend this to any descriptor in the future (by simply checking for
                # `hasattr(assigned_value.default, '__get__')`).
                default = assigned_value.default.__get__(None, cls)
                assigned_value.default = default
                assigned_value._attributes_set['default'] = default

            field_info = FieldInfo_.from_annotated_attribute(ann_type, assigned_value, _source=AnnotationSource.CLASS)

            # Store the original annotation and assignment value that could be used to rebuild the field info later.
            field_info._original_assignment = assigned_value
            field_info._original_annotation = ann_type
            if not evaluated:
                field_info._complete = False
            elif 'final' in field_info._qualifiers and not field_info.is_required():
                warnings.warn(
                    f'Annotation {ann_name!r} is marked as final and has a default value. Pydantic treats {ann_name!r} as a '
                    'class variable, but it will be considered as a normal field in V3 to be aligned with dataclasses. If you '
                    f'still want {ann_name!r} to be considered as a class variable, annotate it as: `ClassVar[<type>] = <default>.`',
                    category=PydanticDeprecatedSince211,
                    # Incorrect when `create_model` is used, but the chance that final with a default is used is low in that case:
                    stacklevel=4,
                )
                class_vars.add(ann_name)
                continue

            # attributes which are fields are removed from the class namespace:
            # 1. To match the behaviour of annotation-only fields
            # 2. To avoid false positives in the NameError check above
            try:
                delattr(cls, ann_name)
            except AttributeError:
                pass  # indicates the attribute was on a parent class

        # Use cls.__dict__['__pydantic_decorators__'] instead of cls.__pydantic_decorators__
        # to make sure the decorators have already been built for this exact class
        decorators: DecoratorInfos = cls.__dict__['__pydantic_decorators__']
        if ann_name in decorators.computed_fields:
            raise TypeError(
                f'Field {ann_name!r} of class {cls.__name__!r} overrides symbol of same name in a parent class. '
                'This override with a computed_field is incompatible.'
            )
        fields[ann_name] = field_info

        if field_info._complete:
            # If not complete, this will be called in `rebuild_model_fields()`:
            update_field_from_config(config_wrapper, ann_name, field_info)

    if config_wrapper.use_attribute_docstrings:
        _update_fields_from_docstrings(cls, fields)

    pydantic_extra_info: PydanticExtraInfo | None = None
    if '__pydantic_extra__' in type_hints:
        ann, complete = type_hints['__pydantic_extra__']
        pydantic_extra_info = PydanticExtraInfo(
            annotation=ann,
            complete=complete,
        )

    return fields, pydantic_extra_info, class_vars


def rebuild_model_fields(
    cls: type[BaseModel],
    *,
    config_wrapper: ConfigWrapper,
    ns_resolver: NsResolver,
    typevars_map: Mapping[TypeVar, Any],
) -> tuple[dict[str, FieldInfo], PydanticExtraInfo | None]:
    """Rebuild the (already present) model fields by trying to reevaluate annotations.

    This function should be called whenever a model with incomplete fields is encountered.

    Returns:
        A two-tuple, the first element being the rebuilt fields, the second element being
        the rebuild `PydanticExtraInfo` instance, if available.

    Raises:
        NameError: If one of the annotations failed to evaluate.

    Note:
        This function *doesn't* mutate the model fields in place, as it can be called during
        schema generation, where you don't want to mutate other model's fields.
    """
    rebuilt_fields: dict[str, FieldInfo] = {}
    with ns_resolver.push(cls):
        for f_name, field_info in cls.__pydantic_fields__.items():
            if field_info._complete:
                rebuilt_fields[f_name] = field_info
            else:
                new_field = _recreate_field_info(
                    field_info, ns_resolver=ns_resolver, typevars_map=typevars_map, lenient=False
                )
                update_field_from_config(config_wrapper, f_name, new_field)
                rebuilt_fields[f_name] = new_field

        if cls.__pydantic_extra_info__ is not None and not cls.__pydantic_extra_info__.complete:
            rebuilt_extra_info = PydanticExtraInfo(
                annotation=_typing_extra.eval_type(
                    cls.__pydantic_extra_info__.annotation, *ns_resolver.types_namespace
                ),
                complete=True,
            )
        else:
            rebuilt_extra_info = cls.__pydantic_extra_info__

    return rebuilt_fields, rebuilt_extra_info


def _recreate_field_info(
    field_info: FieldInfo,
    ns_resolver: NsResolver,
    typevars_map: Mapping[TypeVar, Any],
    *,
    lenient: bool,
) -> FieldInfo:
    FieldInfo_ = import_cached_field_info()

    existing_desc = field_info.description
    if lenient:
        ann = _generics.replace_types(field_info._original_annotation, typevars_map)
        ann, evaluated = _typing_extra.try_eval_type(
            ann,
            *ns_resolver.types_namespace,
        )
    else:
        # Not the best pattern, maybe we could ship our own `eval_type()`,
        # that would replace the type variables on the fly during evaluation.
        ann = _typing_extra.eval_type(
            field_info._original_annotation,
            *ns_resolver.types_namespace,
        )
        ann = _generics.replace_types(ann, typevars_map)
        ann = _typing_extra.eval_type(
            ann,
            *ns_resolver.types_namespace,
        )
        evaluated = True

    if (assign := field_info._original_assignment) is PydanticUndefined:
        new_field = FieldInfo_.from_annotation(ann, _source=AnnotationSource.CLASS)
    else:
        new_field = FieldInfo_.from_annotated_attribute(ann, assign, _source=AnnotationSource.CLASS)
        new_field._original_assignment = assign
    new_field._original_annotation = ann
    # The description might come from the docstring if `use_attribute_docstrings` was `True`:
    new_field.description = new_field.description if new_field.description is not None else existing_desc
    if not evaluated:
        new_field._complete = False

    return new_field


def collect_dataclass_fields(
    cls: type[StandardDataclass],
    *,
    config_wrapper: ConfigWrapper,
    ns_resolver: NsResolver | None = None,
    typevars_map: dict[Any, Any] | None = None,
) -> dict[str, FieldInfo]:
    """Collect the fields of a dataclass.

    Args:
        cls: dataclass.
        config_wrapper: The config wrapper instance.
        ns_resolver: Namespace resolver to use when getting dataclass annotations.
            Defaults to an empty instance.
        typevars_map: A dictionary mapping type variables to their concrete types.

    Returns:
        The dataclass fields.
    """
    FieldInfo_ = import_cached_field_info()

    fields: dict[str, FieldInfo] = {}
    ns_resolver = ns_resolver or NsResolver()
    dataclass_fields = cls.__dataclass_fields__

    # The logic here is similar to `_typing_extra.get_cls_type_hints`,
    # although we do it manually as stdlib dataclasses already have annotations
    # collected in each class:
    for base in reversed(cls.__mro__):
        if not dataclasses.is_dataclass(base):
            continue

        with ns_resolver.push(base):
            for ann_name, dataclass_field in dataclass_fields.items():
                base_anns = _typing_extra.safe_get_annotations(base)

                if ann_name not in base_anns:
                    # `__dataclass_fields__`contains every field, even the ones from base classes.
                    # Only collect the ones defined on `base`.
                    continue

                globalns, localns = ns_resolver.types_namespace
                ann_type, evaluated = _typing_extra.try_eval_type(dataclass_field.type, globalns, localns)

                if _typing_extra.is_classvar_annotation(ann_type):
                    continue

                if (
                    not dataclass_field.init
                    and dataclass_field.default is dataclasses.MISSING
                    and dataclass_field.default_factory is dataclasses.MISSING
                ):
                    # TODO: We should probably do something with this so that validate_assignment behaves properly
                    #   Issue: https://github.com/pydantic/pydantic/issues/5470
                    continue

                if isinstance(dataclass_field.default, FieldInfo_):
                    if dataclass_field.default.init_var:
                        if dataclass_field.default.init is False:
                            raise PydanticUserError(
                                f'Dataclass field {ann_name} has init=False and init_var=True, but these are mutually exclusive.',
                                code='clashing-init-and-init-var',
                            )

                        # TODO: same note as above re validate_assignment
                        continue
                    field_info = FieldInfo_.from_annotated_attribute(
                        ann_type, dataclass_field.default, _source=AnnotationSource.DATACLASS
                    )
                    field_info._original_assignment = dataclass_field.default
                else:
                    field_info = FieldInfo_.from_annotated_attribute(
                        ann_type, dataclass_field, _source=AnnotationSource.DATACLASS
                    )
                    field_info._original_assignment = dataclass_field

                if not evaluated:
                    field_info._complete = False
                    field_info._original_annotation = ann_type

                fields[ann_name] = field_info
                update_field_from_config(config_wrapper, ann_name, field_info)

                if field_info.default is not PydanticUndefined and isinstance(
                    getattr(cls, ann_name, field_info), FieldInfo_
                ):
                    # We need this to fix the default when the "default" from __dataclass_fields__ is a pydantic.FieldInfo
                    setattr(cls, ann_name, field_info.default)

    if typevars_map:
        for field in fields.values():
            # We don't pass any ns, as `field.annotation`
            # was already evaluated. TODO: is this method relevant?
            # Can't we juste use `_generics.replace_types`?
            field.apply_typevars_map(typevars_map)

    if config_wrapper.use_attribute_docstrings:
        _update_fields_from_docstrings(
            cls,
            fields,
            # We can't rely on the (more reliable) frame inspection method
            # for stdlib dataclasses:
            use_inspect=not hasattr(cls, '__is_pydantic_dataclass__'),
        )

    return fields


def rebuild_dataclass_fields(
    cls: type[PydanticDataclass],
    *,
    config_wrapper: ConfigWrapper,
    ns_resolver: NsResolver,
    typevars_map: Mapping[TypeVar, Any],
) -> dict[str, FieldInfo]:
    """Rebuild the (already present) dataclass fields by trying to reevaluate annotations.

    This function should be called whenever a dataclass with incomplete fields is encountered.

    Raises:
        NameError: If one of the annotations failed to evaluate.

    Note:
        This function *doesn't* mutate the dataclass fields in place, as it can be called during
        schema generation, where you don't want to mutate other dataclass's fields.
    """
    FieldInfo_ = import_cached_field_info()

    rebuilt_fields: dict[str, FieldInfo] = {}
    with ns_resolver.push(cls):
        for f_name, field_info in cls.__pydantic_fields__.items():
            if field_info._complete:
                rebuilt_fields[f_name] = field_info
            else:
                existing_desc = field_info.description
                ann = _typing_extra.eval_type(
                    field_info._original_annotation,
                    *ns_resolver.types_namespace,
                )
                ann = _generics.replace_types(ann, typevars_map)
                new_field = FieldInfo_.from_annotated_attribute(
                    ann,
                    field_info._original_assignment,
                    _source=AnnotationSource.DATACLASS,
                )

                # The description might come from the docstring if `use_attribute_docstrings` was `True`:
                new_field.description = new_field.description if new_field.description is not None else existing_desc
                update_field_from_config(config_wrapper, f_name, new_field)
                rebuilt_fields[f_name] = new_field

    return rebuilt_fields


def is_valid_field_name(name: str) -> bool:
    return not name.startswith('_')


def is_valid_privateattr_name(name: str) -> bool:
    return name.startswith('_') and not name.startswith('__')


def takes_validated_data_argument(
    default_factory: Callable[[], Any] | Callable[[dict[str, Any]], Any],
) -> TypeIs[Callable[[dict[str, Any]], Any]]:
    """Whether the provided default factory callable has a validated data parameter."""
    try:
        sig = _typing_extra.signature_no_eval(default_factory)
    except (ValueError, TypeError):
        # `inspect.signature` might not be able to infer a signature, e.g. with C objects.
        # In this case, we assume no data argument is present:
        return False

    parameters = list(sig.parameters.values())

    return len(parameters) == 1 and can_be_positional(parameters[0]) and parameters[0].default is Parameter.empty


def resolve_default_value(
    default: Any,
    default_factory: Callable[[], Any] | Callable[[dict[str, Any]], Any] | None,
    *,
    validated_data: dict[str, Any] | None = None,
    call_default_factory: bool = False,
) -> Any:
    """Resolve the default value using either a static default or a default_factory."""
    from ._utils import smart_deepcopy

    if default_factory is None:
        return smart_deepcopy(default)
    if call_default_factory:
        if takes_validated_data_argument(default_factory=default_factory):
            fac = cast('Callable[[dict[str, Any]], Any]', default_factory)
            if validated_data is None:
                raise ValueError(
                    "The default factory requires the 'validated_data' argument, which was not provided when calling 'get_default()'."
                )
            return fac(validated_data)
        else:
            fac = cast('Callable[[], Any]', default_factory)
            return fac()

    return PydanticUndefined
