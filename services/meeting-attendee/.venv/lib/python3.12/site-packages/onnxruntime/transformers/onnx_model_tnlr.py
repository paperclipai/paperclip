# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
import logging

from fusion_attention import AttentionMask, FusionAttention
from fusion_utils import NumpyHelper
from onnx import NodeProto, helper
from onnx_model import OnnxModel
from onnx_model_bert import BertOnnxModel

logger = logging.getLogger(__name__)


class FusionTnlrAttention(FusionAttention):
    """
    Fuse TNLR Attention subgraph into one Attention node.
    TNLR Attention has extra addition after qk nodes and adopts [S, B, NH] as I/O shape.
    """

    def __init__(
        self,
        model: OnnxModel,
        hidden_size: int,
        num_heads: int,
        attention_mask: AttentionMask,
    ):
        super().__init__(model, hidden_size, num_heads, attention_mask)

    def create_attention_node(
        self,
        mask_index: str,
        matmul: NodeProto,
        add: NodeProto,
        num_heads: int,
        hidden_size: int,
        input: str,
        output: str,
        add_qk_str: str,
    ) -> NodeProto | None:
        assert num_heads > 0
        if hidden_size > 0 and (hidden_size % num_heads) != 0:
            logger.debug(f"input hidden size {hidden_size} is not a multiple of num of heads {num_heads}")
            return None

        weight = self.model.get_initializer(matmul.input[1])
        bias = self.model.get_initializer(add.input[1]) or self.model.get_initializer(add.input[0])

        if weight is None or bias is None:
            return None

        qkv_weight = NumpyHelper.to_array(weight)
        qkv_bias = NumpyHelper.to_array(bias)

        attention_node_name = self.model.create_node_name("Attention")

        tensor_dtype = weight.data_type
        np_type = helper.tensor_dtype_to_np_dtype(tensor_dtype)
        weight = helper.make_tensor(
            name=attention_node_name + "_qkv_weight",
            data_type=tensor_dtype,
            dims=[hidden_size, 3 * hidden_size],
            vals=qkv_weight.astype(np_type).tobytes(),
            raw=True,
        )
        self.model.add_initializer(weight, self.this_graph_name)

        bias = helper.make_tensor(
            name=attention_node_name + "_qkv_bias",
            data_type=tensor_dtype,
            dims=[3 * hidden_size],
            vals=qkv_bias.astype(np_type).tobytes(),
            raw=True,
        )
        self.model.add_initializer(bias, self.this_graph_name)

        attention_inputs = [
            input,
            attention_node_name + "_qkv_weight",
            attention_node_name + "_qkv_bias",
        ]
        if mask_index is not None:
            attention_inputs.append(mask_index)
        else:
            attention_inputs.append("")

        if add_qk_str is not None:
            attention_inputs.append("")
            attention_inputs.append(add_qk_str)

        attention_node = helper.make_node(
            "Attention",
            inputs=attention_inputs,
            outputs=[output],
            name=attention_node_name,
        )
        attention_node.domain = "com.microsoft"
        attention_node.attribute.extend([helper.make_attribute("num_heads", num_heads)])

        return attention_node

    def fuse(self, normalize_node, input_name_to_nodes, output_name_to_node):
        # Sometimes we can not fuse skiplayernormalization since the add before layernorm has an output that used by nodes outside skiplayernorm
        # Conceptually we treat add before layernorm as skiplayernorm node since they share the same pattern
        start_node = normalize_node
        if normalize_node.op_type != "SkipLayerNormalization":
            return

        # SkipLayerNormalization has two inputs, and one of them is the root input for attention.
        qkv_nodes = self.model.match_parent_path(
            start_node,
            ["Where", "Add", "MatMul", "Reshape", "Transpose", "MatMul"],
            [1, 1, 1, 0, 0, 0],
        )
        if qkv_nodes is not None:
            (_, _, matmul_below, reshape_qkv, transpose_qkv, matmul_qkv) = qkv_nodes
        else:
            return

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

        v_nodes = self.model.match_parent_path(
            matmul_qkv,
            ["Transpose", "Reshape", "Slice", "Add", "MatMul"],
            [1, 0, 0, 0, 1],
        )
        if v_nodes is None:
            return
        (_, _, _, add, matmul) = v_nodes

        upper_nodes = self.model.match_parent_path(matmul, ["Transpose"], [0])
        transpose = upper_nodes[0]

        qk_nodes = self.model.match_parent_path(matmul_qkv, ["Softmax", "Add", "MatMul"], [0, 0, 0])
        if qk_nodes is None:
            return
        (_, add_qk, matmul_qk) = qk_nodes

        q_nodes = self.model.match_parent_path(
            matmul_qk,
            ["Mul", "Transpose", "Reshape", "Slice", "Add", "MatMul"],
            [0, 0, 0, 0, 0, 1],
        )
        if q_nodes is None:
            return
        add = q_nodes[-2]
        matmul = q_nodes[-1]

        k_nodes = self.model.match_parent_path(
            matmul_qk,
            ["Transpose", "Reshape", "Slice", "Add", "MatMul"],
            [1, 0, 0, 0, 1],
        )
        if k_nodes is None:
            return
        add = k_nodes[-2]
        matmul = k_nodes[-1]

        relative_position_bias_nodes = self.model.match_parent_path(add_qk, ["Reshape", "Where"], [1, 0])
        if relative_position_bias_nodes is None:
            return

        if matmul.input[0] == root_input:
            mask_index = None
            attention_last_node = reshape_qkv
            # number of heads are same for all the paths, hence to create attention node, we pass the q_num_heads
            # the input_hidden_size represents the input hidden size, this is used as needed but hidden sizes for Q, K are extracted appropriately
            new_node = self.create_attention_node(
                mask_index,
                matmul,
                add,
                self.num_heads,
                self.hidden_size,
                root_input,
                attention_last_node.output[0],
                relative_position_bias_nodes[0].input[0],
            )
            if new_node is None:
                return

            self.nodes_to_add.append(new_node)
            self.node_name_to_graph_name[new_node.name] = self.this_graph_name

            # Add a transpose node after the attention node
            back_transpose = helper.make_node(
                "Transpose",
                ["back_transpose_in_" + new_node.name],
                [new_node.output[0]],
                "back_transpose_" + new_node.name,
                perm=[1, 0, 2],
            )
            self.model.add_node(back_transpose, self.this_graph_name)
            new_node.input[0] = transpose.input[0]
            new_node.output[0] = "back_transpose_in_" + new_node.name

            self.nodes_to_remove.extend([attention_last_node, transpose_qkv, matmul_qkv])
            self.nodes_to_remove.extend(qk_nodes)
            self.nodes_to_remove.extend(q_nodes)
            self.nodes_to_remove.extend(k_nodes)
            self.nodes_to_remove.extend(v_nodes)

            # Use prune graph to remove mask nodes since they are shared by all attention nodes.
            # self.nodes_to_remove.extend(mask_nodes)
            self.prune_graph = True


class TnlrOnnxModel(BertOnnxModel):
    def __init__(self, model, num_heads, hidden_size):
        super().__init__(model, num_heads, hidden_size)
        self.attention_mask = AttentionMask(self)
        self.attention_fusion = FusionTnlrAttention(self, self.hidden_size, self.num_heads, self.attention_mask)

    def fuse_attention(self):
        self.attention_fusion.apply()
