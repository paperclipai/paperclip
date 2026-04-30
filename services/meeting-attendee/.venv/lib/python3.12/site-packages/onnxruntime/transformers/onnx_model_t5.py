# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
import logging

import numpy as np
from fusion_attention import AttentionMask, FusionAttention
from fusion_base import Fusion
from fusion_simplified_layernorm import FusionSimplifiedLayerNormalization, FusionSkipSimplifiedLayerNormalization
from fusion_utils import NumpyHelper
from onnx import NodeProto, TensorProto, helper
from onnx_model import OnnxModel
from onnx_model_bert import BertOnnxModel

logger = logging.getLogger(__name__)


class FusionT5Attention(FusionAttention):
    """
    Fuse T5 Attention subgraph into one Attention node.
    """

    def __init__(
        self,
        model: OnnxModel,
        hidden_size: int,
        num_heads: int,
        attention_mask: AttentionMask,
    ):
        super().__init__(
            model,
            hidden_size,
            num_heads,
            attention_mask,
            use_multi_head_attention=False,
            search_op_types=["Softmax"],
        )
        self.static_kv = 1

    def make_attention_node(
        self,
        mask_index: str | None,
        q_matmul: NodeProto,
        k_matmul: NodeProto,
        v_matmul: NodeProto,
        num_heads: int,
        hidden_size: int,
        input: str,
        output: str,
        attn_bias: str | None,
        scale: float,
    ) -> NodeProto | None:
        """Create an Attention node.
        Args:
            mask_index (str): mask input
            q_matmul (NodeProto): MatMul node in fully connection for Q
            k_matmul (NodeProto): MatMul node in fully connection for K
            v_matmul (NodeProto): MatMul node in fully connection for V
            num_heads (int): number of attention heads. If a model is pruned, it is the number of heads after pruning.
            hidden_size (int): hidden dimension. If a model is pruned, it is the hidden dimension after pruning.
            input (str): input name
            output (str): output name
        Returns:
            Union[NodeProto, None]: the node created or None if failed.
        """
        assert num_heads > 0

        if hidden_size > 0 and (hidden_size % num_heads) != 0:
            logger.debug(f"input hidden size {hidden_size} is not a multiple of num of heads {num_heads}")
            return None

        q_weight = self.model.get_initializer(q_matmul.input[1])
        k_weight = self.model.get_initializer(k_matmul.input[1])
        v_weight = self.model.get_initializer(v_matmul.input[1])

        if q_weight is None or k_weight is None or v_weight is None:
            matmul = q_matmul if q_weight is None else k_matmul if k_weight is None else v_matmul
            print(
                f"{matmul.input[1]} is not an initializer. "
                "Please set do_constant_folding=True in torch.onnx.export to unblock attention fusion"
            )
            return None

        qw = NumpyHelper.to_array(q_weight)
        kw = NumpyHelper.to_array(k_weight)
        vw = NumpyHelper.to_array(v_weight)

        # assert q and k have same shape as expected
        assert qw.shape == kw.shape

        qw_in_size = qw.shape[0]
        kw_in_size = kw.shape[0]
        vw_in_size = vw.shape[0]

        assert qw_in_size == kw_in_size == vw_in_size

        if hidden_size > 0 and hidden_size != qw_in_size:
            logger.warning(
                f"Input hidden size ({hidden_size}) is not same as weight matrix dimension of q,k,v ({qw_in_size}). "
                "Please provide a correct input hidden size or pass in 0"
            )

        qw_out_size = np.prod(qw.shape[1:])
        qkv_weight = np.stack((qw, kw, vw), axis=1)
        qkv_weight_dim = 3 * qw_out_size

        attention_node_name = self.model.create_node_name("Attention")

        weight = helper.make_tensor(
            name=attention_node_name + "_qkv_weight",
            data_type=TensorProto.FLOAT,
            dims=[qw_in_size, qkv_weight_dim],
            vals=qkv_weight.tobytes(),
            raw=True,
        )

        self.model.add_initializer(weight, self.this_graph_name)

        attention_inputs = [
            input,
            attention_node_name + "_qkv_weight",
            "",
        ]
        if mask_index:
            attention_inputs.append(mask_index)
        else:
            attention_inputs.append("")

        if attn_bias:
            attention_inputs.append("")  # no past
            attention_inputs.append(attn_bias)

        while attention_inputs and attention_inputs[-1] == "":
            attention_inputs.pop()

        attention_node = helper.make_node(
            "Attention",
            inputs=attention_inputs,
            outputs=[output],
            name=attention_node_name,
        )
        attention_node.domain = "com.microsoft"
        attention_node.attribute.extend([helper.make_attribute("num_heads", num_heads)])

        if scale is not None:
            attention_node.attribute.extend([helper.make_attribute("scale", scale)])

        if self.mask_filter_value is not None:
            attention_node.attribute.extend([helper.make_attribute("mask_filter_value", float(self.mask_filter_value))])

        return attention_node

    def create_mha_node(
        self,
        query: str,
        key: str,
        value: str,
        mask_index: str | None,
        attn_bias: str | None,
        past_key: str | None,
        past_value: str | None,
        output: str,
        present_key: str | None,
        present_value: str | None,
        num_heads: int,
        hidden_size: int,
    ) -> NodeProto | None:
        assert num_heads > 0 and hidden_size > 0 and query and key and value

        if (hidden_size % num_heads) != 0:
            logger.debug(f"input hidden size {hidden_size} is not a multiple of num of heads {num_heads}")
            return None

        attention_node_name = self.model.create_node_name("MultiHeadAttention")
        attention_inputs = [
            query,
            key,
            value,
            "",  # bias
        ]

        if mask_index:
            attention_inputs.append(mask_index)
        else:
            attention_inputs.append("")

        if attn_bias:
            attention_inputs.append(attn_bias)
        else:
            attention_inputs.append("")

        if past_key:
            assert past_value
            attention_inputs.append(past_key)
            attention_inputs.append(past_value)

        while attention_inputs and attention_inputs[-1] == "":
            attention_inputs.pop()

        attention_outputs = [output]
        if present_key:
            assert present_value
            attention_outputs.append(present_key)
            attention_outputs.append(present_value)

        print(f"{attention_inputs=}, {attention_outputs=}, {attention_node_name=}")
        attention_node = helper.make_node(
            "MultiHeadAttention",
            inputs=attention_inputs,
            outputs=attention_outputs,
            name=attention_node_name,
        )

        attention_node.domain = "com.microsoft"
        attention_node.attribute.extend([helper.make_attribute("num_heads", num_heads)])
        attention_node.attribute.extend([helper.make_attribute("scale", 1.0)])
        if self.mask_filter_value is not None:
            attention_node.attribute.extend([helper.make_attribute("mask_filter_value", float(self.mask_filter_value))])

        self.increase_counter("MultiHeadAttention")
        return attention_node

    def fuse(self, node, input_name_to_nodes, output_name_to_node):
        if self.fuse_t5_encoder(node, input_name_to_nodes, output_name_to_node):
            return

        self.fuse_t5_decoder(node, input_name_to_nodes, output_name_to_node)

    def fuse_t5_encoder(self, softmax_node, input_name_to_nodes, output_name_to_node):
        assert softmax_node.op_type == "Softmax"
        qkv_nodes = self.model.match_child_path(
            softmax_node,
            ["MatMul", "Transpose", "Reshape"],
            edges=[(0, 0), (0, 0), (0, 0)],
            input_name_to_nodes=input_name_to_nodes,
        )
        if qkv_nodes is None:
            return False
        matmul_qkv, _, reshape_qkv = qkv_nodes

        qkv_shape_nodes = self.model.match_parent_path(
            reshape_qkv,
            ["Concat", "Unsqueeze", "Gather", "Shape"],
            [1, 0, 0, 0],
            output_name_to_node,
        )
        if qkv_shape_nodes is None:
            return False
        input_shape_node = qkv_shape_nodes[-1]

        v_nodes = self.model.match_parent_path(
            matmul_qkv,
            ["Transpose", "Reshape", "MatMul"],
            [1, 0, 0],
            output_name_to_node,
        )
        if v_nodes is None:
            return False
        _, reshape_v, matmul_v = v_nodes
        # todo: check reshape_v parent nodes

        qk_nodes = self.model.match_parent_path(
            matmul_qkv,
            ["Softmax", "Add", "MatMul"],
            [0, 0, 0],
            output_name_to_node,
        )
        if qk_nodes is None:
            return False
        _, add_qk, matmul_qk = qk_nodes

        mask_nodes = self.model.match_parent_path(
            add_qk,
            ["Add", "Mul", "Sub", "Cast", "Unsqueeze", "Unsqueeze"],
            [1, 1, 0, 1, 0, 0],
            output_name_to_node,
        )

        is_pattern_for_one_graph_input = mask_nodes is None
        if mask_nodes is not None:
            mul_node = mask_nodes[1]
        else:
            # Pattern for SD3 and Flux.
            mask_nodes = self.model.match_parent_path(
                add_qk,
                ["Add", "Slice", "Mul", "Sub", "Unsqueeze", "Unsqueeze"],
                [1, 1, 0, 0, 1, 0],
                output_name_to_node,
            )

            # If the model is not optimized by ORT, there might be an additional Cast node.
            if mask_nodes is None:
                mask_nodes = self.model.match_parent_path(
                    add_qk,
                    ["Add", "Slice", "Mul", "Sub", "Cast", "Unsqueeze", "Unsqueeze"],
                    [1, 1, 0, 0, 1, 0, 0],
                    output_name_to_node,
                )
                if mask_nodes is None:
                    return False
            mul_node = mask_nodes[2]

        _, mul_val = self.model.get_constant_input(mul_node)
        if mul_val is None:
            return False

        if mul_val != -10000:
            self.mask_filter_value = float(mul_val)

        # If the mask is derived from shape of input_ids, it means there is no padding mask.
        mask_nodes_2 = self.model.match_parent_path(
            mask_nodes[-1],
            ["ConstantOfShape", "Concat", "Unsqueeze", "Gather", "Shape"],
            [0, 0, 0, 0, 0],
            output_name_to_node,
        )
        mask_nodes_3 = self.model.match_parent_path(
            mask_nodes[-1],
            ["ConstantOfShape", "Concat", "Unsqueeze", "Gather", "Shape"],
            [0, 0, 1, 0, 0],
            output_name_to_node,
        )
        if (
            mask_nodes_2 is not None
            and any(input.name == mask_nodes_2[-1].input[0] for input in self.model.graph().input)
            and mask_nodes_3 is not None
            and mask_nodes_2[-1].input[0] == mask_nodes_3[-1].input[0]
            and len(mask_nodes_2[1].input) == 2
        ):
            mask_index = ""
        else:
            mask_index = self.attention_mask.process_mask(mask_nodes[-1].input[0])

        res_pos_bias = None
        rpb_nodes = self.model.match_parent_path(
            add_qk,
            ["Add", "RelativePositionBias"],
            [1, 0],
        )
        if rpb_nodes is None and is_pattern_for_one_graph_input:
            # Pattern for SD3 and Flux.
            rpb_nodes = self.model.match_parent_path(
                add_qk,
                ["Add", "Slice", "RelativePositionBias"],
                [1, 0, 0],
            )
        if rpb_nodes is None:
            return False

        res_pos_bias = rpb_nodes[-1].output[0]

        k_nodes = self.model.match_parent_path(
            matmul_qk,
            ["Transpose", "Reshape", "MatMul"],
            [1, 0, 0],
        )
        if k_nodes is None:
            return False
        _, _, matmul_k = k_nodes
        # todo: check reshape_k parent nodes

        q_nodes = self.model.match_parent_path(
            matmul_qk,
            ["Transpose", "Reshape", "MatMul"],
            [0, 0, 0],
        )
        if q_nodes is None:
            return False

        _, reshape_q, matmul_q = q_nodes
        # todo: check reshape_q parent nodes

        if matmul_q.input[0] != input_shape_node.input[0]:
            return False

        q_num_heads, q_hidden_size = self.get_num_heads_and_hidden_size(reshape_q)

        new_node = self.make_attention_node(
            mask_index,
            matmul_q,
            matmul_k,
            matmul_v,
            num_heads=q_num_heads,
            hidden_size=q_hidden_size,
            input=input_shape_node.input[0],
            output=reshape_qkv.output[0],
            attn_bias=res_pos_bias,
            scale=1.0,
        )
        if new_node is None:
            return False

        self.nodes_to_add.append(new_node)
        self.node_name_to_graph_name[new_node.name] = self.this_graph_name

        self.nodes_to_remove.append(reshape_qkv)
        self.prune_graph = True
        return True

    def fuse_t5_decoder(self, softmax_node, input_name_to_nodes, output_name_to_node):
        assert softmax_node.op_type == "Softmax"

        qkv_nodes = self.model.match_child_path(
            softmax_node,
            ["MatMul", "Transpose", "Reshape"],
            edges=[(0, 0), (0, 0), (0, 0)],
            input_name_to_nodes=input_name_to_nodes,
        )
        if qkv_nodes is None:
            return
        matmul_qkv, _transpose_qkv, reshape_qkv = qkv_nodes

        qkv_shape_nodes = self.model.match_parent_path(
            reshape_qkv,
            ["Concat", "Unsqueeze", "Gather", "Shape"],
            [1, 0, 0, 0],
        )
        if qkv_shape_nodes is None:
            return
        input_shape_node = qkv_shape_nodes[-1]

        value = None
        past_value = None
        present_value = None
        v_nodes = self.model.match_parent_path(
            matmul_qkv,
            ["Concat", "Transpose", "Reshape", "MatMul"],
            [1, 1, 0, 0],
        )
        if v_nodes is None:
            v_nodes = self.model.match_parent_path(
                matmul_qkv,
                ["Transpose", "Reshape", "MatMul"],
                [1, 0, 0],
            )
            if v_nodes is not None:
                transpose_v, reshape_v, matmul_v = v_nodes
                value = reshape_v.input[0]
                present_value = transpose_v.output[0]
                if "present_value" not in present_value:
                    return
                if matmul_v.input[0] != input_shape_node.input[0]:
                    self.static_kv = 1
                else:
                    self.static_kv = 0
            else:
                past_value = matmul_qkv.input[1]
                if past_value in output_name_to_node:
                    return
                if "past_value_cross" not in past_value:
                    return
                self.static_kv = 1
        else:
            concat_v, _, reshape_v, _ = v_nodes
            past_value = concat_v.input[0]
            if past_value in output_name_to_node:
                return
            if "past_value_self" not in past_value:
                return
            present_value = concat_v.output[0]
            if "present_value_self" not in present_value:
                return
            value = reshape_v.input[0]
            self.static_kv = 0

        qk_nodes = self.model.match_parent_path(
            matmul_qkv,
            ["Softmax", "Add", "MatMul"],
            [0, 0, 0],
        )
        if qk_nodes is None:
            return
        _, add_qk, matmul_qk = qk_nodes

        mask_index = None
        res_pos_bias = None
        if self.static_kv == 1:
            mask_nodes = self.model.match_parent_path(
                add_qk,
                ["Add", "Mul", "Sub", "Cast", "Unsqueeze", "Unsqueeze"],
                [1, 1, 0, 1, 0, 0],
            )
            if mask_nodes is not None:
                mul_node = mask_nodes[1]
            else:
                mask_nodes = self.model.match_parent_path(
                    add_qk,
                    ["Add", "Slice", "Mul", "Sub", "Cast", "Unsqueeze", "Unsqueeze"],
                    [1, 1, 0, 0, 1, 0, 0],
                )
                if mask_nodes is None:
                    return
                mul_node = mask_nodes[2]

            _, mul_val = self.model.get_constant_input(mul_node)
            if mul_val != -10000:
                self.mask_filter_value = mul_val

            mask_index = self.attention_mask.process_mask(mask_nodes[-1].input[0])
        else:
            matched_path_index, _, _ = self.model.match_parent_paths(
                add_qk,
                [
                    (["Add", "Slice"], [1, 0]),
                    (["Add", "RelativePositionBias"], [1, 0]),
                ],
                output_name_to_node,
            )
            if matched_path_index < 0:
                logger.debug("Skip MultiHeadAttention fusion since attention bias pattern not matched")
                return

            res_pos_bias = add_qk.input[1]

        key = None
        past_key = None
        present_key = None
        if self.static_kv == 1:
            k_nodes = self.model.match_parent_path(
                matmul_qk,
                ["Transpose", "Reshape", "MatMul"],
                [1, 0, 0],
            )
            if k_nodes is not None:
                transpose_k, reshape_k, _ = k_nodes
                key = reshape_k.input[0]
                present_key_transpose_nodes = input_name_to_nodes[reshape_k.output[0]]
                for present_key_transpose_node in present_key_transpose_nodes:
                    present_key_candidate = self.model.find_graph_output(present_key_transpose_node.output[0])
                    if present_key_candidate is not None:
                        present_key = present_key_candidate.name
                        break
                if present_key is None:
                    return
                if "present_key_cross" not in present_key:
                    return
            else:
                k_nodes = self.model.match_parent_path(
                    matmul_qk,
                    ["Transpose"],
                    [1],
                )
                if k_nodes is None:
                    return
                transpose_k = k_nodes[0]

                past_key = transpose_k.input[0]
                if past_key in output_name_to_node:
                    return
                if "past_key_cross" not in past_key:
                    return
        else:
            idx, k_nodes, _ = self.model.match_parent_paths(
                matmul_qk,
                [
                    (["Transpose", "Concat", "Reshape", "MatMul"], [1, 0, 1, 0]),
                    (["Transpose", "Concat", "Transpose", "Reshape", "MatMul"], [1, 0, 1, 0, 0]),
                ],
                output_name_to_node,
            )
            past_key_transpose_node = None
            present_key_transpose_nodes = None
            if k_nodes is not None:
                concat_k, reshape_k = k_nodes[1], k_nodes[-2]
                key = reshape_k.input[0]

                if idx == 0:
                    past_key_transpose_node = output_name_to_node[concat_k.input[0]]
                    past_key = past_key_transpose_node.input[0]
                else:
                    past_key = concat_k.input[0]
                if past_key in output_name_to_node:
                    return
                if "past_key_self" not in past_key:
                    return

                if idx == 0:
                    present_key_transpose_nodes = input_name_to_nodes[concat_k.output[0]]
                    for present_key_transpose_node in present_key_transpose_nodes:
                        present_key_candidate = self.model.find_graph_output(present_key_transpose_node.output[0])
                        if present_key_candidate is not None:
                            present_key = present_key_candidate.name
                            break
                else:
                    present_key = concat_k.output[0]
                if present_key is None:
                    return
                if "present_key_self" not in present_key:
                    return
            else:
                k_nodes = self.model.match_parent_path(
                    matmul_qk,
                    ["Transpose", "Reshape", "MatMul"],
                    [1, 0, 0],
                )
                if k_nodes is None:
                    return
                _, reshape_k, _ = k_nodes
                key = reshape_k.input[0]
                present_key_transpose_nodes = input_name_to_nodes[reshape_k.output[0]]
                for present_key_transpose_node in present_key_transpose_nodes:
                    present_key_candidate = self.model.find_graph_output(present_key_transpose_node.output[0])
                    if present_key_candidate is not None:
                        present_key = present_key_candidate.name
                        break
                if present_key is None:
                    return
                if "present_key_self" not in present_key:
                    return

        q_nodes = self.model.match_parent_path(
            matmul_qk,
            ["Transpose", "Reshape", "MatMul"],
            [0, 0, 0],
        )
        if q_nodes is None:
            return

        transpose_q, reshape_q, matmul_q = q_nodes

        if matmul_q.input[0] != input_shape_node.input[0]:
            return

        q_num_heads, q_hidden_size = self.get_num_heads_and_hidden_size(reshape_q)

        if self.static_kv == 1 and past_key is not None:
            key = past_key
            value = past_value
            past_key = None
            past_value = None

        if not (key and value and q_num_heads > 0 and q_hidden_size > 0):
            return

        new_node = self.create_mha_node(
            query=matmul_q.output[0],
            key=key,
            value=value,
            mask_index=mask_index,
            attn_bias=res_pos_bias,
            past_key=past_key,
            past_value=past_value,
            output=reshape_qkv.output[0],
            present_key=present_key,
            present_value=present_value,
            num_heads=q_num_heads,
            hidden_size=q_hidden_size,
        )

        if new_node:
            self.nodes_to_add.append(new_node)
            self.node_name_to_graph_name[new_node.name] = self.this_graph_name

            # Since present_* is graph output, we need update the graph to avoid circular.
            if present_key or present_value:
                for graph_output in [present_key, present_value]:
                    if not (graph_output and self.model.find_graph_output(graph_output)):
                        print(f"{graph_output=} does not exist in graph output")
                        return
                    assert graph_output in output_name_to_node
                    output_name_to_node[graph_output].output[0] = graph_output + "_copy"
                    self.model.replace_input_of_all_nodes(graph_output, graph_output + "_copy")

            self.nodes_to_remove.append(reshape_qkv)
            self.prune_graph = False


class FusionRelativePositionBiasBlock(Fusion):
    def __init__(self, model: OnnxModel):
        super().__init__(model, "RelativePositionBias", ["Softmax"])

    def fuse(self, node, input_name_to_nodes, output_name_to_node):
        compute_bias_nodes = self.model.match_parent_path(
            node,
            ["Add", "Add", "Slice", "Unsqueeze", "Transpose", "Gather", "Where"],
            [0, 1, 0, 0, 0, 0, 1],
            output_name_to_node,
        )

        if compute_bias_nodes is None:
            compute_bias_nodes = self.model.match_parent_path(
                node,
                ["Add", "Add", "Slice", "Unsqueeze", "Transpose", "Gather", "Add", "Where"],
                [0, 1, 0, 0, 0, 0, 1, 1],
                output_name_to_node,
            )
            if compute_bias_nodes is None:
                return

        gather = compute_bias_nodes[5]
        where = compute_bias_nodes[-1]
        slice = compute_bias_nodes[2]
        unsqueeze = compute_bias_nodes[3]

        # Current fusion will not remove the node until the graph is processed.
        # This avoids to fuse it again when it is shared by multiple layers.
        if unsqueeze in self.nodes_to_remove:
            return

        compute_buckets_nodes = self.model.match_parent_path(
            where,
            ["Min", "ConstantOfShape", "Shape", "Add", "Cast", "Mul", "Div", "Log", "Div"],
            [2, 1, 0, 0, 0, 0, 0, 0, 0],
            output_name_to_node,
        )
        if compute_buckets_nodes is None:
            return

        # This value is to used to compute max_distance later.
        log_max = self.model.get_constant_value(compute_buckets_nodes[-3].input[1])

        div = compute_buckets_nodes[-1]

        range_nodes = self.model.match_parent_path(
            div,
            ["Cast", "Neg", "Min", "ConstantOfShape", "Shape", "Sub", "Unsqueeze", "Range"],
            [0, 0, 0, 1, 0, 0, 0, 0],
            output_name_to_node,
        )

        is_bidirectional = False
        if range_nodes is None:
            range_nodes = self.model.match_parent_path(
                div, ["Cast", "Abs", "Sub", "Unsqueeze", "Range"], [0, 0, 0, 0, 0], output_name_to_node
            )
            is_bidirectional = True
            if range_nodes is None:
                return
        range_node = range_nodes[-1]

        # Double check that the constant relative to max_distance and relative_attention_num_buckets.
        # Most t5 models use max_distance=128, so we hardcode it unitl we see a model with different value.

        # The log_max is the value of the following formula:
        #   math.log(max_distance / (relative_attention_num_buckets // (4 if is_bidirectional else 2)))
        # See https://github.com/huggingface/transformers/blob/608e163b527eaee41e650ffb9eb4c422d2679902/src/transformers/models/t5/modeling_t5.py#L397.
        # Here is the value based on max_distance=128 and relative_attention_num_buckets=32:
        max_distance = int(np.round(np.exp(log_max) * (32 // (4 if is_bidirectional else 2))))
        if max_distance != 128:
            logger.warning(
                f"max_distance is {max_distance}, which is different from the default value 128. "
                "Please double check the model configuration."
            )

        node_name = self.model.create_node_name(
            "RelativePositionBias", name_prefix="RelPosBias_" + ("encoder" if is_bidirectional else "decoder")
        )

        table_weight_i = self.model.get_initializer(gather.input[0])
        if table_weight_i is None:
            return
        table_weight = NumpyHelper.to_array(table_weight_i)
        table_weight_t = np.transpose(table_weight)
        bias_table = helper.make_tensor(
            name=node_name + "_bias_table_weight",
            data_type=TensorProto.FLOAT,
            dims=[np.shape(table_weight)[0], np.shape(table_weight)[1]],
            vals=table_weight_t.tobytes(),
            raw=True,
        )
        self.model.add_initializer(bias_table, self.this_graph_name)

        # Relative position is like the following in encoder:
        #                seq_len
        #                   |
        #                Range(0, *)
        #                /      \
        #   Unsqueeze(axes=0)    Unsqueeze(axes=1)
        #                \    /
        #                  Sub
        #                   |
        #                  Abs
        #
        # Relative position is like the following in decoder:
        #       past_seq_len   seq_len
        #                 \    /
        #                  Add
        #                /      \
        #        Range(0, *)    Range(0, *)
        #                \    /
        #                  Sub
        # Note that the graph will slice the attention bias to get last seq_len rows.
        #
        # In new version of transformers, the pattern of decoder is changed like the following
        #
        #      total_seq_len    Range(start=past_seq_len, end=total_seq_len)
        #              |              |
        #          Range(0, *)   Unsqueeze(axes=1)
        #              |              |
        #    Unsqueeze(axes=0)    Cast(to=int64)
        #                   \     /
        #                     Sub
        # Currently, there is still Slice to get last seq_len rows so end result is same.
        # But need to be careful that the shape of bias tensor is changed before Slice.
        #
        # RelativePositionBias operator requires query_length == key_length so we shall pass in total_seq_len.
        # Here we get the end value of the Range node as length to pass to the RelativePositionBias node.

        # TODO: Optimization opportunity: change RelativePositionBias op to support query_length != key_length.
        #       only compute seq_len rows, then we can remove the Slice after the RelativePositionBias node.
        inputs = [bias_table.name, range_node.input[1], range_node.input[1]]

        # Use a new tensor name since the shape might be different as mentioned above.
        bias_output = node_name + "_rel_pos_bias"
        slice.input[0] = bias_output

        rpb_node = helper.make_node(
            "RelativePositionBias",
            inputs=inputs,
            outputs=[bias_output],
            name=node_name,
        )
        rpb_node.domain = "com.microsoft"
        rpb_node.attribute.extend([helper.make_attribute("max_distance", max_distance)])
        rpb_node.attribute.extend([helper.make_attribute("is_bidirectional", is_bidirectional)])
        self.node_name_to_graph_name[rpb_node.name] = self.this_graph_name
        self.nodes_to_add.append(rpb_node)
        self.prune_graph = True


class T5OnnxModel(BertOnnxModel):
    def __init__(self, model, num_heads: int = 0, hidden_size: int = 0):
        super().__init__(model, num_heads, hidden_size)
        self.attention_mask = AttentionMask(self)

        # When the model has only one input (input_ids), there is no padding mask.
        if len(self.model.graph.input) == 1:
            from fusion_options import AttentionMaskFormat  # noqa: PLC0415

            self.attention_mask.mask_format = AttentionMaskFormat.NoMask

        self.attention_fusion = FusionT5Attention(self, self.hidden_size, self.num_heads, self.attention_mask)
        self.layer_norm_fusion = FusionSimplifiedLayerNormalization(self)
        self.skip_layer_norm_fusion = FusionSkipSimplifiedLayerNormalization(self)
        self.rpb_fusion = FusionRelativePositionBiasBlock(self)

    def fuse_attention(self):
        self.attention_fusion.apply()

    def fuse_layer_norm(self):
        self.layer_norm_fusion.apply()

    def fuse_skip_layer_norm(self, shape_infer=True):
        self.skip_layer_norm_fusion.apply()

    def adjust_rel_pos_bis_length_input(self):
        # For T5 encoder, it uses complex logic to compute the query and key length when there is only one graph input (input_ids)
        # We can directly get the length from shape (the 2nd dimension) of input_ids.
        for node in self.nodes():
            if node.op_type == "RelativePositionBias":
                nodes = self.match_parent_path(
                    node,
                    [
                        "Gather",
                        "Shape",
                        "Transpose",
                        "Reshape",
                        "Concat",
                        "Unsqueeze",
                        "Gather",
                        "Shape",
                        "SimplifiedLayerNormalization",
                        "Gather",
                    ],
                    [1, 0, 0, 0, 1, 0, 0, 0, 0, 0],
                )
                # TODO: more validation on node attributes
                if nodes is not None:
                    graph_input_names = [input.name for input in self.model.graph.input]
                    if nodes[-1].input[1] in graph_input_names:
                        node_name = self.create_node_name("Shape", name_prefix="Added_Shape_")
                        shape_node = helper.make_node(
                            "Shape",
                            inputs=[nodes[-1].input[1]],
                            outputs=[node_name + "_Output"],
                            name=node_name,
                        )

                        indices_1 = helper.make_tensor(
                            name="Constant_Index_1",
                            data_type=TensorProto.INT64,
                            dims=[1],  # Shape of the tensor
                            vals=[1],  # Tensor values
                        )
                        self.add_initializer(indices_1)

                        gather = helper.make_node(
                            "Gather",
                            inputs=[node_name + "_Output", "Constant_Index_1"],
                            outputs=[node_name + "_Output_Gather_1"],
                            name=self.create_node_name("Gather", name_prefix="Added_Gather_"),
                            axis=0,
                        )

                        self.add_node(shape_node)
                        self.add_node(gather)
                        node.input[1] = node_name + "_Output_Gather_1"
                        node.input[2] = node_name + "_Output_Gather_1"

                break

    # Remove get_extended_attention_mask() since it generates all zeros.
    def remove_extended_mask_decoder_init(self):
        nodes_to_remove = []
        for node in self.nodes():
            if node.op_type == "Add":
                extended_mask_nodes = self.match_parent_path(
                    node,
                    [
                        "Mul",
                        "Sub",
                        "Mul",
                        "Unsqueeze",
                        "Cast",
                        "LessOrEqual",
                        "Tile",
                        "Concat",
                        "Unsqueeze",
                        "Gather",
                        "Shape",
                    ],
                    [1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0],
                )
                if extended_mask_nodes is None:
                    continue

                rpb_nodes = self.match_parent_path(node, ["RelativePositionBias"], [0])
                if rpb_nodes is None:
                    continue

                rpb_node = rpb_nodes[0]
                rpb_node.output[0] = node.output[0]

                nodes_to_remove.extend(extended_mask_nodes)
                nodes_to_remove.append(node)
                self.remove_nodes(nodes_to_remove)

    def remove_extended_mask_decoder(self):
        nodes_to_remove = []
        for node in self.nodes():
            if node.op_type == "Add":
                extended_mask_nodes = self.match_parent_path(
                    node,
                    [
                        "Mul",
                        "Sub",
                        "Mul",
                        "Unsqueeze",
                        "Concat",
                        "Cast",
                        "LessOrEqual",
                        "Tile",
                        "Concat",
                        "Unsqueeze",
                        "Gather",
                        "Shape",
                    ],
                    [1, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0],
                )
                if extended_mask_nodes is None:
                    continue

                rpb_nodes = self.match_parent_path(node, ["Slice", "RelativePositionBias"], [0, 0])
                if rpb_nodes is None:
                    continue

                rpb_node = rpb_nodes[0]
                rpb_node.output[0] = node.output[0]

                nodes_to_remove.extend(extended_mask_nodes)
                nodes_to_remove.append(node)
                self.remove_nodes(nodes_to_remove)

    def preprocess(self):
        self.adjust_reshape_and_expand()
        self.rpb_fusion.apply()

    def postprocess(self):
        # remove get_extended_attention_mask() since it generates all zeros.
        self.remove_extended_mask_decoder_init()
        self.remove_extended_mask_decoder()
        self.adjust_rel_pos_bis_length_input()

        self.prune_graph()
