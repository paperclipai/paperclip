from __future__ import annotations

import os
import warnings
from collections.abc import Callable, Iterator, Mapping, MutableMapping
from pathlib import Path
from typing import Any, TypeVar, overload


class undefined:
    pass


class EnvironError(Exception):
    pass


class Environ(MutableMapping[str, str]):
    def __init__(self, environ: MutableMapping[str, str] = os.environ):
        self._environ = environ
        self._has_been_read: set[str] = set()

    def __getitem__(self, key: str) -> str:
        self._has_been_read.add(key)
        return self._environ.__getitem__(key)

    def __setitem__(self, key: str, value: str) -> None:
        if key in self._has_been_read:
            raise EnvironError(f"Attempting to set environ['{key}'], but the value has already been read.")
        self._environ.__setitem__(key, value)

    def __delitem__(self, key: str) -> None:
        if key in self._has_been_read:
            raise EnvironError(f"Attempting to delete environ['{key}'], but the value has already been read.")
        self._environ.__delitem__(key)

    def __iter__(self) -> Iterator[str]:
        return iter(self._environ)

    def __len__(self) -> int:
        return len(self._environ)


environ = Environ()

T = TypeVar("T")


class Config:
    def __init__(
        self,
        env_file: str | Path | None = None,
        environ: Mapping[str, str] = environ,
        env_prefix: str = "",
        encoding: str = "utf-8",
    ) -> None:
        self.environ = environ
        self.env_prefix = env_prefix
        self.file_values: dict[str, str] = {}
        if env_file is not None:
            if not os.path.isfile(env_file):
                warnings.warn(f"Config file '{env_file}' not found.")
            else:
                self.file_values = self._read_file(env_file, encoding)

    @overload
    def __call__(self, key: str, *, default: None) -> str | None: ...

    @overload
    def __call__(self, key: str, cast: type[T], default: T = ...) -> T: ...

    @overload
    def __call__(self, key: str, cast: type[str] = ..., default: str = ...) -> str: ...

    @overload
    def __call__(
        self,
        key: str,
        cast: Callable[[Any], T] = ...,
        default: Any = ...,
    ) -> T: ...

    @overload
    def __call__(self, key: str, cast: type[str] = ..., default: T = ...) -> T | str: ...

    def __call__(
        self,
        key: str,
        cast: Callable[[Any], Any] | None = None,
        default: Any = undefined,
    ) -> Any:
        return self.get(key, cast, default)

    def get(
        self,
        key: str,
        cast: Callable[[Any], Any] | None = None,
        default: Any = undefined,
    ) -> Any:
        key = self.env_prefix + key
        if key in self.environ:
            value = self.environ[key]
            return self._perform_cast(key, value, cast)
        if key in self.file_values:
            value = self.file_values[key]
            return self._perform_cast(key, value, cast)
        if default is not undefined:
            return self._perform_cast(key, default, cast)
        raise KeyError(f"Config '{key}' is missing, and has no default.")

    def _read_file(self, file_name: str | Path, encoding: str) -> dict[str, str]:
        file_values: dict[str, str] = {}
        with open(file_name, encoding=encoding) as input_file:
            for line in input_file.readlines():
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    key, value = line.split("=", 1)
                    key = key.strip()
                    value = value.strip().strip("\"'")
                    file_values[key] = value
        return file_values

    def _perform_cast(
        self,
        key: str,
        value: Any,
        cast: Callable[[Any], Any] | None = None,
    ) -> Any:
        if cast is None or value is None:
            return value
        elif cast is bool and isinstance(value, str):
            mapping = {"true": True, "1": True, "false": False, "0": False}
            value = value.lower()
            if value not in mapping:
                raise ValueError(f"Config '{key}' has value '{value}'. Not a valid bool.")
            return mapping[value]
        try:
            return cast(value)
        except (TypeError, ValueError):
            raise ValueError(f"Config '{key}' has value '{value}'. Not a valid {cast.__name__}.")
