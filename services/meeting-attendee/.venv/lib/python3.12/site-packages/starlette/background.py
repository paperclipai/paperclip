from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any, ParamSpec

from starlette._utils import is_async_callable
from starlette.concurrency import run_in_threadpool

P = ParamSpec("P")


class BackgroundTask:
    def __init__(self, func: Callable[P, Any], *args: P.args, **kwargs: P.kwargs) -> None:
        self.func = func
        self.args = args
        self.kwargs = kwargs
        self.is_async = is_async_callable(func)

    async def __call__(self) -> None:
        if self.is_async:
            await self.func(*self.args, **self.kwargs)
        else:
            await run_in_threadpool(self.func, *self.args, **self.kwargs)


class BackgroundTasks(BackgroundTask):
    def __init__(self, tasks: Sequence[BackgroundTask] | None = None):
        self.tasks = list(tasks) if tasks else []

    def add_task(self, func: Callable[P, Any], *args: P.args, **kwargs: P.kwargs) -> None:
        task = BackgroundTask(func, *args, **kwargs)
        self.tasks.append(task)

    async def __call__(self) -> None:
        for task in self.tasks:
            await task()
