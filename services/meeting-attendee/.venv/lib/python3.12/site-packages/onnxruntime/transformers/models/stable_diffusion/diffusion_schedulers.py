# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
# Modified from utilities.py of TensorRT demo diffusion, which has the following license:
#
# Copyright 2022 The HuggingFace Inc. team.
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


import numpy as np
import torch


class DDIMScheduler:
    def __init__(
        self,
        device="cuda",
        num_train_timesteps: int = 1000,
        beta_start: float = 0.0001,
        beta_end: float = 0.02,
        clip_sample: bool = False,
        set_alpha_to_one: bool = False,
        steps_offset: int = 1,
        prediction_type: str = "epsilon",
        timestep_spacing: str = "leading",
    ):
        # this schedule is very specific to the latent diffusion model.
        betas = torch.linspace(beta_start**0.5, beta_end**0.5, num_train_timesteps, dtype=torch.float32) ** 2

        alphas = 1.0 - betas
        self.alphas_cumprod = torch.cumprod(alphas, dim=0)
        # standard deviation of the initial noise distribution
        self.init_noise_sigma = 1.0

        # At every step in ddim, we are looking into the previous alphas_cumprod
        # For the final step, there is no previous alphas_cumprod because we are already at 0
        # `set_alpha_to_one` decides whether we set this parameter simply to one or
        # whether we use the final alpha of the "non-previous" one.
        self.final_alpha_cumprod = torch.tensor(1.0) if set_alpha_to_one else self.alphas_cumprod[0]

        # setable values
        self.num_inference_steps = None
        self.timesteps = torch.from_numpy(np.arange(0, num_train_timesteps)[::-1].copy().astype(np.int64))
        self.steps_offset = steps_offset
        self.num_train_timesteps = num_train_timesteps
        self.clip_sample = clip_sample
        self.prediction_type = prediction_type
        self.device = device
        self.timestep_spacing = timestep_spacing

    def configure(self):
        variance = np.zeros(self.num_inference_steps, dtype=np.float32)
        for idx, timestep in enumerate(self.timesteps):
            prev_timestep = timestep - self.num_train_timesteps // self.num_inference_steps
            variance[idx] = self._get_variance(timestep, prev_timestep)
        self.variance = torch.from_numpy(variance).to(self.device)

        timesteps = self.timesteps.long().cpu()
        self.filtered_alphas_cumprod = self.alphas_cumprod[timesteps].to(self.device)
        self.final_alpha_cumprod = self.final_alpha_cumprod.to(self.device)

    def scale_model_input(self, sample: torch.FloatTensor, idx, *args, **kwargs) -> torch.FloatTensor:
        return sample

    def _get_variance(self, timestep, prev_timestep):
        alpha_prod_t = self.alphas_cumprod[timestep]
        alpha_prod_t_prev = self.alphas_cumprod[prev_timestep] if prev_timestep >= 0 else self.final_alpha_cumprod
        beta_prod_t = 1 - alpha_prod_t
        beta_prod_t_prev = 1 - alpha_prod_t_prev

        variance = (beta_prod_t_prev / beta_prod_t) * (1 - alpha_prod_t / alpha_prod_t_prev)

        return variance

    def set_timesteps(self, num_inference_steps: int):
        self.num_inference_steps = num_inference_steps
        if self.timestep_spacing == "leading":
            step_ratio = self.num_train_timesteps // self.num_inference_steps
            # creates integer timesteps by multiplying by ratio
            # casting to int to avoid issues when num_inference_step is power of 3
            timesteps = (np.arange(0, num_inference_steps) * step_ratio).round()[::-1].copy().astype(np.int64)
            timesteps += self.steps_offset
        elif self.timestep_spacing == "trailing":
            step_ratio = self.num_train_timesteps / self.num_inference_steps
            # creates integer timesteps by multiplying by ratio
            # casting to int to avoid issues when num_inference_step is power of 3
            timesteps = np.round(np.arange(self.num_train_timesteps, 0, -step_ratio)).astype(np.int64)
            timesteps -= 1
        else:
            raise ValueError(
                f"{self.timestep_spacing} is not supported. Please make sure to choose one of 'linspace', 'leading' or 'trailing'."
            )

        self.timesteps = torch.from_numpy(timesteps).to(self.device)

    def step(
        self,
        model_output,
        sample,
        idx,
        timestep,
        eta: float = 0.0,
        use_clipped_model_output: bool = False,
        generator=None,
        variance_noise: torch.FloatTensor = None,
    ):
        if self.num_inference_steps is None:
            raise ValueError(
                "Number of inference steps is 'None', you need to run 'set_timesteps' after creating the scheduler"
            )

        # See formulas (12) and (16) of DDIM paper https://arxiv.org/pdf/2010.02502.pdf
        # Ideally, read DDIM paper in-detail understanding

        # Notation (<variable name> -> <name in paper>
        # - pred_noise_t -> e_theta(x_t, t)
        # - pred_original_sample -> f_theta(x_t, t) or x_0
        # - std_dev_t -> sigma_t
        # - eta -> η
        # - pred_sample_direction -> "direction pointing to x_t"
        # - pred_prev_sample -> "x_t-1"

        prev_idx = idx + 1
        alpha_prod_t = self.filtered_alphas_cumprod[idx]
        alpha_prod_t_prev = (
            self.filtered_alphas_cumprod[prev_idx] if prev_idx < self.num_inference_steps else self.final_alpha_cumprod
        )

        beta_prod_t = 1 - alpha_prod_t

        # 3. compute predicted original sample from predicted noise also called
        # "predicted x_0" of formula (12) from https://arxiv.org/pdf/2010.02502.pdf
        if self.prediction_type == "epsilon":
            pred_original_sample = (sample - beta_prod_t ** (0.5) * model_output) / alpha_prod_t ** (0.5)
        elif self.prediction_type == "sample":
            pred_original_sample = model_output
        elif self.prediction_type == "v_prediction":
            pred_original_sample = (alpha_prod_t**0.5) * sample - (beta_prod_t**0.5) * model_output
            # predict V
            model_output = (alpha_prod_t**0.5) * model_output + (beta_prod_t**0.5) * sample
        else:
            raise ValueError(
                f"prediction_type given as {self.prediction_type} must be one of `epsilon`, `sample`, or `v_prediction`"
            )

        # 4. Clip "predicted x_0"
        if self.clip_sample:
            pred_original_sample = torch.clamp(pred_original_sample, -1, 1)

        # 5. compute variance: "sigma_t(η)" -> see formula (16)
        # o_t = sqrt((1 - a_t-1)/(1 - a_t)) * sqrt(1 - a_t/a_t-1)
        variance = self.variance[idx]
        std_dev_t = eta * variance ** (0.5)

        if use_clipped_model_output:
            # the model_output is always re-derived from the clipped x_0 in Glide
            model_output = (sample - alpha_prod_t ** (0.5) * pred_original_sample) / beta_prod_t ** (0.5)

        # 6. compute "direction pointing to x_t" of formula (12) from https://arxiv.org/pdf/2010.02502.pdf
        pred_sample_direction = (1 - alpha_prod_t_prev - std_dev_t**2) ** (0.5) * model_output

        # 7. compute x_t without "random noise" of formula (12) from https://arxiv.org/pdf/2010.02502.pdf
        prev_sample = alpha_prod_t_prev ** (0.5) * pred_original_sample + pred_sample_direction

        if eta > 0:
            # randn_like does not support generator https://github.com/pytorch/pytorch/issues/27072
            device = model_output.device
            if variance_noise is not None and generator is not None:
                raise ValueError(
                    "Cannot pass both generator and variance_noise. Please make sure that either `generator` or"
                    " `variance_noise` stays `None`."
                )

            if variance_noise is None:
                variance_noise = torch.randn(
                    model_output.shape, generator=generator, device=device, dtype=model_output.dtype
                )
            variance = std_dev_t * variance_noise

            prev_sample = prev_sample + variance

        return prev_sample

    def add_noise(self, init_latents, noise, idx, latent_timestep):
        sqrt_alpha_prod = self.filtered_alphas_cumprod[idx] ** 0.5
        sqrt_one_minus_alpha_prod = (1 - self.filtered_alphas_cumprod[idx]) ** 0.5
        noisy_latents = sqrt_alpha_prod * init_latents + sqrt_one_minus_alpha_prod * noise

        return noisy_latents


class EulerAncestralDiscreteScheduler:
    def __init__(
        self,
        num_train_timesteps: int = 1000,
        beta_start: float = 0.0001,
        beta_end: float = 0.02,
        device="cuda",
        steps_offset: int = 1,
        prediction_type: str = "epsilon",
        timestep_spacing: str = "trailing",  # set default to trailing for SDXL Turbo
    ):
        betas = torch.linspace(beta_start**0.5, beta_end**0.5, num_train_timesteps, dtype=torch.float32) ** 2
        alphas = 1.0 - betas
        self.alphas_cumprod = torch.cumprod(alphas, dim=0)

        sigmas = np.array(((1 - self.alphas_cumprod) / self.alphas_cumprod) ** 0.5)
        sigmas = np.concatenate([sigmas[::-1], [0.0]]).astype(np.float32)
        self.sigmas = torch.from_numpy(sigmas)

        # standard deviation of the initial noise distribution
        self.init_noise_sigma = self.sigmas.max()

        # setable values
        self.num_inference_steps = None
        timesteps = np.linspace(0, num_train_timesteps - 1, num_train_timesteps, dtype=float)[::-1].copy()
        self.timesteps = torch.from_numpy(timesteps)
        self.is_scale_input_called = False

        self._step_index = None

        self.device = device
        self.num_train_timesteps = num_train_timesteps
        self.steps_offset = steps_offset
        self.prediction_type = prediction_type
        self.timestep_spacing = timestep_spacing

    # Copied from diffusers.schedulers.scheduling_euler_discrete.EulerDiscreteScheduler._init_step_index
    def _init_step_index(self, timestep):
        if isinstance(timestep, torch.Tensor):
            timestep = timestep.to(self.timesteps.device)

        index_candidates = (self.timesteps == timestep).nonzero()

        # The sigma index that is taken for the **very** first `step`
        # is always the second index (or the last index if there is only 1)
        # This way we can ensure we don't accidentally skip a sigma in
        # case we start in the middle of the denoising schedule (e.g. for image-to-image)
        if len(index_candidates) > 1:
            step_index = index_candidates[1]
        else:
            step_index = index_candidates[0]

        self._step_index = step_index.item()

    def scale_model_input(self, sample: torch.FloatTensor, idx, timestep, *args, **kwargs) -> torch.FloatTensor:
        if self._step_index is None:
            self._init_step_index(timestep)

        sigma = self.sigmas[self._step_index]
        sample = sample / ((sigma**2 + 1) ** 0.5)
        self.is_scale_input_called = True
        return sample

    def set_timesteps(self, num_inference_steps: int):
        self.num_inference_steps = num_inference_steps

        if self.timestep_spacing == "linspace":
            timesteps = np.linspace(0, self.num_train_timesteps - 1, num_inference_steps, dtype=np.float32)[::-1].copy()
        elif self.timestep_spacing == "leading":
            step_ratio = self.num_train_timesteps // self.num_inference_steps
            # creates integer timesteps by multiplying by ratio
            # casting to int to avoid issues when num_inference_step is power of 3
            timesteps = (np.arange(0, num_inference_steps) * step_ratio).round()[::-1].copy().astype(np.float32)
            timesteps += self.steps_offset
        elif self.timestep_spacing == "trailing":
            step_ratio = self.num_train_timesteps / self.num_inference_steps
            # creates integer timesteps by multiplying by ratio
            # casting to int to avoid issues when num_inference_step is power of 3
            timesteps = (np.arange(self.num_train_timesteps, 0, -step_ratio)).round().copy().astype(np.float32)
            timesteps -= 1
        else:
            raise ValueError(
                f"{self.timestep_spacing} is not supported. Please make sure to choose one of 'linspace', 'leading' or 'trailing'."
            )

        sigmas = np.array(((1 - self.alphas_cumprod) / self.alphas_cumprod) ** 0.5)
        sigmas = np.interp(timesteps, np.arange(0, len(sigmas)), sigmas)
        sigmas = np.concatenate([sigmas, [0.0]]).astype(np.float32)
        self.sigmas = torch.from_numpy(sigmas).to(device=self.device)
        self.timesteps = torch.from_numpy(timesteps).to(device=self.device)

        self._step_index = None

    def configure(self):
        dts = np.zeros(self.num_inference_steps, dtype=np.float32)
        sigmas_up = np.zeros(self.num_inference_steps, dtype=np.float32)
        for idx, timestep in enumerate(self.timesteps):
            step_index = (self.timesteps == timestep).nonzero().item()
            sigma = self.sigmas[step_index]

            sigma_from = self.sigmas[step_index]
            sigma_to = self.sigmas[step_index + 1]
            sigma_up = (sigma_to**2 * (sigma_from**2 - sigma_to**2) / sigma_from**2) ** 0.5
            sigma_down = (sigma_to**2 - sigma_up**2) ** 0.5
            dt = sigma_down - sigma
            dts[idx] = dt
            sigmas_up[idx] = sigma_up

        self.dts = torch.from_numpy(dts).to(self.device)
        self.sigmas_up = torch.from_numpy(sigmas_up).to(self.device)

    def step(
        self,
        model_output,
        sample,
        idx,
        timestep,
        generator=None,
    ):
        if self._step_index is None:
            self._init_step_index(timestep)
        sigma = self.sigmas[self._step_index]

        # 1. compute predicted original sample (x_0) from sigma-scaled predicted noise
        if self.prediction_type == "epsilon":
            pred_original_sample = sample - sigma * model_output
        elif self.prediction_type == "v_prediction":
            # * c_out + input * c_skip
            pred_original_sample = model_output * (-sigma / (sigma**2 + 1) ** 0.5) + (sample / (sigma**2 + 1))
        else:
            raise ValueError(
                f"prediction_type given as {self.prediction_type} must be one of `epsilon`, or `v_prediction`"
            )

        sigma_from = self.sigmas[self._step_index]
        sigma_to = self.sigmas[self._step_index + 1]
        sigma_up = (sigma_to**2 * (sigma_from**2 - sigma_to**2) / sigma_from**2) ** 0.5
        sigma_down = (sigma_to**2 - sigma_up**2) ** 0.5

        # 2. Convert to an ODE derivative
        derivative = (sample - pred_original_sample) / sigma

        dt = sigma_down - sigma

        prev_sample = sample + derivative * dt

        device = model_output.device
        noise = torch.randn(model_output.shape, dtype=model_output.dtype, device=device, generator=generator).to(device)

        prev_sample = prev_sample + noise * sigma_up

        # upon completion increase step index by one
        self._step_index += 1

        return prev_sample

    def add_noise(self, original_samples, noise, idx, timestep=None):
        sigmas = self.sigmas.to(device=original_samples.device, dtype=original_samples.dtype)
        schedule_timesteps = self.timesteps.to(original_samples.device)
        timesteps = timestep.to(original_samples.device)

        step_indices = [(schedule_timesteps == t).nonzero().item() for t in timesteps]

        sigma = sigmas[step_indices].flatten()
        while len(sigma.shape) < len(original_samples.shape):
            sigma = sigma.unsqueeze(-1)

        noisy_samples = original_samples + noise * sigma
        return noisy_samples


class UniPCMultistepScheduler:
    def __init__(
        self,
        device="cuda",
        num_train_timesteps: int = 1000,
        beta_start: float = 0.00085,
        beta_end: float = 0.012,
        solver_order: int = 2,
        prediction_type: str = "epsilon",
        thresholding: bool = False,
        dynamic_thresholding_ratio: float = 0.995,
        sample_max_value: float = 1.0,
        predict_x0: bool = True,
        solver_type: str = "bh2",
        lower_order_final: bool = True,
        disable_corrector: list[int] | None = None,
        use_karras_sigmas: bool | None = False,
        timestep_spacing: str = "linspace",
        steps_offset: int = 0,
        sigma_min=None,
        sigma_max=None,
    ):
        self.device = device
        self.betas = torch.linspace(beta_start**0.5, beta_end**0.5, num_train_timesteps, dtype=torch.float32) ** 2

        self.alphas = 1.0 - self.betas
        self.alphas_cumprod = torch.cumprod(self.alphas, dim=0)
        # Currently we only support VP-type noise schedule
        self.alpha_t = torch.sqrt(self.alphas_cumprod)
        self.sigma_t = torch.sqrt(1 - self.alphas_cumprod)
        self.lambda_t = torch.log(self.alpha_t) - torch.log(self.sigma_t)

        # standard deviation of the initial noise distribution
        self.init_noise_sigma = 1.0

        self.predict_x0 = predict_x0
        # setable values
        self.num_inference_steps = None
        timesteps = np.linspace(0, num_train_timesteps - 1, num_train_timesteps, dtype=np.float32)[::-1].copy()
        self.timesteps = torch.from_numpy(timesteps)
        self.model_outputs = [None] * solver_order
        self.timestep_list = [None] * solver_order
        self.lower_order_nums = 0
        self.disable_corrector = disable_corrector if disable_corrector else []
        self.last_sample = None

        self._step_index = None

        self.num_train_timesteps = num_train_timesteps
        self.solver_order = solver_order
        self.prediction_type = prediction_type
        self.thresholding = thresholding
        self.dynamic_thresholding_ratio = dynamic_thresholding_ratio
        self.sample_max_value = sample_max_value
        self.solver_type = solver_type
        self.lower_order_final = lower_order_final
        self.use_karras_sigmas = use_karras_sigmas
        self.timestep_spacing = timestep_spacing
        self.steps_offset = steps_offset
        self.sigma_min = sigma_min
        self.sigma_max = sigma_max

    @property
    def step_index(self):
        """
        The index counter for current timestep. It will increase 1 after each scheduler step.
        """
        return self._step_index

    def set_timesteps(self, num_inference_steps: int):
        if self.timestep_spacing == "linspace":
            timesteps = (
                np.linspace(0, self.num_train_timesteps - 1, num_inference_steps + 1)
                .round()[::-1][:-1]
                .copy()
                .astype(np.int64)
            )
        elif self.timestep_spacing == "leading":
            step_ratio = self.num_train_timesteps // (num_inference_steps + 1)
            # creates integer timesteps by multiplying by ratio
            # casting to int to avoid issues when num_inference_step is power of 3
            timesteps = (np.arange(0, num_inference_steps + 1) * step_ratio).round()[::-1][:-1].copy().astype(np.int64)
            timesteps += self.steps_offset
        elif self.timestep_spacing == "trailing":
            step_ratio = self.num_train_timesteps / num_inference_steps
            # creates integer timesteps by multiplying by ratio
            # casting to int to avoid issues when num_inference_step is power of 3
            timesteps = np.arange(self.num_train_timesteps, 0, -step_ratio).round().copy().astype(np.int64)
            timesteps -= 1
        else:
            raise ValueError(
                f"{self.timestep_spacing} is not supported. Please make sure to choose one of 'linspace', 'leading' or 'trailing'."
            )

        sigmas = np.array(((1 - self.alphas_cumprod) / self.alphas_cumprod) ** 0.5)
        if self.use_karras_sigmas:
            log_sigmas = np.log(sigmas)
            sigmas = np.flip(sigmas).copy()
            sigmas = self._convert_to_karras(in_sigmas=sigmas, num_inference_steps=num_inference_steps)
            timesteps = np.array([self._sigma_to_t(sigma, log_sigmas) for sigma in sigmas]).round()
            sigmas = np.concatenate([sigmas, sigmas[-1:]]).astype(np.float32)
        else:
            sigmas = np.interp(timesteps, np.arange(0, len(sigmas)), sigmas)
            sigma_last = ((1 - self.alphas_cumprod[0]) / self.alphas_cumprod[0]) ** 0.5
            sigmas = np.concatenate([sigmas, [sigma_last]]).astype(np.float32)

        self.sigmas = torch.from_numpy(sigmas)
        self.timesteps = torch.from_numpy(timesteps).to(device=self.device, dtype=torch.int64)

        self.num_inference_steps = len(timesteps)

        self.model_outputs = [
            None,
        ] * self.solver_order
        self.lower_order_nums = 0
        self.last_sample = None

        # add an index counter for schedulers that allow duplicated timesteps
        self._step_index = None

    # Copied from diffusers.schedulers.scheduling_ddpm.DDPMScheduler._threshold_sample
    def _threshold_sample(self, sample: torch.FloatTensor) -> torch.FloatTensor:
        dtype = sample.dtype
        batch_size, channels, *remaining_dims = sample.shape

        if dtype not in (torch.float32, torch.float64):
            sample = sample.float()  # upcast for quantile calculation, and clamp not implemented for cpu half

        # Flatten sample for doing quantile calculation along each image
        sample = sample.reshape(batch_size, channels * np.prod(remaining_dims))

        abs_sample = sample.abs()  # "a certain percentile absolute pixel value"

        s = torch.quantile(abs_sample, self.dynamic_thresholding_ratio, dim=1)
        s = torch.clamp(
            s, min=1, max=self.sample_max_value
        )  # When clamped to min=1, equivalent to standard clipping to [-1, 1]
        s = s.unsqueeze(1)  # (batch_size, 1) because clamp will broadcast along dim=0
        sample = torch.clamp(sample, -s, s) / s  # "we threshold xt0 to the range [-s, s] and then divide by s"

        sample = sample.reshape(batch_size, channels, *remaining_dims)
        sample = sample.to(dtype)

        return sample

    # Copied from diffusers.schedulers.scheduling_euler_discrete.EulerDiscreteScheduler._sigma_to_t
    def _sigma_to_t(self, sigma, log_sigmas):
        # get log sigma
        log_sigma = np.log(np.maximum(sigma, 1e-10))

        # get distribution
        dists = log_sigma - log_sigmas[:, np.newaxis]

        # get sigmas range
        low_idx = np.cumsum((dists >= 0), axis=0).argmax(axis=0).clip(max=log_sigmas.shape[0] - 2)
        high_idx = low_idx + 1

        low = log_sigmas[low_idx]
        high = log_sigmas[high_idx]

        # interpolate sigmas
        w = (low - log_sigma) / (low - high)
        w = np.clip(w, 0, 1)

        # transform interpolation to time range
        t = (1 - w) * low_idx + w * high_idx
        t = t.reshape(sigma.shape)
        return t

    # Copied from diffusers.schedulers.scheduling_dpmsolver_multistep.DPMSolverMultistepScheduler._sigma_to_alpha_sigma_t
    def _sigma_to_alpha_sigma_t(self, sigma):
        alpha_t = 1 / ((sigma**2 + 1) ** 0.5)
        sigma_t = sigma * alpha_t

        return alpha_t, sigma_t

    # Copied from diffusers.schedulers.scheduling_euler_discrete.EulerDiscreteScheduler._convert_to_karras
    def _convert_to_karras(self, in_sigmas: torch.FloatTensor, num_inference_steps) -> torch.FloatTensor:
        """Constructs the noise schedule of Karras et al. (2022)."""

        sigma_min = self.sigma_min
        sigma_max = self.sigma_max

        sigma_min = sigma_min if sigma_min is not None else in_sigmas[-1].item()
        sigma_max = sigma_max if sigma_max is not None else in_sigmas[0].item()

        rho = 7.0  # 7.0 is the value used in the paper
        ramp = np.linspace(0, 1, num_inference_steps)
        min_inv_rho = sigma_min ** (1 / rho)
        max_inv_rho = sigma_max ** (1 / rho)
        sigmas = (max_inv_rho + ramp * (min_inv_rho - max_inv_rho)) ** rho
        return sigmas

    def convert_model_output(
        self,
        model_output: torch.FloatTensor,
        *args,
        sample: torch.FloatTensor = None,
        **kwargs,
    ) -> torch.FloatTensor:
        timestep = args[0] if len(args) > 0 else kwargs.pop("timestep", None)
        if sample is None:
            if len(args) > 1:
                sample = args[1]
            else:
                raise ValueError("missing `sample` as a required keyword argument")
        if timestep is not None:
            print(
                "Passing `timesteps` is deprecated and has no effect as model output conversion is now handled via an internal counter `self.step_index`",
            )

        sigma = self.sigmas[self.step_index]
        alpha_t, sigma_t = self._sigma_to_alpha_sigma_t(sigma)

        if self.predict_x0:
            if self.prediction_type == "epsilon":
                x0_pred = (sample - sigma_t * model_output) / alpha_t
            elif self.prediction_type == "sample":
                x0_pred = model_output
            elif self.prediction_type == "v_prediction":
                x0_pred = alpha_t * sample - sigma_t * model_output
            else:
                raise ValueError(
                    f"prediction_type given as {self.prediction_type} must be one of `epsilon`, `sample`, or"
                    " `v_prediction` for the UniPCMultistepScheduler."
                )

            if self.thresholding:
                x0_pred = self._threshold_sample(x0_pred)

            return x0_pred
        else:
            if self.prediction_type == "epsilon":
                return model_output
            elif self.prediction_type == "sample":
                epsilon = (sample - alpha_t * model_output) / sigma_t
                return epsilon
            elif self.prediction_type == "v_prediction":
                epsilon = alpha_t * model_output + sigma_t * sample
                return epsilon
            else:
                raise ValueError(
                    f"prediction_type given as {self.prediction_type} must be one of `epsilon`, `sample`, or"
                    " `v_prediction` for the UniPCMultistepScheduler."
                )

    def multistep_uni_p_bh_update(
        self,
        model_output: torch.FloatTensor,
        *args,
        sample: torch.FloatTensor = None,
        order: int | None = None,
        **kwargs,
    ) -> torch.FloatTensor:
        prev_timestep = args[0] if len(args) > 0 else kwargs.pop("prev_timestep", None)
        if sample is None:
            if len(args) > 1:
                sample = args[1]
            else:
                raise ValueError(" missing `sample` as a required keyword argument")
        if order is None:
            if len(args) > 2:
                order = args[2]
            else:
                raise ValueError(" missing `order` as a required keyword argument")
        if prev_timestep is not None:
            print(
                "Passing `prev_timestep` is deprecated and has no effect as model output conversion is now handled via an internal counter `self.step_index`",
            )
        model_output_list = self.model_outputs

        # s0 = self.timestep_list[-1]
        m0 = model_output_list[-1]
        x = sample

        sigma_t, sigma_s0 = self.sigmas[self.step_index + 1], self.sigmas[self.step_index]
        alpha_t, sigma_t = self._sigma_to_alpha_sigma_t(sigma_t)
        alpha_s0, sigma_s0 = self._sigma_to_alpha_sigma_t(sigma_s0)

        lambda_t = torch.log(alpha_t) - torch.log(sigma_t)
        lambda_s0 = torch.log(alpha_s0) - torch.log(sigma_s0)

        h = lambda_t - lambda_s0
        device = sample.device

        rks = []
        d1s = []
        for i in range(1, order):
            si = self.step_index - i
            mi = model_output_list[-(i + 1)]
            alpha_si, sigma_si = self._sigma_to_alpha_sigma_t(self.sigmas[si])
            lambda_si = torch.log(alpha_si) - torch.log(sigma_si)
            rk = (lambda_si - lambda_s0) / h
            rks.append(rk)
            d1s.append((mi - m0) / rk)

        rks.append(1.0)
        rks = torch.tensor(rks, device=device)

        r = []
        b = []

        hh = -h if self.predict_x0 else h
        h_phi_1 = torch.expm1(hh)  # h\phi_1(h) = e^h - 1
        h_phi_k = h_phi_1 / hh - 1

        factorial_i = 1

        if self.solver_type == "bh1":
            b_h = hh
        elif self.solver_type == "bh2":
            b_h = torch.expm1(hh)
        else:
            raise NotImplementedError()

        for i in range(1, order + 1):
            r.append(torch.pow(rks, i - 1))
            b.append(h_phi_k * factorial_i / b_h)
            factorial_i *= i + 1
            h_phi_k = h_phi_k / hh - 1 / factorial_i

        r = torch.stack(r)
        b = torch.tensor(b, device=device)

        if len(d1s) > 0:
            d1s = torch.stack(d1s, dim=1)  # (B, K)
            # for order 2, we use a simplified version
            if order == 2:
                rhos_p = torch.tensor([0.5], dtype=x.dtype, device=device)
            else:
                rhos_p = torch.linalg.solve(r[:-1, :-1], b[:-1])
        else:
            d1s = None

        if self.predict_x0:
            x_t_ = sigma_t / sigma_s0 * x - alpha_t * h_phi_1 * m0
            if d1s is not None:
                pred_res = torch.einsum("k,bkc...->bc...", rhos_p, d1s)
            else:
                pred_res = 0
            x_t = x_t_ - alpha_t * b_h * pred_res
        else:
            x_t_ = alpha_t / alpha_s0 * x - sigma_t * h_phi_1 * m0
            if d1s is not None:
                pred_res = torch.einsum("k,bkc...->bc...", rhos_p, d1s)
            else:
                pred_res = 0
            x_t = x_t_ - sigma_t * b_h * pred_res

        x_t = x_t.to(x.dtype)
        return x_t

    def multistep_uni_c_bh_update(
        self,
        this_model_output: torch.FloatTensor,
        *args,
        last_sample: torch.FloatTensor = None,
        this_sample: torch.FloatTensor = None,
        order: int | None = None,
        **kwargs,
    ) -> torch.FloatTensor:
        this_timestep = args[0] if len(args) > 0 else kwargs.pop("this_timestep", None)
        if last_sample is None:
            if len(args) > 1:
                last_sample = args[1]
            else:
                raise ValueError(" missing`last_sample` as a required keyword argument")
        if this_sample is None:
            if len(args) > 2:
                this_sample = args[2]
            else:
                raise ValueError(" missing`this_sample` as a required keyword argument")
        if order is None:
            if len(args) > 3:
                order = args[3]
            else:
                raise ValueError(" missing`order` as a required keyword argument")
        if this_timestep is not None:
            print(
                "Passing `this_timestep` is deprecated and has no effect as model output conversion is now handled via an internal counter `self.step_index`",
            )

        model_output_list = self.model_outputs

        m0 = model_output_list[-1]
        x = last_sample
        # x_t = this_sample
        model_t = this_model_output

        sigma_t, sigma_s0 = self.sigmas[self.step_index], self.sigmas[self.step_index - 1]
        alpha_t, sigma_t = self._sigma_to_alpha_sigma_t(sigma_t)
        alpha_s0, sigma_s0 = self._sigma_to_alpha_sigma_t(sigma_s0)

        lambda_t = torch.log(alpha_t) - torch.log(sigma_t)
        lambda_s0 = torch.log(alpha_s0) - torch.log(sigma_s0)

        h = lambda_t - lambda_s0
        device = this_sample.device

        rks = []
        d1s = []
        for i in range(1, order):
            si = self.step_index - (i + 1)
            mi = model_output_list[-(i + 1)]
            alpha_si, sigma_si = self._sigma_to_alpha_sigma_t(self.sigmas[si])
            lambda_si = torch.log(alpha_si) - torch.log(sigma_si)
            rk = (lambda_si - lambda_s0) / h
            rks.append(rk)
            d1s.append((mi - m0) / rk)

        rks.append(1.0)
        rks = torch.tensor(rks, device=device)

        r = []
        b = []

        hh = -h if self.predict_x0 else h
        h_phi_1 = torch.expm1(hh)  # h\phi_1(h) = e^h - 1
        h_phi_k = h_phi_1 / hh - 1

        factorial_i = 1

        if self.solver_type == "bh1":
            b_h = hh
        elif self.solver_type == "bh2":
            b_h = torch.expm1(hh)
        else:
            raise NotImplementedError()

        for i in range(1, order + 1):
            r.append(torch.pow(rks, i - 1))
            b.append(h_phi_k * factorial_i / b_h)
            factorial_i *= i + 1
            h_phi_k = h_phi_k / hh - 1 / factorial_i

        r = torch.stack(r)
        b = torch.tensor(b, device=device)

        if len(d1s) > 0:
            d1s = torch.stack(d1s, dim=1)
        else:
            d1s = None

        # for order 1, we use a simplified version
        if order == 1:
            rhos_c = torch.tensor([0.5], dtype=x.dtype, device=device)
        else:
            rhos_c = torch.linalg.solve(r, b)

        if self.predict_x0:
            x_t_ = sigma_t / sigma_s0 * x - alpha_t * h_phi_1 * m0
            if d1s is not None:
                corr_res = torch.einsum("k,bkc...->bc...", rhos_c[:-1], d1s)
            else:
                corr_res = 0
            d1_t = model_t - m0
            x_t = x_t_ - alpha_t * b_h * (corr_res + rhos_c[-1] * d1_t)
        else:
            x_t_ = alpha_t / alpha_s0 * x - sigma_t * h_phi_1 * m0
            if d1s is not None:
                corr_res = torch.einsum("k,bkc...->bc...", rhos_c[:-1], d1s)
            else:
                corr_res = 0
            d1_t = model_t - m0
            x_t = x_t_ - sigma_t * b_h * (corr_res + rhos_c[-1] * d1_t)
        x_t = x_t.to(x.dtype)
        return x_t

    def _init_step_index(self, timestep):
        if isinstance(timestep, torch.Tensor):
            timestep = timestep.to(self.timesteps.device)

        index_candidates = (self.timesteps == timestep).nonzero()

        if len(index_candidates) == 0:
            step_index = len(self.timesteps) - 1
        # The sigma index that is taken for the **very** first `step`
        # is always the second index (or the last index if there is only 1)
        # This way we can ensure we don't accidentally skip a sigma in
        # case we start in the middle of the denoising schedule (e.g. for image-to-image)
        elif len(index_candidates) > 1:
            step_index = index_candidates[1].item()
        else:
            step_index = index_candidates[0].item()

        self._step_index = step_index

    def step(
        self,
        model_output: torch.FloatTensor,
        timestep: int,
        sample: torch.FloatTensor,
        return_dict: bool = True,
    ):
        if self.num_inference_steps is None:
            raise ValueError(
                "Number of inference steps is 'None', you need to run 'set_timesteps' after creating the scheduler"
            )

        if self.step_index is None:
            self._init_step_index(timestep)

        use_corrector = (
            self.step_index > 0 and self.step_index - 1 not in self.disable_corrector and self.last_sample is not None
        )

        model_output_convert = self.convert_model_output(model_output, sample=sample)
        if use_corrector:
            sample = self.multistep_uni_c_bh_update(
                this_model_output=model_output_convert,
                last_sample=self.last_sample,
                this_sample=sample,
                order=self.this_order,
            )

        for i in range(self.solver_order - 1):
            self.model_outputs[i] = self.model_outputs[i + 1]
            self.timestep_list[i] = self.timestep_list[i + 1]

        self.model_outputs[-1] = model_output_convert
        self.timestep_list[-1] = timestep

        if self.lower_order_final:
            this_order = min(self.solver_order, len(self.timesteps) - self.step_index)
        else:
            this_order = self.solver_order

        self.this_order = min(this_order, self.lower_order_nums + 1)  # warmup for multistep
        assert self.this_order > 0

        self.last_sample = sample
        prev_sample = self.multistep_uni_p_bh_update(
            model_output=model_output,  # pass the original non-converted model output, in case solver-p is used
            sample=sample,
            order=self.this_order,
        )

        if self.lower_order_nums < self.solver_order:
            self.lower_order_nums += 1

        # upon completion increase step index by one
        self._step_index += 1

        if not return_dict:
            return (prev_sample,)

        return prev_sample

    def scale_model_input(self, sample: torch.FloatTensor, *args, **kwargs) -> torch.FloatTensor:
        return sample

    def add_noise(
        self,
        original_samples: torch.FloatTensor,
        noise: torch.FloatTensor,
        idx,
        timesteps: torch.IntTensor,
    ) -> torch.FloatTensor:
        # Make sure sigmas and timesteps have the same device and dtype as original_samples
        sigmas = self.sigmas.to(device=original_samples.device, dtype=original_samples.dtype)
        schedule_timesteps = self.timesteps.to(original_samples.device)
        timesteps = timesteps.to(original_samples.device)

        step_indices = [(schedule_timesteps == t).nonzero().item() for t in timesteps]
        sigma = sigmas[step_indices].flatten()
        while len(sigma.shape) < len(original_samples.shape):
            sigma = sigma.unsqueeze(-1)

        alpha_t, sigma_t = self._sigma_to_alpha_sigma_t(sigma)
        noisy_samples = alpha_t * original_samples + sigma_t * noise
        return noisy_samples

    def configure(self):
        pass

    def __len__(self):
        return self.num_train_timesteps


# Modified from diffusers.schedulers.LCMScheduler
class LCMScheduler:
    def __init__(
        self,
        device="cuda",
        num_train_timesteps: int = 1000,
        beta_start: float = 0.00085,
        beta_end: float = 0.012,
        original_inference_steps: int = 50,
        clip_sample: bool = False,
        clip_sample_range: float = 1.0,
        steps_offset: int = 0,
        prediction_type: str = "epsilon",
        thresholding: bool = False,
        dynamic_thresholding_ratio: float = 0.995,
        sample_max_value: float = 1.0,
        timestep_spacing: str = "leading",
        timestep_scaling: float = 10.0,
    ):
        self.device = device
        self.betas = torch.linspace(beta_start**0.5, beta_end**0.5, num_train_timesteps, dtype=torch.float32) ** 2
        self.alphas = 1.0 - self.betas
        self.alphas_cumprod = torch.cumprod(self.alphas, dim=0)
        self.final_alpha_cumprod = self.alphas_cumprod[0]
        # standard deviation of the initial noise distribution
        self.init_noise_sigma = 1.0
        # setable values
        self.num_inference_steps = None
        self.timesteps = torch.from_numpy(np.arange(0, num_train_timesteps)[::-1].copy().astype(np.int64))

        self.num_train_timesteps = num_train_timesteps
        self.clip_sample = clip_sample
        self.clip_sample_range = clip_sample_range
        self.steps_offset = steps_offset
        self.prediction_type = prediction_type
        self.thresholding = thresholding
        self.timestep_spacing = timestep_spacing
        self.timestep_scaling = timestep_scaling
        self.original_inference_steps = original_inference_steps
        self.dynamic_thresholding_ratio = dynamic_thresholding_ratio
        self.sample_max_value = sample_max_value

        self._step_index = None

    # Copied from diffusers.schedulers.scheduling_euler_discrete.EulerDiscreteScheduler._init_step_index
    def _init_step_index(self, timestep):
        if isinstance(timestep, torch.Tensor):
            timestep = timestep.to(self.timesteps.device)

        index_candidates = (self.timesteps == timestep).nonzero()

        if len(index_candidates) > 1:
            step_index = index_candidates[1]
        else:
            step_index = index_candidates[0]

        self._step_index = step_index.item()

    @property
    def step_index(self):
        return self._step_index

    def scale_model_input(self, sample: torch.FloatTensor, *args, **kwargs) -> torch.FloatTensor:
        return sample

    # Copied from diffusers.schedulers.scheduling_ddpm.DDPMScheduler._threshold_sample
    def _threshold_sample(self, sample: torch.FloatTensor) -> torch.FloatTensor:
        dtype = sample.dtype
        batch_size, channels, *remaining_dims = sample.shape

        if dtype not in (torch.float32, torch.float64):
            sample = sample.float()  # upcast for quantile calculation, and clamp not implemented for cpu half

        # Flatten sample for doing quantile calculation along each image
        sample = sample.reshape(batch_size, channels * np.prod(remaining_dims))

        abs_sample = sample.abs()  # "a certain percentile absolute pixel value"

        s = torch.quantile(abs_sample, self.dynamic_thresholding_ratio, dim=1)
        s = torch.clamp(
            s, min=1, max=self.sample_max_value
        )  # When clamped to min=1, equivalent to standard clipping to [-1, 1]
        s = s.unsqueeze(1)  # (batch_size, 1) because clamp will broadcast along dim=0
        sample = torch.clamp(sample, -s, s) / s  # "we threshold xt0 to the range [-s, s] and then divide by s"

        sample = sample.reshape(batch_size, channels, *remaining_dims)
        sample = sample.to(dtype)

        return sample

    def set_timesteps(
        self,
        num_inference_steps: int,
        strength: int = 1.0,
    ):
        assert num_inference_steps <= self.num_train_timesteps

        self.num_inference_steps = num_inference_steps
        original_steps = self.original_inference_steps

        assert original_steps <= self.num_train_timesteps
        assert num_inference_steps <= original_steps

        # LCM Timesteps Setting
        # Currently, only linear spacing is supported.
        c = self.num_train_timesteps // original_steps
        # LCM Training Steps Schedule
        lcm_origin_timesteps = np.asarray(list(range(1, int(original_steps * strength) + 1))) * c - 1
        skipping_step = len(lcm_origin_timesteps) // num_inference_steps
        # LCM Inference Steps Schedule
        timesteps = lcm_origin_timesteps[::-skipping_step][:num_inference_steps]

        self.timesteps = torch.from_numpy(timesteps.copy()).to(device=self.device, dtype=torch.long)

        self._step_index = None

    def get_scalings_for_boundary_condition_discrete(self, timestep):
        self.sigma_data = 0.5  # Default: 0.5
        scaled_timestep = timestep * self.timestep_scaling

        c_skip = self.sigma_data**2 / (scaled_timestep**2 + self.sigma_data**2)
        c_out = scaled_timestep / (scaled_timestep**2 + self.sigma_data**2) ** 0.5
        return c_skip, c_out

    def step(
        self,
        model_output: torch.FloatTensor,
        timestep: int,
        sample: torch.FloatTensor,
        generator: torch.Generator | None = None,
    ):
        if self.num_inference_steps is None:
            raise ValueError(
                "Number of inference steps is 'None', you need to run 'set_timesteps' after creating the scheduler"
            )

        if self.step_index is None:
            self._init_step_index(timestep)

        # 1. get previous step value
        prev_step_index = self.step_index + 1
        if prev_step_index < len(self.timesteps):
            prev_timestep = self.timesteps[prev_step_index]
        else:
            prev_timestep = timestep

        # 2. compute alphas, betas
        alpha_prod_t = self.alphas_cumprod[timestep]
        alpha_prod_t_prev = self.alphas_cumprod[prev_timestep] if prev_timestep >= 0 else self.final_alpha_cumprod

        beta_prod_t = 1 - alpha_prod_t
        beta_prod_t_prev = 1 - alpha_prod_t_prev

        # 3. Get scalings for boundary conditions
        c_skip, c_out = self.get_scalings_for_boundary_condition_discrete(timestep)

        # 4. Compute the predicted original sample x_0 based on the model parameterization
        if self.prediction_type == "epsilon":  # noise-prediction
            predicted_original_sample = (sample - beta_prod_t.sqrt() * model_output) / alpha_prod_t.sqrt()
        elif self.prediction_type == "sample":  # x-prediction
            predicted_original_sample = model_output
        elif self.prediction_type == "v_prediction":  # v-prediction
            predicted_original_sample = alpha_prod_t.sqrt() * sample - beta_prod_t.sqrt() * model_output
        else:
            raise ValueError(
                f"prediction_type given as {self.prediction_type} must be one of `epsilon`, `sample` or"
                " `v_prediction` for `LCMScheduler`."
            )

        # 5. Clip or threshold "predicted x_0"
        if self.thresholding:
            predicted_original_sample = self._threshold_sample(predicted_original_sample)
        elif self.clip_sample:
            predicted_original_sample = predicted_original_sample.clamp(-self.clip_sample_range, self.clip_sample_range)

        # 6. Denoise model output using boundary conditions
        denoised = c_out * predicted_original_sample + c_skip * sample

        # 7. Sample and inject noise z ~ N(0, I) for MultiStep Inference
        # Noise is not used on the final timestep of the timestep schedule.
        # This also means that noise is not used for one-step sampling.
        if self.step_index != self.num_inference_steps - 1:
            noise = torch.randn(
                model_output.shape, device=model_output.device, dtype=denoised.dtype, generator=generator
            )
            prev_sample = alpha_prod_t_prev.sqrt() * denoised + beta_prod_t_prev.sqrt() * noise
        else:
            prev_sample = denoised

        # upon completion increase step index by one
        self._step_index += 1

        return (prev_sample,)

    # Copied from diffusers.schedulers.scheduling_ddpm.DDPMScheduler.add_noise
    def add_noise(
        self,
        original_samples: torch.FloatTensor,
        noise: torch.FloatTensor,
        timesteps: torch.IntTensor,
    ) -> torch.FloatTensor:
        # Make sure alphas_cumprod and timestep have same device and dtype as original_samples
        alphas_cumprod = self.alphas_cumprod.to(device=original_samples.device, dtype=original_samples.dtype)
        timesteps = timesteps.to(original_samples.device)

        sqrt_alpha_prod = alphas_cumprod[timesteps] ** 0.5
        sqrt_alpha_prod = sqrt_alpha_prod.flatten()
        while len(sqrt_alpha_prod.shape) < len(original_samples.shape):
            sqrt_alpha_prod = sqrt_alpha_prod.unsqueeze(-1)

        sqrt_one_minus_alpha_prod = (1 - alphas_cumprod[timesteps]) ** 0.5
        sqrt_one_minus_alpha_prod = sqrt_one_minus_alpha_prod.flatten()
        while len(sqrt_one_minus_alpha_prod.shape) < len(original_samples.shape):
            sqrt_one_minus_alpha_prod = sqrt_one_minus_alpha_prod.unsqueeze(-1)

        noisy_samples = sqrt_alpha_prod * original_samples + sqrt_one_minus_alpha_prod * noise
        return noisy_samples

    def configure(self):
        pass

    def __len__(self):
        return self.num_train_timesteps
