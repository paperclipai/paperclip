# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.  See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------

import logging
import os
import tempfile
import textwrap
from pathlib import Path

import numpy as np
import onnx
import torch
import torch.nn.functional as F
import torch.utils.cpp_extension
from onnx_model import OnnxModel
from transformers import WhisperConfig
from whisper_inputs import convert_inputs_for_ort, get_model_dynamic_axes, get_sample_jump_times_inputs

from onnxruntime import InferenceSession
from onnxruntime.tools import pytorch_export_contrib_ops

logger = logging.getLogger(__name__)

##################################################
# Functions that have to be outside of the class
# for torch.jit.script_if_tracing to work
##################################################


@torch.jit.script_if_tracing
def index_QKs(alignment_heads: torch.Tensor, QKs: list[torch.Tensor]):  # noqa: N802
    """
    Compute the following to get stacked QK tensor that has been indexed for the desired attention heads:
    weights = torch.stack([QKs[_l][:, _h] for _l, _h in alignment_heads], dim=1)
    """
    indexed_QKs = []  # noqa: N806
    for pair in alignment_heads:
        # Each QK is of shape (batch_size, num_heads, sequence_length, num_frames // 2)
        # The `QKs[_l]` selects the right QK from the list of QKs
        # The `QKs[_l][:, _h]` selects the right attention heads from the chosen QK. The `:` is to do this for the batch dim.
        #
        # PyTorch:
        # QKs[_l] is of shape (batch_size, num_heads, sequence_length, num_frames // 2)
        # QKs[_l][:, _h] is of shape (batch_size, sequence_length, num_frames // 2)
        #
        # ONNX:
        # QKs[_l] is of shape (batch_size, num_heads, sequence_length, num_frames // 2)
        # QKs[_l][:, _h] is of shape (batch_size, 1, sequence_length, num_frames // 2) because
        # the `[:, _h]` operation maps to a Gather op and that op does not reduce dimensions
        _l, _h = pair[0], pair[1]
        indexed_QKs.append(QKs[_l][:, _h])

    # PyTorch:
    # torch.stack will return a tensor of shape (batch_size, num_alignment_heads, sequence_length, num_frames // 2).
    #
    # ONNX:
    # torch.stack will return a tensor of shape (batch_size, num_alignment_heads, 1, sequence_length, num_frames // 2)
    # because the Gather op does not reduce dimensions. To remove the unneeded dimension, torch.squeeze with a specified
    # dim (dim = 2) is added. The torch.squeeze op with a specified dim only runs if the specified dim has a size of 1.
    # Since the dim won't be of size 1 in the PyTorch tensor but it is of size 1 in the ONNX tensor, it will be a no-op
    # in PyTorch and an op in ONNX. Thus, the Squeeze op will only affect the ONNX model.
    weights = torch.stack(indexed_QKs, dim=1)
    weights = torch.squeeze(weights, dim=2)
    return weights


def jump_timings(text_indices, time_indices):
    """
    Calculate jump times from text_indices and time_indices where
    text_indices and time_indices are both 1d vectors
    """
    TOKENS_PER_SECOND = 50.0  # noqa: N806
    diff = text_indices[1:] - text_indices[:-1]
    padding = torch.tensor([1], dtype=torch.int32)
    jumps = torch.cat((padding, diff)).to(torch.bool)
    jump_times = time_indices[jumps].to(torch.float) / TOKENS_PER_SECOND
    return jump_times


def padded_jump_from_dtw(matrix_2d: torch.Tensor, max_length: torch.Tensor):
    """
    Run Dynamic Time Warping (DTW) on batched tensor
    """
    trace = torch.ops.onnxruntime.DynamicTimeWarping(matrix_2d)
    text_indices = trace[0, :]
    time_indices = trace[1, :]
    jump_times = jump_timings(text_indices, time_indices)
    return F.pad(jump_times, [0, int((max_length - jump_times.size(-1)).item())], mode="constant", value=-1.0)


@torch.jit.script_if_tracing
def batch_jump_times(matrix: torch.Tensor, max_decoded_length: torch.Tensor):
    """
    Compute the following to calculate jump times for all batches:
    batched_jump_times = torch.stack([self.padded_jump_from_dtw(matrix[b], max_decoded_length) for b in range(matrix.size(0))])
    """
    list_of_jump_times = []
    for b in range(matrix.size(0)):
        jump_times = padded_jump_from_dtw(matrix[b], max_decoded_length)
        list_of_jump_times.append(jump_times)
    batched_jump_times = torch.stack(list_of_jump_times)
    return batched_jump_times


class WhisperJumpTimes(torch.nn.Module):
    """Whisper jump times component"""

    def __init__(self, config: WhisperConfig, device: torch.device, cache_dir: str | os.PathLike):
        super().__init__()
        self.config = config
        self.device = device
        self.cache_dir = cache_dir

        self.filter_width = 7
        self.qk_scale = 1.0

    def median_filter(self, weights: torch.Tensor):
        """
        Apply a median filter of width `filter_width` along the last dimension of `weights`
        """
        pad_width = self.filter_width // 2
        x = F.pad(weights, (pad_width, pad_width, 0, 0), mode="reflect")
        x_unfolded = torch.ops.onnxruntime.UnfoldTensor(x, -1, self.filter_width, 1)
        result = torch.select(x_unfolded.sort()[0], dim=-1, index=pad_width)
        return result

    def forward(
        self,
        alignment_heads: torch.Tensor,
        sot_sequence_length: torch.Tensor,
        segment_length: torch.Tensor,
        QKs: list[torch.Tensor],
    ):
        # Get stacked QKs tensor
        weights = index_QKs(alignment_heads, QKs)
        weights = weights[:, :, : segment_length // 2]
        weights = weights.to(torch.float32)

        weights = (weights * self.qk_scale).softmax(dim=-1)
        std, mean = torch.std_mean(weights, dim=-2, keepdim=True, unbiased=False)
        weights = (weights - mean) / std
        weights = self.median_filter(weights)

        matrix = torch.mean(weights, 1)
        matrix = -matrix[:, sot_sequence_length:-1]

        max_decoded_length = torch.tensor([matrix.size(1)], dtype=torch.int64)
        batched_jump_times = batch_jump_times(matrix, max_decoded_length)
        return batched_jump_times

    def input_names(self):
        input_names = [
            "alignment_heads",
            "sot_sequence_length",
            "segment_length",
            *[f"cross_qk_{i}" for i in range(self.config.decoder_layers)],
        ]
        return input_names

    def output_names(self):
        output_names = ["jump_times"]
        return output_names

    def inputs(self, use_fp16_inputs: bool, use_int32_inputs: bool, return_dict: bool = False):
        inputs = get_sample_jump_times_inputs(
            self.config,
            self.device,
            batch_size=2,
            sequence_length=8,
            num_alignment_heads=6,
            sot_sequence_length=3,
            segment_length=1332,
            use_fp16=use_fp16_inputs,
            use_int32=use_int32_inputs,
        )
        if return_dict:
            return inputs
        return (
            inputs["alignment_heads"],
            inputs["sot_sequence_length"],
            inputs["segment_length"],
            inputs["QKs"],
        )

    def create_torch_ops(self):
        """
        1) Create UnfoldTensor and DynamicTimeWarping as torch ops
        3) Provide a symbolic mapping from torch ops to ORT contrib ops

        See https://pytorch.org/tutorials/advanced/torch_script_custom_ops.html#building-with-jit-compilation
        for more details on how this works.
        """
        # Set torch extensions directory to cache directory
        os.environ["TORCH_EXTENSIONS_DIR"] = self.cache_dir

        # Try to import `ninja` pip package
        try:
            assert torch.utils.cpp_extension.verify_ninja_availability()
        except Exception as e:
            logger.error(f"An error occurred while verifying `ninja` is available: {e}", exc_info=True)  # noqa: G201
            install_cmd = "pip install ninja"
            logger.warning(f"Could not import `ninja`. Attempting to install `ninja` via `{install_cmd}`.")
            os.system(install_cmd)

        # Create UnfoldTensor torch op
        unfold_op_source = textwrap.dedent("""\
        #include "torch/script.h"

        torch::Tensor UnfoldTensor(torch::Tensor input, int64_t dim, int64_t size, int64_t step) {
          return input.unfold(dim, size, step);
        }

        // namespace is onnxruntime
        static auto registry = torch::RegisterOperators("onnxruntime::UnfoldTensor", &UnfoldTensor);
        """)

        torch.utils.cpp_extension.load_inline(
            name="UnfoldTensor",
            cpp_sources=unfold_op_source,
            is_python_module=False,
            verbose=True,
        )

        # Create DynamicTimeWarping torch op
        dtw_op_source = textwrap.dedent("""\
        #include "torch/script.h"
        #include "torch/torch.h"
        #include <stdexcept>
        #include <tuple>
        #include <vector>

        torch::Tensor Backtrace(torch::Tensor trace) {
          int64_t i = trace.size(0) - 1;
          int64_t j = trace.size(1) - 1;
          trace.index({0, torch::indexing::Slice()}) = 2;
          trace.index({torch::indexing::Slice(), 0}) = 1;

          std::vector<int32_t> result_vec;
          while (i > 0 || j > 0) {
            result_vec.push_back(static_cast<int32_t>(i - 1));
            result_vec.push_back(static_cast<int32_t>(j - 1));
            int value = trace[i][j].item<int>();

            if (value == 0) {
              i--;
              j--;
            } else if (value == 1) {
              i--;
            } else if (value == 2) {
              j--;
            } else {
              throw std::runtime_error("Unexpected trace[i, j]");
            }
          }

          // Compute result[::-1, :].T
          torch::Tensor result = torch::from_blob(result_vec.data(), {static_cast<long int>(result_vec.size() / 2), 2}, torch::kInt32).clone();
          torch::Tensor reversed = result.flip(0); // result[::-1, :]
          torch::Tensor transposed = reversed.transpose(0, 1); // .T
          return transposed;
        }

        torch::Tensor DynamicTimeWarping(torch::Tensor x) {
          int64_t N = x.size(0);
          int64_t M = x.size(1);
          torch::Tensor cost = torch::full({N + 1, M + 1}, std::numeric_limits<float>::infinity(), torch::dtype(torch::kFloat32));
          torch::Tensor trace = torch::full({N + 1, M + 1}, -1, torch::dtype(torch::kFloat32));

          cost[0][0] = 0;
          for (int j = 1; j < M + 1; j++) {
            for (int i = 1; i < N + 1; i++) {
              float c0 = cost[i - 1][j - 1].item<float>();
              float c1 = cost[i - 1][j].item<float>();
              float c2 = cost[i][j - 1].item<float>();

              float c = 0;
              float t = 0;

              if (c0 < c1 && c0 < c2) {
                c = c0;
                t = 0;
              } else if (c1 < c0 && c1 < c2) {
                c = c1;
                t = 1;
              } else {
                c = c2;
                t = 2;
              }

              cost[i][j] = x[i - 1][j - 1].item<float>() + c;
              trace[i][j] = t;
            }
          }

          return Backtrace(trace);
        }

        // namespace is onnxruntime
        static auto registry = torch::RegisterOperators("onnxruntime::DynamicTimeWarping", &DynamicTimeWarping);
        """)

        torch.utils.cpp_extension.load_inline(
            name="DynamicTimeWarping",
            cpp_sources=dtw_op_source,
            is_python_module=False,
            verbose=True,
        )

        # Create symbolic mapping from torch ops to ORT contrib ops
        pytorch_export_contrib_ops.register()

    def export_onnx(
        self,
        onnx_model_path: str,
        provider: str,
        verbose: bool = True,
        use_external_data_format: bool = False,
        use_fp16_inputs: bool = False,
        use_int32_inputs: bool = True,
    ):
        """Export word-level timestamps to ONNX

        Args:
            onnx_model_path (str): path to save ONNX model
            provider (str): provider to use for verifying parity on ONNX model
            verbose (bool, optional): print verbose information. Defaults to True.
            use_external_data_format (bool, optional): use external data format or not. Defaults to False.
            use_fp16_inputs (bool, optional): use float16 inputs for the audio_features. Defaults to False.
            use_int32_inputs (bool, optional): use int32 inputs for the decoder_input_ids. Defaults to True.
        """
        # Shape of timestamps's tensors:
        # Inputs:
        #    alignment_heads: (num_alignment_heads, 2)
        #    sot_sequence_length: (1)
        #    segment_length: (1)
        #    cross_qk_*: (batch_size, num_heads, sequence_length, num_frames // 2)
        # Outputs:
        #    jump_times: (batch_size, max_length)

        # Definitions:
        # alignment_heads: the attention head indices where the Q*K values are highly correlated with word-level timestamps
        # (i.e. the alignment between audio and text tokens)
        # This is calculated as follows:
        #
        # ```
        # import base64
        # import gzip
        # import numpy as np
        # import torch
        #
        # # base85-encoded (n_layers, n_heads) boolean arrays indicating the cross-attention heads that are
        # # highly correlated to the word-level timing, i.e. the alignment between audio and text tokens.
        # _ALIGNMENT_HEADS = {
        #     "tiny.en": b"ABzY8J1N>@0{>%R00Bk>$p{7v037`oCl~+#00",
        #     "tiny": b"ABzY8bu8Lr0{>%RKn9Fp%m@SkK7Kt=7ytkO",
        #     "base.en": b"ABzY8;40c<0{>%RzzG;p*o+Vo09|#PsxSZm00",
        #     "base": b"ABzY8KQ!870{>%RzyTQH3`Q^yNP!>##QT-<FaQ7m",
        #     "small.en": b"ABzY8>?_)10{>%RpeA61k&I|OI3I$65C{;;pbCHh0B{qLQ;+}v00",
        #     "small": b"ABzY8DmU6=0{>%Rpa?J`kvJ6qF(V^F86#Xh7JUGMK}P<N0000",
        #     "medium.en": b"ABzY8usPae0{>%R7<zz_OvQ{)4kMa0BMw6u5rT}kRKX;$NfYBv00*Hl@qhsU00",
        #     "medium": b"ABzY8B0Jh+0{>%R7}kK1fFL7w6%<-Pf*t^=N)Qr&0RR9",
        #     "large-v1": b"ABzY8r9j$a0{>%R7#4sLmoOs{s)o3~84-RPdcFk!JR<kSfC2yj",
        #     "large-v2": b"ABzY8zd+h!0{>%R7=D0pU<_bnWW*tkYAhobTNnu$jnkEkXqp)j;w1Tzk)UH3X%SZd&fFZ2fC2yj",
        #     "large-v3": b"ABzY8gWO1E0{>%R7(9S+Kn!D~%ngiGaR?*L!iJG9p-nab0JQ=-{D1-g00",
        #     "large": b"ABzY8gWO1E0{>%R7(9S+Kn!D~%ngiGaR?*L!iJG9p-nab0JQ=-{D1-g00",
        #     "large-v3-turbo": b"ABzY8j^C+e0{>%RARaKHP%t(lGR*)0g!tONPyhe`",
        #     "turbo": b"ABzY8j^C+e0{>%RARaKHP%t(lGR*)0g!tONPyhe`",
        # }
        #
        # model_name = "large-v3-turbo"
        # array = np.frombuffer(
        #     gzip.decompress(base64.b85decode(_ALIGNMENT_HEADS[model_name])), dtype=bool
        # ).copy()
        # mask = torch.from_numpy(array).reshape(
        #     self.dims.n_text_layer, self.dims.n_text_head
        # )
        # self.alignment_heads = mask.to_sparse().indices().T
        # ```
        #
        # sot_sequence_length: the length of the start-of-transcription sequence before the first token is generated
        # Typically the start-of-transcription sequence is [<|startoftranscription|>, <|language_token|>, <|task_token|>]
        # so its length is 3.
        #
        # segment_length: the length (in frames) of the audio segment that is being transcribed
        #
        # cross_qk_*: the Q*K values for the cross-attention blocks in the decoder
        # Every decoder layer has a self-attention block and a cross-attention block so there are `n` cross-attention blocks
        # where `n` is the number of decoder layers.
        #
        # jump_times: the timings where jumps occur in speech
        # This allows us to detect when a word began to be spoken by the speaker (start_times) and when a word was finished
        # being spoken by the speaker (end_times).

        inputs = self.inputs(use_fp16_inputs=use_fp16_inputs, use_int32_inputs=use_int32_inputs)
        input_names = self.input_names()
        output_names = self.output_names()
        dynamic_axes = get_model_dynamic_axes(self.config, input_names, output_names)

        Path(onnx_model_path).parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory() as tmp_dir_name:
            temp_onnx_model_path = os.path.join(tmp_dir_name, "encoder.onnx")
            Path(temp_onnx_model_path).parent.mkdir(parents=True, exist_ok=True)
            out_path = temp_onnx_model_path if use_external_data_format else onnx_model_path

            # Create torch ops and map them to ORT contrib ops before export
            self.create_torch_ops()
            torch.onnx.export(
                self,
                args=inputs,
                f=out_path,
                export_params=True,
                input_names=input_names,
                output_names=output_names,
                dynamic_axes=dynamic_axes,
                opset_version=17,
                do_constant_folding=True,
                verbose=verbose,
                custom_opsets={"com.microsoft": 1},
            )

            if use_external_data_format:
                model = onnx.load_model(out_path, load_external_data=use_external_data_format)
                OnnxModel.save(
                    model,
                    onnx_model_path,
                    save_as_external_data=True,
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
            use_fp16_inputs (bool, optional): use float16 inputs for the cross_qk_{i}
            use_int32_inputs (bool, optional): use int32 inputs for the alignment_heads and sot_sequence_length
        """
        # Shape of jump times's tensors:
        # Inputs:
        #    alignment_heads: (num_alignment_heads, 2)
        #    sot_sequence_length: (1)
        #    segment_length: (1)
        #    cross_qk_*: (batch_size, num_heads, sequence_length, num_frames // 2)
        # Outputs:
        #    jump_times: (batch_size, max_length)
        inputs = self.inputs(use_fp16_inputs=use_fp16_inputs, use_int32_inputs=use_int32_inputs, return_dict=True)

        # Run PyTorch model
        pt_outputs = (
            self.forward(
                inputs["alignment_heads"], inputs["sot_sequence_length"], inputs["segment_length"], inputs["QKs"]
            )
            .detach()
            .cpu()
            .numpy()
        )

        # Run ONNX model
        sess = InferenceSession(onnx_model_path, providers=[provider])
        ort_outputs = sess.run(None, convert_inputs_for_ort(inputs, sess))

        # Calculate output difference
        diff = np.abs(pt_outputs - ort_outputs)
        print("Comparing batched jump_times...", flush=True)
        print(f"Max diff: {np.max(diff)}", flush=True)
