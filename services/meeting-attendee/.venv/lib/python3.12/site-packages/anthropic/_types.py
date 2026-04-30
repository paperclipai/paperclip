from __future__ import annotations

from os import PathLike
from typing import (
    IO,
    TYPE_CHECKING,
    Any,
    Dict,
    List,
    Type,
    Tuple,
    Union,
    Mapping,
    TypeVar,
    Callable,
    Iterable,
    Iterator,
    Optional,
    Sequence,
    AsyncIterable,
)
from typing_extensions import (
    Set,
    Literal,
    Protocol,
    TypeAlias,
    TypedDict,
    SupportsIndex,
    overload,
    override,
    runtime_checkable,
)

import httpx
import pydantic
from httpx import URL, Proxy, Timeout, Response, BaseTransport, AsyncBaseTransport

if TYPE_CHECKING:
    from ._models import BaseModel
    from ._response import APIResponse, AsyncAPIResponse
    from ._legacy_response import HttpxBinaryResponseContent

Transport = BaseTransport
AsyncTransport = AsyncBaseTransport
Query = Mapping[str, object]
Body = object
AnyMapping = Mapping[str, object]
ModelT = TypeVar("ModelT", bound=pydantic.BaseModel)
_T = TypeVar("_T")


# Approximates httpx internal ProxiesTypes and RequestFiles types
# while adding support for `PathLike` instances
ProxiesDict = Dict["str | URL", Union[None, str, URL, Proxy]]
ProxiesTypes = Union[str, Proxy, ProxiesDict]
if TYPE_CHECKING:
    Base64FileInput = Union[IO[bytes], PathLike[str]]
    FileContent = Union[IO[bytes], bytes, PathLike[str]]
else:
    Base64FileInput = Union[IO[bytes], PathLike]
    FileContent = Union[IO[bytes], bytes, PathLike]  # PathLike is not subscriptable in Python 3.8.


# Used for sending raw binary data / streaming data in request bodies
# e.g. for file uploads without multipart encoding
BinaryTypes = Union[bytes, bytearray, IO[bytes], Iterable[bytes]]
AsyncBinaryTypes = Union[bytes, bytearray, IO[bytes], AsyncIterable[bytes]]

FileTypes = Union[
    # file (or bytes)
    FileContent,
    # (filename, file (or bytes))
    Tuple[Optional[str], FileContent],
    # (filename, file (or bytes), content_type)
    Tuple[Optional[str], FileContent, Optional[str]],
    # (filename, file (or bytes), content_type, headers)
    Tuple[Optional[str], FileContent, Optional[str], Mapping[str, str]],
]
RequestFiles = Union[Mapping[str, FileTypes], Sequence[Tuple[str, FileTypes]]]

# duplicate of the above but without our custom file support
HttpxFileContent = Union[IO[bytes], bytes]
HttpxFileTypes = Union[
    # file (or bytes)
    HttpxFileContent,
    # (filename, file (or bytes))
    Tuple[Optional[str], HttpxFileContent],
    # (filename, file (or bytes), content_type)
    Tuple[Optional[str], HttpxFileContent, Optional[str]],
    # (filename, file (or bytes), content_type, headers)
    Tuple[Optional[str], HttpxFileContent, Optional[str], Mapping[str, str]],
]
HttpxRequestFiles = Union[Mapping[str, HttpxFileTypes], Sequence[Tuple[str, HttpxFileTypes]]]

# Workaround to support (cast_to: Type[ResponseT]) -> ResponseT
# where ResponseT includes `None`. In order to support directly
# passing `None`, overloads would have to be defined for every
# method that uses `ResponseT` which would lead to an unacceptable
# amount of code duplication and make it unreadable. See _base_client.py
# for example usage.
#
# This unfortunately means that you will either have
# to import this type and pass it explicitly:
#
# from anthropic import NoneType
# client.get('/foo', cast_to=NoneType)
#
# or build it yourself:
#
# client.get('/foo', cast_to=type(None))
if TYPE_CHECKING:
    NoneType: Type[None]
else:
    NoneType = type(None)


class RequestOptions(TypedDict, total=False):
    headers: Headers
    max_retries: int
    timeout: float | Timeout | None
    params: Query
    extra_json: AnyMapping
    idempotency_key: str
    follow_redirects: bool


# Sentinel class used until PEP 0661 is accepted
class NotGiven:
    """
    For parameters with a meaningful None value, we need to distinguish between
    the user explicitly passing None, and the user not passing the parameter at
    all.

    User code shouldn't need to use not_given directly.

    For example:

    ```py
    def create(timeout: Timeout | None | NotGiven = not_given): ...


    create(timeout=1)  # 1s timeout
    create(timeout=None)  # No timeout
    create()  # Default timeout behavior
    ```
    """

    def __bool__(self) -> Literal[False]:
        return False

    @override
    def __repr__(self) -> str:
        return "NOT_GIVEN"


not_given = NotGiven()
# for backwards compatibility:
NOT_GIVEN = NotGiven()


class Omit:
    """
    To explicitly omit something from being sent in a request, use `omit`.

    ```py
    # as the default `Content-Type` header is `application/json` that will be sent
    client.post("/upload/files", files={"file": b"my raw file content"})

    # you can't explicitly override the header as it has to be dynamically generated
    # to look something like: 'multipart/form-data; boundary=0d8382fcf5f8c3be01ca2e11002d2983'
    client.post(..., headers={"Content-Type": "multipart/form-data"})

    # instead you can remove the default `application/json` header by passing omit
    client.post(..., headers={"Content-Type": omit})
    ```
    """

    def __bool__(self) -> Literal[False]:
        return False


omit = Omit()


@runtime_checkable
class ModelBuilderProtocol(Protocol):
    @classmethod
    def build(
        cls: type[_T],
        *,
        response: Response,
        data: object,
    ) -> _T: ...


Headers = Mapping[str, Union[str, Omit]]


class HeadersLikeProtocol(Protocol):
    def get(self, __key: str) -> str | None: ...


HeadersLike = Union[Headers, HeadersLikeProtocol]

ResponseT = TypeVar(
    "ResponseT",
    bound=Union[
        object,
        str,
        None,
        "BaseModel",
        List[Any],
        Dict[str, Any],
        Response,
        ModelBuilderProtocol,
        "APIResponse[Any]",
        "AsyncAPIResponse[Any]",
        "HttpxBinaryResponseContent",
    ],
)

StrBytesIntFloat = Union[str, bytes, int, float]

# Note: copied from Pydantic
# https://github.com/pydantic/pydantic/blob/6f31f8f68ef011f84357330186f603ff295312fd/pydantic/main.py#L79
IncEx: TypeAlias = Union[Set[int], Set[str], Mapping[int, Union["IncEx", bool]], Mapping[str, Union["IncEx", bool]]]

PostParser = Callable[[Any], Any]


@runtime_checkable
class InheritsGeneric(Protocol):
    """Represents a type that has inherited from `Generic`

    The `__orig_bases__` property can be used to determine the resolved
    type variable for a given base class.
    """

    __orig_bases__: tuple[_GenericAlias]


class _GenericAlias(Protocol):
    __origin__: type[object]


class HttpxSendArgs(TypedDict, total=False):
    auth: httpx.Auth
    follow_redirects: bool


_T_co = TypeVar("_T_co", covariant=True)


if TYPE_CHECKING:
    # This works because str.__contains__ does not accept object (either in typeshed or at runtime)
    # https://github.com/hauntsaninja/useful_types/blob/5e9710f3875107d068e7679fd7fec9cfab0eff3b/useful_types/__init__.py#L285
    #
    # Note: index() and count() methods are intentionally omitted to allow pyright to properly
    # infer TypedDict types when dict literals are used in lists assigned to SequenceNotStr.
    class SequenceNotStr(Protocol[_T_co]):
        @overload
        def __getitem__(self, index: SupportsIndex, /) -> _T_co: ...
        @overload
        def __getitem__(self, index: slice, /) -> Sequence[_T_co]: ...
        def __contains__(self, value: object, /) -> bool: ...
        def __len__(self) -> int: ...
        def __iter__(self) -> Iterator[_T_co]: ...
        def __reversed__(self) -> Iterator[_T_co]: ...
else:
    # just point this to a normal `Sequence` at runtime to avoid having to special case
    # deserializing our custom sequence type
    SequenceNotStr = Sequence
