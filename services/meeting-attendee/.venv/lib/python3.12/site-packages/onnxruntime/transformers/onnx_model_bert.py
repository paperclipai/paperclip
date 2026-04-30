# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

from logging import getLogger

import numpy as np
from convert_to_packing_mode import PackingMode
from fusion_attention import AttentionMask, FusionAttention
from fusion_bart_attention import FusionBartAttention
from fusion_biasgelu import FusionBiasGelu
from fusion_constant_fold import FusionConstantFold
from fusion_embedlayer import FusionEmbedLayerNormalization
from fusion_fastgelu import FusionFastGelu
from fusion_gelu import FusionGelu
from fusion_gelu_approximation import FusionGeluApproximation
from fusion_gemmfastgelu import FusionGemmFastGelu
from fusion_layernorm import FusionLayerNormalization, FusionLayerNormalizationTF
from fusion_options import AttentionMaskFormat, FusionOptions
from fusion_qordered_attention import FusionQOrderedAttention
from fusion_qordered_gelu import FusionQOrderedGelu
from fusion_qordered_layernorm import FusionQOrderedLayerNormalization
from fusion_qordered_matmul import FusionQOrderedMatMul
from fusion_quickgelu import FusionQuickGelu
from fusion_reshape import FusionReshape
from fusion_rotary_attention import FusionRotaryEmbeddings
from fusion_shape import FusionShape
from fusion_simplified_layernorm import FusionSimplifiedLayerNormalization, FusionSkipSimplifiedLayerNormalization
from fusion_skiplayernorm import FusionBiasSkipLayerNormalization, FusionSkipLayerNormalization
from fusion_utils import FusionUtils
from onnx import ModelProto, TensorProto, helper, numpy_helper
from onnx_model import OnnxModel

logger = getLogger(__name__)


class BertOnnxModel(OnnxModel):
    def __init__(self, model: ModelProto, num_heads: int = 0, hidden_size: int = 0):
        """Initialize BERT ONNX Model.

        Args:
            model (ModelProto): the ONNX model
            num_heads (int, optional): number of attention heads. Defaults to 0 (detect the parameter automatically).
            hidden_size (int, optional): hidden dimension. Defaults to 0 (detect the parameter automatically).
        """
        assert (num_heads == 0 and hidden_size == 0) or (num_heads > 0 and hidden_size % num_heads == 0)

        super().__init__(model)
        self.num_heads = num_heads
        self.hidden_size = hidden_size

        self.attention_mask = AttentionMask(self)
        self.attention_fusion = FusionAttention(self, self.hidden_size, self.num_heads, self.attention_mask)
        self.qordered_attention_fusion = FusionQOrderedAttention(
            self, self.hidden_size, self.num_heads, self.attention_mask
        )
        self.utils = FusionUtils(self)

    def fuse_constant_fold(self):
        fusion = FusionConstantFold(self)
        fusion.apply()

    def fuse_attention(self):
        self.attention_fusion.apply()
        # Only relevant in models with Q-DQ nodes
        self.qordered_attention_fusion.apply()

    def fuse_gelu(self):
        fusion = FusionGelu(self)
        fusion.apply()
        fusion = FusionFastGelu(self)
        fusion.apply()
        fusion = FusionQuickGelu(self)
        fusion.apply()
        # Only relevant in models with Q-DQ nodes
        fusion = FusionQOrderedGelu(self)
        fusion.apply()

    def fuse_bias_gelu(self, is_fastgelu):
        fusion = FusionBiasGelu(self, is_fastgelu)
        fusion.apply()

    def gelu_approximation(self):
        fusion = FusionGeluApproximation(self)
        fusion.apply()

    def fuse_gemm_fast_gelu(self):
        fusion = FusionGemmFastGelu(self)
        fusion.apply()

    def fuse_add_bias_skip_layer_norm(self):
        fusion = FusionBiasSkipLayerNormalization(self)
        fusion.apply()

    def fuse_reshape(self):
        fusion = FusionReshape(self)
        fusion.apply()

    def fuse_shape(self):
        fusion = FusionShape(self)
        fusion.apply()

    def fuse_embed_layer(self, use_mask_index):
        fusion = FusionEmbedLayerNormalization(self, use_mask_index)
        fusion.apply()

    def fuse_layer_norm(self):
        fusion = FusionLayerNormalization(self)
        fusion.apply()

        fusion = FusionLayerNormalizationTF(self)
        fusion.apply()

        # Only relevant in models with Q-DQ nodes
        fusion = FusionQOrderedLayerNormalization(self)
        fusion.apply()

    def fuse_simplified_layer_norm(self):
        fusion = FusionSimplifiedLayerNormalization(self)
        fusion.apply()

    def fuse_skip_layer_norm(self, shape_infer=True):
        fusion = FusionSkipLayerNormalization(self, shape_infer=shape_infer)
        fusion.apply()

    def fuse_skip_simplified_layer_norm(self):
        fusion = FusionSkipSimplifiedLayerNormalization(self)
        fusion.apply()

    def fuse_rotary_embeddings(self):
        fusion = FusionRotaryEmbeddings(self)
        fusion.apply()
        # Remove non-MS domain functions
        rot_emb_nodes = list(
            filter(
                lambda node: node.op_type == "RotaryEmbedding" and node.domain != "com.microsoft",
                self.model.graph.node,
            )
        )
        non_ms_domains_to_keep = {node.domain for node in rot_emb_nodes}
        i = 0
        while i < len(self.model.functions):
            fn = self.model.functions[i]
            if "RotaryEmbedding" in fn.name and fn.domain not in non_ms_domains_to_keep:
                self.model.functions.remove(fn)
            else:
                i += 1

    # Only relevant in models with Q-DQ nodes
    def fuse_qordered_mamtul(self):
        fusion = FusionQOrderedMatMul(self)
        fusion.apply()

    def get_graph_inputs_from_node_type(self, op_type: str, input_indices: list[int], casted: bool):
        """
        Get graph inputs that feed into node type (like EmbedLayerNormalization or Attention).
        Returns a list of the graph input names based on the filter whether it is casted or not.
        """
        graph_inputs = []

        output_name_to_node = self.output_name_to_node()
        nodes = self.get_nodes_by_op_type(op_type)
        for node in nodes:
            bert_inputs = [node.input[i] for i in input_indices if i < len(node.input)]
            for bert_input in bert_inputs:
                if self.find_graph_input(bert_input):
                    if not casted:
                        graph_inputs.append(bert_input)
                elif bert_input in output_name_to_node:
                    parent = output_name_to_node[bert_input]
                    if parent.op_type == "Cast" and self.find_graph_input(parent.input[0]) is not None:
                        if casted:
                            graph_inputs.append(parent.input[0])
        return graph_inputs

    def get_graph_inputs_from_fused_nodes(self, casted: bool):
        inputs = self.get_graph_inputs_from_node_type("EmbedLayerNormalization", [0, 1, 7], casted)
        inputs += self.get_graph_inputs_from_node_type("Attention", [3], casted)
        return inputs

    def change_graph_inputs_to_int32(self):
        """Change data type of all graph inputs to int32 type, and add Cast node if needed."""
        graph = self.graph()
        add_cast_count = 0
        remove_cast_count = 0
        for graph_input in graph.input:
            new_node, removed_nodes = self.change_graph_input_type(graph_input, TensorProto.INT32)
            if new_node:
                add_cast_count += 1
            remove_cast_count += len(removed_nodes)
        logger.info(
            f"Graph inputs are changed to int32. Added {add_cast_count} Cast nodes, and removed {remove_cast_count} Cast nodes."
        )

    def use_dynamic_axes(self, dynamic_batch_dim="batch_size", dynamic_seq_len="max_seq_len"):
        """
        Update input and output shape to use dynamic axes.
        """
        bert_graph_inputs = self.get_graph_inputs_from_fused_nodes(
            casted=True
        ) + self.get_graph_inputs_from_fused_nodes(casted=False)

        for input in self.model.graph.input:
            if input.name in bert_graph_inputs:
                dim_proto = input.type.tensor_type.shape.dim[0]
                dim_proto.dim_param = dynamic_batch_dim
                if dynamic_seq_len is not None:
                    dim_proto = input.type.tensor_type.shape.dim[1]
                    dim_proto.dim_param = dynamic_seq_len

        for output in self.model.graph.output:
            dim_proto = output.type.tensor_type.shape.dim[0]
            dim_proto.dim_param = dynamic_batch_dim

    def preprocess(self):
        self.adjust_reshape_and_expand()
        return

    def adjust_reshape_and_expand(self):
        nodes_to_remove = []
        for node in self.nodes():
            if node.op_type == "Reshape":
                # Clean up unnecessary reshape nodes.
                # Find reshape nodes with no actually data in "shape" attribute and remove.
                reshape_shape = self.get_constant_value(node.input[1])
                if reshape_shape is not None and reshape_shape.size == 0:
                    nodes_to_remove.extend([node])
                    self.replace_input_of_all_nodes(node.output[0], node.input[0])
                    continue

                # Find path "Slice" -> "Reshape" -> "Expand" -> "Expand" -> current "Reshape", simplify the graph by
                # changing current reshape's input to output of slice.
                reshape_path = self.match_parent_path(
                    node,
                    ["Expand", "Expand", "Reshape", "Slice"],
                    [0, 0, 0, 0],
                    self.output_name_to_node(),
                )
                if reshape_path is not None:
                    expand_node = reshape_path[-3]
                    expand_shape_value = self.get_constant_value(expand_node.input[1])

                    reshape_before_expand = reshape_path[-2]
                    shape_value = self.get_constant_value(reshape_before_expand.input[1])

                    slice_node = reshape_path[-1]
                    if (
                        expand_shape_value is not None
                        and shape_value is not None
                        and len(expand_shape_value) == 2
                        and len(shape_value) == 1
                        and expand_shape_value[1] == shape_value[0]
                    ):
                        node.input[0] = slice_node.output[0]

        if nodes_to_remove:
            self.remove_nodes(nodes_to_remove)
            logger.info(f"Removed Reshape and Expand count: {len(nodes_to_remove)}")

    def clean_graph(self):
        output_name_to_node = self.output_name_to_node()
        nodes_to_remove = []
        for node in self.nodes():
            # Before:
            #  input_ids --> Shape --> Gather(indices=0) --> Unsqueeze ------+
            #          |                                                     |
            #          |                                                     v
            #          +----> Shape --> Gather(indices=1) --> Unsqueeze--->  Concat --> ConstantOfShape -->Cast --> EmbedLayerNormaliation/ReduceSum
            # After (Concat path simplified, Cast merged into ConstantOfShape):
            #  input_ids --> Shape --> ConstantOfShape --> EmbedLayerNormalization/ReduceSum
            op_input_id = {"EmbedLayerNormalization": 1, "ReduceSum": 0, "Attention": 3}
            if node.op_type in op_input_id:
                i = op_input_id[node.op_type]
                parent_nodes = self.match_parent_path(
                    node,
                    [
                        "Cast",
                        "ConstantOfShape",
                        "Concat",
                        "Unsqueeze",
                        "Gather",
                        "Shape",
                    ],
                    [i, 0, 0, 0, 0, 0],
                    output_name_to_node,
                )
                if parent_nodes is not None:
                    (
                        cast,
                        constant_of_shape,
                        concat,
                        unsqueeze,
                        gather,
                        shape,
                    ) = parent_nodes
                    if shape.input[0] == self.graph().input[0].name:
                        constant_of_shape.input[0] = shape.output[0]

                        # Merge ConstantOfShape → Cast: update the value attribute dtype
                        # so ConstantOfShape directly produces the target type.
                        cast_to_type = OnnxModel.get_node_attribute(cast, "to")
                        cos_tensor = OnnxModel.get_node_attribute(constant_of_shape, "value")
                        if cast_to_type is not None and cos_tensor is not None:
                            fill_val = numpy_helper.to_array(cos_tensor).flat[0]
                            np_dtype = helper.tensor_dtype_to_np_dtype(cast_to_type)
                            new_val = numpy_helper.from_array(np.array([fill_val], dtype=np_dtype))
                            for i, attr in enumerate(constant_of_shape.attribute):
                                if attr.name == "value":
                                    constant_of_shape.attribute[i].CopyFrom(helper.make_attribute("value", new_val))
                                    break
                            self.replace_input_of_all_nodes(cast.output[0], constant_of_shape.output[0])
                            nodes_to_remove.append(cast)

                        output_name_to_node = self.output_name_to_node()

            if node.op_type == "Attention":
                # Before (Cast present or already merged into ConstantOfShape):
                #   input_ids --> Shape --> ConstantOfShape [--> Cast] --> ReduceSum --> Attention
                # After:
                #   remove this path, and remove the optional mask_index input of Attention node.
                parent_nodes = self.match_parent_path(
                    node,
                    ["ReduceSum", "Cast", "ConstantOfShape", "Shape"],
                    [3, 0, 0, 0],
                    output_name_to_node,
                )
                if parent_nodes is None:
                    # Also try merged pattern (Cast already folded into ConstantOfShape).
                    parent_nodes = self.match_parent_path(
                        node,
                        ["ReduceSum", "ConstantOfShape", "Shape"],
                        [3, 0, 0],
                        output_name_to_node,
                    )
                if parent_nodes is not None:
                    if parent_nodes[-1].input[0] == self.graph().input[0].name:
                        attention_node = helper.make_node(
                            "Attention",
                            inputs=node.input[0 : len(node.input) - 1],
                            outputs=node.output,
                            name=node.name + "_remove_mask",
                        )
                        attention_node.domain = "com.microsoft"
                        attention_node.attribute.extend([helper.make_attribute("num_heads", self.num_heads)])
                        self.add_node(attention_node, self.get_graph_by_node(node).name)
                        nodes_to_remove.append(node)
        self.remove_nodes(nodes_to_remove)

    def postprocess(self):
        self.clean_graph()
        self.prune_graph()

    def optimize(self, options: FusionOptions | None = None, add_dynamic_axes: bool = False):
        if (options is not None) and not options.enable_shape_inference:
            self.disable_shape_inference()

        self.utils.remove_identity_nodes()

        # Remove cast nodes that having same data type of input and output based on symbolic shape inference.
        self.utils.remove_useless_cast_nodes()

        # Apply any missed constant-folding model optimizations (e.g. for Dynamo-exported models)
        self.fuse_constant_fold()

        if (options is None) or options.enable_layer_norm:
            self.fuse_layer_norm()
            self.fuse_simplified_layer_norm()

        if (options is None) or options.enable_gelu:
            self.fuse_gelu()

        self.preprocess()

        self.fuse_reshape()

        if (options is None) or options.enable_skip_layer_norm:
            self.fuse_skip_layer_norm(options.enable_shape_inference)
            self.fuse_skip_simplified_layer_norm()

        if (options is None) or options.enable_rotary_embeddings:
            self.fuse_rotary_embeddings()

        if options is not None:
            self.attention_mask.set_mask_format(options.attention_mask_format)
            if options.use_multi_head_attention and not isinstance(self.attention_fusion, FusionBartAttention):
                self.attention_fusion = FusionAttention(
                    self,
                    self.hidden_size,
                    self.num_heads,
                    self.attention_mask,
                    options.use_multi_head_attention,
                )

        if (options is None) or options.enable_attention:
            self.fuse_attention()

        # Perform the MatMul fusion after the Attention fusion as we do not
        # want to fuse the MatMuls inside the Attention subgraphs
        if (options is None) or options.enable_qordered_matmul:
            self.fuse_qordered_mamtul()

        self.fuse_shape()

        if (options is None) or options.enable_embed_layer_norm:
            use_mask_index = options.attention_mask_format == AttentionMaskFormat.MaskIndexEnd
            self.fuse_embed_layer(use_mask_index)

        # Remove reshape nodes that having same shape of input and output based on symbolic shape inference.
        self.utils.remove_useless_reshape_nodes()

        self.postprocess()

        # Bias fusion is done after postprocess to avoid extra Reshape between bias and Gelu/FastGelu/SkipLayerNormalization
        if (options is None) or options.enable_bias_gelu:
            # Fuse Gelu and Add Bias before it.
            self.fuse_bias_gelu(is_fastgelu=True)
            self.fuse_bias_gelu(is_fastgelu=False)

        if (options is None) or options.enable_bias_skip_layer_norm:
            # Fuse SkipLayerNormalization and Add Bias before it.
            self.fuse_add_bias_skip_layer_norm()

        if options is not None and options.enable_gelu_approximation:
            self.gelu_approximation()

        if options is not None and options.enable_gemm_fast_gelu:
            self.fuse_gemm_fast_gelu()

        self.remove_unused_constant()

        # Use symbolic batch dimension in input and output.
        if add_dynamic_axes:
            self.use_dynamic_axes()

        logger.info(f"opset version: {self.get_opset_version()}")

    def get_fused_operator_statistics(self):
        """
        Returns node count of fused operators.
        """
        op_count = {}
        ops = [
            "EmbedLayerNormalization",
            "Attention",
            "MultiHeadAttention",
            "Gelu",
            "FastGelu",
            "BiasGelu",
            "GemmFastGelu",
            "LayerNormalization",
            "SimplifiedLayerNormalization",
            "SkipLayerNormalization",
            "SkipSimplifiedLayerNormalization",
            "RotaryEmbedding",
        ]
        q_ops = [
            "QOrderedAttention",
            "QOrderedGelu",
            "QOrderedLayerNormalization",
            "QOrderedMatMul",
        ]
        for op in ops + q_ops:
            nodes = self.get_nodes_by_op_type(op)
            op_count[op] = len(nodes)

        logger.info(f"Optimized operators: {op_count}")
        return op_count

    def is_fully_optimized(self, fused_op_count=None):
        """
        Returns True when the model is fully optimized.
        """
        if fused_op_count is None:
            fused_op_count = self.get_fused_operator_statistics()

        def op_count(op_name: str):
            return fused_op_count.get(op_name) or 0

        embed = op_count("EmbedLayerNormalization")
        attention = op_count("Attention") + op_count("MultiHeadAttention") + op_count("QOrderedAttention")
        gelu = op_count("Gelu") + op_count("BiasGelu") + op_count("FastGelu")
        layer_norm = op_count("LayerNormalization") + op_count("SkipLayerNormalization")
        simple_layer_norm = op_count("SimplifiedLayerNormalization") + op_count("SkipSimplifiedLayerNormalization")

        is_perfect = (
            (embed > 0)
            and (attention > 0)
            and (attention == gelu)
            and ((layer_norm >= 2 * attention) or (simple_layer_norm >= 2 * attention))
        )

        if layer_norm == 0:
            logger.debug("Layer Normalization not fused")

        if simple_layer_norm == 0:
            logger.debug("Simple Layer Normalization not fused")

        if gelu == 0:
            logger.debug("Gelu (or FastGelu) not fused")

        if embed == 0:
            logger.debug("EmbedLayerNormalization not fused")

        if attention == 0:
            logger.warning("Attention (or MultiHeadAttention) not fused")

        return is_perfect

    def convert_to_packing_mode(self, use_symbolic_shape_infer: bool = False):
        packing_mode = PackingMode(self)
        packing_mode.convert(use_symbolic_shape_infer)
