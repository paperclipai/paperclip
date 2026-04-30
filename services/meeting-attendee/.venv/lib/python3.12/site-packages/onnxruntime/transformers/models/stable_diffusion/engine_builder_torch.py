# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
import logging

from diffusion_models import PipelineInfo
from engine_builder import EngineBuilder, EngineType

logger = logging.getLogger(__name__)


class TorchEngineBuilder(EngineBuilder):
    def __init__(
        self,
        pipeline_info: PipelineInfo,
        max_batch_size=16,
        device="cuda",
        use_cuda_graph=False,
    ):
        """
        Initializes the ONNX Runtime TensorRT ExecutionProvider Engine Builder.

        Args:
            pipeline_info (PipelineInfo):
                Version and Type of pipeline.
            max_batch_size (int):
                Maximum batch size for dynamic batch engine.
            device (str):
                device to run.
            use_cuda_graph (bool):
                Use CUDA graph to capture engine execution and then launch inference
        """
        super().__init__(
            EngineType.TORCH,
            pipeline_info,
            max_batch_size=max_batch_size,
            device=device,
            use_cuda_graph=use_cuda_graph,
        )

        self.compile_config = {}
        if use_cuda_graph:
            self.compile_config = {
                "clip": {"mode": "reduce-overhead", "dynamic": False},
                "clip2": {"mode": "reduce-overhead", "dynamic": False},
                "unet": {"mode": "reduce-overhead", "fullgraph": True, "dynamic": False},
                "unetxl": {"mode": "reduce-overhead", "fullgraph": True, "dynamic": False},
                "vae": {"mode": "reduce-overhead", "fullgraph": False, "dynamic": False},
            }

    def build_engines(
        self,
        framework_model_dir: str,
    ):
        import torch  # noqa: PLC0415

        self.torch_device = torch.device("cuda", torch.cuda.current_device())
        self.load_models(framework_model_dir)

        pipe = self.load_pipeline_with_lora() if self.pipeline_info.lora_weights else None

        built_engines = {}
        for model_name, model_obj in self.models.items():
            model = self.get_or_load_model(pipe, model_name, model_obj, framework_model_dir)
            if self.pipeline_info.is_xl() and not self.custom_fp16_vae:
                model = model.to(device=self.torch_device, dtype=torch.float32)
            else:
                model = model.to(device=self.torch_device, dtype=torch.float16)

            if model_name in self.compile_config:
                compile_config = self.compile_config[model_name]
                if model_name in ["unet", "unetxl"]:
                    model.to(memory_format=torch.channels_last)
                engine = torch.compile(model, **compile_config)
                built_engines[model_name] = engine
            else:  # eager mode
                built_engines[model_name] = model

        self.engines = built_engines

    def run_engine(self, model_name, feed_dict):
        if model_name in ["unet", "unetxl"]:
            if "controlnet_images" in feed_dict:
                return {"latent": self.engines[model_name](**feed_dict)}

            if model_name == "unetxl":
                added_cond_kwargs = {k: feed_dict[k] for k in feed_dict if k in ["text_embeds", "time_ids"]}
                return {
                    "latent": self.engines[model_name](
                        feed_dict["sample"],
                        feed_dict["timestep"],
                        feed_dict["encoder_hidden_states"],
                        added_cond_kwargs=added_cond_kwargs,
                        return_dict=False,
                    )[0]
                }

            return {
                "latent": self.engines[model_name](
                    feed_dict["sample"], feed_dict["timestep"], feed_dict["encoder_hidden_states"], return_dict=False
                )[0]
            }

        if model_name in ["vae_encoder"]:
            return {"latent": self.engines[model_name](feed_dict["images"])}

        raise RuntimeError(f"Shall not reach here: {model_name}")
