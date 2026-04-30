# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
import tensorrt as trt

TRT_LOGGER = trt.Logger(trt.Logger.ERROR)


def init_trt_plugins():
    # Register TensorRT plugins
    trt.init_libnvinfer_plugins(TRT_LOGGER, "")
