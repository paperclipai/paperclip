# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.  See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------
from __future__ import annotations

import numpy as np
import torch
from transformers import AutoConfig, AutoTokenizer
from transformers.cache_utils import DynamicCache

from onnxruntime import InferenceSession, OrtValue


# Get position_ids from attention_mask
def get_position_ids(attention_mask: torch.Tensor, use_past_kv: bool):
    position_ids = attention_mask.long().cumsum(-1) - 1
    position_ids.masked_fill_(attention_mask == 0, 1)
    if use_past_kv:
        # Shape: (batch_size, 1)
        position_ids = position_ids[:, -1].unsqueeze(-1)

    # Shape: (batch_size, sequence_length)
    return position_ids


# Inputs for first pass to get initial past_key_values
#   input_ids: (batch_size, sequence_length)
#   attention_mask: (batch_size, sequence_length)
#   position_ids: (batch_size, sequence_length)
def get_sample_inputs(
    config: AutoConfig,
    device: torch.device,
    batch_size: int,
    seq_len: int,
    engine: str = "pt",
    return_dict: bool = False,
):
    input_ids = torch.randint(low=0, high=config.vocab_size, size=(batch_size, seq_len), dtype=torch.int64)
    attention_mask = torch.ones(batch_size, seq_len, dtype=torch.int64)
    position_ids = get_position_ids(attention_mask, use_past_kv=False)

    # Convert inputs to NumPy (for ORT) or send to device (for PyTorch)
    input_ids = input_ids.numpy() if engine == "ort" else input_ids.to(device)
    attention_mask = attention_mask.numpy() if engine == "ort" else attention_mask.to(device)
    position_ids = position_ids.numpy() if engine == "ort" else position_ids.to(device)

    if not return_dict:
        # For export
        return (input_ids, attention_mask, position_ids)

    inputs = {
        "input_ids": input_ids,
        "attention_mask": attention_mask,
        "position_ids": position_ids,
    }
    return inputs


# Inputs for subsequent passes with past_key_values
#   input_ids: (batch_size, 1)
#   attention_mask: (batch_size, past_sequence_length + 1)
#   position_ids: (batch_size, 1)
#   past_key: (batch_size, num_heads, past_sequence_length, head_size)
#   past_value: (batch_size, num_heads, past_sequence_length, head_size)
def get_sample_with_past_kv_inputs(
    config: AutoConfig,
    device: torch.device,
    batch_size: int,
    past_seq_len: int,
    use_fp16: bool = False,
    engine: str = "pt",
    return_dict: bool = False,
    world_size: int = 1,
):
    input_ids = torch.randint(low=0, high=config.vocab_size, size=(batch_size, 1), dtype=torch.int64)
    attention_mask = torch.ones(batch_size, past_seq_len + 1, dtype=torch.int64)
    # position_ids is of shape (batch_size, 1)
    position_ids = get_position_ids(attention_mask, use_past_kv=True)
    past_kv = get_past_kv_inputs(config, batch_size, past_seq_len, use_fp16, world_size=world_size)

    # Convert inputs to NumPy (for ORT) or send to device (for PyTorch)
    input_ids = input_ids.numpy() if engine == "ort" else input_ids.to(device)
    attention_mask = attention_mask.numpy() if engine == "ort" else attention_mask.to(device)
    position_ids = position_ids.numpy() if engine == "ort" else position_ids.to(device)
    past_kv = (
        flatten_past_kv_inputs(past_kv) if engine == "ort" else [(kv[0].to(device), kv[1].to(device)) for kv in past_kv]
    )

    if not return_dict:
        # For export
        assert isinstance(past_kv, list)
        return (input_ids, attention_mask, position_ids, past_kv)

    inputs = {
        "input_ids": input_ids,
        "attention_mask": attention_mask,
        "position_ids": position_ids,
    }
    if engine == "ort":
        assert isinstance(past_kv, dict)
        inputs.update(past_kv)
    else:
        assert isinstance(past_kv, list)
        inputs["past_key_values"] = past_kv

    return inputs


# Inputs for all passes with past_key_values
#   input_ids: (batch_size, sequence_length)
#   attention_mask: (batch_size, past_sequence_length + sequence_length)
#   position_ids: (batch_size, sequence_length)
#   past_key: (batch_size, num_heads, kv_sequence_length, head_size)
#      For models with GQA, kv_sequence_length = max_sequence_length
#      For models without GQA, kv_sequence_length = past_sequence_length
#   past_value: (batch_size, num_heads, kv_sequence_length, head_size)
#      For models with GQA, kv_sequence_length = max_sequence_length
#      For models without GQA, kv_sequence_length = past_sequence_length
def get_merged_sample_with_past_kv_inputs(
    config: AutoConfig,
    device: torch.device,
    batch_size: int,
    seq_len: int,
    past_seq_len: int,
    max_seq_len: int,
    use_fp16: bool = False,
    use_buffer_share: bool = False,
    engine: str = "pt",
    return_dict: bool = False,
    world_size: int = 1,
):
    input_ids = torch.randint(low=0, high=config.vocab_size, size=(batch_size, seq_len), dtype=torch.int64)
    attention_mask = torch.ones(batch_size, past_seq_len + seq_len, dtype=torch.int64)
    # position_ids is of shape (batch_size, seq_len) for prompt generation, (batch_size, 1) for token generation
    position_ids = get_position_ids(attention_mask, use_past_kv=(past_seq_len != 0))
    past_kv = get_past_kv_inputs(config, batch_size, past_seq_len, use_fp16, world_size=world_size)

    # Convert inputs to NumPy (for ORT) or send to device (for PyTorch)
    input_ids = input_ids.numpy() if engine == "ort" else input_ids.to(device)
    attention_mask = attention_mask.numpy() if engine == "ort" else attention_mask.to(device)
    position_ids = position_ids.numpy() if engine == "ort" else position_ids.to(device)
    past_kv = (
        flatten_past_kv_inputs(past_kv) if engine == "ort" else [(kv[0].to(device), kv[1].to(device)) for kv in past_kv]
    )

    if not return_dict:
        # For export
        assert isinstance(past_kv, list)
        return (input_ids, attention_mask, position_ids, past_kv)

    inputs = {
        "input_ids": input_ids,
        "attention_mask": attention_mask,
        "position_ids": position_ids,
    }
    if engine == "ort":
        assert isinstance(past_kv, dict)
        inputs.update(past_kv)

        if use_buffer_share:
            inputs = enable_past_present_share_buffer(inputs, past_seq_len, max_seq_len)

    else:
        assert isinstance(past_kv, list)
        inputs["past_key_values"] = past_kv

    return inputs


# Inputs for Microsoft export from https://github.com/microsoft/Llama-2-Onnx
def get_msft_sample_inputs(
    config: AutoConfig,
    batch_size: int,
    past_seq_len: int,
    seq_len: int,
    max_seq_len: int,
    use_fp16: bool,
    use_buffer_share: bool,
    split_kv: bool,
):
    np_dtype = np.float16 if use_fp16 else np.float32
    head_size = config.hidden_size // config.num_attention_heads

    if not split_kv:
        ort_inputs = {
            "x": np.random.rand(batch_size, seq_len, config.hidden_size).astype(np_dtype),
            "attn_mask": (-10000.0 * np.triu(np.ones((batch_size, max_seq_len, max_seq_len)), k=1)).astype(np_dtype),
            "k_cache": np.random.rand(
                batch_size, config.num_hidden_layers, past_seq_len, config.num_attention_heads, head_size
            ).astype(np_dtype),
            "v_cache": np.random.rand(
                batch_size, config.num_hidden_layers, past_seq_len, config.num_attention_heads, head_size
            ).astype(np_dtype),
            "pos": np.array(past_seq_len, dtype=np.int64),
        }
    else:
        ort_inputs = {
            "x": np.random.rand(batch_size, seq_len, config.hidden_size).astype(np_dtype),
            "attn_mask": (np.triu(np.ones((batch_size, max_seq_len, max_seq_len), dtype=np.int32), k=1) - 1).astype(
                np.int32
            ),
            "pos": np.array(past_seq_len, dtype=np.int64),
        }
        for i in range(config.num_hidden_layers):
            ort_inputs.update(
                {
                    f"k_{i}_cache": np.random.rand(
                        batch_size, config.num_attention_heads, past_seq_len, head_size
                    ).astype(np_dtype),
                    f"v_{i}_cache": np.random.rand(
                        batch_size, config.num_attention_heads, past_seq_len, head_size
                    ).astype(np_dtype),
                }
            )

        if use_buffer_share:
            ort_inputs = enable_past_present_share_buffer(ort_inputs, past_seq_len, max_seq_len)

    return ort_inputs


# Create past_key_values
# Each is of shape (batch_size, num_heads, past_sequence_length, head_size)
def get_past_kv_inputs(config: AutoConfig, batch_size: int, past_seq_len: int, use_fp16: bool, world_size: int = 1):
    num_heads = config.num_key_value_heads // world_size
    head_size = config.head_dim if hasattr(config, "head_dim") else config.hidden_size // config.num_attention_heads
    torch_dtype = torch.float16 if use_fp16 else torch.float32
    past_kv = [
        (
            torch.rand(batch_size, num_heads, past_seq_len, head_size, dtype=torch_dtype),
            torch.rand(batch_size, num_heads, past_seq_len, head_size, dtype=torch_dtype),
        )
        for _ in range(config.num_hidden_layers)
    ]
    return past_kv


# Convert list of past_key_values to dict of past_key and past_value
def flatten_past_kv_inputs(past_key_values: list[tuple[torch.Tensor, torch.Tensor]]):
    past_kv = {}
    for i, (past_k, past_v) in enumerate(past_key_values):
        if isinstance(past_key_values, DynamicCache):
            past_kv[f"past_key_values_key_cache_{i}"] = past_k.detach().cpu().numpy()
            past_kv[f"past_key_values_value_cache_{i}"] = past_v.detach().cpu().numpy()
        else:
            past_kv[f"past_key_values.{i}.key"] = past_k.detach().cpu().numpy()
            past_kv[f"past_key_values.{i}.value"] = past_v.detach().cpu().numpy()
    return past_kv


# Format PyTorch inputs to ONNX Runtime inputs
def convert_inputs_for_ort(
    pt_inputs: dict,
    use_buffer_share: bool = False,
    past_seq_len: int = 0,
    max_seq_len: int = 2048,
):
    ort_inputs = {}
    for k, v in pt_inputs.items():
        if isinstance(v, np.ndarray):
            ort_inputs[k] = v
        elif k == "past_key_values":
            ort_inputs.update(flatten_past_kv_inputs(v))
        else:
            ort_inputs[k] = v.detach().cpu().numpy()

    # Reshape KV caches if using past-present-share-buffer
    if use_buffer_share:
        ort_inputs = enable_past_present_share_buffer(ort_inputs, past_seq_len, max_seq_len)

    return ort_inputs


# Re-allocate KV caches from (batch_size, num_heads, past_sequence_length, head_size) to
# (batch_size, num_heads, max_sequence_length, head_size) for past-present buffer sharing
def enable_past_present_share_buffer(ort_inputs: dict, past_seq_len: int, max_seq_len: int):
    for k, v in ort_inputs.items():
        # Allocate new buffers with max_sequence_length for GQA
        if "cache" in k or "past_key_values" in k:
            # Copy v (BxSxPxH) into new_v (BxSxMxH)
            batch_size, num_heads, _, head_size = v.shape
            new_v = np.zeros((batch_size, num_heads, max_seq_len, head_size), dtype=v.dtype)
            new_v[:batch_size, :num_heads, :past_seq_len, :head_size] = v
            ort_inputs[k] = new_v
    return ort_inputs


# Verify ONNX Runtime inputs with model
def verify_ort_inputs(model: InferenceSession, ort_inputs: dict):
    # Check that all model inputs will be provided
    model_inputs = {model_input.name for model_input in model.get_inputs()}
    user_inputs = set(ort_inputs.keys())
    missing_inputs = model_inputs - user_inputs
    if len(missing_inputs):
        print(f"The following model inputs are missing: {missing_inputs}")
        raise Exception("There are missing inputs to the model. Please add them and try again.")

    # Remove unnecessary inputs from model inputs
    unnecessary_inputs = user_inputs - model_inputs
    if len(unnecessary_inputs):
        for unnecessary_input in unnecessary_inputs:
            del ort_inputs[unnecessary_input]

    return ort_inputs


# Add IO bindings for execution providers using OrtValue
# Use when you need to run inference once or twice to save memory
def add_io_bindings_as_ortvalues(
    model: InferenceSession,
    ort_inputs: dict,
    device: str,
    device_id: int,
    use_buffer_share: bool,
    kv_cache_ortvalues: dict,
):
    io_binding = model.io_binding()

    model_inputs = {i.name for i in model.get_inputs()}
    for k, v in ort_inputs.items():
        # Use this check to handle scenarios such as INT4 CUDA and FP16 CUDA models with
        # GQA + RotaryEmbedding fusion where `position_ids` is removed as an ONNX model input
        # but `position_ids` is used as a PyTorch model input
        if k not in model_inputs:
            continue

        # Bind OrtValue inputs to device
        if use_buffer_share and ("cache" in k or "past_key_values" in k):
            if k not in kv_cache_ortvalues:
                v_device = OrtValue.ortvalue_from_numpy(v, device_type=device, device_id=device_id)
                io_binding.bind_ortvalue_input(k, v_device)
                kv_cache_ortvalues[k] = v_device
            else:
                kv_cache_ortvalues[k].update_inplace(v)
                io_binding.bind_ortvalue_input(k, kv_cache_ortvalues[k])
        else:
            v_device = OrtValue.ortvalue_from_numpy(v, device_type=device, device_id=device_id)
            io_binding.bind_ortvalue_input(k, v_device)

    for output in model.get_outputs():
        name = output.name
        if use_buffer_share and ("out" in name or "present" in name):
            # Bind present KV cache outputs to past KV cache inputs in order to buffer share
            input_name = name.replace("out", "cache").replace("present", "past_key_values")
            io_binding.bind_ortvalue_output(name, kv_cache_ortvalues[input_name])
        else:
            io_binding.bind_output(name, device_type=device, device_id=device_id)

    return io_binding, kv_cache_ortvalues


# Add IO bindings for execution providers using PyTorch tensors
# Use when you need to run inference many times
def add_io_bindings_as_tensors(
    model: InferenceSession, inputs: dict, outputs: dict, use_fp16: bool, use_buffer_share: bool
):
    # Verify model inputs
    inputs = verify_ort_inputs(model, inputs)

    device = None
    pt_to_np = {
        "torch.int32": np.int32,
        "torch.int64": np.int64,
        "torch.float16": np.float16,
        "torch.float32": np.float32,
    }

    # Bind inputs/outputs to IO binding
    io_binding = model.io_binding()
    for k, v in inputs.items():
        io_binding.bind_input(
            name=k,
            device_type=v.device.type,
            device_id=0 if v.device.type == "cpu" else v.device.index,
            element_type=pt_to_np[repr(v.dtype)],
            shape=tuple(v.shape),
            buffer_ptr=v.data_ptr(),
        )
        device = v.device

    for output in model.get_outputs():
        name = output.name
        # Bind KV cache outputs to KV cache inputs
        v = (
            inputs[name.replace("present", "past_key_values")]
            if use_buffer_share and "present" in name
            else outputs[name]
        )
        io_binding.bind_output(
            name=name,
            device_type=device.type,
            device_id=0 if device.type == "cpu" else device.index,
            element_type=(np.float16 if use_fp16 else np.float32),
            shape=tuple(v.shape),
            buffer_ptr=v.data_ptr(),
        )

    return io_binding


# Get actual inputs when using real data (instead of sample data) and initialize outputs
def get_initial_inputs_and_outputs(
    config: AutoConfig,
    tokenizer: AutoTokenizer,
    requested_length: int,
    prompt: list[str],
    device: torch.device,
    use_fp16: bool,
    use_buffer_share: bool,
    engine: str,
):
    tokenizer.pad_token = tokenizer.eos_token
    encodings_dict = tokenizer.batch_encode_plus(prompt, padding=True)
    torch_dtype = torch.float16 if use_fp16 else torch.float32

    # input_ids:      pad token id is 0
    # attention_mask: pad token id is 0
    # position_ids:   pad token id is 1
    input_ids = torch.tensor(encodings_dict["input_ids"], device=device, dtype=torch.int64)
    attention_mask = torch.tensor(encodings_dict["attention_mask"], device=device, dtype=torch.int64)
    position_ids = get_position_ids(attention_mask, use_past_kv=False)

    # Check if tokenized prompt length matches the requested prompt length
    tokenized_length = input_ids.shape[-1]
    if tokenized_length > requested_length:
        # Shorten the inputs from (batch_size, tokenized_length) to (batch_size, requested_length)
        input_ids = input_ids[:, :requested_length]
        attention_mask = attention_mask[:, :requested_length]
        position_ids = get_position_ids(attention_mask, use_past_kv=False)
    elif tokenized_length < requested_length:
        # Lengthen the inputs from (batch_size, tokenized_length) to (batch_size, requested_length)
        input_ids_first_col = input_ids[:, 0].unsqueeze(0).T
        attention_mask_first_col = attention_mask[:, 0].unsqueeze(0).T
        for _ in range(requested_length - tokenized_length):
            input_ids = torch.hstack((input_ids_first_col, input_ids))
            attention_mask = torch.hstack((attention_mask_first_col, attention_mask))
        position_ids = get_position_ids(attention_mask, use_past_kv=False)

    tokenized_length = input_ids.shape[-1]
    assert tokenized_length == requested_length

    # Create inputs
    inputs = {
        "input_ids": input_ids.contiguous() if engine == "ort" else input_ids,
        "attention_mask": attention_mask.contiguous() if engine == "ort" else attention_mask,
        "position_ids": position_ids.contiguous() if engine == "ort" else position_ids,
    }
    if engine != "ort":
        inputs["past_key_values"] = []

    # Get shape of KV cache inputs
    batch_size, sequence_length = input_ids.shape
    max_sequence_length = config.max_position_embeddings
    num_heads = config.num_key_value_heads
    head_size = config.head_dim if hasattr(config, "head_dim") else config.hidden_size // config.num_attention_heads

    # Create KV cache inputs
    for i in range(config.num_hidden_layers):
        past_key = torch.zeros(
            batch_size,
            num_heads,
            max_sequence_length if use_buffer_share else 0,
            head_size,
            device=device,
            dtype=torch_dtype,
        )
        past_value = torch.zeros(
            batch_size,
            num_heads,
            max_sequence_length if use_buffer_share else 0,
            head_size,
            device=device,
            dtype=torch_dtype,
        )
        if engine == "ort":
            inputs.update(
                {
                    f"past_key_values.{i}.key": past_key.contiguous(),
                    f"past_key_values.{i}.value": past_value.contiguous(),
                }
            )
        else:
            inputs["past_key_values"].append((past_key, past_value))

    outputs = None
    if engine == "ort":
        # Create outputs
        logits = torch.zeros(batch_size, sequence_length, config.vocab_size, device=device, dtype=torch_dtype)
        outputs = {"logits": logits.contiguous()}
        if not use_buffer_share:
            for i in range(config.num_hidden_layers):
                present_key = torch.zeros(
                    batch_size, num_heads, sequence_length, head_size, device=device, dtype=torch_dtype
                )
                present_value = torch.zeros(
                    batch_size, num_heads, sequence_length, head_size, device=device, dtype=torch_dtype
                )
                outputs.update(
                    {f"present.{i}.key": present_key.contiguous(), f"present.{i}.value": present_value.contiguous()}
                )

    return inputs, outputs
