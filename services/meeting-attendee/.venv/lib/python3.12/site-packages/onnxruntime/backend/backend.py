# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
"""
Implements ONNX's backend API.
"""

import os
import unittest

import packaging.version
from onnx import ModelProto, helper, version  # noqa: F401
from onnx.backend.base import Backend
from onnx.checker import check_model

from onnxruntime import InferenceSession, SessionOptions, get_available_providers, get_device
from onnxruntime.backend.backend_rep import OnnxRuntimeBackendRep


class OnnxRuntimeBackend(Backend):
    """
    Implements
    `ONNX's backend API <https://github.com/onnx/onnx/blob/main/docs/ImplementingAnOnnxBackend.md>`_
    with *ONNX Runtime*.
    The backend is mostly used when you need to switch between
    multiple runtimes with the same API.
    `Importing models from ONNX to Caffe2 <https://github.com/onnx/tutorials/blob/master/tutorials/OnnxCaffe2Import.ipynb>`_
    shows how to use *caffe2* as a backend for a converted model.
    Note: This is not the official Python API.
    """

    allowReleasedOpsetsOnly = bool(os.getenv("ALLOW_RELEASED_ONNX_OPSET_ONLY", "1") == "1")  # noqa: N815

    @classmethod
    def is_compatible(cls, model, device=None, **kwargs):
        """
        Return whether the model is compatible with the backend.

        :param model: unused
        :param device: None to use the default device or a string (ex: `'CPU'`)
        :return: boolean
        """
        if device is None:
            device = get_device()
        return cls.supports_device(device)

    @classmethod
    def is_opset_supported(cls, model):
        """
        Return whether the opset for the model is supported by the backend.
        When By default only released onnx opsets are allowed by the backend
        To test new opsets env variable ALLOW_RELEASED_ONNX_OPSET_ONLY should be set to 0

        :param model: Model whose opsets needed to be verified.
        :return: boolean and error message if opset is not supported.
        """
        if cls.allowReleasedOpsetsOnly:
            for opset in model.opset_import:
                domain = opset.domain if opset.domain else "ai.onnx"
                try:
                    key = (domain, opset.version)
                    if key not in helper.OP_SET_ID_VERSION_MAP:
                        error_message = (
                            "Skipping this test as only released onnx opsets are supported."
                            "To run this test set env variable ALLOW_RELEASED_ONNX_OPSET_ONLY to 0."
                            f" Got Domain '{domain}' version '{opset.version}'."
                        )
                        return False, error_message
                except AttributeError:
                    # for some CI pipelines accessing helper.OP_SET_ID_VERSION_MAP
                    # is generating attribute error. TODO investigate the pipelines to
                    # fix this error. Falling back to a simple version check when this error is encountered
                    if (domain == "ai.onnx" and opset.version > 12) or (domain == "ai.ommx.ml" and opset.version > 2):
                        error_message = (
                            "Skipping this test as only released onnx opsets are supported."
                            "To run this test set env variable ALLOW_RELEASED_ONNX_OPSET_ONLY to 0."
                            f" Got Domain '{domain}' version '{opset.version}'."
                        )
                        return False, error_message
        return True, ""

    @classmethod
    def supports_device(cls, device):
        """
        Check whether the backend is compiled with particular device support.
        In particular it's used in the testing suite.
        """
        if device == "CUDA":
            device = "GPU"
        return "-" + device in get_device() or device + "-" in get_device() or device == get_device()

    @classmethod
    def prepare(cls, model, device=None, **kwargs):
        """
        Load the model and creates a :class:`onnxruntime.InferenceSession`
        ready to be used as a backend.

        :param model: ModelProto (returned by `onnx.load`),
            string for a filename or bytes for a serialized model
        :param device: requested device for the computation,
            None means the default one which depends on
            the compilation settings
        :param kwargs: see :class:`onnxruntime.SessionOptions`
        :return: :class:`onnxruntime.InferenceSession`
        """
        if isinstance(model, OnnxRuntimeBackendRep):
            return model
        elif isinstance(model, InferenceSession):
            return OnnxRuntimeBackendRep(model)
        elif isinstance(model, (str, bytes)):
            options = SessionOptions()
            for k, v in kwargs.items():
                if hasattr(options, k):
                    setattr(options, k, v)

            excluded_providers = os.getenv("ORT_ONNX_BACKEND_EXCLUDE_PROVIDERS", default="").split(",")
            providers = [x for x in get_available_providers() if (x not in excluded_providers)]

            inf = InferenceSession(model, sess_options=options, providers=providers)
            # backend API is primarily used for ONNX test/validation. As such, we should disable session.run() fallback
            # which may hide test failures.
            inf.disable_fallback()
            if device is not None and not cls.supports_device(device):
                raise RuntimeError(f"Incompatible device expected '{device}', got '{get_device()}'")
            return cls.prepare(inf, device, **kwargs)
        else:
            # type: ModelProto
            # check_model serializes the model anyways, so serialize the model once here
            # and reuse it below in the cls.prepare call to avoid an additional serialization
            # only works with onnx >= 1.10.0 hence the version check
            onnx_version = packaging.version.parse(version.version) or packaging.version.Version("0")
            onnx_supports_serialized_model_check = onnx_version.release >= (1, 10, 0)
            bin_or_model = model.SerializeToString() if onnx_supports_serialized_model_check else model
            check_model(bin_or_model)
            opset_supported, error_message = cls.is_opset_supported(model)
            if not opset_supported:
                raise unittest.SkipTest(error_message)
            # Now bin might be serialized, if it's not we need to serialize it otherwise we'll have
            # an infinite recursive call
            bin = bin_or_model
            if not isinstance(bin, (str, bytes)):
                bin = bin.SerializeToString()
            return cls.prepare(bin, device, **kwargs)

    @classmethod
    def run_model(cls, model, inputs, device=None, **kwargs):
        """
        Compute the prediction.

        :param model: :class:`onnxruntime.InferenceSession` returned
            by function *prepare*
        :param inputs: inputs
        :param device: requested device for the computation,
            None means the default one which depends on
            the compilation settings
        :param kwargs: see :class:`onnxruntime.RunOptions`
        :return: predictions
        """
        rep = cls.prepare(model, device, **kwargs)
        return rep.run(inputs, **kwargs)

    @classmethod
    def run_node(cls, node, inputs, device=None, outputs_info=None, **kwargs):
        """
        This method is not implemented as it is much more efficient
        to run a whole model than every node independently.
        """
        raise NotImplementedError("It is much more efficient to run a whole model than every node independently.")


is_compatible = OnnxRuntimeBackend.is_compatible
prepare = OnnxRuntimeBackend.prepare
run = OnnxRuntimeBackend.run_model
supports_device = OnnxRuntimeBackend.supports_device
