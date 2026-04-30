# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
from logging import getLogger

import numpy as np
from fusion_gpt_attention import FusionGptAttentionPastBase
from onnx import helper
from onnx_model import OnnxModel

logger = getLogger(__name__)


def is_close(value, expected_value):
    return abs(value - expected_value) <= 1e-6


class FusionGptAttentionMegatron(FusionGptAttentionPastBase):
    """
    Fuse GPT-2 Attention with past state subgraph from Megatron into one Attention node.
    """

    def __init__(self, model: OnnxModel, num_heads: int):
        super().__init__(model, num_heads)

    def fuse_attention_node(
        self,
        matmul_before_split,
        add_before_split,
        past,
        present,
        input,
        reshape_qkv,
        mask,
    ):
        attention_node_name = self.model.create_node_name("GptAttention")
        int32_mask = self.cast_attention_mask(mask)
        output = reshape_qkv.output[0]
        i = 1 if (add_before_split.input[0] == matmul_before_split.output[0]) else 0
        attention_node = helper.make_node(
            "Attention",
            inputs=[
                input,
                matmul_before_split.input[1],
                add_before_split.input[i],
                int32_mask,
                past,
            ],
            outputs=[output, present],
            name=attention_node_name,
        )
        attention_node.domain = "com.microsoft"
        attention_node.attribute.extend(
            [
                helper.make_attribute("num_heads", self.num_heads),
                helper.make_attribute("unidirectional", 0),  # unidirectional shall not be ON for 4D attention mask
            ]
        )
        if self.mask_filter_value is not None:
            attention_node.attribute.extend([helper.make_attribute("mask_filter_value", float(self.mask_filter_value))])

        nodes_to_add = [attention_node]
        self.nodes_to_add.extend(nodes_to_add)

        for node in nodes_to_add:
            self.node_name_to_graph_name[node.name] = self.this_graph_name

        self.nodes_to_remove.append(reshape_qkv)

        # we rely on prune_graph() to clean old subgraph nodes
        self.prune_graph = True

    def match_mask(self, sub_qk, mul_qk, matmul_qk, layernorm_before_attention):
        mask_nodes = self.model.match_parent_path(sub_qk, ["Mul", "Sub", "Slice", "Slice"], [1, 0, 1, 0])
        if mask_nodes is None:
            logger.debug("fuse_attention: failed to match unidirectional mask path")
            return None
        (mul_mask, sub_mask, last_slice_mask, slice_mask) = mask_nodes

        if len(mask_nodes) > 1 and mask_nodes[0].op_type == "Mul":
            _, mul_val = self.model.get_constant_input(mask_nodes[0])
            if mul_val != 10000:
                self.mask_filter_value = -mul_val

        if mul_qk.input[1] != last_slice_mask.output[0]:
            logger.debug("fuse_attention failed: mul_qk.input[1] != last_slice_mask.output[0]")
            return None

        if not self.utils.check_node_input_value(mul_mask, 1, 10000.0):
            logger.debug("fuse_attention failed: mul_mask input 1 is not constant 10000.0")
            return None

        if not self.utils.check_node_input_value(sub_mask, 0, 1.0):
            logger.debug("fuse_attention failed: sub_mask input 0 is not constant 1.0")
            return None

        if not self.model.find_graph_input(slice_mask.input[0]):
            logger.info("expect slick_mask input 0 to be graph input")
            return None

        if not self.utils.check_node_input_value(last_slice_mask, 1, [0]):
            logger.debug("fuse_attention failed: last_slice_mask input 1 (starts) is not constant [0]")
            return None

        if not self.utils.check_node_input_value(last_slice_mask, 3, [3]):
            logger.debug("fuse_attention failed: last_slice_mask input 3 (axes) is not constant [3]")
            return False

        if not self.utils.check_node_input_value(last_slice_mask, 4, [1]):
            logger.debug("fuse_attention failed: last_slice_mask input 4 (steps) is not constant [1]")
            return False

        if not self.utils.check_node_input_value(slice_mask, 3, [2]):
            logger.debug("fuse_attention failed: slice_mask input 3 (axes) is not constant [2]")
            return None

        if not self.utils.check_node_input_value(slice_mask, 4, [1]):
            logger.debug("fuse_attention failed: slice_mask input 4 (steps) is not constant [1]")
            return None

        last_slice_path = self.model.match_parent_path(
            last_slice_mask, ["Unsqueeze", "Gather", "Shape", "MatMul"], [2, 0, 0, 0]
        )
        if last_slice_path is None or last_slice_path[-1] != matmul_qk:
            logger.debug("fuse_attention: failed to match last slice path")
            return None

        first_slice_path = self.model.match_parent_path(
            slice_mask, ["Unsqueeze", "Gather", "Shape", "MatMul"], [2, 0, 0, 0]
        )
        if first_slice_path is None or first_slice_path[-1] != matmul_qk:
            logger.debug("fuse_attention: failed to match first slice path")
            return None

        first_slice_sub = self.model.match_parent_path(
            slice_mask,
            ["Unsqueeze", "Sub", "Gather", "Shape", "MatMul"],
            [1, 0, 0, 0, 0],
        )
        if first_slice_sub is None or first_slice_sub[-1] != matmul_qk:
            logger.debug("fuse_attention: failed to match last slice sub path")
            return None

        first_slice_sub_1 = self.model.match_parent_path(
            slice_mask,
            ["Unsqueeze", "Sub", "Gather", "Shape", "LayerNormalization"],
            [1, 0, 1, 0, 0],
        )

        if first_slice_sub_1 is None:
            first_slice_sub_1 = self.model.match_parent_path(
                slice_mask,
                ["Unsqueeze", "Sub", "Gather", "Shape", "SkipLayerNormalization"],
                [1, 0, 1, 0, 0],
            )

        if first_slice_sub_1 is None or first_slice_sub_1[-1] != layernorm_before_attention:
            logger.debug("fuse_attention: failed to match last slice sub path 1")
            return None

        return slice_mask.input[0]

    def fuse(self, normalize_node, input_name_to_nodes, output_name_to_node):
        past = None
        present = None

        is_normalize_node_skiplayernorm = normalize_node.op_type == "SkipLayerNormalization"
        qkv_nodes = None

        if not is_normalize_node_skiplayernorm:
            qkv_nodes = self.model.match_parent_path(
                normalize_node,
                ["Add", "Add", "MatMul", "Reshape", "Transpose", "MatMul"],
                [0, 1, None, 0, 0, 0],
                output_name_to_node=output_name_to_node,
            )
        else:
            qkv_nodes = self.model.match_parent_path(
                normalize_node,
                ["Add", "MatMul", "Reshape", "Transpose", "MatMul"],
                [1, None, 0, 0, 0],
                output_name_to_node=output_name_to_node,
            )

        if qkv_nodes is None:
            return

        skip_input = None
        if not is_normalize_node_skiplayernorm:
            (
                add_skip,
                add_after_attention,
                matmul_after_attention,
                reshape_qkv,
                transpose_qkv,
                matmul_qkv,
            ) = qkv_nodes

            skip_input = add_skip.input[0]
        else:
            (
                add_after_attention,
                matmul_after_attention,
                reshape_qkv,
                transpose_qkv,
                matmul_qkv,
            ) = qkv_nodes

            skip_input = normalize_node.input[0]

        v_nodes = self.model.match_parent_path(
            matmul_qkv,
            [
                "Concat",
                "Transpose",
                "Reshape",
                "Split",
                "Add",
                "MatMul",
                "LayerNormalization",
            ],
            [1, 1, 0, 0, 0, None, 0],
        )

        if v_nodes is None:
            v_nodes = self.model.match_parent_path(
                matmul_qkv,
                [
                    "Concat",
                    "Transpose",
                    "Reshape",
                    "Split",
                    "Add",
                    "MatMul",
                    "SkipLayerNormalization",
                ],
                [1, 1, 0, 0, 0, None, 0],
            )

        if v_nodes is None:
            logger.debug("fuse_attention: failed to match v path")
            return
        (
            concat_v,
            transpose_v,
            reshape_v,
            split_v,
            add_before_split,
            matmul_before_split,
            layernorm_before_attention,
        ) = v_nodes

        if (
            layernorm_before_attention.op_type == "LayerNormalization"
            and skip_input != layernorm_before_attention.input[0]
        ):
            logger.debug("fuse_attention: skip_input != layernorm_before_attention.input[0]")
            return

        if (
            layernorm_before_attention.op_type == "SkipLayerNormalization"
            and skip_input != layernorm_before_attention.output[3]
        ):
            logger.debug("fuse_attention: skip_input != layernorm_before_attention.input[0]")
            return

        qk_nodes = self.model.match_parent_path(matmul_qkv, ["Softmax", "Sub", "Mul", "MatMul"], [0, 0, 0, 0])
        if qk_nodes is None:
            logger.debug("fuse_attention: failed to match qk path")
            return None
        (softmax_qk, sub_qk, mul_qk, matmul_qk) = qk_nodes
        if self.model.get_node_attribute(softmax_qk, "axis") != 3:
            logger.debug("fuse_attention failed: softmax_qk axis != 3")
            return None

        attention_mask = self.match_mask(sub_qk, mul_qk, matmul_qk, layernorm_before_attention)

        q_nodes = self.model.match_parent_path(matmul_qk, ["Div", "Transpose", "Reshape", "Split"], [0, 0, 0, 0])
        if q_nodes is None:
            logger.debug("fuse_attention: failed to match q path")
            return
        (div_q, transpose_q, reshape_q, split_q) = q_nodes
        if split_v != split_q:
            logger.debug("fuse_attention: skip since split_v != split_q")
            return

        k_nodes = self.model.match_parent_path(
            matmul_qk,
            ["Div", "Transpose", "Concat", "Transpose", "Reshape", "Split"],
            [1, 0, 0, 1, 0, 0],
        )
        if k_nodes is None:
            logger.debug("fuse_attention: failed to match k path")
            return
        (div_k, _, concat_k, transpose_k, reshape_k, split_k) = k_nodes
        if split_v != split_k:
            logger.debug("fuse_attention: skip since split_v != split_k")
            return

        i, value = self.model.get_constant_input(reshape_k)
        if not (
            isinstance(value, np.ndarray)
            and list(value.shape) == [4]
            and value[0] == 0
            and value[1] == 0
            and value[2] > 0
            and value[3] > 0
        ):
            logger.debug("fuse_attention: reshape constant input is not [0, 0, N, H]")
            return

        num_heads = value[2]
        if num_heads != self.num_heads:
            logger.info(f"Detected num_heads={num_heads}. Ignore user specified value {self.num_heads}")
            self.num_heads = num_heads

        hidden_size_per_head = value[3]
        i, value = self.model.get_constant_input(div_k)
        expected_value = float(np.sqrt(np.sqrt(hidden_size_per_head)))
        if not is_close(value, expected_value):
            logger.debug(f"fuse_attention: div_k value={value} expected={expected_value}")
            return

        i, value = self.model.get_constant_input(div_q)
        if not is_close(value, expected_value):
            logger.debug(f"fuse_attention: div_q value={value} expected={expected_value}")
            return

        # Match past and present paths
        past = self.match_past_pattern_2(concat_k, concat_v, output_name_to_node)
        if past is None:
            logger.debug("fuse_attention: match past failed")
            return
        if not self.model.find_graph_input(past):
            logger.debug("fuse_attention: past is not graph input.")
            # For GPT2LMHeadModel_BeamSearchStep, there is an extra Gather node to select beam index so it is not graph input.

        present = self.match_present(concat_v, input_name_to_nodes)
        if present is None:
            logger.debug("fuse_attention: match present failed")
            return
        if not self.model.find_graph_output(present):
            logger.info("fuse_attention: expect present to be graph output")
            return

        self.fuse_attention_node(
            matmul_before_split,
            add_before_split,
            past,
            present,
            layernorm_before_attention.output[0],
            reshape_qkv,
            attention_mask,
        )
