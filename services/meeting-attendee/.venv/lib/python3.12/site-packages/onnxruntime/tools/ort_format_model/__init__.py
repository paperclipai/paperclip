# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

import os
import sys

# need to add the path to the ORT flatbuffers python module before we import anything else here.
# we also auto-magically adjust to whether we're running from the ORT repo, or from within the ORT python package
script_dir = os.path.dirname(os.path.realpath(__file__))
fbs_py_schema_dirname = "ort_flatbuffers_py"
if os.path.isdir(os.path.join(script_dir, fbs_py_schema_dirname)):
    # fbs bindings are in this directory, so we're running in the ORT python package
    ort_fbs_py_parent_dir = script_dir
else:
    # running directly from ORT repo, so fbs bindings are under onnxruntime/core/flatbuffers
    ort_root = os.path.abspath(os.path.join(script_dir, "..", "..", "..", ".."))
    ort_fbs_py_parent_dir = os.path.join(ort_root, "onnxruntime", "core", "flatbuffers")

sys.path.append(ort_fbs_py_parent_dir)

from .operator_type_usage_processors import (  # noqa: E402
    GloballyAllowedTypesOpTypeImplFilter,  # noqa: F401
    OperatorTypeUsageManager,  # noqa: F401
    OpTypeImplFilterInterface,  # noqa: F401
)
from .ort_model_processor import OrtFormatModelProcessor  # noqa: E402, F401
from .utils import create_config_from_models  # noqa: E402, F401
