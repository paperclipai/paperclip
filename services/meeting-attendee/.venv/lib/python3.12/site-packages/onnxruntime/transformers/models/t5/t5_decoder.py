# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.  See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------

import logging
import os
import tempfile
from pathlib import Path

import numpy
import onnx
import torch
from io_binding_helper import TypeHelper
from onnx_model import OnnxModel
from past_helper import PastKeyValuesHelper
from t5_encoder import T5EncoderInputs
from torch_onnx_export_helper import torch_onnx_export
from transformers import MT5Config, T5Config

from onnxruntime import InferenceSession

logger = logging.getLogger(__name__)


class T5DecoderInit(torch.nn.Module):
    """A T5 decoder with LM head to create initial past key values.
    This model is only called once during starting decoding.
    """

    def __init__(
        self,
        decoder: torch.nn.Module,
        lm_head: torch.nn.Module,
        config: T5Config | MT5Config,
        decoder_start_token_id: int | None = None,
    ):
        super().__init__()
        self.decoder = decoder
        self.lm_head = lm_head
        self.config = config
        self.decoder_start_token_id = (
            decoder_start_token_id if decoder_start_token_id is not None else self.config.decoder_start_token_id
        )
        self.tie_word_embeddings = (
            self.config.tie_word_embeddings if hasattr(self.config, "tie_word_embeddings") else True
        )

    def forward(
        self,
        decoder_input_ids: torch.Tensor,
        encoder_attention_mask: torch.Tensor,
        encoder_hidden_states: torch.FloatTensor,
    ):
        if decoder_input_ids is None:
            batch_size = encoder_attention_mask.shape[0]
            decoder_input_ids = (
                torch.ones(
                    (batch_size, 1),
                    dtype=torch.long,
                    device=encoder_attention_mask.device,
                )
                * self.decoder_start_token_id
            )

        decoder_outputs = self.decoder(
            input_ids=decoder_input_ids,
            encoder_hidden_states=encoder_hidden_states,
            encoder_attention_mask=encoder_attention_mask,
            use_cache=True,
            return_dict=True,
        )

        sequence_output = decoder_outputs.last_hidden_state
        present_key_values = decoder_outputs.past_key_values

        if self.tie_word_embeddings:
            sequence_output = sequence_output * (self.config.d_model**-0.5)

        lm_logits = self.lm_head(sequence_output)
        past_self, past_cross = PastKeyValuesHelper.group_by_self_or_cross(present_key_values)
        return lm_logits, past_self, past_cross


class T5Decoder(torch.nn.Module):
    """A T5 decoder with LM head and past key values"""

    def __init__(self, decoder, lm_head, config):
        super().__init__()
        self.decoder = decoder
        self.lm_head = lm_head
        self.config = config
        self.tie_word_embeddings = (
            self.config.tie_word_embeddings if hasattr(self.config, "tie_word_embeddings") else True
        )

    def forward(self, decoder_input_ids, encoder_attention_mask, *past):
        num_decoder_layers = self.config.num_decoder_layers
        past_key_values = PastKeyValuesHelper.group_by_layer(past, num_decoder_layers)

        # This is a hack since only the third dimension of encoder_hidden_states is used here
        dummy_encoder_hidden_states = encoder_attention_mask.unsqueeze(2)
        decoder_outputs = self.decoder(
            input_ids=decoder_input_ids,
            past_key_values=past_key_values,
            encoder_hidden_states=dummy_encoder_hidden_states,
            encoder_attention_mask=encoder_attention_mask,
            use_cache=True,
            return_dict=True,
        )

        sequence_output = decoder_outputs.last_hidden_state
        present_key_values = decoder_outputs.past_key_values

        if self.tie_word_embeddings:
            sequence_output = sequence_output * (self.config.d_model**-0.5)

        lm_logits = self.lm_head(sequence_output)
        present_self, _ = PastKeyValuesHelper.group_by_self_or_cross(present_key_values)

        # Do not return present_cross since they are identical to corresponding past_cross input
        return lm_logits, present_self


class T5DecoderInputs:
    def __init__(
        self,
        decoder_input_ids,
        encoder_attention_mask,
        past_key_values=None,
    ):
        self.decoder_input_ids: torch.LongTensor = decoder_input_ids
        self.encoder_attention_mask: torch.LongTensor = encoder_attention_mask
        self.past_key_values: list[torch.FloatTensor] | list[torch.HalfTensor] | None = past_key_values

    @staticmethod
    def create_dummy(
        config: T5Config | MT5Config,
        batch_size: int,
        encode_sequence_length: int,
        past_decode_sequence_length: int,
        device: torch.device,
        float16: bool = False,
        use_int32_inputs: bool = False,
    ):  # -> T5DecoderInputs:
        """Create dummy inputs for T5Decoder.

        Args:
            decoder: decoder
            batch_size (int): batch size
            encode_sequence_length (int): sequence length of input_ids for encoder
            past_decode_sequence_length (int): past sequence length of input_ids for decoder
            device (torch.device): device of output tensors
            float16 (bool): whether the model uses float32 or float16 in input
            use_int32_inputs(bool): whether use int32 instead of int64 for some inputs

        Returns:
            T5DecoderInputs: dummy inputs for decoder
        """
        num_attention_heads: int = config.num_heads
        num_layers: int = config.num_decoder_layers
        vocab_size: int = config.vocab_size

        # Do not use head_size = hidden_size / num_attention_heads here.
        # For example, mt5-small, d_model=512 and num_heads=6
        head_size: int = config.d_kv

        sequence_length: int = 1  # fixed for decoding
        decoder_input_ids = torch.randint(
            low=0,
            high=vocab_size - 1,
            size=(batch_size, sequence_length),
            dtype=(torch.int32 if use_int32_inputs else torch.int64),
            device=device,
        )

        encoder_inputs = T5EncoderInputs.create_dummy(
            batch_size,
            encode_sequence_length,
            vocab_size,
            device,
            use_int32_inputs=use_int32_inputs,
        )

        float_type = torch.float16 if float16 else torch.float32

        if past_decode_sequence_length > 0:
            self_attention_past_shape = [
                batch_size,
                num_attention_heads,
                past_decode_sequence_length,
                head_size,
            ]
            cross_attention_past_shape = [
                batch_size,
                num_attention_heads,
                encode_sequence_length,
                head_size,
            ]

            past = []
            for _ in range(2 * num_layers):
                past.append(torch.rand(self_attention_past_shape, dtype=float_type, device=device))

            for _ in range(2 * num_layers):
                past.append(torch.rand(cross_attention_past_shape, dtype=float_type, device=device))
        else:
            past = None

        return T5DecoderInputs(decoder_input_ids, encoder_inputs.attention_mask, past)

    def to_list(self) -> list:
        input_list = [
            self.decoder_input_ids,
            self.encoder_attention_mask,
        ]
        if self.past_key_values:
            input_list.extend(self.past_key_values)
        return input_list

    def to_fp32(self):
        past = [p.to(dtype=torch.float32) for p in self.past_key_values] if self.past_key_values else None
        return T5DecoderInputs(
            self.decoder_input_ids.clone(),
            self.encoder_attention_mask.clone(),
            past,
        )


class T5DecoderHelper:
    @staticmethod
    def export_onnx(
        decoder: T5Decoder | T5DecoderInit,
        device: torch.device,
        onnx_model_path: str,
        verbose: bool = True,
        use_external_data_format: bool = False,
        use_int32_inputs: bool = False,
    ):
        """Export decoder to ONNX

        Args:
            decoder (Union[T5Decoder, T5DecoderNoPastState]): decoder object
            device (torch.device): device of decoder object
            onnx_model_path (str): onnx path
            verbose (bool, optional): print verbose information. Defaults to True.
            use_external_data_format (bool, optional): use external data format or not. Defaults to False.
            use_int32_inputs (bool, optional): use int32 inputs
        """
        assert isinstance(decoder, (T5Decoder, T5DecoderInit))

        inputs = T5DecoderInputs.create_dummy(
            decoder.config,
            batch_size=2,
            encode_sequence_length=3,
            past_decode_sequence_length=5 if isinstance(decoder, T5Decoder) else 0,
            device=device,
            use_int32_inputs=use_int32_inputs,
        )
        input_list = inputs.to_list()

        num_decoder_layers = decoder.config.num_decoder_layers

        past_names = PastKeyValuesHelper.get_past_names(num_decoder_layers, present=False)
        present_names = PastKeyValuesHelper.get_past_names(num_decoder_layers, present=True)
        present_self_names = present_names[: 2 * num_decoder_layers]

        input_past_names = past_names if isinstance(decoder, T5Decoder) else []
        output_present_names = present_self_names if isinstance(decoder, T5Decoder) else present_names
        output_names = ["logits", *output_present_names]

        # Shape of input tensors (sequence_length==1):
        #    input_ids: (batch_size, sequence_length)
        #    encoder_attention_mask: (batch_size, encode_sequence_length)
        #    past_self_*: (batch_size, num_heads, past_decode_sequence_length, head_size)
        #    past_cross_*: (batch_size, num_heads, encode_sequence_length, head_size)

        # Shape of output tensors:
        #    logits: (batch_size, sequence_length, vocab_size)
        #    past_self_*: (batch_size, num_heads, past_decode_sequence_length + sequence_length, head_size)
        #    past_cross_*: (batch_size, num_heads, encode_sequence_length, head_size)

        input_names = ["input_ids"]
        input_names.append("encoder_attention_mask")
        input_names.extend(input_past_names)

        dynamic_axes = {
            "input_ids": {
                0: "batch_size",
                # 1: 'sequence_length'
            },
            "encoder_attention_mask": {0: "batch_size", 1: "encode_sequence_length"},
            "encoder_hidden_states": {0: "batch_size", 1: "encode_sequence_length"},
            "logits": {
                0: "batch_size",
                # 1: 'sequence_length'
            },
        }

        for name in input_past_names:
            dynamic_axes[name] = {
                0: "batch_size",
                2: "past_decode_sequence_length" if "self" in name else "encode_sequence_length",
            }

        for name in output_present_names:
            if "cross" in name:
                dynamic_axes[name] = {0: "batch_size", 2: "encode_sequence_length"}
            else:  # self attention past state
                if isinstance(decoder, T5Decoder):
                    dynamic_axes[name] = {
                        0: "batch_size",
                        2: "past_decode_sequence_length + 1",
                    }
                else:
                    dynamic_axes[name] = {
                        0: "batch_size",
                        # 2: 'sequence_length'
                    }

        Path(onnx_model_path).parent.mkdir(parents=True, exist_ok=True)

        with tempfile.TemporaryDirectory() as tmp_dir_name:
            temp_onnx_model_path = os.path.join(tmp_dir_name, "decoder.onnx")
            Path(temp_onnx_model_path).parent.mkdir(parents=True, exist_ok=True)
            torch_onnx_export(
                decoder,
                args=tuple(input_list),
                f=temp_onnx_model_path if use_external_data_format else onnx_model_path,
                export_params=True,
                input_names=input_names,
                output_names=output_names,
                dynamic_axes=dynamic_axes,
                opset_version=12,
                do_constant_folding=True,
                use_external_data_format=use_external_data_format,
                verbose=verbose,
            )

            if use_external_data_format:
                model = onnx.load_model(temp_onnx_model_path, load_external_data=True)
                OnnxModel.save(
                    model,
                    onnx_model_path,
                    save_as_external_data=True,
                    all_tensors_to_one_file=True,
                )

    @staticmethod
    def onnxruntime_inference(ort_session, inputs: T5DecoderInputs):
        """Run inference of ONNX model."""
        logger.debug("start onnxruntime_inference")

        ort_inputs = {
            "input_ids": numpy.ascontiguousarray(inputs.decoder_input_ids.cpu().numpy()),
            "encoder_attention_mask": numpy.ascontiguousarray(inputs.encoder_attention_mask.cpu().numpy()),
        }

        if inputs.past_key_values:
            assert len(inputs.past_key_values) % 4 == 0
            num_layers = int(len(inputs.past_key_values) / 4)
            past_names = PastKeyValuesHelper.get_past_names(num_layers)
            for i, past_tensor in enumerate(inputs.past_key_values):
                ort_inputs[past_names[i]] = numpy.ascontiguousarray(past_tensor.cpu().numpy())

        ort_outputs = ort_session.run(None, ort_inputs)
        return ort_outputs

    @staticmethod
    def verify_onnx(
        model: T5Decoder | T5DecoderInit,
        ort_session: InferenceSession,
        device: torch.device,
        use_int32_inputs: bool,
        max_cases: int = 4,
    ):
        """Compare the result from PyTorch and OnnxRuntime to verify the ONNX model is good."""
        float16: bool = TypeHelper.get_input_type(ort_session, "past_key_self_0") == "tensor(float16)"

        test_cases = [(4, 11, 3), (1, 2, 5), (3, 1, 1), (8, 5, 2)]
        test_cases_max_diff = []
        for (
            batch_size,
            encode_sequence_length,
            past_decode_sequence_length,
        ) in test_cases[:max_cases]:
            if isinstance(model, T5DecoderInit):
                past_decode_sequence_length = 0  # noqa: PLW2901

            inputs = T5DecoderInputs.create_dummy(
                model.config,
                batch_size,
                encode_sequence_length,
                past_decode_sequence_length,
                device=device,
                float16=float16,
                use_int32_inputs=use_int32_inputs,
            )

            # We use fp32 PyTroch model as baseline even when ONNX model is fp16
            input_list = inputs.to_fp32().to_list()

            # Run inference of PyTorch model
            with torch.no_grad():
                torch_outputs = model(*input_list)

            ort_outputs = T5DecoderHelper.onnxruntime_inference(ort_session, inputs)
            num_decoder_layers = model.config.num_decoder_layers

            max_diff = numpy.amax(numpy.abs(torch_outputs[0].cpu().numpy() - ort_outputs[0]))
            max_diff_all = max_diff
            logger.debug(f"logits max_diff={max_diff}")

            for i in range(2 * num_decoder_layers):
                max_diff = numpy.amax(numpy.abs(torch_outputs[1][i].cpu().numpy() - ort_outputs[1 + i]))
                logger.debug(f"self attention past state {i} max_diff={max_diff}")
                max_diff_all = max(max_diff_all, max_diff)

            if isinstance(model, T5DecoderInit):
                for i in range(2 * num_decoder_layers):
                    max_diff = numpy.amax(
                        numpy.abs(torch_outputs[2][i].cpu().numpy() - ort_outputs[1 + 2 * num_decoder_layers + i])
                    )
                    logger.debug(f"cross attention past state {i} max_diff={max_diff}")
                    max_diff_all = max(max_diff_all, max_diff)

            test_cases_max_diff.append(max_diff_all)
            logger.info(
                "batch_size=%s, encode_sequence_length=%s, past_decode_sequence_length=%s, max_diff=%s",
                batch_size,
                encode_sequence_length,
                past_decode_sequence_length,
                max_diff_all,
            )

        return max_diff_all
