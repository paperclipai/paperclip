# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
import logging

import numpy as np
from fusion_attention import AttentionMask, FusionAttention
from onnx import helper
from onnx_model import OnnxModel

logger = logging.getLogger(__name__)


class FusionBartAttention(FusionAttention):
    """
    Fuse Bart Attention subgraph into one Attention node.
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
            [1, 1, 0, 0, 0],
        )

        # For LayerNormalization (when SkipLayerNorm fusion doesn't run, e.g. SDPA models where
        # symbolic shape inference fails), there's an extra Add node for the residual connection
        # between the LayerNorm and the attention output path.
        add_before_layernorm = None
        if qkv_nodes is None:
            qkv_nodes_with_residual = self.model.match_parent_path(
                normalize_node,
                ["Add", "Add", "MatMul", "Reshape", "Transpose", "MatMul"],
                [0, None, 0, 0, 0, 0],
            )
            if qkv_nodes_with_residual is not None:
                add_before_layernorm = qkv_nodes_with_residual[0]
                qkv_nodes = qkv_nodes_with_residual[1:]

        if qkv_nodes is not None:
            (
                add_out,
                matmul_out,
                reshape_qkv,
                transpose_qkv,
                matmul_qkv,
            ) = qkv_nodes
        else:
            logger.debug("fuse_attention: failed to match qkv path")
            return

        if add_before_layernorm is not None:
            # LayerNorm case: root_input is the non-attention input of the residual Add
            if add_before_layernorm.input[0] == add_out.output[0]:
                root_input = add_before_layernorm.input[1]
            else:
                root_input = add_before_layernorm.input[0]
        else:
            other_inputs = []
            for input_ in normalize_node.input:
                if input_ not in output_name_to_node:
                    continue
                if input_ == qkv_nodes[0].output[0]:
                    continue
                other_inputs.append(input_)
            if len(other_inputs) != 1:
                return
            root_input = other_inputs[0]

        # Sometimes the input name to the attention MatMul nodes does not match the input name to the end
        # SkipLayerNormalization node (name saved in root_input). We find the true input name to the MatMul
        # nodes by getting the initial SkipLayerNormalization node and checking how many MatMul nodes are
        # children nodes for each of its output names.
        """
                                        root_input
                    +---------------------------------------------------+
                    |                                                   |
                    |                                                   |
        SkipLayerNormalization --> Attention --> MatMul --> SkipLayerNormalization
        """
        skip_layernorm = output_name_to_node[root_input]
        # For some attention blocks, the end SkipLayerNormalization node may point to another node whose
        # child is the LayerNormalization node.
        if skip_layernorm.op_type in {"Add", "Clip"}:
            skip_layernorm = self.model.get_children(skip_layernorm)[0]
        for output in skip_layernorm.output:
            if not output:
                continue
            children = input_name_to_nodes[output]
            children_types = [child.op_type for child in children]
            if children_types.count("MatMul") >= 1:
                root_input = output
                break

        graph_input_names = {node.name for node in self.model.graph().input}
        graph_output_names = {node.name for node in self.model.graph().output}

        v_nodes_past_or_present = self.model.match_parent_path(
            matmul_qkv,
            ["Transpose", "Reshape", "Add", "MatMul"],
            [1, 0, 0, None],
        )
        v_nodes_with_past = self.model.match_parent_path(
            matmul_qkv,
            ["Concat", "Transpose", "Reshape", "Add", "MatMul"],
            [1, 1, 0, 0, None],
        )
        v_nodes_past_only_oai = self.model.match_parent_path(
            matmul_qkv,
            ["Transpose", "Reshape", "Reshape", "Transpose"],
            [1, 0, 0, 0],
        )
        past_v, present_v = "", ""
        v_nodes, add_v, matmul_v = [], None, None
        if v_nodes_past_or_present is not None:
            v_nodes = v_nodes_past_or_present
            (transpose_v, reshape_v, add_v, matmul_v) = v_nodes

            # Find past_v input name
            start_child_nodes = input_name_to_nodes[add_v.output[0]]
            for start_child_node in start_child_nodes:
                if start_child_node.op_type == "Concat":
                    concat_v_nodes = self.model.match_parent_path(
                        start_child_node,
                        ["Reshape", "Transpose"],
                        [0, 0],
                    )
                    if concat_v_nodes is not None:
                        past_v = concat_v_nodes[-1].input[0]
                    start_child_nodes = input_name_to_nodes[start_child_node.output[0]]
                    break

            # Find present_v output name
            for start_child_node in start_child_nodes:
                start_grandchild_nodes = input_name_to_nodes[start_child_node.output[0]]
                for start_grandchild_node in start_grandchild_nodes:
                    if start_grandchild_node.output[0] in graph_output_names:
                        present_v = start_grandchild_node.output[0]
                        break
                if present_v != "":
                    break
        elif v_nodes_with_past is not None:
            v_nodes = v_nodes_with_past
            (concat_v, transpose_v, reshape_v, add_v, matmul_v) = v_nodes
            past_v = concat_v.input[0]
            present_v = concat_v.output[0]
        elif matmul_qkv.input[1] in graph_input_names:
            # Hugging Face's cross-attention where past_v is used directly as value
            past_v = matmul_qkv.input[1]
        elif v_nodes_past_only_oai is not None:
            # OpenAI's cross-attention where past_v is used directly as value
            v_nodes = v_nodes_past_only_oai
            past_v = v_nodes[-1].input[0]
        else:
            logger.debug("fuse_attention: failed to match v path")
            return
        past_v = past_v if past_v in graph_input_names else ""
        present_v = present_v if present_v in graph_output_names else ""

        qk_nodes_no_mask = self.model.match_parent_path(matmul_qkv, ["Softmax", "MatMul"], [0, 0])
        qk_nodes_with_mask = self.model.match_parent_path(matmul_qkv, ["Softmax", "Add", "MatMul"], [0, 0, 0])
        # SDPA: NaN guard (Where(IsNaN, 0, softmax)) wraps the Softmax output.
        # Where input[2] is the Softmax output (value when condition is False).
        qk_nodes_sdpa_no_mask = self.model.match_parent_path(matmul_qkv, ["Where", "Softmax", "MatMul"], [0, 2, 0])
        qk_nodes_sdpa_with_mask = self.model.match_parent_path(
            matmul_qkv, ["Where", "Softmax", "Add", "MatMul"], [0, 2, 0, 0]
        )
        qk_nodes, add_qk = [], None
        if qk_nodes_no_mask is not None:
            _, matmul_qk = qk_nodes_no_mask
            qk_nodes = qk_nodes_no_mask
        elif qk_nodes_with_mask is not None:
            _, add_qk, matmul_qk = qk_nodes_with_mask
            qk_nodes = qk_nodes_with_mask
        elif qk_nodes_sdpa_no_mask is not None:
            _, _, matmul_qk = qk_nodes_sdpa_no_mask
            qk_nodes = qk_nodes_sdpa_no_mask
        elif qk_nodes_sdpa_with_mask is not None:
            _, _, add_qk, matmul_qk = qk_nodes_sdpa_with_mask
            qk_nodes = qk_nodes_sdpa_with_mask
        else:
            logger.debug("fuse_attention: failed to match qk path")
            return

        q_nodes_hf = self.model.match_parent_path(
            matmul_qk,
            ["Transpose", "Reshape", "Mul", "Add", "MatMul"],
            [0, 0, 0, 0, 1],
        )
        q_nodes_oai = self.model.match_parent_path(
            matmul_qk,
            ["Mul", "Transpose", "Reshape", "Add", "MatMul"],
            [0, 0, 0, 0, 1],
        )
        # SDPA: Mul(scale) applied before Transpose, MatMul may be at any Add input.
        q_nodes_sdpa = self.model.match_parent_path(
            matmul_qk,
            ["Mul", "Transpose", "Reshape", "Add", "MatMul"],
            [0, 0, 0, 0, None],
        )
        q_nodes = []
        if q_nodes_hf is not None:
            q_nodes = q_nodes_hf
            (transpose_q, reshape_q, mul_q, add_q, matmul_q) = q_nodes
        elif q_nodes_oai is not None:
            q_nodes = q_nodes_oai
            (mul_q, transpose_q, reshape_q, add_q, matmul_q) = q_nodes
        elif q_nodes_sdpa is not None:
            q_nodes = q_nodes_sdpa
            (mul_q, transpose_q, reshape_q, add_q, matmul_q) = q_nodes
        else:
            logger.debug("fuse_attention: failed to match q path")
            return

        k_nodes_no_past_hf = self.model.match_parent_path(
            matmul_qk,
            ["Transpose", "Reshape", "MatMul"],
            [1, 0, 0],
        )
        k_nodes_with_past_hf = self.model.match_parent_path(
            matmul_qk,
            ["Transpose", "Concat", "Transpose", "Reshape", "MatMul"],
            [1, 0, 1, 0, 0],
        )
        k_nodes_past_or_present_oai = self.model.match_parent_path(
            matmul_qk,
            ["Mul", "Transpose", "Reshape", "MatMul"],
            [1, 0, 0, 0],
        )
        k_nodes_past_only_oai = self.model.match_parent_path(
            matmul_qk,
            ["Mul", "Transpose", "Reshape", "Reshape", "Transpose"],
            [1, 0, 0, 0, 0],
        )
        # SDPA: K is scaled (Mul) and transposed via Reshape->Transpose(0,2,1)->Reshape chain.
        k_nodes_sdpa = self.model.match_parent_path(
            matmul_qk,
            ["Mul", "Reshape", "Transpose", "Reshape", "Transpose", "Reshape", "Add", "MatMul"],
            [1, 0, 0, 0, 0, 0, 0, None],
        )
        past_k, present_k = "", ""
        k_nodes, add_k, matmul_k = [], None, None
        if k_nodes_no_past_hf is not None:
            k_nodes = k_nodes_no_past_hf
            (transpose_k, reshape_k, matmul_k) = k_nodes

            # Find present_k output name
            transpose_k_nodes = input_name_to_nodes[reshape_k.output[0]]
            for transpose_k_node in transpose_k_nodes:
                if transpose_k_node.output[0] in graph_output_names:
                    present_k = transpose_k_node.output[0]
                    break
        elif k_nodes_with_past_hf is not None:
            k_nodes = k_nodes_with_past_hf
            (_, concat_k, transpose_k, reshape_k, matmul_k) = k_nodes
            past_k = concat_k.input[0]
            present_k = concat_k.output[0]
        elif output_name_to_node[matmul_qk.input[1]].input[0] in graph_input_names:
            # Hugging Face's cross-attention where past_k is used directly as key
            k_nodes = [output_name_to_node[matmul_qk.input[1]]]
            past_k = k_nodes[0].input[0]
        elif k_nodes_sdpa is not None:
            k_nodes = k_nodes_sdpa
            (_, _, _, _, transpose_k, reshape_k, add_k, matmul_k) = k_nodes
        elif k_nodes_past_or_present_oai is not None:
            k_nodes = k_nodes_past_or_present_oai
            (_, transpose_k, reshape_k, matmul_k) = k_nodes

            # Find past_k input name
            start_child_nodes = input_name_to_nodes[matmul_k.output[0]]
            for start_child_node in start_child_nodes:
                if start_child_node.op_type == "Concat":
                    concat_k_nodes = self.model.match_parent_path(
                        start_child_node,
                        ["Reshape", "Transpose"],
                        [0, 0],
                    )
                    if concat_k_nodes is not None:
                        past_k = concat_k_nodes[-1].input[0]
                    start_child_nodes = input_name_to_nodes[start_child_node.output[0]]
                    break

            # Find present_k output name
            for start_child_node in start_child_nodes:
                start_grandchild_nodes = input_name_to_nodes[start_child_node.output[0]]
                for start_grandchild_node in start_grandchild_nodes:
                    if start_grandchild_node.output[0] in graph_output_names:
                        present_k = start_grandchild_node.output[0]
                        break
                if present_k != "":
                    break
        elif k_nodes_past_only_oai is not None:
            # OpenAI's cross-attention where past_k is used directly as key
            k_nodes = k_nodes_past_only_oai
            past_k = k_nodes[-1].input[0]
        else:
            logger.debug("fuse_attention: failed to match k path")
            return
        past_k = past_k if past_k in graph_input_names else ""
        present_k = present_k if present_k in graph_output_names else ""

        if matmul_k is not None and add_k is None:
            # Create empty Add node for attention graph
            add_v_tensor = self.model.get_initializer(add_v.input[0])
            bias_dim = add_v_tensor.dims[0]
            dtype = add_v_tensor.data_type
            empty_bias_name = "empty_bias"
            empty_tensor = self.model.get_initializer(empty_bias_name)
            if empty_tensor is None:
                self.add_initializer(
                    empty_bias_name,
                    dtype,
                    dims=[bias_dim],
                    vals=np.array([0.0] * bias_dim, dtype=helper.tensor_dtype_to_np_dtype(dtype)),
                )

            add_name = self.model.create_node_name("Add")
            add_k = helper.make_node("Add", [empty_bias_name, matmul_k.output[0]], [reshape_k.name], add_name)

        three_root_inputs = bool(past_k) and bool(past_v) and matmul_k is None and matmul_v is None
        one_root_input = (
            not three_root_inputs
            and matmul_q.input[0] == root_input
            and matmul_k.input[0] == root_input
            and matmul_v.input[0] == root_input
        )
        two_root_inputs = (
            not three_root_inputs
            and matmul_q.input[0] == root_input
            and matmul_k.input[0] == matmul_v.input[0]
            and matmul_k.input[0] != matmul_q.input[0]
        )

        # There are 5 types of attention:
        # 1) Encoder attention with one_root_input=True and no mask
        # 2) Decoder self attention with one_root_input=True and has mask
        # 3) Decoder cross attention with two_root_inputs=True and no mask
        # 4) Decoder self attention with past with one_root_input=True and has mask and past_k and past_v
        # 5) Decoder cross attention with past with three_root_inputs=True and no mask
        # Derive mask presence from which QK pattern matched rather than re-walking the graph.
        # This reuses the result of match_parent_paths above, which already tried both masked and
        # unmasked variants and returned the first successful match.
        has_mask = qk_nodes in (qk_nodes_with_mask, qk_nodes_sdpa_with_mask)
        no_mask = not has_mask
        encoder_attention = one_root_input and no_mask
        decoder_self_attention = one_root_input and has_mask
        decoder_cross_attention = two_root_inputs and no_mask
        decoder_self_attention_with_past = decoder_self_attention and bool(past_k) and bool(past_v)
        decoder_cross_attention_with_past = three_root_inputs and no_mask

        # For decoder self-attentions, the attention mask needs to be included in the attention node
        causal_mask = has_mask
        mask_nodes = []
        if causal_mask:
            mask_nodes_bart = self.model.match_parent_path(
                add_qk,
                ["Where"],
                [1],
            )
            mask_nodes_whisper_hf = self.model.match_parent_path(
                add_qk,
                ["Slice", "Expand", "Where"],
                [1, 0, 1],
            )
            mask_nodes_whisper_oai = self.model.match_parent_path(
                add_qk,
                ["Slice", "Unsqueeze", "Gather", "Shape", "Add"],
                [1, 2, 0, 0, 0],
            )
            mask_nodes_whisper_oai_unit_test = self.model.match_parent_path(
                add_qk,
                ["Slice", "Slice"],
                [1, 0],
            )
            if mask_nodes_whisper_hf is not None:
                mask_nodes = mask_nodes_whisper_hf
            elif mask_nodes_whisper_oai is not None:
                mask_nodes = mask_nodes_whisper_oai
            elif mask_nodes_whisper_oai_unit_test is not None:
                mask_nodes = mask_nodes_whisper_oai_unit_test
            elif mask_nodes_bart is not None:
                mask_nodes = mask_nodes_bart
            else:
                logger.debug("fuse_attention: failed to match mask nodes")
                return
            assert len(mask_nodes) > 0

        if (
            encoder_attention
            or decoder_self_attention
            or decoder_cross_attention
            or decoder_self_attention_with_past
            or decoder_cross_attention_with_past
        ):
            attention_last_node = reshape_qkv
            num_heads, hidden_size = self.get_num_heads_and_hidden_size(reshape_q)

            # Fall back to user-specified values when detected values are invalid
            # (e.g., SDPA models use -1 in reshape shapes for dynamic dimensions).
            if (num_heads <= 0 or hidden_size <= 0) and self.num_heads > 0 and self.hidden_size > 0:
                logger.debug(
                    "fuse_attention: reshape dims invalid (num_heads=%d, hidden_size=%d), "
                    "falling back to user-specified num_heads=%d, hidden_size=%d",
                    num_heads,
                    hidden_size,
                    self.num_heads,
                    self.hidden_size,
                )
                num_heads = self.num_heads
                hidden_size = self.hidden_size

            if num_heads <= 0 or hidden_size <= 0 or (hidden_size % num_heads) != 0:
                logger.debug("fuse_attention: failed to detect num_heads or hidden_size")
                return

            new_node = None
            if decoder_self_attention_with_past or decoder_cross_attention or decoder_cross_attention_with_past:
                # Note: Decoder attention with past key and past value is fused as multi-head attention
                # rather than attention because multi-head attention supports separate past key and past
                # value whereas attention supports concatenated past key and past value.
                new_node = (
                    self.create_multihead_attention_node(
                        q_matmul=matmul_q,
                        k_matmul=matmul_k if decoder_cross_attention or decoder_self_attention_with_past else past_k,
                        v_matmul=matmul_v if decoder_cross_attention or decoder_self_attention_with_past else past_v,
                        q_add=add_q,
                        k_add=add_k if decoder_cross_attention or decoder_self_attention_with_past else None,
                        v_add=add_v if decoder_cross_attention or decoder_self_attention_with_past else None,
                        num_heads=num_heads,
                        hidden_size=hidden_size,
                        output=attention_last_node.output[0],
                        unidirectional=causal_mask,
                        past_k=past_k if decoder_self_attention_with_past else "",
                        past_v=past_v if decoder_self_attention_with_past else "",
                        present_k=present_k,
                        present_v=present_v,
                    )
                    if self.use_multi_head_attention
                    else None
                )
            else:
                # Temporarily set multi-head attention flag to false
                use_multi_head_attention_ground_truth = self.use_multi_head_attention
                self.use_multi_head_attention = False
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
                    causal=causal_mask,
                    past_k=past_k,
                    past_v=past_v,
                    present_k=present_k,
                    present_v=present_v,
                )
                self.use_multi_head_attention = use_multi_head_attention_ground_truth
            if new_node is None:
                logger.debug("fuse_attention: failed to create fused node")
                return

            self.nodes_to_add.append(new_node)
            self.node_name_to_graph_name[new_node.name] = self.this_graph_name

            self.nodes_to_remove.extend([attention_last_node, transpose_qkv, matmul_qkv])
            self.nodes_to_remove.extend(qk_nodes)

            # When using multi-head attention, keep MatMul nodes in original graph
            if decoder_self_attention_with_past or decoder_cross_attention or decoder_cross_attention_with_past:
                if len(q_nodes) > 0 and q_nodes[-1].op_type == "MatMul":
                    q_nodes.pop()
                if len(k_nodes) > 0 and k_nodes[-1].op_type == "MatMul":
                    k_nodes.pop()
                if len(v_nodes) > 0 and v_nodes[-1].op_type == "MatMul":
                    v_nodes.pop()
                if self.disable_multi_head_attention_bias:
                    if len(q_nodes) > 0 and q_nodes[-1].op_type == "Add":
                        q_nodes.pop()
                    if len(k_nodes) > 0 and k_nodes[-1].op_type == "Add":
                        k_nodes.pop()
                    if len(v_nodes) > 0 and v_nodes[-1].op_type == "Add":
                        v_nodes.pop()

            self.nodes_to_remove.extend(q_nodes)
            self.nodes_to_remove.extend(k_nodes)
            self.nodes_to_remove.extend(v_nodes)

            # Use prune graph to remove mask nodes since they are shared by all attention nodes.
            self.prune_graph = True
