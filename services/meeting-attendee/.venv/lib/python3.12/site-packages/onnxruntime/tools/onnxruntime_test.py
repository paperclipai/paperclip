# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
from __future__ import annotations

import argparse
import os
import sys
from timeit import default_timer as timer

import numpy as np

import onnxruntime as onnxrt

float_dict = {
    "tensor(float16)": "float16",
    "tensor(float)": "float32",
    "tensor(double)": "float64",
}

integer_dict = {
    "tensor(int32)": "int32",
    "tensor(int8)": "int8",
    "tensor(uint8)": "uint8",
    "tensor(int16)": "int16",
    "tensor(uint16)": "uint16",
    "tensor(int64)": "int64",
    "tensor(uint64)": "uint64",
}


def generate_feeds(sess, symbolic_dims: dict | None = None):
    feeds = {}
    symbolic_dims = symbolic_dims or {}
    for input_meta in sess.get_inputs():
        # replace any symbolic dimensions
        shape = []
        for dim in input_meta.shape:
            if not dim:
                # unknown dim
                shape.append(1)
            elif isinstance(dim, str):
                # symbolic dim. see if we have a value otherwise use 1
                if dim in symbolic_dims:
                    shape.append(int(symbolic_dims[dim]))
                else:
                    shape.append(1)
            else:
                shape.append(dim)

        if input_meta.type in float_dict:
            feeds[input_meta.name] = np.random.rand(*shape).astype(float_dict[input_meta.type])
        elif input_meta.type in integer_dict:
            feeds[input_meta.name] = np.random.uniform(high=1000, size=tuple(shape)).astype(
                integer_dict[input_meta.type]
            )
        elif input_meta.type == "tensor(bool)":
            feeds[input_meta.name] = np.random.randint(2, size=tuple(shape)).astype("bool")
        else:
            print(f"unsupported input type {input_meta.type} for input {input_meta.name}")
            sys.exit(-1)
    return feeds


# simple test program for loading onnx model, feeding all inputs and running the model num_iters times.
def run_model(
    model_path,
    num_iters=1,
    debug=None,
    profile=None,
    symbolic_dims=None,
    feeds=None,
    override_initializers=True,
):
    symbolic_dims = symbolic_dims or {}
    if debug:
        print(f"Pausing execution ready for debugger to attach to pid: {os.getpid()}")
        print("Press key to continue.")
        sys.stdin.read(1)

    sess_options = None
    if profile:
        sess_options = onnxrt.SessionOptions()
        sess_options.enable_profiling = True
        sess_options.profile_file_prefix = os.path.basename(model_path)

    sess = onnxrt.InferenceSession(
        model_path,
        sess_options=sess_options,
        providers=onnxrt.get_available_providers(),
    )
    meta = sess.get_modelmeta()

    if not feeds:
        feeds = generate_feeds(sess, symbolic_dims)

    if override_initializers:
        # Starting with IR4 some initializers provide default values
        # and can be overridden (available in IR4). For IR < 4 models
        # the list would be empty
        for initializer in sess.get_overridable_initializers():
            shape = [dim if dim else 1 for dim in initializer.shape]
            if initializer.type in float_dict:
                feeds[initializer.name] = np.random.rand(*shape).astype(float_dict[initializer.type])
            elif initializer.type in integer_dict:
                feeds[initializer.name] = np.random.uniform(high=1000, size=tuple(shape)).astype(
                    integer_dict[initializer.type]
                )
            elif initializer.type == "tensor(bool)":
                feeds[initializer.name] = np.random.randint(2, size=tuple(shape)).astype("bool")
            else:
                print(f"unsupported initializer type {initializer.type} for initializer {initializer.name}")
                sys.exit(-1)

    start = timer()
    for _i in range(num_iters):
        outputs = sess.run([], feeds)  # fetch all outputs
    end = timer()

    print(f"model: {meta.graph_name}")
    print(f"version: {meta.version}")
    print(f"iterations: {num_iters}")
    print(f"avg latency: {((end - start) * 1000) / num_iters} ms")

    if profile:
        trace_file = sess.end_profiling()
        print(f"trace file written to: {trace_file}")

    return 0, feeds, num_iters > 0 and outputs


def main():
    parser = argparse.ArgumentParser(description="Simple ONNX Runtime Test Tool.")
    parser.add_argument("model_path", help="model path")
    parser.add_argument(
        "num_iters",
        nargs="?",
        type=int,
        default=1000,
        help="model run iterations. default=1000",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="pause execution to allow attaching a debugger.",
    )
    parser.add_argument("--profile", action="store_true", help="enable chrome timeline trace profiling.")
    parser.add_argument(
        "--symbolic_dims",
        default={},
        type=lambda s: dict(x.split("=") for x in s.split(",")),
        help="Comma separated name=value pairs for any symbolic dimensions in the model input. "
        "e.g. --symbolic_dims batch=1,seqlen=5. "
        "If not provided, the value of 1 will be used for all symbolic dimensions.",
    )

    args = parser.parse_args()
    exit_code, _, _ = run_model(args.model_path, args.num_iters, args.debug, args.profile, args.symbolic_dims)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
