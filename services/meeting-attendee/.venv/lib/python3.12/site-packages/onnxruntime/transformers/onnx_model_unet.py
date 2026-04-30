# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

import logging

from fusion_attention_unet import FusionAttentionUnet
from fusion_bias_add import FusionBiasAdd
from fusion_biassplitgelu import FusionBiasSplitGelu
from fusion_group_norm import FusionGroupNorm
from fusion_nhwc_conv import FusionNhwcConv
from fusion_options import FusionOptions
from fusion_skip_group_norm import FusionSkipGroupNorm
from fusion_transpose import FusionInsertTranspose, FusionTranspose
from import_utils import is_installed
from onnx import ModelProto
from onnx_model import OnnxModel
from onnx_model_bert import BertOnnxModel

logger = logging.getLogger(__name__)


class UnetOnnxModel(BertOnnxModel):
    def __init__(self, model: ModelProto, num_heads: int = 0, hidden_size: int = 0):
        """Initialize UNet ONNX Model.

        Args:
            model (ModelProto): the ONNX model
            num_heads (int, optional): number of attention heads. Defaults to 0 (detect the parameter automatically).
            hidden_size (int, optional): hidden dimension. Defaults to 0 (detect the parameter automatically).
        """
        assert (num_heads == 0 and hidden_size == 0) or (num_heads > 0 and hidden_size % num_heads == 0)

        super().__init__(model, num_heads=num_heads, hidden_size=hidden_size)

    def preprocess(self):
        self.remove_useless_div()

    def postprocess(self):
        self.prune_graph()
        self.remove_unused_constant()

    def remove_useless_div(self):
        """Remove Div by 1"""
        div_nodes = [node for node in self.nodes() if node.op_type == "Div"]

        nodes_to_remove = []
        for div in div_nodes:
            if self.find_constant_input(div, 1.0) == 1:
                nodes_to_remove.append(div)

        for node in nodes_to_remove:
            self.replace_input_of_all_nodes(node.output[0], node.input[0])

        if nodes_to_remove:
            self.remove_nodes(nodes_to_remove)
            logger.info("Removed %d Div nodes", len(nodes_to_remove))

    def convert_conv_to_nhwc(self):
        # Transpose weights in offline might help since ORT does not apply constant-folding on Transpose nodes.
        conv_to_nhwc_conv = FusionNhwcConv(self, update_weight=True)
        conv_to_nhwc_conv.apply()

    def merge_adjacent_transpose(self):
        fusion_transpose = FusionTranspose(self)
        fusion_transpose.apply()

        remove_count = 0
        nodes = self.get_nodes_by_op_type("Transpose")
        for node in nodes:
            permutation = OnnxModel.get_node_attribute(node, "perm")
            assert isinstance(permutation, list)
            if permutation != list(range(len(permutation))):
                continue
            assert not (
                self.find_graph_output(node.output[0])
                or self.find_graph_input(node.input[0])
                or self.find_graph_output(node.input[0])
            )

            # Let all children nodes skip current Transpose node and link to its parent
            # Note that we cannot update parent node output since parent node might have more than one children.
            self.replace_input_of_all_nodes(node.output[0], node.input[0])

            self.remove_node(node)
            remove_count += 1

        total = len(fusion_transpose.nodes_to_remove) + remove_count
        if total:
            logger.info("Removed %d Transpose nodes", total)

    def fuse_multi_head_attention(self, options: FusionOptions | None = None):
        # Self Attention
        enable_packed_qkv = (options is None) or options.enable_packed_qkv
        self_attention_fusion = FusionAttentionUnet(
            self,
            self.hidden_size,
            self.num_heads,
            is_cross_attention=False,
            enable_packed_qkv=enable_packed_qkv,
            enable_packed_kv=False,
        )
        self_attention_fusion.apply()

        # Cross Attention
        enable_packed_kv = (options is None) or options.enable_packed_kv
        cross_attention_fusion = FusionAttentionUnet(
            self,
            self.hidden_size,
            self.num_heads,
            is_cross_attention=True,
            enable_packed_qkv=False,
            enable_packed_kv=enable_packed_kv,
        )
        cross_attention_fusion.apply()

    def fuse_bias_add(self):
        fusion = FusionBiasAdd(self)
        fusion.apply()

    def optimize(self, options: FusionOptions | None = None):
        if is_installed("tqdm"):
            import tqdm  # noqa: PLC0415
            from tqdm.contrib.logging import logging_redirect_tqdm  # noqa: PLC0415

            with logging_redirect_tqdm():
                steps = 18
                progress_bar = tqdm.tqdm(range(steps), initial=0, desc="fusion")
                self._optimize(options, progress_bar)
        else:
            logger.info("tqdm is not installed. Run optimization without progress bar")
            self._optimize(options, None)

    def _optimize(self, options: FusionOptions | None = None, progress_bar=None):
        if (options is not None) and not options.enable_shape_inference:
            self.disable_shape_inference()

        self.utils.remove_identity_nodes()
        if progress_bar:
            progress_bar.update(1)

        # Remove cast nodes that having same data type of input and output based on symbolic shape inference.
        self.utils.remove_useless_cast_nodes()
        if progress_bar:
            progress_bar.update(1)

        if (options is None) or options.enable_layer_norm:
            self.fuse_layer_norm()
        if progress_bar:
            progress_bar.update(1)

        if (options is None) or options.enable_gelu:
            self.fuse_gelu()
        if progress_bar:
            progress_bar.update(1)

        self.preprocess()
        if progress_bar:
            progress_bar.update(1)

        self.fuse_reshape()
        if progress_bar:
            progress_bar.update(1)

        if (options is None) or options.enable_group_norm:
            channels_last = (options is None) or options.group_norm_channels_last
            group_norm_fusion = FusionGroupNorm(self, channels_last)
            group_norm_fusion.apply()

            insert_transpose_fusion = FusionInsertTranspose(self)
            insert_transpose_fusion.apply()
        if progress_bar:
            progress_bar.update(1)

        if (options is None) or options.enable_bias_splitgelu:
            bias_split_gelu_fusion = FusionBiasSplitGelu(self)
            bias_split_gelu_fusion.apply()
        if progress_bar:
            progress_bar.update(1)

        if (options is None) or options.enable_attention:
            # self.save_model_to_file("before_mha.onnx")
            self.fuse_multi_head_attention(options)
        if progress_bar:
            progress_bar.update(1)

        if (options is None) or options.enable_skip_layer_norm:
            self.fuse_skip_layer_norm()
        if progress_bar:
            progress_bar.update(1)

        self.fuse_shape()
        if progress_bar:
            progress_bar.update(1)

        # Remove reshape nodes that having same shape of input and output based on symbolic shape inference.
        self.utils.remove_useless_reshape_nodes()
        if progress_bar:
            progress_bar.update(1)

        if (options is None) or options.enable_skip_group_norm:
            skip_group_norm_fusion = FusionSkipGroupNorm(self)
            skip_group_norm_fusion.apply()
        if progress_bar:
            progress_bar.update(1)

        if (options is None) or options.enable_bias_skip_layer_norm:
            # Fuse SkipLayerNormalization and Add Bias before it.
            self.fuse_add_bias_skip_layer_norm()
        if progress_bar:
            progress_bar.update(1)

        if options is not None and options.enable_gelu_approximation:
            self.gelu_approximation()
        if progress_bar:
            progress_bar.update(1)

        if options is None or options.enable_nhwc_conv:
            self.convert_conv_to_nhwc()
            self.merge_adjacent_transpose()
        if progress_bar:
            progress_bar.update(1)

        if options is not None and options.enable_bias_add:
            self.fuse_bias_add()
        if progress_bar:
            progress_bar.update(1)

        self.postprocess()
        if progress_bar:
            progress_bar.update(1)

        logger.info(f"opset version: {self.get_opset_version()}")

    def get_fused_operator_statistics(self):
        """
        Returns node count of fused operators.
        """
        op_count = {}
        ops = [
            "Attention",
            "MultiHeadAttention",
            "LayerNormalization",
            "SkipLayerNormalization",
            "BiasSplitGelu",
            "GroupNorm",
            "SkipGroupNorm",
            "NhwcConv",
            "BiasAdd",
        ]

        for op in ops:
            nodes = self.get_nodes_by_op_type(op)
            op_count[op] = len(nodes)

        logger.info(f"Optimized operators:{op_count}")
        return op_count
