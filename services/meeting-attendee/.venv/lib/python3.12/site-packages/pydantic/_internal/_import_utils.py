from functools import cache
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pydantic import BaseModel
    from pydantic.fields import FieldInfo


@cache
def import_cached_base_model() -> type['BaseModel']:
    from pydantic import BaseModel

    return BaseModel


@cache
def import_cached_field_info() -> type['FieldInfo']:
    from pydantic.fields import FieldInfo

    return FieldInfo
