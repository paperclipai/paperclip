# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
from logging import getLogger

from fusion_attention import AttentionMask, FusionAttention
from fusion_options import AttentionMaskFormat
from onnx import NodeProto
from onnx_model import OnnxModel

logger = getLogger(__name__)


class FusionAttentionClip(FusionAttention):
    """
    Fuse Attention subgraph of Clip into one Attention node.
    """

    def __init__(
        self,
        model: OnnxModel,
        hidden_size: int,
        num_heads: int,
    ):
        attention_mask = AttentionMask(model)
        attention_mask.mask_format = AttentionMaskFormat.NoMask

        super().__init__(
            model,
            hidden_size,
            num_heads,
            attention_mask,
            use_multi_head_attention=False,
            search_op_types=["SkipLayerNormalization"],
        )

    def get_num_heads_and_hidden_size(self, reshape_q: NodeProto) -> tuple[int, int]:
        """Detect num_heads and hidden_size for ONNX model from MiDaS
        Args:
            reshape_q (NodeProto): reshape node for q
        Returns:
            Tuple[int, int]: num_heads and hidden_size
        """
        concat = self.model.match_parent(reshape_q, "Concat", 1)
        if concat is None or len(concat.input) != 4:
            return self.num_heads, self.hidden_size

        # The shape is a tensor like [?, ?, num_heads, head_size]
        num_head_value = self.model.get_constant_value(concat.input[2])
        if num_head_value is None:
            return self.num_heads, self.hidden_size  # Fall back to user specified value

        if len(num_head_value) != 1 or num_head_value[0] <= 0:
            return self.num_heads, self.hidden_size  # Fall back to user specified value

        num_heads = num_head_value[0]

        head_size_value = self.model.get_constant_value(concat.input[3])
        if head_size_value is None:
            return self.num_heads, self.hidden_size  # Fall back to user specified value

        if len(head_size_value) != 1 or head_size_value[0] <= 0:
            return self.num_heads, self.hidden_size  # Fall back to user specified value

        head_size = head_size_value[0]

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
        skip_input_index = None
        node_before_layer_norm = None
        for i in [1, 0]:
            parent = self.model.match_parent(normalize_node, "SkipLayerNormalization", i)
            if parent is not None:
                skip_input_index = i
                node_before_layer_norm = parent

        root_input = None
        if node_before_layer_norm is not None:
            root_input = node_before_layer_norm.output[0]
        else:
            # Deal with the first attention after the embedding layer.
            for i in [0, 1]:
                node_before_layer_norm = None

                node_before_layer_norm_1 = self.model.match_parent(normalize_node, "Add", i)
                node_before_layer_norm_2 = self.model.match_parent(normalize_node, "LayerNormalization", i)
                if node_before_layer_norm_1 is not None:
                    #           Add -----------+
                    #            |             |
                    #        LayerNorm         |
                    #            |             |
                    #        LayerNorm         |
                    #            |             |
                    #   Attention subgraph     |
                    #            |             |
                    #      SkipLayerNorm ------+
                    node_before_layer_norm = node_before_layer_norm_1
                elif node_before_layer_norm_2 is not None:
                    #           Add
                    #            |
                    #        LayerNorm --------+
                    #            |             |
                    #        LayerNorm         |
                    #            |             |
                    #   Attention subgraph     |
                    #            |             |
                    #      SkipLayerNorm ------+
                    node_before_layer_norm = node_before_layer_norm_2

                if node_before_layer_norm is None:
                    continue
                child = self.model.find_first_child_by_type(
                    node_before_layer_norm,
                    "LayerNormalization",
                    input_name_to_nodes,
                    False,
                )
                if child is None:
                    continue
                root_input = child.output[0]
                skip_input_index = i
                break

            if skip_input_index is None:
                return

        qkv_nodes = self.model.match_parent_path(
            normalize_node,
            ["Add", "MatMul", "Reshape", "Transpose", "Reshape", "MatMul"],
            [1 - skip_input_index, None, None, 0, 0, 0],
        )
        if qkv_nodes is None:
            qkv_nodes = self.model.match_parent_path(
                normalize_node,
                ["Add", "MatMul", "Reshape", "Transpose", "MatMul"],
                [1, None, 0, 0, 0],
            )
            if qkv_nodes is None:
                logger.debug("fuse_attention: failed to match qkv path")
                return
        reshape_qkv, transpose_qkv, matmul_qkv = (
            qkv_nodes[2],
            qkv_nodes[3],
            qkv_nodes[-1],
        )

        v_nodes = self.model.match_parent_path(
            matmul_qkv,
            ["Reshape", "Transpose", "Reshape", "Add", "MatMul"],
            [1, 0, 0, 0, None],
        )
        if v_nodes is None:
            v_nodes = self.model.match_parent_path(
                matmul_qkv, ["Transpose", "Reshape", "Add", "MatMul"], [1, 0, 0, None]
            )
            if v_nodes is None:
                logger.debug("fuse_attention: failed to match v path")
                return

        add_v, matmul_v = v_nodes[-2], v_nodes[-1]

        causal_mask_input_index = None
        add_mask = None
        add_mask_indices = []
        qk_nodes = self.model.match_parent_path(
            matmul_qkv,
            ["Softmax", "Reshape", "Add", "Reshape", "MatMul"],
            [0, 0, 0, None, 0],
            return_indice=add_mask_indices,
        )
        if qk_nodes is None:
            qk_nodes = self.model.match_parent_path(
                matmul_qkv,
                ["Softmax", "MatMul"],
                [0, 0],
            )
            if qk_nodes is None:
                qk_nodes = self.model.match_parent_path(matmul_qkv, ["Softmax", "Add", "Mul", "MatMul"], [0, 0, 0, 0])
                if qk_nodes is not None:
                    add_mask = qk_nodes[1]
                else:
                    # If attention mask is not used, we can still match the qk path.
                    qk_nodes = self.model.match_parent_path(matmul_qkv, ["Softmax", "Mul", "MatMul"], [0, 0, 0])
                    if qk_nodes is None:
                        # Cast nodes are added in the model for fp16.
                        qk_nodes = self.model.match_parent_path(
                            matmul_qkv,
                            ["Cast", "Cast", "Softmax", "Add", "Mul", "MatMul"],
                            [0, 0, 0, 0, 0, 0],
                        )
                        if qk_nodes is not None:
                            add_mask = qk_nodes[3]
                        else:
                            # If attention mask is not used, we can still match the qk path.
                            qk_nodes = self.model.match_parent_path(
                                matmul_qkv,
                                ["Cast", "Cast", "Softmax", "Mul", "MatMul"],
                                [0, 0, 0, 0, 0],
                            )
                            if qk_nodes is None:
                                logger.debug("fuse_attention: failed to match qk path")
                                return
        else:
            assert len(add_mask_indices) == 1
            causal_mask_input_index = 1 - add_mask_indices[0]
            add_mask = qk_nodes[2]

        matmul_qk = qk_nodes[-1]

        q_nodes = self.model.match_parent_path(
            matmul_qk,
            ["Reshape", "Transpose", "Reshape", "Mul", "Add", "MatMul"],
            [0, 0, 0, 0, None, None],
        )
        if q_nodes is None:
            q_nodes = self.model.match_parent_path(
                matmul_qk, ["Transpose", "Reshape", "Add", "MatMul"], [0, 0, 0, None]
            )
            if q_nodes is None:
                logger.debug("fuse_attention: failed to match q path")
                return

            reshape_q = q_nodes[1]
        else:
            reshape_q = q_nodes[2]

        add_q, matmul_q = q_nodes[-2], q_nodes[-1]

        k_nodes = self.model.match_parent_path(
            matmul_qk,
            ["Transpose", "Reshape", "Transpose", "Reshape", "Add", "MatMul"],
            [1, 0, 0, 0, 0, None],
        )
        if k_nodes is None:
            k_nodes = self.model.match_parent_path(
                matmul_qk, ["Transpose", "Reshape", "Add", "MatMul"], [1, 0, 0, None]
            )
            if k_nodes is None:
                logger.debug("fuse_attention: failed to match k path")
                return

        add_k, matmul_k = k_nodes[-2], k_nodes[-1]

        if matmul_q.input[0] != root_input or matmul_k.input[0] != root_input or matmul_v.input[0] != root_input:
            logger.debug("fuse_attention: expect to have same input to q, k and v matmul")
            return

        num_heads, hidden_size = self.get_num_heads_and_hidden_size(reshape_q)
        if num_heads <= 0 or hidden_size <= 0:
            logger.debug("fuse_attention: failed to detect num_heads or hidden_size")
            return

        attention_last_node = reshape_qkv

        add_qk = ""
        causal_mask_nodes_1 = None
        causal_mask_nodes_2 = None
        if add_mask is not None:
            if add_mask.input[1] == "attention_mask":
                add_qk = add_mask.input[1]
            else:
                # 4D Add after Q x K'
                add_qk_nodes = self.model.match_parent_path(
                    add_mask,
                    [
                        "Where",
                        "Sub",
                        "Cast",
                        "Expand",
                        "Unsqueeze",
                        "Unsqueeze",
                        "Reshape",
                        "Reshape",
                        "Cast",
                    ],
                    [1, 2, 1, 0, 0, 0, 0, 0, 0],
                )
                if add_qk_nodes is not None:
                    add_qk = add_mask.input[1]
                else:
                    # Here we do not match the whole subgraph since it is very complex. Instead, we just check whether a key path
                    # of computing causal mask.
                    causal_mask_nodes_1 = self.model.match_parent_path(
                        add_mask,
                        ["Concat", "Expand", "Unsqueeze", "Unsqueeze", "Where", "Less"],
                        [causal_mask_input_index, 0, 0, 0, 0, 0],
                    )
                    # If the model is exported with batch_size == 1, there is no Concat node
                    causal_mask_nodes_2 = self.model.match_parent_path(
                        add_mask,
                        ["Expand", "Unsqueeze", "Unsqueeze", "Where", "Less"],
                        [causal_mask_input_index, 0, 0, 0, 0],
                    )

                    if causal_mask_nodes_1 is None and causal_mask_nodes_2 is None:
                        logger.debug("fuse_attention: failed to match causal mask subgraph")
                        return

        new_node = self.create_attention_node(
            mask_index=None,
            q_matmul=matmul_q,
            k_matmul=matmul_k,
            v_matmul=matmul_v,
            q_add=add_q,
            k_add=add_k,
            v_add=add_v,
            num_heads=num_heads,
            hidden_size=hidden_size,
            first_input=root_input,
            output=attention_last_node.output[0],
            add_qk_str=add_qk,
            scale=None,
            causal=(causal_mask_nodes_1 is not None) or (causal_mask_nodes_2 is not None),
        )
        if new_node is None:
            logger.debug("fuse_attention: failed to create fused node")
            return

        self.nodes_to_add.append(new_node)
        self.node_name_to_graph_name[new_node.name] = self.this_graph_name
        self.nodes_to_remove.extend([attention_last_node, transpose_qkv])

        # Use prune graph to remove nodes since they are shared by all attention nodes.
        self.prune_graph = True
