# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.  See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------
# This script helps onnx conversion and validation for GPT2 model with past state.
import logging
import os
import pickle
import random
import shutil
import tempfile
import time
from pathlib import Path

import numpy
import onnx
import torch
from benchmark_helper import Precision
from float16 import float_to_float16_max_diff
from fusion_options import FusionOptions
from io_binding_helper import IOBindingHelper
from onnx_model import OnnxModel
from optimizer import optimize_model
from torch_onnx_export_helper import torch_onnx_export
from transformers import GPT2Config, GPT2LMHeadModel, GPT2Model, TFGPT2Model

logger = logging.getLogger(__name__)

PRETRAINED_GPT2_MODELS = ["distilgpt2", "gpt2", "gpt2-medium", "gpt2-large", "gpt2-xl"]

DEFAULT_TOLERANCE = {
    Precision.FLOAT32: 0.0005,
    Precision.FLOAT16: 0.2,
    Precision.INT8: 3.0,
}


class GPT2ModelNoPastState(GPT2Model):
    """Here we wrap a class to disable past state output."""

    def __init__(self, config):
        super().__init__(config)

    def forward(self, input_ids):
        return super().forward(input_ids, use_cache=False, return_dict=False)


class TFGPT2ModelNoPastState(TFGPT2Model):
    """Here we wrap a class to disable past state output."""

    def __init__(self, config):
        config.use_cache = False
        super().__init__(config)

    def forward(self, input_ids):
        return super().call(input_ids, use_cache=False)


class MyGPT2Model(GPT2Model):
    """Here we wrap a class for Onnx model conversion for GPT2Model with past state."""

    def __init__(self, config):
        super().__init__(config)

    @staticmethod
    def post_process(result, num_layer):
        if isinstance(result[1][0], (tuple, list)):
            assert len(result[1]) == num_layer and len(result[1][0]) == 2
            # assert len(result[1][0][0].shape) == 4 and result[1][0][0].shape == result[1][0][1].shape
            present = []
            for i in range(num_layer):
                # Since transformers v4.*, past key and values are separated outputs.
                # Here we concate them into one tensor to be compatible with Attention operator.
                present.append(
                    torch.cat(
                        (result[1][i][0].unsqueeze(0), result[1][i][1].unsqueeze(0)),
                        dim=0,
                    )
                )
            return (result[0], tuple(present))

        return result

    def forward(self, input_ids, position_ids, attention_mask, *past):
        result = super().forward(
            input_ids,
            position_ids=position_ids,
            attention_mask=attention_mask,
            past_key_values=past,
            return_dict=False,
        )
        return MyGPT2Model.post_process(result, self.config.n_layer)


class MyGPT2LMHeadModel(GPT2LMHeadModel):
    """Here we wrap a class for Onnx model conversion for GPT2LMHeadModel with past state."""

    def __init__(self, config):
        super().__init__(config)

    def forward(self, input_ids, position_ids, attention_mask, *past):
        result = super().forward(
            input_ids,
            position_ids=position_ids,
            attention_mask=attention_mask,
            past_key_values=past,
            return_dict=False,
        )

        return MyGPT2Model.post_process(result, self.config.n_layer)


class MyGPT2LMHeadModel_NoPadding(GPT2LMHeadModel):  # noqa: N801
    """Here we wrap a class for Onnx model conversion for GPT2LMHeadModel with past state and no padding.
    When you always use batch_size=1 in inference, there is no padding in inputs. In such case, position_ids
    and attention_mask need no be in inputs.
    """

    def __init__(self, config):
        super().__init__(config)

    def forward(self, input_ids, *past):
        result = super().forward(input_ids, past_key_values=past, return_dict=False)

        return MyGPT2Model.post_process(result, self.config.n_layer)


# Maps model class name to a tuple of model class, name of first output and use padding or not
MODEL_CLASSES = {
    "GPT2LMHeadModel": (MyGPT2LMHeadModel, "logits", True),
    "GPT2LMHeadModel_NoPadding": (MyGPT2LMHeadModel_NoPadding, "logits", False),
    "GPT2Model": (MyGPT2Model, "last_state", True),
}


class Gpt2Inputs:
    def __init__(self, input_ids, position_ids, attention_mask, past):
        self.input_ids: torch.LongTensor = input_ids
        self.position_ids: torch.LongTensor = position_ids
        self.attention_mask: torch.LongTensor | torch.FloatTensor | torch.HalfTensor = attention_mask
        self.past: list[torch.FloatTensor] | list[torch.HalfTensor] = past

    def to_list(self) -> list:
        input_list = [v for v in [self.input_ids, self.position_ids, self.attention_mask] if v is not None]
        if self.past:
            input_list.extend(self.past)

        return input_list

    def to_tuple(self) -> tuple:
        return tuple(v for v in [self.input_ids, self.position_ids, self.attention_mask, self.past] if v is not None)

    def to_fp32(self):
        # For attention mask, only convert fp16 to fp32, and keep the original type if it is integer.
        attention_mask = None
        if self.attention_mask is not None:
            attention_mask = (
                self.attention_mask.to(dtype=torch.float32)
                if (self.attention_mask.dtype == torch.float16)
                else self.attention_mask
            )

        past = [p.to(dtype=torch.float32) for p in self.past]
        return Gpt2Inputs(self.input_ids, self.position_ids, attention_mask, past)


class Gpt2Helper:
    """A helper class for Gpt2 model conversion, inference and verification."""

    @staticmethod
    def get_dummy_inputs(
        batch_size: int,
        past_sequence_length: int,
        sequence_length: int,
        num_attention_heads: int,
        hidden_size: int,
        num_layer: int,
        vocab_size: int,
        device: torch.device,
        float16: bool = False,
        has_position_ids: bool = True,
        has_attention_mask: bool = True,
        input_ids_dtype: torch.dtype = torch.int32,
        position_ids_dtype: torch.dtype = torch.int32,
        attention_mask_dtype: torch.dtype = torch.int32,
        left_side_padding: bool = True,
    ) -> Gpt2Inputs:
        """Create random inputs for GPT2 model.
        Returns torch tensors of input_ids, position_ids, attention_mask and a list of past state tensors.
        """
        float_type = torch.float16 if float16 else torch.float32
        past_shape = [
            2,
            batch_size,
            num_attention_heads,
            past_sequence_length,
            int(hidden_size / num_attention_heads),
        ]

        past = [(torch.rand(past_shape, dtype=float_type, device=device) * 2.0 - 1.0) for _ in range(num_layer)]
        input_ids = torch.randint(
            low=0,
            high=vocab_size - 1,
            size=(batch_size, sequence_length),
            dtype=input_ids_dtype,
            device=device,
        )

        attention_mask = None
        if has_attention_mask:
            total_sequence_length = past_sequence_length + sequence_length
            attention_mask = torch.ones(
                [batch_size, total_sequence_length],
                dtype=attention_mask_dtype,
                device=device,
            )

            if total_sequence_length >= 2:
                for i in range(batch_size):
                    padding_length = random.randint(0, total_sequence_length - 1)
                    if left_side_padding:
                        attention_mask[i, :padding_length] = 0
                    else:  # right side padding
                        attention_mask[i, total_sequence_length - padding_length :] = 0

        # Deduce position_ids from attention mask
        position_ids = None
        if has_position_ids:
            position_ids = attention_mask.long().cumsum(-1) - 1
            position_ids.masked_fill_(position_ids < 0, 0)
            position_ids = position_ids[:, past_sequence_length:].to(position_ids_dtype)

        return Gpt2Inputs(input_ids, position_ids, attention_mask, past)

    @staticmethod
    def get_output_shapes(
        batch_size: int,
        past_sequence_length: int,
        sequence_length: int,
        config: GPT2Config,
        model_class: str = "GPT2LMHeadModel",
    ) -> dict[str, list[int]]:
        """Returns a dictionary with output name as key, and shape as value."""
        num_attention_heads = config.num_attention_heads
        hidden_size = config.hidden_size
        num_layer = config.num_hidden_layers
        vocab_size = config.vocab_size

        output_name = MODEL_CLASSES[model_class][1]

        last_state_shape = [
            batch_size,
            sequence_length,
            vocab_size if output_name == "logits" else hidden_size,
        ]
        present_state_shape = [
            2,
            batch_size,
            num_attention_heads,
            past_sequence_length + sequence_length,
            int(hidden_size / num_attention_heads),
        ]

        output_shapes = {output_name: last_state_shape}
        for i in range(num_layer):
            output_shapes["present_" + str(i)] = present_state_shape

        return output_shapes

    @staticmethod
    def auto_increase_buffer_size(output_buffers, output_shapes):
        for key in output_shapes:
            assert key in output_buffers
            buffer = output_buffers[key]
            if numpy.prod(output_shapes[key]) > buffer.nelement():
                output_buffers[key] = torch.empty(
                    numpy.prod(output_shapes[key]),
                    dtype=buffer.dtype,
                    device=buffer.device,
                )

    @staticmethod
    def get_output_buffers(output_shapes, device, is_float16=False):
        """Returns a dictionary of output name as key, and 1D tensor as value. The tensor has enough space for given shape."""
        data_type = torch.float16 if is_float16 else torch.float32

        output_buffers = {}
        for name, shape in output_shapes.items():
            output_buffers[name] = torch.empty(numpy.prod(shape), dtype=data_type, device=device)
        return output_buffers

    @staticmethod
    def diff_outputs(torch_outputs, ort_outputs, relative=False):
        """Returns the maximum difference between PyTorch and OnnxRuntime outputs."""
        expected_outputs = torch_outputs[0].cpu().numpy()
        diff = numpy.abs(expected_outputs - ort_outputs[0])
        if relative:
            return numpy.amax(diff / (numpy.abs(expected_outputs) + 1e-6))
        else:
            return numpy.amax(diff)

    @staticmethod
    def compare_outputs(torch_outputs, ort_outputs, rtol=1e-03, atol=1e-03, **kwargs):
        """Returns True if torch and ORT outputs are close for given thresholds, and False otherwise.
        Note: need kwargs since Gpt2BeamSearchHelper.compare_outputs has an extra parameter model_class
        """
        is_close = numpy.allclose(ort_outputs[0], torch_outputs[0].cpu().numpy(), rtol=rtol, atol=atol)
        logger.debug(f"PyTorch and OnnxRuntime output 0 (last_state) are close: {is_close}")

        is_all_close = is_close
        num_layers = len(ort_outputs) - 1

        for layer in range(num_layers):
            is_close = numpy.allclose(
                ort_outputs[1 + layer],
                torch_outputs[1][layer].cpu().numpy(),
                rtol=rtol,
                atol=atol,
            )
            logger.debug(f"PyTorch and OnnxRuntime layer {layer} state (present_{layer}) are close:{is_close}")
            is_all_close = is_all_close and is_close

        if not is_all_close:
            max_abs_diff = Gpt2Helper.diff_outputs(torch_outputs, ort_outputs)
            logger.info(f"PyTorch and OnnxRuntime results are not all close: max_abs_diff={max_abs_diff:.5f}")

        return is_all_close

    @staticmethod
    def compare_outputs_v2(torch_outputs, ort_outputs, atol=1e-06):
        """Compare outputs from PyTorch and OnnxRuntime

        Args:
            torch_outputs (Tuple[Torch.Tensor]): PyTorch model output
            ort_outputs (List[numpy.ndarray]): OnnxRuntime output
            atol (float, optional): Absolute tollerance. Defaults to 1e-06.

        Returns:
            is_all_close(bool): whether all elements are close.
            max_abs_diff(float): maximum absolute difference.
            messages(str): a list of debug message for each output
        """
        is_all_close = True
        is_top1_matched = False
        max_diffs = []
        messages = []
        for i in range(len(ort_outputs)):
            ort_output = ort_outputs[i]
            torch_output = (torch_outputs[0] if i == 0 else torch_outputs[1][i - 1]).cpu().numpy()
            is_close = numpy.allclose(ort_output, torch_output, atol=atol, rtol=0)
            max_diffs.append(numpy.amax(numpy.abs(torch_output - ort_output)))
            is_all_close = is_all_close and is_close

            if numpy.isnan(torch_output).any():
                logger.debug(f"PyTorch output {i} has nan")
            if numpy.isinf(torch_output).any():
                logger.debug(f"PyTorch output {i} has inf")
            if numpy.isnan(ort_output).any():
                logger.debug(f"ORT output {i} has nan")
            if numpy.isinf(ort_output).any():
                logger.debug(f"ORT output {i} has inf")

            diff = numpy.fabs(ort_output - torch_output)
            idx = numpy.unravel_index(diff.argmax(), diff.shape)
            messages.append(
                f"diff={diff[idx]:.9f} index={idx} ort={ort_output[idx]:.9f} torch={float(torch_output[idx]):.9f}"
            )

            if i == 0:  # logits
                ort_max_index = numpy.unravel_index(numpy.argmax(ort_output, axis=None), ort_output.shape)
                torch_max_index = numpy.unravel_index(numpy.argmax(torch_output, axis=None), torch_output.shape)
                is_top1_matched = numpy.array_equal(ort_max_index, torch_max_index)

        max_diff_output_index = max_diffs.index(max(max_diffs))
        return (
            is_all_close,
            max(max_diffs),
            max_diff_output_index,
            messages,
            is_top1_matched,
        )

    @staticmethod
    def export_onnx(
        model,
        device,
        onnx_model_path: str,
        verbose: bool = False,
        use_external_data_format: bool = False,
        has_position_ids: bool = True,
        has_attention_mask: bool = True,
        input_ids_dtype: torch.dtype = torch.int32,
        position_ids_dtype: torch.dtype = torch.int32,
        attention_mask_dtype: torch.dtype = torch.int32,
    ):
        """Export GPT-2 model with past state to ONNX model."""
        config: GPT2Config = model.config
        num_layer = config.n_layer
        dummy_inputs = Gpt2Helper.get_dummy_inputs(
            batch_size=1,
            past_sequence_length=1,
            sequence_length=1,
            num_attention_heads=config.num_attention_heads,
            hidden_size=config.hidden_size,
            num_layer=num_layer,
            vocab_size=config.vocab_size,
            device=device,
            float16=False,
            has_position_ids=has_position_ids,
            has_attention_mask=has_attention_mask,
            input_ids_dtype=input_ids_dtype,
            position_ids_dtype=position_ids_dtype,
            attention_mask_dtype=attention_mask_dtype,
        )
        input_list = dummy_inputs.to_list()

        with torch.no_grad():
            outputs = model(*input_list)

        past_names = [f"past_{i}" for i in range(num_layer)]
        present_names = [f"present_{i}" for i in range(num_layer)]

        # GPT2Model outputs last_state; GPT2LMHeadModel outputs logits (prediction_scores)
        assert outputs[0].shape[2] == config.vocab_size or outputs[0].shape[2] == config.hidden_size
        output_names = ["logits" if outputs[0].shape[2] == config.vocab_size else "last_state", *present_names]

        # Shape of input tensors:
        #    input_ids: (batch_size, seq_len)
        #    past_{i}:  (2, batch_size, num_heads, past_seq_len, hidden_size/num_heads)
        #    attention_mask: (batch_size, past_seq_len + seq_len)
        # Shape of output tensors:
        #    last_state: (batch_size, seq_len, hidden_size)
        #      or logits: (batch_size, seq_len, vocab_size)
        #    present_{i}:  (2, batch_size, num_heads, past_seq_len + seq_len, hidden_size/num_heads)
        dynamic_axes = {
            "input_ids": {0: "batch_size", 1: "seq_len"},
            output_names[0]: {0: "batch_size", 1: "seq_len"},
        }
        for name in past_names:
            dynamic_axes[name] = {1: "batch_size", 3: "past_seq_len"}
        for name in present_names:
            dynamic_axes[name] = {1: "batch_size", 3: "total_seq_len"}

        input_names = ["input_ids"]
        if has_position_ids:
            dynamic_axes["position_ids"] = {0: "batch_size", 1: "seq_len"}
            input_names.append("position_ids")
        if has_attention_mask:
            dynamic_axes["attention_mask"] = {0: "batch_size", 1: "total_seq_len"}
            input_names.append("attention_mask")
        input_names.extend(past_names)

        assert len(outputs) == 2 and len(outputs[1]) == num_layer

        logger.info(
            f"Shapes: input_ids={dummy_inputs.input_ids.shape} past={dummy_inputs.past[0].shape} output={outputs[0].shape} present={outputs[1][0].shape}"
        )

        Path(onnx_model_path).parent.mkdir(parents=True, exist_ok=True)

        if use_external_data_format:
            # We let PyTorch export onnx to a temp directory first, then convert external data to one file.
            with tempfile.TemporaryDirectory() as tmp_dir_name:
                temp_onnx_model_path = os.path.join(tmp_dir_name, "gpt2.onnx")
                Path(temp_onnx_model_path).parent.mkdir(parents=True, exist_ok=True)

                torch_onnx_export(
                    model,
                    args=tuple(input_list),
                    f=temp_onnx_model_path,
                    export_params=True,
                    input_names=input_names,
                    output_names=output_names,
                    dynamic_axes=dynamic_axes,
                    opset_version=14,
                    do_constant_folding=True,
                    use_external_data_format=True,
                    verbose=verbose,
                )

                model = onnx.load_model(temp_onnx_model_path, load_external_data=True)
                OnnxModel.save(
                    model,
                    onnx_model_path,
                    save_as_external_data=True,
                    all_tensors_to_one_file=True,
                )
        else:
            torch_onnx_export(
                model,
                args=tuple(input_list),
                f=onnx_model_path,
                export_params=True,
                input_names=input_names,
                output_names=output_names,
                dynamic_axes=dynamic_axes,
                opset_version=11,
                do_constant_folding=True,
                use_external_data_format=False,
                verbose=verbose,
            )

    @staticmethod
    def optimize_onnx(
        onnx_model_path,
        optimized_model_path,
        is_float16,
        num_attention_heads,
        hidden_size,
        use_external_data_format=False,
        auto_mixed_precision=False,
        stage=0,
        **kwargs,
    ):
        """Optimize ONNX model with an option to convert it to use mixed precision."""
        optimization_options = FusionOptions("gpt2")

        m = optimize_model(
            onnx_model_path,
            model_type="gpt2",
            num_heads=num_attention_heads,
            hidden_size=hidden_size,
            opt_level=0,
            optimization_options=optimization_options,
            use_gpu=False,
        )

        if is_float16:
            if auto_mixed_precision:
                Gpt2Helper.auto_mixed_precision(m)
            else:
                if "keep_io_types" not in kwargs:
                    kwargs["keep_io_types"] = False
                m.convert_float_to_float16(use_symbolic_shape_infer=True, **kwargs)

        m.save_model_to_file(optimized_model_path, use_external_data_format)
        return m

    @staticmethod
    def auto_mixed_precision(
        onnx_model: OnnxModel,
        op_block_list: list[str] = [  # noqa: B006
            "Add",
            "LayerNormalization",
            "SkipLayerNormalization",
            "FastGelu",
            "EmbedLayerNormalization",
        ],
    ):
        """Convert GPT-2 model to mixed precision.
           It detects whether original model has fp16 weights, and set parameters for float16 conversion automatically.
        Args:
            onnx_model (OnnxModel): optimized ONNX model
            op_block_list (List[str], optional): operators to compute in fp32. Defaults to ["Add", "LayerNormalization",
                                                 "SkipLayerNormalization", "FastGelu", "EmbedLayerNormalization"]
        Returns:
            parameters(dict): a dictionary of parameters used in float16 conversion
        """
        op_full_set = {node.op_type for node in onnx_model.nodes()}
        fp32_op_set = set(op_block_list)
        fp16_op_set = op_full_set.difference(fp32_op_set)
        logger.info(f"fp32 op: {fp32_op_set} fp16 op: {fp16_op_set}")

        # logits is the first output
        logits_output_name = onnx_model.graph().output[0].name

        # We use the weight in last MatMul node to detect whether the model is stored with float16 weights from training.
        is_weight_fp16_precision = False
        output_name_to_node = onnx_model.output_name_to_node()
        assert logits_output_name in output_name_to_node
        node = output_name_to_node[logits_output_name]
        last_matmul_node = None
        if node.op_type == "MatMul":
            last_matmul_node = node
            logger.info(f"Found last MatMul node for logits: {node.name}")
            initializer = None
            for input in node.input:
                initializer = onnx_model.get_initializer(input)
                if initializer is not None:
                    break

            # when the max difference of value after converting float to float16 is lower than a threshold (1e-6),
            # we can deduce that the weights are stored in float16 precision.
            max_diff = float_to_float16_max_diff(initializer)
            logger.debug(f"max diff of converting weights in last MatMul node {node.name}: {max_diff}")
            is_weight_fp16_precision = max_diff < 1e-6
        else:
            logger.warning(f"Failed to find MatMul node for logits. Found {node.op_type} of node {node.name}")

        keep_io_types = []
        node_block_list = []
        if (not is_weight_fp16_precision) and (last_matmul_node is not None):
            # When original weight is float32 precision, keep logits and last MatMul in float32 could get better precision.
            keep_io_types = [logits_output_name]
            node_block_list = [last_matmul_node.name]

        parameters = {
            "keep_io_types": keep_io_types,
            "op_block_list": op_block_list,
            "node_block_list": node_block_list,
            "force_fp16_initializers": is_weight_fp16_precision,
        }

        logger.info(f"auto_mixed_precision parameters: {parameters}")
        onnx_model.convert_float_to_float16(use_symbolic_shape_infer=True, **parameters)

        return parameters

    @staticmethod
    def pytorch_inference(model, inputs: Gpt2Inputs, total_runs: int = 0):
        """Run inference of PyTorch model, and returns average latency in ms when total_runs > 0 besides outputs."""
        logger.debug("start pytorch_inference")

        # Convert it to fp32 as the PyTroch model cannot deal with half input.
        input_list = inputs.to_fp32().to_list()

        with torch.no_grad():
            outputs = model(*input_list)

        if total_runs == 0:
            return outputs

        latency = []
        with torch.no_grad():
            for _ in range(total_runs):
                start = time.time()
                outputs = model(*input_list)
                latency.append(time.time() - start)

        average_latency = sum(latency) * 1000 / len(latency)
        logger.debug("PyTorch inference time = {} ms".format(format(average_latency, ".2f")))  # noqa: G001

        return outputs, average_latency

    @staticmethod
    def onnxruntime_inference(ort_session, inputs: Gpt2Inputs, total_runs: int = 0):
        """Run inference of ONNX model, and returns average latency in ms when total_runs > 0 besides outputs."""
        logger.debug("start onnxruntime_inference")

        ort_inputs = {"input_ids": numpy.ascontiguousarray(inputs.input_ids.cpu().numpy())}

        if inputs.past is not None:
            for i, past_i in enumerate(inputs.past):
                ort_inputs[f"past_{i}"] = numpy.ascontiguousarray(past_i.cpu().numpy())

        if inputs.attention_mask is not None:
            ort_inputs["attention_mask"] = numpy.ascontiguousarray(inputs.attention_mask.cpu().numpy())

        if inputs.position_ids is not None:
            ort_inputs["position_ids"] = numpy.ascontiguousarray(inputs.position_ids.cpu().numpy())

        ort_outputs = ort_session.run(None, ort_inputs)
        if total_runs == 0:
            return ort_outputs

        latency = []
        for _ in range(total_runs):
            start = time.time()
            ort_outputs = ort_session.run(None, ort_inputs)
            latency.append(time.time() - start)

        average_latency = sum(latency) * 1000 / len(latency)
        logger.debug("OnnxRuntime Inference time = {} ms".format(format(average_latency, ".2f")))  # noqa: G001

        return ort_outputs, average_latency

    @staticmethod
    def prepare_io_binding(
        ort_session,
        input_ids,
        position_ids,
        attention_mask,
        past,
        output_buffers,
        output_shapes,
    ):
        """Returnas IO binding object for a session."""
        return IOBindingHelper.prepare_io_binding(
            ort_session,
            input_ids,
            position_ids,
            attention_mask,
            past,
            output_buffers,
            output_shapes,
        )

    @staticmethod
    def get_outputs_from_io_binding_buffer(ort_session, output_buffers, output_shapes, return_numpy=True):
        """Copy results to cpu. Returns a list of numpy array."""
        return IOBindingHelper.get_outputs_from_io_binding_buffer(
            ort_session, output_buffers, output_shapes, return_numpy
        )

    @staticmethod
    def onnxruntime_inference_with_binded_io(
        ort_session,
        inputs: Gpt2Inputs,
        output_buffers: dict[str, torch.Tensor],
        output_shapes: dict[str, list[int]],
        total_runs: int = 0,
        return_numpy: bool = True,
        include_copy_output_latency: bool = False,
    ):
        """Inference with IO binding. Returns outputs, and optional latency when total_runs > 0."""
        logger.debug("start onnxruntime_inference_with_binded_io")

        # Bind inputs and outputs to onnxruntime session
        io_binding = Gpt2Helper.prepare_io_binding(
            ort_session,
            inputs.input_ids,
            inputs.position_ids,
            inputs.attention_mask,
            inputs.past,
            output_buffers,
            output_shapes,
        )

        # Run onnxruntime with io binding
        ort_session.run_with_iobinding(io_binding)

        # Copy results to cpu for verification
        ort_outputs = Gpt2Helper.get_outputs_from_io_binding_buffer(
            ort_session, output_buffers, output_shapes, return_numpy
        )

        if total_runs == 0:
            return ort_outputs

        latency = []
        for _ in range(total_runs):
            start = time.time()
            # Run onnxruntime with io binding
            ort_session.run_with_iobinding(io_binding)
            if include_copy_output_latency:
                _ = Gpt2Helper.get_outputs_from_io_binding_buffer(
                    ort_session, output_buffers, output_shapes, return_numpy
                )
            latency.append(time.time() - start)

        average_latency = sum(latency) * 1000 / len(latency)
        logger.debug("OnnxRuntime with IO binding inference time = %.2f ms", average_latency)

        return ort_outputs, average_latency

    @staticmethod
    def save_outputs(i, ort_outputs, torch_outputs):
        with open(f"ort_outputs_{i}.pickle", "wb") as f:
            pickle.dump(ort_outputs, f)
        logger.info(f"ORT output are saved to ort_outputs_{i}.pickle")

        with open(f"torch_outputs_{i}.pickle", "wb") as f:
            pickle.dump(torch_outputs, f)
        logger.info(f"Torch output are saved to torch_outputs_{i}.pickle")

    @staticmethod
    def save_inputs(i, dummy_inputs, ort_outputs, torch_outputs):
        with open(f"dummy_inputs_{i}.pickle", "wb") as f:
            pickle.dump(dummy_inputs, f)
        logger.info(f"inputs are saved to dummy_inputs_{i}.pickle")

    @staticmethod
    def test_parity(
        ort_session,
        model,
        device,
        is_float16=False,
        rtol=5e-4,
        atol=5e-4,
        test_cases_per_run=10000,
        total_runs=1,
        use_io_binding=True,
        model_class="GPT2LMHeadModel",
        has_position_ids=True,
        has_attention_mask=True,
        input_ids_dtype=torch.int32,
        position_ids_dtype=torch.int32,
        attention_mask_dtype=torch.int32,
        stage=0,
        verbose=False,
        enable_pickle_output=False,
    ):
        """Generate random inputs and compare the results of PyTorch and Onnx Runtime."""

        config: GPT2Config = model.config

        logger.info(
            f"Running parity test (atol={atol}, test_cases={test_cases_per_run}, runs={total_runs}, use_io_binding={use_io_binding}, model_class={model_class}, is_float16={is_float16}) ..."
        )

        max_batch_size = 8
        max_past_seq_len = 4  # Do not use large number here for higher chance of hitting empty past (past_seq_len=0)
        max_seq_len = 2

        output_buffers = None
        if use_io_binding:
            max_output_shapes = Gpt2Helper.get_output_shapes(
                max_batch_size, max_past_seq_len, max_seq_len, config, model_class
            )
            output_buffers = Gpt2Helper.get_output_buffers(max_output_shapes, device, is_float16)

        passed_test_cases = 0
        top1_matched_cases = 0

        max_abs_diff_list = []
        top1_matched_cases_per_run = [0] * total_runs
        total_test_cases = test_cases_per_run * total_runs
        for i in range(total_test_cases):
            run_id = int(i / test_cases_per_run)
            sequence_length = random.randint(1, max_seq_len)
            past_sequence_length = 0 if (stage == 1) else random.randint(0, max_past_seq_len)
            batch_size = random.randint(1, max_batch_size)

            logger.debug(
                f"Running parity test for batch_size={batch_size} past_sequence_length={past_sequence_length}..."
            )
            dummy_inputs = Gpt2Helper.get_dummy_inputs(
                batch_size,
                past_sequence_length,
                sequence_length,
                config.num_attention_heads,
                config.hidden_size,
                config.n_layer,
                config.vocab_size,
                device,
                is_float16,
                has_position_ids,
                has_attention_mask,
                input_ids_dtype=input_ids_dtype,
                position_ids_dtype=position_ids_dtype,
                attention_mask_dtype=attention_mask_dtype,
                left_side_padding=True,
            )
            outputs = Gpt2Helper.pytorch_inference(model, dummy_inputs)
            if use_io_binding:
                ort_outputs = Gpt2Helper.onnxruntime_inference(ort_session, dummy_inputs)
            else:
                output_shapes = Gpt2Helper.get_output_shapes(
                    batch_size,
                    past_sequence_length,
                    sequence_length,
                    config,
                    model_class,
                )
                ort_outputs = Gpt2Helper.onnxruntime_inference_with_binded_io(
                    ort_session, dummy_inputs, output_buffers, output_shapes
                )

            (
                is_all_close,
                max_abs_diff,
                max_diff_output_index,
                messages,
                is_top1_matched,
            ) = Gpt2Helper.compare_outputs_v2(outputs, ort_outputs, atol=atol)
            if not numpy.isnan(max_abs_diff):
                max_abs_diff_list.append(max_abs_diff)
            if is_all_close:
                passed_test_cases += 1

            if is_top1_matched:
                top1_matched_cases += 1
                top1_matched_cases_per_run[run_id] += 1

            if verbose and not is_all_close:
                logger.info(
                    f"test_case={i} batch_size={batch_size} past_sequence_length={past_sequence_length} sequence_length={sequence_length} MaxDiff={max_abs_diff}"
                )
                for i, message in enumerate(messages):  # noqa: PLW2901
                    logger.info(f"\t{i}: Name={ort_session.get_outputs()[i].name}, {message}")

            # Collect data for debugging
            if enable_pickle_output and (numpy.isnan(max_abs_diff) or max_abs_diff > 100 * atol):
                Gpt2Helper.save_inputs(i, dummy_inputs)
                Gpt2Helper.save_outputs(i, ort_outputs, outputs)

        if max_abs_diff_list:
            result = {
                f"max_diff_percentile_{p}": f"{numpy.percentile(max_abs_diff_list, p):.5f}" for p in [50, 90, 95, 99]
            }
        else:
            result = {f"max_diff_percentile_{p}": "nan" for p in [50, 90, 95, 99]}

        result["top1_match_rate"] = top1_matched_cases * 1.0 / total_test_cases
        result["top1_match_rate_per_run"] = [x * 1.0 / test_cases_per_run for x in top1_matched_cases_per_run]
        result["diff_pass_rate"] = passed_test_cases * 1.0 / total_test_cases
        result["nan_rate"] = (total_test_cases - len(max_abs_diff_list)) * 1.0 / total_test_cases

        logger.info(
            f"Parity Test Cases={total_test_cases}; Passed={passed_test_cases}; Nan={total_test_cases - len(max_abs_diff_list)}; Top1_Matched={top1_matched_cases}"
        )

        if passed_test_cases > 0.95 * total_test_cases:
            logger.info(f"Parity is good: passed rate={int(passed_test_cases * 100 / total_test_cases):.0f}%")

        return result

    @staticmethod
    def test_performance(
        ort_session,
        model,
        device,
        is_float16=False,
        total_runs=100,
        use_io_binding=True,
        model_class="GPT2LMHeadModel",
        has_position_ids=True,
        has_attention_mask=True,
        input_ids_dtype=torch.int32,
        position_ids_dtype=torch.int32,
        attention_mask_dtype=torch.int32,
        batch_size=8,
        sequence_length=1,
        past_sequence_length=32,
    ):
        """Generate random inputs and measure average latency of Onnx Runtime."""

        config: GPT2Config = model.config

        output_buffers = None
        if use_io_binding:
            output_shapes = Gpt2Helper.get_output_shapes(
                batch_size, past_sequence_length, sequence_length, config, model_class
            )
            output_buffers = Gpt2Helper.get_output_buffers(output_shapes, device, is_float16)

        dummy_inputs = Gpt2Helper.get_dummy_inputs(
            batch_size,
            past_sequence_length,
            sequence_length,
            config.num_attention_heads,
            config.hidden_size,
            config.n_layer,
            config.vocab_size,
            device,
            is_float16,
            has_position_ids,
            has_attention_mask,
            input_ids_dtype=input_ids_dtype,
            position_ids_dtype=position_ids_dtype,
            attention_mask_dtype=attention_mask_dtype,
        )

        if use_io_binding:
            _, latency = Gpt2Helper.onnxruntime_inference(ort_session, dummy_inputs, total_runs)
        else:
            _, latency = Gpt2Helper.onnxruntime_inference_with_binded_io(
                ort_session, dummy_inputs, output_buffers, output_shapes, total_runs
            )

        return latency

    @staticmethod
    def torchscript(model, config, device, has_position_ids=True, has_attention_mask=True):
        """JIT trace for TorchScript."""
        input_list = Gpt2Helper.get_dummy_inputs(
            batch_size=1,
            past_sequence_length=1,
            sequence_length=1,
            num_attention_heads=config.num_attention_heads,
            hidden_size=config.hidden_size,
            num_layer=config.n_layer,
            vocab_size=config.vocab_size,
            device=device,
            float16=False,
            has_position_ids=has_position_ids,
            has_attention_mask=has_attention_mask,
        ).to_list()
        return torch.jit.trace(model, input_list)

    @staticmethod
    def get_onnx_paths(
        output_dir,
        model_name_or_path,
        model_class: str = "GPT2LMHeadModel",
        has_past=True,
        new_folder=False,
        remove_existing=["raw", "fp32", "fp16", "int8"],  # noqa: B006
    ):
        """Build a  path name for given model based on given attributes."""
        model_name = model_name_or_path
        if os.path.isdir(model_name_or_path):
            model_name = Path(model_name_or_path).parts[-1]
        else:
            model_name.split("/")[-1]

        if model_class != "GPT2LMHeadModel":
            model_name += "_" + model_class

        if has_past:
            model_name += "_past"

        if new_folder:
            suffix = {"raw": "", "fp32": "_fp32", "fp16": "_fp16", "int8": "_int8"}
            # Remove the directories if existed.
            for model_type in ["raw", "fp32", "fp16", "int8"]:
                new_dir = os.path.join(output_dir, model_name + suffix[model_type])
                if os.path.exists(new_dir):
                    if model_type in remove_existing:
                        try:
                            shutil.rmtree(new_dir)
                            logger.info(f"Removed the existed directory: {new_dir}")
                        except OSError as e:
                            logger.info(f"Failed to remove the directory {new_dir}: {e.strerror}")
                    else:
                        logger.info(f"Directory for {model_type} existed: {new_dir}")

            # store each model to its own directory (for external data format).
            return {
                "raw": os.path.join(os.path.join(output_dir, model_name), model_name + ".onnx"),
                "fp32": os.path.join(
                    os.path.join(output_dir, model_name + "_fp32"),
                    model_name + "_fp32.onnx",
                ),
                "fp16": os.path.join(
                    os.path.join(output_dir, model_name + "_fp16"),
                    model_name + "_fp16.onnx",
                ),
                "int8": os.path.join(
                    os.path.join(output_dir, model_name + "_int8"),
                    model_name + "_int8.onnx",
                ),
            }

        return {
            "raw": os.path.join(output_dir, model_name + ".onnx"),
            "fp32": os.path.join(output_dir, model_name + "_fp32.onnx"),
            "fp16": os.path.join(output_dir, model_name + "_fp16.onnx"),
            "int8": os.path.join(output_dir, model_name + "_int8.onnx"),
        }
