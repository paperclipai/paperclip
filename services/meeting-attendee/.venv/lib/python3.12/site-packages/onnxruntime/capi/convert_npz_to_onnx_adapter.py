# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

# This script helps converting .npz files to .onnx_adapter files

import argparse
import os
import sys

import numpy as np

import onnxruntime as ort


def get_args() -> argparse:
    parser = argparse.ArgumentParser()
    parser.add_argument("--npz_file_path", type=str, required=True)
    parser.add_argument("--output_file_path", type=str, required=True)
    parser.add_argument("--adapter_version", type=int, required=True)
    parser.add_argument("--model_version", type=int, required=True)
    return parser.parse_args()


def export_lora_parameters(
    npz_file_path: os.PathLike, adapter_version: int, model_version: int, output_file_path: os.PathLike
):
    """The function converts lora parameters in npz to onnx_adapter format"""
    adapter_format = ort.AdapterFormat()
    adapter_format.set_adapter_version(adapter_version)
    adapter_format.set_model_version(model_version)
    name_to_ort_value = {}
    with np.load(npz_file_path) as data:
        for name, np_arr in data.items():
            ort_value = ort.OrtValue.ortvalue_from_numpy(np_arr)
            name_to_ort_value[name] = ort_value

    adapter_format.set_parameters(name_to_ort_value)
    adapter_format.export_adapter(output_file_path)


def main() -> int:
    args = get_args()
    export_lora_parameters(args.npz_file_path, args.adapter_version, args.model_version, args.output_file_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
