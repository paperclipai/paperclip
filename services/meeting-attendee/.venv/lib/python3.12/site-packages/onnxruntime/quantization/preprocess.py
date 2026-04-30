# --------------------------------------------------------------------------
# Copyright (c) Microsoft, Intel Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------

import argparse
import logging
import sys

from .shape_inference import quant_pre_process

logger = logging.getLogger(__name__)


def parse_arguments():
    parser = argparse.ArgumentParser(
        description="""Model optimizer and shape inferencer, in preparation for quantization,
Consists of three optional steps:
1. Symbolic shape inference (best for transformer models).
2. Model optimization.
3. ONNX shape inference.

Model quantization with QDQ format, i.e. inserting QuantizeLinear/DeQuantizeLinear on
the tensor, requires tensor shape information to perform its best. Currently, shape inferencing
works best with optimized model. As a result, it is highly recommended to run quantization
on optimized model with shape information. This is the tool for optimization and shape
inferencing.

Essentially this tool performs the following three (skippable) steps:

1. Symbolic shape inference.
2. Model optimization
3. ONNX shape inference"""
    )

    parser.add_argument("--input", required=True, help="Path to the input model file")
    parser.add_argument("--output", required=True, help="Path to the output model file")
    parser.add_argument(
        "--skip_optimization",
        type=bool,
        default=False,
        help="Skip model optimization step if true. It's a known issue that ORT"
        " optimization has difficulty with model size greater than 2GB, rerun with"
        " this option to get around this issue.",
    )
    parser.add_argument(
        "--skip_onnx_shape",
        type=bool,
        default=False,
        help="Skip ONNX shape inference. Symbolic shape inference is most effective"
        " with transformer based models. Skipping all shape inferences may"
        " reduce the effectiveness of quantization, as a tensor with unknown"
        " shape can not be quantized.",
    )
    parser.add_argument(
        "--skip_symbolic_shape",
        type=bool,
        default=False,
        help="Skip symbolic shape inference. Symbolic shape inference is most"
        " effective with transformer based models. Skipping all shape"
        " inferences may reduce the effectiveness of quantization, as a tensor"
        " with unknown shape can not be quantized.",
    )
    parser.add_argument(
        "--auto_merge",
        help="Automatically merge symbolic dims when confliction happens",
        action="store_true",
        default=False,
    )
    parser.add_argument(
        "--int_max",
        help="maximum value for integer to be treated as boundless for ops like slice",
        type=int,
        default=2**31 - 1,
    )
    parser.add_argument(
        "--guess_output_rank",
        help="guess output rank to be the same as input 0 for unknown ops",
        action="store_true",
        default=False,
    )
    parser.add_argument(
        "--verbose",
        help="Prints detailed logs of inference, 0: turn off, 1: warnings, 3: detailed",
        type=int,
        default=0,
    )
    parser.add_argument(
        "--save_as_external_data",
        help="Saving an ONNX model to external data",
        action="store_true",
        default=False,
    )
    parser.add_argument(
        "--all_tensors_to_one_file",
        help="Saving all the external data to one file",
        action="store_true",
        default=False,
    )
    parser.add_argument(
        "--external_data_location",
        help="The file location to save the external file",
        default=None,
    )
    parser.add_argument(
        "--external_data_size_threshold",
        help="The size threshold for external data",
        type=int,
        default=1024,
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_arguments()
    if args.skip_optimization and args.skip_onnx_shape and args.skip_symbolic_shape:
        logger.error("Skipping all three steps, nothing to be done. Quitting...")
        sys.exit()

    if (not args.skip_optimization) and args.save_as_external_data:
        logger.error("ORT model optimization does not support external data yet!")
        sys.exit()

    logger.info("input model: %s", args.input)
    logger.info("output model: %s", args.output)
    quant_pre_process(
        args.input,
        args.output,
        args.skip_optimization,
        args.skip_onnx_shape,
        args.skip_symbolic_shape,
        args.auto_merge,
        args.int_max,
        args.guess_output_rank,
        args.verbose,
        args.save_as_external_data,
        args.all_tensors_to_one_file,
        args.external_data_location,
        args.external_data_size_threshold,
    )
