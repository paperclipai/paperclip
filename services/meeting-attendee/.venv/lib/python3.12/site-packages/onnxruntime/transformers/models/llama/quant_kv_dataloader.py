# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.  See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------
import argparse

import numpy as np
import torch
from benchmark_helper import create_onnxruntime_session
from datasets import load_dataset
from llama_inputs import get_position_ids
from torch.nn.functional import pad
from torch.utils.data import DataLoader
from transformers import LlamaTokenizer


class QuantKVDataLoader:
    def __init__(self, args: argparse.Namespace, onnx_model_path: str = ""):
        self.batch_size = 1
        self.pad_max = args.pad_max

        tokenizer = LlamaTokenizer.from_pretrained(args.original_model_name, use_auth_token=args.use_auth_token)
        dataset = load_dataset(args.smooth_quant_dataset, split="train")
        dataset = dataset.map(lambda examples: tokenizer(examples["text"]), batched=True)
        dataset.set_format(type="torch", columns=["input_ids", "attention_mask"])

        self.dataloader = DataLoader(
            dataset,
            batch_size=self.batch_size,
            shuffle=False,
            collate_fn=self.collate_batch,
        )
        self.decoder_model = (
            create_onnxruntime_session(
                onnx_model_path,
                args.execution_provider != "cpu",  # use_gpu
                provider=args.execution_provider,
                verbose=args.verbose,
            )
            if onnx_model_path
            else None
        )

    def collate_batch(self, batch):
        input_ids_batched = []
        attention_mask_batched = []
        position_ids_batched = []
        labels = []

        for text in batch:
            # Set inputs for model
            input_ids = text["input_ids"]
            attention_mask = torch.ones(len(input_ids))
            position_ids = get_position_ids(attention_mask, use_past_kv=False)
            label = len(input_ids) - 1

            # Pad input data because all model inputs must have same shape
            pad_len = self.pad_max - input_ids.shape[0]
            input_ids = pad(input_ids, (0, pad_len), value=1)
            attention_mask = pad(attention_mask, (0, pad_len), value=0)
            position_ids = pad(position_ids, (0, pad_len), value=0)

            input_ids_batched.append(input_ids)
            attention_mask_batched.append(attention_mask)
            position_ids_batched.append(position_ids)
            labels.append(label)

        input_ids_batched = torch.vstack(input_ids_batched)
        attention_mask_batched = torch.vstack(attention_mask_batched)
        position_ids_batched = torch.vstack(position_ids_batched)
        labels = torch.tensor(labels)

        return (input_ids_batched, attention_mask_batched, position_ids_batched), labels

    def __iter__(self):
        try:
            for (input_ids, attention_mask, position_ids), labels in self.dataloader:
                # Inputs for decoder_model.onnx
                inputs = {
                    "input_ids": input_ids[:, :-1].detach().cpu().numpy().astype(np.int64),
                    "attention_mask": attention_mask[:, :-1].detach().cpu().numpy().astype(np.int64),
                    "position_ids": position_ids[:, :-1].detach().cpu().numpy().astype(np.int64),
                }
                label = labels.detach().cpu().numpy()

                if self.decoder_model is not None:
                    # Run decoder_model.onnx to get inputs for decoder_with_past_model.onnx
                    outputs = self.decoder_model.run(None, inputs)

                    for i in range(int((len(outputs) - 1) / 2)):
                        inputs[f"past_key_values.{i}.key"] = outputs[i * 2 + 1]
                        inputs[f"past_key_values.{i}.value"] = outputs[i * 2 + 2]
                    past_sequence_length = inputs["past_key_values.0.key"].shape[2]

                    inputs["input_ids"] = input_ids[:, -1].unsqueeze(0).detach().cpu().numpy().astype(np.int64)
                    attn_mask_torch = torch.ones((self.batch_size, past_sequence_length + 1), dtype=torch.int64)
                    inputs["attention_mask"] = attn_mask_torch.detach().cpu().numpy().astype(np.int64)
                    inputs["position_ids"] = (
                        get_position_ids(attn_mask_torch, use_past_kv=True).detach().cpu().numpy().astype(np.int64)
                    )

                # Yield (inputs, label) tuple for Intel's Neural Compressor:
                # https://github.com/intel/neural-compressor/blob/d4baed9ea11614e1f0dc8a1f4f55b73ed3ed585c/neural_compressor/quantization.py#L55-L62
                yield (inputs, label)

        except StopIteration:
            return
