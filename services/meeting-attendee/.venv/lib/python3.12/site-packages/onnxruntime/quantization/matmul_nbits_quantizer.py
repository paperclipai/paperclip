# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------

from __future__ import annotations

import argparse
import copy
import logging
import os

import ml_dtypes
import numpy as np
import numpy.typing as npt
import onnx
import onnx_ir as ir
from onnx.onnx_pb import GraphProto, ModelProto, NodeProto, TensorProto

from onnxruntime.capi._pybind_state import (
    quantize_matmul_2bits,
    quantize_matmul_4bits,
    quantize_matmul_8bits,
    quantize_qdq_matmul_4bits,
)

from .calibrate import CalibrationDataReader
from .neural_compressor import gptq_quantize, rtn_quantize
from .onnx_model import ONNXModel
from .quant_utils import QuantFormat, attribute_to_kwarg

logging.basicConfig(format="%(asctime)s %(name)s [%(levelname)s] - %(message)s", level=logging.INFO)
logger = logging.getLogger(__name__)


class WeightOnlyQuantConfig:
    def __init__(
        self,
        algorithm: str,
        quant_format: QuantFormat,
        op_types_to_quantize: tuple[str, ...] | None = None,
        quant_axes: tuple[tuple[str, int], ...] | None = None,
        customized_weight_config: dict | None = None,
    ):
        """This is the Base class for Weight Only blockwise quantization Configuration.

        Args:
            algorithm:
                weight only quantize algorithm name.
            quant_format: QuantFormat{QOperator, QDQ}.
                QOperator format quantizes the model with quantized operators directly.
                QDQ format quantize the model by inserting QuantizeLinear/DeQuantizeLinear on the tensor.
            op_types_to_quantize (optional):
                set of operator types to quantize. Default {MatMul}
            quant_axes (dict[str, int], optional):
                op:axis, which axis to quantize for an op. Default {MatMul: 0, Gather: 1}
            customized_weight_config:
                customized weight config for nodes if needed. It is dictionary with node name as key,
                and the value is a dict of customized config.
        """
        self.algorithm = algorithm
        self.quant_format = quant_format
        self.op_types_to_quantize = set(op_types_to_quantize) if op_types_to_quantize else {"MatMul"}
        self.quant_axes = dict(quant_axes) if quant_axes else {"MatMul": 0, "Gather": 1}
        self.customized_weight_config = customized_weight_config


class RTNWeightOnlyQuantConfig(WeightOnlyQuantConfig):
    def __init__(
        self,
        ratios=None,
        quant_format=QuantFormat.QOperator,
        op_types_to_quantize: tuple[str, ...] | None = None,
        customized_weight_config: dict | None = None,
    ):
        """
        This is a class for round-to-nearest (RTN) algorithm Weight Only Quant Configuration.
        RTN is the most straightforward way to quantize weight using scale maps.

        Args:
            ratios:
                percentile of clip. Defaults to {}.
            quant_format (QuantFormat{QOperator, QDQ}, optional):
                QOperator format quantizes the model with quantized operators directly.
                QDQ format quantize the model by inserting QuantizeLinear/DeQuantizeLinear on the tensor.
                Defaults to QuantFormat.QOperator.
            op_types_to_quantize (optional):
                set of operator types to quantize.
            customized_weight_config:
                customized weight config for nodes if needed. It is dictionary with node name as key,
                and the value is a dict of customized config.
        """
        assert quant_format == QuantFormat.QOperator, "RTN only supports QOperator format"

        if ratios is None:
            ratios = {}
        super().__init__(
            algorithm="RTN",
            quant_format=quant_format,
            op_types_to_quantize=op_types_to_quantize,
            customized_weight_config=customized_weight_config,
        )
        self.ratios = ratios


class KQuantWeightOnlyQuantConfig(WeightOnlyQuantConfig):
    def __init__(
        self,
        ratios=None,
        quant_format=QuantFormat.QOperator,
        op_types_to_quantize: tuple[str, ...] | None = None,
        customized_weight_config: dict | None = None,
    ):
        """
        This is a class for k-quant algorithm Weight Only Quant Configuration.

        Args:
            ratios:
                percentile of clip. Defaults to {}.
            quant_format (QuantFormat{QOperator, QDQ}, optional):
                QOperator format quantizes the model with quantized operators directly.
                QDQ format quantize the model by inserting QuantizeLinear/DeQuantizeLinear on the tensor.
                Defaults to QuantFormat.QOperator.
            op_types_to_quantize (optional):
                set of operator types to quantize.
        """
        assert quant_format == QuantFormat.QOperator, "k-quant only supports QOperator format"

        if ratios is None:
            ratios = {}
        super().__init__(
            algorithm="k_quant",
            quant_format=quant_format,
            op_types_to_quantize=op_types_to_quantize,
            customized_weight_config=customized_weight_config,
        )
        self.ratios = ratios


class GPTQWeightOnlyQuantConfig(WeightOnlyQuantConfig):
    def __init__(
        self,
        calibration_data_reader: CalibrationDataReader | None = None,
        percdamp=0.01,
        block_size=128,
        actorder=False,
        mse=False,
        perchannel=True,
        quant_format=QuantFormat.QOperator,
        op_types_to_quantize: tuple[str, ...] | None = None,
    ):
        """
        This is a class for GPTQ algorithm Weight Only Quant Configuration.
        GPTQ algorithm provides more accurate quantization but requires more computational resources.

        Args:
            calibration_data_reader:
                a calibration data reader. It enumerates calibration data and generates inputs for the original model.
            percdamp:
                percent of the average Hessian diagonal to use for dampening.
            block_size (int, optional):
                channel number in one block to execute a GPTQ quantization iteration.
            actorder (bool, optional):
                whether rearrange Hessian matrix considering the diag's value.
            mse (bool, optional):
                whether get scale and zero point with mse error.
            perchannel (bool, optional):
                whether quantize weight per-channel.
            quant_format (QuantFormat{QOperator, QDQ}, optional):
                QOperator format quantizes the model with quantized operators directly.
                QDQ format quantize the model by inserting QuantizeLinear/DeQuantizeLinear on the tensor.
                Defaults to QuantFormat.QOperator.
            op_types_to_quantize (optional):
                set of operator types to quantize.
        """
        assert quant_format == QuantFormat.QOperator, "GPTQ only supports QOperator format"

        super().__init__(
            algorithm="GPTQ",
            quant_format=quant_format,
            op_types_to_quantize=op_types_to_quantize,
        )
        self.calibration_data_reader = calibration_data_reader
        self.percdamp = percdamp
        self.block_size = block_size
        self.actorder = actorder
        self.mse = mse
        self.perchannel = perchannel


class HQQWeightOnlyQuantConfig(WeightOnlyQuantConfig):
    def __init__(
        self,
        block_size=128,
        bits=4,
        axis=1,
        quant_format=QuantFormat.QOperator,
        op_types_to_quantize: tuple[str, ...] | None = None,
        quant_axes: tuple[tuple[str, int], ...] | None = None,
    ):
        """
        This is a class for HQQ algorithm Weight Only Quant Configuration.
        HQQ algorithm quant weight without needing calibrate data.

        Args:
            block_size (int, optional):
                channel number in one block to execute a HQQ quantization iteration.
            bits (int, optional):
                how many bits to represent weight.
            axis (int, optional):
                0 or 1. which axis to quantize. https://arxiv.org/pdf/2309.15531.pdf
            quant_format (QuantFormat{QOperator, QDQ}, optional):
                QOperator format quantizes the model with quantized operators directly.
                QDQ format quantize the model by inserting QuantizeLinear/DeQuantizeLinear on the tensor.
                Defaults to QuantFormat.QOperator.
            op_types_to_quantize (optional):
                set of operator types to quantize.
            quant_axes (dict[str, int], optional):
                op:axis, which axis to quantize for an op. Default {MatMul: 0, Gather: 1}
        """
        assert quant_format == QuantFormat.QOperator, "HQQ only supports QOperator format"

        super().__init__(
            algorithm="HQQ",
            quant_format=quant_format,
            op_types_to_quantize=op_types_to_quantize,
            quant_axes=quant_axes,
        )
        self.block_size = block_size
        self.bits = bits
        self.axis = axis


class DefaultWeightOnlyQuantConfig(WeightOnlyQuantConfig):
    def __init__(
        self,
        block_size: int = 128,
        is_symmetric: bool = False,
        accuracy_level: int | None = None,
        quant_format=QuantFormat.QOperator,
        op_types_to_quantize: tuple[str, ...] | None = None,
        quant_axes: tuple[tuple[str, int], ...] | None = None,
        bits: int = 4,
        channel_wised_quantize: bool = False,
    ):
        """
        This is a class for weight only affine quantization configuration.

        Args:
            block_size (int, optional):
                channel number in one block to execute an affine quantization iteration.
            is_symmetric (bool, optional):
                whether quantize weight symmetrically.
            accuracy_level (int, optional):
                Accuracy level of the 4-bit quantized MatMul computation.
                Refer to the MatMulNBits contrib op's 'accuracy_level' attribute for details.
                (https://github.com/microsoft/onnxruntime/blob/main/docs/ContribOperators.md#commicrosoftmatmulnbits)
            quant_format (QuantFormat{QOperator, QDQ}, optional):
                QOperator format quantizes the model with quantized operators directly.
                QDQ format quantize the model by inserting QuantizeLinear/DeQuantizeLinear on the tensor.
                Defaults to QuantFormat.QOperator.
            op_types_to_quantize (optional):
                set of operator types to quantize.
            quant_axes (dict[str, int], optional):
                op:axis, which axis to quantize for an op. Default {MatMul: 0, Gather: 1}
            bits (int, optional):
                number of bits per element after quantization. Default 4.
        """
        super().__init__(
            algorithm="DEFAULT",
            quant_format=quant_format,
            op_types_to_quantize=op_types_to_quantize,
            quant_axes=quant_axes,
        )
        self.block_size = block_size
        self.is_symmetric = is_symmetric
        self.bits = bits
        self.accuracy_level = accuracy_level
        self.channel_wised_quantize = channel_wised_quantize
        if channel_wised_quantize and quant_format == QuantFormat.QOperator:
            raise NotImplementedError("QuantFormat.QOperator is not supported channel_wised_quantize yet")


class NVAWQWeightOnlyQuantConfig(WeightOnlyQuantConfig):
    def __init__(
        self,
        tokenizer_dir,
        dataset_name="cnn",
        cache_dir="./cache",
        calibration_method="awq_lite",
    ):
        """
        Configuration for the nvidia_awq quantization method.

        Args:
            tokenizer_dir (str): pathof the tokenizer dir.
            dataset_name (str): Name of the dataset.
            cache_dir (str): Directory for caching.
            calibration_method (str): calib method for nvidia_awq.
        """
        # Import torch and DataLoader
        try:
            import torch  # noqa: PLC0415
            from torch.utils.data import DataLoader  # noqa: PLC0415

            self.torch = torch
            self.DataLoader = DataLoader
        except ImportError:
            print(
                "Error: The 'torch' library is required but not installed. Please install it using 'pip install torch'."
            )
            raise ImportError("torch is not installed. Exiting.") from None

        # Import datasets
        try:
            from datasets import load_dataset  # noqa: PLC0415

            self.load_dataset = load_dataset
        except ImportError:
            print(
                "Error: The 'datasets' library is required but not installed. Please install it using 'pip install datasets'."
            )
            raise ImportError("datasets is not installed. Exiting.") from None

        # Import transformers
        try:
            from transformers import AutoConfig, AutoTokenizer  # noqa: PLC0415

            self.AutoConfig = AutoConfig
            self.AutoTokenizer = AutoTokenizer
        except ImportError:
            print(
                "Error: The 'transformers' library is required but not installed. Please install it using 'pip install transformers'."
            )
            raise ImportError("transformers is not installed. Exiting.") from None

        super().__init__(
            algorithm="nvidia_awq",
            quant_format=QuantFormat.QDQ,
            op_types_to_quantize=None,  # Assuming op_types_to_quantize is handled elsewhere
            quant_axes=None,  # Assuming quant_axes is handled elsewhere
        )

        # Determine the device
        device = self.torch.device("cuda" if self.torch.cuda.is_available() else "cpu")

        calib_inputs = self.get_calib_inputs(
            dataset_name=dataset_name,
            model_name=tokenizer_dir,
            cache_dir=cache_dir,
            calib_size=32,
            batch_size=1,
            block_size=512,
            device=device,
            use_fp16=True,
            use_buffer_share=False,
            add_past_kv_inputs=True,
            max_calib_rows_to_load=128,
            add_position_ids=True,
        )

        self.calibration_data_reader = calib_inputs
        self.calibration_method = calibration_method

    def make_model_input(
        self,
        config,
        input_ids_arg,
        attention_mask_arg,
        add_past_kv_inputs,
        device,
        use_fp16,
        use_buffer_share,
        add_position_ids,
    ):
        # Access torch from the instance variable
        torch = self.torch

        input_ids = input_ids_arg
        attention_mask = attention_mask_arg

        if isinstance(input_ids_arg, list):
            input_ids = torch.tensor(input_ids_arg, device=device, dtype=torch.int64)
            attention_mask = torch.tensor(attention_mask_arg, device=device, dtype=torch.int64)

        inputs = {
            "input_ids": input_ids.contiguous(),
            "attention_mask": attention_mask.contiguous(),
        }

        if add_position_ids:
            position_ids = attention_mask.long().cumsum(-1) - 1
            position_ids.masked_fill_(attention_mask == 0, 1)
            inputs["position_ids"] = position_ids.contiguous()

        if add_past_kv_inputs:
            torch_dtype = torch.float16 if use_fp16 else torch.float32
            batch_size, sequence_length = input_ids.shape
            max_sequence_length = config.max_position_embeddings
            num_heads, head_size = (
                config.num_key_value_heads,
                config.hidden_size // config.num_attention_heads,
            )
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
                inputs.update(
                    {
                        f"past_key_values.{i}.key": past_key.contiguous(),
                        f"past_key_values.{i}.value": past_value.contiguous(),
                    }
                )

        return inputs

    def get_calib_inputs(
        self,
        dataset_name,
        model_name,
        cache_dir,
        calib_size,
        batch_size,
        block_size,
        device,
        use_fp16,
        use_buffer_share,
        add_past_kv_inputs,
        max_calib_rows_to_load,
        add_position_ids,
    ):
        # Access transformers and datasets from the instance variables
        auto_config = self.AutoConfig
        auto_tokenizer = self.AutoTokenizer
        load_dataset = self.load_dataset

        config = auto_config.from_pretrained(
            model_name, use_auth_token=True, cache_dir=cache_dir, trust_remote_code=True
        )
        tokenizer = auto_tokenizer.from_pretrained(
            model_name, use_auth_token=True, cache_dir=cache_dir, trust_remote_code=True
        )
        tokenizer.add_special_tokens({"pad_token": "[PAD]"})
        tokenizer.pad_token = tokenizer.eos_token

        assert calib_size <= max_calib_rows_to_load, "calib size should be no more than max_calib_rows_to_load"

        if "cnn" in dataset_name:
            dataset2 = load_dataset("cnn_dailymail", name="3.0.0", split="train").select(range(max_calib_rows_to_load))
            column = "article"
        elif "pile" in dataset_name:
            dataset2 = load_dataset("mit-han-lab/pile-val-backup", split="validation")
            column = "text"
        else:
            raise ValueError(f'dataset "{dataset_name}" not supported')

        dataset2 = dataset2[column][:calib_size]
        batch_encoded = tokenizer.batch_encode_plus(
            dataset2, return_tensors="pt", padding=True, truncation=True, max_length=block_size
        )
        batch_encoded = batch_encoded.to(device)
        batch_encoded_input_ids = batch_encoded["input_ids"]
        batch_encoded_attention_mask = batch_encoded["attention_mask"]

        # Access DataLoader from the instance variable
        data_loader = self.DataLoader

        calib_dataloader_input_ids = data_loader(batch_encoded_input_ids, batch_size=batch_size, shuffle=False)
        calib_dataloader_attention_mask = data_loader(
            batch_encoded_attention_mask, batch_size=batch_size, shuffle=False
        )

        assert len(calib_dataloader_input_ids.dataset) == len(calib_dataloader_attention_mask.dataset)
        assert len(calib_dataloader_input_ids) == len(calib_dataloader_attention_mask)

        number_of_batched_samples = calib_size // batch_size

        batched_input_ids = []
        for idx, data in enumerate(calib_dataloader_input_ids):
            batched_input_ids.append(data)
            if idx == (number_of_batched_samples - 1):
                break

        batched_attention_mask = []
        for idx, data in enumerate(calib_dataloader_attention_mask):
            batched_attention_mask.append(data)
            if idx == (number_of_batched_samples - 1):
                break

        print(
            f"\n--Quantize-Script-- number_of_batched_samples={number_of_batched_samples}, "
            f"batch-input-ids-list-len={len(batched_input_ids)}, batched_attention_mask={len(batched_attention_mask)}\n"
        )

        batched_inputs_list = []
        for i in range(number_of_batched_samples):
            input_ids = batched_input_ids[i]
            attention_mask = batched_attention_mask[i]

            inputs = self.make_model_input(
                config,
                input_ids,
                attention_mask,
                add_past_kv_inputs,
                device,
                use_fp16,
                use_buffer_share,
                add_position_ids,
            )
            inputs = {input_name: torch_tensor.cpu().numpy() for input_name, torch_tensor in inputs.items()}
            batched_inputs_list.append(inputs)

        print(f"\n--Quantize-Script-- number of batched inputs = {len(batched_inputs_list)}\n")
        return batched_inputs_list


def is_divisible(val1, val2):
    return int(val2 * np.ceil(val1 / val2)) == val1


class HQQWeightOnlyQuantizer:
    def __init__(
        self,
        config: HQQWeightOnlyQuantConfig,
    ):
        self.config = config

    # Proximal solver || weight - dequantize(quantize(weight))||_p^p
    @staticmethod
    def optimize_weights(
        tensor,
        scale,
        zero,
        min_max: list[int],
        axis: int = 0,
        opt_params: dict | None = None,
        verbose=False,
    ):
        import torch  # noqa: PLC0415

        opt_params = {"lp_norm": 0.7, "beta": 1e1, "kappa": 1.01, "iters": 20} if opt_params is None else opt_params
        lp_norm, beta, kappa, iters = (
            opt_params["lp_norm"],
            opt_params["beta"],
            opt_params["kappa"],
            opt_params["iters"],
        )

        dtype = torch.float16 if tensor.is_cuda else torch.float32
        w_f = tensor.to(dtype)
        scale = scale.to(dtype)
        zero = zero.to(dtype)

        def shrink_op(x, beta, p=lp_norm):
            if p == 1:
                return torch.sign(x) * torch.nn.functional.relu(torch.abs(x) - 1.0 / beta)
            else:
                return torch.sign(x) * torch.nn.functional.relu(
                    torch.abs(x) - (1.0 / beta) * torch.pow(torch.abs(x) + 1e-8, p - 1)
                )

        best_error = 1e4
        for i in range(iters):
            w_q = torch.round(w_f * scale + zero).clamp(min_max[0], min_max[1])
            w_r = (w_q - zero) / scale
            w_e = shrink_op(w_f - w_r, beta)
            zero = torch.mean(w_q - (w_f - w_e) * scale, axis=axis, keepdim=True)
            beta *= kappa

            current_error = float(torch.abs(w_f - w_r).mean())
            if verbose:
                print(i, np.round(current_error, 6))
            if current_error < best_error:
                best_error = current_error
            else:
                break

        del w_f, w_q, w_r, w_e

        return scale, zero

    @staticmethod
    def pack_on_row_fast_248bit(pack_tensor, ori_int_tensor, bits):
        if pack_tensor.shape[0] == ori_int_tensor.shape[0]:
            ori_int_tensor = ori_int_tensor.T
            pack_tensor = pack_tensor.T
        if bits in [2, 4, 8]:
            compress_ratio = pack_tensor.element_size() * 8 // bits
            for j in range(compress_ratio):
                pack_tensor[0:] |= ori_int_tensor[j::compress_ratio] << (bits * (j))
        else:
            raise NotImplementedError("Only 2,4,8 bits are supported.")

    # from Official implementation of Half-Quadratic Quantization (HQQ)
    def quantize_internal(
        self, tensor, bits=4, channel_wise=True, group_size=64, optimize=True, round_zero=True, axis=1
    ):
        import torch  # noqa: PLC0415

        weight = tensor.float()
        ori_shape = weight.shape

        pad_len = (group_size - ori_shape[axis] % group_size) % group_size
        if axis == 1:
            weight = torch.nn.functional.pad(weight, (0, pad_len), "constant", 0)
        else:
            weight = torch.nn.functional.pad(weight, (0, 0, 0, pad_len), "constant", 0)
        shape = weight.shape

        # Reshape for grouping
        if (group_size is not None) and channel_wise:
            weight = weight.reshape([-1, group_size]) if (axis == 1) else weight.reshape([group_size, -1])

        # Get min/max values
        if channel_wise is False:
            _min, _max = weight.min(), weight.max()
            optimize = False
        else:
            _min = weight.min(axis=axis, keepdim=True)[0]
            _max = weight.max(axis=axis, keepdim=True)[0]

        max_v = 2**bits - 1
        min_v = 0
        min_max = [min_v, max_v]

        # Note: here we work with the inverse of the scale to avoid division and quantize instead via weight*scale + zero, the scale is inverted later on.
        # clamp to avoid half-precision problems
        scale = (max_v / (_max - _min)).clamp(max=2e4)
        #!!!!!!!!!!!!!!!
        min_max_axis = _max - _min
        if (min_max_axis == 0).sum().item() > 0:
            min_max_axis[min_max_axis == 0] = max_v
            scale = (max_v / min_max_axis).clamp(max=2e4)
        zero = -_min * scale

        if round_zero:
            zero = torch.round(zero)

        # Fine-tune weights
        if optimize:
            scale, zero = self.optimize_weights(tensor=weight, scale=scale, zero=zero, min_max=min_max, axis=axis)

        # Quantize
        # Necessary for fake quantization backprop
        w_q = torch.round(weight * scale + zero).clamp(min_max[0], min_max[1])
        w_q = w_q.reshape(shape).int()

        scale = 1.0 / scale
        if axis == 1:
            scale = scale.reshape(shape[0], -1)
            zero = zero.reshape(shape[0], -1)
        else:
            scale = scale.reshape(-1, shape[-1])
            zero = zero.reshape(-1, shape[-1])
        # cleanup
        del weight, _min, _max

        return w_q, scale.to(tensor.dtype), zero.to(tensor.dtype)

    def quantize(self, node: NodeProto, graph_stack: list[GraphProto]) -> list[NodeProto]:
        """
        Target node:        QOperator node:            QDQ nodes:
        MatMul              MatMulNBits                DeQuantizeLinear -> MatMul
        Gather              GatherBlockQuantized       Gather, Gather, Gather (optional) -> DequantizeLinear
        If the node is target node with fp32 or fp16 const weight, quantize the weight to int4 and
        return the new nodes.
        If QOperator format, return the corresponding QOperator nodes.
        If QDQ format, return the corresdponging QDQ nodes.
        Gather (quantized data) + Gather (scales) + Gather (optional, zero points) -> DequantizeLinear is
        not supported yet because Gather does not support int4 data.
        """
        # With HQQ, zero points are in float. Current GatherBlockQuantized does not support float zero points.
        if node.op_type == "Gather":
            raise NotImplementedError("Gather quantization is not supported yet in HQQ")

        import torch  # noqa: PLC0415

        logger.info(f"start to quantize {node.name} ...")
        input_b = node.input[1]
        b_pb, bs_graph = get_initializer(input_b, graph_stack)
        if b_pb is None:
            logger.info("MatMul doesn't have const weight. Skip to quantize")
            return [node]  # only care about constant weight

        b_array = onnx.numpy_helper.to_array(b_pb)
        if len(b_array.shape) != 2:
            logger.info("MatMul weight is not 2D. Skip to quantize")
            return [node]  # can only process 2-D matrix
        b_array_torch = torch.from_numpy(b_array)
        if torch.cuda.is_available():
            b_array_torch = b_array_torch.cuda()

        bits = self.config.bits
        quant_weight_torch, scales_torch, zero_points_torch = self.quantize_internal(
            b_array_torch.T, bits=bits, group_size=self.config.block_size
        )
        quant_weight_torch = quant_weight_torch.contiguous()
        scales_torch = scales_torch.contiguous()
        zero_points_torch = zero_points_torch.contiguous()

        packed_size = 8 // bits  # number of elements packed into one byte

        packed_torch = torch.zeros(
            (quant_weight_torch.shape[0], quant_weight_torch.shape[1] // packed_size),
            dtype=torch.uint8,
            device=quant_weight_torch.device,
        )
        self.pack_on_row_fast_248bit(packed_torch, quant_weight_torch, bits)
        scales = scales_torch.cpu().numpy()
        zero_points = zero_points_torch.cpu().numpy()
        # reshape to the predefined shape in MatmulNbits
        scales = scales.reshape(-1)
        zero_points = zero_points.reshape(-1)
        rows, cols = b_array_torch.shape
        block_size = self.config.block_size
        blob_size = block_size // packed_size
        k_blocks = (rows + block_size - 1) // block_size
        packed_torch = packed_torch.reshape(cols, k_blocks, blob_size)

        b_quant = onnx.numpy_helper.from_array(packed_torch.cpu().numpy())
        b_quant.name = b_pb.name + "_Q" + str(bits)
        for input in bs_graph.input:
            if input.name == input_b:
                bs_graph.input.remove(input)
                break

        scales_tensor = onnx.numpy_helper.from_array(scales)
        scales_tensor.name = b_pb.name + "_scales"
        bs_graph.initializer.extend([b_quant, scales_tensor])

        input_names = [node.input[0], b_quant.name, scales_tensor.name]
        zp_tensor = onnx.numpy_helper.from_array(zero_points)
        zp_tensor.name = b_pb.name + "_zero_points"
        bs_graph.initializer.extend([zp_tensor])
        input_names.append(zp_tensor.name)

        kwargs = {}
        rows, cols = b_array.shape
        kwargs["K"] = rows
        kwargs["N"] = cols
        kwargs["bits"] = bits
        kwargs["block_size"] = self.config.block_size

        matmul_q_node = onnx.helper.make_node(
            "MatMulNBits",
            inputs=input_names,
            outputs=[node.output[0]],
            name=node.name + "_Q" + str(bits) if node.name else "",
            domain="com.microsoft",
            **kwargs,
        )

        logger.info(f"complete quantization of {node.name} ...")

        return [matmul_q_node]


def get_initializer(name, graph_path: list[GraphProto]) -> tuple[TensorProto, GraphProto]:
    for gid in range(len(graph_path) - 1, -1, -1):
        graph = graph_path[gid]
        for tensor in graph.initializer:
            if tensor.name == name:
                return tensor, graph
    return None, None


# transpose int4 matrix (packed as uint8)
def transpose_packed_int4_matrix(packed, rows, cols):
    # unpack to int4 matrix
    total = rows * cols
    high = (packed >> 4) & 0x0F
    low = packed & 0x0F
    int4_vals = np.empty(total, dtype=np.uint8)
    int4_vals[0::2] = low
    int4_vals[1::2] = high
    int4_matrix = int4_vals.reshape((rows, cols))

    # transpose int4 matrix
    int4_matrix_transposed = int4_matrix.T

    # pack to uint8
    flat = int4_matrix_transposed.reshape(-1)
    packed = ((flat[1::2] << 4) & 0xF0) | (flat[0::2] & 0x0F)
    return packed.astype(np.uint8)


class DefaultWeightOnlyQuantizer:
    def __init__(self, config: DefaultWeightOnlyQuantConfig):
        self.config = config

    def qbits_block_quant(self, fp32weight: npt.ArrayLike) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """4b/8b quantize fp32 weight to int4 using C++ kernels."""

        qbits = self.config.bits
        kpack = 8 // qbits
        if len(fp32weight.shape) != 2:
            raise ValueError("Current int4 block quantization only supports 2D tensors!")
        rows, cols = fp32weight.shape

        block_size = self.config.block_size
        k_blocks = (rows + block_size - 1) // block_size

        if self.config.quant_format == QuantFormat.QOperator:
            blob_size = (block_size + kpack - 1) // kpack
            padded_rows = k_blocks * block_size
            pad_len = padded_rows - rows
            if pad_len > 0:
                fp32weight = np.pad(fp32weight, ((0, pad_len), (0, 0)), "constant")

            # block wise quantization, each block comes from a single column
            packed = np.zeros((cols, k_blocks, blob_size), dtype="uint8")
            zero_point = np.zeros((cols, ((k_blocks + kpack - 1) // kpack)), dtype="uint8")
            scales = np.zeros((cols, k_blocks), dtype=fp32weight.dtype)
            if qbits == 2:
                quantize_matmul_2bits(
                    packed, fp32weight, scales, zero_point, block_size, cols, rows, self.config.is_symmetric
                )
            elif qbits == 8:
                quantize_matmul_8bits(
                    packed, fp32weight, scales, zero_point, block_size, cols, rows, self.config.is_symmetric
                )
            else:
                quantize_matmul_4bits(
                    packed, fp32weight, scales, zero_point, block_size, cols, rows, self.config.is_symmetric
                )
        else:
            # block size equal to rows (K) if channel wised quantize enabled
            block_size = rows if self.config.channel_wised_quantize else self.config.block_size
            k_blocks = (rows + block_size - 1) // block_size

            assert qbits == 4, "QDQ format only support 4 bits quantization"
            packed = np.zeros((rows * cols + 1) // 2, dtype="uint8")
            zero_point = np.zeros((cols * k_blocks + 1) // 2, dtype="uint8")
            scales = np.zeros((k_blocks, cols), dtype=fp32weight.dtype)
            quantize_qdq_matmul_4bits(
                packed, fp32weight, scales, zero_point, block_size, cols, rows, self.config.is_symmetric
            )

        return (packed, scales, zero_point)

    def quantize_matmul(self, node: NodeProto, graph_stack: list[GraphProto]) -> list[NodeProto]:
        """
        Quantize weight B of MatMul node to int4 or int8.
        Currently only support 2D constant matrix and axis 0 blockwise quantization.
        """
        bits = self.config.bits
        if bits == 8:
            qtype = TensorProto.INT8 if self.config.is_symmetric else TensorProto.UINT8
        else:
            qtype = TensorProto.INT4 if self.config.is_symmetric else TensorProto.UINT4
        input_b = node.input[1]
        b_tensor, b_graph = get_initializer(input_b, graph_stack)
        if b_tensor is None:
            logger.info("MatMul doesn't have const weight. Skip to quantize")
            return [node]  # only care about constant weight

        b_ndarray = ir.from_proto(b_tensor).numpy()
        if len(b_ndarray.shape) != 2:
            logger.info("MatMul weight is not 2D. Skip to quantize")
            return [node]  # can only process 2-D matrix

        bfloat16 = b_ndarray.dtype == "bfloat16"
        if bfloat16:
            b_ndarray = b_ndarray.astype(np.float32)

        packed, scales, zero_points = self.qbits_block_quant(b_ndarray)
        if bfloat16:
            scales = scales.astype(ml_dtypes.bfloat16)

        if self.config.quant_format == QuantFormat.QOperator:
            b_quant = ir.serde.serialize_tensor(ir.Tensor(packed, name=b_tensor.name + f"_Q{bits}"))
            scales_tensor = ir.serde.serialize_tensor(ir.Tensor(scales, name=b_tensor.name + "_scales"))
        else:
            b_quant = onnx.helper.make_tensor(
                b_tensor.name + f"_DQ_Q{bits}", qtype, b_ndarray.shape, packed.tobytes(), True
            )
            scales_tensor = ir.serde.serialize_tensor(ir.Tensor(scales, name=b_tensor.name + "_DQ_scales"))

        # if QDQ, CW and SYM enabled, optimize for Intel NPU, tranpose the weight to NHWC format will increase performance
        qdq_opt_for_intel_npu_enabled = (
            self.config.quant_format == QuantFormat.QDQ
            and self.config.channel_wised_quantize
            and self.config.is_symmetric
        )
        if qdq_opt_for_intel_npu_enabled:
            rows, cols = b_ndarray.shape
            packed = transpose_packed_int4_matrix(packed, rows, cols)
            scales = scales.reshape((cols, 1))  # (cols, 1)
            b_quant = onnx.helper.make_tensor(
                b_tensor.name + f"_DQ_Q{bits}", qtype, [cols, rows], packed.tobytes(), True
            )
            scales_tensor = ir.serde.serialize_tensor(ir.Tensor(scales, name=b_tensor.name + "_DQ_scales"))

        for input in b_graph.input:
            if input.name == input_b:
                b_graph.input.remove(input)
                break

        b_graph.initializer.extend([b_quant, scales_tensor])

        output_nodes = []

        if self.config.quant_format == QuantFormat.QOperator:
            input_names = [node.input[0], b_quant.name, scales_tensor.name]
            if not self.config.is_symmetric:
                zp_tensor = onnx.numpy_helper.from_array(zero_points, b_tensor.name + "_zero_points")
                input_names.append(zp_tensor.name)
                b_graph.initializer.extend([zp_tensor])
            kwargs = {}
            rows, cols = b_ndarray.shape
            kwargs["K"] = rows
            kwargs["N"] = cols
            kwargs["bits"] = bits
            kwargs["block_size"] = self.config.block_size

            # Do not output accuracy_level if it is 0 since the attribute is optional and is not supported by most EPs.
            if self.config.accuracy_level:
                kwargs["accuracy_level"] = self.config.accuracy_level

            matmul_qbit_node = onnx.helper.make_node(
                "MatMulNBits",
                inputs=input_names,
                outputs=[node.output[0]],
                name=node.name + f"_Q{bits}" if node.name else "",
                domain="com.microsoft",
                **kwargs,
            )

            output_nodes.append(matmul_qbit_node)
        else:
            dq_input_names = [b_quant.name, scales_tensor.name]
            dq_output_names = [b_quant.name + "_output"]
            tp_input_names = [dq_output_names[0]]
            tp_output_names = [dq_output_names[0] + "_transposed"]
            matmul_input_names = [
                node.input[0],
                tp_output_names[0] if qdq_opt_for_intel_npu_enabled else dq_output_names[0],
            ]
            matmul_output_names = [node.output[0]]
            if not self.config.is_symmetric:
                zp_tensor = onnx.helper.make_tensor(
                    b_tensor.name + "_DQ_zero_points", qtype, scales.shape, zero_points.tobytes(), True
                )
                dq_input_names.append(zp_tensor.name)
                b_graph.initializer.extend([zp_tensor])
            rows, cols = b_ndarray.shape
            dq_kwargs = {
                "axis": 1 if qdq_opt_for_intel_npu_enabled else 0,
                "block_size": rows if self.config.channel_wised_quantize else self.config.block_size,
            }
            dq_node = onnx.helper.make_node(
                "DequantizeLinear",
                inputs=dq_input_names,
                outputs=dq_output_names,
                name=node.name + f"_DQ_Q{bits}" if node.name else "",
                **dq_kwargs,
            )
            matmul_node = onnx.helper.make_node(
                "MatMul",
                inputs=matmul_input_names,
                outputs=matmul_output_names,
                name=node.name + f"_matmul_Q{bits}" if node.name else "",
            )
            if qdq_opt_for_intel_npu_enabled:
                tp_node = onnx.helper.make_node(
                    "Transpose",
                    inputs=tp_input_names,
                    outputs=tp_output_names,
                    perm=[1, 0],
                )
                output_nodes.extend([dq_node, tp_node, matmul_node])
            else:
                output_nodes.extend([dq_node, matmul_node])

        return output_nodes

    @staticmethod
    def quant_slice_symmetric(data: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        max_val = np.max(data, axis=1, keepdims=True)
        min_val = np.min(data, axis=1, keepdims=True)
        abs_max = np.where(np.abs(max_val) > np.abs(min_val), max_val, min_val)

        scale = abs_max / -8.0  # if max == min, max may be clipped
        quantized_slice = np.where(scale == 0, 0, data / scale).round().clip(-8, 7).astype(np.int8)

        return quantized_slice, scale

    @staticmethod
    def quant_slice_asymmetric(data: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        min_val = np.minimum(data.min(axis=1, keepdims=True), 0)
        max_val = np.maximum(data.max(axis=1, keepdims=True), 0)

        scale = (max_val - min_val) / 15.0
        zero_point = np.where(scale == 0, 8, -min_val / scale).round().clip(0, 15).astype(np.uint8)
        quantized_slice = np.where(scale == 0, 8, data / scale + zero_point).round().clip(0, 15).astype(np.uint8)

        return quantized_slice, scale, zero_point

    @staticmethod
    def pack_int8_to_int4(data: np.ndarray) -> np.ndarray:
        """Pack int8 data to int4 and store in uint8 ndarray."""
        data_flat = data.reshape(-1)
        if len(data_flat) % 2 != 0:
            data_flat = np.append(data_flat, 0)
        quant_data_int4 = (data_flat[::2] & 0xF) | ((data_flat[1::2] & 0xF) << 4)

        return quant_data_int4.astype("uint8")

    @staticmethod
    def quantize_ndarray(
        data: np.ndarray,
        quantize_axis: int,
        block_size: int,
        is_symmetric: bool,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray | None]:
        """Quantize ndarray data to int4 using numpy, return (quantized data, scales, zero points)."""
        # Get the shape of the matrix
        m = 1  # dimension of the matrix before the quantize axis
        k = data.shape[quantize_axis]  # dimension of the matrix along the quantize axis
        n = 1  # dimension of the matrix after the quantize axis
        for i, dim in enumerate(data.shape):
            if i < quantize_axis:
                m *= dim
            elif i > quantize_axis:
                n *= dim

        k_blocks = (k + block_size - 1) // block_size
        scales_shape = list(data.shape)
        scales_shape[quantize_axis] = k_blocks

        data_reshape = data.reshape((m, k, n))
        scales = np.zeros((m, k_blocks, n), dtype=data.dtype)
        if is_symmetric:
            quant_data_int8 = np.zeros((m, k, n), dtype="int8")
        else:
            quant_data_int8 = np.zeros((m, k, n), dtype="uint8")
            zero_point_int8 = np.zeros((m, k_blocks, n), dtype="uint8")

        # slice and quantize
        for i in range(0, k, block_size):
            end_idx = min(i + block_size, k)
            slice = data_reshape[:, i:end_idx, :]

            if is_symmetric:
                quantized_slice_int8, scale_slice = DefaultWeightOnlyQuantizer.quant_slice_symmetric(slice)
            else:
                quantized_slice_int8, scale_slice, zero_point_slice_int8 = (
                    DefaultWeightOnlyQuantizer.quant_slice_asymmetric(slice)
                )

            quant_data_int8[:, i:end_idx, :] = quantized_slice_int8
            j = i // block_size
            scales[:, j : (j + 1), :] = scale_slice
            if not is_symmetric:
                zero_point_int8[:, j : (j + 1), :] = zero_point_slice_int8

        # pack int8 to int4
        quant_data_int4 = DefaultWeightOnlyQuantizer.pack_int8_to_int4(quant_data_int8)
        zero_point_int4 = None
        if not is_symmetric:
            zero_point_int4 = DefaultWeightOnlyQuantizer.pack_int8_to_int4(zero_point_int8)
        scales = scales.reshape(scales_shape)
        return quant_data_int4, scales, zero_point_int4

    def quantize_gather(self, node: NodeProto, graph_stack: list[GraphProto]) -> list[NodeProto]:
        """Quantize weight data of Gather node to int4."""
        assert self.config.quant_format == QuantFormat.QOperator, "Gather only supports QOperator format currently."

        qtype = TensorProto.INT4 if self.config.is_symmetric else TensorProto.UINT4
        data_arg = node.input[0]
        data_tensorproto, data_graphproto = get_initializer(data_arg, graph_stack)
        if data_tensorproto is None:
            logger.info("Gather doesn't have const weight. Skip quantization.")
            return [node]  # only care about constant weight

        data_ndarray = onnx.numpy_helper.to_array(data_tensorproto)
        data_rank = len(data_ndarray.shape)
        quantize_axis = self.config.quant_axes.get("Gather", 1)
        block_size = self.config.block_size

        assert quantize_axis < data_rank and quantize_axis >= -data_rank, "Invalid quantize axis for Gather node."
        assert block_size >= 16 and ((block_size - 1) & block_size == 0), "Invalid block size for Gather node."

        quantize_axis = (quantize_axis + data_rank) % data_rank
        quantized_data, scales, zero_points = self.quantize_ndarray(
            data_ndarray, quantize_axis, block_size, self.config.is_symmetric
        )

        for input in data_graphproto.input:
            if input.name == data_arg:
                data_graphproto.input.remove(input)
                break

        quantized_data_tensorproto = onnx.helper.make_tensor(
            data_tensorproto.name + "_Q4", qtype, data_ndarray.shape, quantized_data.tobytes(), True
        )
        scales_tensorproto = onnx.numpy_helper.from_array(scales, data_tensorproto.name + "_scales")
        input_names = [quantized_data_tensorproto.name, node.input[1], scales_tensorproto.name]
        data_graphproto.initializer.extend([quantized_data_tensorproto, scales_tensorproto])
        if not self.config.is_symmetric:
            zp_tensorproto = onnx.helper.make_tensor(
                data_tensorproto.name + "_zero_points", qtype, scales.shape, zero_points.tobytes(), True
            )
            input_names.append(zp_tensorproto.name)
            data_graphproto.initializer.extend([zp_tensorproto])

        try:
            gather_axis = onnx.helper.get_node_attr_value(node, "axis")
        except ValueError:
            gather_axis = 0

        kwargs = {
            "gather_axis": gather_axis,
            "quantize_axis": quantize_axis,
            "block_size": block_size,
        }

        gather_q4_node = onnx.helper.make_node(
            "GatherBlockQuantized",
            inputs=input_names,
            outputs=[node.output[0]],
            name=node.name + "_Q4" if node.name else "",
            domain="com.microsoft",
            **kwargs,
        )

        return [gather_q4_node]

    def quantize(self, node: NodeProto, graph_stack: list[GraphProto]) -> list[NodeProto]:
        """
        Target node:        QOperator node:            QDQ nodes:
        MatMul              MatMulNBits                DeQuantizeLinear -> MatMul
        Gather              GatherBlockQuantized       Gather, Gather, Gather (optional) -> DequantizeLinear
        If the node is target node with fp32 or fp16 const weight, quantize the weight to int4 and
        return the new nodes.
        If QOperator format, return the corresponding QOperator nodes.
        If QDQ format, return the corresdponging QDQ nodes.
        Gather (quantized data) + Gather (scales) + Gather (optional, zero points) -> DequantizeLinear is
        not supported yet because Gather does not support int4 data.
        """
        logger.info(f"start to quantize {node.name} ...")

        bits = self.config.bits
        if node.op_type == "MatMul":
            if bits == 8 and self.config.quant_format == QuantFormat.QDQ:
                logger.error("MatMul only supports QOperator format for 8 bits quantization.")
                return [node]
            results = self.quantize_matmul(node, graph_stack)
        elif node.op_type == "Gather":
            if self.config.bits != 4:
                logger.error("Gather only supports 4 bits quantization.")
                return [node]

            results = self.quantize_gather(node, graph_stack)
        else:
            logger.error(f"Unsupported operator {node.op_type} for weight only quantization. Skip quantization.")
            return [node]

        logger.info(f"complete quantization of {node.name} with {self.config.bits} bits ...")
        return results


class NVAWQWeightOnlyQuantizer:
    def __init__(
        self,
        config: NVAWQWeightOnlyQuantConfig,
    ):
        self.config = config

    def quantize_awq(self, model: ModelProto | str) -> ModelProto:
        """
        Perform nvidia_awq quantization using ModelOpt's int4 quantize function.

        Args:
            model (ModelProto): The ONNX model to quantize.

        Returns:
            ModelProto: The quantized ONNX model.
        """
        try:
            from modelopt.onnx.quantization.int4 import quantize as quantize_int4  # noqa: PLC0415
        except ImportError:
            print(
                "Please ensure that the 'modelopt' package is installed. Please install it using pip install nvidia_modelopt."
            )
            raise ImportError(
                "modelopt is not installed. Please install it using pip install nvidia_modelopt. Exiting."
            ) from None

        logger.info("Starting nvidia_awq quantization...")

        # Prepare calibration inputs
        calib_inputs = self.config.calibration_data_reader

        # Perform quantization using ModelOpt's int4 quantize function
        quantized_model = quantize_int4(
            model,
            calibration_method=self.config.calibration_method,
            calibration_data_reader=calib_inputs,
        )

        logger.info("Completed nvidia_awq quantization.")
        return quantized_model


class MatMulNBitsQuantizer:
    """
    Target node:        QOperator node:            QDQ nodes:
    MatMul              MatMulNBits                DeQuantizeLinear -> MatMul
    Gather              GatherBlockQuantized       Gather, Gather, Gather (optional) -> DequantizeLinear

    Perform 2/4/8 bits quantization of constant weights for target nodes.
    If algo_config.quant_format is QOperator:
      - nodes are replaced by the corresponding QOperator nodes.
      - quantized weights are stored in the contrib ops.
    If algo_config.quant_format is QDQ:
      - the quantized weight is stored in a standard onnx node. For MatMul, it is DequantizeLinear. For Gather,
        it is the three Gathers, one for quantized data, one for scales and one for optional zero points.
      - The nodes are replaced by the corresponding QDQ nodes.
      - currently Gather is not supported in QDQ because Gather does not support int4 yet.
    Note:
      - for quantized gather, the memory usage of "DequantizeLinear + Gather" is the same as the original Gather
        during runtime. Therefor it is not recommended.
      - when a node is in nodes_to_exclude, and the node configuration in algo_config.customized_weight_config will be ignored.
    """

    def __init__(
        self,
        model: ModelProto | str,
        bits: int = 4,  # default to 4bit
        block_size: int = 128,
        is_symmetric: bool = False,
        accuracy_level: int | None = None,
        nodes_to_exclude=None,
        nodes_to_include: list[str] | None = None,
        quant_format=QuantFormat.QOperator,
        op_types_to_quantize: tuple[str, ...] | None = None,
        quant_axes: tuple[tuple[str, int], ...] | None = None,
        channel_wised_quantize: bool = False,
        algo_config: WeightOnlyQuantConfig | None = None,
    ):
        if nodes_to_exclude is None:
            nodes_to_exclude = []
        self.model = ONNXModel(onnx.load(model)) if isinstance(model, str) else ONNXModel(model)
        self.model_path = model if isinstance(model, str) else None
        self.bits = bits
        self.block_size = block_size
        self.is_symmetric = is_symmetric
        self.accuracy_level = accuracy_level
        self.nodes_to_exclude = set(nodes_to_exclude)
        self.nodes_to_include = set(nodes_to_include) if nodes_to_include else None
        self.node_quantizer = None

        if algo_config is None:
            algo_config = DefaultWeightOnlyQuantConfig(
                block_size=block_size,
                is_symmetric=is_symmetric,
                accuracy_level=accuracy_level,
                quant_format=quant_format,
                op_types_to_quantize=op_types_to_quantize,
                quant_axes=quant_axes,
                bits=bits,
                channel_wised_quantize=channel_wised_quantize,
            )

        self.algo_config = algo_config
        if hasattr(self.algo_config, "bits"):
            assert self.algo_config.bits in [2, 4, 8], "Only support 2, 4 or 8 bits quantization"

        if algo_config.algorithm == "HQQ":
            self.node_quantizer = HQQWeightOnlyQuantizer(self.algo_config)
        elif algo_config.algorithm == "DEFAULT":
            self.node_quantizer = DefaultWeightOnlyQuantizer(self.algo_config)
        elif algo_config.algorithm == "nvidia_awq":
            self.node_quantizer = NVAWQWeightOnlyQuantizer(self.algo_config)

    def _process_subgraph(self, graph_stack: list[GraphProto]):
        new_nodes = []
        graph = graph_stack[-1]

        for node in graph.node:
            graph_attrs = [
                attr
                for attr in node.attribute
                if attr.type == onnx.AttributeProto.GRAPH or attr.type == onnx.AttributeProto.GRAPHS
            ]
            if graph_attrs:
                kwargs = {}
                for attr in node.attribute:
                    if attr.type == onnx.AttributeProto.GRAPH:
                        # recursive call to take care of sub-graph
                        graph_stack.append(attr.g)
                        kv = {attr.name: self._process_subgraph(graph_stack)}
                    elif attr.type == onnx.AttributeProto.GRAPHS:
                        value = []
                        for subgraph in attr.graphs:
                            # recursive call to take care of sub-graph
                            graph_stack.append(subgraph)
                            value.extend([self._process_subgraph(graph_stack)])
                        kv = {attr.name: value}
                    else:
                        kv = attribute_to_kwarg(attr)
                    kwargs.update(kv)
                node = onnx.helper.make_node(  # noqa: PLW2901
                    node.op_type, node.input, node.output, name=node.name, **kwargs
                )
            out_nodes = []
            if node.name in self.nodes_to_exclude:
                logger.info(f"exclude to quantize {node.name} as specified by nodes_to_exclude...")
                out_nodes = [node]
            elif (self.nodes_to_include and node.name in self.nodes_to_include) or (
                node.op_type in self.algo_config.op_types_to_quantize
            ):
                out_nodes = self.node_quantizer.quantize(node, graph_stack)
            else:
                logger.info(f"skip to quantize {node.name} ...")
                out_nodes = [node]
            new_nodes.extend(out_nodes)

        graph.ClearField("node")
        graph.node.extend(new_nodes)
        graph_stack.pop()
        return graph

    def _generate_q4_node_config(self):
        """Generate weight only quant configuration for nodes."""
        q4_node_config = {}
        for node in self.model.model.graph.node:
            if node.op_type in ["MatMul"]:
                if not all(self.model.get_initializer(i) is None for i in node.input):
                    template_config_q4 = {
                        "bits": 4,
                        "group_size": self.block_size,
                        "scheme": "sym" if self.is_symmetric else "asym",
                    }
                    if (
                        self.algo_config.customized_weight_config
                        and node.name in self.algo_config.customized_weight_config
                    ):
                        for key, value in self.algo_config.customized_weight_config[node.name].items():
                            if key in template_config_q4:
                                template_config_q4[key] = value
                    q4_node_config[node.name] = template_config_q4
        return q4_node_config

    def int4_quant_algo(self):
        """4b quantize a model with RTN or GPTQ algorithm. Please refer to
        https://github.com/intel/neural-compressor/blob/master/docs/source/quantization_weight_only.md
        for more details on weight only quantization using Intel® Neural Compressor.
        """

        def inc_dataloader():
            data_reader = copy.deepcopy(self.algo_config.calibration_data_reader)
            for data in data_reader:
                yield data, None

        kwargs = {}
        if self.accuracy_level is not None:
            kwargs["accuracy_level"] = self.accuracy_level
        weight_only_node_config = self._generate_q4_node_config()

        algorithm = self.algo_config.algorithm
        logger.info(f"start to quantize model with {algorithm} algorithm...")
        if algorithm in ["RTN", "k_quant"]:
            kwargs["ratios"] = self.algo_config.ratios
            kwargs["algorithm"] = algorithm

            """
            We uses fp32 to represent the node that skip quantization, it does not mean this node is fp32 type though.
            """
            for n in self.nodes_to_exclude:
                weight_only_node_config[n] = "fp32"

            self.model = rtn_quantize(
                model=self.model_path if self.model_path is not None else self.model.model,
                weight_config=weight_only_node_config,
                **kwargs,
            )
        elif algorithm == "GPTQ":
            kwargs["percdamp"] = self.algo_config.percdamp
            kwargs["blocksize"] = self.algo_config.block_size
            kwargs["actorder"] = self.algo_config.actorder
            kwargs["mse"] = self.algo_config.mse
            kwargs["perchannel"] = self.algo_config.perchannel
            kwargs["n_samples"] = -1
            dataloader = inc_dataloader()

            self.model = gptq_quantize(
                model=self.model_path if self.model_path is not None else self.model.model,
                weight_config=weight_only_node_config,
                dataloader=dataloader,
                **kwargs,
            )
        logger.info(f"complete quantization of model with {algorithm} algorithm.")

    def process(self):
        if self.algo_config.algorithm in ["HQQ", "DEFAULT"]:
            # use a stack to keep track of sub-graphs
            graph_stack = [self.model.graph()]

            # Update domain opset
            if self.algo_config.quant_format == QuantFormat.QOperator:
                self.model.set_opset_import("com.microsoft", 1)

            if self.algo_config.quant_format == QuantFormat.QDQ or "Gather" in self.algo_config.op_types_to_quantize:
                opset_import = self.model.opset_import()
                for opset in opset_import:
                    if opset.domain in [None, "ai.onnx", ""] and opset.version < 21:
                        logger.warning(
                            "The opset of the input model is under 21 and doesn't support int4 data type. "
                            "Force to update it to opset 21, but the generated model may not be a valid model."
                        )
                        self.model.set_opset_import(opset.domain, 21)

            self._process_subgraph(graph_stack)
            self.model.clean_initializers()
        elif self.algo_config.algorithm == "nvidia_awq":
            # Handle nvidia_awq quantization
            logger.info("Processing nvidia_awq quantization...")
            self.model = self.node_quantizer.quantize_awq(
                self.model.model if self.model_path is None else self.model_path
            )
            logger.info("Completed nvidia_awq quantization.")
            self.model = ONNXModel(self.model)  # Ensure the model is wrapped back into ONNXModel
            self.model.clean_initializers()
        else:
            # RTN or GPTQ weight-only quantize algorithm
            self.int4_quant_algo()


def ort_convert_str_to_bool(value):
    return value.lower() in ("true", "1")


# Custom function to parse str:int pairs
def parse_key_value_pair(s):
    key, value = s.split(":")
    return key, int(value)


def parse_args():
    parser = argparse.ArgumentParser(
        description="""Blockwise int4 quantization for MatMul 2D weight matrices.

A weight matrix is partitioned into into blocks, where each block is a
continguous subset inside each column. Each block is quantized into a
set of 4b integers with a scaling factor and an optional offset.
"""
    )

    parser.add_argument("--input_model", required=True, help="Path to the input model file")
    parser.add_argument("--output_model", required=True, help="Path to the output model file")
    parser.add_argument("--block_size", required=False, default=32, type=int, help="Block size for quantization")
    parser.add_argument(
        "--quant_method",
        default="default",
        type=str,
        choices=["default", "hqq", "rtn", "k_quant", "gptq", "nvidia_awq"],
        help="the algorithm used to quantize weight, \nrtn and gptq leverage Intel® Neural Compressor",
    )
    parser.add_argument("--bits", default=4, type=int, help="the target bits to represent weight")
    parser.add_argument(
        "--symmetric",
        required=False,
        default=True,
        const=True,
        nargs="?",
        type=ort_convert_str_to_bool,
        choices=[True, False],
        help="Indicate whether to quantize the model symmetrically, symmetric is not supported by hqq",
    )
    parser.add_argument(
        "--accuracy_level",
        required=False,
        type=int,
        help="Accuracy level of the 4-bit quantized MatMul computation. "
        "Refer to the MatMulNBits contrib op's 'accuracy_level' attribute for details "
        "(https://github.com/microsoft/onnxruntime/blob/main/docs/ContribOperators.md#commicrosoftmatmulnbits).",
    )
    parser.add_argument("-v", "--verbose", required=False, action="store_true")
    parser.set_defaults(verbose=False)
    parser.add_argument(
        "--nodes_to_exclude",
        nargs="+",
        type=str,
        required=False,
        default=[],
        help="Specify the nodes to be excluded from quantization with node names",
    )
    parser.add_argument(
        "--nodes_to_include",
        nargs="+",
        type=str,
        required=False,
        help="Specify the specific nodes to be included from quantization with node names",
    )
    parser.add_argument(
        "--quant_format",
        default="QOperator",
        type=str,
        choices=["QOperator", "QDQ"],
        help="QuantFormat {QOperator, QDQ}"
        "QOperator format quantizes the model with quantized operators directly."
        "QDQ format quantize the model by inserting DeQuantizeLinear before the MatMul.",
    )
    parser.add_argument(
        "--op_types_to_quantize",
        type=str,
        nargs="+",
        choices=["MatMul", "Gather"],
        help="op_types_to_quantize {MatMul, Gather}. Operators to quantize. Default is MatMul.",
    )
    parser.add_argument(
        "--quant_axes",
        type=parse_key_value_pair,
        nargs="+",
        required=False,
        help="Key-value pairs in op_type:axis_to_quantize separated by space."
        "Specify the axis to quantize for an op. Default {MatMul:0, Gather:1}"
        "Example: --quant_axes MatMul:0 Gather:1",
    )
    # Group arguments specific to nvidia_awq
    nv_awq_config = parser.add_argument_group("nvidia_awq", "Arguments specific to nvidia_awq quantization")
    nv_awq_config.add_argument(
        "--calib_dataset_name",
        type=str,
        default="cnn",
        help="Name of the calibration dataset for nvidia_awq.",
    )
    nv_awq_config.add_argument(
        "--tokenizer_dir",
        type=str,
        required=False,
        help="Path of the tokenizer dir.",
    )
    nv_awq_config.add_argument(
        "--calibration_method",
        type=str,
        required=False,
        choices=["awq", "awq_clip"],
        help="Support two options, awq implementation and weight clipping.",
    )
    nv_awq_config.add_argument(
        "--cache_dir",
        type=str,
        default="./cache",
        help="Cache directory for calibration data.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    if args.verbose:
        logger.setLevel(logging.DEBUG)

    input_model_path = args.input_model
    output_model_path = args.output_model
    quant_format = QuantFormat[args.quant_format]
    op_types_to_quantize = tuple(args.op_types_to_quantize) if args.op_types_to_quantize else ("MatMul",)
    quant_axes = tuple(args.quant_axes) if args.quant_axes else None

    if os.path.exists(output_model_path):
        logger.error(f"file {output_model_path} already exists")
        raise Exception(f"file {output_model_path} already exists")

    if args.symmetric and args.quant_method == "hqq":
        logger.warning("symmetric is not supportted by hqq, will force to symmetric=False")
        args.symmetric = False

    model = onnx.load(input_model_path)
    if args.quant_method == "hqq":
        quant_config = HQQWeightOnlyQuantConfig(
            block_size=args.block_size, bits=args.bits, op_types_to_quantize=op_types_to_quantize, quant_axes=quant_axes
        )
    elif args.quant_method == "default":
        quant_config = DefaultWeightOnlyQuantConfig(
            block_size=args.block_size,
            is_symmetric=args.symmetric,
            accuracy_level=args.accuracy_level,
            quant_format=quant_format,
            op_types_to_quantize=op_types_to_quantize,
            quant_axes=quant_axes,
            bits=args.bits,
        )
    elif args.quant_method == "rtn":
        quant_config = RTNWeightOnlyQuantConfig(op_types_to_quantize=op_types_to_quantize)
    elif args.quant_method == "k_quant":
        quant_config = KQuantWeightOnlyQuantConfig(op_types_to_quantize=op_types_to_quantize)
    elif args.quant_method == "gptq":
        quant_config = GPTQWeightOnlyQuantConfig(block_size=args.block_size, op_types_to_quantize=op_types_to_quantize)
    elif args.quant_method == "nvidia_awq":
        if quant_format == QuantFormat.QOperator:
            logger.warning("QOperator is not applicable to nvidia_awq. overriding the value to QDQ")
            quant_format = QuantFormat.QDQ

        model = input_model_path
        if args.calibration_method is not None:
            if args.calibration_method == "awq":
                calibration_method = "awq_lite"
            else:
                calibration_method = "awq_clip"
        else:
            calibration_method = "awq_lite"

        quant_config = NVAWQWeightOnlyQuantConfig(
            dataset_name=args.calib_dataset_name,
            tokenizer_dir=args.tokenizer_dir,
            cache_dir=args.cache_dir,
            calibration_method=calibration_method,
        )
    else:
        raise ValueError(f"Unsupported quantization method: {args.quant_method}")

    quant = MatMulNBitsQuantizer(
        model=model,
        bits=args.bits,
        accuracy_level=args.accuracy_level,
        nodes_to_exclude=args.nodes_to_exclude,
        nodes_to_include=args.nodes_to_include,
        algo_config=quant_config,
    )
    quant.process()
    quant.model.save_model_to_file(output_model_path, True)
