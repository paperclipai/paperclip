# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

from logging import getLogger

from fusion_base import Fusion
from fusion_utils import NumpyHelper
from onnx import NodeProto, TensorProto, helper
from onnx_model import OnnxModel

logger = getLogger(__name__)


class FusionGemmFastGelu(Fusion):
    def __init__(self, model: OnnxModel):
        super().__init__(model, "GemmFastGelu", "FastGelu", "GemmFastGelu")
        self.shape_infer = None
        self.shape_infer_done = False

    def get_dimensions_from_tensor_proto(self, tensor_proto: TensorProto) -> int | None:
        if tensor_proto.type.tensor_type.HasField("shape"):
            return len(tensor_proto.type.tensor_type.shape.dim)
        else:
            return None

    def get_dimensions(self, input_name: str) -> int | None:
        graph_input = self.model.find_graph_input(input_name)
        if graph_input:
            return self.get_dimensions_from_tensor_proto(graph_input)

        if not self.shape_infer_done:
            self.shape_infer = self.model.infer_runtime_shape(update=True)
            self.shape_infer_done = True

        if self.shape_infer is not None:
            return self.get_dimensions_from_tensor_proto(self.shape_infer.known_vi_[input_name])

        return None

    def fuse(
        self,
        node: NodeProto,
        input_name_to_nodes: dict[str, list[NodeProto]],
        output_name_to_node: dict[str, NodeProto],
    ):
        """
        This pattern is from PyTorch bert model
        Fuse MatMul with FastGelu into one node:

            [root] --> MatMul --> FastGelu -->

        """
        has_bias = False
        if len(node.input) == 2:
            has_bias = True

        match_nodes = self.model.match_parent_path(node, ["MatMul"], [0])
        if match_nodes is None:
            return
        matmul = match_nodes[0]

        # matmul input X should >= two dimension, input weight should be two dimension
        weight_index = -1
        x_dims = 0
        weight = None

        for i, input in enumerate(matmul.input):
            initializer = self.model.get_initializer(input)
            if initializer is None:
                x_dims = self.get_dimensions(matmul.input[i])
            else:
                weight_index = i
                weight = NumpyHelper.to_array(initializer)
        if weight is None:
            return
        if len(weight.shape) != 2:
            return
        if x_dims < len(weight.shape):
            return

        # bias weight should be one dimension
        bias_index = -1
        if has_bias:
            bias_weight = None
            for i, input in enumerate(node.input):
                initializer = self.model.get_initializer(input)
                if initializer is None:
                    continue
                bias_index = i
                bias_weight = NumpyHelper.to_array(initializer)
                break
            if bias_weight is None:
                return
            if len(bias_weight.shape) != 1:
                return

        subgraph_nodes = [node, matmul]
        if not self.model.is_safe_to_fuse_nodes(
            subgraph_nodes, [node.output[0]], input_name_to_nodes, output_name_to_node
        ):
            return

        self.nodes_to_remove.extend(subgraph_nodes)

        inputs = (
            [matmul.input[1 - weight_index], matmul.input[weight_index], node.input[bias_index]]
            if has_bias
            else [matmul.input[1 - weight_index], matmul.input[weight_index]]
        )

        fused_node = helper.make_node(
            "GemmFastGelu",
            inputs=inputs,
            outputs=node.output,
            name=self.model.create_node_name("GemmFastGelu"),
        )
        fused_node.domain = "com.microsoft"
        self.nodes_to_add.append(fused_node)
        self.node_name_to_graph_name[fused_node.name] = self.this_graph_name
