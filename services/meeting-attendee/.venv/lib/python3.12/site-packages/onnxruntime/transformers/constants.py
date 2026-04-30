# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------


class Operators:
    ATTENTION = "Attention"
    LAYERNORM = "LayerNormalization"
    MULTI_HEAD_ATTENTION = "MultiHeadAttention"
    PACKEDATTENTION = "PackedAttention"
    PACKED_MULTI_HEAD_ATTENTION = "PackedMultiHeadAttention"
    REMOVEPADDING = "RemovePadding"
    RESTOREPADDING = "RestorePadding"
    SKIPLAYERNORM = "SkipLayerNormalization"


class AttentionInputIDs:
    INPUT = 0
    WEIGHTS = 1
    BIAS = 2
    MASK_INDEX = 3
    PAST = 4
    ATTENTION_BIAS = 5
    PAST_SEQUENCE_LENGTH = 6


class AttentionOutputIDs:
    OUTPUT = 0
    PRESENT = 1


class MultiHeadAttentionInputIDs:
    QUERY = 0
    KEY = 1
    VALUE = 2
    BIAS = 3
    KEY_PADDING_MASK = 4
    ATTENTION_BIAS = 5
    PAST_KEY = 6
    PAST_VALUE = 7


class MultiHeadAttentionOutputIDs:
    OUTPUT = 0
    PRESENT_KEY = 1
    PRESENT_VALUE = 2
