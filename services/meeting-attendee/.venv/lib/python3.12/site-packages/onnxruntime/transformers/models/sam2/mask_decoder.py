# -------------------------------------------------------------------------
# Copyright (R) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
import logging
import warnings

import torch
from image_encoder import SAM2ImageEncoder, random_sam2_input_image
from prompt_encoder import SAM2PromptEncoder
from sam2.modeling.sam2_base import SAM2Base
from torch import nn

logger = logging.getLogger(__name__)


class SAM2MaskDecoder(nn.Module):
    def __init__(
        self,
        sam_model: SAM2Base,
        multimask_output: bool,
        dynamic_multimask_via_stability: bool = True,
    ) -> None:
        super().__init__()
        self.mask_decoder = sam_model.sam_mask_decoder
        self.prompt_encoder = sam_model.sam_prompt_encoder
        self.model = sam_model
        self.multimask_output = multimask_output
        self.dynamic_multimask_via_stability = dynamic_multimask_via_stability

    @torch.no_grad()
    def forward(
        self,
        image_features_0: torch.Tensor,
        image_features_1: torch.Tensor,
        image_embeddings: torch.Tensor,
        image_pe: torch.Tensor,
        sparse_embeddings: torch.Tensor,
        dense_embeddings: torch.Tensor,
    ):
        """
        Decode masks from image and prompt embeddings. Only support H=W=1024.

        Args:
            image_features_0 (torch.Tensor): [1, 32, H/4, W/4]. high resolution features of level 0 from image encoder.
            image_features_1 (torch.Tensor): [1, 64, H/8, W/8]. high resolution features of level 1 from image encoder.
            image_embeddings (torch.Tensor): [1, 256, H/16, W/16]. image embedding from image encoder.
            image_pe (torch.Tensor): [1, 256, H/16, W/16]. image positional encoding.
            sparse_embeddings (torch.Tensor): [L, P+1, 256], embedding for points and boxes.
            dense_embeddings (torch.Tensor):  [L, 256, H/16, W/16]. embedding for input masks.

        Returns:
            low_res_masks (torch.Tensor, optional): [1, M, H/4, W/4]. low resolution masks.
            iou_predictions (torch.Tensor): [1, M]. scores for M masks.
        """
        low_res_masks, iou_predictions, _, _ = self.mask_decoder.predict_masks(
            image_embeddings=image_embeddings,
            image_pe=image_pe,
            sparse_prompt_embeddings=sparse_embeddings,
            dense_prompt_embeddings=dense_embeddings,
            repeat_image=sparse_embeddings.shape[0] > 1,  # batch mode
            high_res_features=[image_features_0, image_features_1],
        )

        if self.multimask_output:
            low_res_masks = low_res_masks[:, 1:, :, :]
            iou_predictions = iou_predictions[:, 1:]
        elif self.dynamic_multimask_via_stability:
            # When outputting a single mask, if the stability score from the current single-mask
            # output (based on output token 0) falls below a threshold, we instead select from
            # multi-mask outputs (based on output token 1~3) the mask with the highest predicted IoU score.
            low_res_masks, iou_predictions = self.mask_decoder._dynamic_multimask_via_stability(
                low_res_masks, iou_predictions
            )
        else:
            low_res_masks = low_res_masks[:, 0:1, :, :]
            iou_predictions = iou_predictions[:, 0:1]

        return low_res_masks, iou_predictions


def export_mask_decoder_onnx(
    sam2_model: SAM2Base,
    onnx_model_path: str,
    multimask_output: bool,
    dynamic_multimask_via_stability: bool = True,
    verbose=False,
):
    sam2_prompt_encoder = SAM2PromptEncoder(sam2_model).cpu()

    image = random_sam2_input_image()
    sam2_encoder = SAM2ImageEncoder(sam2_model).cpu()
    image_features_0, image_features_1, image_embeddings = sam2_encoder(image)
    logger.info("image_features_0.shape: %s", image_features_0.shape)
    logger.info("image_features_1.shape: %s", image_features_1.shape)
    logger.info("image_embeddings.shape: %s", image_embeddings.shape)

    # encode an random prompt
    num_labels = 2
    num_points = 3
    point_coords = torch.randint(low=0, high=1024, size=(num_labels, num_points, 2), dtype=torch.float)
    point_labels = torch.randint(low=0, high=1, size=(num_labels, num_points), dtype=torch.float)
    input_masks = torch.zeros(num_labels, 1, 256, 256, dtype=torch.float)
    has_input_masks = torch.ones(1, dtype=torch.float)

    sparse_embeddings, dense_embeddings, image_pe = sam2_prompt_encoder(
        point_coords, point_labels, input_masks, has_input_masks
    )

    logger.info("sparse_embeddings.shape: %s", sparse_embeddings.shape)
    logger.info("dense_embeddings.shape: %s", dense_embeddings.shape)
    logger.info("image_pe.shape: %s", image_pe.shape)

    sam2_mask_decoder = SAM2MaskDecoder(sam2_model, multimask_output, dynamic_multimask_via_stability)
    inputs = (image_features_0, image_features_1, image_embeddings, image_pe, sparse_embeddings, dense_embeddings)
    low_res_masks, iou_predictions = sam2_mask_decoder(*inputs)
    logger.info("low_res_masks.shape: %s", low_res_masks.shape)
    logger.info("iou_predictions.shape: %s", iou_predictions.shape)

    with warnings.catch_warnings():
        if not verbose:
            warnings.filterwarnings("ignore", category=torch.jit.TracerWarning)
            warnings.filterwarnings("ignore", category=UserWarning)
        torch.onnx.export(
            sam2_mask_decoder,
            inputs,
            onnx_model_path,
            export_params=True,
            opset_version=18,
            do_constant_folding=True,
            input_names=[
                "image_features_0",
                "image_features_1",
                "image_embeddings",
                "image_pe",
                "sparse_embeddings",
                "dense_embeddings",
            ],
            output_names=["low_res_masks", "iou_predictions"],
            dynamic_axes={
                "sparse_embeddings": {0: "num_labels", 1: "num_points+1"},
                "dense_embeddings": {0: "num_labels"},
                "low_res_masks": {0: "num_labels"},
                "iou_predictions": {0: "num_labels"},
            },
        )

    print("mask decoder onnx model saved to", onnx_model_path)


def test_mask_decoder_onnx(
    sam2_model: SAM2Base,
    onnx_model_path: str,
    multimask_output: bool,
    dynamic_multimask_via_stability: bool,
):
    sam2_prompt_encoder = SAM2PromptEncoder(sam2_model).cpu()

    image = random_sam2_input_image()
    sam2_encoder = SAM2ImageEncoder(sam2_model).cpu()
    image_features_0, image_features_1, image_embeddings = sam2_encoder(image)

    num_labels = 1
    num_points = 5
    point_coords = torch.randint(low=0, high=1024, size=(num_labels, num_points, 2), dtype=torch.float)
    point_labels = torch.randint(low=0, high=1, size=(num_labels, num_points), dtype=torch.float)
    input_masks = torch.rand(num_labels, 1, 256, 256, dtype=torch.float)
    has_input_masks = torch.ones(1, dtype=torch.float)

    sparse_embeddings, dense_embeddings, image_pe = sam2_prompt_encoder(
        point_coords, point_labels, input_masks, has_input_masks
    )

    sam2_mask_decoder = SAM2MaskDecoder(sam2_model, multimask_output, dynamic_multimask_via_stability)
    inputs = (image_features_0, image_features_1, image_embeddings, image_pe, sparse_embeddings, dense_embeddings)
    low_res_masks, iou_predictions = sam2_mask_decoder(*inputs)

    import onnxruntime  # noqa: PLC0415

    ort_session = onnxruntime.InferenceSession(onnx_model_path, providers=["CPUExecutionProvider"])

    model_inputs = ort_session.get_inputs()
    input_names = [model_inputs[i].name for i in range(len(model_inputs))]
    logger.info("input_names: %s", input_names)

    model_outputs = ort_session.get_outputs()
    output_names = [model_outputs[i].name for i in range(len(model_outputs))]
    logger.info("output_names: %s", output_names)

    outputs = ort_session.run(
        output_names,
        {
            "image_features_0": image_features_0.numpy(),
            "image_features_1": image_features_1.numpy(),
            "image_embeddings": image_embeddings.numpy(),
            "image_pe": image_pe.numpy(),
            "sparse_embeddings": sparse_embeddings.numpy(),
            "dense_embeddings": dense_embeddings.numpy(),
        },
    )

    for i, output_name in enumerate(output_names):
        logger.info("output %s shape: %s", output_name, outputs[i].shape)

    ort_low_res_masks, ort_iou_predictions = outputs
    torch.testing.assert_close(low_res_masks, torch.tensor(ort_low_res_masks), atol=5e-3, rtol=1e-4)
    torch.testing.assert_close(iou_predictions, torch.tensor(ort_iou_predictions), atol=5e-3, rtol=1e-4)
    print(f"onnx model has been verified: {onnx_model_path}")
