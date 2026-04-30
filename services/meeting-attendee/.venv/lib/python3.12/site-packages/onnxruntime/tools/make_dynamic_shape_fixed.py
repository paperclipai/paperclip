#!/usr/bin/env python3
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.
from __future__ import annotations

import argparse
import os
import pathlib
import sys

import onnx

from .onnx_model_utils import fix_output_shapes, make_dim_param_fixed, make_input_shape_fixed


def make_dynamic_shape_fixed_helper():
    parser = argparse.ArgumentParser(
        f"{os.path.basename(__file__)}:{make_dynamic_shape_fixed_helper.__name__}",
        description="""
                                     Assign a fixed value to a dim_param or input shape
                                     Provide either dim_param and dim_value or input_name and input_shape.""",
    )

    parser.add_argument(
        "--dim_param", type=str, required=False, help="Symbolic parameter name. Provide dim_value if specified."
    )
    parser.add_argument(
        "--dim_value", type=int, required=False, help="Value to replace dim_param with in the model. Must be > 0."
    )
    parser.add_argument(
        "--input_name",
        type=str,
        required=False,
        help="Model input name to replace shape of. Provide input_shape if specified.",
    )
    parser.add_argument(
        "--input_shape",
        type=lambda x: [int(i) for i in x.split(",")],
        required=False,
        help="Shape to use for input_shape. Provide comma separated list for the shape. "
        "All values must be > 0. e.g. --input_shape 1,3,256,256",
    )

    parser.add_argument("input_model", type=pathlib.Path, help="Provide path to ONNX model to update.")
    parser.add_argument("output_model", type=pathlib.Path, help="Provide path to write updated ONNX model to.")

    args = parser.parse_args()

    if (
        (args.dim_param and args.input_name)
        or (not args.dim_param and not args.input_name)
        or (args.dim_param and (not args.dim_value or args.dim_value < 1))
        or (args.input_name and (not args.input_shape or any(value < 1 for value in args.input_shape)))
    ):
        print("Invalid usage.")
        parser.print_help()
        sys.exit(-1)

    model = onnx.load(str(args.input_model.resolve(strict=True)))

    if args.dim_param:
        make_dim_param_fixed(model.graph, args.dim_param, args.dim_value)
    else:
        make_input_shape_fixed(model.graph, args.input_name, args.input_shape)

    # update the output shapes to make them fixed if possible.
    fix_output_shapes(model)

    onnx.save(model, str(args.output_model.resolve()))


if __name__ == "__main__":
    make_dynamic_shape_fixed_helper()
