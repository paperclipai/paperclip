# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
from fusion_utils import NumpyHelper
from onnx import ModelProto, TensorProto
from onnx.external_data_helper import set_external_data
from onnx_model import OnnxModel

from onnxruntime import OrtValue


def extract_raw_data_from_model(model: ModelProto):
    """
    Extract external data from model and return the external data as a list of tuples (name, value).
    Note this function does not handle external data that is not loaded into the model as raw data.

    Args:
        model (ModelProto): the model proto to extract external data from.
    Returns:
        (external_names, external_values): a tuple of two lists of external data names and values.
    """
    external_data = []
    onnx_model = OnnxModel(model)
    for graph in onnx_model.graphs():
        for initializer in graph.initializer:
            name = initializer.name

            if initializer.HasField("raw_data"):
                numpy_tensor = NumpyHelper.to_array(initializer)
                ort_value = OrtValue.ortvalue_from_numpy(numpy_tensor)
                external_data.append((name, ort_value))
                # mimic set_external_data
                set_external_data(initializer, location="foo.bin")
                initializer.name = name
                initializer.ClearField("raw_data")

    return zip(*external_data, strict=False)


def has_external_data(model: ModelProto):
    """
    Check if the model has external data.

    Args:
        model (ModelProto): the model proto to check for external data.
    Returns:
        bool: True if the model has external data, False otherwise.
    """
    onnx_model = OnnxModel(model)
    for graph in onnx_model.graphs():
        for initializer in graph.initializer:
            if initializer.HasField("data_location") and initializer.data_location == TensorProto.EXTERNAL:
                return True
    return False
