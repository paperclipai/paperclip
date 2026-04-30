# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.  See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------
# This script helps debugging parity issue for two same onnx models with fp16 and fp32 format
# Please build ORT with --cmake_extra_defines onnxruntime_DEBUG_NODE_INPUTS_OUTPUTS=ON

import math
import multiprocessing
import os
from pathlib import Path

import numpy
import torch
from benchmark_helper import create_onnxruntime_session
from gpt2_helper import Gpt2Helper
from onnx import TensorProto, numpy_helper

NON_ZERO_VALUE = str(1)
ZERO_VALUE = str(0)


def environ_setting_nodes(node_name_filter=None, node_type_filter=None):
    # Set I/O data as default
    os.environ["ORT_DEBUG_NODE_IO_DUMP_SHAPE_DATA"] = ZERO_VALUE
    os.environ["ORT_DEBUG_NODE_IO_DUMP_INPUT_DATA"] = NON_ZERO_VALUE
    os.environ["ORT_DEBUG_NODE_IO_DUMP_OUTPUT_DATA"] = NON_ZERO_VALUE
    if node_name_filter is not None:
        os.environ["ORT_DEBUG_NODE_IO_NAME_FILTER"] = node_name_filter
    elif node_type_filter is not None:
        os.environ["ORT_DEBUG_NODE_IO_OP_TYPE_FILTER"] = node_type_filter
    else:
        os.environ["ORT_DEBUG_NODE_IO_DUMPING_DATA_TO_FILES_FOR_ALL_NODES_IS_OK"] = NON_ZERO_VALUE


def environ_setting_paths(output_path):
    # Set dumping values to files as default
    os.environ["ORT_DEBUG_NODE_IO_DUMP_DATA_DESTINATION"] = "files"
    os.environ["ORT_DEBUG_NODE_IO_OUTPUT_DIR"] = output_path


def environ_reset():
    for flag in [
        "ORT_DEBUG_NODE_IO_DUMP_SHAPE_DATA",
        "ORT_DEBUG_NODE_IO_DUMP_INPUT_DATA",
        "ORT_DEBUG_NODE_IO_DUMP_OUTPUT_DATA",
        "ORT_DEBUG_NODE_IO_NAME_FILTER",
        "ORT_DEBUG_NODE_IO_OP_TYPE_FILTER",
        "ORT_DEBUG_NODE_IO_DUMP_DATA_TO_FILES",
        "ORT_DEBUG_NODE_IO_OUTPUT_DIR",
        "ORT_DEBUG_NODE_IO_DUMPING_DATA_TO_FILES_FOR_ALL_NODES_IS_OK",
    ]:
        if flag in os.environ:
            del os.environ[flag]


def inference(model_path, dummy_inputs, outputs_path, use_gpu):
    environ_reset()
    environ_setting_nodes()
    environ_setting_paths(outputs_path)
    session = create_onnxruntime_session(model_path, use_gpu, enable_all_optimization=False)
    Gpt2Helper.onnxruntime_inference(session, dummy_inputs)


def generate_outputs_files(model_path, dummy_inputs, outputs_path, use_gpu):
    dir_path = Path(outputs_path)
    if dir_path.exists() and dir_path.is_dir():
        import shutil  # noqa: PLC0415

        shutil.rmtree(outputs_path)
    dir_path.mkdir(parents=True, exist_ok=True)

    process = multiprocessing.Process(target=inference, args=(model_path, dummy_inputs, outputs_path, use_gpu))
    process.start()
    process.join()


def post_processing(outputs_path, outputs_path_other):
    # Compare outputs with e.g. fp16 and fp32
    record = {}
    if_close = {}

    import glob  # noqa: PLC0415

    for filename in glob.glob(os.path.join(outputs_path, "*.tensorproto")):
        filename_other = os.path.join(outputs_path_other, Path(filename).name)
        if not os.path.exists(filename_other):
            continue
        with open(filename, "rb") as f:
            tensor = TensorProto()
            tensor.ParseFromString(f.read())
            array = numpy_helper.to_array(tensor)
            with open(filename_other, "rb") as f:  # noqa: PLW2901
                tensor_other = TensorProto()
                tensor_other.ParseFromString(f.read())
                array_other = numpy_helper.to_array(tensor_other)
                if array_other.size == 0:
                    continue
                diff = numpy.average(numpy.abs(array_other - array) / (numpy.abs(array_other) + 1e-6))
                if math.isnan(diff):
                    continue
                record[Path(filename).name.split(".")[0]] = diff
                if_close[Path(filename).name.split(".")[0]] = numpy.allclose(array, array_other, rtol=1e-04, atol=1e-04)

    results = ["Node\tDiff\tClose"]
    for k, v in sorted(record.items(), key=lambda x: x[1], reverse=True):
        results.append(f"{k}\t{v}\t{if_close[k]}")
    for line in results:
        print(line)


if __name__ == "__main__":
    # Below example shows how to use this helper to investigate parity issue of gpt-2 fp32 and fp16 onnx model
    # Please build ORT with --cmake_extra_defines onnxruntime_DEBUG_NODE_INPUTS_OUTPUTS=ON !!
    multiprocessing.set_start_method("spawn")

    # Generate Inputs
    sequence_length = 8
    past_sequence_length = 8
    batch_size = 5
    dummy_inputs_fp16 = Gpt2Helper.get_dummy_inputs(
        batch_size,
        past_sequence_length,
        sequence_length,
        12,
        768,
        12,
        50257,
        device=torch.device("cpu"),
        float16=True,
    )
    dummy_inputs_fp32 = dummy_inputs_fp16.to_fp32()

    # Get GPT-2 model from huggingface using convert_to_onnx.py
    os.system("python convert_to_onnx.py -m gpt2 --output gpt2_fp32.onnx -o -p fp32 --use_gpu")
    os.system("python convert_to_onnx.py -m gpt2 --output gpt2_fp16.onnx -o -p fp16 --use_gpu")

    # Specify the directory to dump the node's I/O
    outputs_path_fp32_gpu = "./fp32_gpu"
    outputs_path_fp16_gpu = "./fp16_gpu"
    generate_outputs_files("./gpt2_fp32.onnx", dummy_inputs_fp32, outputs_path_fp32_gpu, use_gpu=True)
    generate_outputs_files("./gpt2_fp16.onnx", dummy_inputs_fp16, outputs_path_fp16_gpu, use_gpu=True)

    # Compare each node's I/O value and sort based on average rtol
    post_processing(outputs_path_fp16_gpu, outputs_path_fp32_gpu)
