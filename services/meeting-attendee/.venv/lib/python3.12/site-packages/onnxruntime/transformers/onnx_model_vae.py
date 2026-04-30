# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

from logging import getLogger

from fusion_attention_vae import FusionAttentionVae
from fusion_options import FusionOptions
from onnx import ModelProto
from onnx_model_unet import UnetOnnxModel

logger = getLogger(__name__)


class VaeOnnxModel(UnetOnnxModel):
    def __init__(self, model: ModelProto, num_heads: int = 0, hidden_size: int = 0):
        assert (num_heads == 0 and hidden_size == 0) or (num_heads > 0 and hidden_size % num_heads == 0)
        super().__init__(model, num_heads=num_heads, hidden_size=hidden_size)

    def fuse_multi_head_attention(self, options: FusionOptions | None = None):
        # Self Attention
        self_attention_fusion = FusionAttentionVae(self, self.hidden_size, self.num_heads)
        self_attention_fusion.apply()

    def get_fused_operator_statistics(self):
        """
        Returns node count of fused operators.
        """
        op_count = {}
        ops = [
            "Attention",
            "GroupNorm",
            "SkipGroupNorm",
            "NhwcConv",
        ]
        for op in ops:
            nodes = self.get_nodes_by_op_type(op)
            op_count[op] = len(nodes)

        logger.info(f"Optimized operators:{op_count}")
        return op_count
