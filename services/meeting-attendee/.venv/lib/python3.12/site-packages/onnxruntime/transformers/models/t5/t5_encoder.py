# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.
# -------------------------------------------------------------------------

import logging
import random

import torch
from transformers import MT5Config, T5Config

logger = logging.getLogger(__name__)


class T5Encoder(torch.nn.Module):
    """T5 encoder outputs only the last hidden state"""

    def __init__(self, encoder, config: T5Config | MT5Config):
        super().__init__()
        self.encoder = encoder
        self.config = config

    def forward(self, input_ids, attention_mask):
        return self.encoder(input_ids, attention_mask)[0]


class T5EncoderInputs:
    def __init__(self, input_ids, attention_mask):
        self.input_ids: torch.LongTensor = input_ids
        self.attention_mask: torch.LongTensor = attention_mask

    @staticmethod
    def create_dummy(
        batch_size: int,
        sequence_length: int,
        vocab_size: int,
        device: torch.device,
        use_int32_inputs: bool = False,
    ):  # -> T5EncoderInputs
        """Create dummy inputs for T5 encoder.

        Args:
            batch_size (int): batch size
            sequence_length (int): sequence length
            vocab_size (int): vocabulary size
            device (torch.device): device of output tensors

        Returns:
            T5EncoderInputs: dummy inputs for encoder
        """
        dtype = torch.int32 if use_int32_inputs else torch.int64

        input_ids = torch.randint(
            low=0,
            high=vocab_size - 1,
            size=(batch_size, sequence_length),
            dtype=dtype,
            device=device,
        )

        attention_mask = torch.ones([batch_size, sequence_length], dtype=dtype, device=device)
        if sequence_length >= 2:
            for i in range(batch_size):
                padding_position = random.randint(0, sequence_length - 1)
                attention_mask[i, :padding_position] = 0
        return T5EncoderInputs(input_ids, attention_mask)

    def to_list(self) -> list:
        input_list = [v for v in [self.input_ids, self.attention_mask] if v is not None]
        return input_list
