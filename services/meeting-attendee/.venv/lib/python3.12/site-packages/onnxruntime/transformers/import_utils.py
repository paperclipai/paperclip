# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
import importlib.metadata
import importlib.util


def is_installed(package):
    try:
        dist = importlib.metadata.distribution(package)
    except importlib.metadata.PackageNotFoundError:
        try:
            spec = importlib.util.find_spec(package)
        except ModuleNotFoundError:
            return False

        return spec is not None

    return dist is not None
