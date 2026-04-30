# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.  See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------
# This script helps creating dummy inputs for Longformer model.

import logging

import numpy
import torch

logger = logging.getLogger(__name__)

PRETRAINED_LONGFORMER_MODELS = {
    "longformer-base-4096": "allenai/longformer-base-4096",
    "longformer-large-4096": "allenai/longformer-large-4096",
    "longformer-random-tiny": "patrickvonplaten/longformer-random-tiny",  # A tiny model for debugging
}


class LongformerInputs:
    def __init__(self, input_ids, attention_mask, global_attention_mask):
        self.input_ids: torch.LongTensor = input_ids
        self.attention_mask: torch.FloatTensor | torch.HalfTensor = attention_mask
        self.global_attention_mask: torch.FloatTensor | torch.HalfTensor = global_attention_mask

    def to_list(self) -> list:
        return [v for v in [self.input_ids, self.attention_mask, self.global_attention_mask] if v is not None]

    def to_tuple(self) -> tuple:
        return tuple(v for v in self.to_list())

    def get_ort_inputs(self) -> dict:
        return {
            "input_ids": numpy.ascontiguousarray(self.input_ids.cpu().numpy()),
            "attention_mask": numpy.ascontiguousarray(self.attention_mask.cpu().numpy()),
            "global_attention_mask": numpy.ascontiguousarray(self.global_attention_mask.cpu().numpy()),
        }


class LongformerHelper:
    """A helper class for Longformer model conversion, inference and verification."""

    @staticmethod
    def get_dummy_inputs(
        batch_size: int,
        sequence_length: int,
        num_global_tokens: int,
        device: torch.device,
        vocab_size: int = 100,
    ) -> LongformerInputs:
        """Create random inputs for Longformer model.
        Returns torch tensors of input_ids, attention_mask and global_attention_mask tensors.
        """

        input_ids = torch.randint(
            low=0,
            high=vocab_size - 1,
            size=(batch_size, sequence_length),
            dtype=torch.long,
            device=device,
        )
        attention_mask = torch.ones(input_ids.shape, dtype=torch.long, device=device)
        global_attention_mask = torch.zeros(input_ids.shape, dtype=torch.long, device=device)
        global_token_index = list(range(num_global_tokens))
        global_attention_mask[:, global_token_index] = 1
        return LongformerInputs(input_ids, attention_mask, global_attention_mask)

    @staticmethod
    def get_output_shapes(batch_size: int, sequence_length: int, hidden_size: int) -> dict[str, list[int]]:
        """Returns a dictionary with output name as key, and shape as value."""
        return {
            "last_state": [batch_size, sequence_length, hidden_size],
            "pooler": [batch_size, sequence_length],
        }
