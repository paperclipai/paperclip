# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Any, List, Generic, TypeVar, Optional, cast
from typing_extensions import Protocol, override, runtime_checkable

from ._base_client import BasePage, PageInfo, BaseSyncPage, BaseAsyncPage

__all__ = ["SyncCursorIDPage", "AsyncCursorIDPage"]

_T = TypeVar("_T")


@runtime_checkable
class CursorIDPageItem(Protocol):
    id: str


class SyncCursorIDPage(BaseSyncPage[_T], BasePage[_T], Generic[_T]):
    data: List[_T]

    @override
    def _get_page_items(self) -> List[_T]:
        data = self.data
        if not data:
            return []
        return data

    @override
    def next_page_info(self) -> Optional[PageInfo]:
        is_forwards = not self._options.params.get("ending_before", False)

        data = self.data
        if not data:
            return None

        if is_forwards:
            item = cast(Any, data[-1])
            if not isinstance(item, CursorIDPageItem) or item.id is None:  # pyright: ignore[reportUnnecessaryComparison]
                # TODO emit warning log
                return None

            return PageInfo(params={"starting_after": item.id})
        else:
            item = cast(Any, self.data[0])
            if not isinstance(item, CursorIDPageItem) or item.id is None:  # pyright: ignore[reportUnnecessaryComparison]
                # TODO emit warning log
                return None

            return PageInfo(params={"ending_before": item.id})


class AsyncCursorIDPage(BaseAsyncPage[_T], BasePage[_T], Generic[_T]):
    data: List[_T]

    @override
    def _get_page_items(self) -> List[_T]:
        data = self.data
        if not data:
            return []
        return data

    @override
    def next_page_info(self) -> Optional[PageInfo]:
        is_forwards = not self._options.params.get("ending_before", False)

        data = self.data
        if not data:
            return None

        if is_forwards:
            item = cast(Any, data[-1])
            if not isinstance(item, CursorIDPageItem) or item.id is None:  # pyright: ignore[reportUnnecessaryComparison]
                # TODO emit warning log
                return None

            return PageInfo(params={"starting_after": item.id})
        else:
            item = cast(Any, self.data[0])
            if not isinstance(item, CursorIDPageItem) or item.id is None:  # pyright: ignore[reportUnnecessaryComparison]
                # TODO emit warning log
                return None

            return PageInfo(params={"ending_before": item.id})
