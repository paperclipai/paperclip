# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

from logging import getLogger

import numpy as np
from fusion_attention import AttentionMask
from fusion_base import Fusion
from fusion_utils import FusionUtils, NumpyHelper
from onnx import NodeProto, helper
from onnx_model import OnnxModel

logger = getLogger(__name__)


class FusionQOrderedAttention(Fusion):
    def __init__(
        self,
        model: OnnxModel,
        hidden_size: int,
        num_heads: int,
        attention_mask: AttentionMask,
    ):
        self.hidden_size = hidden_size
        self.num_heads = num_heads
        self.attention_mask = attention_mask

        super().__init__(model, "QOrderedAttention", "QOrderedLayerNormalization")

    def get_num_heads_and_hidden_size(self, reshape_q: NodeProto) -> tuple[int, int]:
        """Detect num_heads and hidden_size from a reshape node.
        Args:
            reshape_q (NodeProto): reshape node for Q
        Returns:
            Tuple[int, int]: num_heads and hidden_size
        """

        # we assume that reshape fusion has done, so the shape is a tensor like [0, 0, num_heads, head_size]
        q_shape = self.model.get_initializer(reshape_q.input[1])
        if q_shape is None:
            logger.debug(f"{reshape_q.input[1]} is not initializer.")

            # Check if the second input to Reshape flows through a Constant node
            # TODO: Investigate why FusionAttention doesn't have such logic
            constant_node = self.model.match_parent_path(reshape_q, ["Constant"], [1])

            if constant_node is None:
                return self.num_heads, self.hidden_size  # Fall back to user specified value
            else:
                constant_node = constant_node[0]

                if len(constant_node.attribute) != 1:
                    return self.num_heads, self.hidden_size  # Fall back to user specified value

                # This is assuming it is a Tensor attribute (this is a safe assumption)
                q_shape = constant_node.attribute[0].t

        q_shape_value = NumpyHelper.to_array(q_shape)
        if len(q_shape_value) != 4 or (q_shape_value[2] <= 0 or q_shape_value[3] <= 0):
            logger.debug(f"q_shape_value={q_shape_value}. Expected value are like [0, 0, num_heads, head_size].")
            return self.num_heads, self.hidden_size  # Fall back to user specified value

        num_heads = q_shape_value[2]
        head_size = q_shape_value[3]
        hidden_size = num_heads * head_size

        if self.num_heads > 0 and num_heads != self.num_heads:
            if self.num_heads_warning:
                logger.warning(f"--num_heads is {self.num_heads}. Detected value is {num_heads}. Using detected value.")
                self.num_heads_warning = False  # Do not show the warning more than once

        if self.hidden_size > 0 and hidden_size != self.hidden_size:
            if self.hidden_size_warning:
                logger.warning(
                    f"--hidden_size is {self.hidden_size}. Detected value is {hidden_size}. Using detected value."
                )
                self.hidden_size_warning = False  # Do not show the warning more than once

        return num_heads, hidden_size

    def fuse(self, normalize_node, input_name_to_nodes, output_name_to_node):
        add_before_layernorm = self.model.match_parent_path(
            normalize_node,
            ["QuantizeLinear", "Add"],
            [0, 0],
        )

        if add_before_layernorm is not None:
            start_node = add_before_layernorm[-1]
        else:
            return

        # Input QDQ nodes
        dequantize_input = self.model.match_parent_path(
            start_node,
            ["DequantizeLinear"],
            [None],
        )

        if dequantize_input is None:
            logger.debug("fuse_qordered_attention: failed to match input qdq nodes path")
            return

        dequantize_input = dequantize_input[-1]

        # QKV nodes
        qkv_nodes = self.model.match_parent_path(
            start_node,
            ["Add", "MatMul", "Reshape", "Transpose", "DequantizeLinear", "QuantizeLinear", "MatMul"],
            [None, None, 0, 0, 0, 0, 0],
        )

        if qkv_nodes is None:
            logger.debug("fuse_qordered_attention: failed to match qkv path")
            return

        (_, projection_matmul, reshape_qkv, transpose_qkv, dequantize_qkv, quantize_qkv, matmul_qkv) = qkv_nodes

        # Make sure the Q/DQ has the proper zero points and constant per-tensor scales
        if not FusionUtils.check_qdq_node_for_fusion(quantize_qkv, self.model):
            return

        if not FusionUtils.check_qdq_node_for_fusion(dequantize_qkv, self.model):
            return

        # Identify the root input to the Attention node
        other_inputs = []
        for _i, input in enumerate(start_node.input):
            if input not in output_name_to_node:
                continue

            if input == qkv_nodes[0].output[0]:
                continue

            other_inputs.append(input)

        if len(other_inputs) != 1:
            return

        root_input = other_inputs[0]

        # V nodes
        v_nodes = self.model.match_parent_path(
            matmul_qkv,
            ["Transpose", "Reshape", "DequantizeLinear", "QuantizeLinear", "Add", "MatMul"],
            [1, 0, 0, 0, 0, None],
        )

        if v_nodes is None:
            logger.debug("fuse_qordered_attention: failed to match v path")
            return

        (_, _, dequantize_v, quantize_v, add_v, matmul_v) = v_nodes

        # Make sure the Q/DQ has the proper zero points and constant per-tensor scales
        if not FusionUtils.check_qdq_node_for_fusion(quantize_v, self.model):
            return

        if not FusionUtils.check_qdq_node_for_fusion(dequantize_v, self.model):
            return

        # V MatMul weight
        dequantize_v_matmul_weight = self.model.match_parent_path(matmul_v, ["DequantizeLinear"], [1])

        if dequantize_v_matmul_weight is None:
            logger.debug("fuse_qordered_attention: failed to match v path")
            return

        dequantize_v_matmul_weight = dequantize_v_matmul_weight[0]

        if self.model.get_constant_value(dequantize_v_matmul_weight.input[0]) is None:
            return

        # Make sure the upstream DequantizeLinear-1 has the proper zero points and scales
        # Per-channel scales are supported for weights alone
        if not FusionUtils.check_qdq_node_for_fusion(dequantize_v_matmul_weight, self.model, False):
            return

        # QK nodes
        qk_nodes = self.model.match_parent_path(
            matmul_qkv,
            [
                "DequantizeLinear",
                "QuantizeLinear",
                "Softmax",
                "Add",
                "Div",
                "DequantizeLinear",
                "QuantizeLinear",
                "MatMul",
            ],
            [0, 0, 0, 0, None, 0, 0, 0],
        )

        if qk_nodes is None:
            logger.debug("fuse_qordered_attention: failed to match qk path")
            return

        (
            dequantize_qk_softmax,
            quantize_qk_softmax,
            softmax_qk,
            add_qk,
            div_qk,
            dequantize_qk,
            quantize_qk,
            matmul_qk,
        ) = qk_nodes

        # Make sure the Q/DQ has the proper zero points and constant per-tensor scales
        if not FusionUtils.check_qdq_node_for_fusion(quantize_qk_softmax, self.model):
            return

        if not FusionUtils.check_qdq_node_for_fusion(dequantize_qk_softmax, self.model):
            return

        if not FusionUtils.check_qdq_node_for_fusion(quantize_qk, self.model):
            return

        if not FusionUtils.check_qdq_node_for_fusion(dequantize_qk, self.model):
            return

        # Q nodes
        q_nodes = self.model.match_parent_path(
            matmul_qk,
            ["Transpose", "Reshape", "DequantizeLinear", "QuantizeLinear", "Add", "MatMul"],
            [0, 0, 0, 0, 0, None],
        )

        if q_nodes is None:
            logger.debug("fuse_qordered_attention: failed to match q path")
            return

        (_, reshape_q, dequantize_q, quantize_q, add_q, matmul_q) = q_nodes

        # Make sure the Q/DQ has the proper zero points and constant per-tensor scales
        if not FusionUtils.check_qdq_node_for_fusion(quantize_q, self.model):
            return

        if not FusionUtils.check_qdq_node_for_fusion(dequantize_q, self.model):
            return

        # Q MatMul weight
        dequantize_q_matmul_weight = self.model.match_parent_path(matmul_q, ["DequantizeLinear"], [1])

        if dequantize_q_matmul_weight is None:
            logger.debug("fuse_qordered_attention: failed to match q path")
            return

        dequantize_q_matmul_weight = dequantize_q_matmul_weight[0]

        if self.model.get_constant_value(dequantize_q_matmul_weight.input[0]) is None:
            return

        # Make sure the upstream DequantizeLinear-1 has the proper zero points and scales
        # Per-channel scales are supported for weights alone
        if not FusionUtils.check_qdq_node_for_fusion(dequantize_q_matmul_weight, self.model, False):
            return

        # K nodes
        k_nodes = self.model.match_parent_path(
            matmul_qk,
            ["Transpose", "Reshape", "DequantizeLinear", "QuantizeLinear", "Add", "MatMul"],
            [1, 0, 0, 0, 0, None],
        )

        if k_nodes is None:
            logger.debug("fuse_qordered_attention: failed to match k path")
            return

        (_, _, dequantize_k, quantize_k, add_k, matmul_k) = k_nodes

        # Make sure the Q/DQ has the proper zero points and constant per-tensor scales
        if not FusionUtils.check_qdq_node_for_fusion(quantize_k, self.model):
            return

        if not FusionUtils.check_qdq_node_for_fusion(dequantize_k, self.model):
            return

        # K MatMul weight
        dequantize_k_matmul_weight = self.model.match_parent_path(matmul_k, ["DequantizeLinear"], [1])

        if dequantize_k_matmul_weight is None:
            logger.debug("fuse_qordered_attention: failed to match k path")
            return

        dequantize_k_matmul_weight = dequantize_k_matmul_weight[0]

        if self.model.get_constant_value(dequantize_k_matmul_weight.input[0]) is None:
            return

        # Make sure the upstream DequantizeLinear-1 has the proper zero points and scales
        # Per-channel scales are supported for weights alone
        if not FusionUtils.check_qdq_node_for_fusion(dequantize_k_matmul_weight, self.model, False):
            return

        # Mask nodes
        mask_nodes = self.model.match_parent_path(
            add_qk, ["Mul", "Sub", "Cast", "Unsqueeze", "Unsqueeze"], [None, 0, 1, 0, 0]
        )

        if mask_nodes is None:
            logger.debug("fuse_qordered_attention: failed to match mask_nodes path")
            return

        # Ascertain `qkv_hidden_sizes` attribute value
        q_weight = self.model.get_initializer(dequantize_q_matmul_weight.input[0])
        k_weight = self.model.get_initializer(dequantize_k_matmul_weight.input[0])
        v_weight = self.model.get_initializer(dequantize_v_matmul_weight.input[0])

        qw = NumpyHelper.to_array(q_weight)
        kw = NumpyHelper.to_array(k_weight)
        vw = NumpyHelper.to_array(v_weight)

        qw_out_size = np.prod(qw.shape[1:])
        kw_out_size = np.prod(kw.shape[1:])
        vw_out_size = np.prod(vw.shape[1:])

        # Form QOrderedAttention node
        if matmul_v.input[0] == root_input and matmul_q.input[0] == root_input and matmul_k.input[0] == root_input:
            mask_index = self.attention_mask.process_mask(mask_nodes[-1].input[0])

            # Ascertain `num_heads` and `hidden_size`
            num_heads, hidden_size = self.get_num_heads_and_hidden_size(reshape_q)

            # Formulate the inputs
            # Actual quantized input
            attention_inputs = [dequantize_input.input[0]]
            attention_inputs.append(dequantize_input.input[1])

            attention_inputs.append(dequantize_q.input[1])
            attention_inputs.append(dequantize_k.input[1])
            attention_inputs.append(dequantize_v.input[1])

            attention_inputs.append(dequantize_q_matmul_weight.input[0])
            attention_inputs.append(dequantize_k_matmul_weight.input[0])
            attention_inputs.append(dequantize_v_matmul_weight.input[0])

            attention_inputs.append(dequantize_q_matmul_weight.input[1])
            attention_inputs.append(dequantize_k_matmul_weight.input[1])
            attention_inputs.append(dequantize_v_matmul_weight.input[1])

            if self.model.get_initializer(add_q.input[0]):
                attention_inputs.append(add_q.input[0])
            else:  # second input is the constant bias
                attention_inputs.append(add_q.input[1])

            if self.model.get_initializer(add_k.input[0]):
                attention_inputs.append(add_k.input[0])
            else:  # second input is the constant bias
                attention_inputs.append(add_k.input[1])

            if self.model.get_initializer(add_v.input[0]):
                attention_inputs.append(add_v.input[0])
            else:  # second input is the constant bias
                attention_inputs.append(add_v.input[1])

            attention_inputs.append(quantize_qk.input[1])
            attention_inputs.append(quantize_qk_softmax.input[1])
            attention_inputs.append(dequantize_qkv.input[1])

            # Mask input
            if mask_index is not None:
                attention_inputs.append(mask_index)
            else:
                attention_inputs.append("")

            # The MatMul weight 'B' and 'bias' need some post-processing
            # Transpose weight 'B' from order ROW to order COL
            # This offline transpose is needed only while using the CUDA EP
            # TODO: Make this fusion logic EP-agnostic ?
            q_weight_tensor = self.model.get_initializer(dequantize_q_matmul_weight.input[0])
            FusionUtils.transpose_2d_int8_tensor(q_weight_tensor)

            k_weight_tensor = self.model.get_initializer(dequantize_k_matmul_weight.input[0])
            FusionUtils.transpose_2d_int8_tensor(k_weight_tensor)

            v_weight_tensor = self.model.get_initializer(dequantize_v_matmul_weight.input[0])
            FusionUtils.transpose_2d_int8_tensor(v_weight_tensor)

            # Name and create Attention node
            attention_node_name = self.model.create_node_name("QOrderedAttention")

            attention_node = helper.make_node(
                "QOrderedAttention",
                inputs=attention_inputs,
                outputs=[reshape_qkv.output[0]],
                name=attention_node_name,
            )

            self.model.replace_node_input(dequantize_qkv, dequantize_qkv.input[0], attention_node.output[0])
            self.model.replace_node_input(projection_matmul, projection_matmul.input[0], dequantize_qkv.output[0])

            attention_node.attribute.extend([helper.make_attribute("num_heads", num_heads)])
            attention_node.attribute.extend([helper.make_attribute("order_input", 1)])
            attention_node.attribute.extend([helper.make_attribute("order_weight", 0)])
            attention_node.attribute.extend([helper.make_attribute("order_output", 1)])
            attention_node.attribute.extend(
                [helper.make_attribute("qkv_hidden_sizes", [qw_out_size, kw_out_size, vw_out_size])]
            )

            attention_node.domain = "com.microsoft"

            self.nodes_to_add.append(attention_node)
            self.node_name_to_graph_name[attention_node.name] = self.this_graph_name

            self.nodes_to_remove.extend([reshape_qkv, transpose_qkv, quantize_qkv, matmul_qkv])
            self.nodes_to_remove.extend(qk_nodes)
            self.nodes_to_remove.extend(q_nodes)
            self.nodes_to_remove.extend(k_nodes)
            self.nodes_to_remove.extend(v_nodes)
            self.nodes_to_remove.extend(
                [dequantize_q_matmul_weight, dequantize_k_matmul_weight, dequantize_v_matmul_weight]
            )

            # Use prune graph to remove mask nodes since they are shared by all attention nodes.
            # self.nodes_to_remove.extend(mask_nodes)
            self.prune_graph = True
