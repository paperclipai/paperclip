# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------
"""Provide entry point to preprocess ONNX model especially for QNN."""

import argparse
import pathlib

import onnx

from onnxruntime.quantization.execution_providers import qnn


def _parse_arguments():
    """Parse cmdline arguments."""
    parser = argparse.ArgumentParser(description="Arguments for QNN model preprocess.")

    parser.add_argument("--input_model_path", "-i", required=True, help="Path to the input ONNX model.")
    parser.add_argument("--output_model_path", "-o", required=True, help="Path to the output ONNX model.")

    # Save preprocessed model with external data.
    parser.add_argument(
        "--save_as_external_data",
        action="store_true",
        help="Whether the output model would be saved with external data.",
    )
    parser.add_argument(
        "--all_tensors_to_one_file",
        action="store_true",
        help="Whether to save all external data in one file or save each tensor to a file named with the tensor name.",
    )
    parser.add_argument(
        "--external_data_location",
        help="Filename of the external file where all tensors are saved. The path is relative to the model path.",
    )
    parser.add_argument(
        "--external_data_size_threshold",
        default=1024,
        type=int,
        help="Tensors with data size larger than this threshold are converted to external data.",
    )
    parser.add_argument(
        "--external_data_convert_attribute",
        action="store_true",
        help="Whether to save all tensors, including attribute tensors, to external data.",
    )

    # Preprocess options.
    parser.add_argument(
        "--fuse_layernorm",
        action="store_true",
        help="Whether to fuse matched sequences into LayerNormalization nodes if possible.",
    )

    # I/O layouts.
    parser.add_argument(
        "--inputs_to_make_channel_last",
        nargs="+",
        default=None,
        help="List of graph input names to be transposed into channel-last.",
    )

    parser.add_argument(
        "--outputs_to_make_channel_last",
        nargs="+",
        default=None,
        help="List of graph output names to be transposed into channel-last.",
    )

    # Fix dynamic input shapes.
    parser.add_argument(
        "--dynamic_input_shapes",
        nargs=2,
        action="append",
        type=str,
        default=None,
        help="Model input name and desired static shape in comma seprated format, for example: 'input' 1,3,256,256",
    )

    # Exclude initializer from input
    parser.add_argument(
        "--exclude_initializer_from_input",
        action="store_true",
        help="Whether to exclude initializer from input if model.ir_version >= 4",
    )

    return parser.parse_args()


def qnn_preprocess_model(
    model_input: str | pathlib.Path | onnx.ModelProto,
    model_output: str | pathlib.Path,
    fuse_layernorm: bool = False,
    save_as_external_data: bool = False,
    all_tensors_to_one_file: bool = False,
    external_data_location: str | None = None,
    external_data_size_threshold: int = 1024,
    external_data_convert_attribute: bool = False,
    inputs_to_make_channel_last: list[str] | None = None,
    outputs_to_make_channel_last: list[str] | None = None,
    dynamic_input_shapes: list[tuple[str, str]] | None = None,
    exclude_initializer_from_input: bool = False,
) -> bool:
    """Preprocess ONNX model for QNN.

    Args:
        model_input: A path or ONNX ModelProto specifiying the model to be preprocessed.
        model_output: A path specifying where the preprocessed model to be saved.
        fuse_layernorm: A bool specifying whether to fuse the matched sequence into a single LayerNormalization node.
            Defaults to False.
        save_as_external_data: A bool specifying whether to save model with external data. Defaults to False.
        all_tensors_to_one_file: A bool specifying whether to save all external data in one file or save each tensor to
            a file named with the tensor name. This argument is effective only when `save_as_external_data` is True.
            Defaults to False.
        external_data_location: A str specifying where to save the external data. The path is relative to the model
            path. This argument is effective only when `save_as_external_data` is True. Defaults to the model name.
        external_data_size_threshold: An int specifying the threshold of data size for tensors be saved as external
            data. This argument is effective only when `save_as_external_data` is True. Defaults to 1024.
        external_data_convert_attribute: A bool specifying whether to save all tensors including attributes as external
            data. This argument is effective only when `save_as_external_data` is True. Defaults to False.
        inputs_to_make_channel_last: A list of strs specifying graph input names to be transposed into channel-last.
            Defaults to None.
        outputs_to_make_channel_last: A list of strs specifying graph output names to be transposed into channel-last.
            Defaults to None.
        dynamic_input_shapes: A list of tuples specifying model input name to and its static shape in comma seprated
            format, for example: [('input', '1,3,256,256')]. Defaults to None.
        exclude_initializer_from_input: A bool specifying whether to exclude initializer from input. Defaults to False.

    Returns:
        A bool indicating whether the model is modified.
    """
    return qnn.qnn_preprocess_model(
        model_input,
        model_output,
        fuse_layernorm=fuse_layernorm,
        save_as_external_data=save_as_external_data,
        all_tensors_to_one_file=all_tensors_to_one_file,
        external_data_location=external_data_location,
        external_data_size_threshold=external_data_size_threshold,
        external_data_convert_attribute=external_data_convert_attribute,
        inputs_to_make_channel_last=inputs_to_make_channel_last,
        outputs_to_make_channel_last=outputs_to_make_channel_last,
        dynamic_input_shapes=dynamic_input_shapes,
        exclude_initializer_from_input=exclude_initializer_from_input,
    )


if __name__ == "__main__":
    args = _parse_arguments()
    qnn_preprocess_model(
        args.input_model_path,
        args.output_model_path,
        fuse_layernorm=args.fuse_layernorm,
        save_as_external_data=args.save_as_external_data,
        all_tensors_to_one_file=args.all_tensors_to_one_file,
        external_data_location=args.external_data_location,
        external_data_size_threshold=args.external_data_size_threshold,
        external_data_convert_attribute=args.external_data_convert_attribute,
        inputs_to_make_channel_last=args.inputs_to_make_channel_last,
        outputs_to_make_channel_last=args.outputs_to_make_channel_last,
        dynamic_input_shapes=args.dynamic_input_shapes,
        exclude_initializer_from_input=args.exclude_initializer_from_input,
    )
