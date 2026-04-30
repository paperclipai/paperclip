# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
import logging

from fusion_attention import AttentionMask
from fusion_conformer_attention import FusionConformerAttention
from fusion_options import FusionOptions
from onnx_model_bert import BertOnnxModel

logger = logging.getLogger(__name__)


class ConformerOnnxModel(BertOnnxModel):
    def __init__(self, model, num_heads, hidden_size):
        super().__init__(model, num_heads, hidden_size)
        self.attention_mask = AttentionMask(self)
        self.attention_fusion = FusionConformerAttention(self, self.hidden_size, self.num_heads, self.attention_mask)

    def optimize(self, options: FusionOptions | None = None, add_dynamic_axes: bool = False):
        self.attention_fusion.use_multi_head_attention = False if options is None else options.use_multi_head_attention
        self.attention_fusion.disable_multi_head_attention_bias = (
            False if options is None else options.disable_multi_head_attention_bias
        )
        super().optimize(options, add_dynamic_axes)

    def fuse_attention(self):
        self.attention_fusion.apply()

    def preprocess(self):
        self.adjust_reshape_and_expand()
