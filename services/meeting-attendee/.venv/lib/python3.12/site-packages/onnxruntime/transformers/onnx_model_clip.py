# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

from logging import getLogger

from fusion_attention_clip import FusionAttentionClip
from onnx import ModelProto
from onnx_model_bert import BertOnnxModel

logger = getLogger(__name__)


class ClipOnnxModel(BertOnnxModel):
    def __init__(self, model: ModelProto, num_heads: int = 0, hidden_size: int = 0):
        super().__init__(model, num_heads=num_heads, hidden_size=hidden_size)
        self.clip_attention_fusion = FusionAttentionClip(self, self.hidden_size, self.num_heads)

    def get_fused_operator_statistics(self):
        """
        Returns node count of fused operators.
        """
        op_count = {}
        ops = [
            "Attention",
            "FastGelu",
            "Gelu",
            "LayerNormalization",
            "QuickGelu",
            "BiasGelu",
            "SkipLayerNormalization",
        ]
        for op in ops:
            nodes = self.get_nodes_by_op_type(op)
            op_count[op] = len(nodes)

        logger.info(f"Optimized operators:{op_count}")
        return op_count

    def fuse_attention(self):
        self.clip_attention_fusion.apply()
