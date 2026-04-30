# -------------------------------------------------------------------------
# Copyright (R) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
import logging
import warnings

import torch
from sam2.modeling.sam2_base import SAM2Base
from sam2_utils import compare_tensors_with_tolerance, random_sam2_input_image
from torch import nn

import onnxruntime

logger = logging.getLogger(__name__)


class SAM2ImageEncoder(nn.Module):
    def __init__(self, sam_model: SAM2Base) -> None:
        super().__init__()
        self.model = sam_model
        self.image_encoder = sam_model.image_encoder
        self.no_mem_embed = sam_model.no_mem_embed

    def forward(
        self,
        image: torch.Tensor,
        enable_nvtx_profile: bool = False,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """
        Encodes images into features.

        Only supports H=W=1024. If you want to use different image sizes like 512x512,
        see https://github.com/facebookresearch/segment-anything-2/issues/138.

        Args:
            image (torch.Tensor): images of shape [B, 3, H, W], B is batch size, H and W are height and width.
            enable_nvtx_profile (bool): enable NVTX profiling.

        Returns:
            image_features_0: image features of shape [B, 32, H/4, W/4] - high resolution features of level 0
            image_features_1: image features of shape [B, 64, H/8, W/8] - high resolution features of level 1
            image_embeddings: image features of shape [B, 256, H/16, W/16] - 16 is the backbone_stride
        """
        nvtx_helper = None
        if enable_nvtx_profile:
            from nvtx_helper import NvtxHelper  # noqa: PLC0415

            nvtx_helper = NvtxHelper(["image_encoder", "post_process"])

        if nvtx_helper is not None:
            nvtx_helper.start_profile("image_encoder")

        backbone_out = self.image_encoder(image)

        if nvtx_helper is not None:
            nvtx_helper.stop_profile("image_encoder")
            nvtx_helper.start_profile("post_process")

        # precompute projected level 0 and level 1 features in SAM decoder
        # to avoid running it again on every SAM click
        backbone_out["backbone_fpn"][0] = self.model.sam_mask_decoder.conv_s0(backbone_out["backbone_fpn"][0])
        backbone_out["backbone_fpn"][1] = self.model.sam_mask_decoder.conv_s1(backbone_out["backbone_fpn"][1])

        # Prepare and flatten visual features.
        feature_maps = backbone_out["backbone_fpn"][-self.model.num_feature_levels :]
        vision_pos_embeds = backbone_out["vision_pos_enc"][-self.model.num_feature_levels :]
        feat_sizes = [(x.shape[-2], x.shape[-1]) for x in vision_pos_embeds]

        # flatten NxCxHxW to HWxNxC
        # TODO: we should avoid this transpose since it will be transposed back to NCHW later.
        vision_feats = [x.flatten(2).permute(2, 0, 1) for x in feature_maps]

        vision_feats[-1] = vision_feats[-1] + self.no_mem_embed

        feats = [
            feat.permute(1, 2, 0).reshape(1, -1, *feat_size)
            for feat, feat_size in zip(vision_feats[::-1], feat_sizes[::-1], strict=False)
        ][::-1]

        if nvtx_helper is not None:
            nvtx_helper.stop_profile("post_process")
            nvtx_helper.print_latency()

        return feats[0], feats[1], feats[2]


def export_image_encoder_onnx(
    sam2_model: SAM2Base,
    onnx_model_path: str,
    dynamic_batch_axes: bool = False,
    verbose: bool = False,
    dynamo: bool = False,
    clear_dynamo_metadata: bool = False,
):
    image = random_sam2_input_image()

    sam2_encoder = SAM2ImageEncoder(sam2_model).cpu()
    image_features_0, image_features_1, image_embeddings = sam2_encoder(image)
    logger.info("image.shape: %s", image.shape)
    logger.info("image_features_0.shape: %s", image_features_0.shape)
    logger.info("image_features_1.shape: %s", image_features_1.shape)
    logger.info("image_embeddings.shape: %s", image_embeddings.shape)

    dynamic_axes = None
    if dynamic_batch_axes:
        dynamic_axes = {
            "image": {0: "batch_size"},
            "image_features_0": {0: "batch_size"},
            "image_features_1": {0: "batch_size"},
            "image_embeddings": {0: "batch_size"},
        }

    with warnings.catch_warnings():
        if not verbose:
            warnings.filterwarnings("ignore", category=torch.jit.TracerWarning)
            warnings.filterwarnings("ignore", category=UserWarning)

        if not dynamo:
            torch.onnx.export(
                sam2_encoder,
                image,
                onnx_model_path,
                export_params=True,
                opset_version=17,
                do_constant_folding=True,
                input_names=["image"],
                output_names=["image_features_0", "image_features_1", "image_embeddings"],
                dynamic_axes=dynamic_axes,
            )
        else:
            torch._dynamo.config.capture_scalar_outputs = True
            ep = torch.export.export(
                sam2_encoder,
                args=(image,),
                strict=False,
                dynamic_shapes=[
                    {0: torch.export.Dim.AUTO},
                ],
            )

            onnx_program = torch.onnx.export(
                ep,
                (),
                opset_version=17,
                input_names=["image"],
                output_names=["image_features_0", "image_features_1", "image_embeddings"],
                dynamo=True,
            )
            onnx_program.optimize()
            onnx_program.save(onnx_model_path + ".dynamo.onnx", external_data=False)
            import onnx  # noqa: PLC0415

            from onnxruntime.transformers.dynamo_onnx_helper import DynamoOnnxHelper  # noqa: PLC0415

            onnx_model = onnx.load_model(onnx_model_path + ".dynamo.onnx", load_external_data=True)
            if dynamic_batch_axes:
                # Fix labels of dynamic axes since they can't be specified during Dynamo export currently
                onnx_model.graph.input[0].type.tensor_type.shape.dim[0].dim_param = "batch_size"
                for i in range(3):
                    onnx_model.graph.output[i].type.tensor_type.shape.dim[0].dim_param = "batch_size"

            onnx_model_helper = DynamoOnnxHelper(onnx_model)
            onnx_model_helper.convert_constants_to_initializers()
            if clear_dynamo_metadata:
                onnx_model_helper.clear_metadata()

            import os  # noqa: PLC0415

            if os.path.exists(onnx_model_path):
                os.remove(onnx_model_path)
            if os.path.exists(onnx_model_path + ".data"):
                os.remove(onnx_model_path + ".data")
            onnx_model_helper.model.save_model_to_file(
                onnx_model_path, use_external_data_format=True, all_tensors_to_one_file=True, convert_attribute=True
            )

    print("encoder onnx model saved to", onnx_model_path)


def test_image_encoder_onnx(
    sam2_model: SAM2Base,
    onnx_model_path: str,
    dynamic_batch_axes=False,
):
    ort_session = onnxruntime.InferenceSession(onnx_model_path, providers=["CPUExecutionProvider"])

    model_inputs = ort_session.get_inputs()
    input_names = [model_inputs[i].name for i in range(len(model_inputs))]
    logger.info("input_names: %s", input_names)

    model_outputs = ort_session.get_outputs()
    output_names = [model_outputs[i].name for i in range(len(model_outputs))]
    logger.info("output_names: %s", output_names)

    batch_sizes = [1, 2] if dynamic_batch_axes else [1]
    for batch_size in batch_sizes:
        image = random_sam2_input_image(batch_size)

        sam2_encoder = SAM2ImageEncoder(sam2_model).cpu()
        image_features_0, image_features_1, image_embeddings = sam2_encoder(image.clone())

        logger.info("image.shape: %s", image.shape)
        logger.info("image_features_0.shape: %s", image_features_0.shape)
        logger.info("image_features_1.shape: %s", image_features_1.shape)
        logger.info("image_embeddings.shape: %s", image_embeddings.shape)

        outputs = ort_session.run(output_names, {"image": image.numpy()})
        for i, output_name in enumerate(output_names):
            logger.info("output %s shape %s", output_name, outputs[i].shape)
        ort_image_features_0, ort_image_features_1, ort_image_embeddings = outputs

        # ONNXRuntime and PyTorch has about 0.75% mismatched elements, but seems not impacting segmentation results.
        if (
            compare_tensors_with_tolerance(
                "image_features_0",
                image_features_0,
                torch.tensor(ort_image_features_0),
                mismatch_percentage_tolerance=1,
            )
            and compare_tensors_with_tolerance(
                "image_features_1",
                image_features_1,
                torch.tensor(ort_image_features_1),
                mismatch_percentage_tolerance=1,
            )
            and compare_tensors_with_tolerance(
                "image_embeddings",
                image_embeddings,
                torch.tensor(ort_image_embeddings),
                mismatch_percentage_tolerance=1,
            )
        ):
            print(f"onnx model has been verified for batch_size={batch_size}: {onnx_model_path}")
        else:
            print(f"onnx model verification failed for batch_size={batch_size}: {onnx_model_path}")
