# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.
# -------------------------------------------------------------------------

import logging
import os
import tempfile
from pathlib import Path

import numpy
import onnx
import torch
from onnx_model import OnnxModel
from past_helper import PastKeyValuesHelper
from t5_decoder import T5DecoderInit
from t5_encoder import T5Encoder, T5EncoderInputs
from torch_onnx_export_helper import torch_onnx_export
from transformers import MT5Config, T5Config

from onnxruntime import InferenceSession

logger = logging.getLogger(__name__)


class T5EncoderDecoderInit(torch.nn.Module):
    """A combination of T5Encoder and T5DecoderInit."""

    def __init__(
        self,
        encoder: torch.nn.Module,
        decoder: torch.nn.Module,
        lm_head: torch.nn.Linear,
        config: T5Config | MT5Config,
        decoder_start_token_id: int | None = None,
        output_cross_only: bool = False,
    ):
        super().__init__()
        self.config: T5Config | MT5Config = config
        self.t5_encoder = T5Encoder(encoder, config)
        self.t5_decoder_init = T5DecoderInit(decoder, lm_head, config, decoder_start_token_id)
        self.output_cross_only = output_cross_only

    def forward(
        self,
        encoder_input_ids: torch.Tensor,
        encoder_attention_mask: torch.Tensor,
        decoder_input_ids: torch.Tensor | None = None,
    ):
        encoder_hidden_states: torch.FloatTensor = self.t5_encoder(encoder_input_ids, encoder_attention_mask)

        lm_logits, past_self, past_cross = self.t5_decoder_init(
            decoder_input_ids, encoder_attention_mask, encoder_hidden_states
        )

        if self.output_cross_only:
            return past_cross
        else:
            return lm_logits, encoder_hidden_states, past_self, past_cross


class T5EncoderDecoderInitInputs:
    def __init__(self, encoder_input_ids, encoder_attention_mask, decoder_input_ids=None):
        self.encoder_input_ids: torch.LongTensor = encoder_input_ids
        self.encoder_attention_mask: torch.LongTensor = encoder_attention_mask
        self.decoder_input_ids: torch.LongTensor | None = decoder_input_ids

    @staticmethod
    def create_dummy(
        config: T5Config | MT5Config,
        batch_size: int,
        encode_sequence_length: int,
        use_decoder_input_ids: int,
        device: torch.device,
        use_int32_inputs: bool = False,
    ):  # -> T5EncoderDecoderInitInputs:
        encoder_inputs: T5EncoderInputs = T5EncoderInputs.create_dummy(
            batch_size,
            encode_sequence_length,
            config.vocab_size,
            device,
            use_int32_inputs=use_int32_inputs,
        )
        decoder_input_ids = None
        if use_decoder_input_ids:
            dtype = torch.int32 if use_int32_inputs else torch.int64
            decoder_input_ids = torch.ones((batch_size, 1), dtype=dtype, device=device) * config.decoder_start_token_id

        return T5EncoderDecoderInitInputs(encoder_inputs.input_ids, encoder_inputs.attention_mask, decoder_input_ids)

    def to_list(self) -> list:
        input_list = [self.encoder_input_ids, self.encoder_attention_mask]
        if self.decoder_input_ids is not None:
            input_list.append(self.decoder_input_ids)
        return input_list


class T5EncoderDecoderInitHelper:
    @staticmethod
    def export_onnx(
        model: T5EncoderDecoderInit,
        device: torch.device,
        onnx_model_path: str,
        use_decoder_input_ids: bool = True,
        verbose: bool = True,
        use_external_data_format: bool = False,
        use_int32_inputs: bool = False,
    ):
        """Export decoder to ONNX

        Args:
            model (T5EncoderDecoderInit): the model to export
            device (torch.device): device of decoder object
            onnx_model_path (str): onnx path
            verbose (bool, optional): print verbose information. Defaults to True.
            use_external_data_format (bool, optional): use external data format or not. Defaults to False.
            use_int32_inputs (bool, optional): use int32 instead of int64 for integer inputs. Defaults to False.
        """
        assert isinstance(model, T5EncoderDecoderInit)

        # Do not exclude decoder in torch onnx export so that cross can show up.
        output_cross_only = model.output_cross_only
        model.output_cross_only = False

        inputs = T5EncoderDecoderInitInputs.create_dummy(
            model.config,
            batch_size=2,
            encode_sequence_length=3,
            use_decoder_input_ids=use_decoder_input_ids,
            device=device,
            use_int32_inputs=use_int32_inputs,
        )
        input_list = inputs.to_list()

        present_names = PastKeyValuesHelper.get_past_names(model.config.num_decoder_layers, present=True)

        output_names = ["logits", "encoder_hidden_states", *present_names]

        # Shape of input tensors (sequence_length==1):
        #    input_ids: (batch_size, sequence_length)
        #    encoder_attention_mask: (batch_size, encode_sequence_length)
        #    encoder_hidden_states: (batch_size, encode_sequence_length, hidden_size)
        #    past_self_*: (batch_size, num_heads, past_decode_sequence_length, head_size)
        #    past_cross_*: (batch_size, num_heads, encode_sequence_length, head_size)

        # Shape of output tensors:
        #    logits: (batch_size, sequence_length, vocab_size)
        #    past_self_*: (batch_size, num_heads, past_decode_sequence_length + sequence_length, head_size)
        #    past_cross_*: (batch_size, num_heads, encode_sequence_length, head_size)

        input_names = ["encoder_input_ids", "encoder_attention_mask"]

        # ONNX exporter might mark dimension like 'present_value_self_1_dim_2' in shape inference.
        # We use a workaround here: first use dim_param "1" for sequence_length, and later change to dim_value.
        sequence_length = "1"
        num_heads = str(model.config.num_heads)
        hidden_size = str(model.config.d_model)
        head_size = str(model.config.d_kv)

        dynamic_axes = {
            "encoder_input_ids": {0: "batch_size", 1: "encode_sequence_length"},
            "encoder_attention_mask": {0: "batch_size", 1: "encode_sequence_length"},
            "encoder_hidden_states": {
                0: "batch_size",
                1: "encode_sequence_length",
                2: hidden_size,
            },
            "logits": {
                0: "batch_size",
                1: sequence_length,
            },
        }

        if use_decoder_input_ids:
            input_names.append("decoder_input_ids")
            dynamic_axes["decoder_input_ids"] = {
                0: "batch_size",
                1: sequence_length,
            }

        for name in present_names:
            if "cross" in name:
                dynamic_axes[name] = {
                    0: "batch_size",
                    1: num_heads,
                    2: "encode_sequence_length",
                    3: head_size,
                }

            else:  # self attention past state
                dynamic_axes[name] = {
                    0: "batch_size",
                    1: num_heads,
                    2: sequence_length,
                    3: head_size,
                }

        with tempfile.TemporaryDirectory() as tmp_dir_name:
            temp_onnx_model_path = os.path.join(tmp_dir_name, "encoder_decoder_init.onnx")
            Path(temp_onnx_model_path).parent.mkdir(parents=True, exist_ok=True)
            torch_onnx_export(
                model,
                args=tuple(input_list),
                f=temp_onnx_model_path,
                export_params=True,
                input_names=input_names,
                output_names=output_names,
                dynamic_axes=dynamic_axes,
                opset_version=12,
                do_constant_folding=True,
                use_external_data_format=use_external_data_format,
                verbose=verbose,
            )

            # Restore output_cross_only setting.
            model.output_cross_only = output_cross_only

            # Workaround as mentioned earlier: change numeric dim_param to dim_value
            exported_model: onnx.ModelProto = onnx.load(temp_onnx_model_path)
            for tensor in exported_model.graph.output:
                for dim_proto in tensor.type.tensor_type.shape.dim:
                    if dim_proto.HasField("dim_param") and dim_proto.dim_param in [
                        sequence_length,
                        num_heads,
                        hidden_size,
                        head_size,
                    ]:
                        dim_value = int(dim_proto.dim_param)
                        dim_proto.Clear()
                        dim_proto.dim_value = dim_value

            if output_cross_only:
                # Rewrite onnx graph to only keep present_[key|value]_cross_* outputs.
                onnx_model = OnnxModel(exported_model)
                output_name_to_node = onnx_model.output_name_to_node()

                for output in exported_model.graph.output:
                    if "cross" in output.name:
                        assert output.name in output_name_to_node

                        transpose_node = output_name_to_node[output.name]
                        assert transpose_node and transpose_node.op_type == "Transpose"

                        permutation = OnnxModel.get_node_attribute(transpose_node, "perm")
                        assert isinstance(permutation, list)
                        assert permutation == [0, 2, 1, 3]

                        matched_nodes = onnx_model.match_parent_path(
                            transpose_node,
                            ["Reshape", "MatMul"],
                            [0, 0],
                            output_name_to_node,
                        )
                        assert matched_nodes is not None

                        reshape_node, matmul_node = matched_nodes
                        assert "encoder_hidden_states" in matmul_node.input

                        if not onnx_model.get_initializer("cross_reshape_shape"):
                            shape_tensor = onnx.helper.make_tensor(
                                name="cross_reshape_shape",
                                data_type=onnx.TensorProto.INT64,
                                dims=[4],
                                vals=[0, 0, int(num_heads), int(head_size)],
                                raw=False,
                            )
                            onnx_model.add_initializer(shape_tensor)

                        reshape_node.input[1] = "cross_reshape_shape"

                cross_outputs = [output.name for output in exported_model.graph.output if "cross" in output.name]
                onnx_model.prune_graph(cross_outputs, allow_remove_graph_inputs=True)

            OnnxModel.save(
                exported_model,
                onnx_model_path,
                save_as_external_data=use_external_data_format,
                all_tensors_to_one_file=True,
            )

    @staticmethod
    def onnxruntime_inference(ort_session, inputs: T5EncoderDecoderInitInputs):
        """Run inference of ONNX model."""
        logger.debug("start onnxruntime_inference")

        ort_inputs = {
            "encoder_input_ids": numpy.ascontiguousarray(inputs.encoder_input_ids.cpu().numpy()),
            "encoder_attention_mask": numpy.ascontiguousarray(inputs.encoder_attention_mask.cpu().numpy()),
        }
        if inputs.decoder_input_ids is not None:
            ort_inputs["decoder_input_ids"] = numpy.ascontiguousarray(inputs.decoder_input_ids.cpu().numpy())

        ort_outputs = ort_session.run(None, ort_inputs)
        return ort_outputs

    @staticmethod
    def verify_onnx(
        model: T5EncoderDecoderInit,
        ort_session: InferenceSession,
        device: torch.device,
        use_int32_inputs: bool,
        max_cases: int = 4,
    ):
        """Compare the result from PyTorch and OnnxRuntime to verify the ONNX model is good."""
        ort_inputs = ort_session.get_inputs()
        use_decoder_input_ids = len(ort_inputs) == 3

        test_cases = [(4, 11), (1, 2), (3, 1), (8, 5)]
        test_cases_max_diff = []
        for batch_size, encode_sequence_length in test_cases[:max_cases]:
            inputs = T5EncoderDecoderInitInputs.create_dummy(
                model.config,
                batch_size,
                encode_sequence_length,
                use_decoder_input_ids=use_decoder_input_ids,
                device=device,
                use_int32_inputs=use_int32_inputs,
            )

            ort_outputs = T5EncoderDecoderInitHelper.onnxruntime_inference(ort_session, inputs)

            # Run inference of PyTorch model
            input_list = inputs.to_list()
            torch_outputs = model(*input_list)

            num_decoder_layers = model.config.num_decoder_layers

            if not model.output_cross_only:
                assert torch_outputs[0].cpu().numpy().shape == ort_outputs[0].shape
                max_diff = numpy.amax(numpy.abs(torch_outputs[0].cpu().numpy() - ort_outputs[0]))
                logger.debug(f"logits max_diff={max_diff}")
                max_diff_all = max_diff

                assert torch_outputs[1].cpu().numpy().shape == ort_outputs[1].shape
                max_diff = numpy.amax(numpy.abs(torch_outputs[1].cpu().numpy() - ort_outputs[1]))
                logger.debug(f"encoder_hidden_states max_diff={max_diff}")
                max_diff_all = max(max_diff_all, max_diff)

                for i in range(2 * num_decoder_layers):
                    max_diff = numpy.amax(numpy.abs(torch_outputs[2][i].cpu().numpy() - ort_outputs[2 + i]))
                    logger.debug(f"self attention past state {i} max_diff={max_diff}")

                for i in range(2 * num_decoder_layers):
                    max_diff = numpy.amax(
                        numpy.abs(torch_outputs[3][i].cpu().numpy() - ort_outputs[2 + 2 * num_decoder_layers + i])
                    )
                    logger.debug(f"cross attention past state {i} max_diff={max_diff}")
                    max_diff_all = max(max_diff_all, max_diff)
            else:
                max_diff_all = -float("inf")
                for i in range(2 * num_decoder_layers):
                    max_diff = numpy.amax(numpy.abs(torch_outputs[i].cpu().numpy() - ort_outputs[i]))
                    logger.debug(f"cross attention past state {i} max_diff={max_diff}")
                    max_diff_all = max(max_diff_all, max_diff)

            test_cases_max_diff.append(max_diff_all)
            logger.info(
                f"batch_size={batch_size} encode_sequence_length={encode_sequence_length}, max_diff={max_diff_all}"
            )

        return max(test_cases_max_diff)
