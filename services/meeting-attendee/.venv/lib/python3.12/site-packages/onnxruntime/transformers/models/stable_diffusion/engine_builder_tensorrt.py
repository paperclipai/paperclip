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

import gc
import os
import pathlib
from collections import OrderedDict

import numpy as np
import tensorrt as trt
import torch
from cuda import cudart
from diffusion_models import PipelineInfo
from engine_builder import EngineBuilder, EngineType
from polygraphy.backend.common import bytes_from_path
from polygraphy.backend.trt import (
    CreateConfig,
    ModifyNetworkOutputs,
    Profile,
    engine_from_bytes,
    engine_from_network,
    network_from_onnx_path,
    save_engine,
)

# Map of numpy dtype -> torch dtype
numpy_to_torch_dtype_dict = {
    np.int32: torch.int32,
    np.int64: torch.int64,
    np.float16: torch.float16,
    np.float32: torch.float32,
}


def _cuda_assert(cuda_ret):
    err = cuda_ret[0]
    if err != cudart.cudaError_t.cudaSuccess:
        raise RuntimeError(
            f"CUDA ERROR: {err}, error code reference: https://nvidia.github.io/cuda-python/module/cudart.html#cuda.cudart.cudaError_t"
        )
    if len(cuda_ret) > 1:
        return cuda_ret[1]
    return None


class TensorrtEngine:
    def __init__(
        self,
        engine_path,
    ):
        self.engine_path = engine_path
        self.engine = None
        self.context = None
        self.buffers = OrderedDict()
        self.tensors = OrderedDict()
        self.cuda_graph_instance = None

    def __del__(self):
        del self.engine
        del self.context
        del self.buffers
        del self.tensors

    def build(
        self,
        onnx_path,
        fp16,
        input_profile=None,
        enable_all_tactics=False,
        timing_cache=None,
        update_output_names=None,
    ):
        print(f"Building TensorRT engine for {onnx_path}: {self.engine_path}")
        p = Profile()
        if input_profile:
            for name, dims in input_profile.items():
                assert len(dims) == 3
                p.add(name, min=dims[0], opt=dims[1], max=dims[2])

        config_kwargs = {}
        if not enable_all_tactics:
            config_kwargs["tactic_sources"] = []

        network = network_from_onnx_path(onnx_path, flags=[trt.OnnxParserFlag.NATIVE_INSTANCENORM])
        if update_output_names:
            print(f"Updating network outputs to {update_output_names}")
            network = ModifyNetworkOutputs(network, update_output_names)
        engine = engine_from_network(
            network,
            config=CreateConfig(
                fp16=fp16, refittable=False, profiles=[p], load_timing_cache=timing_cache, **config_kwargs
            ),
            save_timing_cache=timing_cache,
        )
        save_engine(engine, path=self.engine_path)

    def load(self):
        print(f"Loading TensorRT engine: {self.engine_path}")
        self.engine = engine_from_bytes(bytes_from_path(self.engine_path))

    def activate(self, reuse_device_memory=None):
        if reuse_device_memory:
            self.context = self.engine.create_execution_context_without_device_memory()
            self.context.device_memory = reuse_device_memory
        else:
            self.context = self.engine.create_execution_context()

    def allocate_buffers(self, shape_dict=None, device="cuda"):
        for idx in range(self.engine.num_io_tensors):
            binding = self.engine[idx]
            if shape_dict and binding in shape_dict:
                shape = shape_dict[binding]
            else:
                shape = self.engine.get_binding_shape(binding)
            dtype = trt.nptype(self.engine.get_binding_dtype(binding))
            if self.engine.binding_is_input(binding):
                self.context.set_binding_shape(idx, shape)
            tensor = torch.empty(tuple(shape), dtype=numpy_to_torch_dtype_dict[dtype]).to(device=device)
            self.tensors[binding] = tensor

    def infer(self, feed_dict, stream, use_cuda_graph=False):
        for name, buf in feed_dict.items():
            self.tensors[name].copy_(buf)

        for name, tensor in self.tensors.items():
            self.context.set_tensor_address(name, tensor.data_ptr())

        if use_cuda_graph:
            if self.cuda_graph_instance is not None:
                _cuda_assert(cudart.cudaGraphLaunch(self.cuda_graph_instance, stream))
                _cuda_assert(cudart.cudaStreamSynchronize(stream))
            else:
                # do inference before CUDA graph capture
                noerror = self.context.execute_async_v3(stream)
                if not noerror:
                    raise ValueError("ERROR: inference failed.")
                # capture cuda graph
                _cuda_assert(
                    cudart.cudaStreamBeginCapture(stream, cudart.cudaStreamCaptureMode.cudaStreamCaptureModeGlobal)
                )
                self.context.execute_async_v3(stream)
                self.graph = _cuda_assert(cudart.cudaStreamEndCapture(stream))

                from cuda import nvrtc  # noqa: PLC0415

                result, major, minor = nvrtc.nvrtcVersion()
                assert result == nvrtc.nvrtcResult(0)
                if major < 12:
                    self.cuda_graph_instance = _cuda_assert(
                        cudart.cudaGraphInstantiate(self.graph, b"", 0)
                    )  # cuda < 12
                else:
                    self.cuda_graph_instance = _cuda_assert(cudart.cudaGraphInstantiate(self.graph, 0))  # cuda >= 12
        else:
            noerror = self.context.execute_async_v3(stream)
            if not noerror:
                raise ValueError("ERROR: inference failed.")

        return self.tensors


class TensorrtEngineBuilder(EngineBuilder):
    """
    Helper class to hide the detail of TensorRT Engine from pipeline.
    """

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
            EngineType.TRT,
            pipeline_info,
            max_batch_size=max_batch_size,
            device=device,
            use_cuda_graph=use_cuda_graph,
        )

        self.stream = None
        self.shared_device_memory = None

    def load_resources(self, image_height, image_width, batch_size):
        super().load_resources(image_height, image_width, batch_size)

        self.stream = _cuda_assert(cudart.cudaStreamCreate())

    def teardown(self):
        super().teardown()

        if self.shared_device_memory:
            cudart.cudaFree(self.shared_device_memory)

        cudart.cudaStreamDestroy(self.stream)
        del self.stream

    def load_engines(
        self,
        engine_dir,
        framework_model_dir,
        onnx_dir,
        onnx_opset,
        opt_batch_size,
        opt_image_height,
        opt_image_width,
        static_batch=False,
        static_shape=True,
        enable_all_tactics=False,
        timing_cache=None,
    ):
        """
        Build and load engines for TensorRT accelerated inference.
        Export ONNX models first, if applicable.

        Args:
            engine_dir (str):
                Directory to write the TensorRT engines.
            framework_model_dir (str):
                Directory to write the framework model ckpt.
            onnx_dir (str):
                Directory to write the ONNX models.
            onnx_opset (int):
                ONNX opset version to export the models.
            opt_batch_size (int):
                Batch size to optimize for during engine building.
            opt_image_height (int):
                Image height to optimize for during engine building. Must be a multiple of 8.
            opt_image_width (int):
                Image width to optimize for during engine building. Must be a multiple of 8.
            static_batch (bool):
                Build engine only for specified opt_batch_size.
            static_shape (bool):
                Build engine only for specified opt_image_height & opt_image_width. Default = True.
            enable_all_tactics (bool):
                Enable all tactic sources during TensorRT engine builds.
            timing_cache (str):
                Path to the timing cache to accelerate build or None
        """
        # Create directory
        for directory in [engine_dir, onnx_dir]:
            if not os.path.exists(directory):
                print(f"[I] Create directory: {directory}")
                pathlib.Path(directory).mkdir(parents=True)

        self.load_models(framework_model_dir)

        # Load lora only when we need export text encoder or UNet to ONNX.
        load_lora = False
        if self.pipeline_info.lora_weights:
            for model_name, model_obj in self.models.items():
                if model_name not in ["clip", "clip2", "unet", "unetxl"]:
                    continue
                profile_id = model_obj.get_profile_id(
                    opt_batch_size, opt_image_height, opt_image_width, static_batch, static_shape
                )
                engine_path = self.get_engine_path(engine_dir, model_name, profile_id)
                if not os.path.exists(engine_path):
                    onnx_path = self.get_onnx_path(model_name, onnx_dir, opt=False)
                    onnx_opt_path = self.get_onnx_path(model_name, onnx_dir, opt=True)
                    if not os.path.exists(onnx_opt_path):
                        if not os.path.exists(onnx_path):
                            load_lora = True
                            break

        # Export models to ONNX
        self.disable_torch_spda()
        pipe = self.load_pipeline_with_lora() if load_lora else None

        for model_name, model_obj in self.models.items():
            if model_name == "vae" and self.vae_torch_fallback:
                continue
            profile_id = model_obj.get_profile_id(
                opt_batch_size, opt_image_height, opt_image_width, static_batch, static_shape
            )
            engine_path = self.get_engine_path(engine_dir, model_name, profile_id)
            if not os.path.exists(engine_path):
                onnx_path = self.get_onnx_path(model_name, onnx_dir, opt=False)
                onnx_opt_path = self.get_onnx_path(model_name, onnx_dir, opt=True)
                if not os.path.exists(onnx_opt_path):
                    if not os.path.exists(onnx_path):
                        print(f"Exporting model: {onnx_path}")
                        model = self.get_or_load_model(pipe, model_name, model_obj, framework_model_dir)

                        with torch.inference_mode(), torch.autocast("cuda"):
                            inputs = model_obj.get_sample_input(1, opt_image_height, opt_image_width)
                            torch.onnx.export(
                                model,
                                inputs,
                                onnx_path,
                                export_params=True,
                                opset_version=onnx_opset,
                                do_constant_folding=True,
                                input_names=model_obj.get_input_names(),
                                output_names=model_obj.get_output_names(),
                                dynamic_axes=model_obj.get_dynamic_axes(),
                            )
                        del model
                        torch.cuda.empty_cache()
                        gc.collect()
                    else:
                        print(f"Found cached model: {onnx_path}")

                    # Optimize onnx
                    if not os.path.exists(onnx_opt_path):
                        print(f"Generating optimizing model: {onnx_opt_path}")
                        model_obj.optimize_trt(onnx_path, onnx_opt_path)
                    else:
                        print(f"Found cached optimized model: {onnx_opt_path} ")
        self.enable_torch_spda()

        # Build TensorRT engines
        for model_name, model_obj in self.models.items():
            if model_name == "vae" and self.vae_torch_fallback:
                continue
            profile_id = model_obj.get_profile_id(
                opt_batch_size, opt_image_height, opt_image_width, static_batch, static_shape
            )
            engine_path = self.get_engine_path(engine_dir, model_name, profile_id)
            engine = TensorrtEngine(engine_path)
            onnx_opt_path = self.get_onnx_path(model_name, onnx_dir, opt=True)

            if not os.path.exists(engine.engine_path):
                engine.build(
                    onnx_opt_path,
                    fp16=True,
                    input_profile=model_obj.get_input_profile(
                        opt_batch_size,
                        opt_image_height,
                        opt_image_width,
                        static_batch,
                        static_shape,
                    ),
                    enable_all_tactics=enable_all_tactics,
                    timing_cache=timing_cache,
                    update_output_names=None,
                )
            self.engines[model_name] = engine

        # Load TensorRT engines
        for model_name in self.models:
            if model_name == "vae" and self.vae_torch_fallback:
                continue
            self.engines[model_name].load()

    def max_device_memory(self):
        max_device_memory = 0
        for engine in self.engines.values():
            max_device_memory = max(max_device_memory, engine.engine.device_memory_size)
        return max_device_memory

    def activate_engines(self, shared_device_memory=None):
        if shared_device_memory is None:
            max_device_memory = self.max_device_memory()
            _, shared_device_memory = cudart.cudaMalloc(max_device_memory)
        self.shared_device_memory = shared_device_memory
        # Load and activate TensorRT engines
        for engine in self.engines.values():
            engine.activate(reuse_device_memory=self.shared_device_memory)

    def run_engine(self, model_name, feed_dict):
        return self.engines[model_name].infer(feed_dict, self.stream, use_cuda_graph=self.use_cuda_graph)
