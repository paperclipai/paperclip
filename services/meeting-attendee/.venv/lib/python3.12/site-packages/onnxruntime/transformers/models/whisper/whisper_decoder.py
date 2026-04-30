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
from google.protobuf.internal.containers import RepeatedCompositeFieldContainer
from onnx import ModelProto, ValueInfoProto
from onnx_model import OnnxModel
from past_helper import PastKeyValuesHelper
from transformers import WhisperConfig
from whisper_inputs import (
    convert_inputs_for_ort,
    get_model_dynamic_axes,
    get_sample_decoder_inputs,
    group_past_key_values,
)

from onnxruntime import InferenceSession

logger = logging.getLogger(__name__)


class WhisperDecoder(torch.nn.Module):
    """A Whisper decoder with optional past key values"""

    def __init__(self, config: WhisperConfig, model: torch.nn.Module, model_impl: str, no_beam_search_op: bool = False):
        super().__init__()
        self.config = config
        self.device = model.device
        self.model_impl = model_impl
        self.no_beam_search_op = no_beam_search_op

        self.decoder = None if model_impl == "openai" else model.model.decoder
        self.proj_out = None if model_impl == "openai" else model.proj_out
        self.model = model if model_impl == "openai" else None

        self.max_source_positions = self.config.max_source_positions
        self.num_heads = self.config.decoder_attention_heads
        self.head_size = self.config.d_model // self.num_heads

    def hf_forward(
        self,
        decoder_input_ids: torch.Tensor,
        encoder_hidden_states: torch.Tensor | None = None,
        past_key_values: list[tuple[torch.Tensor]] | None = None,
    ):
        outputs = self.decoder(
            encoder_hidden_states=encoder_hidden_states,
            input_ids=decoder_input_ids,
            past_key_values=past_key_values,
            use_cache=True,
        )
        logits = self.proj_out(outputs.last_hidden_state)
        present_key_values = outputs.past_key_values

        if past_key_values is None:
            # Return present_self_* and present_cross_* for decoder-init
            return logits, present_key_values

        # Before: (past_key_self_0, past_value_self_0, past_key_cross_0, past_value_cross_0),
        #         (past_key_self_1, past_value_self_1, past_key_cross_1, past_value_cross_1),
        # After:  (past_key_self_0, past_value_self_0, past_key_self_1, past_value_self_1), ...,
        #         (past_key_cross_0, past_value_cross_0, past_key_cross_1, past_value_cross_1), ...
        present_self, present_cross = PastKeyValuesHelper.group_by_self_and_cross(present_key_values)

        # Return present_self_* for decoder-with-past since past_cross_* and present_cross_* are identical
        return logits, present_self

    def oai_forward(
        self,
        decoder_input_ids: torch.Tensor,
        encoder_hidden_states: torch.Tensor | None = None,
        past_key_values: list[tuple[torch.Tensor]] | None = None,
    ):
        past_kv_cache = {}
        if past_key_values is not None:
            # Convert past KV caches (BxNxSxH --> BxSxNxH --> BxSxD) for OpenAI's forward pass
            self_attn_kv_caches, cross_attn_kv_caches = group_past_key_values(past_key_values)
            self_attn_kv_caches = [past_kv.transpose(1, 2) for past_kv in self_attn_kv_caches]
            self_attn_kv_caches = [past_kv.reshape((*past_kv.shape[:2], -1)) for past_kv in self_attn_kv_caches]
            cross_attn_kv_caches = [past_kv.transpose(1, 2) for past_kv in cross_attn_kv_caches]
            cross_attn_kv_caches = [past_kv.reshape((*past_kv.shape[:2], -1)) for past_kv in cross_attn_kv_caches]

            for idx, block in enumerate(self.model.decoder.blocks):
                past_kv_cache[block.attn.key] = self_attn_kv_caches[2 * idx]
                past_kv_cache[block.attn.value] = self_attn_kv_caches[2 * idx + 1]
                past_kv_cache[block.cross_attn.key] = cross_attn_kv_caches[2 * idx]
                past_kv_cache[block.cross_attn.value] = cross_attn_kv_caches[2 * idx + 1]

        # Install OpenAI's hooks on the forward pass of each nn.Linear for key and value
        # since the hooks will capture the output of the key and value MatMuls, which
        # represent the current keys and values.
        #
        # For OpenAI's forward pass, the hook function will also perform the concat
        # operation (past_kv + curr_kv --> pres_kv) if needed. However, the ONNX model
        # will not contain this concat operation because the present KV caches aren't
        # returned by OpenAI's forward pass.
        kv_cache, hooks = self.model.install_kv_cache_hooks()

        # Run forward pass
        # NOTE: There is a bug with openai-whisper==20240930 with the introduction of SDPA.
        # In the Whisper codebase, the following line
        #
        # is_causal = mask is not None and n_ctx > 1
        #
        # has been added where `mask` is a torch tensor. The right-hand side evaluates to `tensor(True/False)`
        # but `is_causal` only accepts the boolean value. The fix is to apply `.item()` after the right-hand
        # side has been evaluated. In other words, the line should be
        #
        # is_causal = (mask is not None and n_ctx > 1).item()
        #
        # instead.
        logits = self.model.decoder(x=decoder_input_ids, xa=encoder_hidden_states, kv_cache=past_kv_cache)

        # Re-do concat operation on self attention KV caches for ONNX export (if past self attention KV caches exist)
        if past_key_values is not None:
            for block in self.model.decoder.blocks:
                kv_cache[block.attn.key] = torch.cat(
                    [past_kv_cache[block.attn.key], kv_cache[block.attn.key]], dim=1
                ).detach()
                kv_cache[block.attn.value] = torch.cat(
                    [past_kv_cache[block.attn.value], kv_cache[block.attn.value]], dim=1
                ).detach()

        present_self, present_cross = [], []
        for block in self.model.decoder.blocks:
            # Group self and cross values
            present_self.append(kv_cache[block.attn.key])
            present_self.append(kv_cache[block.attn.value])
            if past_key_values is None:
                # Return present_self_* and present_cross_* for decoder-init
                present_cross.append(kv_cache[block.cross_attn.key])
                present_cross.append(kv_cache[block.cross_attn.value])

        # Convert present KV caches (BxSxD --> BxSxNxH --> BxNxSxH) after OpenAI's forward pass
        present_self = [
            present_kv.reshape((*present_kv.shape[:2], -1, self.head_size)).transpose(1, 2)
            for present_kv in present_self
        ]
        present_cross = [
            present_kv.reshape((*present_kv.shape[:2], -1, self.head_size)).transpose(1, 2)
            for present_kv in present_cross
        ]

        # Remove OpenAI's hooks since they can persist after this function completes
        for hook in hooks:
            hook.remove()

        if past_key_values is None:
            # Return present_self_* and present_cross_* for decoder-init
            present_key_values = PastKeyValuesHelper.group_by_layer(
                present_self + present_cross, len(present_self) // 2
            )
            return logits, present_key_values

        # Return present_self_* for decoder-with-past since past_cross_* and present_cross_* are identical
        return logits, present_self

    def forward(
        self,
        decoder_input_ids: torch.Tensor,
        encoder_hidden_states: torch.Tensor | None = None,
        past_key_values: list[tuple[torch.Tensor]] | None = None,
    ):
        if self.model_impl == "openai":
            return self.oai_forward(decoder_input_ids, encoder_hidden_states, past_key_values)
        return self.hf_forward(decoder_input_ids, encoder_hidden_states, past_key_values)

    def input_names(self):
        if self.first_pass:
            input_names = ["input_ids", "encoder_hidden_states"]
        else:
            input_names = [
                "input_ids",
                "encoder_hidden_states",
                *list(
                    chain.from_iterable(
                        (f"past_key_self_{i}", f"past_value_self_{i}", f"past_key_cross_{i}", f"past_value_cross_{i}")
                        for i in range(self.config.decoder_layers)
                    )
                ),
            ]
        return input_names

    def output_names(self):
        if self.first_pass:
            output_names = [
                "logits",
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
        else:
            output_names = [
                "logits",
                *list(
                    chain.from_iterable(
                        (f"present_key_self_{i}", f"present_value_self_{i}") for i in range(self.config.decoder_layers)
                    )
                ),
            ]
        return output_names

    def dynamic_axes(self, input_names, output_names):
        dynamic_axes = get_model_dynamic_axes(self.config, input_names, output_names)
        if "input_ids" in dynamic_axes and not self.no_beam_search_op:
            # Set dynamic axes for `input_ids` when using beam search op to {0: "batch_size"} only
            del dynamic_axes["input_ids"][1]
        return dynamic_axes

    def inputs(self, use_fp16_inputs: bool, use_int32_inputs: bool, return_dict: bool = False):
        inputs = get_sample_decoder_inputs(
            self.config,
            self.device,
            batch_size=2,
            past_sequence_length=(0 if self.first_pass else 6),
            sequence_length=(6 if self.first_pass else 1),
            use_fp16=use_fp16_inputs,
            use_int32=use_int32_inputs,
        )
        if return_dict:
            if self.first_pass:
                del inputs["past_key_values"]
            return inputs

        if self.first_pass:
            return (
                inputs["decoder_input_ids"],
                inputs["encoder_hidden_states"],
            )
        return (
            inputs["decoder_input_ids"],
            inputs["encoder_hidden_states"],
            inputs["past_key_values"],
        )

    def fix_key_value_cache_dims(self, io: ValueInfoProto, is_cross: bool = False, is_output: bool = False):
        # Shape should be (batch_size, num_heads, sequence_length, head_size) for self attention KV caches
        # and (batch_size, num_heads, num_frames // 2, head_size) for cross attention KV caches
        num_heads = io.type.tensor_type.shape.dim[1]
        if "_dim_" in num_heads.dim_param:
            num_heads.Clear()
            num_heads.dim_value = self.num_heads
        sequence_length = io.type.tensor_type.shape.dim[2]
        if "_dim_" in sequence_length.dim_param:
            sequence_length.Clear()
            if is_cross:
                sequence_length.dim_value = self.max_source_positions
            else:
                sequence_length.dim_param = "total_sequence_length" if is_output else "past_sequence_length"
        head_size = io.type.tensor_type.shape.dim[3]
        if "_dim_" in head_size.dim_param:
            head_size.Clear()
            head_size.dim_value = self.head_size
        return io

    def fix_io(self, io_list: RepeatedCompositeFieldContainer, is_output: bool = False):
        # Fix order of inputs/outputs and each dim_value of input/output
        reordered_io = []
        self_attn_kv_caches = []
        cross_attn_kv_caches = []

        for io in io_list:
            if "past" not in io.name and "present" not in io.name:
                reordered_io.append(io)
            elif "self" in io.name:
                # Self attention KV caches
                new_io = self.fix_key_value_cache_dims(io, is_cross=False, is_output=is_output)
                if self.no_beam_search_op:
                    reordered_io.append(new_io)
                else:
                    self_attn_kv_caches.append(new_io)
            else:
                # Cross attention KV caches
                new_io = self.fix_key_value_cache_dims(io, is_cross=True, is_output=is_output)
                if self.no_beam_search_op:
                    reordered_io.append(new_io)
                else:
                    cross_attn_kv_caches.append(new_io)

        if not self.no_beam_search_op:
            reordered_io += self_attn_kv_caches + cross_attn_kv_caches
        return reordered_io

    def fix_inputs_and_outputs(self, model: ModelProto):
        # ONNX exporter might mark dimensions like 'Transposepresent_value_self_1_dim_2' in shape inference.
        # We now change the dim_values to the correct one.
        reordered_inputs = self.fix_io(model.graph.input, is_output=False)
        while len(model.graph.input) > 0:
            model.graph.input.pop()
        model.graph.input.extend(reordered_inputs)

        reordered_outputs = self.fix_io(model.graph.output, is_output=True)
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
        use_encoder_hidden_states: bool = False,
        use_kv_cache_inputs: bool = True,
    ):
        """Export decoder to ONNX

        Args:
            onnx_model_path (str): path to save ONNX model
            provider (str): provider to use for verifying parity on ONNX model
            verbose (bool, optional): print verbose information. Defaults to True.
            use_external_data_format (bool, optional): use external data format or not. Defaults to False.
            use_fp16_inputs (bool, optional): use float16 inputs for the KV caches. Defaults to False.
            use_int32_inputs (bool, optional): use int32 inputs for the decoder_input_ids. Defaults to True.
            use_encoder_hidden_states (bool, optional): use encoder_hidden_states as model input for decoder-init/decoder-without-past models. Defaults to False.
            use_kv_cache_inputs (bool, optional): use KV caches as model inputs for decoder-with-past models. Defaults to True.
        """
        # Shape of decoder's tensors:
        # Required Inputs:
        #    decoder_input_ids: (batch_size, sequence_length)
        # Optional Inputs:
        #    encoder_hidden_states (comes from encoder's outputs): (batch_size, num_frames // 2, hidden_size)
        #    past_{key/value}_self_* (past self attention KV caches): (batch_size, num_heads, past_sequence_length, head_size)
        #    past_{key/value}_cross_* (past cross attention KV caches): (batch_size, num_heads, num_frames // 2, head_size)
        # Outputs:
        #    logits: (batch_size, sequence_length, vocab_size)
        #    present_{key/value}_self_* (present self attention KV caches): (batch_size, num_heads, past_sequence_length + sequence_length, head_size)
        #    present_{key/value}_cross_* (present cross attention KV caches): (batch_size, num_heads, num_frames // 2, head_size)

        # For the first pass through the decoder (i.e. decoder-init/decoder-without-past)
        self.first_pass = use_encoder_hidden_states and not use_kv_cache_inputs

        # For subsequent passes through the decoder (i.e. decoder-with-past)
        self.later_pass = not use_encoder_hidden_states and use_kv_cache_inputs

        assert self.first_pass or self.later_pass, (
            "Only one of `use_encoder_hidden_states` and `use_kv_cache_inputs` can be true at once."
        )

        inputs = self.inputs(use_fp16_inputs=use_fp16_inputs, use_int32_inputs=use_int32_inputs)
        input_names = self.input_names()
        output_names = self.output_names()
        dynamic_axes = self.dynamic_axes(input_names, output_names)

        Path(onnx_model_path).parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory() as tmp_dir_name:
            temp_onnx_model_path = os.path.join(tmp_dir_name, "decoder.onnx")
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
            model = self.fix_inputs_and_outputs(model)
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
            use_fp16_inputs (bool, optional): use float16 inputs for the KV caches
            use_int32_inputs (bool, optional): use int32 inputs for the decoder_input_ids
        """
        # Shape of decoder's tensors:
        # Required Inputs:
        #    decoder_input_ids: (batch_size, sequence_length)
        # Optional Inputs:
        #    encoder_hidden_states (comes from encoder's outputs): (batch_size, num_frames // 2, hidden_size)
        #    past_{key/value}_self_* (past self attention KV caches): (batch_size, num_heads, past_sequence_length, head_size)
        #    past_{key/value}_cross_* (past cross attention KV caches): (batch_size, num_heads, num_frames // 2, head_size)
        # Outputs:
        #    logits: (batch_size, sequence_length, vocab_size)
        #    present_{key/value}_self_* (present self attention KV caches): (batch_size, num_heads, past_sequence_length + sequence_length, head_size)
        #    present_{key/value}_cross_* (present cross attention KV caches): (batch_size, num_heads, num_frames // 2, head_size)

        # Run PyTorch model
        inputs = self.inputs(use_fp16_inputs=use_fp16_inputs, use_int32_inputs=use_int32_inputs, return_dict=True)
        pt_outputs = []
        if self.first_pass:
            out = self.forward(**inputs)
            pt_outputs.append(out[0].detach().cpu().numpy())
            for present_key_value_layer in out[1]:
                for present_key_value in present_key_value_layer:
                    pt_outputs.append(present_key_value.detach().cpu().numpy())
        else:
            out = self.forward(**inputs)
            pt_outputs.append(out[0].detach().cpu().numpy())
            for present_self_key_value in out[1]:
                pt_outputs.append(present_self_key_value.detach().cpu().numpy())

        # Run ONNX model
        sess = InferenceSession(onnx_model_path, providers=[provider])
        ort_outputs = sess.run(None, convert_inputs_for_ort(inputs, sess))

        # Calculate output difference
        try:
            for i, output_name in enumerate(self.output_names()):
                diff = np.abs(pt_outputs[i] - ort_outputs[i])
                logger.warning(f"Comparing {output_name}...")
                logger.warning(f"Max diff: {np.max(diff)}")
        except:  # noqa: E722
            pass
