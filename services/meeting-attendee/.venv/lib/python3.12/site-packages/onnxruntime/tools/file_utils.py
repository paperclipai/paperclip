# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.
from __future__ import annotations

import os
import pathlib
import typing


def path_match_suffix_ignore_case(path: pathlib.Path | str, suffix: str) -> bool:
    """
    Returns whether `path` ends in `suffix`, ignoring case.
    """
    if not isinstance(path, str):
        path = str(path)
    return path.casefold().endswith(suffix.casefold())


def files_from_file_or_dir(
    file_or_dir_path: pathlib.Path | str, predicate: typing.Callable[[pathlib.Path], bool] = lambda _: True
) -> list[pathlib.Path]:
    """
    Gets the files in `file_or_dir_path` satisfying `predicate`.
    If `file_or_dir_path` is a file, the single file is considered. Otherwise, all files in the directory are
    considered.
    :param file_or_dir_path: Path to a file or directory.
    :param predicate: Predicate to determine if a file is included.
    :return: A list of files.
    """
    if not isinstance(file_or_dir_path, pathlib.Path):
        file_or_dir_path = pathlib.Path(file_or_dir_path)

    selected_files = []

    def process_file(file_path: pathlib.Path):
        if predicate(file_path):
            selected_files.append(file_path)

    if file_or_dir_path.is_dir():
        for root, _, files in os.walk(file_or_dir_path):
            for file in files:
                file_path = pathlib.Path(root, file)
                process_file(file_path)
    else:
        process_file(file_or_dir_path)

    return selected_files
