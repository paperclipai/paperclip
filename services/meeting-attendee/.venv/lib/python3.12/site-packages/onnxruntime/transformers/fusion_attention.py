# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
from logging import getLogger

import numpy as np
from fusion_base import Fusion
from fusion_options import AttentionMaskFormat
from fusion_utils import FusionUtils, NumpyHelper
from onnx import NodeProto, TensorProto, helper, numpy_helper
from onnx_model import OnnxModel

logger = getLogger(__name__)


class AttentionMask:
    """
    Fuse Attention subgraph into one Attention node.
    """

    def __init__(self, model: OnnxModel):
        self.model = model
        # A lookup table with mask input as key, and mask index output as value
        self.mask_indice = {}
        # A lookup table with mask input as key, and cast (to int32) output as value
        self.mask_casted = {}
        self.utils = FusionUtils(model)
        self.mask_format = AttentionMaskFormat.MaskIndexEnd
        self.opset_version = model.get_opset_version()

    def set_mask_format(self, mask_format: AttentionMaskFormat):
        self.mask_format = mask_format

    def set_mask_indice(self, mask, mask_index):
        if mask in self.mask_indice:
            assert mask_index == self.mask_indice[mask]
        self.mask_indice[mask] = mask_index

    def get_first_mask(self):
        assert len(self.mask_indice) > 0
        return next(iter(self.mask_indice))

    def process_mask(self, mask_2d: str) -> str | None:
        if self.mask_format == AttentionMaskFormat.NoMask:
            return None

        if mask_2d in self.mask_indice:
            return self.mask_indice[mask_2d]

        # Add cast to convert int64 to int32
        if self.model.find_graph_input(mask_2d):
            casted, input_name = self.utils.cast_graph_input_to_int32(mask_2d)
        else:
            input_name, _cast_node = self.utils.cast_input_to_int32(mask_2d)
            casted = True

        if casted:
            self.mask_casted[mask_2d] = input_name

        # Attention supports int32 attention mask (2D) since 1.4.0
        if self.mask_format == AttentionMaskFormat.AttentionMask:
            self.mask_indice[mask_2d] = input_name
            return input_name

        # Add a mask processing node to convert attention mask to mask index (1D)
        output_name = self.model.create_node_name("mask_index")
        if self.opset_version < 13:
            mask_index_node = helper.make_node(
                "ReduceSum",
                inputs=[input_name],
                outputs=[output_name],
                name=self.model.create_node_name("ReduceSum", "MaskReduceSum"),
            )
            mask_index_node.attribute.extend([helper.make_attribute("axes", [1]), helper.make_attribute("keepdims", 0)])
        else:
            # ReduceSum-13: axes is moved from attribute to input
            axes_name = "ort_const_1_reduce_sum_axes"
            if self.model.get_initializer(axes_name) is None:
                self.model.add_initializer(
                    helper.make_tensor(
                        name=axes_name,
                        data_type=TensorProto.INT64,
                        dims=[1],
                        vals=[1],
                        raw=False,
                    )
                )
            mask_index_node = helper.make_node(
                "ReduceSum",
                inputs=[input_name, axes_name],
                outputs=[output_name],
                name=self.model.create_node_name("ReduceSum", "MaskReduceSum"),
            )
            mask_index_node.attribute.extend([helper.make_attribute("keepdims", 0)])

        self.model.add_node(mask_index_node)

        self.mask_indice[mask_2d] = output_name
        return output_name


class FusionAttention(Fusion):
    """
    Fuse Attention subgraph into one Attention node.
    """

    def __init__(
        self,
        model: OnnxModel,
        hidden_size: int,
        num_heads: int,
        attention_mask: AttentionMask | None = None,
        use_multi_head_attention: bool = False,
        disable_multi_head_attention_bias: bool = False,
        search_op_types: list[str] = ["SkipLayerNormalization", "LayerNormalization"],  # noqa: B006
    ):
        attention_op_name = "MultiHeadAttention" if use_multi_head_attention else "Attention"
        super().__init__(model, attention_op_name, search_op_types)
        self.hidden_size = hidden_size
        self.num_heads = num_heads
        self.attention_mask = attention_mask if attention_mask else AttentionMask(model)
        self.use_multi_head_attention = use_multi_head_attention
        self.disable_multi_head_attention_bias = disable_multi_head_attention_bias
        self.mask_filter_value = None

        # Flags to show warning only once
        self.num_heads_warning = True
        self.hidden_size_warning = True

        self.shape_infer = None
        self.shape_infer_done = True

    def get_num_heads_and_hidden_size_from_concat(self, concat: NodeProto) -> tuple[int, int]:
        """
        Detect num_heads and hidden_size from Concat node in the following subgraph:

        SkipLayerNormalization or EmbedLayerNormalization
                        /        |
                     MatMul    Shape
                        |        |
                       Add     Gather(indices=0)
                        |        |
                        |      Unsqueeze
                        |        |
                        |     Concat (*, -1, 12, 64)
                        |     /
                       Reshape
                          |
                       Transpose
        """
        if len(concat.input) == 4:
            num_heads = self.model.get_constant_value(concat.input[2])
            head_size = self.model.get_constant_value(concat.input[3])
            if (
                isinstance(num_heads, np.ndarray)
                and num_heads.size == 1
                and isinstance(head_size, np.ndarray)
                and head_size.size == 1
            ):
                return num_heads[0], num_heads[0] * head_size[0]

        return self.num_heads, self.hidden_size

    def get_num_heads_and_hidden_size(self, reshape_q: NodeProto) -> tuple[int, int]:
        """Detect num_heads and hidden_size from a reshape node.

        Args:
            reshape_q (NodeProto): reshape node for Q

        Returns:
            Tuple[int, int]: num_heads and hidden_size
        """
        # we assume that reshape fusion has done, so the shape is a tensor like [0, 0, num_heads, head_size]
        q_shape_value = self.model.get_constant_value(reshape_q.input[1])
        if q_shape_value is None:
            concat = self.model.get_parent(reshape_q, 1)
            if concat is not None and concat.op_type == "Concat":
                return self.get_num_heads_and_hidden_size_from_concat(concat)
            logger.debug("%s is not initializer.", reshape_q.input[1])
            return self.num_heads, self.hidden_size  # Fall back to user specified value

        if (
            (not isinstance(q_shape_value, np.ndarray))
            or len(q_shape_value) != 4
            or (q_shape_value[2] <= 0 or q_shape_value[3] <= 0)
        ):
            logger.debug("q_shape_value=%s. Expected value are like [0, 0, num_heads, head_size].", q_shape_value)
            return self.num_heads, self.hidden_size  # Fall back to user specified value

        num_heads = q_shape_value[2]
        head_size = q_shape_value[3]
        hidden_size = num_heads * head_size

        if self.num_heads > 0 and num_heads != self.num_heads:
            if self.num_heads_warning:
                logger.warning(
                    "--num_heads is %d. Detected value is %d. Using detected value.", self.num_heads, num_heads
                )
                self.num_heads_warning = False  # Do not show the warning more than once

        if self.hidden_size > 0 and hidden_size != self.hidden_size:
            if self.hidden_size_warning:
                logger.warning(
                    "--hidden_size is %d. Detected value is %d. Using detected value.", self.hidden_size, hidden_size
                )
                self.hidden_size_warning = False  # Do not show the warning more than once

        return num_heads, hidden_size

    def get_add_qk_str(self, add_qk: NodeProto):
        if not self.shape_infer_done:
            self.shape_infer = self.model.infer_runtime_shape(update=True)
            self.shape_infer_done = True

        if self.shape_infer is None:
            return None

        input_0_shape = self.shape_infer.get_edge_shape(add_qk.input[0])
        input_1_shape = self.shape_infer.get_edge_shape(add_qk.input[1])

        if input_0_shape is None or input_1_shape is None:
            logger.debug("one of the inputs of %s is None", add_qk)
            return None

        if input_0_shape != input_1_shape:
            logger.debug("the shape of two inputs of %s is not same", add_qk)
            return None

        return add_qk.input[1]

    def reshape_add_qk(self, add_qk: str):
        # Convert 4D mask from (B,1,S,T) to (B,N,S,T)
        # B = batch size, N = num heads, S = source sequence length, T = target sequence length
        mask_output_name = add_qk + "_mask"

        # Check if concat node for (B,1,S,T) --> (B,N,S,T) already exists
        concat_node = list(filter(lambda node: node.output[0] == mask_output_name, self.nodes_to_add))
        if len(concat_node) == 1:
            return mask_output_name

        assert len(concat_node) == 0
        concat_node_name = self.model.create_node_name("Concat")
        concat_add_qk_fp32 = helper.make_node(
            "Concat",
            inputs=[add_qk for _ in range(self.num_heads)],
            outputs=[mask_output_name],
            name=concat_node_name,
            axis=1,
        )
        # Add new node to graph
        self.nodes_to_add.append(concat_add_qk_fp32)
        self.node_name_to_graph_name[concat_node_name] = self.this_graph_name

        return mask_output_name

    def concat_kv(self, past_k: str, past_v: str) -> str:
        """Concatenate past_k and past_v inputs to create past_kv input.

        Args:
            past_k (str): name of past K value
            past_v (str): name of past V value

        Returns:
            kv_output_name (str): name of past KV value
        """
        # Unsqueeze K and V nodes from (B,N,P,H) to (1,B,N,P,H)
        # B = batch size, N = num heads, P = past sequence length, H = head size
        unsqueeze_k_name = self.model.create_node_name("Unsqueeze")
        unsqueeze_v_name = self.model.create_node_name("Unsqueeze")
        k_5d_name = (past_k + "_5d").replace(".", "_")
        v_5d_name = (past_v + "_5d").replace(".", "_")

        k_5d = helper.make_node(
            "Unsqueeze",
            inputs=[past_k],
            outputs=[k_5d_name],
            name=unsqueeze_k_name,
            axes=[0],
        )
        v_5d = helper.make_node(
            "Unsqueeze",
            inputs=[past_v],
            outputs=[v_5d_name],
            name=unsqueeze_v_name,
            axes=[0],
        )

        # Add unsqueeze nodes to graph
        self.nodes_to_add.append(k_5d)
        self.nodes_to_add.append(v_5d)
        self.node_name_to_graph_name[unsqueeze_k_name] = self.this_graph_name
        self.node_name_to_graph_name[unsqueeze_v_name] = self.this_graph_name

        # Concat K and V to get one node of size (2,B,N,P,H)
        concat_node_name = self.model.create_node_name("Concat")
        kv_output_name = past_v.replace(".value", ".kv").replace(".", "_").replace("_value", "_kv")
        concat_kv = helper.make_node(
            "Concat",
            inputs=[k_5d_name, v_5d_name],
            outputs=[kv_output_name],
            name=concat_node_name,
            axis=0,
        )

        # Add concat node to graph
        self.nodes_to_add.append(concat_kv)
        self.node_name_to_graph_name[concat_node_name] = self.this_graph_name

        return kv_output_name

    def split_kv(self, present_k_name: str, present_v_name: str, kv_node: str):
        """Split kv_node containing present KV values into separate present K and present V values.

        Args:
            present_k_name (str): name of output to store present K value in
            present_v_name (str): name of output to store present V value in
            kv_node (str): name of present KV values
        """
        # Split kv_node into present_k and present_v nodes

        # Create initializers for indexing kv_node, whose shape is (2,B,N,P,H)
        k_index, v_index = "index_0", "index_1"
        k_dim = self.model.get_initializer(k_index)
        v_dim = self.model.get_initializer(v_index)
        if k_dim is None:
            k_dim = numpy_helper.from_array(np.array(0, dtype="int64"), name=k_index)
            self.model.add_initializer(k_dim, self.this_graph_name)
        if v_dim is None:
            v_dim = numpy_helper.from_array(np.array(1, dtype="int64"), name=v_index)
            self.model.add_initializer(v_dim, self.this_graph_name)

        # Create nodes to index kv_node
        gather_k_name = self.model.create_node_name("Gather")
        gather_v_name = self.model.create_node_name("Gather")
        present_k = helper.make_node(
            "Gather",
            inputs=[kv_node, k_index],
            outputs=[present_k_name],
            name=gather_k_name,
            axis=0,
        )
        present_v = helper.make_node(
            "Gather",
            inputs=[kv_node, v_index],
            outputs=[present_v_name],
            name=gather_v_name,
            axis=0,
        )

        # Add gather nodes to graph
        self.nodes_to_add.append(present_k)
        self.nodes_to_add.append(present_v)
        self.node_name_to_graph_name[gather_k_name] = self.this_graph_name
        self.node_name_to_graph_name[gather_v_name] = self.this_graph_name

    def create_combined_qkv_bias(
        self,
        q_add: NodeProto,
        k_add: NodeProto | None,
        v_add: NodeProto | None,
        name_prefix: str,
    ) -> NodeProto | None:
        q_bias = self.model.get_initializer(q_add.input[1]) or self.model.get_initializer(q_add.input[0])
        qb = NumpyHelper.to_array(q_bias)
        kb = np.zeros_like(qb)
        vb = np.zeros_like(qb)
        if k_add is not None:
            k_bias = self.model.get_initializer(k_add.input[1]) or self.model.get_initializer(k_add.input[0])
            kb = NumpyHelper.to_array(k_bias)
        if v_add is not None:
            v_bias = self.model.get_initializer(v_add.input[1]) or self.model.get_initializer(v_add.input[0])
            vb = NumpyHelper.to_array(v_bias)

        qkv_bias = np.stack((qb, kb, vb), axis=0)
        qkv_bias_dim = 3 * np.prod(qb.shape)

        bias_name = name_prefix + "_qkv_bias"
        self.add_initializer(
            name=bias_name,
            data_type=q_bias.data_type,
            dims=[qkv_bias_dim],
            vals=qkv_bias,
        )
        return bias_name

    def create_packed_qkv_matmul_node(
        self,
        q_matmul: NodeProto,
        k_matmul: NodeProto,
        v_matmul: NodeProto,
        q_add: NodeProto,
        k_add: NodeProto | None,
        v_add: NodeProto | None,
    ) -> tuple[NodeProto, NodeProto, NodeProto]:
        """Create packed QKV MatMul node before MultiHeadAttention node.
           This is for the scenario where an Attention node should be created but cannot be created
           because past_key and past_value are separate inputs and not one concatenated input.

        Args:
            q_matmul (NodeProto): name of MatMul from Q path - (batch_size, sequence_length, hidden_size)
            k_matmul (NodeProto): name of MatMul from K path - (batch_size, sequence_length, hidden_size)
            v_matmul (NodeProto): name of MatMul from V path - (batch_size, sequence_length, hidden_size)
            q_add (NodeProto): name of Add from Q path
            k_add (NodeProto): name of Add from K path
            v_add (NodeProto): name of Add from V path

        Returns:
             q_output (NodeProto): Slice node for Q
             k_output (NodeProto): Slice node for K
             v_output (NodeProto): Slice node for V
        """
        matmul_node_name = self.model.create_node_name("MatMul")

        # Check that input for Q, K, V is the same
        assert q_matmul.input[0] == k_matmul.input[0] and k_matmul.input[0] == v_matmul.input[0]

        # Created packed QKV weight
        q_weight = self.model.get_initializer(q_matmul.input[1])
        k_weight = self.model.get_initializer(k_matmul.input[1])
        v_weight = self.model.get_initializer(v_matmul.input[1])

        qw = NumpyHelper.to_array(q_weight)
        kw = NumpyHelper.to_array(k_weight)
        vw = NumpyHelper.to_array(v_weight)

        assert qw.shape == kw.shape and kw.shape == vw.shape
        d = qw.shape[0]

        qkv_weight = np.stack((qw, kw, vw), axis=1).reshape((d, 3 * d))
        qkv_weight_name = matmul_node_name + "_qkv_weight"

        self.add_initializer(
            name=qkv_weight_name,
            data_type=q_weight.data_type,
            dims=[qkv_weight.shape[0], qkv_weight.shape[1]],
            vals=qkv_weight,
        )

        # Created packed QKV MatMul with output (B, S, 3*D)
        # Output is of the form:
        #
        # [[[Q Q ... Q Q K K ... K K V V ... V V]]]
        #   [Q Q ... Q Q K K ... K K V V ... V V]
        #                     .
        #                     .
        #                     .
        #  [[Q Q ... Q Q K K ... K K V V ... V V]
        #   [Q Q ... Q Q K K ... K K V V ... V V]]]
        qkv_matmul_output = matmul_node_name + "_qkv_out"
        qkv_matmul = helper.make_node(
            "MatMul",
            inputs=[q_matmul.input[0], qkv_weight_name],
            outputs=[qkv_matmul_output],
            name=matmul_node_name,
        )
        self.node_name_to_graph_name[matmul_node_name] = self.this_graph_name

        qkv_nodes = [qkv_matmul]

        # Create Slice nodes to access Q, K, V
        q_slice_name = matmul_node_name + "_q_start_index"
        self.add_initializer(name=q_slice_name, data_type=TensorProto.INT64, dims=[1], vals=[0], raw=False)
        k_slice_name = matmul_node_name + "_k_start_index"
        self.add_initializer(name=k_slice_name, data_type=TensorProto.INT64, dims=[1], vals=[d], raw=False)
        v_slice_name = matmul_node_name + "_v_start_index"
        self.add_initializer(name=v_slice_name, data_type=TensorProto.INT64, dims=[1], vals=[2 * d], raw=False)
        end_of_qkv_name = matmul_node_name + "_end_of_qkv_index"
        self.add_initializer(name=end_of_qkv_name, data_type=TensorProto.INT64, dims=[1], vals=[3 * d], raw=False)
        qkv_last_axis_name = matmul_node_name + "_qkv_last_axis"
        self.add_initializer(name=qkv_last_axis_name, data_type=TensorProto.INT64, dims=[1], vals=[-1], raw=False)

        q_slice_output = matmul_node_name + "_q_out"
        q_slice = helper.make_node(
            "Slice",
            inputs=[qkv_matmul_output, q_slice_name, k_slice_name, qkv_last_axis_name],
            outputs=[q_slice_output],
            name=self.model.create_node_name("Slice"),
        )
        self.node_name_to_graph_name[q_slice.name] = self.this_graph_name
        k_slice_output = matmul_node_name + "_k_out"
        k_slice = helper.make_node(
            "Slice",
            inputs=[qkv_matmul_output, k_slice_name, v_slice_name, qkv_last_axis_name],
            outputs=[k_slice_output],
            name=self.model.create_node_name("Slice"),
        )
        self.node_name_to_graph_name[k_slice.name] = self.this_graph_name
        v_slice_output = matmul_node_name + "_v_out"
        v_slice = helper.make_node(
            "Slice",
            inputs=[qkv_matmul_output, v_slice_name, end_of_qkv_name, qkv_last_axis_name],
            outputs=[v_slice_output],
            name=self.model.create_node_name("Slice"),
        )
        self.node_name_to_graph_name[v_slice.name] = self.this_graph_name

        q_output = q_slice
        k_output = k_slice
        v_output = v_slice
        qkv_nodes.extend([q_slice, k_slice, v_slice])

        if self.disable_multi_head_attention_bias:
            if q_add is not None:
                initializer_input = 1 if self.model.get_initializer(q_add.input[1]) else 0
                if np.any(NumpyHelper.to_array(self.model.get_initializer(q_add.input[initializer_input]))):
                    q_add.input[1 - initializer_input] = q_slice_output
                    q_output = q_add
                    qkv_nodes.append(q_add)
                    self.node_name_to_graph_name[q_add.name] = self.this_graph_name
            if k_add is not None:
                initializer_input = 1 if self.model.get_initializer(k_add.input[1]) else 0
                if np.any(NumpyHelper.to_array(self.model.get_initializer(k_add.input[initializer_input]))):
                    k_add.input[1 - initializer_input] = k_slice_output
                    k_output = k_add
                    qkv_nodes.append(k_add)
                    self.node_name_to_graph_name[k_add.name] = self.this_graph_name
            if v_add is not None:
                initializer_input = 1 if self.model.get_initializer(v_add.input[1]) else 0
                if np.any(NumpyHelper.to_array(self.model.get_initializer(v_add.input[initializer_input]))):
                    v_add.input[1 - initializer_input] = v_slice_output
                    v_output = v_add
                    qkv_nodes.append(v_add)
                    self.node_name_to_graph_name[v_add.name] = self.this_graph_name

        # Add nodes to graph
        self.nodes_to_add.extend(qkv_nodes)
        return q_output, k_output, v_output

    # This function is used in child classes for bart or conformer model.
    def create_multihead_attention_node(
        self,
        q_matmul: NodeProto,
        k_matmul: NodeProto | str | None,
        v_matmul: NodeProto | str | None,
        q_add: NodeProto,
        k_add: NodeProto | None,
        v_add: NodeProto | None,
        num_heads: int,
        hidden_size: int,
        output: str,
        key_padding_mask: str = "",
        add_qk: str = "",
        unidirectional: bool = False,
        past_k: str = "",
        past_v: str = "",
        present_k: str = "",
        present_v: str = "",
        packed_qkv: bool = False,
    ) -> NodeProto | None:
        """Create a MultiHeadAttention node.

        Args:
            q_matmul (NodeProto): name of MatMul from Q path - (batch_size, sequence_length, hidden_size)
            k_matmul (NodeProto): name of MatMul from K path - (batch_size, sequence_length, hidden_size) or (batch_size, num_heads, past_sequence_length, head_size)
            v_matmul (NodeProto): name of MatMul from V path - (batch_size, sequence_length, hidden_size) or (batch_size, num_heads, past_sequence_length, head_size)
            q_add (NodeProto): name of Add from Q path
            k_add (NodeProto): name of Add from K path
            v_add (NodeProto): name of Add from V path
            num_heads (int): number of attention heads. If a model is pruned, it is the number of heads after pruning.
            hidden_size (int): hidden dimension. If a model is pruned, it is the hidden dimension after pruning.
            output (str): output name of MHA
            key_padding_mask (str): name of key padding mask
            add_qk (str): name of add after Q x K'
            unidirectional (bool): whether to apply causal attention mask automatically or not
            past_k (str): name of past K value - (batch_size, num_heads, past_sequence_length, head_size)
            past_v (str): name of past V value - (batch_size, num_heads, past_sequence_length, head_size)
            present_k (str): name of present K value - (batch_size, num_heads, sequence_length, head_size)
            present_v (str): name of present V value - (batch_size, num_heads, sequence_length, head_size)
            packed_qkv (bool): whether to combine MatMuls from Q, K, V paths
                               Note: This is for the scenario where an Attention node should be created but cannot be created
                               because past_key and past_value are separate inputs and not one concatenated input.

        Returns:
            Union[NodeProto, None]: the node created or None if failed.
        """
        # B = batch size, N = num heads, P = past seq len, H = head size
        assert num_heads > 0

        if hidden_size > 0 and (hidden_size % num_heads) != 0:
            logger.debug("input hidden size %d is not a multiple of num of heads %d", hidden_size, num_heads)
            return None

        graph_input_names = {node.name for node in self.model.graph().input}
        mha_node_name = self.model.create_node_name("Attention")

        # Add initial Q/K/V inputs for MHA
        mha_inputs = []
        if packed_qkv:
            q_slice, k_slice, v_slice = self.create_packed_qkv_matmul_node(
                q_matmul,
                k_matmul,
                v_matmul,
                q_add,
                k_add,
                v_add,
            )
            mha_inputs.extend([q_slice.output[0], k_slice.output[0], v_slice.output[0]])
        elif isinstance(k_matmul, NodeProto) and isinstance(v_matmul, NodeProto):
            if self.disable_multi_head_attention_bias:
                mha_inputs.extend([q_add.output[0], k_matmul.output[0], v_add.output[0]])
            else:
                mha_inputs.extend([q_matmul.output[0], k_matmul.output[0], v_matmul.output[0]])
        elif (
            isinstance(k_matmul, str)
            and isinstance(v_matmul, str)
            and k_matmul in graph_input_names
            and v_matmul in graph_input_names
        ):
            if self.disable_multi_head_attention_bias:
                mha_inputs.extend([q_add.output[0], k_matmul, v_matmul])
            else:
                mha_inputs.extend([q_matmul.output[0], k_matmul, v_matmul])
        else:
            return None

        # Add bias to inputs for MHA
        # Bias for cross attention is not fully supported in DMMHA and cpu MHA kernels since they assume
        # bias has been added to key and value when they are in BNSH format, so only bias for query is used.
        # Need add checks if we found such assumption is not true.
        if not self.disable_multi_head_attention_bias:
            bias_name = self.create_combined_qkv_bias(q_add, k_add, v_add, mha_node_name)
            mha_inputs.append(bias_name)
        else:
            mha_inputs.append("")

        # Add optional inputs for MHA
        if past_k and past_v:
            mha_inputs.extend([key_padding_mask, add_qk, past_k, past_v])
        elif key_padding_mask or add_qk:
            mha_inputs.extend([key_padding_mask, add_qk])

        # Add outputs for MHA
        mha_outputs = [output]
        if present_k and present_v:
            mha_outputs.extend([present_k, present_v])

        mha_node = helper.make_node(
            "MultiHeadAttention",
            inputs=mha_inputs,
            outputs=mha_outputs,
            name=mha_node_name,
        )
        mha_node.domain = "com.microsoft"
        mha_node.attribute.append(helper.make_attribute("num_heads", num_heads))
        if unidirectional:
            mha_node.attribute.append(helper.make_attribute("unidirectional", int(unidirectional)))

        self.increase_counter("MultiHeadAttention")
        return mha_node

    def create_attention_node(
        self,
        mask_index: str | None,
        q_matmul: NodeProto,
        k_matmul: NodeProto,
        v_matmul: NodeProto,
        q_add: NodeProto,
        k_add: NodeProto,
        v_add: NodeProto,
        num_heads: int,
        hidden_size: int,
        first_input: str,
        output: str,
        add_qk_str: str = "",
        causal: bool = False,
        past_k: str = "",
        past_v: str = "",
        present_k: str = "",
        present_v: str = "",
        scale: float | None = None,
    ) -> NodeProto | None:
        """Create an Attention node.

        Args:
            mask_index (str | None): mask input
            q_matmul (NodeProto): MatMul node in fully connection for Q
            k_matmul (NodeProto): MatMul node in fully connection for K
            v_matmul (NodeProto): MatMul node in fully connection for V
            q_add (NodeProto): Add bias node in fully connection for Q
            k_add (NodeProto): Add bias node in fully connection for K
            v_add (NodeProto): Add bias node in fully connection for V
            num_heads (int): number of attention heads. If a model is pruned, it is the number of heads after pruning.
            hidden_size (int): hidden dimension. If a model is pruned, it is the hidden dimension after pruning.
            first_input (str): first input name
            output (str): output name
            add_qk_str (str): name of Add node after Q x K'
            causal: whether it is uni-directional mask.
            past_k (str): name of input for past K value
            past_v (str): name of input for past V value
            present_k (str): name of output to store present K value
            present_v (str): name of output to store present V value
            scale: scale before softmax

        Returns:
            Union[NodeProto, None]: the node created or None if failed.
        """
        assert num_heads > 0

        if hidden_size > 0 and (hidden_size % num_heads) != 0:
            logger.debug("input hidden size %d is not a multiple of num of heads %d", hidden_size, num_heads)
            return None

        has_bias = True
        if q_add is None and k_add is None and v_add is None:
            has_bias = False

        q_weight = self.model.get_initializer(q_matmul.input[1])
        k_weight = self.model.get_initializer(k_matmul.input[1])
        v_weight = self.model.get_initializer(v_matmul.input[1])

        q_bias, k_bias, v_bias = None, None, None
        if has_bias:
            q_bias = self.model.get_initializer(q_add.input[1]) or self.model.get_initializer(q_add.input[0])
            k_bias = self.model.get_initializer(k_add.input[1]) or self.model.get_initializer(k_add.input[0])
            v_bias = self.model.get_initializer(v_add.input[1]) or self.model.get_initializer(v_add.input[0])

            if not (k_weight and v_weight and q_bias and k_bias):
                return None

        if q_weight is None:
            print(
                f"{q_matmul.input[1]} is not an initializer. "
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
                "Input hidden size (%d) is not same as weight matrix dimension of q,k,v (%d). "
                "Please provide a correct input hidden size or pass in 0",
                hidden_size,
                qw_in_size,
            )

        is_qkv_diff_dims = False
        if qw.shape != vw.shape:
            is_qkv_diff_dims = True

        # All the matrices can have the same shape or q, k matrices can have the same shape with v being different
        # For 2d weights, the shapes would be [in_size, out_size].
        # For 3d weights, shape would be [in_size, a, b] where a*b = out_size
        qw_out_size = np.prod(qw.shape[1:])
        kw_out_size = np.prod(kw.shape[1:])
        vw_out_size = np.prod(vw.shape[1:])

        qkv_weight_dim = 0
        if is_qkv_diff_dims:
            qkv_weight = np.concatenate((qw, kw, vw), axis=1)
            qkv_weight_dim = qw_out_size + kw_out_size + vw_out_size
        else:
            qkv_weight = np.stack((qw, kw, vw), axis=1)
            qkv_weight_dim = 3 * qw_out_size

        qkv_bias_dim = 0
        qkv_bias: np.ndarray | None = None
        if has_bias:
            qb = NumpyHelper.to_array(q_bias)
            kb = NumpyHelper.to_array(k_bias)
            vb = NumpyHelper.to_array(v_bias)

            q_bias_shape = np.prod(qb.shape)
            k_bias_shape = np.prod(kb.shape)
            v_bias_shape = np.prod(vb.shape)

            assert q_bias_shape == k_bias_shape == qw_out_size
            assert v_bias_shape == vw_out_size

            if is_qkv_diff_dims:
                qkv_bias = np.concatenate((qb, kb, vb), axis=0)
                qkv_bias_dim = q_bias_shape + k_bias_shape + v_bias_shape
            else:
                qkv_bias = np.stack((qb, kb, vb), axis=0)
                qkv_bias_dim = 3 * q_bias_shape

        attention_node_name = self.model.create_node_name("Attention")

        if not self.use_multi_head_attention:
            self.add_initializer(
                name=attention_node_name + "_qkv_weight",
                data_type=q_weight.data_type,
                dims=[qw_in_size, int(qkv_weight_dim)],
                vals=qkv_weight,
            )

        if has_bias:
            self.add_initializer(
                name=attention_node_name + "_qkv_bias",
                data_type=q_bias.data_type,
                dims=[int(qkv_bias_dim)],
                vals=qkv_bias,
            )

        # For MultiHeadAttention operator, use separated inputs for query, key and value, and no weights.
        if self.use_multi_head_attention:
            if add_qk_str:
                logger.debug("MultiHeadAttention does not support relative_position_bias: cannot fuse the attention.")
                return None

            attention_inputs = [
                q_matmul.output[0],
                k_matmul.output[0],
                v_matmul.output[0],
                attention_node_name + "_qkv_bias",
            ]

            if mask_index is not None:
                attention_inputs.append(mask_index)

            attention_node = helper.make_node(
                "MultiHeadAttention",
                inputs=attention_inputs,
                outputs=[output],
                name=attention_node_name,
            )
            self.increase_counter("MultiHeadAttention")

        else:
            attention_inputs = [
                first_input,
                attention_node_name + "_qkv_weight",
                attention_node_name + "_qkv_bias" if has_bias else "",
            ]
            if mask_index is not None:
                attention_inputs.append(mask_index)
            else:
                attention_inputs.append("")

            past_exists = past_k and past_v
            if past_exists:
                past_kv = self.concat_kv(past_k, past_v)
                attention_inputs.append(past_kv)

            if add_qk_str:
                # Add additional add to attention node (input name = attention_bias)
                if not past_exists:
                    attention_inputs.append("")
                attention_inputs.append(add_qk_str)

            attention_outputs = [output]
            if present_k and present_v:
                present_kv = present_k.replace(".key", "").replace("_key", "").replace(".", "_")
                attention_outputs.append(present_kv)
                self.split_kv(present_k, present_v, present_kv)

            attention_node = helper.make_node(
                "Attention",
                inputs=attention_inputs,
                outputs=attention_outputs,
                name=attention_node_name,
            )
            self.increase_counter("Attention")

        attention_node.domain = "com.microsoft"
        attention_node.attribute.extend([helper.make_attribute("num_heads", num_heads)])

        if causal:
            attention_node.attribute.extend([helper.make_attribute("unidirectional", 1)])

        if scale is not None:
            attention_node.attribute.extend([helper.make_attribute("scale", scale)])

        if is_qkv_diff_dims:
            attention_node.attribute.extend(
                [helper.make_attribute("qkv_hidden_sizes", [qw_out_size, kw_out_size, vw_out_size])]
            )

        if self.mask_filter_value is not None:
            attention_node.attribute.extend([helper.make_attribute("mask_filter_value", float(self.mask_filter_value))])

        return attention_node

    def fuse(self, node, input_name_to_nodes, output_name_to_node):
        # Sometimes we can not fuse skiplayernormalization since the add before layernorm has an output that used by nodes outside skiplayernorm
        # Conceptually we treat add before layernorm as skiplayernorm node since they share the same pattern
        normalize_node = node
        start_node = normalize_node
        if normalize_node.op_type == "LayerNormalization":
            add_before_layernorm = self.model.match_parent(normalize_node, "Add", 0)
            if add_before_layernorm is not None:
                start_node = add_before_layernorm
            elif self.model.find_graph_input(normalize_node.input[0]) is not None:
                # Pre-LN first block: LN fed directly by graph input.  QKV matching will
                # still fail from this (first) LN anchor because its inputs are weights, not
                # the QKV projection path.  The real fusion happens when fuse() is called
                # again from the second LN/SkipLN anchor after the residual Add, where the
                # other_inputs and root_input changes (#2-#4) take effect.
                start_node = normalize_node
            else:
                return

        # SkipLayerNormalization has two inputs, and one of them is the root input for attention.
        qkv_nodes = self.model.match_parent_path(
            start_node,
            ["Add", "MatMul", "Reshape", "Transpose", "MatMul"],
            [None, None, 0, 0, 0],
        )
        einsum_node = None
        if qkv_nodes is not None:
            (_, _, reshape_qkv, transpose_qkv, matmul_qkv) = qkv_nodes
        else:
            # Match Albert
            qkv_nodes = self.model.match_parent_path(
                start_node, ["Add", "Einsum", "Transpose", "MatMul"], [1, None, 0, 0]
            )
            if qkv_nodes is not None:
                (_, einsum_node, transpose_qkv, matmul_qkv) = qkv_nodes
            else:
                return

        other_inputs = []
        for _i, node_input in enumerate(start_node.input):
            if node_input not in output_name_to_node:
                if self.model.find_graph_input(node_input) is None:
                    continue

            if node_input == qkv_nodes[0].output[0]:
                continue
            other_inputs.append(node_input)
        if len(other_inputs) != 1:
            return

        root_input = other_inputs[0]

        # Match flaubert                     Mask
        #                                     |
        # Mul --> LayerNormalization -->  Attention --> MatMul --> Add
        #  |                                                        |
        #  |                                                        |
        #  +---------------------------------------------------------
        mul_before_layernorm = self.model.match_parent(start_node, "Mul", 0)
        if mul_before_layernorm is not None:
            mul_children = input_name_to_nodes[mul_before_layernorm.output[0]]
            if mul_children is not None and len(mul_children) == 2:
                layernorm_node = mul_children[1]
                if layernorm_node.op_type == "LayerNormalization":
                    root_input = layernorm_node.output[0]
                else:
                    return
            elif mul_children is not None and len(mul_children) == 5:
                root_input = mul_before_layernorm.output[0]
            else:
                return
        elif normalize_node.op_type in ("LayerNormalization", "SkipLayerNormalization"):
            children = input_name_to_nodes[root_input]
            for child in children:
                if child.op_type == "LayerNormalization":
                    root_input = child.output[0]

        # When Add before the LayerNormalization produces an output
        # that is consumed by some other nodes other than the LayerNormalization itself,
        # fused SkipLayerNormalization will have several outputs.
        # In this case we need to pick the one used in Attention
        # For example, this is the case for ViT
        # SkipLayerNormalization --> Attention --> MatMul --> Add --> SkipLayerNormalization
        #  |                                                                     |
        #  |                                                                     |
        #  +---------------------------------------------------------------------+
        if root_input in output_name_to_node:
            parent_node = output_name_to_node[root_input]
            if parent_node.op_type == "SkipLayerNormalization" and len(parent_node.output) == 4:
                root_input = parent_node.output[0]

        children = input_name_to_nodes[root_input]
        children_types = [child.op_type for child in children]
        if children_types.count("MatMul") != 3:
            return

        v_nodes = self.model.match_parent_path(matmul_qkv, ["Transpose", "Reshape", "Add", "MatMul"], [1, 0, 0, None])
        if v_nodes is None:
            logger.debug("fuse_attention: failed to match v path")
            return
        (_, _, add_v, matmul_v) = v_nodes

        is_distill = False
        is_distill_add = False
        is_no_mask_attention = False
        is_sdpa = False
        qk_paths = {
            "path1": (["Softmax", "Add", "Div", "MatMul"], [0, 0, None, 0]),
            "path2": (["Softmax", "Add", "Mul", "MatMul"], [0, 0, None, 0]),
            "path3": (["Softmax", "Where", "MatMul", "Div"], [0, 0, 2, 0]),
            "path4": (["Softmax", "Add", "Where", "MatMul"], [0, 0, 0, 2]),
            "path5": (["Softmax", "Div", "MatMul"], [0, 0, 0]),
            "sdpa": (["Softmax", "Add", "MatMul", "Mul", "Sqrt"], [0, 0, None, 0, 1]),
        }

        qk_nodes = None
        for k, v in qk_paths.items():
            qk_nodes = self.model.match_parent_path(matmul_qkv, v[0], v[1])
            if qk_nodes is None:
                continue
            if k == "path3":
                is_distill = True
            elif k == "path4":
                is_distill_add = True
            elif k == "path5":
                is_no_mask_attention = True
            elif k == "sdpa":
                is_sdpa = True
            break

        if qk_nodes is None:
            logger.debug("fuse_attention: failed to match qk path")
            return

        add_qk = None
        matmul_qk = None
        where_qk = None
        after_q = None
        if is_distill:
            (_, where_qk, matmul_qk, _) = qk_nodes
        elif is_distill_add:
            (_, add_qk, where_qk, matmul_qk) = qk_nodes
        elif is_no_mask_attention:
            (_, _, matmul_qk) = qk_nodes
        elif is_sdpa:
            (_, add_qk, matmul_qk, after_q, _) = qk_nodes
        else:
            (_, add_qk, _, matmul_qk) = qk_nodes

        after_q = after_q or matmul_qk
        q_nodes = self.model.match_parent_path(after_q, ["Transpose", "Reshape", "Add", "MatMul"], [0, 0, 0, None])
        if q_nodes is None:
            q_nodes = self.model.match_parent_path(
                after_q,
                ["Div", "Transpose", "Reshape", "Add", "MatMul"],
                [0, 0, 0, 0, None],
            )
            if q_nodes is None:
                logger.debug("fuse_attention: failed to match q path")
                return
        reshape_q = q_nodes[-3]
        add_q = q_nodes[-2]
        matmul_q = q_nodes[-1]

        after_k = matmul_qk
        if is_sdpa:
            mul_k_nodes = self.model.match_parent_path(matmul_qk, ["Mul", "Sqrt"], [1, None])
            if mul_k_nodes is None:
                logger.debug("fuse_attention: failed to match mul sqrt q path")
                return
            (after_k, _) = mul_k_nodes

        k_nodes = self.model.match_parent_path(
            after_k, ["Transpose", "Reshape", "Add", "MatMul"], [0 if is_sdpa else 1, 0, 0, None]
        )
        if k_nodes is None:
            k_nodes = self.model.match_parent_path(
                matmul_qk,
                ["Transpose", "Transpose", "Reshape", "Add", "MatMul"],
                [1, 0, 0, 0, None],
            )
            if k_nodes is None:
                logger.debug("fuse_attention: failed to match k path")
                return
        add_k = k_nodes[-2]
        matmul_k = k_nodes[-1]

        # Note that Cast might be removed by OnnxRuntime so we match two patterns here.
        mask_nodes = None
        add_qk_str = ""
        if is_distill:
            _, mask_nodes, _ = self.model.match_parent_paths(
                where_qk,
                [
                    (["Expand", "Reshape", "Equal"], [0, 0, 0]),
                    (["Equal", "Unsqueeze", "Unsqueeze"], [0, 0, 0]),
                    (["Cast", "Expand", "Reshape", "Equal"], [0, 0, 0, 0]),
                ],
                output_name_to_node,
            )
        elif is_distill_add:
            _, mask_nodes, _ = self.model.match_parent_paths(
                where_qk,
                [
                    (["Cast", "Equal", "Unsqueeze", "Unsqueeze"], [0, 0, 0, 0]),
                    (["Equal", "Unsqueeze", "Unsqueeze"], [0, 0, 0]),
                ],
                output_name_to_node,
            )
            if add_qk is not None:
                add_qk_str = self.get_add_qk_str(add_qk)
                if add_qk_str is None:
                    logger.debug("fuse_attention: failed to verify shape inference of %s", add_qk)
                    return
        elif is_no_mask_attention:
            pass
        else:
            _, mask_nodes, _ = self.model.match_parent_paths(
                add_qk,
                [
                    (["Mul", "Sub", "Cast", "Unsqueeze", "Unsqueeze"], [None, 0, 1, 0, 0]),
                    (["Mul", "Sub", "Unsqueeze", "Unsqueeze"], [None, 0, 1, 0]),
                    # The following two patterns are for SDPA.
                    (["Where", "Cast", "Sub", "Expand", "Unsqueeze", "Unsqueeze"], [None, 0, 0, 1, 0, 0]),
                    (["Where", "Cast", "Sub", "Cast", "Expand", "Unsqueeze", "Unsqueeze"], [None, 0, 0, 1, 0, 0, 0]),
                ],
                output_name_to_node,
            )
        if not is_no_mask_attention and mask_nodes is None:
            logger.debug("fuse_attention: failed to match mask path")
            return

        if not is_no_mask_attention and len(mask_nodes) > 1:
            _, mul_val = self.model.get_constant_input(mask_nodes[0])
            # The mask value shall be a float scalar (usually is the lowest float value).
            if (
                (mul_val is None)
                or not (isinstance(mul_val, np.ndarray) and mul_val.size == 1)
                or (mul_val.item() >= 0)
            ):
                return
            if mul_val.item() != -10000:
                self.mask_filter_value = mul_val.item()

        if matmul_v.input[0] == root_input and matmul_q.input[0] == root_input and matmul_k.input[0] == root_input:
            mask_index = self.attention_mask.process_mask(mask_nodes[-1].input[0]) if not is_no_mask_attention else None

            attention_last_node = reshape_qkv if einsum_node is None else transpose_qkv

            q_num_heads, q_hidden_size = self.get_num_heads_and_hidden_size(reshape_q)
            if q_num_heads <= 0 or q_hidden_size <= 0:
                logger.warning(
                    "Failed to detect num_heads and hidden_size for Attention fusion. "
                    "Please specify those parameters in argument."
                )
                return

            # number of heads are same for all the paths, hence to create attention node, we pass the q_num_heads
            # the input_hidden_size represents the input hidden size, this is used as needed but hidden sizes for Q, K are extracted appropriately
            new_node = self.create_attention_node(
                mask_index=mask_index,
                q_matmul=matmul_q,
                k_matmul=matmul_k,
                v_matmul=matmul_v,
                q_add=add_q,
                k_add=add_k,
                v_add=add_v,
                num_heads=q_num_heads,
                hidden_size=q_hidden_size,
                first_input=root_input,
                output=attention_last_node.output[0],
                add_qk_str=add_qk_str,
            )

            if new_node is None:
                return

            self.nodes_to_add.append(new_node)
            self.node_name_to_graph_name[new_node.name] = self.this_graph_name

            if einsum_node is not None:
                unique_index = einsum_node.input[0]
                new_edge = "edge_modified_" + unique_index

                shape_tensor = self.add_initializer(
                    name="shape_modified_tensor" + unique_index,
                    data_type=TensorProto.INT64,
                    dims=[4],
                    vals=[0, 0, q_num_heads, int(q_hidden_size / q_num_heads)],
                    raw=False,
                )

                self.model.add_node(
                    helper.make_node(
                        "Reshape",
                        [attention_last_node.output[0], shape_tensor.name],
                        [new_edge],
                        "reshape_modified_" + unique_index,
                    ),
                    self.this_graph_name,
                )
                einsum_node.input[0] = new_edge

            self.nodes_to_remove.extend([attention_last_node, transpose_qkv, matmul_qkv])
            self.nodes_to_remove.extend(qk_nodes)

            # For MultiHeadAttention operator, MatMul nodes for Q/K/V projection shall not be fused.
            self.nodes_to_remove.extend(q_nodes if not self.use_multi_head_attention else q_nodes[:-1])
            self.nodes_to_remove.extend(k_nodes if not self.use_multi_head_attention else k_nodes[:-1])
            self.nodes_to_remove.extend(v_nodes if not self.use_multi_head_attention else v_nodes[:-1])

            # Use prune graph to remove mask nodes since they are shared by all attention nodes.
            self.prune_graph = True
