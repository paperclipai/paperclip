# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

from logging import getLogger

from fusion_base import Fusion
from fusion_utils import FusionUtils
from onnx import helper
from onnx_model import OnnxModel

logger = getLogger(__name__)


class FusionQOrderedMatMul(Fusion):
    def __init__(self, model: OnnxModel):
        super().__init__(model, "QOrderedMatMul", "MatMul")

    def fuse(self, node, input_name_to_nodes: dict, output_name_to_node: dict):
        matmul_children = self.model.get_children(node, input_name_to_nodes)

        # Should only have 1 child - Bias Add
        if len(matmul_children) != 1 or matmul_children[0].op_type != "Add":
            return

        bias_add_node = matmul_children[0]

        # Atleast one of the inputs to Bias Add node must be a constant
        bias_add_node_index = 0
        if (
            self.model.get_constant_value(bias_add_node.input[0]) is None
            and self.model.get_constant_value(bias_add_node.input[1]) is None
        ):
            return

        if self.model.get_constant_value(bias_add_node.input[0]) is None:
            bias_add_node_index = 1

        bias_add_children = self.model.get_children(bias_add_node, input_name_to_nodes)

        if len(bias_add_children) != 1:
            return

        bias_add_child = bias_add_children[0]

        # Bias Add can have another Add downstream (Residual Add layer)
        residual_add_node = None

        downstream_quantize_node = None

        if bias_add_child.op_type == "Add":
            residual_add_node = bias_add_child

            residual_add_children = self.model.get_children(residual_add_node, input_name_to_nodes)

            if len(residual_add_children) != 1 or residual_add_children[0].op_type != "QuantizeLinear":
                return

            downstream_quantize_node = residual_add_children[0]

        elif bias_add_child.op_type == "QuantizeLinear":
            downstream_quantize_node = bias_add_child

        else:
            return

        # Make sure the downstream QuantizeLinear has the proper zero points and scales
        if not FusionUtils.check_qdq_node_for_fusion(downstream_quantize_node, self.model):
            return

        # The first input to MatMul should flow through a DequantizeLinear node
        first_path_id, first_input_parent_nodes, _ = self.model.match_parent_paths(
            node,
            [(["DequantizeLinear"], [0])],
            output_name_to_node,
        )

        # If Attention is not fused, this is the pattern to look for
        # leading upto the MatMul
        reshape_node_0 = None
        transpose_node_0 = None
        if first_path_id < 0:
            first_path_id, first_input_parent_nodes, _ = self.model.match_parent_paths(
                node,
                [(["Reshape", "Transpose", "DequantizeLinear", "QuantizeLinear"], [0, 0, 0, 0])],
                output_name_to_node,
            )

            if first_path_id < 0:
                return

            reshape_node_0 = first_input_parent_nodes[0]
            transpose_node_0 = first_input_parent_nodes[1]
            dequantize_node_0 = first_input_parent_nodes[2]
        else:
            dequantize_node_0 = first_input_parent_nodes[0]

        # Make sure the upstream DequantizeLinear-0 has the proper zero points and scales
        if not FusionUtils.check_qdq_node_for_fusion(dequantize_node_0, self.model):
            return

        # The second input to MatMul should flow through a DequantizeLinear node
        dequantize_node_1 = None
        is_weight_transpose_required = True

        weight_path_id, weight_nodes, _ = self.model.match_parent_paths(
            node,
            [(["DequantizeLinear", "QuantizeLinear", "Transpose", "DequantizeLinear"], [1, 0, 0, 0])],
            output_name_to_node,
        )

        if weight_path_id < 0:
            weight_path_id, weight_nodes, _ = self.model.match_parent_paths(
                node,
                [(["DequantizeLinear"], [1])],
                output_name_to_node,
            )

            if weight_path_id < 0:
                return

            dequantize_node_1 = weight_nodes[0]
        else:
            is_weight_transpose_required = False
            dequantize_node_1 = weight_nodes[3]

        # Check if weight 'B' is a constant
        if self.model.get_constant_value(dequantize_node_1.input[0]) is None:
            return

        # Make sure the upstream DequantizeLinear-1 has the proper zero points and scales
        # Per-channel scales are supported for weights alone
        if not FusionUtils.check_qdq_node_for_fusion(dequantize_node_1, self.model, False):
            return

        # Make sure the upstream flow into the Residual Add node flows through a DQ node
        residual_add_dequantize_node = None

        if residual_add_node is not None:
            residual_path_id, residual_input_parent_nodes, _ = self.model.match_parent_paths(
                residual_add_node,
                [
                    (["DequantizeLinear"], [1]),
                ],
                output_name_to_node,
            )

            if residual_path_id < 0:
                return

            residual_add_dequantize_node = residual_input_parent_nodes[0]

        # Make sure the upstream DequantizeLinear to the Residual Add has the proper zero points and scales
        if residual_add_dequantize_node is not None and not FusionUtils.check_qdq_node_for_fusion(
            residual_add_dequantize_node, self.model
        ):
            return

        # Subgraph nodes to be fused
        subgraph_nodes = [node, bias_add_node]  # MatMul + Bias Add

        if residual_add_node is not None:
            subgraph_nodes.extend([residual_add_node])  # Residual Add

        subgraph_nodes.extend(weight_nodes)
        subgraph_nodes.extend([downstream_quantize_node])  # Downstream Q node

        if not self.model.is_safe_to_fuse_nodes(
            subgraph_nodes, downstream_quantize_node.output, input_name_to_nodes, output_name_to_node
        ):
            logger.debug("It is not safe to fuse QOrderedMatMul node. Skip")
            return

        # Deal with the case where-in the Attention subgraph is not fused
        if transpose_node_0 is not None:
            self.model.replace_node_input(transpose_node_0, transpose_node_0.input[0], dequantize_node_0.input[0])

        # Make inputs
        fused_node_inputs = [
            reshape_node_0.output[0] if reshape_node_0 is not None else dequantize_node_0.input[0],
            dequantize_node_0.input[1],
            dequantize_node_1.input[0],
            dequantize_node_1.input[1],
            downstream_quantize_node.input[1],
            bias_add_node.input[bias_add_node_index],
        ]

        if residual_add_node is not None:
            fused_node_inputs.append(residual_add_dequantize_node.input[0])
            fused_node_inputs.append(residual_add_dequantize_node.input[1])

        # The MatMul weight 'B' and 'bias' need some post-processing
        # Transpose weight 'B' from order ROW to order COL
        # This offline transpose is needed only while using the CUDA EP
        # TODO: Make this fusion logic EP-agnostic ?
        if is_weight_transpose_required:
            weight_tensor = self.model.get_initializer(dequantize_node_1.input[0])
            FusionUtils.transpose_2d_int8_tensor(weight_tensor)

        fused_node = helper.make_node(
            "QOrderedMatMul",
            inputs=fused_node_inputs,
            outputs=[downstream_quantize_node.output[0]],
            name=self.model.create_node_name("QOrderedMatMul", name_prefix="QOrderedMatMul"),
        )

        fused_node.attribute.extend([helper.make_attribute("order_A", 1)])
        fused_node.attribute.extend([helper.make_attribute("order_B", 0)])
        fused_node.attribute.extend([helper.make_attribute("order_Y", 1)])

        fused_node.domain = "com.microsoft"

        self.nodes_to_remove.extend(subgraph_nodes)
        self.nodes_to_add.append(fused_node)
        self.node_name_to_graph_name[fused_node.name] = self.this_graph_name
