# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
import hashlib
import os
from enum import Enum

import torch
from diffusion_models import CLIP, VAE, CLIPWithProj, PipelineInfo, UNet, UNetXL


class EngineType(Enum):
    ORT_CUDA = 0  # ONNX Runtime CUDA Execution Provider
    ORT_TRT = 1  # ONNX Runtime TensorRT Execution Provider
    TRT = 2  # TensorRT
    TORCH = 3  # PyTorch


def get_engine_type(name: str) -> EngineType:
    name_to_type = {
        "ORT_CUDA": EngineType.ORT_CUDA,
        "ORT_TRT": EngineType.ORT_TRT,
        "TRT": EngineType.TRT,
        "TORCH": EngineType.TORCH,
    }
    return name_to_type[name]


class EngineBuilder:
    def __init__(
        self,
        engine_type: EngineType,
        pipeline_info: PipelineInfo,
        device="cuda",
        max_batch_size=16,
        use_cuda_graph=False,
    ):
        """
        Initializes the Engine Builder.

        Args:
            pipeline_info (PipelineInfo):
                Version and Type of pipeline.
            device (str | torch.device):
                device to run engine
            max_batch_size (int):
                Maximum batch size for dynamic batch engine.
            use_cuda_graph (bool):
                Use CUDA graph to capture engine execution and then launch inference
        """
        self.engine_type = engine_type
        self.pipeline_info = pipeline_info
        self.max_batch_size = max_batch_size
        self.use_cuda_graph = use_cuda_graph
        self.device = torch.device(device)
        self.torch_device = torch.device(device, torch.cuda.current_device())
        self.stages = pipeline_info.stages()

        self.vae_torch_fallback = self.pipeline_info.vae_torch_fallback() and self.engine_type != EngineType.TORCH
        self.custom_fp16_vae = self.pipeline_info.custom_fp16_vae()

        self.models = {}
        self.engines = {}
        self.torch_models = {}
        self.use_vae_slicing = False

        self.torch_sdpa = getattr(torch.nn.functional, "scaled_dot_product_attention", None)

    def enable_vae_slicing(self):
        self.use_vae_slicing = True

    def disable_torch_spda(self):
        if hasattr(torch.nn.functional, "scaled_dot_product_attention"):
            delattr(torch.nn.functional, "scaled_dot_product_attention")

    def enable_torch_spda(self):
        if (not hasattr(torch.nn.functional, "scaled_dot_product_attention")) and self.torch_sdpa:
            torch.nn.functional.scaled_dot_product_attention = self.torch_sdpa

    def teardown(self):
        for engine in self.engines.values():
            del engine
        self.engines = {}

    def get_diffusers_module_name(self, model_name):
        name_mapping = {
            "clip": "text_encoder",
            "clip2": "text_encoder_2",
            "unet": "unet",
            "unetxl": "unet",
            "vae": "vae_decoder",
        }
        return name_mapping.get(model_name, model_name)

    def get_cached_model_name(self, model_name):
        model_name = self.get_diffusers_module_name(model_name)
        is_unet = model_name == "unet"
        hash_source = []
        if model_name in ["text_encoder", "text_encoder_2", "unet"] and self.pipeline_info.lora_weights:
            if self.pipeline_info.lora_weights in [
                "latent-consistency/lcm-lora-sdxl",
                "latent-consistency/lcm-lora-sdv1-5",
            ]:
                if is_unet:
                    model_name = "unet_lcm-lora"
            else:
                model_name = model_name + "_lora"
                hash_source.append(self.pipeline_info.lora_weights)

        # TODO(tianleiwu): save custom model to a directory named by its original model.
        if is_unet and self.pipeline_info.custom_unet():
            model_name = model_name + "_lcm"

        if model_name in ["unet"] and self.pipeline_info.controlnet:
            model_name = model_name + "_" + "_".join(self.pipeline_info.controlnet)

        if hash_source:
            model_name += "_" + hashlib.sha256("\t".join(hash_source).encode("utf-8")).hexdigest()[:8]

        # TODO: When we support original VAE, we shall save custom VAE to another directory.

        if self.pipeline_info.is_inpaint():
            model_name += "_inpaint"
        return model_name

    def get_model_dir(self, model_name, root_dir, opt=True, suffix="", create=True):
        engine_name = self.engine_type.name.lower()
        if engine_name != "ort_cuda" and not suffix:
            suffix = f".{engine_name}" if opt else ""
        directory_name = self.get_cached_model_name(model_name) + suffix
        onnx_model_dir = os.path.join(root_dir, directory_name)
        if create:
            os.makedirs(onnx_model_dir, exist_ok=True)
        return onnx_model_dir

    def get_onnx_path(self, model_name, onnx_dir, opt=True, suffix=""):
        onnx_model_dir = self.get_model_dir(model_name, onnx_dir, opt=opt, suffix=suffix)
        return os.path.join(onnx_model_dir, "model.onnx")

    def get_engine_path(self, engine_dir, model_name, profile_id):
        return os.path.join(engine_dir, self.get_cached_model_name(model_name) + profile_id)

    def load_pipeline_with_lora(self):
        """Load text encoders and UNet with diffusers pipeline"""
        from diffusers import DiffusionPipeline  # noqa: PLC0415

        pipeline = DiffusionPipeline.from_pretrained(
            self.pipeline_info.name(),
            variant="fp16",
            torch_dtype=torch.float16,
        )
        pipeline.load_lora_weights(self.pipeline_info.lora_weights)
        pipeline.fuse_lora(lora_scale=self.pipeline_info.lora_scale)

        del pipeline.vae
        pipeline.vae = None
        return pipeline

    def get_or_load_model(self, pipeline, model_name, model_obj, framework_model_dir):
        if model_name in ["clip", "clip2", "unet", "unetxl"] and pipeline:
            if model_name == "clip":
                model = pipeline.text_encoder
                pipeline.text_encoder = None
            elif model_name == "clip2":
                model = pipeline.text_encoder_2
                pipeline.text_encoder_2 = None
            else:
                model = pipeline.unet
                pipeline.unet = None
        else:
            model = model_obj.load_model(framework_model_dir)

        return model.to(self.torch_device)

    def load_models(self, framework_model_dir: str):
        # For TRT or ORT_TRT, we will export fp16 torch model for UNet and VAE
        # For ORT_CUDA, we export fp32 model first, then optimize to fp16.
        export_fp16 = self.engine_type in [EngineType.ORT_TRT, EngineType.TRT]

        if "clip" in self.stages:
            self.models["clip"] = CLIP(
                self.pipeline_info,
                None,  # not loaded yet
                device=self.torch_device,
                max_batch_size=self.max_batch_size,
                clip_skip=0,
            )

        if "clip2" in self.stages:
            self.models["clip2"] = CLIPWithProj(
                self.pipeline_info,
                None,  # not loaded yet
                device=self.torch_device,
                max_batch_size=self.max_batch_size,
                clip_skip=0,
            )

        if "unet" in self.stages:
            self.models["unet"] = UNet(
                self.pipeline_info,
                None,  # not loaded yet
                device=self.torch_device,
                fp16=export_fp16,
                max_batch_size=self.max_batch_size,
                unet_dim=(9 if self.pipeline_info.is_inpaint() else 4),
            )

        if "unetxl" in self.stages:
            self.models["unetxl"] = UNetXL(
                self.pipeline_info,
                None,  # not loaded yet
                device=self.torch_device,
                fp16=export_fp16,
                max_batch_size=self.max_batch_size,
                unet_dim=4,
                time_dim=(5 if self.pipeline_info.is_xl_refiner() else 6),
            )

        # VAE Decoder
        if "vae" in self.stages:
            self.models["vae"] = VAE(
                self.pipeline_info,
                None,  # not loaded yet
                device=self.torch_device,
                max_batch_size=self.max_batch_size,
                fp16=export_fp16,
                custom_fp16_vae=self.custom_fp16_vae,
            )

            if self.vae_torch_fallback:
                self.torch_models["vae"] = self.models["vae"].load_model(framework_model_dir)

    def load_resources(self, image_height, image_width, batch_size):
        if self.engine_type == EngineType.TORCH:
            return

        # Allocate buffers for I/O bindings
        for model_name, obj in self.models.items():
            if model_name == "vae" and self.vae_torch_fallback:
                continue
            slice_size = 1 if (model_name == "vae" and self.use_vae_slicing) else batch_size
            self.engines[model_name].allocate_buffers(
                shape_dict=obj.get_shape_dict(slice_size, image_height, image_width), device=self.torch_device
            )

    def _vae_decode(self, latents):
        if self.engine_type == EngineType.TORCH:
            if self.pipeline_info.is_xl() and not self.custom_fp16_vae:  # need upcast
                latents = latents.to(dtype=torch.float32)
                images = self.engines["vae"](latents)["sample"]
            else:
                images = self.engines["vae"](latents)["sample"]
        elif self.vae_torch_fallback:
            if not self.custom_fp16_vae:
                latents = latents.to(dtype=torch.float32)
                self.torch_models["vae"] = self.torch_models["vae"].to(dtype=torch.float32)
            images = self.torch_models["vae"](latents)["sample"]
        else:
            if self.pipeline_info.is_xl() and not self.custom_fp16_vae:  # need upcast
                images = self.run_engine("vae", {"latent": latents.to(dtype=torch.float32)})["images"]
            else:
                images = self.run_engine("vae", {"latent": latents})["images"]

        return images

    def vae_decode(self, latents):
        if self.use_vae_slicing:
            # The output tensor points to same buffer. Need clone it to avoid overwritten.
            decoded_slices = [self._vae_decode(z_slice).clone() for z_slice in latents.split(1)]
            return torch.cat(decoded_slices)

        return self._vae_decode(latents)


def get_engine_paths(
    work_dir: str, pipeline_info: PipelineInfo, engine_type: EngineType, framework_model_dir: str | None = None
):
    root_dir = work_dir or "."
    short_name = pipeline_info.short_name()

    # When both ORT_CUDA and ORT_TRT/TRT is used, we shall make sub directory for each engine since
    # ORT_CUDA need fp32 torch model, while ORT_TRT/TRT use fp16 torch model.
    onnx_dir = os.path.join(root_dir, engine_type.name, short_name, "onnx")
    engine_dir = os.path.join(root_dir, engine_type.name, short_name, "engine")
    output_dir = os.path.join(root_dir, engine_type.name, short_name, "output")

    timing_cache = os.path.join(root_dir, engine_type.name, "timing_cache")

    # Shared among ORT_CUDA, ORT_TRT and TRT engines, and need use load_model(..., always_download_fp16=True)
    # So that the shared model is always fp16.
    if framework_model_dir is None:
        framework_model_dir = os.path.join(root_dir, "torch_model")

    return onnx_dir, engine_dir, output_dir, framework_model_dir, timing_cache
