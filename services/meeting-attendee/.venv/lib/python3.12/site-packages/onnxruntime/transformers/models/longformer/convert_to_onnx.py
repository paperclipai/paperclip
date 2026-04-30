# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.  See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------

# This script converts Longformer model from huggingface transformers 4.0 or later to ONNX.
# It translates LongformerSelfAttention to the LongformerAttention operator in ONNX Runtime.
#
# Before running this script, prepare a python environment in Linux with PyTorch 1.9.0 and other packages installed.
# Then run "python setup.py install" in ./torch_extensions directory. If your python version is not 3.8, you will need
# update this script with correct name of longformer_attention.cpython-*.so (search TODO below).
#
# It is tested in Ubuntu 18.04 with python 3.8, onnxruntime-gpu 1.11.0, PyTorch 1.9.0, transformers 4.18.0.
# Warning: Using  PyTorch 1.10 or newer version might encounter issue in exporting, but they are fine for benchmarking.
#
# Example commands to export longformer base model in Linux:
#   conda create -n longformer python=3.8
#   conda activate longformer
#   python3 -m pip install torch==1.9.0+cu111 torchvision==0.10.0+cu111 torchaudio==0.9.0 -f https://download.pytorch.org/whl/torch_stable.html
#   python3 -m pip install flatbuffers numpy packaging sympy protobuf==3.20.1 onnx==1.12.0 transformers==4.18.0
#   python3 -m pip install -i https://test.pypi.org/simple/ ort-nightly-gpu
#   cd ./torch_extensions
#   rm -rf build
#   python setup.py install
#   cd ..
#   python convert_to_onnx.py --model longformer-base-4096 --precision fp16 --optimize_onnx
#   python convert_to_onnx.py --model longformer-base-4096 --precision fp16 --optimize_onnx --no_merge_qkv
#
# GPU is not needed for this script. You can run it in CPU. For --optimize_onnx, you can use either onnxruntime or onnxruntime-gpu package.
#
# For inference of the onnx model, you will need onnxruntime-gpu 1.7.0 or newer version.

import argparse
import inspect
from pathlib import Path

import torch
import transformers
from longformer_helper import PRETRAINED_LONGFORMER_MODELS
from onnx import load_model
from onnx_model_bert import BertOnnxModel
from packaging import version
from torch.onnx import register_custom_op_symbolic
from torch.onnx.symbolic_helper import parse_args
from torch_onnx_export_helper import torch_onnx_export
from transformers import LongformerModel, LongformerSelfAttention

# Supports format 0 or 1
weight_bias_format = 0


@parse_args("v", "v", "v", "v", "v", "v", "v", "i", "i")
def my_longformer_attention(
    g,
    input,
    weight,
    bias,
    mask,
    global_weight,
    global_bias,
    global_mask,
    num_heads,
    window,
):
    return g.op(
        "com.microsoft::LongformerAttention",
        input,
        weight,
        bias,
        mask,
        global_weight,
        global_bias,
        global_mask,
        num_heads_i=num_heads,
        window_i=window,
    )


# namespace is onnxruntime which is registered in longformer_attention.cpp
register_custom_op_symbolic("onnxruntime::LongformerAttention", my_longformer_attention, 9)

# TODO: search the directory to find correct output filename of "python setup.py install" when python version is not 3.8
torch.ops.load_library(
    r"./torch_extensions/build/lib.linux-x86_64-3.8/longformer_attention.cpython-38-x86_64-linux-gnu.so"
)


def parse_arguments():
    """Parse arguments

    Returns:
        args: Namespace
    """
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "-m",
        "--model",
        required=False,
        type=str,
        default="longformer-base-4096",
        help="Checkpoint directory or pre-trained model names in the list: "
        + ", ".join(PRETRAINED_LONGFORMER_MODELS.keys()),
    )

    parser.add_argument(
        "--export_padding",
        required=False,
        action="store_true",
        help="Export padding logic to ONNX graph. If not enabled, user need pad input so that sequence length is multiple of window size.",
    )
    parser.set_defaults(export_padding=False)

    parser.add_argument(
        "--no_merge_qkv",
        required=False,
        action="store_true",
        help="Stack the weights of q, k and v on dimension 0 instead of dimension 1.",
    )
    parser.set_defaults(no_merge_qkv=False)

    parser.add_argument(
        "-o",
        "--optimize_onnx",
        required=False,
        action="store_true",
        help="Use optimizer.py to optimize onnx model.",
    )
    parser.set_defaults(optimize_onnx=False)

    parser.add_argument(
        "-p",
        "--precision",
        required=False,
        type=str,
        default="fp32",
        choices=["fp32", "fp16"],
        help="Precision of model to run: fp32 for full precision, fp16 for mixed precision",
    )

    args = parser.parse_args()
    return args


# Create a dummy input for ONNX export.
def get_dummy_inputs(config, export_padding, device):
    # When sequence length is multiple of windows size, there is no padding logic in ONNX graph
    sequence_length = config.attention_window[0] + 1 if export_padding else config.attention_window[0]

    # Create dummy inputs
    input_ids = torch.arange(sequence_length).unsqueeze(0).to(device)

    attention_mask = torch.ones(input_ids.shape, dtype=torch.long, device=device)
    attention_mask[:, sequence_length - 1] = 0  # last token is masked

    global_attention_mask = torch.zeros(input_ids.shape, dtype=torch.long, device=device)
    global_attention_mask[:, 0] = 1  # first token is global token

    return input_ids, attention_mask, global_attention_mask


# A new function to replace LongformerSelfAttention.forward
# For transformers 4.0.0
def my_longformer_self_attention_forward_4(
    self,
    hidden_states,
    attention_mask=None,
    is_index_masked=None,
    is_index_global_attn=None,
    is_global_attn=None,
):
    global_mask = is_index_global_attn.int()
    # The following check is based on the dummy inputs (only the first token is global).
    assert (
        len(global_mask.shape) == 2
        and global_mask.shape[0] == 1
        and global_mask.count_nonzero().item() == 1
        and global_mask.tolist()[0][0] == 1
    )

    input_mask = is_index_masked.float()
    # TODO: The filtering value may be -10000.0 or -inf. Check the huggingface implementation.
    input_mask = input_mask.masked_fill(is_index_masked, -10000.0)
    # Yet another way to generate input_mask = torch.masked_fill(attention_mask, is_index_global_attn, 0.0)

    # TODO: add postprocessing of ONNX model to calculate based on graph input: input_mask = (attention_mask - 1) * 10000.0
    # TODO: add postprocessing of ONNX model to use graph input directly: global_mask = global_attention_mask

    # The following check is based on the dummy inputs (only the last token is masked).
    assert (
        len(input_mask.shape) == 2
        and input_mask.shape[0] == 1
        and input_mask.count_nonzero().item() == 1
        and input_mask.tolist()[0][-1] == -10000.0
    )

    weight = torch.stack(
        (
            self.query.weight.transpose(0, 1),
            self.key.weight.transpose(0, 1),
            self.value.weight.transpose(0, 1),
        ),
        dim=weight_bias_format,
    )

    if weight_bias_format == 1:
        # shape is (hidden_size, 3*hidden_size) for format 1, otherwise (3, hidden_size, hidden_size) by default
        weight = weight.reshape(self.embed_dim, 3 * self.embed_dim)

    global_weight = torch.stack(
        (
            self.query_global.weight.transpose(0, 1),
            self.key_global.weight.transpose(0, 1),
            self.value_global.weight.transpose(0, 1),
        ),
        dim=weight_bias_format,
    )

    if weight_bias_format == 1:
        global_weight = global_weight.reshape(self.embed_dim, 3 * self.embed_dim)

    if weight_bias_format == 1:
        bias = torch.stack((self.query.bias, self.key.bias, self.value.bias), dim=0)
        bias = bias.reshape(3 * self.embed_dim)
        global_bias = torch.stack((self.query_global.bias, self.key_global.bias, self.value_global.bias), dim=0)
        global_bias = global_bias.reshape(3 * self.embed_dim)
    else:
        bias = torch.stack(
            (self.query.bias, self.key.bias, self.value.bias, self.key_global.bias, self.value_global.bias), dim=0
        )
        bias = bias.reshape(5 * self.embed_dim)
        global_bias = self.query_global.bias
        global_bias = global_bias.reshape(1 * self.embed_dim)

    attn_output = torch.ops.onnxruntime.LongformerAttention(
        hidden_states,
        weight,
        bias,
        input_mask,
        global_weight,
        global_bias,
        global_mask,
        self.num_heads,
        self.one_sided_attn_window_size,
    )

    assert attn_output.size() == hidden_states.size(), "Unexpected size"

    outputs = (attn_output,)
    return outputs


# For transformers 4.3.0
def my_longformer_self_attention_forward_4_3(
    self,
    hidden_states,
    attention_mask=None,
    is_index_masked=None,
    is_index_global_attn=None,
    is_global_attn=None,
    output_attentions=False,
):
    assert output_attentions is False
    return my_longformer_self_attention_forward_4(
        self,
        hidden_states,
        attention_mask,
        is_index_masked,
        is_index_global_attn,
        is_global_attn,
    )


# For transformers 4.3.2 or later versions
def my_longformer_self_attention_forward_4_3_2(
    self,
    hidden_states,
    attention_mask=None,
    layer_head_mask=None,
    is_index_masked=None,
    is_index_global_attn=None,
    is_global_attn=None,
    output_attentions=False,
):
    assert output_attentions is False
    assert layer_head_mask is None
    return my_longformer_self_attention_forward_4(
        self,
        hidden_states,
        attention_mask,
        is_index_masked,
        is_index_global_attn,
        is_global_attn,
    )


def export_longformer(model: LongformerModel, onnx_model_path: str, export_padding: bool):
    """Export longformer model to ONNX

    Args:
        model (LongformerModel): longformer model
        onnx_model_path (str): output onnx path
        export_padding (bool): whether export padding logic to ONNX so that input string can be any length.

    Raises:
        RuntimeError: This tool requires transformers 4.0.0 or later.
        RuntimeError: LongformerSelfAttention.forward arguments are different.
    """
    input_ids, attention_mask, global_attention_mask = get_dummy_inputs(
        model.config, export_padding, device=torch.device("cpu")
    )

    _ = model(
        input_ids,
        attention_mask=attention_mask,
        global_attention_mask=global_attention_mask,
    )

    if version.parse(transformers.__version__) < version.parse("4.0.0"):
        raise RuntimeError("This tool requires transformers 4.0.0 or later.")

    # Here we replace LongformerSelfAttention.forward using our implementation for exporting ONNX model
    key = " ".join(inspect.getfullargspec(LongformerSelfAttention.forward).args)
    args_to_func = {
        "self hidden_states attention_mask layer_head_mask is_index_masked is_index_global_attn is_global_attn output_attentions": my_longformer_self_attention_forward_4_3_2,
        "self hidden_states attention_mask is_index_masked is_index_global_attn is_global_attn output_attentions": my_longformer_self_attention_forward_4_3,
        "self hidden_states attention_mask is_index_masked is_index_global_attn is_global_attn": my_longformer_self_attention_forward_4,
    }

    if key not in args_to_func:
        print(
            "Current arguments",
            inspect.getfullargspec(LongformerSelfAttention.forward).args,
        )
        raise RuntimeError(
            "LongformerSelfAttention.forward arguments are different. Please install supported version (like transformers 4.3.0)."
        )

    # Store for restoring later
    original_forward = LongformerSelfAttention.forward

    LongformerSelfAttention.forward = args_to_func[key]

    example_inputs = (input_ids, attention_mask, global_attention_mask)

    Path(onnx_model_path).parent.mkdir(parents=True, exist_ok=True)

    torch_onnx_export(
        model,
        example_inputs,
        onnx_model_path,
        opset_version=12,
        input_names=["input_ids", "attention_mask", "global_attention_mask"],
        output_names=["last_state", "pooler"],
        dynamic_axes={
            "input_ids": {0: "batch_size", 1: "sequence_length"},
            "attention_mask": {0: "batch_size", 1: "sequence_length"},
            "global_attention_mask": {0: "batch_size", 1: "sequence_length"},
            "last_state": {0: "batch_size", 1: "sequence_length"},
            "pooler": {0: "batch_size", 1: "sequence_length"},
        },
        custom_opsets={"com.microsoft": 1},
    )
    print(f"ONNX model exported to {onnx_model_path}")

    # Restore original implementation:
    LongformerSelfAttention.forward = original_forward


def optimize_longformer(onnx_model_path: str, fp32_model_path: str, fp16_model_path=None):
    """Optimize longformer onnx model

    Args:
        onnx_model_path (str): path of original ONNX model.
        fp32_model_path (str): path of optimized fp32 model.
        fp16_model_path (str, optional): path of optimized fp16 model. Defaults to None.
    """
    model = load_model(onnx_model_path, format=None, load_external_data=True)
    optimizer = BertOnnxModel(model)
    optimizer.optimize()

    use_external_data_format = False
    if fp32_model_path:
        optimizer.save_model_to_file(fp32_model_path, use_external_data_format)
        print(f"optimized fp32 model saved to {fp32_model_path}")

    if fp16_model_path:
        optimizer.convert_float_to_float16(keep_io_types=True)
        optimizer.save_model_to_file(fp16_model_path, use_external_data_format)
        print(f"optimized fp16 model saved to {fp16_model_path}")


def main(args):
    model_name = args.model
    onnx_model_path = model_name + ".onnx"

    global weight_bias_format  # noqa: PLW0603
    weight_bias_format = 0 if args.no_merge_qkv else 1

    model = LongformerModel.from_pretrained(PRETRAINED_LONGFORMER_MODELS[model_name])

    export_longformer(model, onnx_model_path, args.export_padding)

    if args.optimize_onnx or args.precision != "fp32":
        fp32_model_path = model_name + f"_f{weight_bias_format}" + "_fp32.onnx"
        fp16_model_path = model_name + f"_f{weight_bias_format}" + "_fp16.onnx" if args.precision == "fp16" else None
        optimize_longformer(onnx_model_path, fp32_model_path, fp16_model_path)


if __name__ == "__main__":
    args = parse_arguments()
    main(args)
