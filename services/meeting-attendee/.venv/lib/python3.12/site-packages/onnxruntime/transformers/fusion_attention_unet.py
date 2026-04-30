# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
from logging import getLogger

import numpy as np
from fusion_base import Fusion
from fusion_utils import NumpyHelper
from onnx import NodeProto, TensorProto, helper
from onnx_model import OnnxModel

logger = getLogger(__name__)


class FusionAttentionUnet(Fusion):
    """
    Fuse Attention subgraph of UNet into one Attention node.
    """

    def __init__(
        self,
        model: OnnxModel,
        hidden_size: int,
        num_heads: int,
        is_cross_attention: bool,
        enable_packed_qkv: bool,
        enable_packed_kv: bool,
    ):
        super().__init__(
            model,
            "Attention" if is_cross_attention and enable_packed_qkv else "MultiHeadAttention",
            ["LayerNormalization"],
        )
        self.hidden_size = hidden_size
        self.num_heads = num_heads
        self.is_cross_attention = is_cross_attention

        # Note: pack Q/K/V or K/V weights into one tensor make it harder for updating initializers for LoRA.
        # To support LoRA, it is better to use separated Q, K and V inputs in offline optimization,
        # and CUDA operator pre-packs those tensors to preferred format based on available kernels.
        # In this way, we can support LoRA and get optimal performance at same time.
        self.enable_packed_qkv = enable_packed_qkv
        self.enable_packed_kv = enable_packed_kv

        # Flags to show warning only once
        self.num_heads_warning = True
        self.hidden_size_warning = True

    def get_num_heads(self, reshape_q: NodeProto, is_torch2: bool = False) -> int:
        """Detect num_heads from a reshape node.

        Args:
            reshape_q (NodeProto): reshape node for Q
            is_torch2 (bool): graph pattern is from PyTorch 2.*
        Returns:
            int: num_heads, or 0 if not found
        """
        num_heads = 0
        if is_torch2:
            # we assume that reshape fusion has done, so the shape is a tensor like [0, 0, num_heads, head_size]
            reshape_parent = self.model.get_parent(reshape_q, 1)
            if reshape_parent and reshape_parent.op_type == "Concat" and len(reshape_parent.input) == 4:
                num_heads = self.model.get_constant_value(reshape_parent.input[2])
                if isinstance(num_heads, np.ndarray) and list(num_heads.shape) == [1]:
                    num_heads = int(num_heads)
        else:
            # we assume that reshape fusion has done, so the shape is a tensor like [0, 0, num_heads, head_size]
            q_shape_value = self.model.get_constant_value(reshape_q.input[1])
            if isinstance(q_shape_value, np.ndarray) and list(q_shape_value.shape) == [4]:
                num_heads = int(q_shape_value[2])

        if isinstance(num_heads, int) and num_heads > 0:
            return num_heads

        return 0

    def get_hidden_size(self, layernorm_node):
        """Detect hidden_size from LayerNormalization node.
        Args:
            layernorm_node (NodeProto): LayerNormalization node before Q, K and V
        Returns:
            int: hidden_size, or 0 if not found
        """
        layernorm_bias = self.model.get_initializer(layernorm_node.input[2])
        if layernorm_bias:
            return NumpyHelper.to_array(layernorm_bias).shape[0]

        return 0

    def get_num_heads_and_hidden_size(
        self, reshape_q: NodeProto, layernorm_node: NodeProto, is_torch2: bool = False
    ) -> tuple[int, int]:
        """Detect num_heads and hidden_size.

        Args:
            reshape_q (NodeProto): reshape node for Q
            is_torch2 (bool): graph pattern is from PyTorch 2.*
            layernorm_node (NodeProto): LayerNormalization node before Q, K, V
        Returns:
            Tuple[int, int]: num_heads and hidden_size
        """
        num_heads = self.get_num_heads(reshape_q, is_torch2)
        if num_heads <= 0:
            num_heads = self.num_heads  # Fall back to user specified value

        if self.num_heads > 0 and num_heads != self.num_heads:
            if self.num_heads_warning:
                logger.warning(f"--num_heads is {self.num_heads}. Detected value is {num_heads}. Using detected value.")
                self.num_heads_warning = False  # Do not show the warning more than once

        hidden_size = self.get_hidden_size(layernorm_node)
        if hidden_size <= 0:
            hidden_size = self.hidden_size  # Fall back to user specified value

        if self.hidden_size > 0 and hidden_size != self.hidden_size:
            if self.hidden_size_warning:
                logger.warning(
                    f"--hidden_size is {self.hidden_size}. Detected value is {hidden_size}. Using detected value."
                )
                self.hidden_size_warning = False  # Do not show the warning more than once

        return num_heads, hidden_size

    def create_attention_node(
        self,
        q_matmul: NodeProto,
        k_matmul: NodeProto,
        v_matmul: NodeProto,
        num_heads: int,
        hidden_size: int,
        input: str,
        output: str,
    ) -> NodeProto | None:
        """Create an Attention node.

        Args:
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
        is_self_attention = not self.is_cross_attention

        if is_self_attention:
            if q_matmul.input[0] != input or k_matmul.input[0] != input or v_matmul.input[0] != input:
                logger.debug(
                    "For self attention, input hidden state for q and k/v shall be same. Got %s, %s, %s",
                    q_matmul.input[0],
                    k_matmul.input[0],
                    v_matmul.input[0],
                )
                return None
        else:
            if q_matmul.input[0] != input or (k_matmul.input[0] != v_matmul.input[0]) or (k_matmul.input[0] == input):
                logger.debug(
                    "For cross attention, input hidden state for q and k/v shall be different. Got %s, %s, %s",
                    q_matmul.input[0],
                    k_matmul.input[0],
                    v_matmul.input[0],
                )
                return None

        if hidden_size > 0 and (hidden_size % num_heads) != 0:
            logger.debug(f"input hidden size {hidden_size} is not a multiple of num of heads {num_heads}")
            return None

        q_weight = self.model.get_initializer(q_matmul.input[1])
        k_weight = self.model.get_initializer(k_matmul.input[1])
        v_weight = self.model.get_initializer(v_matmul.input[1])
        if not (q_weight and k_weight and v_weight):
            return None

        # Sometimes weights are stored in fp16
        float_type = q_weight.data_type

        qw = NumpyHelper.to_array(q_weight)
        kw = NumpyHelper.to_array(k_weight)
        vw = NumpyHelper.to_array(v_weight)
        logger.debug(f"qw={qw.shape} kw={kw.shape} vw={vw.shape} hidden_size={hidden_size}")

        # assert q and k have same shape as expected
        if is_self_attention:
            if qw.shape != kw.shape or qw.shape != vw.shape:
                return None

            qw_in_size = qw.shape[0]

            if hidden_size > 0 and hidden_size != qw_in_size:
                raise ValueError(
                    f"Input hidden size ({hidden_size}) is not same as weight dimension of q,k,v ({qw_in_size}). "
                    "Please provide a correct input hidden size or pass in 0"
                )

            # All the matrices can have the same shape or q, k matrics can have the same shape with v being different
            # For 2d weights, the shapes would be [in_size, out_size].
            # For 3d weights, shape would be [in_size, a, b] where a*b = out_size
            qw_out_size = int(np.prod(qw.shape[1:]))

            if self.enable_packed_qkv:
                attention_node_name = self.model.create_node_name("MultiHeadAttention")

                c = qw_in_size
                n = num_heads
                h = qw_out_size // num_heads

                # Concat and interleave weights so that the output of fused KV GEMM has [B, S_kv, N, 3, H] shape
                qkv_weight = np.dstack([qw.reshape(c, n, h), kw.reshape(c, n, h), vw.reshape(c, n, h)]).reshape(
                    c, n * 3 * h
                )

                matmul_node_name = self.model.create_node_name("MatMul", name_prefix="MatMul_QKV")
                self.add_initializer(
                    name=matmul_node_name + "_weight",
                    data_type=float_type,
                    dims=[qkv_weight.shape[0], qkv_weight.shape[1]],
                    vals=qkv_weight,
                )

                matmul_node = helper.make_node(
                    "MatMul",
                    inputs=[k_matmul.input[0], matmul_node_name + "_weight"],
                    outputs=[matmul_node_name + "_out"],
                    name=matmul_node_name,
                )
                self.node_name_to_graph_name[matmul_node.name] = self.this_graph_name

                self.add_initializer(
                    name=matmul_node_name + "_reshape_shape",
                    data_type=TensorProto.INT64,
                    dims=[5],
                    vals=[0, 0, n, 3, h],
                    raw=False,
                )

                reshape_node = helper.make_node(
                    "Reshape",
                    inputs=[
                        matmul_node_name + "_out",
                        matmul_node_name + "_reshape_shape",
                    ],
                    outputs=[attention_node_name + "_qkv_input"],
                    name=matmul_node_name + "_reshape",
                )
                self.node_name_to_graph_name[reshape_node.name] = self.this_graph_name
                self.nodes_to_add.extend([matmul_node, reshape_node])
                self.nodes_to_remove.extend([q_matmul, k_matmul, v_matmul])

            else:
                qkv_weight = np.stack((qw, kw, vw), axis=1)
                qkv_weight_dim = 3 * qw_out_size

                attention_node_name = self.model.create_node_name("Attention")

                self.add_initializer(
                    name=attention_node_name + "_qkv_weight",
                    data_type=float_type,
                    dims=[qw_in_size, qkv_weight_dim],
                    vals=qkv_weight,
                )
        else:  # cross attention
            attention_node_name = self.model.create_node_name("MultiHeadAttention")
            if self.enable_packed_kv:
                if kw.shape != vw.shape:
                    return None

                kw_in_size = kw.shape[0]
                vw_in_size = vw.shape[0]
                assert kw_in_size == vw_in_size

                qw_out_size = qw.shape[1]
                kw_out_size = kw.shape[1]
                vw_out_size = vw.shape[1]
                assert qw_out_size == vw_out_size and kw_out_size == vw_out_size

                c = kw_in_size
                n = num_heads
                h = kw_out_size // num_heads

                # Concat and interleave weights so that the output of fused KV GEMM has [B, S_kv, N, 2, H] shape
                kv_weight = np.dstack([kw.reshape(c, n, h), vw.reshape(c, n, h)]).reshape(c, n * 2 * h)

                matmul_node_name = self.model.create_node_name("MatMul", name_prefix="MatMul_KV")
                self.add_initializer(
                    name=matmul_node_name + "_weight",
                    data_type=float_type,
                    dims=[kv_weight.shape[0], kv_weight.shape[1]],
                    vals=kv_weight,
                )

                matmul_node = helper.make_node(
                    "MatMul",
                    inputs=[k_matmul.input[0], matmul_node_name + "_weight"],
                    outputs=[matmul_node_name + "_out"],
                    name=matmul_node_name,
                )
                self.node_name_to_graph_name[matmul_node.name] = self.this_graph_name

                self.add_initializer(
                    name=matmul_node_name + "_reshape_shape",
                    data_type=TensorProto.INT64,
                    dims=[5],
                    vals=[0, 0, n, 2, h],
                    raw=False,
                )

                reshape_node = helper.make_node(
                    "Reshape",
                    inputs=[
                        matmul_node_name + "_out",
                        matmul_node_name + "_reshape_shape",
                    ],
                    outputs=[attention_node_name + "_kv_input"],
                    name=matmul_node_name + "_reshape",
                )
                self.node_name_to_graph_name[reshape_node.name] = self.this_graph_name
                self.nodes_to_add.extend([matmul_node, reshape_node])
                self.nodes_to_remove.extend([k_matmul, v_matmul])

        # No bias, use zeros
        qkv_bias = np.zeros([3, hidden_size], dtype=np.float32)
        qkv_bias_dim = 3 * hidden_size

        self.add_initializer(
            name=attention_node_name + "_qkv_bias",
            data_type=float_type,
            dims=[qkv_bias_dim],
            vals=qkv_bias,
        )

        if is_self_attention:
            if not self.enable_packed_qkv:
                attention_inputs = [
                    input,
                    attention_node_name + "_qkv_weight",
                    attention_node_name + "_qkv_bias",
                ]
            else:
                attention_inputs = [attention_node_name + "_qkv_input"]
        else:
            if not self.enable_packed_kv:
                attention_inputs = [
                    q_matmul.output[0],
                    k_matmul.output[0],
                    v_matmul.output[0],
                    attention_node_name + "_qkv_bias",
                ]
            else:
                attention_inputs = [
                    q_matmul.output[0],
                    attention_node_name + "_kv_input",
                ]

        attention_node = helper.make_node(
            "Attention" if (is_self_attention and not self.enable_packed_qkv) else "MultiHeadAttention",
            inputs=attention_inputs,
            outputs=[output],
            name=attention_node_name,
        )
        attention_node.domain = "com.microsoft"
        attention_node.attribute.extend([helper.make_attribute("num_heads", num_heads)])

        counter_name = (
            "Attention (self attention)"
            if is_self_attention and not self.enable_packed_qkv
            else "MultiHeadAttention ({})".format(
                "self attention with packed qkv"
                if self.enable_packed_qkv
                else "cross attention with packed kv"
                if self.enable_packed_kv
                else "cross attention"
            )
        )
        self.increase_counter(counter_name)
        return attention_node

    def create_attention_node_lora(
        self,
        q_matmul_add: NodeProto,
        k_matmul_add: NodeProto,
        v_matmul_add: NodeProto,
        num_heads: int,
        hidden_size: int,
        input: str,
        output: str,
    ) -> NodeProto | None:
        """Create an Attention node.

        Args:
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
        is_self_attention = not self.is_cross_attention

        q_matmul = self.model.match_parent(q_matmul_add, "MatMul", 0)
        k_matmul = self.model.match_parent(k_matmul_add, "MatMul", 0)
        v_matmul = self.model.match_parent(v_matmul_add, "MatMul", 0)

        q_lora_nodes = self.match_lora_path(q_matmul_add)
        if q_lora_nodes is None:
            return None
        (q_lora_last_node, q_lora_matmul_1) = q_lora_nodes

        k_lora_nodes = self.match_lora_path(k_matmul_add)
        if k_lora_nodes is None:
            return None
        (k_lora_last_node, k_lora_matmul_1) = k_lora_nodes

        v_lora_nodes = self.match_lora_path(v_matmul_add)
        if v_lora_nodes is None:
            return None
        (v_lora_last_node, v_lora_matmul_1) = v_lora_nodes

        if is_self_attention:
            if q_matmul.input[0] != input or k_matmul.input[0] != input or v_matmul.input[0] != input:
                logger.debug(
                    "For self attention, input hidden state for q and k/v shall be same. Got %s, %s, %s",
                    q_matmul.input[0],
                    k_matmul.input[0],
                    v_matmul.input[0],
                )
                return None

            if (
                q_lora_matmul_1.input[0] != input
                or k_lora_matmul_1.input[0] != input
                or v_lora_matmul_1.input[0] != input
            ):
                logger.debug(
                    "For self attention, input hidden state for LoRA q and k/v weights shall be same. Got %s, %s, %s",
                    q_lora_matmul_1.input[0],
                    k_lora_matmul_1.input[0],
                    v_lora_matmul_1.input[0],
                )
                return None
        else:
            if q_matmul.input[0] != input or (k_matmul.input[0] != v_matmul.input[0]) or (k_matmul.input[0] == input):
                logger.debug(
                    "For cross attention, input hidden state for q and k/v shall be different. Got %s, %s, %s",
                    q_matmul.input[0],
                    k_matmul.input[0],
                    v_matmul.input[0],
                )
                return None

            if (
                q_lora_matmul_1.input[0] != input
                or (k_lora_matmul_1.input[0] != v_lora_matmul_1.input[0])
                or (k_matmul.input[0] == input)
            ):
                logger.debug(
                    (
                        "For cross attention, input hidden state for LoRA q and k/v weights shall be different. "
                        "Got %s, %s, %s"
                    ),
                    q_lora_matmul_1.input[0],
                    k_lora_matmul_1.input[0],
                    v_lora_matmul_1.input[0],
                )
                return None

        if hidden_size > 0 and (hidden_size % num_heads) != 0:
            logger.debug(f"input hidden size {hidden_size} is not a multiple of num of heads {num_heads}")
            return None

        q_weight = self.model.get_initializer(q_matmul.input[1])
        k_weight = self.model.get_initializer(k_matmul.input[1])
        v_weight = self.model.get_initializer(v_matmul.input[1])
        if not (q_weight and k_weight and v_weight):
            return None

        # Sometimes weights are stored in fp16
        if q_weight.data_type == 10:
            logger.debug("weights are in fp16. Please run fp16 conversion after optimization")
            return None

        qw = NumpyHelper.to_array(q_weight)
        kw = NumpyHelper.to_array(k_weight)
        vw = NumpyHelper.to_array(v_weight)
        logger.debug(f"qw={qw.shape} kw={kw.shape} vw={vw.shape} hidden_size={hidden_size}")

        # assert q and k have same shape as expected
        if is_self_attention:
            if qw.shape != kw.shape or qw.shape != vw.shape:
                return None

            qw_in_size = qw.shape[0]

            if hidden_size > 0 and hidden_size != qw_in_size:
                raise ValueError(
                    f"Input hidden size ({hidden_size}) is not same as weight dimension of q,k,v ({qw_in_size}). "
                    "Please provide a correct input hidden size or pass in 0"
                )

            # All the matrices can have the same shape or q, k matrics can have the same shape with v being different
            # For 2d weights, the shapes would be [in_size, out_size].
            # For 3d weights, shape would be [in_size, a, b] where a*b = out_size
            qw_out_size = int(np.prod(qw.shape[1:]))

            if self.enable_packed_qkv:
                attention_node_name = self.model.create_node_name("MultiHeadAttention")

                c = qw_in_size
                n = num_heads
                h = qw_out_size // num_heads

                # Concat and interleave weights so that the output of fused KV GEMM has [B, S_kv, N, 3, H] shape
                qkv_weight = np.dstack([qw.reshape(c, n, h), kw.reshape(c, n, h), vw.reshape(c, n, h)]).reshape(
                    c, n * 3 * h
                )

                matmul_node_name = self.model.create_node_name("MatMul", name_prefix="MatMul_QKV")
                self.add_initializer(
                    name=matmul_node_name + "_weight",
                    data_type=TensorProto.FLOAT,
                    dims=[qkv_weight.shape[0], qkv_weight.shape[1]],
                    vals=qkv_weight,
                )

                matmul_node = helper.make_node(
                    "MatMul",
                    inputs=[k_matmul.input[0], matmul_node_name + "_weight"],
                    outputs=[matmul_node_name + "_out"],
                    name=matmul_node_name,
                )
                self.node_name_to_graph_name[matmul_node.name] = self.this_graph_name

                # Do the same thing with the LoRA weights, but don't constant fold the result. The goal is to allow
                # the Q/K/V weights to be changed without having to re-run the optimizer.
                lora_weight_shape_tensor_name = q_lora_last_node.name + "_reshape_shape"

                self.add_initializer(
                    name=lora_weight_shape_tensor_name,
                    data_type=TensorProto.INT64,
                    dims=[4],
                    vals=[0, 0, n, h],
                    raw=False,
                )

                # Reshape the LoRA Q weights
                q_lora_reshape_node_name = self.model.create_node_name("Reshape", name_prefix="Reshape_LoRA_Q")
                q_lora_reshape_node = helper.make_node(
                    "Reshape",
                    inputs=[q_lora_last_node.output[0], lora_weight_shape_tensor_name],
                    outputs=[q_lora_reshape_node_name + "_out"],
                    name=q_lora_reshape_node_name,
                )
                self.node_name_to_graph_name[q_lora_reshape_node.name] = self.this_graph_name

                # Reshape the LoRA K weights
                k_lora_reshape_node_name = self.model.create_node_name("Reshape", name_prefix="Reshape_LoRA_K")
                k_lora_reshape_node = helper.make_node(
                    "Reshape",
                    inputs=[k_lora_last_node.output[0], lora_weight_shape_tensor_name],
                    outputs=[k_lora_reshape_node_name + "_out"],
                    name=k_lora_reshape_node_name,
                )
                self.node_name_to_graph_name[k_lora_reshape_node.name] = self.this_graph_name

                # Reshape the LoRA V weights
                v_lora_reshape_node_name = self.model.create_node_name("Reshape", name_prefix="Reshape_LoRA_V")
                v_lora_reshape_node = helper.make_node(
                    "Reshape",
                    inputs=[v_lora_last_node.output[0], lora_weight_shape_tensor_name],
                    outputs=[v_lora_reshape_node_name + "_out"],
                    name=v_lora_reshape_node_name,
                )
                self.node_name_to_graph_name[v_lora_reshape_node.name] = self.this_graph_name

                # Concat the reshaped LoRA Q/K/V weights together on the third axis
                qkv_lora_concat_node_name = self.model.create_node_name("Concat", name_prefix="Concat_LoRA_QKV")
                qkv_lora_concat_node = helper.make_node(
                    "Concat",
                    inputs=[
                        q_lora_reshape_node.output[0],
                        k_lora_reshape_node.output[0],
                        v_lora_reshape_node.output[0],
                    ],
                    outputs=[qkv_lora_concat_node_name + "_out"],
                    name=qkv_lora_concat_node_name,
                )
                qkv_lora_concat_node.attribute.extend([helper.make_attribute("axis", 3)])
                self.node_name_to_graph_name[qkv_lora_concat_node.name] = self.this_graph_name

                # Reshape the LoRA concatenated weights to [..., n * 3 * h]
                reshaped_lora_weights_shape_tensor_name = qkv_lora_concat_node.name + "_reshape_shape"
                self.add_initializer(
                    name=reshaped_lora_weights_shape_tensor_name,
                    data_type=TensorProto.INT64,
                    dims=[3],
                    vals=[0, 0, n * 3 * h],
                    raw=False,
                )

                qkv_lora_reshaped_node_name = self.model.create_node_name("Reshape", name_prefix="Reshape_LoRA_QKV")
                qkv_lora_reshaped_node = helper.make_node(
                    "Reshape",
                    inputs=[qkv_lora_concat_node.output[0], reshaped_lora_weights_shape_tensor_name],
                    outputs=[qkv_lora_reshaped_node_name + "_out"],
                    name=qkv_lora_reshaped_node_name,
                )
                self.node_name_to_graph_name[qkv_lora_reshaped_node.name] = self.this_graph_name

                # Add the LoRA Q/K/V weights to the base Q/K/V weights
                add_weights_node_name = self.model.create_node_name("Add", name_prefix="Add_Weights_QKV")
                add_weights_node = helper.make_node(
                    "Add",
                    inputs=[qkv_lora_reshaped_node.output[0], matmul_node.output[0]],
                    outputs=[add_weights_node_name + "_out"],
                    name=add_weights_node_name,
                )
                self.node_name_to_graph_name[add_weights_node.name] = self.this_graph_name

                # Finally, reshape the concatenated Q/K/V result to 5D
                shape_tensor_name = add_weights_node_name + "_reshape_shape"
                self.add_initializer(
                    name=shape_tensor_name,
                    data_type=TensorProto.INT64,
                    dims=[5],
                    vals=[0, 0, n, 3, h],
                    raw=False,
                )

                reshape_node = helper.make_node(
                    "Reshape",
                    inputs=[add_weights_node.output[0], shape_tensor_name],
                    outputs=[attention_node_name + "_qkv_input"],
                    name=add_weights_node_name + "_reshape",
                )
                self.node_name_to_graph_name[reshape_node.name] = self.this_graph_name

                self.nodes_to_add.extend(
                    [
                        matmul_node,
                        q_lora_reshape_node,
                        k_lora_reshape_node,
                        v_lora_reshape_node,
                        qkv_lora_concat_node,
                        qkv_lora_reshaped_node,
                        add_weights_node,
                        reshape_node,
                    ]
                )
                self.nodes_to_remove.extend([q_matmul, k_matmul, v_matmul, q_matmul_add, k_matmul_add, v_matmul_add])
            else:
                # TODO: Support non-packed QKV
                return None
        else:  # cross attention
            attention_node_name = self.model.create_node_name("MultiHeadAttention")
            if self.enable_packed_kv:
                if kw.shape != vw.shape:
                    return None

                kw_in_size = kw.shape[0]
                vw_in_size = vw.shape[0]
                assert kw_in_size == vw_in_size

                qw_out_size = qw.shape[1]
                kw_out_size = kw.shape[1]
                vw_out_size = vw.shape[1]
                assert qw_out_size == vw_out_size and kw_out_size == vw_out_size

                c = kw_in_size
                n = num_heads
                h = kw_out_size // num_heads

                # Concat and interleave weights so that the output of fused KV GEMM has [B, S_kv, N, 2, H] shape
                kv_weight = np.dstack([kw.reshape(c, n, h), vw.reshape(c, n, h)]).reshape(c, n * 2 * h)

                matmul_node_name = self.model.create_node_name("MatMul", name_prefix="MatMul_KV")
                self.add_initializer(
                    name=matmul_node_name + "_weight",
                    data_type=TensorProto.FLOAT,
                    dims=[kv_weight.shape[0], kv_weight.shape[1]],
                    vals=kv_weight,
                )

                matmul_node = helper.make_node(
                    "MatMul",
                    inputs=[k_matmul.input[0], matmul_node_name + "_weight"],
                    outputs=[matmul_node_name + "_out"],
                    name=matmul_node_name,
                )
                self.node_name_to_graph_name[matmul_node.name] = self.this_graph_name

                # Do the same thing with the LoRA weights, but don't constant fold the result. The goal is to allow
                # the Q/K/V weights to be changed without having to re-run the optimizer.
                kv_lora_weight_shape_tensor_name = q_lora_last_node.name + "_reshape_shape"
                self.add_initializer(
                    name=kv_lora_weight_shape_tensor_name,
                    data_type=TensorProto.INT64,
                    dims=[4],
                    vals=[0, 0, n, h],
                    raw=False,
                )

                # Reshape the LoRA K weights
                k_lora_reshape_node_name = self.model.create_node_name("Reshape", name_prefix="Reshape_LoRA_K")
                k_lora_reshape_node = helper.make_node(
                    "Reshape",
                    inputs=[k_lora_last_node.output[0], kv_lora_weight_shape_tensor_name],
                    outputs=[k_lora_reshape_node_name + "_out"],
                    name=k_lora_reshape_node_name,
                )
                self.node_name_to_graph_name[k_lora_reshape_node.name] = self.this_graph_name

                # Reshape the LoRA V weights
                v_lora_reshape_node_name = self.model.create_node_name("Reshape", name_prefix="Reshape_LoRA_V")
                v_lora_reshape_node = helper.make_node(
                    "Reshape",
                    inputs=[v_lora_last_node.output[0], kv_lora_weight_shape_tensor_name],
                    outputs=[v_lora_reshape_node_name + "_out"],
                    name=v_lora_reshape_node_name,
                )
                self.node_name_to_graph_name[v_lora_reshape_node.name] = self.this_graph_name

                # Concat the reshaped LoRA K/V weights together on the third axis
                kv_lora_concat_node_name = self.model.create_node_name("Concat", name_prefix="Concat_LoRA_KV")
                kv_lora_concat_node = helper.make_node(
                    "Concat",
                    inputs=[k_lora_reshape_node.output[0], v_lora_reshape_node.output[0]],
                    outputs=[kv_lora_concat_node_name + "_out"],
                    name=kv_lora_concat_node_name,
                )
                kv_lora_concat_node.attribute.extend([helper.make_attribute("axis", 3)])
                self.node_name_to_graph_name[kv_lora_concat_node.name] = self.this_graph_name

                # Reshape the LoRA concatenated weights to [..., n * 2 * h]
                reshaped_kv_lora_weights_shape_tensor_name = kv_lora_concat_node.name + "_reshape_shape"
                self.add_initializer(
                    name=reshaped_kv_lora_weights_shape_tensor_name,
                    data_type=TensorProto.INT64,
                    dims=[3],
                    vals=[0, 0, n * 2 * h],
                    raw=False,
                )

                kv_lora_reshaped_node_name = self.model.create_node_name("Reshape", name_prefix="Reshape_LoRA_KV")
                kv_lora_reshaped_node = helper.make_node(
                    "Reshape",
                    inputs=[kv_lora_concat_node.output[0], reshaped_kv_lora_weights_shape_tensor_name],
                    outputs=[kv_lora_reshaped_node_name + "_out"],
                    name=kv_lora_reshaped_node_name,
                )
                self.node_name_to_graph_name[kv_lora_reshaped_node.name] = self.this_graph_name

                # Add the LoRA K/V weights to the base K/V weights
                add_kv_weights_node_name = self.model.create_node_name("Add", name_prefix="Add_Weights_KV")
                add_kv_weights_node = helper.make_node(
                    "Add",
                    inputs=[kv_lora_reshaped_node.output[0], matmul_node.output[0]],
                    outputs=[add_kv_weights_node_name + "_out"],
                    name=add_kv_weights_node_name,
                )
                self.node_name_to_graph_name[add_kv_weights_node.name] = self.this_graph_name

                # Finally, reshape the concatenated K/V result to 5D
                shape_tensor_name = add_kv_weights_node_name + "_reshape_shape"
                self.add_initializer(
                    name=shape_tensor_name,
                    data_type=TensorProto.INT64,
                    dims=[5],
                    vals=[0, 0, n, 2, h],
                    raw=False,
                )

                reshape_node = helper.make_node(
                    "Reshape",
                    inputs=[add_kv_weights_node.output[0], shape_tensor_name],
                    outputs=[attention_node_name + "_kv_input"],
                    name=add_kv_weights_node_name + "_reshape",
                )
                self.node_name_to_graph_name[reshape_node.name] = self.this_graph_name
                self.nodes_to_add.extend(
                    [
                        matmul_node,
                        k_lora_reshape_node,
                        v_lora_reshape_node,
                        kv_lora_concat_node,
                        kv_lora_reshaped_node,
                        add_kv_weights_node,
                        reshape_node,
                    ]
                )
                self.nodes_to_remove.extend([k_matmul, v_matmul, k_matmul_add, v_matmul_add])
            else:
                # TODO: Support non-packed KV
                return None

        # No bias, use zeros
        qkv_bias = np.zeros([3, hidden_size], dtype=np.float32)
        qkv_bias_dim = 3 * hidden_size
        self.add_initializer(
            name=attention_node_name + "_qkv_bias",
            data_type=TensorProto.FLOAT,
            dims=[qkv_bias_dim],
            vals=qkv_bias,
        )

        if is_self_attention:
            if not self.enable_packed_qkv:
                # TODO: Support non-packed QKV
                return None
            else:
                attention_inputs = [attention_node_name + "_qkv_input"]
        else:
            if not self.enable_packed_kv:
                # TODO: Support non-packed QKV
                return None
            else:
                attention_inputs = [
                    q_matmul_add.output[0],
                    attention_node_name + "_kv_input",
                ]

        attention_node = helper.make_node(
            "Attention" if (is_self_attention and not self.enable_packed_qkv) else "MultiHeadAttention",
            inputs=attention_inputs,
            outputs=[output],
            name=attention_node_name,
        )
        attention_node.domain = "com.microsoft"
        attention_node.attribute.extend([helper.make_attribute("num_heads", num_heads)])

        counter_name = (
            "Attention (self attention)"
            if is_self_attention and not self.enable_packed_qkv
            else "MultiHeadAttention ({})".format(
                "self attention with packed qkv"
                if self.enable_packed_qkv
                else "cross attention with packed kv"
                if self.enable_packed_kv
                else "cross attention"
            )
        )
        self.increase_counter(counter_name)
        return attention_node

    def fuse(self, normalize_node, input_name_to_nodes, output_name_to_node):
        if self.fuse_a1111_fp16(normalize_node, input_name_to_nodes, output_name_to_node):
            return

        node_before_layernorm = self.model.match_parent(normalize_node, "Add", 0)

        # In SD 1.5, for self attention, LayerNorm has parent Reshape
        if node_before_layernorm is None and not self.is_cross_attention:
            node_before_layernorm = self.model.match_parent(normalize_node, "Reshape", 0)

        if node_before_layernorm is None:
            return

        root_input = node_before_layernorm.output[0]

        children_nodes = input_name_to_nodes[root_input]
        skip_add = None
        for node in children_nodes:
            if node.op_type == "Add":  # SkipLayerNormalization fusion is not applied yet
                skip_add = node
                break
        if skip_add is None:
            return

        match_qkv = self.match_qkv_torch1(root_input, skip_add) or self.match_qkv_torch2(root_input, skip_add)
        if match_qkv is not None:
            is_torch2, reshape_qkv, transpose_qkv, reshape_q, matmul_q, matmul_k, matmul_v = match_qkv

            attention_last_node = reshape_qkv

            q_num_heads, q_hidden_size = self.get_num_heads_and_hidden_size(reshape_q, normalize_node, is_torch2)
            if q_num_heads <= 0:
                logger.debug("fuse_attention: failed to detect num_heads")
                return

            # number of heads are same for all the paths, hence to create attention node, we pass the q_num_heads
            new_node = self.create_attention_node(
                matmul_q,
                matmul_k,
                matmul_v,
                q_num_heads,
                q_hidden_size,
                input=normalize_node.output[0],
                output=attention_last_node.output[0],
            )
            if new_node is None:
                return
        else:
            # Check if we have a LoRA pattern
            match_qkv = self.match_qkv_torch1_lora(root_input, skip_add) or self.match_qkv_torch2_lora(
                root_input, skip_add
            )
            if match_qkv is None:
                return

            is_torch2, reshape_qkv, transpose_qkv, reshape_q, matmul_add_q, matmul_add_k, matmul_add_v = match_qkv

            attention_last_node = reshape_qkv

            q_num_heads, q_hidden_size = self.get_num_heads_and_hidden_size(reshape_q, normalize_node, is_torch2)
            if q_num_heads <= 0:
                logger.debug("fuse_attention: failed to detect num_heads")
                return

            # number of heads are same for all the paths, hence to create attention node, we pass the q_num_heads
            new_node = self.create_attention_node_lora(
                matmul_add_q,
                matmul_add_k,
                matmul_add_v,
                q_num_heads,
                q_hidden_size,
                input=normalize_node.output[0],
                output=attention_last_node.output[0],
            )
            if new_node is None:
                return

            q_num_heads, q_hidden_size = self.get_num_heads_and_hidden_size(reshape_q, normalize_node, is_torch2)
            if q_num_heads <= 0:
                logger.debug("fuse_attention: failed to detect num_heads")
                return

        self.nodes_to_add.append(new_node)
        self.node_name_to_graph_name[new_node.name] = self.this_graph_name

        self.nodes_to_remove.extend([attention_last_node, transpose_qkv])

        # Use prune graph to remove nodes since they are shared by all attention nodes.
        self.prune_graph = True

    def match_qkv_torch1(self, root_input, skip_add):
        """Match Q, K and V paths exported by PyTorch 1.*"""
        another_input = 1 if skip_add.input[0] == root_input else 0
        qkv_nodes = self.model.match_parent_path(
            skip_add,
            ["Add", "MatMul", "Reshape", "Transpose", "Reshape", "MatMul"],
            [another_input, None, None, 0, 0, 0],
        )

        if qkv_nodes is None:
            return None

        (_, _, reshape_qkv, transpose_qkv, _, matmul_qkv) = qkv_nodes

        # No bias. For cross-attention, the input of the MatMul is encoder_hidden_states graph input.
        v_nodes = self.model.match_parent_path(matmul_qkv, ["Reshape", "Transpose", "Reshape", "MatMul"], [1, 0, 0, 0])
        if v_nodes is None:
            logger.debug("fuse_attention: failed to match v path")
            return None
        (_, _, _, matmul_v) = v_nodes

        qk_nodes = self.model.match_parent_path(matmul_qkv, ["Softmax", "Mul", "MatMul"], [0, 0, 0])
        if qk_nodes is not None:
            (_softmax_qk, _mul_qk, matmul_qk) = qk_nodes
        else:
            qk_nodes = self.model.match_parent_path(matmul_qkv, ["Softmax", "Add", "Mul", "MatMul"], [0, 0, 0, 0])
            if qk_nodes is not None:
                (_softmax_qk, _add_zero, _mul_qk, matmul_qk) = qk_nodes
            else:
                logger.debug("fuse_attention: failed to match qk path")
                return None

        q_nodes = self.model.match_parent_path(matmul_qk, ["Reshape", "Transpose", "Reshape", "MatMul"], [0, 0, 0, 0])
        if q_nodes is None:
            logger.debug("fuse_attention: failed to match q path")
            return None
        (_, _transpose_q, reshape_q, matmul_q) = q_nodes

        k_nodes = self.model.match_parent_path(
            matmul_qk, ["Transpose", "Reshape", "Transpose", "Reshape", "MatMul"], [1, 0, 0, 0, 0]
        )
        if k_nodes is None:
            logger.debug("fuse_attention: failed to match k path")
            return None

        (_, _, _, _, matmul_k) = k_nodes

        return False, reshape_qkv, transpose_qkv, reshape_q, matmul_q, matmul_k, matmul_v

    def match_qkv_torch2(self, root_input, skip_add):
        """Match Q, K and V paths exported by PyTorch 2.*"""
        another_input = 1 if skip_add.input[0] == root_input else 0
        qkv_nodes = self.model.match_parent_path(
            skip_add,
            ["Add", "MatMul", "Reshape", "Transpose", "MatMul"],
            [another_input, None, None, 0, 0],
        )

        if qkv_nodes is None:
            return None

        (_, _, reshape_qkv, transpose_qkv, matmul_qkv) = qkv_nodes

        v_nodes = self.model.match_parent_path(matmul_qkv, ["Transpose", "Reshape", "MatMul"], [1, 0, 0])
        if v_nodes is None:
            logger.debug("fuse_attention: failed to match v path")
            return None
        (_, _, matmul_v) = v_nodes

        qk_nodes = self.model.match_parent_path(matmul_qkv, ["Softmax", "MatMul"], [0, 0])
        if qk_nodes is not None:
            (_softmax_qk, matmul_qk) = qk_nodes
        else:
            logger.debug("fuse_attention: failed to match qk path")
            return None

        q_nodes = self.model.match_parent_path(matmul_qk, ["Mul", "Transpose", "Reshape", "MatMul"], [0, None, 0, 0])
        if q_nodes is None:
            logger.debug("fuse_attention: failed to match q path")
            return None
        (mul_q, _transpose_q, reshape_q, matmul_q) = q_nodes

        k_nodes = self.model.match_parent_path(matmul_qk, ["Mul", "Transpose", "Reshape", "MatMul"], [1, None, 0, 0])
        if k_nodes is None:
            logger.debug("fuse_attention: failed to match k path")
            return None

        (_mul_k, _, _, matmul_k) = k_nodes

        # The scalar for Q and K is sqrt(1.0/sqrt(head_size)).
        mul_q_nodes = self.model.match_parent_path(
            mul_q,
            ["Sqrt", "Div", "Sqrt", "Cast", "Slice", "Shape", "Transpose", "Reshape"],
            [None, 0, 1, 0, 0, 0, 0, 0],
        )
        if mul_q_nodes is None or mul_q_nodes[-1] != reshape_q:
            logger.debug("fuse_attention: failed to match mul_q path")
            return None

        return True, reshape_qkv, transpose_qkv, reshape_q, matmul_q, matmul_k, matmul_v

    def match_qkv_torch1_lora(self, root_input, skip_add):
        """Match Q, K and V paths exported by PyTorch 1 that contains LoRA patterns.*"""
        another_input = 1 if skip_add.input[0] == root_input else 0
        qkv_nodes = self.model.match_parent_path(
            skip_add,
            ["Add", "Add", "MatMul", "Reshape", "Transpose", "Reshape", "MatMul"],
            [another_input, 0, None, None, 0, 0, 0],
        )
        if qkv_nodes is None:
            return None

        (_, _, _, reshape_qkv, transpose_qkv, _, matmul_qkv) = qkv_nodes

        # No bias. For cross-attention, the input of the MatMul is encoder_hidden_states graph input.
        v_nodes = self.model.match_parent_path(matmul_qkv, ["Reshape", "Transpose", "Reshape", "Add"], [1, 0, 0, 0])
        if v_nodes is None:
            logger.debug("fuse_attention: failed to match LoRA v path")
            return None
        (_, _, _, matmul_add_v) = v_nodes

        qk_nodes = self.model.match_parent_path(matmul_qkv, ["Softmax", "Mul", "MatMul"], [0, 0, 0])
        if qk_nodes is not None:
            (_softmax_qk, _mul_qk, matmul_qk) = qk_nodes
        else:
            qk_nodes = self.model.match_parent_path(matmul_qkv, ["Softmax", "Add", "Mul", "MatMul"], [0, 0, 0, 0])
            if qk_nodes is not None:
                (_softmax_qk, _add_zero, _mul_qk, matmul_qk) = qk_nodes
            else:
                logger.debug("fuse_attention: failed to match LoRA qk path")
                return None

        q_nodes = self.model.match_parent_path(matmul_qk, ["Reshape", "Transpose", "Reshape", "Add"], [0, 0, 0, 0])
        if q_nodes is None:
            logger.debug("fuse_attention: failed to match LoRA q path")
            return None
        (_, _transpose_q, reshape_q, matmul_add_q) = q_nodes

        k_nodes = self.model.match_parent_path(
            matmul_qk, ["Transpose", "Reshape", "Transpose", "Reshape", "Add"], [1, 0, 0, 0, 0]
        )
        if k_nodes is None:
            logger.debug("fuse_attention: failed to match LoRA k path")
            return None

        (_, _, _, _, matmul_add_k) = k_nodes

        return False, reshape_qkv, transpose_qkv, reshape_q, matmul_add_q, matmul_add_k, matmul_add_v

    def match_qkv_torch2_lora(self, root_input, skip_add):
        """Match Q, K and V paths exported by PyTorch 2 that contains LoRA patterns.*"""
        another_input = 1 if skip_add.input[0] == root_input else 0
        qkv_nodes = self.model.match_parent_path(
            skip_add,
            ["Add", "Add", "MatMul", "Reshape", "Transpose", "MatMul"],
            [another_input, 0, None, None, 0, 0],
        )
        if qkv_nodes is None:
            return None

        (_, _, _, reshape_qkv, transpose_qkv, matmul_qkv) = qkv_nodes

        v_nodes = self.model.match_parent_path(matmul_qkv, ["Transpose", "Reshape", "Add"], [1, 0, 0])
        if v_nodes is None:
            logger.debug("fuse_attention: failed to match LoRA v path")
            return None
        (_, _, matmul_add_v) = v_nodes

        qk_nodes = self.model.match_parent_path(matmul_qkv, ["Softmax", "MatMul"], [0, 0])
        if qk_nodes is not None:
            (_softmax_qk, matmul_qk) = qk_nodes
        else:
            logger.debug("fuse_attention: failed to match LoRA qk path")
            return None

        q_nodes = self.model.match_parent_path(matmul_qk, ["Mul", "Transpose", "Reshape", "Add"], [0, None, 0, 0])
        if q_nodes is None:
            logger.debug("fuse_attention: failed to match LoRA q path")
            return None
        (mul_q, _transpose_q, reshape_q, matmul_add_q) = q_nodes

        k_nodes = self.model.match_parent_path(matmul_qk, ["Mul", "Transpose", "Reshape", "Add"], [1, None, 0, 0])
        if k_nodes is None:
            logger.debug("fuse_attention: failed to match LoRA k path")
            return None

        (_mul_k, _, _, matmul_add_k) = k_nodes

        # The scalar for Q and K is sqrt(1.0/sqrt(head_size)).
        mul_q_nodes = self.model.match_parent_path(
            mul_q,
            ["Sqrt", "Div", "Sqrt", "Cast", "Slice", "Shape", "Transpose", "Reshape"],
            [None, 0, 1, 0, 0, 0, 0, 0],
        )
        if mul_q_nodes is None or mul_q_nodes[-1] != reshape_q:
            logger.debug("fuse_attention: failed to match LoRA mul_q path")
            return None

        return True, reshape_qkv, transpose_qkv, reshape_q, matmul_add_q, matmul_add_k, matmul_add_v

    def match_lora_path(
        self,
        add_node: NodeProto,
    ):
        # Lora paths can look like one of the following options:
        # MatMul -> MatMul -> Add
        # MatMul -> MatMul -> Mul -> Add
        # MatMul -> MatMul -> Mul -> Mul -> Add

        # Try matching MatMul -> MatMul -> Add
        lora_nodes = self.model.match_parent_path(
            add_node,
            ["MatMul", "MatMul"],
            [1, 0],
        )

        if lora_nodes is not None:
            (lora_matmul_2_node, lora_matmul_1_node) = lora_nodes
            return (lora_matmul_2_node, lora_matmul_1_node)

        # Try matching MatMul -> MatMul -> Mul -> Add
        lora_nodes = self.model.match_parent_path(
            add_node,
            ["Mul", "MatMul", "MatMul"],
            [1, 0, 0],
        )

        if lora_nodes is not None:
            (lora_mul_node, _, lora_matmul_1_node) = lora_nodes
            return (lora_mul_node, lora_matmul_1_node)

        # Try matching MatMul -> MatMul -> Mul -> Mul -> Add
        lora_nodes = self.model.match_parent_path(
            add_node,
            ["Mul", "Mul", "MatMul", "MatMul"],
            [1, 0, 0, 0],
        )

        if lora_nodes is not None:
            (lora_mul_node, _, _, lora_matmul_1_node) = lora_nodes
            return (lora_mul_node, lora_matmul_1_node)

        return None

    def fuse_a1111_fp16(self, normalize_node, input_name_to_nodes, output_name_to_node):
        """Fuse attention of fp16 UNet exported in A1111 (stable diffusion webui) extension"""
        entry_path = self.model.match_parent_path(normalize_node, ["Cast", "Add"], [0, 0])
        if entry_path is None:
            entry_path = self.model.match_parent_path(normalize_node, ["Cast", "Reshape"], [0, 0])
            if entry_path is None:
                return False
        _cast, node_before_layernorm = entry_path

        root_input = node_before_layernorm.output[0]

        children_nodes = input_name_to_nodes[root_input]
        skip_add = None
        for node in children_nodes:
            if node.op_type == "Add":  # SkipLayerNormalization fusion is not applied yet
                skip_add = node
                break
        if skip_add is None:
            return False

        match_qkv = self.match_qkv_a1111(root_input, skip_add)
        if match_qkv is None:
            return False

        (
            reshape_qkv,
            transpose_qkv,
            reshape_q,
            matmul_q,
            matmul_k,
            matmul_v,
        ) = match_qkv

        cast_q = self.model.match_parent(matmul_q, "Cast", 0)
        cast_k = self.model.match_parent(matmul_k, "Cast", 0)
        cast_v = self.model.match_parent(matmul_v, "Cast", 0)
        if not (
            cast_q is not None
            and cast_k is not None
            and (cast_q == cast_k if not self.is_cross_attention else cast_q != cast_k)
            and cast_k == cast_v
        ):
            return False

        if cast_q.input[0] != normalize_node.output[0]:
            return False

        attention_last_node = reshape_qkv

        q_num_heads = self.get_num_heads(reshape_q, True) or self.get_num_heads(reshape_q, False)
        if q_num_heads <= 0:
            logger.debug("fuse_attention: failed to detect num_heads")
            return False

        q_hidden_size = self.get_hidden_size(normalize_node)

        # number of heads are same for all the paths, hence to create attention node, we pass the q_num_heads
        new_node = self.create_attention_node(
            matmul_q,
            matmul_k,
            matmul_v,
            q_num_heads,
            q_hidden_size,
            input=matmul_q.input[0],
            output=attention_last_node.output[0],
        )
        if new_node is None:
            return False

        self.nodes_to_add.append(new_node)
        self.node_name_to_graph_name[new_node.name] = self.this_graph_name

        self.nodes_to_remove.extend([attention_last_node, transpose_qkv])

        # Use prune graph to remove nodes since they are shared by all attention nodes.
        self.prune_graph = True
        return True

    def match_qkv_a1111(self, root_input, skip_add):
        """Match Q, K and V paths exported by A1111 (stable diffusion webui) extension"""
        another_input = 1 if skip_add.input[0] == root_input else 0
        qkv_nodes = self.model.match_parent_path(
            skip_add,
            ["Add", "MatMul", "Reshape", "Transpose", "Reshape", "Einsum"],
            [another_input, None, None, 0, 0, 0],
        )

        if qkv_nodes is None:
            return None

        (_, _, reshape_qkv, transpose_qkv, reshape_einsum, einsum_qkv) = qkv_nodes

        v_nodes = self.model.match_parent_path(einsum_qkv, ["Reshape", "Transpose", "Reshape", "MatMul"], [1, 0, 0, 0])
        if v_nodes is None:
            logger.debug("fuse_attention: failed to match v path")
            return None
        (_, _, _, matmul_v) = v_nodes

        qk_nodes = self.model.match_parent_path(
            einsum_qkv, ["Cast", "Cast", "Softmax", "Mul", "Einsum"], [0, 0, 0, 0, None]
        )
        if qk_nodes is not None:
            (_, _, _softmax_qk, _, einsum_qk) = qk_nodes
        else:
            logger.debug("fuse_attention: failed to match qk path")
            return None

        q_nodes = self.model.match_parent_path(einsum_qk, ["Reshape", "Transpose", "Reshape", "MatMul"], [0, 0, 0, 0])
        if q_nodes is None:
            logger.debug("fuse_attention: failed to match q path")
            return None
        (_, _transpose_q, reshape_q, matmul_q) = q_nodes

        k_nodes = self.model.match_parent_path(einsum_qk, ["Reshape", "Transpose", "Reshape", "MatMul"], [1, 0, 0, 0])
        if k_nodes is None:
            logger.debug("fuse_attention: failed to match k path")
            return None

        (_, _, _, matmul_k) = k_nodes

        return reshape_qkv, transpose_qkv, reshape_q, matmul_q, matmul_k, matmul_v
