# -------------------------------------------------------------------------
# Copyright (R) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
import logging
import warnings

import torch
import torch.nn.functional as F
from image_encoder import SAM2ImageEncoder, random_sam2_input_image
from mask_decoder import SAM2MaskDecoder
from prompt_encoder import SAM2PromptEncoder
from sam2.modeling.sam2_base import SAM2Base
from sam2_utils import compare_tensors_with_tolerance
from torch import nn

logger = logging.getLogger(__name__)


class SAM2ImageDecoder(nn.Module):
    def __init__(
        self,
        sam_model: SAM2Base,
        multimask_output: bool,
        dynamic_multimask_via_stability: bool = True,
        return_logits: bool = False,
        mask_threshold: float = 0.0,
    ) -> None:
        super().__init__()
        self.prompt_encoder = SAM2PromptEncoder(sam_model)
        self.mask_decoder = SAM2MaskDecoder(sam_model, multimask_output, dynamic_multimask_via_stability)
        self.return_logits = return_logits
        self.mask_threshold = mask_threshold

    @torch.no_grad()
    def forward(
        self,
        image_features_0: torch.Tensor,
        image_features_1: torch.Tensor,
        image_embeddings: torch.Tensor,
        point_coords: torch.Tensor,
        point_labels: torch.Tensor,
        input_masks: torch.Tensor,
        has_input_masks: torch.Tensor,
        original_image_size: torch.Tensor,
        enable_nvtx_profile: bool = False,
    ):
        """
        Decode masks from image features and prompts. Batched images are not supported. H=W=1024.

        Args:
            image_features_0 (torch.Tensor): [1, 32, H/4, W/4]. high resolution features of level 0 from image encoder.
            image_features_1 (torch.Tensor): [1, 64, H/8, W/8]. high resolution features of level 1 from image encoder.
            image_embeddings (torch.Tensor): [1, 256, H/16, W/16]. image embedding from image encoder.
            point_coords (torch.Tensor): [L, P, 2] shape and float32 dtype and contains the absolute pixel
                                         coordinate in (x, y) format of the P input points in image of size 1024x1024.
            point_labels (torch.Tensor): shape [L, P] and int32 dtype, where 1 means
                                         positive (foreground), 0 means negative (background), -1 means padding,
                                         2 (box left upper corner), 3 (box right bottom corner).
            input_masks (torch.Tensor): [L, 1, H/4, W/4]. Low resolution mask input to the model.
                                        Typically coming from a previous iteration.
            has_input_masks (torch.Tensor): [L]. 1.0 if input_masks is used, 0.0 otherwise.
            original_image_size(torch.Tensor): [2]. original image size H_o, W_o.
            enable_nvtx_profile (bool): enable NVTX profiling.

        Returns:
            masks (torch.Tensor): [1, M, H_o, W_o] where M=3 or 1. Masks of original image size.
            iou_predictions (torch.Tensor): [1, M]. scores for M masks.
            low_res_masks (torch.Tensor, optional): [1, M, H/4, W/4]. low resolution masks.
        """
        nvtx_helper = None
        if enable_nvtx_profile:
            from nvtx_helper import NvtxHelper  # noqa: PLC0415

            nvtx_helper = NvtxHelper(["prompt_encoder", "mask_decoder", "post_process"])

        if nvtx_helper is not None:
            nvtx_helper.start_profile("prompt_encoder", color="blue")

        sparse_embeddings, dense_embeddings, image_pe = self.prompt_encoder(
            point_coords, point_labels, input_masks, has_input_masks
        )

        if nvtx_helper is not None:
            nvtx_helper.stop_profile("prompt_encoder")
            nvtx_helper.start_profile("mask_decoder", color="red")

        low_res_masks, iou_predictions = self.mask_decoder(
            image_features_0, image_features_1, image_embeddings, image_pe, sparse_embeddings, dense_embeddings
        )

        if nvtx_helper is not None:
            nvtx_helper.stop_profile("mask_decoder")
            nvtx_helper.start_profile("post_process", color="green")

        # Interpolate the low resolution masks back to the original image size.
        masks = F.interpolate(
            low_res_masks,
            (original_image_size[0], original_image_size[1]),
            mode="bilinear",
            align_corners=False,  # Note that align_corners=True has less mismatches during comparing ORT and PyTorch.
        )

        low_res_masks = torch.clamp(low_res_masks, -32.0, 32.0)
        if not self.return_logits:
            masks = masks > self.mask_threshold

        if nvtx_helper is not None:
            nvtx_helper.stop_profile("post_process")
            nvtx_helper.print_latency()

        return masks, iou_predictions, low_res_masks


def export_decoder_onnx(
    sam2_model: SAM2Base,
    onnx_model_path: str,
    multimask_output: bool = False,
    verbose: bool = False,
):
    batch_size = 1
    image = random_sam2_input_image(batch_size)
    sam2_encoder = SAM2ImageEncoder(sam2_model).cpu()
    image_features_0, image_features_1, image_embeddings = sam2_encoder(image)

    logger.info("image_features_0.shape: %s", image_features_0.shape)
    logger.info("image_features_1.shape: %s", image_features_1.shape)
    logger.info("image_embeddings.shape: %s", image_embeddings.shape)

    sam2_decoder = SAM2ImageDecoder(
        sam2_model,
        multimask_output=multimask_output,
        dynamic_multimask_via_stability=True,
    ).cpu()

    num_labels = 2
    num_points = 3
    point_coords = torch.randint(low=0, high=1024, size=(num_labels, num_points, 2), dtype=torch.float)
    point_labels = torch.randint(low=0, high=1, size=(num_labels, num_points), dtype=torch.int32)
    input_masks = torch.zeros(num_labels, 1, 256, 256, dtype=torch.float)
    has_input_masks = torch.ones(1, dtype=torch.float)
    original_image_size = torch.tensor([1200, 1800], dtype=torch.int32)

    example_inputs = (
        image_features_0,
        image_features_1,
        image_embeddings,
        point_coords,
        point_labels,
        input_masks,
        has_input_masks,
        original_image_size,
    )

    logger.info("point_coords.shape: %s", point_coords.shape)
    logger.info("point_labels.shape: %s", point_labels.shape)
    logger.info("input_masks.shape: %s", input_masks.shape)
    logger.info("has_input_masks.shape: %s", has_input_masks.shape)
    logger.info("original_image_size.shape: %s", original_image_size.shape)

    if verbose:
        masks, iou_predictions, low_res_masks = sam2_decoder(*example_inputs)
        logger.info("masks.shape: %s", masks.shape)
        logger.info("iou_predictions.shape: %s", iou_predictions.shape)
        logger.info("low_res_masks.shape: %s", low_res_masks.shape)

    input_names = [
        "image_features_0",
        "image_features_1",
        "image_embeddings",
        "point_coords",
        "point_labels",
        "input_masks",
        "has_input_masks",
        "original_image_size",
    ]

    output_names = ["masks", "iou_predictions", "low_res_masks"]

    dynamic_axes = {
        "point_coords": {0: "num_labels", 1: "num_points"},
        "point_labels": {0: "num_labels", 1: "num_points"},
        "input_masks": {0: "num_labels"},
        "has_input_masks": {0: "num_labels"},
        "masks": {0: "num_labels", 2: "original_image_height", 3: "original_image_width"},
        "low_res_masks": {0: "num_labels"},
        "iou_predictions": {0: "num_labels"},
    }

    with warnings.catch_warnings():
        if not verbose:
            warnings.filterwarnings("ignore", category=torch.jit.TracerWarning)
            warnings.filterwarnings("ignore", category=UserWarning)

        torch.onnx.export(
            sam2_decoder,
            example_inputs,
            onnx_model_path,
            export_params=True,
            opset_version=16,
            do_constant_folding=True,
            input_names=input_names,
            output_names=output_names,
            dynamic_axes=dynamic_axes,
        )

    logger.info("decoder onnx model saved to %s", onnx_model_path)


def test_decoder_onnx(
    sam2_model: SAM2Base,
    onnx_model_path: str,
    multimask_output=False,
):
    batch_size = 1
    image = random_sam2_input_image(batch_size)
    sam2_encoder = SAM2ImageEncoder(sam2_model).cpu()
    image_features_0, image_features_1, image_embeddings = sam2_encoder(image)

    sam2_image_decoder = SAM2ImageDecoder(
        sam2_model,
        multimask_output=multimask_output,
        dynamic_multimask_via_stability=True,
    ).cpu()

    num_labels = 1
    num_points = 5
    point_coords = torch.randint(low=0, high=1024, size=(num_labels, num_points, 2), dtype=torch.float)
    point_labels = torch.randint(low=0, high=1, size=(num_labels, num_points), dtype=torch.int32)
    input_masks = torch.zeros(num_labels, 1, 256, 256, dtype=torch.float)
    has_input_masks = torch.zeros(1, dtype=torch.float)
    original_image_size = torch.tensor([1500, 1500], dtype=torch.int32)

    example_inputs = (
        image_features_0,
        image_features_1,
        image_embeddings,
        point_coords,
        point_labels,
        input_masks,
        has_input_masks,
        original_image_size,
    )

    masks, iou_predictions, low_res_masks = sam2_image_decoder(*example_inputs)

    import onnxruntime  # noqa: PLC0415

    ort_session = onnxruntime.InferenceSession(onnx_model_path, providers=["CPUExecutionProvider"])

    model_inputs = ort_session.get_inputs()
    input_names = [model_inputs[i].name for i in range(len(model_inputs))]
    logger.info("input_names: %s", input_names)

    model_outputs = ort_session.get_outputs()
    output_names = [model_outputs[i].name for i in range(len(model_outputs))]
    logger.info("output_names: %s", output_names)
    inputs = {model_inputs[i].name: example_inputs[i].numpy() for i in range(len(model_inputs))}
    outputs = ort_session.run(output_names, inputs)

    for i, output_name in enumerate(output_names):
        logger.info(f"{output_name}.shape: %s", outputs[i].shape)

    ort_masks, ort_iou_predictions, ort_low_res_masks = outputs
    if (
        compare_tensors_with_tolerance("masks", masks.float(), torch.tensor(ort_masks).float())
        and compare_tensors_with_tolerance("iou_predictions", iou_predictions, torch.tensor(ort_iou_predictions))
        and compare_tensors_with_tolerance("low_res_masks", low_res_masks, torch.tensor(ort_low_res_masks))
    ):
        print("onnx model has been verified:", onnx_model_path)
    else:
        print("onnx model verification failed:", onnx_model_path)
