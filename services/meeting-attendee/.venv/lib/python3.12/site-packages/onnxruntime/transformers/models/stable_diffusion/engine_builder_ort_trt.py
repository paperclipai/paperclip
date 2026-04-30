# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

import gc
import logging
import os

import torch
from cuda import cudart
from diffusion_models import PipelineInfo
from engine_builder import EngineBuilder, EngineType
from packaging import version

import onnxruntime as ort
from onnxruntime.transformers.io_binding_helper import CudaSession

logger = logging.getLogger(__name__)


class OrtTensorrtEngine(CudaSession):
    def __init__(
        self,
        engine_path,
        device_id,
        onnx_path,
        fp16,
        input_profile,
        workspace_size,
        enable_cuda_graph,
        timing_cache_path=None,
    ):
        self.engine_path = engine_path
        self.ort_trt_provider_options = self.get_tensorrt_provider_options(
            input_profile,
            workspace_size,
            fp16,
            device_id,
            enable_cuda_graph,
            timing_cache_path=timing_cache_path,
        )

        session_options = ort.SessionOptions()
        session_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
        logger.info("creating TRT EP session for %s", onnx_path)
        ort_session = ort.InferenceSession(
            onnx_path,
            session_options,
            providers=[
                ("TensorrtExecutionProvider", self.ort_trt_provider_options),
            ],
        )
        logger.info("created TRT EP session for %s", onnx_path)

        device = torch.device("cuda", device_id)
        super().__init__(ort_session, device, enable_cuda_graph)

    def get_tensorrt_provider_options(
        self, input_profile, workspace_size, fp16, device_id, enable_cuda_graph, timing_cache_path=None
    ):
        trt_ep_options = {
            "device_id": device_id,
            "trt_fp16_enable": fp16,
            "trt_engine_cache_enable": True,
            "trt_timing_cache_enable": True,
            "trt_detailed_build_log": True,
            "trt_engine_cache_path": self.engine_path,
        }

        if version.parse(ort.__version__) > version.parse("1.16.2") and timing_cache_path is not None:
            trt_ep_options["trt_timing_cache_path"] = timing_cache_path

        if enable_cuda_graph:
            trt_ep_options["trt_cuda_graph_enable"] = True

        if workspace_size > 0:
            trt_ep_options["trt_max_workspace_size"] = workspace_size

        if input_profile:
            min_shapes = []
            max_shapes = []
            opt_shapes = []
            for name, profile in input_profile.items():
                assert isinstance(profile, list) and len(profile) == 3
                min_shape = profile[0]
                opt_shape = profile[1]
                max_shape = profile[2]
                assert len(min_shape) == len(opt_shape) and len(opt_shape) == len(max_shape)

                min_shapes.append(f"{name}:" + "x".join([str(x) for x in min_shape]))
                opt_shapes.append(f"{name}:" + "x".join([str(x) for x in opt_shape]))
                max_shapes.append(f"{name}:" + "x".join([str(x) for x in max_shape]))

            trt_ep_options["trt_profile_min_shapes"] = ",".join(min_shapes)
            trt_ep_options["trt_profile_max_shapes"] = ",".join(max_shapes)
            trt_ep_options["trt_profile_opt_shapes"] = ",".join(opt_shapes)

        logger.info("trt_ep_options=%s", trt_ep_options)

        return trt_ep_options

    def allocate_buffers(self, shape_dict, device):
        super().allocate_buffers(shape_dict)


class OrtTensorrtEngineBuilder(EngineBuilder):
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
            EngineType.ORT_TRT,
            pipeline_info,
            max_batch_size=max_batch_size,
            device=device,
            use_cuda_graph=use_cuda_graph,
        )

    def has_engine_file(self, engine_path):
        if os.path.isdir(engine_path):
            children = os.scandir(engine_path)
            for entry in children:
                if entry.is_file() and entry.name.endswith(".engine"):
                    return True
        return False

    def get_work_space_size(self, model_name, max_workspace_size):
        gibibyte = 2**30
        workspace_size = 4 * gibibyte if model_name == "clip" else max_workspace_size
        if workspace_size == 0:
            _, free_mem, _ = cudart.cudaMemGetInfo()
            # The following logic are adopted from TensorRT demo diffusion.
            if free_mem > 6 * gibibyte:
                workspace_size = free_mem - 4 * gibibyte
        return workspace_size

    def build_engines(
        self,
        engine_dir,
        framework_model_dir,
        onnx_dir,
        onnx_opset,
        opt_image_height,
        opt_image_width,
        opt_batch_size=1,
        static_batch=False,
        static_image_shape=True,
        max_workspace_size=0,
        device_id=0,
        timing_cache=None,
    ):
        self.torch_device = torch.device("cuda", device_id)
        self.load_models(framework_model_dir)

        if not os.path.isdir(engine_dir):
            os.makedirs(engine_dir)

        if not os.path.isdir(onnx_dir):
            os.makedirs(onnx_dir)

        # Load lora only when we need export text encoder or UNet to ONNX.
        load_lora = False
        if self.pipeline_info.lora_weights:
            for model_name, model_obj in self.models.items():
                if model_name not in ["clip", "clip2", "unet", "unetxl"]:
                    continue
                profile_id = model_obj.get_profile_id(
                    opt_batch_size, opt_image_height, opt_image_width, static_batch, static_image_shape
                )
                engine_path = self.get_engine_path(engine_dir, model_name, profile_id)
                if not self.has_engine_file(engine_path):
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
                opt_batch_size, opt_image_height, opt_image_width, static_batch, static_image_shape
            )
            engine_path = self.get_engine_path(engine_dir, model_name, profile_id)
            if not self.has_engine_file(engine_path):
                onnx_path = self.get_onnx_path(model_name, onnx_dir, opt=False)
                onnx_opt_path = self.get_onnx_path(model_name, onnx_dir, opt=True)
                if not os.path.exists(onnx_opt_path):
                    if not os.path.exists(onnx_path):
                        logger.info(f"Exporting model: {onnx_path}")
                        model = self.get_or_load_model(pipe, model_name, model_obj, framework_model_dir)

                        with torch.inference_mode(), torch.autocast("cuda"):
                            inputs = model_obj.get_sample_input(opt_batch_size, opt_image_height, opt_image_width)
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
                        logger.info("Found cached model: %s", onnx_path)

                    # Optimize onnx
                    if not os.path.exists(onnx_opt_path):
                        logger.info("Generating optimizing model: %s", onnx_opt_path)
                        model_obj.optimize_trt(onnx_path, onnx_opt_path)
                    else:
                        logger.info("Found cached optimized model: %s", onnx_opt_path)
        self.enable_torch_spda()

        built_engines = {}
        for model_name, model_obj in self.models.items():
            if model_name == "vae" and self.vae_torch_fallback:
                continue

            profile_id = model_obj.get_profile_id(
                opt_batch_size, opt_image_height, opt_image_width, static_batch, static_image_shape
            )

            engine_path = self.get_engine_path(engine_dir, model_name, profile_id)
            onnx_opt_path = self.get_onnx_path(model_name, onnx_dir, opt=True)
            if not self.has_engine_file(engine_path):
                logger.info(
                    "Building TensorRT engine for %s from %s to %s. It can take a while to complete...",
                    model_name,
                    onnx_opt_path,
                    engine_path,
                )
            else:
                logger.info("Reuse cached TensorRT engine in directory %s", engine_path)

            input_profile = model_obj.get_input_profile(
                opt_batch_size,
                opt_image_height,
                opt_image_width,
                static_batch=static_batch,
                static_image_shape=static_image_shape,
            )

            engine = OrtTensorrtEngine(
                engine_path,
                device_id,
                onnx_opt_path,
                fp16=True,
                input_profile=input_profile,
                workspace_size=self.get_work_space_size(model_name, max_workspace_size),
                enable_cuda_graph=self.use_cuda_graph,
                timing_cache_path=timing_cache,
            )

            built_engines[model_name] = engine

        self.engines = built_engines

    def run_engine(self, model_name, feed_dict):
        return self.engines[model_name].infer(feed_dict)
