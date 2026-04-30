# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
"""
Ensure that dependencies are available and then load the extension module.
"""
import os
import platform
import warnings

from . import _ld_preload  # noqa: F401

if platform.system() == "Windows":
    from . import version_info

    # If on Windows, check if this import error is caused by the user not installing the 2019 VC Runtime
    # The VC Redist installer usually puts the VC Runtime dlls in the System32 folder, but it may also be found
    # in some other locations.
    # TODO, we may want to try to load the VC Runtime dlls instead of checking if the hardcoded file path
    # is valid, and raise ImportError if the load fails
    if version_info.vs2019 and platform.architecture()[0] == "64bit":
        system_root = os.getenv("SystemRoot") or "C:\\Windows"
        if not os.path.isfile(os.path.join(system_root, "System32", "vcruntime140_1.dll")):
            warnings.warn("Please install the 2019 Visual C++ runtime and then try again. "
                          "If you've installed the runtime in a non-standard location "
                          "(other than %SystemRoot%\\System32), "
                          "make sure it can be found by setting the correct path.")



from .onnxruntime_pybind11_state import *  # noqa

