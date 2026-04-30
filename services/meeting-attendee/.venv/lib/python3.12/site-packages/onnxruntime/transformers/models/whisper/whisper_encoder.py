# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.  See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------

import logging
import os
import tempfile
from pathlib import Path

import numpy as np
import onnx
import torch
from float16 import convert_float_to_float16
from onnx import ModelProto
from onnx_model import OnnxModel
from transformers import WhisperConfig
from whisper_inputs import get_model_dynamic_axes, get_sample_encoder_inputs

from onnxruntime import InferenceSession

logger = logging.getLogger(__name__)


class WhisperEncoder(torch.nn.Module):
    """Whisper encoder component"""

    def __init__(self, config: WhisperConfig, model: torch.nn.Module, model_impl: str):
        super().__init__()
        self.config = config
        self.device = model.device
        self.model_impl = model_impl

        self.encoder = model.encoder if model_impl == "openai" else model.model.encoder

    def forward(self, audio_features: torch.Tensor):
        outputs = self.encoder(audio_features)
        return outputs if self.model_impl == "openai" else outputs.last_hidden_state

    def input_names(self):
        input_names = ["audio_features"]
        return input_names

    def output_names(self):
        output_names = ["encoder_hidden_states"]
        return output_names

    def dynamic_axes(self, input_names, output_names):
        dynamic_axes = get_model_dynamic_axes(self.config, input_names, output_names)
        return dynamic_axes

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
    ):
        """Export encoder to ONNX

        Args:
            onnx_model_path (str): path to save ONNX model
            provider (str): provider to use for verifying parity on ONNX model
            verbose (bool, optional): print verbose information. Defaults to True.
            use_external_data_format (bool, optional): use external data format or not. Defaults to False.
            use_fp16_inputs (bool, optional): use float16 inputs for the audio_features. Defaults to False.
        """
        # Shape of encoder's tensors:
        # Inputs:
        #    audio_features: (batch_size, num_mels, num_frames)
        # Outputs:
        #    encoder_hidden_states: (batch_size, num_frames // 2, hidden_size)

        inputs = get_sample_encoder_inputs(
            self.config,
            self.device,
            batch_size=2,
            use_fp16=use_fp16_inputs,
        )

        input_names = self.input_names()
        output_names = self.output_names()
        dynamic_axes = self.dynamic_axes(input_names, output_names)

        Path(onnx_model_path).parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory() as tmp_dir_name:
            temp_onnx_model_path = os.path.join(tmp_dir_name, "encoder.onnx")
            Path(temp_onnx_model_path).parent.mkdir(parents=True, exist_ok=True)
            out_path = temp_onnx_model_path if use_external_data_format else onnx_model_path

            torch.onnx.export(
                self,
                args=(inputs["audio_features"]),
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
            model = self.fix_layernorm_weights(model, use_fp16_inputs)
            OnnxModel.save(
                model,
                onnx_model_path,
                save_as_external_data=use_external_data_format,
                all_tensors_to_one_file=True,
            )

        self.verify_onnx(onnx_model_path, provider, use_fp16_inputs)

    def verify_onnx(
        self,
        onnx_model_path: str,
        provider: str,
        use_fp16_inputs: bool,
    ):
        """Verify ONNX model outputs and PyTorch model outputs match

        Args:
            onnx_model_path (str): path to save ONNX model
            provider (str): execution provider for ONNX model
            use_fp16_inputs (bool, optional): use float16 inputs for the audio_features
        """
        # Shape of encoder's tensors:
        # Inputs:
        #    audio_features: (batch_size, num_mels, num_frames)
        # Outputs:
        #    encoder_hidden_states: (batch_size, num_frames // 2, hidden_size)
        inputs = get_sample_encoder_inputs(
            self.config,
            self.device,
            batch_size=2,
            use_fp16=use_fp16_inputs,
        )

        # Run PyTorch model
        pt_outputs = self.forward(inputs["audio_features"]).detach().cpu().numpy()

        # Run ONNX model
        sess = InferenceSession(onnx_model_path, providers=[provider])
        ort_outputs = sess.run(None, {"audio_features": inputs["audio_features"].detach().cpu().numpy()})[0]

        # Calculate output difference
        diff = np.abs(pt_outputs - ort_outputs)
        logger.warning("Comparing encoder_hidden_states...")
        logger.warning(f"Max diff: {np.max(diff)}")
