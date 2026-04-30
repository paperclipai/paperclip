# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
# Modified from TensorRT demo diffusion, which has the following license:
#
# SPDX-FileCopyrightText: Copyright (c) 1993-2023 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# --------------------------------------------------------------------------

import os
import pathlib
import random
import time
from typing import Any

import numpy as np
import nvtx
import torch
from cuda import cudart
from diffusion_models import PipelineInfo, get_tokenizer
from diffusion_schedulers import DDIMScheduler, EulerAncestralDiscreteScheduler, LCMScheduler, UniPCMultistepScheduler
from engine_builder import EngineType
from engine_builder_ort_cuda import OrtCudaEngineBuilder
from engine_builder_ort_trt import OrtTensorrtEngineBuilder
from engine_builder_tensorrt import TensorrtEngineBuilder
from engine_builder_torch import TorchEngineBuilder
from PIL import Image


class StableDiffusionPipeline:
    """
    Stable Diffusion pipeline using TensorRT.
    """

    def __init__(
        self,
        pipeline_info: PipelineInfo,
        max_batch_size=16,
        scheduler="DDIM",
        device="cuda",
        output_dir=".",
        verbose=False,
        nvtx_profile=False,
        use_cuda_graph=False,
        framework_model_dir="pytorch_model",
        engine_type: EngineType = EngineType.ORT_CUDA,
    ):
        """
        Initializes the Diffusion pipeline.

        Args:
            pipeline_info (PipelineInfo):
                Version and Type of pipeline.
            max_batch_size (int):
                Maximum batch size for dynamic batch engine.
            scheduler (str):
                The scheduler to guide the denoising process. Must be one of [DDIM, EulerA, UniPC, LCM].
            device (str):
                PyTorch device to run inference. Default: 'cuda'
            output_dir (str):
                Output directory for log files and image artifacts
            verbose (bool):
                Enable verbose logging.
            nvtx_profile (bool):
                Insert NVTX profiling markers.
            use_cuda_graph (bool):
                Use CUDA graph to capture engine execution and then launch inference
            framework_model_dir (str):
                cache directory for framework checkpoints
            engine_type (EngineType)
                backend engine type like ORT_TRT or TRT
        """

        self.pipeline_info = pipeline_info
        self.version = pipeline_info.version

        self.vae_scaling_factor = pipeline_info.vae_scaling_factor()

        self.max_batch_size = max_batch_size

        self.framework_model_dir = framework_model_dir
        self.output_dir = output_dir
        for directory in [self.framework_model_dir, self.output_dir]:
            if not os.path.exists(directory):
                print(f"[I] Create directory: {directory}")
                pathlib.Path(directory).mkdir(parents=True)

        self.device = device
        self.torch_device = torch.device(device, torch.cuda.current_device())
        self.verbose = verbose
        self.nvtx_profile = nvtx_profile

        self.use_cuda_graph = use_cuda_graph

        self.tokenizer = None
        self.tokenizer2 = None

        self.generator = torch.Generator(device="cuda")
        self.actual_steps = None

        self.current_scheduler = None
        self.set_scheduler(scheduler)

        # backend engine
        self.engine_type = engine_type
        if engine_type == EngineType.TRT:
            self.backend = TensorrtEngineBuilder(pipeline_info, max_batch_size, device, use_cuda_graph)
        elif engine_type == EngineType.ORT_TRT:
            self.backend = OrtTensorrtEngineBuilder(pipeline_info, max_batch_size, device, use_cuda_graph)
        elif engine_type == EngineType.ORT_CUDA:
            self.backend = OrtCudaEngineBuilder(pipeline_info, max_batch_size, device, use_cuda_graph)
        elif engine_type == EngineType.TORCH:
            self.backend = TorchEngineBuilder(pipeline_info, max_batch_size, device, use_cuda_graph)
        else:
            raise RuntimeError(f"Backend engine type {engine_type.name} is not supported")

        # Load text tokenizer
        if not self.pipeline_info.is_xl_refiner():
            self.tokenizer = get_tokenizer(self.pipeline_info, self.framework_model_dir, subfolder="tokenizer")

        if self.pipeline_info.is_xl():
            self.tokenizer2 = get_tokenizer(self.pipeline_info, self.framework_model_dir, subfolder="tokenizer_2")

        self.control_image_processor = None
        if self.pipeline_info.is_xl() and self.pipeline_info.controlnet:
            from diffusers.image_processor import VaeImageProcessor  # noqa: PLC0415

            self.control_image_processor = VaeImageProcessor(
                vae_scale_factor=8, do_convert_rgb=True, do_normalize=False
            )

        # Create CUDA events
        self.events = {}
        for stage in ["clip", "denoise", "vae", "vae_encoder", "pil"]:
            for marker in ["start", "stop"]:
                self.events[stage + "-" + marker] = cudart.cudaEventCreate()[1]
        self.markers = {}

    def is_backend_tensorrt(self):
        return self.engine_type == EngineType.TRT

    def set_scheduler(self, scheduler: str):
        if scheduler == self.current_scheduler:
            return

        # Scheduler options
        sched_opts = {"num_train_timesteps": 1000, "beta_start": 0.00085, "beta_end": 0.012}
        if self.version in ("2.0", "2.1"):
            sched_opts["prediction_type"] = "v_prediction"
        else:
            sched_opts["prediction_type"] = "epsilon"

        if scheduler == "DDIM":
            self.scheduler = DDIMScheduler(device=self.device, **sched_opts)
        elif scheduler == "EulerA":
            self.scheduler = EulerAncestralDiscreteScheduler(device=self.device, **sched_opts)
        elif scheduler == "UniPC":
            self.scheduler = UniPCMultistepScheduler(device=self.device, **sched_opts)
        elif scheduler == "LCM":
            self.scheduler = LCMScheduler(device=self.device, **sched_opts)
        else:
            raise ValueError("Scheduler should be either DDIM, EulerA, UniPC or LCM")

        self.current_scheduler = scheduler
        self.denoising_steps = None

    def set_denoising_steps(self, denoising_steps: int):
        if not (self.denoising_steps == denoising_steps and isinstance(self.scheduler, DDIMScheduler)):
            self.scheduler.set_timesteps(denoising_steps)
            self.scheduler.configure()
            self.denoising_steps = denoising_steps

    def load_resources(self, image_height, image_width, batch_size):
        # If engine is built with static input shape, call this only once after engine build.
        # Otherwise, it need be called before every inference run.
        self.backend.load_resources(image_height, image_width, batch_size)

    def set_random_seed(self, seed):
        if isinstance(seed, int):
            self.generator.manual_seed(seed)
        else:
            self.generator.seed()

    def get_current_seed(self):
        return self.generator.initial_seed()

    def teardown(self):
        for e in self.events.values():
            cudart.cudaEventDestroy(e)

        if self.backend:
            self.backend.teardown()

    def run_engine(self, model_name, feed_dict):
        return self.backend.run_engine(model_name, feed_dict)

    def initialize_latents(self, batch_size, unet_channels, latent_height, latent_width):
        latents_dtype = torch.float16
        latents_shape = (batch_size, unet_channels, latent_height, latent_width)
        latents = torch.randn(latents_shape, device=self.device, dtype=latents_dtype, generator=self.generator)
        # Scale the initial noise by the standard deviation required by the scheduler
        latents = latents * self.scheduler.init_noise_sigma
        return latents

    def initialize_timesteps(self, timesteps, strength):
        """Initialize timesteps for refiner."""
        self.scheduler.set_timesteps(timesteps)
        offset = self.scheduler.steps_offset if hasattr(self.scheduler, "steps_offset") else 0
        init_timestep = int(timesteps * strength) + offset
        init_timestep = min(init_timestep, timesteps)
        t_start = max(timesteps - init_timestep + offset, 0)
        timesteps = self.scheduler.timesteps[t_start:].to(self.device)
        return timesteps, t_start

    def initialize_refiner(self, batch_size, image, strength):
        """Add noise to a reference image."""
        # Initialize timesteps
        timesteps, t_start = self.initialize_timesteps(self.denoising_steps, strength)

        latent_timestep = timesteps[:1].repeat(batch_size)

        # Pre-process input image
        image = self.preprocess_images(batch_size, (image,))[0]

        # VAE encode init image
        if image.shape[1] == 4:
            init_latents = image
        else:
            init_latents = self.encode_image(image)

        # Add noise to latents using timesteps
        noise = torch.randn(init_latents.shape, device=self.device, dtype=torch.float16, generator=self.generator)

        latents = self.scheduler.add_noise(init_latents, noise, t_start, latent_timestep)

        return timesteps, t_start, latents

    def _get_add_time_ids(
        self,
        original_size,
        crops_coords_top_left,
        target_size,
        aesthetic_score,
        negative_aesthetic_score,
        dtype,
        requires_aesthetics_score,
    ):
        if requires_aesthetics_score:
            add_time_ids = list(original_size + crops_coords_top_left + (aesthetic_score,))
            add_neg_time_ids = list(original_size + crops_coords_top_left + (negative_aesthetic_score,))
        else:
            add_time_ids = list(original_size + crops_coords_top_left + target_size)
            add_neg_time_ids = list(original_size + crops_coords_top_left + target_size)

        add_time_ids = torch.tensor([add_time_ids], dtype=dtype)
        add_neg_time_ids = torch.tensor([add_neg_time_ids], dtype=dtype)

        return add_time_ids, add_neg_time_ids

    def start_profile(self, name, color="blue"):
        if self.nvtx_profile:
            self.markers[name] = nvtx.start_range(message=name, color=color)
        event_name = name + "-start"
        if event_name in self.events:
            cudart.cudaEventRecord(self.events[event_name], 0)

    def stop_profile(self, name):
        event_name = name + "-stop"
        if event_name in self.events:
            cudart.cudaEventRecord(self.events[event_name], 0)
        if self.nvtx_profile:
            nvtx.end_range(self.markers[name])

    def preprocess_images(self, batch_size, images=()):
        self.start_profile("preprocess", color="pink")
        init_images = []
        for i in images:
            image = i.to(self.device)
            if image.shape[0] != batch_size:
                image = image.repeat(batch_size, 1, 1, 1)
            init_images.append(image)
        self.stop_profile("preprocess")
        return tuple(init_images)

    def preprocess_controlnet_images(
        self, batch_size, images=None, do_classifier_free_guidance=True, height=1024, width=1024
    ):
        """
        Process a list of PIL.Image.Image as control images, and return a torch tensor.
        """
        if images is None:
            return None
        self.start_profile("preprocess", color="pink")

        if not self.pipeline_info.is_xl():
            images = [
                torch.from_numpy(
                    (np.array(image.convert("RGB")).astype(np.float32) / 255.0)[..., None].transpose(3, 2, 0, 1)
                )
                .to(device=self.device, dtype=torch.float16)
                .repeat_interleave(batch_size, dim=0)
                for image in images
            ]
        else:
            images = [
                self.control_image_processor.preprocess(image, height=height, width=width)
                .to(device=self.device, dtype=torch.float16)
                .repeat_interleave(batch_size, dim=0)
                for image in images
            ]

        if do_classifier_free_guidance:
            images = [torch.cat([i] * 2) for i in images]
        images = torch.cat([image[None, ...] for image in images], dim=0)

        self.stop_profile("preprocess")
        return images

    def encode_prompt(
        self,
        prompt,
        negative_prompt,
        encoder="clip",
        tokenizer=None,
        pooled_outputs=False,
        output_hidden_states=False,
        force_zeros_for_empty_prompt=False,
        do_classifier_free_guidance=True,
        dtype=torch.float16,
    ):
        if tokenizer is None:
            tokenizer = self.tokenizer

        self.start_profile("clip", color="green")

        def tokenize(prompt, output_hidden_states):
            text_input_ids = (
                tokenizer(
                    prompt,
                    padding="max_length",
                    max_length=tokenizer.model_max_length,
                    truncation=True,
                    return_tensors="pt",
                )
                .input_ids.type(torch.int32)
                .to(self.device)
            )

            hidden_states = None
            if self.engine_type == EngineType.TORCH:
                outputs = self.backend.engines[encoder](text_input_ids)
                text_embeddings = outputs[0]
                if output_hidden_states:
                    hidden_states = outputs["last_hidden_state"]
            else:
                outputs = self.run_engine(encoder, {"input_ids": text_input_ids})
                text_embeddings = outputs["text_embeddings"]
                if output_hidden_states:
                    hidden_states = outputs["hidden_states"]
            return text_embeddings, hidden_states

        # Tokenize prompt
        text_embeddings, hidden_states = tokenize(prompt, output_hidden_states)

        # NOTE: output tensor for CLIP must be cloned because it will be overwritten when called again for negative prompt
        text_embeddings = text_embeddings.clone()
        if hidden_states is not None:
            hidden_states = hidden_states.clone()

        # Note: negative prompt embedding is not needed for SD XL when guidance <= 1
        if do_classifier_free_guidance:
            # For SD XL base, handle force_zeros_for_empty_prompt
            is_empty_negative_prompt = all(not i for i in negative_prompt)
            if force_zeros_for_empty_prompt and is_empty_negative_prompt:
                uncond_embeddings = torch.zeros_like(text_embeddings)
                if output_hidden_states:
                    uncond_hidden_states = torch.zeros_like(hidden_states)
            else:
                # Tokenize negative prompt
                uncond_embeddings, uncond_hidden_states = tokenize(negative_prompt, output_hidden_states)

            # Concatenate the unconditional and text embeddings into a single batch to avoid doing two forward passes for classifier free guidance
            text_embeddings = torch.cat([uncond_embeddings, text_embeddings])

            if output_hidden_states:
                hidden_states = torch.cat([uncond_hidden_states, hidden_states])

        self.stop_profile("clip")

        if pooled_outputs:
            # For text encoder in sdxl base
            return hidden_states.to(dtype=dtype), text_embeddings.to(dtype=dtype)

        if output_hidden_states:
            # For text encoder 2 in sdxl base or refiner
            return hidden_states.to(dtype=dtype)

        # For text encoder in sd 1.5
        return text_embeddings.to(dtype=dtype)

    def denoise_latent(
        self,
        latents,
        text_embeddings,
        denoiser="unet",
        timesteps=None,
        step_offset=0,
        guidance=7.5,
        add_kwargs=None,
    ):
        do_classifier_free_guidance = guidance > 1.0

        self.start_profile("denoise", color="blue")

        if not isinstance(timesteps, torch.Tensor):
            timesteps = self.scheduler.timesteps

        for step_index, timestep in enumerate(timesteps):
            # Expand the latents if we are doing classifier free guidance
            latent_model_input = torch.cat([latents] * 2) if do_classifier_free_guidance else latents

            latent_model_input = self.scheduler.scale_model_input(
                latent_model_input, step_offset + step_index, timestep
            )

            # Predict the noise residual
            if self.nvtx_profile:
                nvtx_unet = nvtx.start_range(message="unet", color="blue")

            params = {
                "sample": latent_model_input,
                "timestep": timestep.to(latents.dtype),
                "encoder_hidden_states": text_embeddings,
            }

            if add_kwargs:
                params.update(add_kwargs)

            noise_pred = self.run_engine(denoiser, params)["latent"]

            if self.nvtx_profile:
                nvtx.end_range(nvtx_unet)

            # perform guidance
            if do_classifier_free_guidance:
                noise_pred_uncond, noise_pred_text = noise_pred.chunk(2)
                noise_pred = noise_pred_uncond + guidance * (noise_pred_text - noise_pred_uncond)

            if type(self.scheduler) is UniPCMultistepScheduler:
                latents = self.scheduler.step(noise_pred, timestep, latents, return_dict=False)[0]
            elif type(self.scheduler) is LCMScheduler:
                latents = self.scheduler.step(noise_pred, timestep, latents, generator=self.generator)[0]
            else:
                latents = self.scheduler.step(noise_pred, latents, step_offset + step_index, timestep)

        # The actual number of steps. It might be different from denoising_steps.
        self.actual_steps = len(timesteps)

        self.stop_profile("denoise")
        return latents

    def encode_image(self, image):
        self.start_profile("vae_encoder", color="red")
        init_latents = self.run_engine("vae_encoder", {"images": image})["latent"]
        init_latents = self.vae_scaling_factor * init_latents
        self.stop_profile("vae_encoder")
        return init_latents

    def decode_latent(self, latents):
        self.start_profile("vae", color="red")
        images = self.backend.vae_decode(latents)
        self.stop_profile("vae")
        return images

    def print_summary(self, tic, toc, batch_size, vae_enc=False, pil=False) -> dict[str, Any]:
        throughput = batch_size / (toc - tic)
        latency_clip = cudart.cudaEventElapsedTime(self.events["clip-start"], self.events["clip-stop"])[1]
        latency_unet = cudart.cudaEventElapsedTime(self.events["denoise-start"], self.events["denoise-stop"])[1]
        latency_vae = cudart.cudaEventElapsedTime(self.events["vae-start"], self.events["vae-stop"])[1]
        latency_vae_encoder = (
            cudart.cudaEventElapsedTime(self.events["vae_encoder-start"], self.events["vae_encoder-stop"])[1]
            if vae_enc
            else None
        )
        latency_pil = cudart.cudaEventElapsedTime(self.events["pil-start"], self.events["pil-stop"])[1] if pil else None

        latency = (toc - tic) * 1000.0

        print("|----------------|--------------|")
        print("| {:^14} | {:^12} |".format("Module", "Latency"))
        print("|----------------|--------------|")
        if vae_enc:
            print("| {:^14} | {:>9.2f} ms |".format("VAE-Enc", latency_vae_encoder))
        print("| {:^14} | {:>9.2f} ms |".format("CLIP", latency_clip))
        print(
            "| {:^14} | {:>9.2f} ms |".format(
                "UNet" + ("+CNet" if self.pipeline_info.controlnet else "") + " x " + str(self.actual_steps),
                latency_unet,
            )
        )
        print("| {:^14} | {:>9.2f} ms |".format("VAE-Dec", latency_vae))
        pipeline = "Refiner" if self.pipeline_info.is_xl_refiner() else "Pipeline"
        if pil:
            print("| {:^14} | {:>9.2f} ms |".format("PIL", latency_pil))
        print("|----------------|--------------|")
        print(f"| {pipeline:^14} | {latency:>9.2f} ms |")
        print("|----------------|--------------|")
        print(f"Throughput: {throughput:.2f} image/s")

        perf_data = {
            "latency_clip": latency_clip,
            "latency_unet": latency_unet,
            "latency_vae": latency_vae,
            "latency_pil": latency_pil,
            "latency": latency,
            "throughput": throughput,
        }
        if vae_enc:
            perf_data["latency_vae_encoder"] = latency_vae_encoder
        return perf_data

    @staticmethod
    def pt_to_pil(images):
        images = (
            ((images + 1) * 255 / 2).clamp(0, 255).detach().permute(0, 2, 3, 1).round().type(torch.uint8).cpu().numpy()
        )
        return [Image.fromarray(images[i]) for i in range(images.shape[0])]

    @staticmethod
    def pt_to_numpy(images: torch.FloatTensor):
        """
        Convert a PyTorch tensor to a NumPy image.
        """
        return ((images + 1) / 2).clamp(0, 1).detach().permute(0, 2, 3, 1).float().cpu().numpy()

    def metadata(self) -> dict[str, Any]:
        data = {
            "actual_steps": self.actual_steps,
            "seed": self.get_current_seed(),
            "name": self.pipeline_info.name(),
            "custom_vae": self.pipeline_info.custom_fp16_vae(),
            "custom_unet": self.pipeline_info.custom_unet(),
        }

        if self.engine_type == EngineType.ORT_CUDA:
            for engine_name, engine in self.backend.engines.items():
                data.update(engine.metadata(engine_name))

        return data

    def save_images(self, images: list, prompt: list[str], negative_prompt: list[str], metadata: dict[str, Any]):
        session_id = str(random.randint(1000, 9999))
        for i, image in enumerate(images):
            seed = str(self.get_current_seed())
            prefix = "".join(x for x in prompt[i] if x.isalnum() or x in ", -").replace(" ", "_")[:20]
            parts = [prefix, session_id, str(i + 1), str(seed), self.current_scheduler, str(self.actual_steps)]
            image_path = os.path.join(self.output_dir, "-".join(parts) + ".png")
            print(f"Saving image {i + 1} / {len(images)} to: {image_path}")

            from PIL import PngImagePlugin  # noqa: PLC0415

            info = PngImagePlugin.PngInfo()
            for k, v in metadata.items():
                info.add_text(k, str(v))
            info.add_text("prompt", prompt[i])
            info.add_text("negative_prompt", negative_prompt[i])

            image.save(image_path, "PNG", pnginfo=info)

    def _infer(
        self,
        prompt,
        negative_prompt,
        image_height,
        image_width,
        denoising_steps=30,
        guidance=5.0,
        seed=None,
        image=None,
        strength=0.3,
        controlnet_images=None,
        controlnet_scales=None,
        show_latency=False,
        output_type="pil",
    ):
        if show_latency:
            torch.cuda.synchronize()
            start_time = time.perf_counter()

        assert len(prompt) == len(negative_prompt)
        batch_size = len(prompt)

        self.set_denoising_steps(denoising_steps)
        self.set_random_seed(seed)

        timesteps = None
        step_offset = 0
        with torch.inference_mode(), torch.autocast("cuda"):
            if image is not None:
                timesteps, step_offset, latents = self.initialize_refiner(
                    batch_size=batch_size,
                    image=image,
                    strength=strength,
                )
            else:
                # Pre-initialize latents
                latents = self.initialize_latents(
                    batch_size=batch_size,
                    unet_channels=4,
                    latent_height=(image_height // 8),
                    latent_width=(image_width // 8),
                )

            do_classifier_free_guidance = guidance > 1.0
            if not self.pipeline_info.is_xl():
                denoiser = "unet"
                text_embeddings = self.encode_prompt(
                    prompt,
                    negative_prompt,
                    do_classifier_free_guidance=do_classifier_free_guidance,
                    dtype=latents.dtype,
                )
                add_kwargs = {}
            else:
                denoiser = "unetxl"

                # Time embeddings
                original_size = (image_height, image_width)
                crops_coords_top_left = (0, 0)
                target_size = (image_height, image_width)
                aesthetic_score = 6.0
                negative_aesthetic_score = 2.5
                add_time_ids, add_negative_time_ids = self._get_add_time_ids(
                    original_size,
                    crops_coords_top_left,
                    target_size,
                    aesthetic_score,
                    negative_aesthetic_score,
                    dtype=latents.dtype,
                    requires_aesthetics_score=self.pipeline_info.is_xl_refiner(),
                )
                if do_classifier_free_guidance:
                    add_time_ids = torch.cat([add_negative_time_ids, add_time_ids], dim=0)
                add_time_ids = add_time_ids.to(device=self.device).repeat(batch_size, 1)

                if self.pipeline_info.is_xl_refiner():
                    # CLIP text encoder 2
                    text_embeddings, pooled_embeddings2 = self.encode_prompt(
                        prompt,
                        negative_prompt,
                        encoder="clip2",
                        tokenizer=self.tokenizer2,
                        pooled_outputs=True,
                        output_hidden_states=True,
                        dtype=latents.dtype,
                    )
                    add_kwargs = {"text_embeds": pooled_embeddings2, "time_ids": add_time_ids}
                else:  # XL Base
                    # CLIP text encoder
                    text_embeddings = self.encode_prompt(
                        prompt,
                        negative_prompt,
                        encoder="clip",
                        tokenizer=self.tokenizer,
                        output_hidden_states=True,
                        force_zeros_for_empty_prompt=True,
                        do_classifier_free_guidance=do_classifier_free_guidance,
                        dtype=latents.dtype,
                    )
                    # CLIP text encoder 2
                    text_embeddings2, pooled_embeddings2 = self.encode_prompt(
                        prompt,
                        negative_prompt,
                        encoder="clip2",
                        tokenizer=self.tokenizer2,
                        pooled_outputs=True,
                        output_hidden_states=True,
                        force_zeros_for_empty_prompt=True,
                        do_classifier_free_guidance=do_classifier_free_guidance,
                        dtype=latents.dtype,
                    )

                    # Merged text embeddings
                    text_embeddings = torch.cat([text_embeddings, text_embeddings2], dim=-1)

                    add_kwargs = {"text_embeds": pooled_embeddings2, "time_ids": add_time_ids}

            if self.pipeline_info.controlnet:
                controlnet_images = self.preprocess_controlnet_images(
                    latents.shape[0],
                    controlnet_images,
                    do_classifier_free_guidance=do_classifier_free_guidance,
                    height=image_height,
                    width=image_width,
                )
                add_kwargs.update(
                    {
                        "controlnet_images": controlnet_images,
                        "controlnet_scales": controlnet_scales.to(controlnet_images.dtype).to(controlnet_images.device),
                    }
                )

            # UNet denoiser
            latents = self.denoise_latent(
                latents,
                text_embeddings,
                timesteps=timesteps,
                step_offset=step_offset,
                denoiser=denoiser,
                guidance=guidance,
                add_kwargs=add_kwargs,
            )

        with torch.inference_mode():
            # VAE decode latent
            if output_type == "latent":
                images = latents
            else:
                images = self.decode_latent(latents / self.vae_scaling_factor)
                if output_type == "pil":
                    self.start_profile("pil", color="green")
                    images = self.pt_to_pil(images)
                    self.stop_profile("pil")

        perf_data = None
        if show_latency:
            torch.cuda.synchronize()
            end_time = time.perf_counter()
            perf_data = self.print_summary(
                start_time, end_time, batch_size, vae_enc=self.pipeline_info.is_xl_refiner(), pil=(output_type == "pil")
            )

        return images, perf_data

    def run(
        self,
        prompt: list[str],
        negative_prompt: list[str],
        image_height: int,
        image_width: int,
        denoising_steps: int = 30,
        guidance: float = 5.0,
        seed: int | None = None,
        image: torch.Tensor | None = None,
        strength: float = 0.3,
        controlnet_images: torch.Tensor | None = None,
        controlnet_scales: torch.Tensor | None = None,
        show_latency: bool = False,
        output_type: str = "pil",
        deterministic: bool = False,
    ):
        """
        Run the diffusion pipeline.

        Args:
            prompt (List[str]):
                The text prompt to guide image generation.
            negative_prompt (List[str]):
                The prompt not to guide the image generation.
            image_height (int):
                Height (in pixels) of the image to be generated. Must be a multiple of 8.
            image_width (int):
                Width (in pixels) of the image to be generated. Must be a multiple of 8.
            denoising_steps (int):
                Number of denoising steps. More steps usually lead to higher quality image at the expense of slower inference.
            guidance (float):
                Higher guidance scale encourages to generate images that are closely linked to the text prompt.
            seed (int):
                Seed for the random generator
            image (tuple[torch.Tensor]):
                Reference image.
            strength (float):
                Indicates extent to transform the reference image, which is used as a starting point,
                and more noise is added the higher the strength.
            show_latency (bool):
                Whether return latency data.
            output_type (str):
                It can be "latent", "pt" or "pil".
        """
        if deterministic:
            torch.use_deterministic_algorithms(True)

        if self.is_backend_tensorrt():
            import tensorrt as trt  # noqa: PLC0415
            from trt_utilities import TRT_LOGGER  # noqa: PLC0415

            with trt.Runtime(TRT_LOGGER):
                return self._infer(
                    prompt,
                    negative_prompt,
                    image_height,
                    image_width,
                    denoising_steps=denoising_steps,
                    guidance=guidance,
                    seed=seed,
                    image=image,
                    strength=strength,
                    controlnet_images=controlnet_images,
                    controlnet_scales=controlnet_scales,
                    show_latency=show_latency,
                    output_type=output_type,
                )
        else:
            return self._infer(
                prompt,
                negative_prompt,
                image_height,
                image_width,
                denoising_steps=denoising_steps,
                guidance=guidance,
                seed=seed,
                image=image,
                strength=strength,
                controlnet_images=controlnet_images,
                controlnet_scales=controlnet_scales,
                show_latency=show_latency,
                output_type=output_type,
            )
