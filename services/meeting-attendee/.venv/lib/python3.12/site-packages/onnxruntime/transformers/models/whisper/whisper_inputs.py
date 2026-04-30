# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.  See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------

import logging

import numpy as np
import torch
from transformers import WhisperConfig

from onnxruntime import InferenceSession

logger = logging.getLogger(__name__)


# Create audio_features for encoder
# Shape is (batch_size, feature_size, sequence_length) = (batch_size, num_mel_filters, num_frames)
# where num_mel_filters is a model attribute and num_frames = (chunk_length * sample_rate) // hop_length.
#
# Hard-coded audio hyperparameters:
# SAMPLE_RATE = 16000
# N_FFT = 400
# HOP_LENGTH = 160
# CHUNK_LENGTH = 30  (i.e. 30-second chunk of audio)
# N_SAMPLES = CHUNK_LENGTH * SAMPLE_RATE = 30 * 16000 = 480000  (i.e. 480,000 samples in a 30-second chunk of audio)
# N_FRAMES = N_SAMPLES // HOP_LENGTH = 480000 // 160 = 3000  (i.e. 3000 frames in a mel spectrogram input)
#
# N_SAMPLES_PER_TOKEN = HOP_LENGTH * 2 = 160 * 2 = 320
# FRAMES_PER_TOKEN = SAMPLE_RATE // HOP_LENGTH = 16000 // 160 = 100  (i.e. 10 ms per audio frame)
# TOKENS_PER_SECOND = SAMPLE_RATE // N_SAMPLES_PER_TOKEN = 16000 // 320 = 50  (i.e. 20 ms per audio token)
def get_sample_audio_features(
    config: WhisperConfig,
    device: torch.device,
    batch_size: int,
    sequence_length: int = 3000,
    use_fp16: bool = False,
):
    torch_dtype = torch.float16 if use_fp16 else torch.float32
    audio_features = torch.randn(batch_size, config.num_mel_bins, sequence_length, device=device, dtype=torch_dtype)
    return audio_features


# Create input_ids for decoder
# Shape is (batch_size, sequence_length) where sequence_length is the initial decoder sequence length
def get_sample_decoder_input_ids(
    config: WhisperConfig,
    device: torch.device,
    batch_size: int,
    sequence_length: int,
    use_int32: bool = True,
):
    torch_dtype = torch.int32 if use_int32 else torch.int64
    decoder_input_ids = torch.randint(
        low=0, high=config.vocab_size, size=(batch_size, sequence_length), device=device, dtype=torch_dtype
    )
    return decoder_input_ids


# Create encoder_hidden_states for decoder-init
# Shape is (batch_size, num_frames // 2, hidden_size)
def get_sample_encoder_hidden_states(
    config: WhisperConfig,
    device: torch.device,
    batch_size: int,
    use_fp16: bool = False,
):
    torch_dtype = torch.float16 if use_fp16 else torch.float32
    encoder_hidden_states = torch.randn(
        batch_size, config.max_source_positions, config.d_model, device=device, dtype=torch_dtype
    )
    return encoder_hidden_states


# Create past_key_values
# Self-attention KV caches are of shape (batch_size, num_heads, past_sequence_length, head_size)
# Cross-attention KV caches are of shape (batch_size, num_heads, num_frames // 2, head_size)
def get_sample_past_key_values(
    config: WhisperConfig,
    device: torch.device,
    batch_size: int,
    past_seq_len: int,
    use_fp16: bool = False,
):
    num_heads = config.decoder_attention_heads
    head_size = config.d_model // num_heads
    max_source_positions = (
        config.max_source_positions
    )  # equal to num_frames // 2 = encoder's sequence_length // 2 = 3000 // 2 = 1500
    torch_dtype = torch.float16 if use_fp16 else torch.float32
    self_attention_kv_caches = [
        (
            torch.rand(batch_size, num_heads, past_seq_len, head_size, device=device, dtype=torch_dtype),
            torch.rand(batch_size, num_heads, past_seq_len, head_size, device=device, dtype=torch_dtype),
        )
        for _ in range(config.decoder_layers)
    ]
    cross_attention_kv_caches = [
        (
            torch.rand(batch_size, num_heads, max_source_positions, head_size, device=device, dtype=torch_dtype),
            torch.rand(batch_size, num_heads, max_source_positions, head_size, device=device, dtype=torch_dtype),
        )
        for _ in range(config.decoder_layers)
    ]
    return flatten_past_key_values(self_attention_kv_caches, cross_attention_kv_caches)


# Flatten KV caches into pairs-of-4 where each pair is defined as:
# (self_attn_key_cache, self_attn_value_cache, cross_attn_key_cache, cross_attn_value_cache)
def flatten_past_key_values(
    self_attn_kv_caches: list[tuple[torch.Tensor, torch.Tensor]],
    cross_attn_kv_caches: list[tuple[torch.Tensor, torch.Tensor]],
):
    past_key_values = []
    for (self_k_cache, self_v_cache), (cross_k_cache, cross_v_cache) in zip(
        self_attn_kv_caches, cross_attn_kv_caches, strict=False
    ):
        layer_kv_caches = (self_k_cache, self_v_cache, cross_k_cache, cross_v_cache)
        past_key_values.append(layer_kv_caches)
    return past_key_values


# Group KV caches into two 1D lists where one list contains the self attention KV caches and
# one list contains the cross attention KV caches
def group_past_key_values(
    kv_caches: list[tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]],
):
    self_attn_kv_caches, cross_attn_kv_caches = [], []
    for self_k_cache, self_v_cache, cross_k_cache, cross_v_cache in kv_caches:
        self_attn_kv_caches.append(self_k_cache)
        self_attn_kv_caches.append(self_v_cache)
        cross_attn_kv_caches.append(cross_k_cache)
        cross_attn_kv_caches.append(cross_v_cache)
    return self_attn_kv_caches, cross_attn_kv_caches


# Create alignment heads for timestamps
# Shape is (num_alignment_heads, 2)
def get_sample_alignment_heads(
    config: WhisperConfig,
    device: torch.device,
    num_alignment_heads: int = 6,
    use_int32: bool = True,
):
    torch_dtype = torch.int32 if use_int32 else torch.int64
    alignment_heads = torch.ones((num_alignment_heads, 2), device=device, dtype=torch_dtype)
    return alignment_heads


# Create length of start-of-transcription sequence for timestamps
# Shape is (1)
def get_sample_sot_sequence_length(
    device: torch.device,
    sot_sequence_length: int,
    use_int32: bool = False,
):
    torch_dtype = torch.int32 if use_int32 else torch.int64
    sot_length = torch.tensor([sot_sequence_length], device=device, dtype=torch_dtype)
    return sot_length


# Create segment length for timestamps
# Shape is (1)
def get_sample_segment_length(
    device: torch.device,
    segment_length: int,
    use_int32: bool = False,
):
    torch_dtype = torch.int32 if use_int32 else torch.int64
    segment_size = torch.tensor([segment_length], device=device, dtype=torch_dtype)
    return segment_size


# Create QKs for timestamps
# Shape is (batch_size, num_heads, sequence_length, num_frames // 2)
def get_sample_QKs(  # noqa: N802
    config: WhisperConfig,
    device: torch.device,
    batch_size: int,
    sequence_length: int,
    use_fp16: bool = False,
):
    num_heads = config.decoder_attention_heads
    torch_dtype = torch.float16 if use_fp16 else torch.float32
    QKs = [  # noqa: N806
        torch.rand(
            batch_size, num_heads, sequence_length, config.max_source_positions, device=device, dtype=torch_dtype
        )
        for _ in range(config.decoder_layers)
    ]
    return QKs


# Create inputs for encoder component of Whisper
def get_sample_encoder_inputs(
    config: WhisperConfig,
    device: torch.device,
    batch_size: int,
    sequence_length: int = 3000,
    use_fp16: bool = False,
):
    audio_features = get_sample_audio_features(config, device, batch_size, sequence_length, use_fp16)
    return {"audio_features": audio_features}


# Create inputs for encoder component + first pass through decoder component of Whisper
def get_sample_encoder_decoder_init_inputs(
    config: WhisperConfig,
    device: torch.device,
    batch_size: int,
    decoder_sequence_length: int,
    encoder_sequence_length: int = 3000,
    use_fp16: bool = False,
    use_int32: bool = True,
):
    audio_features = get_sample_audio_features(config, device, batch_size, encoder_sequence_length, use_fp16)
    decoder_input_ids = get_sample_decoder_input_ids(config, device, batch_size, decoder_sequence_length, use_int32)
    return {"audio_features": audio_features, "decoder_input_ids": decoder_input_ids}


# Create inputs for decoder component of Whisper
# Inputs for first pass through the decoder (i.e. decoder-init): decoder_input_ids, encoder_hidden_states
# Inputs for subsequent passes through the decoder (i.e. decoder-with-past): decoder_input_ids, past_key_values
def get_sample_decoder_inputs(
    config: WhisperConfig,
    device: torch.device,
    batch_size: int,
    past_sequence_length: int,
    sequence_length: int,
    use_fp16: bool = False,
    use_int32: bool = True,
):
    decoder_input_ids = get_sample_decoder_input_ids(config, device, batch_size, sequence_length, use_int32)
    encoder_hidden_states = get_sample_encoder_hidden_states(config, device, batch_size, use_fp16)
    past_key_values = get_sample_past_key_values(config, device, batch_size, past_sequence_length, use_fp16)
    return {
        "decoder_input_ids": decoder_input_ids,
        "encoder_hidden_states": encoder_hidden_states,
        "past_key_values": past_key_values,
    }


# Create inputs for timestamps component of Whisper
def get_sample_jump_times_inputs(
    config: WhisperConfig,
    device: torch.device,
    batch_size: int,
    sequence_length: int,
    num_alignment_heads: int,
    sot_sequence_length: int,
    segment_length: int,
    use_fp16: bool = False,
    use_int32: bool = True,
):
    alignment_heads = get_sample_alignment_heads(config, device, num_alignment_heads, use_int32)
    # lengths need to be int64 because subsequent 'Slice' ops only take int64 inputs
    sot_sequence_length = get_sample_sot_sequence_length(device, sot_sequence_length)
    segment_length = get_sample_segment_length(device, segment_length)
    QKs = get_sample_QKs(config, device, batch_size, sequence_length, use_fp16)  # noqa: N806
    return {
        "alignment_heads": alignment_heads,
        "sot_sequence_length": sot_sequence_length,
        "segment_length": segment_length,
        "QKs": QKs,
    }


# Convert PyTorch inputs to ONNX Runtime inputs
def convert_inputs_for_ort(
    inputs: dict,
    model: InferenceSession,
):
    self_attn_kv_caches, cross_attn_kv_caches = None, None
    batch_size, num_heads, past_seq_len, head_size = 0, 0, 0, 0
    num_beams, max_seq_len = 1, 448
    if "past_key_values" in inputs:
        (self_attn_kv_caches, cross_attn_kv_caches) = group_past_key_values(inputs["past_key_values"])
        batch_size, num_heads, past_seq_len, head_size = self_attn_kv_caches[0].shape

    ort_inputs = {}
    model_inputs = list(map(lambda i: i.name, model.get_inputs()))  # noqa: C417
    use_buffer_sharing = "cache_indirection" in model_inputs
    for name in model_inputs:
        if name in {"audio_features", "encoder_input_ids"}:
            # Encoder input
            ort_inputs[name] = inputs["audio_features"].detach().cpu().numpy()
        elif name == "encoder_hidden_states":
            # Encoder output
            ort_inputs[name] = inputs["encoder_hidden_states"].detach().cpu().numpy()
        elif name in {"decoder_input_ids", "input_ids"}:
            # Decoder input
            ort_inputs[name] = inputs["decoder_input_ids"].detach().cpu().numpy()
        elif "past_key_self" in name or "past_value_self" in name:
            # Decoder input
            orig_kv_cache = self_attn_kv_caches.pop(0).detach().cpu().numpy()
            if use_buffer_sharing:
                new_kv_cache = np.zeros((batch_size, num_heads, max_seq_len, head_size), dtype=orig_kv_cache.dtype)
                new_kv_cache[:batch_size, :num_heads, :past_seq_len, :head_size] = orig_kv_cache
                ort_inputs[name] = new_kv_cache
            else:
                ort_inputs[name] = orig_kv_cache
        elif "past_key_cross" in name or "past_value_cross" in name:
            # Decoder input
            orig_kv_cache = cross_attn_kv_caches.pop(0).detach().cpu().numpy()
            ort_inputs[name] = orig_kv_cache
        elif name == "past_sequence_length":
            # Decoder input
            ort_inputs[name] = np.array([past_seq_len], dtype=np.int32)
        elif name == "cache_indirection":
            # Decoder input
            ort_inputs[name] = np.zeros((batch_size, num_beams, max_seq_len), dtype=np.int32)
        elif name == "alignment_heads":
            # Jump times input
            ort_inputs[name] = inputs["alignment_heads"].detach().cpu().numpy()
        elif name == "sot_sequence_length":
            # Jump times input
            ort_inputs[name] = inputs["sot_sequence_length"].detach().cpu().numpy()
        elif name == "segment_length":
            # Jump times input
            ort_inputs[name] = inputs["segment_length"].detach().cpu().numpy()
        elif "cross_qk" in name:
            # Jump times input
            ort_inputs[name] = inputs["QKs"].pop(0).detach().cpu().numpy()
        else:
            raise ValueError(f"Unknown name not recognized: {name}")

    return ort_inputs


# Get dynamic axes for all inputs and outputs to the model
def get_model_dynamic_axes(
    config: WhisperConfig,
    input_names: list[str],
    output_names: list[str],
):
    dynamic_axes = {}
    for name in input_names + output_names:
        if name in {"audio_features", "encoder_input_ids"}:
            # shape is (batch_size, num_mels, num_frames)
            dynamic_axes[name] = {0: "batch_size"}
        elif name in {"input_ids", "decoder_input_ids"}:
            # shape is (batch_size, sequence_length)
            dynamic_axes[name] = {0: "batch_size", 1: "sequence_length"}
        elif name == "alignment_heads":
            # shape is (num_alignment_heads, 2)
            dynamic_axes[name] = {0: "num_alignment_heads"}
        elif name in {"sot_sequence_length", "segment_length"}:
            # shape is (1)
            pass
        elif name == "logits":
            # shape is (batch_size, sequence_length, vocab_size)
            dynamic_axes[name] = {0: "batch_size", 1: "sequence_length"}
        elif name == "encoder_hidden_states":
            # shape is (batch_size, num_frames // 2, hidden_size)
            dynamic_axes[name] = {0: "batch_size"}
        elif "past_key_self" in name or "past_value_self" in name:
            # shape is (batch_size, num_heads, past_sequence_length, head_size)
            dynamic_axes[name] = {0: "batch_size", 2: "past_sequence_length"}
        elif "present_key_self" in name or "present_value_self" in name:
            # shape is (batch_size, num_heads, past_sequence_length + sequence_length, head_size),
            # which is equal to (batch_size, num_heads, total_sequence_length, head_size)
            dynamic_axes[name] = {0: "batch_size", 2: "total_sequence_length"}
        elif (
            "past_key_cross" in name
            or "past_value_cross" in name
            or "present_key_cross" in name
            or "present_value_cross" in name
        ):
            # shape is (batch_size, num_heads, num_frames // 2, head_size)
            dynamic_axes[name] = {0: "batch_size"}
        elif "cross_qk" in name:
            # shape is (batch_size, num_heads, source_sequence_length, target_sequence_length)
            dynamic_axes[name] = {0: "batch_size", 2: "sequence_length"}
        elif "jump_times" in name:
            # shape is (batch_size, max_length)
            dynamic_axes[name] = {0: "batch_size", 1: "max_length"}
        else:
            raise Exception(f"Unknown input or output name found: {name}")
    return dynamic_axes
