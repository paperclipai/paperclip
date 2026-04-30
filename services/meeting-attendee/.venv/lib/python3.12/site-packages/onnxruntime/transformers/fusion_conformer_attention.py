# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
import logging

from fusion_attention import AttentionMask, FusionAttention
from onnx_model import OnnxModel

logger = logging.getLogger(__name__)


class FusionConformerAttention(FusionAttention):
    """
    Fuse Conformer Attention subgraph into one MultiHeadAttention node.
    """

    def __init__(
        self,
        model: OnnxModel,
        hidden_size: int,
        num_heads: int,
        attention_mask: AttentionMask,
    ):
        super().__init__(model, hidden_size, num_heads, attention_mask)

    def fuse(self, normalize_node, input_name_to_nodes, output_name_to_node):
        # SkipLayerNormalization has two inputs, and one of them is the root input for attention.
        qkv_nodes = self.model.match_parent_path(
            normalize_node,
            ["Add", "MatMul", "Reshape", "Transpose", "MatMul"],
            [1, None, 0, 0, 0],
        )
        if qkv_nodes is None:
            qkv_nodes = self.model.match_parent_path(
                normalize_node,
                ["MatMul", "Reshape", "Transpose", "MatMul"],
                [1, 0, 0, 0],
            )
            if qkv_nodes is None:
                logger.debug("fuse_conformer_attention: failed to match qkv path")
                return

        reshape_qkv, transpose_qkv, matmul_qkv = qkv_nodes[-3], qkv_nodes[-2], qkv_nodes[-1]

        past_v, present_v = "", ""
        v_nodes = self.model.match_parent_path(
            matmul_qkv,
            ["Concat", "Transpose", "Reshape", "Add", "MatMul"],
            [1, 1, 0, 0, 1],
        )
        if v_nodes is None:
            v_nodes = self.model.match_parent_path(
                matmul_qkv,
                ["Transpose", "Reshape", "Add", "MatMul"],
                [1, 0, 0, 0],
            )
            if v_nodes is None:
                v_nodes = self.model.match_parent_path(
                    matmul_qkv,
                    ["Transpose", "Reshape", "MatMul"],
                    [1, 0, 0],
                )
                if v_nodes is None:
                    logger.debug("fuse_conformer_attention: failed to match v path")
                    return
        else:
            concat_v = v_nodes[0]
            concat_parent = self.model.get_parent(concat_v, 0, None)
            present_v = concat_v.output[0]
            past_v = concat_parent.output[0]

        add_v = v_nodes[-2] if len(v_nodes) >= 2 and v_nodes[-2].op_type == "Add" else None
        matmul_v = v_nodes[-1]

        attn_mask = ""
        qk_nodes = self.model.match_parent_path(
            matmul_qkv,
            ["Softmax", "Add", "MatMul"],
            [0, 0, 0],
        )
        where_qk = None
        if qk_nodes is None:
            qk_nodes = self.model.match_parent_path(
                matmul_qkv,
                ["Where", "Softmax", "Where", "Add", "MatMul"],
                [0, 2, 0, 2, 0],
            )
            if qk_nodes is None:
                qk_nodes = self.model.match_parent_path(
                    matmul_qkv,
                    ["Where", "Softmax", "Where", "Div", "Add", "MatMul"],
                    [0, 2, 0, 2, 0, 0],
                )
                if qk_nodes is None:
                    logger.debug("fuse_conformer_attention: failed to match qk path")
                    return
                where_qk = qk_nodes[2]
            else:
                where_qk = qk_nodes[2]

        if where_qk is not None:
            mask_nodes = self.model.match_parent_path(
                where_qk,
                ["Equal", "Unsqueeze", "Cast"],
                [0, 0, 0],
            )
            if mask_nodes is not None:
                attn_mask = mask_nodes[-1].output[0]

        add_qk, matmul_qk = qk_nodes[-2], qk_nodes[-1]

        q_nodes = self.model.match_parent_path(
            matmul_qk,
            ["Div", "Transpose", "Reshape", "Add", "MatMul"],
            [0, 0, 0, 0, 1],
        )
        if q_nodes is None:
            q_nodes = self.model.match_parent_path(
                matmul_qk,
                ["Mul", "Transpose", "Reshape", "Add", "MatMul"],
                [0, 0, 0, 0, 0],
            )
            if q_nodes is None:
                q_nodes = self.model.match_parent_path(
                    matmul_qk,
                    ["Transpose", "Add", "Reshape", "MatMul"],
                    [0, 0, 0, 1],
                )
                if q_nodes is None:
                    q_nodes = self.model.match_parent_path(
                        matmul_qk,
                        ["Transpose", "Add", "Reshape", "MatMul"],
                        [0, 0, 0, 0],
                    )
                    if q_nodes is None:
                        logger.debug("fuse_conformer_attention: failed to match q path")
                        return

        reshape_q = next((node for node in q_nodes if node.op_type == "Reshape"), None)
        add_q = next((node for node in q_nodes if node.op_type == "Add"), None)
        matmul_q = next((node for node in reversed(q_nodes) if node.op_type == "MatMul"), None)
        if reshape_q is None or add_q is None or matmul_q is None:
            logger.debug("fuse_conformer_attention: failed to identify q reshape/add/matmul nodes")
            return

        extra_q_nodes = self.model.match_parent_path(
            add_qk,
            ["Reshape", "Transpose", "MatMul", "Transpose", "Reshape", "Div"],
            [1, 0, 0, 0, 0, 0],
        )
        if extra_q_nodes is not None and q_nodes[0].op_type in ["Div", "Mul"] and q_nodes[0] != extra_q_nodes[-1]:
            logger.debug("fuse_conformer_attention: failed to match extra q path")
            return

        if extra_q_nodes is None:
            nemotron_extra_q_nodes = self.model.match_parent_path(
                add_qk,
                ["Slice", "Reshape", "Slice", "Reshape", "Pad", "MatMul", "Transpose", "Add"],
                [1, 0, 0, 0, 0, 0, 0, 0],
            )
            if nemotron_extra_q_nodes is not None:
                extra_q_nodes = nemotron_extra_q_nodes

        past_k, present_k = "", ""
        k_nodes = self.model.match_parent_path(
            matmul_qk,
            ["Transpose", "Concat", "Transpose", "Reshape", "Add", "MatMul"],
            [1, 0, 1, 0, 0, 1],
        )
        if k_nodes is None:
            k_nodes = self.model.match_parent_path(
                matmul_qk,
                ["Transpose", "Transpose", "Reshape", "Add", "MatMul"],
                [1, 0, 0, 0, 0],
            )
            if k_nodes is None:
                k_nodes = self.model.match_parent_path(
                    matmul_qk,
                    ["Transpose", "Reshape", "Add", "MatMul"],
                    [1, 0, 0, 0],
                )
                if k_nodes is None:
                    k_nodes = self.model.match_parent_path(
                        matmul_qk,
                        ["Transpose", "Reshape", "MatMul"],
                        [1, 0, 0],
                    )
                    if k_nodes is None:
                        logger.debug("fuse_conformer_attention: failed to match k path")
                        return
        else:
            concat_k = k_nodes[1]
            concat_parent = self.model.get_parent(concat_k, 0, None)
            past_k = concat_parent.output[0]
            present_k = concat_k.output[0]

        add_k = k_nodes[-2] if len(k_nodes) >= 2 and k_nodes[-2].op_type == "Add" else None
        matmul_k = k_nodes[-1]

        num_heads, hidden_size = self.get_num_heads_and_hidden_size(reshape_q)
        if num_heads <= 0 or hidden_size <= 0 or (hidden_size % num_heads) != 0:
            logger.debug("fuse_conformer_attention: failed to detect num_heads or hidden_size")
            return

        # Validate attention_bias: the Attention and MultiHeadAttention kernels require a 4-D
        # tensor with shape [batch_size or 1, num_heads or 1, sequence_length, total_sequence_length].
        # Scalar or 1-D initializers (e.g. a plain QK scaling constant) must not be forwarded as
        # attention_bias. Non-initializer values (computed positional-bias outputs) are kept as-is.
        attention_bias = add_qk.input[1]
        bias_init = self.model.get_initializer(attention_bias)
        if bias_init is not None and len(bias_init.dims) != 4:
            logger.debug(
                "fuse_conformer_attention: skipping attention_bias %s with dims %s (expected 4-D)",
                attention_bias,
                list(bias_init.dims),
            )
            attention_bias = ""

        new_node = None
        use_packed_attention_op = (
            matmul_q.input[0] == matmul_k.input[0]
            and matmul_k.input[0] == matmul_v.input[0]
            and extra_q_nodes is None
            and add_q is not None
            and add_k is not None
            and add_v is not None
        )
        if use_packed_attention_op:
            # Self-attention, use Attention op
            new_node = self.create_attention_node(
                mask_index=attn_mask,
                q_matmul=matmul_q,
                k_matmul=matmul_k,
                v_matmul=matmul_v,
                q_add=add_q,
                k_add=add_k,
                v_add=add_v,
                num_heads=num_heads,
                hidden_size=hidden_size,
                first_input=matmul_q.input[0],
                output=reshape_qkv.output[0],
                add_qk_str=attention_bias,
                past_k=past_k,
                past_v=past_v,
                present_k=present_k,
                present_v=present_v,
            )
        else:
            new_node = self.create_multihead_attention_node(
                q_matmul=matmul_q,
                k_matmul=matmul_k,
                v_matmul=matmul_v,
                q_add=add_q,
                k_add=add_k,
                v_add=add_v,
                num_heads=num_heads,
                hidden_size=hidden_size,
                output=reshape_qkv.output[0],
                key_padding_mask=attn_mask,
                add_qk=attention_bias,
                past_k=past_k,
                past_v=past_v,
                present_k=present_k,
                present_v=present_v,
            )

        if new_node is None:
            logger.debug("fuse_conformer_attention: MultiHeadAttention node creation failed")
            return

        self.nodes_to_add.append(new_node)
        self.node_name_to_graph_name[new_node.name] = self.this_graph_name

        self.nodes_to_remove.extend([reshape_qkv, transpose_qkv, matmul_qkv])
        self.nodes_to_remove.extend(qk_nodes)

        # When using MultiHeadAttention, keep MatMul nodes unfused in original graph
        if not use_packed_attention_op:
            if q_nodes[-1].op_type == "MatMul":
                q_nodes.pop()
            if k_nodes[-1].op_type == "MatMul":
                k_nodes.pop()
            if v_nodes[-1].op_type == "MatMul":
                v_nodes.pop()

        if extra_q_nodes is None:
            # Don't remove Q nodes for conformer-transducer (CT) model since it has
            # an extra set of nodes attached to the output of the Q path that are not
            # part of the attention computation
            self.nodes_to_remove.extend(q_nodes)

        self.nodes_to_remove.extend(k_nodes)
        self.nodes_to_remove.extend(v_nodes)

        # Use prune graph to remove mask nodes since they are shared by all attention nodes.
        self.prune_graph = True
