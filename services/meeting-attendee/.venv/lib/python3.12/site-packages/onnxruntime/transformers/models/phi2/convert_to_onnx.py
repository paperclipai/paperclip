# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
from __future__ import annotations

import argparse
import logging
import os
import warnings
from pathlib import Path

import onnx
import torch
from benchmark_helper import Precision
from fusion_options import AttentionOpType
from onnx_model import OnnxModel
from packaging import version
from transformers import AutoConfig, AutoModelForCausalLM

from onnxruntime import __version__ as ort_version

if version.parse(ort_version) < version.parse("1.22.0"):
    from onnxruntime.quantization.matmul_4bits_quantizer import MatMul4BitsQuantizer as MatMulNBitsQuantizer
else:
    from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer


class ConvertPhi2ToONNX:
    def __init__(
        self,
        device: torch.device,
        model_class: str = "microsoft/phi-2",
        cache_dir: str = "./cache",
    ):
        self.model_class = model_class
        self.device = device
        self.cache_dir = cache_dir
        self.phi_config = AutoConfig.from_pretrained(self.model_class, trust_remote_code=True, cache_dir=self.cache_dir)
        self.phi_model = None
        self.batch_size = 2
        self.sequence_length = 8
        self.attn_op_type = None
        self.precision = None
        self.block_size = 16
        self.accuracy_level = None

    def set_quantization_params(self, block_size: int, accuracy_level: int | None):
        self.block_size = block_size
        self.accuracy_level = accuracy_level

    def init_attn_type_and_precision(self, attn_op_type: AttentionOpType, precision: Precision):
        self.attn_op_type = attn_op_type
        self.precision = precision

    def erase_onnx_model(self, onnx_path: str) -> None:
        assert onnx_path.endswith(".onnx")
        if not os.path.exists(onnx_path):
            return

        model = onnx.load_model(onnx_path, load_external_data=False)
        onnx_data_path = None
        for initializer in model.graph.initializer:
            if initializer.data_location == 1 and initializer.external_data[0].key == "location":
                onnx_data_path = "./" + initializer.external_data[0].value
                break
        logging.info(f"Erasing {onnx_path}...")
        os.remove(onnx_path)
        if onnx_data_path is not None:
            onnx_data_path = os.path.join(Path(onnx_path).parent, onnx_data_path)
            logging.info(f"Erasing {onnx_data_path}...")
            os.remove(onnx_data_path)

    def get_phi2_torch_model(self):
        logging.info("Loading phi2 torch model...")
        if self.phi_model is not None:
            return
        self.phi_model = AutoModelForCausalLM.from_pretrained(
            self.model_class, trust_remote_code=True, cache_dir=self.cache_dir
        )
        self.phi_model.eval()
        self.phi_model.to(self.device)

    def get_phi2_torch_inputs(self, batch_size: int, sequence_length: int):
        input_ids = torch.randint(
            low=0,
            high=self.phi_config.vocab_size,
            size=(batch_size, sequence_length),
            dtype=torch.int64,
            device=self.device,
        )
        self.get_phi2_torch_model()
        torch_inputs = self.phi_model.prepare_inputs_for_generation(
            input_ids, past_key_values=self.phi_model(input_ids, use_cache=True)["past_key_values"]
        )
        return torch_inputs["input_ids"], torch_inputs["attention_mask"], torch_inputs["past_key_values"]

    def dynamo_export(self, onnx_path: str):
        input_ids, attention_mask, past_key_values = self.get_phi2_torch_inputs(self.batch_size, self.sequence_length)
        self.phi_model(input_ids, attention_mask=attention_mask, past_key_values=past_key_values)

        from torch._dynamo import config  # noqa: PLC0415

        config.capture_scalar_outputs = True

        logging.info("Exporting Phi2 torch model to ONNX...")
        torch.onnx.dynamo_export(
            self.phi_model,
            input_ids,
            attention_mask=attention_mask,
            past_key_values=past_key_values,
            export_options=torch.onnx.ExportOptions(dynamic_shapes=True),
        ).save(onnx_path)
        onnx.checker.check_model(onnx_path)
        onnx.shape_inference.infer_shapes_path(onnx_path)

    def optimize_phi2_onnx(self, onnx_path: str, onnx_path_opt: str):
        from fusion_options import FusionOptions  # noqa: PLC0415
        from optimizer import optimize_model  # noqa: PLC0415

        optimization_options = FusionOptions("phi")
        optimization_options.set_attention_op_type(self.attn_op_type)
        optimizer = optimize_model(
            onnx_path,
            model_type="phi",
            num_heads=self.phi_config.num_attention_heads,
            hidden_size=self.phi_config.hidden_size,
            opt_level=0,
            optimization_options=optimization_options,
            only_onnxruntime=False,
        )

        fused_op_count = optimizer.get_fused_operator_statistics()
        if optimizer.is_fully_optimized(fused_op_count):
            logging.info("Model is fully optimized.")
        else:
            logging.info("Model is not fully optimized.")

        if self.precision == Precision.FLOAT32:
            optimizer.save_model_to_file(onnx_path_opt, use_external_data_format=True)
            return

        if (
            self.precision == Precision.FLOAT16 or self.precision == Precision.INT4
        ) and self.attn_op_type != AttentionOpType.MultiHeadAttention:
            # We keep last three layers of Attention as float32 or bfloat16 to avoid overflow.
            node_block_list = (
                [
                    "Attention_29",
                    "Attention_30",
                    "Attention_31",
                ]
                if self.attn_op_type != AttentionOpType.PagedAttention
                else []
            )  # TODO: temp setting for paged attention
            logging.info("Converting onnx model to float16/bfloat16...")
            optimizer.convert_float_to_float16(
                keep_io_types=False,
                node_block_list=node_block_list,
                use_symbolic_shape_infer=True,
                use_bfloat16_as_blocked_nodes_dtype=self.attn_op_type == AttentionOpType.GroupQueryAttention,
            )
            logging.info("Converting onnx model to float16/bfloat16 done.")

        if self.precision == Precision.FLOAT16:
            optimizer.save_model_to_file(onnx_path_opt, use_external_data_format=True)
            return
        else:
            assert self.precision == Precision.INT4
            quant = MatMulNBitsQuantizer(
                model=optimizer.model,
                bits=4,
                block_size=self.block_size,
                is_symmetric=True,
                accuracy_level=self.accuracy_level,
            )
            quant.process()
            quant.model.save_model_to_file(onnx_path_opt, use_external_data_format=True)

    # This function currently only works for phi2 model
    def convert_to_use_cuda_graph(self, in_onnx_path: str, out_onnx_path: str):
        onnx_model = OnnxModel(onnx.load(in_onnx_path, load_external_data=True))

        from onnx import TensorProto, helper  # noqa: PLC0415

        graph = onnx_model.graph()
        new_inputs = []
        for vi in graph.input:
            if "attention_mask" in vi.name:
                vi_seqlen_k = helper.make_tensor_value_info(
                    "seqlens_k",
                    elem_type=TensorProto.INT32,
                    shape=["batch_size"],
                )
                vi_total_seq_len = helper.make_tensor_value_info(
                    "total_sequence_length",
                    elem_type=TensorProto.INT32,
                    shape=[1],
                )
                new_inputs.extend([vi_seqlen_k, vi_total_seq_len])
            else:
                new_inputs.append(vi)

        graph.ClearField("input")
        graph.input.extend(new_inputs)

        gqas = onnx_model.get_nodes_by_op_type("GroupQueryAttention")
        gqa = gqas[0]
        seqlens_path = onnx_model.match_parent_path(
            gqa,
            ["Cast", "Sub", "ReduceSum", "Cast"],
            [5, 0, 0, 0],
        )
        if seqlens_path is None:
            raise RuntimeError("Failed to find seqlens path for GroupQueryAttention node.")
        total_seq_len_path = onnx_model.match_parent_path(
            gqa,
            ["Cast", "Gather", "Shape"],
            [6, 0, 0],
        )
        if total_seq_len_path is None:
            raise RuntimeError("Failed to find total_seq_len path for GroupQueryAttention node.")
        onnx_model.remove_nodes(seqlens_path)
        onnx_model.remove_nodes(total_seq_len_path)

        for gqa in gqas:
            gqa.input[5] = "seqlens_k"
            gqa.input[6] = "total_sequence_length"

        onnx_model.save(onnx_model.model, out_onnx_path, save_as_external_data=True)


def parse_arguments():
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "--fp32_cpu",
        required=False,
        action="store_true",
        help="Generate fp32 ONNX model for CPU",
    )

    parser.add_argument(
        "--int4_cpu",
        required=False,
        action="store_true",
        help="Generate int4 ONNX model for CPU",
    )

    parser.add_argument(
        "--fp32_gpu",
        required=False,
        action="store_true",
        help="Generate fp32 ONNX model for Nvidia GPUs",
    )

    parser.add_argument(
        "--fp16_gpu",
        required=False,
        action="store_true",
        help="Generate fp16 ONNX model for Nvidia GPUs",
    )

    parser.add_argument(
        "--int4_gpu",
        required=False,
        action="store_true",
        help="Generate int4 ONNX model for Nvidia GPUs",
    )

    parser.add_argument(
        "--fp16_gpu_sm8x",
        required=False,
        action="store_true",
        help="Generate fp16 ONNX model for Nvidia GPUs with CUDA architecture SM=80~89",
    )

    parser.add_argument(
        "--int4_gpu_sm8x",
        required=False,
        action="store_true",
        help="Generate int4 ONNX model for Nvidia GPUs with CUDA architecture SM=80~89",
    )

    parser.add_argument(
        "--fp16_vllm",
        required=False,
        action="store_true",
        help="Generate fp16 ONNX model for ORT VLLM",
    )

    parser.add_argument(
        "--int4_vllm",
        required=False,
        action="store_true",
        help="Generate int4 ONNX model for ORT VLLM",
    )

    parser.add_argument(
        "--use_cuda_graph",
        required=False,
        action="store_true",
        help="Use CUDA Graph in decoding process",
    )

    parser.add_argument(
        "--overwrite",
        required=False,
        action="store_true",
        help="Overwrite existing ONNX models",
    )

    parser.add_argument(
        "--cache_dir",
        required=False,
        type=str,
        default="./cache",
        help="The cache directory for the pytorch model",
    )

    parser.add_argument(
        "--device_id",
        required=False,
        type=int,
        default=0,
        help="The device id for the pytorch model",
    )

    parser.add_argument(
        "--run_example",
        required=False,
        action="store_true",
        help="Run ORT inference example",
    )

    parser.add_argument(
        "--run_benchmark",
        required=False,
        action="store_true",
        help="Run ORT benchmark",
    )

    parser.add_argument(
        "--skip_export",
        required=False,
        action="store_true",
        help="Skip exporting ONNX model",
    )

    parser.add_argument(
        "--output_dir",
        type=str,
        help="The output directory for the ONNX models",
        default="phi2_onnx_models",
    )

    parser.add_argument(
        "--block_size",
        required=False,
        default=16,
        type=int,
        help="Block size to quantize with. See https://github.com/microsoft/onnxruntime/blob/main/onnxruntime/python/tools/quantization/matmul_nbits_quantizer.py for details.",
    )

    parser.add_argument(
        "--int4_accuracy_level",
        required=False,
        type=int,
        help="Accuracy level of the 4-bit quantized MatMul computation. "
        "Refer to the MatMulNBits contrib op's 'accuracy_level' attribute for details "
        "(https://github.com/microsoft/onnxruntime/blob/main/docs/ContribOperators.md#commicrosoftmatmulnbits).",
    )

    args = parser.parse_args()
    return args


def main():
    warnings.warn(
        "This example is deprecated. Use the Olive recipe instead: "
        "https://github.com/microsoft/olive-recipes/tree/main",
        DeprecationWarning,
        stacklevel=2,
    )
    args = parse_arguments()

    device = torch.device("cuda", args.device_id) if torch.cuda.is_available() else torch.device("cpu")

    converter = ConvertPhi2ToONNX(device, cache_dir=args.cache_dir)
    converter.set_quantization_params(args.block_size, args.int4_accuracy_level)

    output_dir = args.output_dir

    if not os.path.exists(output_dir):
        os.makedirs(output_dir)

    original_onnx_path = os.path.join(output_dir, "phi2_original.onnx")

    if not args.skip_export:
        if not os.path.exists(original_onnx_path) or args.overwrite:
            converter.dynamo_export(original_onnx_path)

    model_type_to_args = {
        "fp32_cpu": (
            AttentionOpType.MultiHeadAttention,
            Precision.FLOAT32,
            os.path.join(output_dir, "phi2_decoder_fp32_cpu.onnx"),
        ),
        "int4_cpu": (
            AttentionOpType.MultiHeadAttention,
            Precision.INT4,
            os.path.join(output_dir, "phi2_decoder_int4_cpu.onnx"),
        ),
        "fp32_gpu": (
            AttentionOpType.Attention,
            Precision.FLOAT32,
            os.path.join(output_dir, "phi2_decoder_fp32_gpu.onnx"),
        ),
        "fp16_gpu": (
            AttentionOpType.Attention,
            Precision.FLOAT16,
            os.path.join(output_dir, "phi2_decoder_fp16_gpu.onnx"),
        ),
        "int4_gpu": (AttentionOpType.Attention, Precision.INT4, os.path.join(output_dir, "phi2_decoder_int4_gpu.onnx")),
        "fp16_gpu_sm8x": (
            AttentionOpType.GroupQueryAttention,
            Precision.FLOAT16,
            os.path.join(output_dir, "phi2_decoder_fp16_gpu_sm8x.onnx"),
        ),
        "int4_gpu_sm8x": (
            AttentionOpType.GroupQueryAttention,
            Precision.INT4,
            os.path.join(output_dir, "phi2_decoder_int4_gpu_sm8x.onnx"),
        ),
        "fp16_vllm": (
            AttentionOpType.PagedAttention,
            Precision.FLOAT16,
            os.path.join(output_dir, "phi2_decoder_fp16_vllm.onnx"),
        ),
        "int4_vllm": (
            AttentionOpType.PagedAttention,
            Precision.INT4,
            os.path.join(output_dir, "phi2_decoder_int4_vllm.onnx"),
        ),
    }

    if not args.skip_export:
        from multiprocessing import Process  # noqa: PLC0415

        def run_optimize_phi2_onnx(
            converter: ConvertPhi2ToONNX,
            original_onnx_path: str,
            attention_type: AttentionOpType,
            precision: Precision,
            optimized_onnx_path: str,
        ):
            converter.init_attn_type_and_precision(attention_type, precision)
            converter.optimize_phi2_onnx(original_onnx_path, optimized_onnx_path)
            if args.use_cuda_graph:
                assert args.fp16_gpu_sm8x or args.int4_gpu_sm8x
                converter.convert_to_use_cuda_graph(optimized_onnx_path, optimized_onnx_path)

        processes = []
        if args.fp32_cpu:
            processes.append(
                Process(
                    target=run_optimize_phi2_onnx, args=(converter, original_onnx_path, *model_type_to_args["fp32_cpu"])
                )
            )

        if args.int4_cpu:
            processes.append(
                Process(
                    target=run_optimize_phi2_onnx, args=(converter, original_onnx_path, *model_type_to_args["int4_cpu"])
                )
            )

        if args.fp32_gpu:
            processes.append(
                Process(
                    target=run_optimize_phi2_onnx, args=(converter, original_onnx_path, *model_type_to_args["fp32_gpu"])
                )
            )

        if args.fp16_gpu:
            processes.append(
                Process(
                    target=run_optimize_phi2_onnx, args=(converter, original_onnx_path, *model_type_to_args["fp16_gpu"])
                )
            )

        if args.int4_gpu:
            processes.append(
                Process(
                    target=run_optimize_phi2_onnx, args=(converter, original_onnx_path, *model_type_to_args["int4_gpu"])
                )
            )

        if args.fp16_gpu_sm8x:
            processes.append(
                Process(
                    target=run_optimize_phi2_onnx,
                    args=(converter, original_onnx_path, *model_type_to_args["fp16_gpu_sm8x"]),
                )
            )

        if args.int4_gpu_sm8x:
            processes.append(
                Process(
                    target=run_optimize_phi2_onnx,
                    args=(converter, original_onnx_path, *model_type_to_args["int4_gpu_sm8x"]),
                )
            )

        if args.fp16_vllm:
            processes.append(
                Process(
                    target=run_optimize_phi2_onnx,
                    args=(converter, original_onnx_path, *model_type_to_args["fp16_vllm"]),
                )
            )

        if args.int4_vllm:
            processes.append(
                Process(
                    target=run_optimize_phi2_onnx,
                    args=(converter, original_onnx_path, *model_type_to_args["int4_vllm"]),
                )
            )

        [p.start() for p in processes]
        [p.join() for p in processes]

    if args.run_example or args.run_benchmark:
        from inference_example import run_phi2  # noqa: PLC0415

        if args.fp16_gpu_sm8x:
            logging.info("Running fp16_gpu_sm8x example...")
            run_phi2(
                onnx_model_path=model_type_to_args["fp16_gpu_sm8x"][2],
                use_buffer_share=True,
                device_id=args.device_id,
                use_step=True,
                use_cuda_graph=args.use_cuda_graph,
                run_benchmark=args.run_benchmark,
            )
        if args.int4_gpu_sm8x:
            logging.info("Running int4_gpu_sm8x example...")
            run_phi2(
                onnx_model_path=model_type_to_args["int4_gpu_sm8x"][2],
                use_buffer_share=True,
                device_id=args.device_id,
                use_step=True,
                use_cuda_graph=args.use_cuda_graph,
                run_benchmark=args.run_benchmark,
            )
        if args.fp32_gpu:
            logging.info("Running fp32_gpu example...")
            run_phi2(
                onnx_model_path=model_type_to_args["fp32_gpu"][2],
                use_buffer_share=False,
                device_id=args.device_id,
                packed_kv=True,
                use_fp16=False,
                run_benchmark=args.run_benchmark,
            )
        if args.fp16_gpu:
            logging.info("Running fp16_gpu example...")
            run_phi2(
                onnx_model_path=model_type_to_args["fp16_gpu"][2],
                use_buffer_share=False,
                device_id=args.device_id,
                packed_kv=True,
                run_benchmark=args.run_benchmark,
            )
        if args.int4_gpu:
            logging.info("Running int4_gpu example...")
            run_phi2(
                onnx_model_path=model_type_to_args["int4_gpu"][2],
                use_buffer_share=False,
                device_id=args.device_id,
                packed_kv=True,
                run_benchmark=args.run_benchmark,
            )
        if args.fp32_cpu or args.int4_cpu or args.fp16_vllm or args.int4_vllm:
            raise NotImplementedError("CPU/vllm inference example is not implemented yet.")


if __name__ == "__main__":
    main()
