# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

import logging

from fusion_attention_sam2 import FusionMultiHeadAttentionSam2
from fusion_layernorm import FusionLayerNormalizationNCHW
from fusion_options import FusionOptions
from import_utils import is_installed
from onnx import ModelProto
from onnx_model_bert import BertOnnxModel

logger = logging.getLogger(__name__)


class Sam2OnnxModel(BertOnnxModel):
    def __init__(self, model: ModelProto, num_heads: int = 0, hidden_size: int = 0):
        """Initialize SAM2 ONNX Model.

        Args:
            model (ModelProto): the ONNX model
            num_heads (int, optional): number of attention heads. Defaults to 0 (detect the parameter automatically).
            hidden_size (int, optional): hidden dimension. Defaults to 0 (detect the parameter automatically).
        """
        assert (num_heads == 0 and hidden_size == 0) or (num_heads > 0 and hidden_size % num_heads == 0)

        super().__init__(model, num_heads=num_heads, hidden_size=hidden_size)

    def postprocess(self):
        self.prune_graph()
        self.remove_unused_constant()

    def fuse_layer_norm(self):
        super().fuse_layer_norm()

        fusion = FusionLayerNormalizationNCHW(self)
        fusion.apply()

    def fuse_multi_head_attention(self, options: FusionOptions | None = None):
        mha_fusion = FusionMultiHeadAttentionSam2(self, self.hidden_size, self.num_heads)
        mha_fusion.apply()

    def optimize(self, options: FusionOptions | None = None, add_dynamic_axes: bool = False):
        if is_installed("tqdm"):
            import tqdm  # noqa: PLC0415
            from tqdm.contrib.logging import logging_redirect_tqdm  # noqa: PLC0415

            with logging_redirect_tqdm():
                steps = 12
                progress_bar = tqdm.tqdm(range(steps), initial=0, desc="sam2 fusion")
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

        self.fuse_reshape()
        if progress_bar:
            progress_bar.update(1)

        if (options is None) or options.enable_attention:
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

        if (options is None) or options.enable_bias_skip_layer_norm:
            # Fuse SkipLayerNormalization and Add Bias before it.
            self.fuse_add_bias_skip_layer_norm()
        if progress_bar:
            progress_bar.update(1)

        if options is not None and options.enable_gelu_approximation:
            self.gelu_approximation()
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
            "MultiHeadAttention",
            "LayerNormalization",
            "SkipLayerNormalization",
        ]

        for op in ops:
            nodes = self.get_nodes_by_op_type(op)
            op_count[op] = len(nodes)

        logger.info(f"Optimized operators:{op_count}")
        return op_count
