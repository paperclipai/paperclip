# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.
"""
Short examples used in the documentation.
"""

import os


def get_example(name):
    """
    Retrieves the absolute file name of an example.
    """
    this = os.path.abspath(os.path.dirname(__file__))
    full = os.path.join(this, name)
    if not os.path.exists(full):
        raise FileNotFoundError(f"Unable to find example '{name}'")
    return full
