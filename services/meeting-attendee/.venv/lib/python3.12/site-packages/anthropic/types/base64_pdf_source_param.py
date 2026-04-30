# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union
from typing_extensions import Literal, Required, Annotated, TypedDict

from .._types import Base64FileInput
from .._utils import PropertyInfo
from .._models import set_pydantic_config

__all__ = ["Base64PDFSourceParam"]


class Base64PDFSourceParam(TypedDict, total=False):
    data: Required[Annotated[Union[str, Base64FileInput], PropertyInfo(format="base64")]]

    media_type: Required[Literal["application/pdf"]]

    type: Required[Literal["base64"]]


set_pydantic_config(Base64PDFSourceParam, {"arbitrary_types_allowed": True})
