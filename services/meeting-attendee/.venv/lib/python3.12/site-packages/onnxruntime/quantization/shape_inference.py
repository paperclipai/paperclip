# --------------------------------------------------------------------------
# Copyright (c) Microsoft, Intel Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------


import logging
import tempfile
import traceback
from pathlib import Path

import onnx

import onnxruntime
from onnxruntime.tools.symbolic_shape_infer import SymbolicShapeInference
from onnxruntime.transformers.onnx_utils import extract_raw_data_from_model, has_external_data

from .fusions import ReplaceUpsampleWithResize
from .onnx_model import ONNXModel
from .quant_utils import add_pre_process_metadata, save_and_reload_model_with_shape_infer

logger = logging.getLogger(__name__)


def quant_pre_process(
    input_model: str | Path | onnx.ModelProto | None = None,
    output_model_path: str | Path | None = None,
    skip_optimization: bool = False,
    skip_onnx_shape: bool = False,
    skip_symbolic_shape: bool = False,
    auto_merge: bool = False,
    int_max: int = 2**31 - 1,
    guess_output_rank: bool = False,
    verbose: int = 0,
    save_as_external_data: bool = False,
    all_tensors_to_one_file: bool = False,
    external_data_location: str | None = None,
    external_data_size_threshold: int = 1024,
    **deprecated_kwargs,
) -> None:
    """Shape inference and model optimization, in preparation for quantization.

    Args:
        input_model: Path to the input model file or ModelProto
        output_model_path: Path to the output model file
        skip_optimization: Skip model optimization step if true. This may result in ONNX shape
            inference failure for some models.
        skip_onnx_shape: Skip ONNX shape inference. Symbolic shape inference is most effective
            with transformer based models. Skipping all shape inferences may
            reduce the effectiveness of quantization, as a tensor with unknown
            shape can not be quantized.
        skip_symbolic_shape: Skip symbolic shape inference. Symbolic shape inference is most
            effective with transformer based models. Skipping all shape
            inferences may reduce the effectiveness of quantization, as a tensor
            with unknown shape can not be quantized.
        auto_merge: For symbolic shape inference, automatically merge symbolic dims when
            conflict happens.
        int_max: For symbolic shape inference, specify the maximum value for integer to be
            treated as boundless for ops like slice
        guess_output_rank: Guess output rank to be the same as input 0 for unknown ops
        verbose: Logs detailed info of inference, 0: turn off, 1: warnings, 3: detailed
        save_as_external_data: Saving an ONNX model to external data
        all_tensors_to_one_file: Saving all the external data to one file
        external_data_location: The file location to save the external file
        external_data_size_threshold: The size threshold for external data
    """

    if input_model is None:
        input_model = deprecated_kwargs.pop("input_model_path", None)
    assert input_model is not None

    assert output_model_path is not None, "output_model_path is required."

    with tempfile.TemporaryDirectory(prefix="pre.quant.") as quant_tmp_dir:
        temp_path = Path(quant_tmp_dir)
        model = input_model if isinstance(input_model, onnx.ModelProto) else onnx.load(input_model)

        # Since Upsample is deprecated after opset v10, and the model's opset will
        # be upgraded to at least v11 during quantization, we need to replace Upsample
        # with Resize first to avoid generating an invalid model.
        ai_onnx_domain = [opset for opset in model.opset_import if not opset.domain or opset.domain == "ai.onnx"]
        if len(ai_onnx_domain) == 1:
            opset_version = ai_onnx_domain[0].version
            if opset_version <= 10:
                ReplaceUpsampleWithResize(ONNXModel(model), opset_version).apply()
                model = onnx.version_converter.convert_version(model, 11)
                model = save_and_reload_model_with_shape_infer(model)

        if not skip_symbolic_shape:
            logger.info("Performing symbolic shape inference...")
            model = SymbolicShapeInference.infer_shapes(
                model,
                int_max,
                auto_merge,
                guess_output_rank,
                verbose,
            )

        if not skip_optimization:
            # Use ORT optimizers (native code) to optimize model
            if not skip_symbolic_shape:
                # Need to save the inferenced model to file so as to run the optimizer
                input_model = str(temp_path / "symbolic_shape_inferred.onnx")
                if save_as_external_data:
                    onnx.save_model(
                        model,
                        input_model,
                        save_as_external_data=True,
                        all_tensors_to_one_file=all_tensors_to_one_file,
                        size_threshold=external_data_size_threshold,
                        convert_attribute=False,
                    )
                else:
                    onnx.save(model, input_model)
                model = None

            opt_model_path = str(temp_path / "optimized.onnx")
            try:
                sess_option = onnxruntime.SessionOptions()
                sess_option.optimized_model_filepath = opt_model_path
                sess_option.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_BASIC
                # For large model, extract external data from model and add to session options
                if isinstance(input_model, onnx.ModelProto):
                    if has_external_data(input_model):
                        raise ValueError(
                            "ModelProto has external data not loaded into memory, ORT cannot create session. "
                            "Please load external data before calling this function. "
                            "See https://onnx.ai/onnx/repo-docs/ExternalData.html for more information."
                        )
                    external_names, external_values = extract_raw_data_from_model(input_model)
                    sess_option.add_external_initializers(list(external_names), list(external_values))
                    input_model = input_model.SerializeToString()
                # the saved optimized model otherwise points to the original external data file name
                # which is not available relative to the optimized model file
                elif skip_symbolic_shape and save_as_external_data:
                    sess_option.add_session_config_entry(
                        "session.optimized_model_external_initializers_file_name", "optimized.onnx.data"
                    )

                sess = onnxruntime.InferenceSession(input_model, sess_option, providers=["CPUExecutionProvider"])
                # Close the session to avoid the cleanup error on Windows for temp folders
                # https://github.com/microsoft/onnxruntime/issues/17627
                del sess
            except Exception:
                logger.error(
                    "ONNX Runtime Model Optimization Failed! Consider rerun with option `--skip_optimization'."
                )
                logger.error(traceback.format_exc())

            input_model = opt_model_path

        if not skip_onnx_shape:
            # ONNX shape inference.
            # According to docs, infer_shapes_path should be used for 2G+ models.
            # If the skip optimization is specified, we could be dealing with a
            # large model. So be on the safe side, save the model
            if model is not None:
                input_model = str(temp_path / "symbolic_shape_inferred.onnx")
                if save_as_external_data:
                    onnx.save_model(
                        model,
                        input_model,
                        save_as_external_data=True,
                        all_tensors_to_one_file=all_tensors_to_one_file,
                        size_threshold=external_data_size_threshold,
                        convert_attribute=False,
                    )
                else:
                    onnx.save(model, input_model)
                model = None

            if isinstance(input_model, onnx.ModelProto):
                input_model = str(Path(quant_tmp_dir) / "model_input.onnx")
                onnx.save_model(
                    model,
                    input_model,
                    save_as_external_data=True,
                    all_tensors_to_one_file=all_tensors_to_one_file,
                    size_threshold=external_data_size_threshold,
                    convert_attribute=False,
                )

            inferred_model_path = str(temp_path / "onnx_shape_inferred.onnx")
            onnx.shape_inference.infer_shapes_path(input_model, inferred_model_path)
            model = onnx.load(inferred_model_path)

    if model is None:
        model = input_model if isinstance(input_model, onnx.ModelProto) else onnx.load(input_model)

    add_pre_process_metadata(model)

    if save_as_external_data:
        onnx.save_model(
            model,
            output_model_path,
            save_as_external_data=True,
            all_tensors_to_one_file=all_tensors_to_one_file,
            location=external_data_location,
            size_threshold=external_data_size_threshold,
            convert_attribute=False,
        )
    else:
        onnx.save(model, output_model_path)
