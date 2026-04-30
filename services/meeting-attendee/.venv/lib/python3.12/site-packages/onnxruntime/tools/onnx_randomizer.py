# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

# An offline standalone script to declassify an ONNX model by randomizing the tensor data in initializers.
# The ORT Performance may change especially on generative models.

import argparse
from pathlib import Path

import numpy as np
from onnx import load_model, numpy_helper, onnx_pb, save_model

# An experimental small value for differentiating shape data and weights.
# The tensor data with larger size can't be shape data.
# User may adjust this value as needed.
SIZE_THRESHOLD = 10


def graph_iterator(model, func):
    graph_queue = [model.graph]
    while graph_queue:
        graph = graph_queue.pop(0)
        func(graph)
        for node in graph.node:
            for attr in node.attribute:
                if attr.type == onnx_pb.AttributeProto.AttributeType.GRAPH:
                    assert isinstance(attr.g, onnx_pb.GraphProto)
                    graph_queue.append(attr.g)
                if attr.type == onnx_pb.AttributeProto.AttributeType.GRAPHS:
                    for g in attr.graphs:
                        assert isinstance(g, onnx_pb.GraphProto)
                        graph_queue.append(g)


def randomize_graph_initializer(graph):
    for i_tensor in graph.initializer:
        array = numpy_helper.to_array(i_tensor)
        # TODO: need to find a better way to differentiate shape data and weights.
        if array.size > SIZE_THRESHOLD:
            random_array = np.random.uniform(array.min(), array.max(), size=array.shape).astype(array.dtype)
            o_tensor = numpy_helper.from_array(random_array, i_tensor.name)
            i_tensor.CopyFrom(o_tensor)


def main():
    parser = argparse.ArgumentParser(description="Randomize the weights of an ONNX model")
    parser.add_argument("-m", type=str, required=True, help="input onnx model path")
    parser.add_argument("-o", type=str, required=True, help="output onnx model path")
    parser.add_argument(
        "--use_external_data_format",
        required=False,
        action="store_true",
        help="Store or Save in external data format",
    )
    parser.add_argument(
        "--all_tensors_to_one_file",
        required=False,
        action="store_true",
        help="Save all tensors to one file",
    )
    args = parser.parse_args()

    data_path = None
    if args.use_external_data_format:
        if Path(args.m).parent == Path(args.o).parent:
            raise RuntimeError("Please specify output directory with different parent path to input directory.")
        if args.all_tensors_to_one_file:
            data_path = Path(args.o).name + ".data"

    Path(args.o).parent.mkdir(parents=True, exist_ok=True)
    onnx_model = load_model(args.m, load_external_data=args.use_external_data_format)
    graph_iterator(onnx_model, randomize_graph_initializer)
    save_model(
        onnx_model,
        args.o,
        save_as_external_data=args.use_external_data_format,
        all_tensors_to_one_file=args.all_tensors_to_one_file,
        location=data_path,
    )


if __name__ == "__main__":
    main()
