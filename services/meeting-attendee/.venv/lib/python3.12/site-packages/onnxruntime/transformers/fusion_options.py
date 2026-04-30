# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
from argparse import ArgumentParser
from enum import Enum


class AttentionMaskFormat:
    # Build 1D mask indice (sequence length). It requires right side padding! Recommended for BERT model to get best performance.
    MaskIndexEnd = 0

    # For experiment only. Do not use it in production.
    MaskIndexEndAndStart = 1

    # Raw attention mask with 0 means padding (or no attention) and 1 otherwise.
    AttentionMask = 2

    # No attention mask
    NoMask = 3


class AttentionOpType(Enum):
    Attention = "Attention"
    MultiHeadAttention = "MultiHeadAttention"
    GroupQueryAttention = "GroupQueryAttention"
    PagedAttention = "PagedAttention"

    def __str__(self):
        return self.value

    # Override __eq__ to return string comparison
    def __hash__(self):
        return hash(self.value)

    def __eq__(self, other):
        return other.value == self.value


class FusionOptions:
    """Options of fusion in graph optimization"""

    def __init__(self, model_type):
        self.enable_gelu = True
        self.enable_layer_norm = True
        self.enable_attention = True
        self.enable_rotary_embeddings = True

        # Use MultiHeadAttention instead of Attention operator. The difference:
        # (1) Attention has merged weights for Q/K/V projection, which might be faster in some cases since 3 MatMul is
        #     merged into one.
        # (2) Attention could only handle self attention; MultiHeadAttention could handle both self and cross attention.
        self.use_multi_head_attention = False
        self.disable_multi_head_attention_bias = False

        self.enable_skip_layer_norm = True
        self.enable_embed_layer_norm = True
        self.enable_bias_skip_layer_norm = True
        self.enable_bias_gelu = True
        self.enable_gelu_approximation = False
        self.enable_qordered_matmul = True

        self.enable_shape_inference = True
        self.enable_gemm_fast_gelu = False
        self.group_norm_channels_last = True

        if model_type in ["clip", "qwen3"]:
            self.enable_embed_layer_norm = False

        # Set default to sequence length for BERT model to use fused attention to speed up.
        # Note that embed layer normalization will convert 2D mask to 1D when mask type is MaskIndexEnd.
        self.attention_mask_format = AttentionMaskFormat.AttentionMask
        if model_type == "bert":
            self.attention_mask_format = AttentionMaskFormat.MaskIndexEnd
        elif model_type in ["vit", "qwen3"]:
            self.attention_mask_format = AttentionMaskFormat.NoMask

        self.attention_op_type = None

        # options for stable diffusion
        if model_type in ["unet", "vae", "clip"]:
            self.enable_nhwc_conv = True
            self.enable_group_norm = True
            self.enable_skip_group_norm = True
            self.enable_bias_splitgelu = True
            self.enable_packed_qkv = True
            self.enable_packed_kv = True
            self.enable_bias_add = True

    def use_raw_attention_mask(self, use_raw_mask=True):
        if use_raw_mask:
            self.attention_mask_format = AttentionMaskFormat.AttentionMask
        else:
            self.attention_mask_format = AttentionMaskFormat.MaskIndexEnd

    def disable_attention_mask(self):
        self.attention_mask_format = AttentionMaskFormat.NoMask

    def set_attention_op_type(self, attn_op_type: AttentionOpType):
        self.attention_op_type = attn_op_type

    @staticmethod
    def parse(args):
        options = FusionOptions(args.model_type)
        if args.disable_gelu:
            options.enable_gelu = False
        if args.disable_layer_norm:
            options.enable_layer_norm = False
        if args.disable_rotary_embeddings:
            options.enable_rotary_embeddings = False
        if args.disable_attention:
            options.enable_attention = False
        if args.use_multi_head_attention:
            options.use_multi_head_attention = True
        if args.disable_skip_layer_norm:
            options.enable_skip_layer_norm = False
        if args.disable_embed_layer_norm:
            options.enable_embed_layer_norm = False
        if args.disable_bias_skip_layer_norm:
            options.enable_bias_skip_layer_norm = False
        if args.disable_bias_gelu:
            options.enable_bias_gelu = False
        if args.enable_gelu_approximation:
            options.enable_gelu_approximation = True
        if args.disable_shape_inference:
            options.enable_shape_inference = False
        if args.enable_gemm_fast_gelu:
            options.enable_gemm_fast_gelu = True
        if args.use_mask_index:
            options.use_raw_attention_mask(False)
        if args.use_raw_attention_mask:
            options.use_raw_attention_mask(True)
        if args.no_attention_mask:
            options.disable_attention_mask()

        if args.model_type in ["unet", "vae", "clip"]:
            if args.use_group_norm_channels_first:
                options.group_norm_channels_last = False
            if args.disable_nhwc_conv:
                options.enable_nhwc_conv = False
            if args.disable_group_norm:
                options.enable_group_norm = False
            if args.disable_skip_group_norm:
                options.enable_skip_group_norm = False
            if args.disable_bias_splitgelu:
                options.enable_bias_splitgelu = False
            if args.disable_packed_qkv:
                options.enable_packed_qkv = False
            if args.disable_packed_kv:
                options.enable_packed_kv = False
            if args.disable_bias_add:
                options.enable_bias_add = False

        return options

    @staticmethod
    def add_arguments(parser: ArgumentParser):
        parser.add_argument(
            "--disable_attention",
            required=False,
            action="store_true",
            help="disable Attention fusion",
        )
        parser.set_defaults(disable_attention=False)

        parser.add_argument(
            "--disable_skip_layer_norm",
            required=False,
            action="store_true",
            help="disable SkipLayerNormalization fusion",
        )
        parser.set_defaults(disable_skip_layer_norm=False)

        parser.add_argument(
            "--disable_embed_layer_norm",
            required=False,
            action="store_true",
            help="disable EmbedLayerNormalization fusion",
        )
        parser.set_defaults(disable_embed_layer_norm=False)

        parser.add_argument(
            "--disable_bias_skip_layer_norm",
            required=False,
            action="store_true",
            help="disable Add Bias and SkipLayerNormalization fusion",
        )
        parser.set_defaults(disable_bias_skip_layer_norm=False)

        parser.add_argument(
            "--disable_bias_gelu",
            required=False,
            action="store_true",
            help="disable Add Bias and Gelu/FastGelu fusion",
        )
        parser.set_defaults(disable_bias_gelu=False)

        parser.add_argument(
            "--disable_layer_norm",
            required=False,
            action="store_true",
            help="disable LayerNormalization fusion",
        )
        parser.set_defaults(disable_layer_norm=False)

        parser.add_argument(
            "--disable_gelu",
            required=False,
            action="store_true",
            help="disable Gelu fusion",
        )
        parser.set_defaults(disable_gelu=False)

        parser.add_argument(
            "--enable_gelu_approximation",
            required=False,
            action="store_true",
            help="enable Gelu/BiasGelu to FastGelu conversion",
        )
        parser.set_defaults(enable_gelu_approximation=False)

        parser.add_argument(
            "--disable_shape_inference",
            required=False,
            action="store_true",
            help="disable symbolic shape inference",
        )
        parser.set_defaults(disable_shape_inference=False)

        parser.add_argument(
            "--enable_gemm_fast_gelu",
            required=False,
            action="store_true",
            help="enable GemmfastGelu fusion",
        )
        parser.set_defaults(enable_gemm_fast_gelu=False)

        parser.add_argument(
            "--use_mask_index",
            required=False,
            action="store_true",
            help="use mask index to activate fused attention to speed up. It requires right-side padding!",
        )
        parser.set_defaults(use_mask_index=False)

        parser.add_argument(
            "--use_raw_attention_mask",
            required=False,
            action="store_true",
            help="use raw attention mask. Use this option if your input is not right-side padding. This might deactivate fused attention and get worse performance.",
        )
        parser.set_defaults(use_raw_attention_mask=False)

        parser.add_argument(
            "--no_attention_mask",
            required=False,
            action="store_true",
            help="no attention mask. Only works for model_type=bert",
        )
        parser.set_defaults(no_attention_mask=False)

        parser.add_argument(
            "--use_multi_head_attention",
            required=False,
            action="store_true",
            help="Use MultiHeadAttention instead of Attention operator for testing purpose. "
            "Note that MultiHeadAttention might be slower than Attention when qkv are not packed. ",
        )
        parser.set_defaults(use_multi_head_attention=False)

        parser.add_argument(
            "--disable_group_norm",
            required=False,
            action="store_true",
            help="not fuse GroupNorm. Only works for model_type=unet or vae",
        )
        parser.set_defaults(disable_group_norm=False)

        parser.add_argument(
            "--disable_skip_group_norm",
            required=False,
            action="store_true",
            help="not fuse Add + GroupNorm to SkipGroupNorm. Only works for model_type=unet or vae",
        )
        parser.set_defaults(disable_skip_group_norm=False)

        parser.add_argument(
            "--disable_packed_kv",
            required=False,
            action="store_true",
            help="not use packed kv for cross attention in MultiHeadAttention. Only works for model_type=unet",
        )
        parser.set_defaults(disable_packed_kv=False)

        parser.add_argument(
            "--disable_packed_qkv",
            required=False,
            action="store_true",
            help="not use packed qkv for self attention in MultiHeadAttention. Only works for model_type=unet",
        )
        parser.set_defaults(disable_packed_qkv=False)

        parser.add_argument(
            "--disable_bias_add",
            required=False,
            action="store_true",
            help="not fuse BiasAdd. Only works for model_type=unet",
        )
        parser.set_defaults(disable_bias_add=False)

        parser.add_argument(
            "--disable_bias_splitgelu",
            required=False,
            action="store_true",
            help="not fuse BiasSplitGelu. Only works for model_type=unet",
        )
        parser.set_defaults(disable_bias_splitgelu=False)

        parser.add_argument(
            "--disable_nhwc_conv",
            required=False,
            action="store_true",
            help="Do not use NhwcConv. Only works for model_type=unet or vae",
        )
        parser.set_defaults(disable_nhwc_conv=False)

        parser.add_argument(
            "--use_group_norm_channels_first",
            required=False,
            action="store_true",
            help="Use channels_first (NCHW) instead of channels_last (NHWC) for GroupNorm. Only works for model_type=unet or vae",
        )
        parser.set_defaults(use_group_norm_channels_first=False)

        parser.add_argument(
            "--disable_rotary_embeddings",
            required=False,
            action="store_true",
            help="Do not fuse rotary embeddings into RotaryEmbedding op",
        )
