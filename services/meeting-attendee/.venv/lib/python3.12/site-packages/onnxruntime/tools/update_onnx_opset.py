#!/usr/bin/env python3
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

import argparse
import os
import pathlib

from .onnx_model_utils import update_onnx_opset


def update_onnx_opset_helper():
    parser = argparse.ArgumentParser(
        f"{os.path.basename(__file__)}:{update_onnx_opset_helper.__name__}",
        description="""
                                     Update the ONNX opset of the model.
                                     New opset must be later than the existing one.
                                     If not specified will update to opset 15.
                                     """,
    )

    parser.add_argument("--opset", type=int, required=False, default=15, help="ONNX opset to update to.")
    parser.add_argument("input_model", type=pathlib.Path, help="Provide path to ONNX model to update.")
    parser.add_argument("output_model", type=pathlib.Path, help="Provide path to write updated ONNX model to.")

    args = parser.parse_args()
    update_onnx_opset(args.input_model, args.opset, args.output_model)


if __name__ == "__main__":
    update_onnx_opset_helper()
