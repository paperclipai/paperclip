# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

import torch
from torch._C._onnx import OperatorExportTypes

TrainingMode = torch.onnx.TrainingMode
from packaging.version import Version  # noqa: E402


def torch_onnx_export(
    model,
    args,
    f,
    export_params=True,
    verbose=False,
    training=TrainingMode.EVAL,
    input_names=None,
    output_names=None,
    operator_export_type=OperatorExportTypes.ONNX,
    opset_version=None,
    _retain_param_name=None,
    do_constant_folding=True,
    example_outputs=None,
    strip_doc_string=None,
    dynamic_axes=None,
    keep_initializers_as_inputs=None,
    custom_opsets=None,
    enable_onnx_checker=None,
    use_external_data_format=None,
    export_modules_as_functions=False,
):
    if Version(torch.__version__) >= Version("1.11.0"):
        torch.onnx.export(
            model=model,
            args=args,
            f=f,
            export_params=export_params,
            verbose=verbose,
            training=training,
            input_names=input_names,
            output_names=output_names,
            operator_export_type=operator_export_type,
            opset_version=opset_version,
            do_constant_folding=do_constant_folding,
            dynamic_axes=dynamic_axes,
            keep_initializers_as_inputs=keep_initializers_as_inputs,
            custom_opsets=custom_opsets,
            export_modules_as_functions=export_modules_as_functions,
            dynamo=False,
        )
    else:
        torch.onnx.export(
            model=model,
            args=args,
            f=f,
            export_params=export_params,
            verbose=verbose,
            training=training,
            input_names=input_names,
            output_names=output_names,
            operator_export_type=operator_export_type,
            opset_version=opset_version,
            _retain_param_name=_retain_param_name,
            do_constant_folding=do_constant_folding,
            example_outputs=example_outputs,
            strip_doc_string=strip_doc_string,
            dynamic_axes=dynamic_axes,
            keep_initializers_as_inputs=keep_initializers_as_inputs,
            custom_opsets=custom_opsets,
            enable_onnx_checker=enable_onnx_checker,
            use_external_data_format=use_external_data_format,
        )
