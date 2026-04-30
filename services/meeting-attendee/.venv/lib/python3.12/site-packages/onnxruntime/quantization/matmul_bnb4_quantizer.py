# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------

import argparse
import logging
import os

import numpy as np
import numpy.typing as npt
import onnx
from onnx.onnx_pb import GraphProto, ModelProto, NodeProto, TensorProto

from onnxruntime.capi._pybind_state import quantize_matmul_bnb4

from .onnx_model import ONNXModel
from .quant_utils import attribute_to_kwarg

logger = logging.getLogger(__name__)


class MatMulBnb4Quantizer:
    """Perform 4b quantization of constant MatMul weights using FP4 or NF4 data type"""

    ##################
    # quantization types, must be consistent with native code type
    # Bnb_DataType_t defined in blockwise_quant_block_bnb4.h

    # 4b floating point with bias of 3
    FP4 = 0

    # 4b NormalFloat
    NF4 = 1

    def __init__(self, model: ModelProto, quant_type: int, block_size: int, nodes_to_exclude=None):
        nodes_to_exclude = nodes_to_exclude or []
        assert quant_type in [MatMulBnb4Quantizer.FP4, MatMulBnb4Quantizer.NF4]
        self.model = ONNXModel(model)
        self.quant_type = quant_type
        self.block_size = block_size
        self.nodes_to_exclude = set(nodes_to_exclude)

    @staticmethod
    def __get_initializer(name, graph_path: list[GraphProto]) -> tuple[TensorProto, GraphProto]:
        for gid in range(len(graph_path) - 1, -1, -1):
            graph = graph_path[gid]
            for tensor in graph.initializer:
                if tensor.name == name:
                    return tensor, graph
        return None, None

    def bnb4_block_quant(self, fpweight: npt.ArrayLike) -> np.ndarray:
        """4b quantize fp32/fp16 weight"""

        if len(fpweight.shape) != 2:
            raise ValueError("Current bnb4 block quantization only supports 2D tensors!")
        # need to copy since the transposed weight still has the original memory layout
        # Linear4bit quantizes its weight data which is the transposed weight
        fpweight_t = fpweight.transpose().copy()

        rows, cols = fpweight.shape
        numel = rows * cols
        block_size = self.block_size
        num_blocks = (numel + block_size - 1) // block_size
        quantized_numel = (numel + 1) // 2

        packed = np.zeros(quantized_numel, dtype="uint8")
        absmax = np.zeros(num_blocks, dtype=fpweight.dtype)
        # block wise quantization, fpweight_t is flattened and divided into blocks
        quantize_matmul_bnb4(packed, fpweight_t, absmax, block_size, self.quant_type, cols, rows)

        return (packed, absmax)

    def _bnb4_matmul_node_weight(self, node: NodeProto, graph_stack: list[GraphProto]) -> NodeProto:
        """If the node is MatMul with fp32 const weight, quantize the weight with int4, and return the new node"""

        if node.op_type != "MatMul":
            return node  # only care about MatMul for now

        logger.debug(f"start to quantize {node.name} ...")
        if node.name in self.nodes_to_exclude:
            logger.debug(f"exclude to quantize {node.name} as specified by nodes_to_exclude...")
            return node

        inputB = node.input[1]  # noqa: N806
        B, Bs_graph = MatMulBnb4Quantizer.__get_initializer(inputB, graph_stack)  # noqa: N806
        if B is None:
            logger.debug("MatMul doesn't have const weight. Skip to quantize")
            return node  # only care about constant weight

        B_array = onnx.numpy_helper.to_array(B)  # noqa: N806
        if len(B_array.shape) != 2:
            logger.debug("MatMul weight is not 2D. Skip to quantize")
            return node  # can only process 2-D matrix

        packed, absmax = self.bnb4_block_quant(B_array)
        B_quant = onnx.numpy_helper.from_array(packed)  # noqa: N806
        B_quant.name = B.name + "_Bnb4"
        for input in Bs_graph.input:
            if input.name == inputB:
                Bs_graph.input.remove(input)
                break

        absmax_tensor = onnx.numpy_helper.from_array(absmax)
        absmax_tensor.name = B.name + "_absmax"

        Bs_graph.initializer.extend([B_quant, absmax_tensor])

        kwargs = {}
        rows, cols = B_array.shape
        kwargs["K"] = rows
        kwargs["N"] = cols
        kwargs["block_size"] = self.block_size
        kwargs["quant_type"] = self.quant_type

        matmul_bnb4_node = onnx.helper.make_node(
            "MatMulBnb4",
            inputs=[node.input[0], B_quant.name, absmax_tensor.name],
            outputs=[node.output[0]],
            name=node.name + "_Bnb4" if node.name else "",
            domain="com.microsoft",
            **kwargs,
        )

        logger.debug(f"complete quantization of {node.name} ...")

        return matmul_bnb4_node

    def _process_subgraph(self, graph_stack: list[GraphProto]):
        new_nodes = []
        graph = graph_stack[-1]

        for node in graph.node:
            graph_attrs = [
                attr
                for attr in node.attribute
                if attr.type == onnx.AttributeProto.GRAPH or attr.type == onnx.AttributeProto.GRAPHS
            ]
            if graph_attrs:
                kwargs = {}
                for attr in node.attribute:
                    if attr.type == onnx.AttributeProto.GRAPH:
                        # recursive call to take care of sub-graph
                        graph_stack.append(attr.g)
                        kv = {attr.name: self._process_subgraph(graph_stack)}
                    elif attr.type == onnx.AttributeProto.GRAPHS:
                        value = []
                        for subgraph in attr.graphs:
                            # recursive call to take care of sub-graph
                            graph_stack.append(subgraph)
                            value.extend([self._process_subgraph(graph_stack)])
                        kv = {attr.name: value}
                    else:
                        kv = attribute_to_kwarg(attr)
                    kwargs.update(kv)
                node = onnx.helper.make_node(  # noqa: PLW2901
                    node.op_type, node.input, node.output, name=node.name, **kwargs
                )

            new_nodes.append(self._bnb4_matmul_node_weight(node, graph_stack))

        graph.ClearField("node")
        graph.node.extend(new_nodes)
        graph_stack.pop()
        return graph

    def process(self):
        # use a stack to keep track of sub-graphs
        graph_stack = [self.model.graph()]
        opset_import = self.model.opset_import()

        has_ms_domain = False
        for opset in opset_import:
            if opset.domain == "com.microsoft":
                has_ms_domain = True
        if not has_ms_domain:
            opset_import.extend([onnx.helper.make_opsetid("com.microsoft", 1)])

        self._process_subgraph(graph_stack)
        self.model.clean_initializers()


def parse_args():
    parser = argparse.ArgumentParser(
        description="""Blockwise FP4/NF4 quantization for MatMul 2D weight matrices.

A weight matrix is partitioned into blocks, where each block is a contiguous
subset inside the flattened transposed weight matrix. Each block is quantized
into a set of 4b integers with an absolute value scaling factor.
"""
    )

    parser.add_argument("--input_model", required=True, help="Path to the input model file")
    parser.add_argument("--output_model", required=True, help="Path to the output model file")
    parser.add_argument(
        "--quant_type",
        required=False,
        default=1,
        choices=[MatMulBnb4Quantizer.FP4, MatMulBnb4Quantizer.NF4],
        help="Quantization data type. 0: FP4, 1: NF4",
    )
    parser.add_argument(
        "--block_size",
        required=False,
        default=64,
        help="Block size for blockwise quantization. Note: bnb.nn.Linear4bit only uses block_size=64",
    )
    parser.add_argument("-v", "--verbose", required=False, action="store_true")
    parser.set_defaults(verbose=False)
    parser.add_argument(
        "--nodes_to_exclude",
        nargs="+",
        type=str,
        required=False,
        default=[],
        help="Specify the nodes to be excluded from quantization with node names",
    )

    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    if args.verbose:
        logger.setLevel(logging.DEBUG)

    input_model_path = args.input_model
    output_model_path = args.output_model

    if os.path.exists(output_model_path):
        logger.error(f"file {output_model_path} already exists")
        raise Exception(f"file {output_model_path} already exists")

    model = onnx.load(input_model_path)
    quant = MatMulBnb4Quantizer(model, args.quant_type, args.block_size, nodes_to_exclude=args.nodes_to_exclude)
    quant.process()
    quant.model.save_model_to_file(output_model_path, True)
