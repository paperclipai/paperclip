#!/usr/bin/env python3
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

import argparse
import os
import pathlib

import onnx


def optimize_qdq_model():
    parser = argparse.ArgumentParser(
        os.path.basename(__file__),
        description="Update a QDQ format ONNX model to ensure optimal performance when executed using ONNX Runtime.",
    )

    parser.add_argument("input_model", type=pathlib.Path, help="Provide path to ONNX model to update.")
    parser.add_argument("output_model", type=pathlib.Path, help="Provide path to write updated ONNX model to.")

    args = parser.parse_args()

    model = onnx.load(str(args.input_model.resolve(strict=True)))

    # run QDQ model optimizations here

    # Originally, the fixing up of DQ nodes with multiple consumers was implemented as one such optimization.
    # That was moved to an ORT graph transformer.
    print("As of ORT 1.15, the fixing up of DQ nodes with multiple consumers is done by an ORT graph transformer.")

    # There are no optimizations being run currently but we expect that there may be in the future.

    onnx.save(model, str(args.output_model.resolve()))


if __name__ == "__main__":
    optimize_qdq_model()
