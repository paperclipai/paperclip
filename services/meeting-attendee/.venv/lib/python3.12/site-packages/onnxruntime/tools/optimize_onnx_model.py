#!/usr/bin/env python3
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.
from __future__ import annotations

import argparse
import os
import pathlib

from .onnx_model_utils import get_optimization_level, optimize_model


def optimize_model_helper():
    parser = argparse.ArgumentParser(
        f"{os.path.basename(__file__)}:{optimize_model_helper.__name__}",
        description="""
                                     Optimize an ONNX model using ONNX Runtime to the specified level.
                                     See https://onnxruntime.ai/docs/performance/model-optimizations/graph-optimizations.html for more
                                     details of the optimization levels.""",
    )

    parser.add_argument(
        "--opt_level",
        default="basic",
        choices=["disable", "basic", "extended", "layout", "all"],
        help="Optimization level to use.",
    )
    parser.add_argument(
        "--log_level",
        choices=["debug", "info", "warning", "error"],
        type=str,
        required=False,
        default="error",
        help="Log level. Defaults to Error so we don't get output about unused initializers "
        "being removed. Warning or Info may be desirable in some scenarios.",
    )

    parser.add_argument("input_model", type=pathlib.Path, help="Provide path to ONNX model to update.")
    parser.add_argument("output_model", type=pathlib.Path, help="Provide path to write optimized ONNX model to.")

    args = parser.parse_args()

    if args.log_level == "error":
        log_level = 3
    elif args.log_level == "debug":
        log_level = 0  # ORT verbose level
    elif args.log_level == "info":
        log_level = 1
    elif args.log_level == "warning":
        log_level = 2

    optimize_model(args.input_model, args.output_model, get_optimization_level(args.opt_level), log_level)


if __name__ == "__main__":
    optimize_model_helper()
