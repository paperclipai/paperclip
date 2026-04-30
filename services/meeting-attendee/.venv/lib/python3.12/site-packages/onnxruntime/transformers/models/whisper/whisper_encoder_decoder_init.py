# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.  See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------

import logging
import os
import tempfile
from itertools import chain
from pathlib import Path

import numpy as np
import onnx
import torch
from float16 import convert_float_to_float16
from onnx import ModelProto, ValueInfoProto
from onnx_model import OnnxModel
from transformers import WhisperConfig
from whisper_decoder import WhisperDecoder
from whisper_encoder import WhisperEncoder
from whisper_inputs import (
    convert_inputs_for_ort,
    get_model_dynamic_axes,
    get_sample_encoder_decoder_init_inputs,
    group_past_key_values,
)

from onnxruntime import InferenceSession

logger = logging.getLogger(__name__)


class WhisperEncoderDecoderInit(torch.nn.Module):
    """Whisper encoder component + first pass through Whisper decoder component to initialize KV caches"""

    def __init__(self, config: WhisperConfig, model: torch.nn.Module, model_impl: str, no_beam_search_op: bool = False):
        super().__init__()
        self.config = config
        self.device = model.device
        self.model_impl = model_impl
        self.no_beam_search_op = no_beam_search_op

        self.encoder = WhisperEncoder(config, model, model_impl)
        self.decoder = WhisperDecoder(config, model, model_impl, no_beam_search_op)

        self.max_source_positions = self.config.max_source_positions
        self.num_heads = self.config.decoder_attention_heads
        self.head_size = self.config.d_model // self.num_heads

    def hf_forward_for_beam_search_op(self, audio_features: torch.Tensor, decoder_input_ids: torch.Tensor):
        encoder_hidden_states = self.encoder(audio_features)
        logits, present_key_values = self.decoder(decoder_input_ids, encoder_hidden_states)
        return logits, encoder_hidden_states, present_key_values

    def hf_forward_for_no_beam_search_op(self, audio_features: torch.Tensor):
        encoder_hidden_states = self.encoder(audio_features)

        # Get cross attention KV caches and return them for this model
        # We do this because these MatMuls are only run once before their outputs are being re-used in the decoder
        present_cross_attention_key_value_caches = []
        for layer in self.decoder.decoder.layers:
            cross_attn_key_cache = (
                layer.encoder_attn.k_proj(encoder_hidden_states)
                .view(-1, self.max_source_positions, self.num_heads, self.head_size)
                .transpose(1, 2)
            )
            cross_attn_value_cache = (
                layer.encoder_attn.v_proj(encoder_hidden_states)
                .view(-1, self.max_source_positions, self.num_heads, self.head_size)
                .transpose(1, 2)
            )
            present_cross_attention_key_value_caches.append(cross_attn_key_cache)
            present_cross_attention_key_value_caches.append(cross_attn_value_cache)

        return encoder_hidden_states, present_cross_attention_key_value_caches

    def oai_forward_for_beam_search_op(self, audio_features: torch.Tensor, decoder_input_ids: torch.Tensor):
        encoder_hidden_states = self.encoder(audio_features)
        logits, present_key_values = self.decoder(decoder_input_ids, encoder_hidden_states)
        return logits, encoder_hidden_states, present_key_values

    def oai_forward_for_no_beam_search_op(self, audio_features: torch.Tensor):
        encoder_hidden_states = self.encoder(audio_features)

        # Get cross attention KV caches and return them for this model
        # We do this because these MatMuls are only run once before their outputs are being re-used in the decoder
        present_cross_attention_key_value_caches = []
        for block in self.decoder.model.decoder.blocks:
            cross_attn_key_cache = (
                block.cross_attn.key(encoder_hidden_states)
                .view(-1, self.max_source_positions, self.num_heads, self.head_size)
                .transpose(1, 2)
            )
            cross_attn_value_cache = (
                block.cross_attn.value(encoder_hidden_states)
                .view(-1, self.max_source_positions, self.num_heads, self.head_size)
                .transpose(1, 2)
            )
            present_cross_attention_key_value_caches.append(cross_attn_key_cache)
            present_cross_attention_key_value_caches.append(cross_attn_value_cache)

        return encoder_hidden_states, present_cross_attention_key_value_caches

    def forward(self, audio_features: torch.Tensor, decoder_input_ids: torch.Tensor | None = None):
        if self.model_impl == "openai":
            if self.no_beam_search_op:
                return self.oai_forward_for_no_beam_search_op(audio_features)
            return self.oai_forward_for_beam_search_op(audio_features, decoder_input_ids)

        # Hugging Face implementation
        if self.no_beam_search_op:
            return self.hf_forward_for_no_beam_search_op(audio_features)
        return self.hf_forward_for_beam_search_op(audio_features, decoder_input_ids)

    def input_names(self):
        if self.no_beam_search_op:
            input_names = ["audio_features"]
        else:
            input_names = ["encoder_input_ids", "decoder_input_ids"]
        return input_names

    def output_names(self):
        if self.no_beam_search_op:
            output_names = [
                "encoder_hidden_states",
                *list(
                    chain.from_iterable(
                        (f"present_key_cross_{i}", f"present_value_cross_{i}")
                        for i in range(self.config.decoder_layers)
                    )
                ),
            ]
        else:
            output_names = [
                "logits",
                "encoder_hidden_states",
                *list(
                    chain.from_iterable(
                        (
                            f"present_key_self_{i}",
                            f"present_value_self_{i}",
                            f"present_key_cross_{i}",
                            f"present_value_cross_{i}",
                        )
                        for i in range(self.config.decoder_layers)
                    )
                ),
            ]
        return output_names

    def dynamic_axes(self, input_names, output_names):
        dynamic_axes = get_model_dynamic_axes(self.config, input_names, output_names)
        return dynamic_axes

    def inputs(self, use_fp16_inputs: bool, use_int32_inputs: bool, return_dict: bool = False):
        inputs = get_sample_encoder_decoder_init_inputs(
            self.config,
            self.device,
            batch_size=2,
            decoder_sequence_length=6,
            use_fp16=use_fp16_inputs,
            use_int32=use_int32_inputs,
        )
        if return_dict:
            if self.no_beam_search_op:
                del inputs["decoder_input_ids"]
            return inputs

        if self.no_beam_search_op:
            return (inputs["audio_features"],)
        return (
            inputs["audio_features"],
            inputs["decoder_input_ids"],
        )

    def fix_key_value_cache_dims(self, output: ValueInfoProto, is_cross: bool = False):
        # Shape should be (batch_size, num_heads, sequence_length, head_size) for self attention KV caches
        # and (batch_size, num_heads, num_frames // 2, head_size) for cross attention KV caches
        num_heads = output.type.tensor_type.shape.dim[1]
        if "_dim_" in num_heads.dim_param:
            num_heads.Clear()
            num_heads.dim_value = self.num_heads
        sequence_length = output.type.tensor_type.shape.dim[2]
        if "_dim_" in sequence_length.dim_param:
            sequence_length.Clear()
            if is_cross:
                sequence_length.dim_value = self.max_source_positions
            else:
                sequence_length.dim_param = "total_sequence_length"
        head_size = output.type.tensor_type.shape.dim[3]
        if "_dim_" in head_size.dim_param:
            head_size.Clear()
            head_size.dim_value = self.head_size
        return output

    def fix_outputs(self, model: ModelProto):
        # ONNX exporter might mark dimensions like 'Transposepresent_value_self_1_dim_2' in shape inference.
        # We now change the dim_values to the correct one.
        reordered_outputs = []
        self_attn_kv_caches = []
        cross_attn_kv_caches = []

        for output in model.graph.output:
            if "present" not in output.name:
                reordered_outputs.append(output)

            elif "self" in output.name:
                # Self attention KV caches
                new_output = self.fix_key_value_cache_dims(output, is_cross=False)
                if self.no_beam_search_op:
                    reordered_outputs.append(new_output)
                else:
                    self_attn_kv_caches.append(new_output)
            else:
                # Cross attention KV caches
                new_output = self.fix_key_value_cache_dims(output, is_cross=True)
                if self.no_beam_search_op:
                    reordered_outputs.append(new_output)
                else:
                    cross_attn_kv_caches.append(new_output)

        if not self.no_beam_search_op:
            reordered_outputs += self_attn_kv_caches + cross_attn_kv_caches

        while len(model.graph.output) > 0:
            model.graph.output.pop()
        model.graph.output.extend(reordered_outputs)
        return model

    def fix_layernorm_weights(self, model: ModelProto, use_fp16_inputs: bool):
        if self.model_impl == "openai" and use_fp16_inputs:
            # Cast ONNX model to float16 to ensure LayerNorm weights are converted from
            # float32 to float16 since exported model already has float16 weights everywhere
            # except for LayerNorm ops. This happens because OpenAI always upcasts to float32
            # when computing LayerNorm.
            #
            # Reference:
            # https://github.com/openai/whisper/blob/90db0de1896c23cbfaf0c58bc2d30665f709f170/whisper/model.py#L41
            model = convert_float_to_float16(model)
        return model

    def export_onnx(
        self,
        onnx_model_path: str,
        provider: str,
        verbose: bool = True,
        use_external_data_format: bool = False,
        use_fp16_inputs: bool = False,
        use_int32_inputs: bool = True,
    ):
        """Export encoder-decoder-init to ONNX

        Args:
            onnx_model_path (str): path to save ONNX model
            provider (str): provider to use for verifying parity on ONNX model
            verbose (bool, optional): print verbose information. Defaults to True.
            use_external_data_format (bool, optional): use external data format or not. Defaults to False.
            use_fp16_inputs (bool, optional): use float16 inputs for the audio_features. Defaults to False.
            use_int32_inputs (bool, optional): use int32 inputs for the decoder_input_ids. Defaults to True.
        """
        # Shape of encoder's tensors:
        # Inputs:
        #    audio_features: (batch_size, num_mels, num_frames)
        # Outputs:
        #    encoder_hidden_states: (batch_size, num_frames // 2, hidden_size)

        # Shape of decoder's tensors:
        # Inputs:
        #    decoder_input_ids: (batch_size, sequence_length)
        #    encoder_hidden_states (comes from encoder's outputs): (batch_size, num_frames // 2, hidden_size)
        # Outputs:
        #    logits: (batch_size, sequence_length, vocab_size)
        #    present_{key/value}_self_* (present self attention KV caches): (batch_size, num_heads, past_sequence_length + sequence_length, head_size)
        #    present_{key/value}_cross_* (present cross attention KV caches): (batch_size, num_heads, num_frames // 2, head_size)

        inputs = self.inputs(use_fp16_inputs=use_fp16_inputs, use_int32_inputs=use_int32_inputs)
        input_names = self.input_names()
        output_names = self.output_names()
        dynamic_axes = self.dynamic_axes(input_names, output_names)

        Path(onnx_model_path).parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory() as tmp_dir_name:
            temp_onnx_model_path = os.path.join(tmp_dir_name, "encoder_decoder_init.onnx")
            Path(temp_onnx_model_path).parent.mkdir(parents=True, exist_ok=True)
            out_path = temp_onnx_model_path if use_external_data_format else onnx_model_path

            torch.onnx.export(
                self,
                args=inputs,
                f=out_path,
                export_params=True,
                input_names=input_names,
                output_names=output_names,
                dynamic_axes=dynamic_axes,
                opset_version=18,
                do_constant_folding=True,
                dynamo=False,
                verbose=verbose,
            )

            model = onnx.load_model(out_path, load_external_data=use_external_data_format)
            model = self.fix_outputs(model)
            model = self.fix_layernorm_weights(model, use_fp16_inputs)
            OnnxModel.save(
                model,
                onnx_model_path,
                save_as_external_data=use_external_data_format,
                all_tensors_to_one_file=True,
            )

        self.verify_onnx(onnx_model_path, provider, use_fp16_inputs, use_int32_inputs)

    def verify_onnx(
        self,
        onnx_model_path: str,
        provider: str,
        use_fp16_inputs: bool,
        use_int32_inputs: bool,
    ):
        """Verify ONNX model outputs and PyTorch model outputs match

        Args:
            onnx_model_path (str): path to save ONNX model
            provider (str): execution provider for ONNX model
            use_fp16_inputs (bool, optional): use float16 inputs for the audio_features
            use_int32_inputs (bool, optional): use int32 inputs for the decoder_input_ids
        """
        # Shape of encoder's tensors:
        # Inputs:
        #    audio_features: (batch_size, num_mels, num_frames)
        # Outputs:
        #    encoder_hidden_states: (batch_size, num_frames // 2, hidden_size)

        # Shape of decoder's tensors:
        # Inputs:
        #    decoder_input_ids: (batch_size, sequence_length)
        #    encoder_hidden_states (comes from encoder's outputs): (batch_size, num_frames // 2, hidden_size)
        # Outputs:
        #    logits: (batch_size, sequence_length, vocab_size)
        #    present_{key/value}_self_* (present self attention KV caches): (batch_size, num_heads, past_sequence_length + sequence_length, head_size)
        #    present_{key/value}_cross_* (present cross attention KV caches): (batch_size, num_heads, num_frames // 2, head_size)

        inputs = self.inputs(use_fp16_inputs=use_fp16_inputs, use_int32_inputs=use_int32_inputs, return_dict=True)

        # Run PyTorch model
        pt_outputs = []
        if self.no_beam_search_op:
            out = self.forward(**inputs)
            pt_outputs.append(out[0].detach().cpu().numpy())
            for present_cross_attn_cache in out[1]:
                pt_outputs.append(present_cross_attn_cache.detach().cpu().numpy())
        else:
            out = self.forward(**inputs)
            pt_outputs.append(out[0].detach().cpu().numpy())
            pt_outputs.append(out[1].detach().cpu().numpy())

            (self_attn_kv_caches, cross_attn_kv_caches) = group_past_key_values(out[2])
            pt_outputs.extend([self_attn_kv_cache.detach().cpu().numpy() for self_attn_kv_cache in self_attn_kv_caches])
            pt_outputs.extend(
                [cross_attn_kv_cache.detach().cpu().numpy() for cross_attn_kv_cache in cross_attn_kv_caches]
            )

        # Run ONNX model
        sess = InferenceSession(onnx_model_path, providers=[provider])
        ort_outputs = sess.run(None, convert_inputs_for_ort(inputs, sess))

        # Calculate output difference
        for i, output_name in enumerate(self.output_names()):
            diff = np.abs(pt_outputs[i] - ort_outputs[i])
            logger.warning(f"Comparing {output_name}...")
            logger.warning(f"Max diff: {np.max(diff)}")
