# -------------------------------------------------------------------------
# Copyright (R) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
import logging

import torch
from sam2.modeling.sam2_base import SAM2Base
from sam2_utils import compare_tensors_with_tolerance
from torch import nn

logger = logging.getLogger(__name__)


class SAM2PromptEncoder(nn.Module):
    def __init__(self, sam_model: SAM2Base):
        super().__init__()
        self.prompt_encoder = sam_model.sam_prompt_encoder
        self.model = sam_model

    @torch.no_grad()
    def forward(
        self,
        point_coords: torch.Tensor,
        point_labels: torch.Tensor,
        input_masks: torch.Tensor,
        has_input_masks: torch.Tensor,
    ):
        """Encode prompts.

           Args:
            point_coords (torch.Tensor): [L, P, 2] shape and float32 dtype and contains the absolute pixel
                                         coordinate in (x, y) format of the P input points in image of size 1024x1024.
            point_labels (torch.Tensor): shape [L, P] and int32 dtype, where 1 means
                                         positive (foreground), 0 means negative (background), -1 means padding,
                                         2 (box left upper corner), 3 (box right bottom corner).
            input_masks (torch.Tensor): [L, 1, H/4, W/4]. Low resolution mask input to the model.
                                        Typically coming from a previous iteration.
            has_input_masks (torch.Tensor): [L]. 1.0 if input_masks is used, 0.0 otherwise.
        Returns:
            sparse_embeddings (torch.Tensor): [L, P+1, 256], embedding for points and boxes.
            dense_embeddings (torch.Tensor):  [L, 256, 64, 64]. embedding for input masks.
            image_pe (torch.Tensor, optional): [1, 256, 64, 64]. image positional encoding.
        """
        sparse_embeddings = self._embed_points(point_coords, point_labels)
        dense_embeddings = self._embed_masks(input_masks, has_input_masks)
        image_pe = self.prompt_encoder.get_dense_pe()

        return sparse_embeddings, dense_embeddings, image_pe

    def _embed_points(self, point_coords: torch.Tensor, point_labels: torch.Tensor) -> torch.Tensor:
        point_coords = point_coords + 0.5

        padding_point = torch.zeros((point_coords.shape[0], 1, 2), device=point_coords.device)
        padding_label = -torch.ones((point_labels.shape[0], 1), device=point_labels.device)
        point_coords = torch.cat([point_coords, padding_point], dim=1)
        point_labels = torch.cat([point_labels, padding_label], dim=1)

        # Note that the input coordinates are based on image size 1024x1024. Here we normalize it to [0.0, 1.0).
        point_coords[:, :, 0] = point_coords[:, :, 0] / self.model.image_size
        point_coords[:, :, 1] = point_coords[:, :, 1] / self.model.image_size

        point_embedding = self.prompt_encoder.pe_layer._pe_encoding(point_coords)
        point_labels = point_labels.unsqueeze(-1).expand_as(point_embedding)

        point_embedding = point_embedding * (point_labels != -1)
        point_embedding = point_embedding + self.prompt_encoder.not_a_point_embed.weight * (point_labels == -1)

        for i in range(self.prompt_encoder.num_point_embeddings):
            point_embedding = point_embedding + self.prompt_encoder.point_embeddings[i].weight * (point_labels == i)

        return point_embedding

    def _embed_masks(self, input_masks: torch.Tensor, has_input_masks: torch.Tensor) -> torch.Tensor:
        mask_embedding = self.prompt_encoder.mask_downscaling(input_masks)
        no_mask_embedding = self.prompt_encoder.no_mask_embed.weight.reshape(1, -1, 1, 1)
        logger.info("no_mask_embedding.shape: %s", no_mask_embedding.shape)
        mask_embedding = has_input_masks * mask_embedding + (1.0 - has_input_masks) * no_mask_embedding
        logger.info("mask_embedding.shape: %s", mask_embedding.shape)
        return mask_embedding


def export_prompt_encoder_onnx(
    sam2_model: SAM2Base,
    onnx_model_path: str,
):
    sam2_prompt_encoder = SAM2PromptEncoder(sam2_model).cpu()

    num_labels = 2
    num_points = 3
    point_coords = torch.randint(low=0, high=1024, size=(num_labels, num_points, 2), dtype=torch.float)
    point_labels = torch.randint(low=0, high=1, size=(num_labels, num_points), dtype=torch.int32)
    input_masks = torch.zeros(num_labels, 1, 256, 256, dtype=torch.float)
    has_input_masks = torch.ones(1, dtype=torch.float)

    sparse_embeddings, dense_embeddings, image_pe = sam2_prompt_encoder(
        point_coords, point_labels, input_masks, has_input_masks
    )

    logger.info("point_coords.shape: %s", point_coords.shape)
    logger.info("point_labels.shape: %s", point_labels.shape)
    logger.info("input_masks.shape: %s", input_masks.shape)
    logger.info("has_input_masks.shape: %s", has_input_masks.shape)

    logger.info("sparse_embeddings.shape: %s", sparse_embeddings.shape)
    logger.info("dense_embeddings.shape: %s", dense_embeddings.shape)
    logger.info("image_pe.shape: %s", image_pe.shape)

    torch.onnx.export(
        sam2_prompt_encoder,
        (point_coords, point_labels, input_masks, has_input_masks),
        onnx_model_path,
        export_params=True,
        opset_version=18,
        do_constant_folding=True,
        input_names=["point_coords", "point_labels", "input_masks", "has_input_masks"],
        output_names=["sparse_embeddings", "dense_embeddings", "image_pe"],
        dynamic_axes={
            "point_coords": {0: "num_labels", 1: "num_points"},
            "point_labels": {0: "num_labels", 1: "num_points"},
            "input_masks": {0: "num_labels"},
            "sparse_embeddings": {0: "num_labels", 1: "num_points+1"},
            "dense_embeddings": {0: "num_labels"},
        },
    )

    print("prompt encoder onnx model saved to ", onnx_model_path)


def test_prompt_encoder_onnx(
    sam2_model: SAM2Base,
    onnx_model_path: str,
):
    sam2_prompt_encoder = SAM2PromptEncoder(sam2_model).cpu()

    num_labels = 1
    num_points = 5
    point_coords = torch.randint(low=0, high=1024, size=(num_labels, num_points, 2), dtype=torch.float)
    point_labels = torch.randint(low=0, high=1, size=(num_labels, num_points), dtype=torch.int32)
    input_masks = torch.rand(num_labels, 1, 256, 256, dtype=torch.float)
    has_input_masks = torch.ones(1, dtype=torch.float)

    sparse_embeddings, dense_embeddings, image_pe = sam2_prompt_encoder(
        point_coords, point_labels, input_masks, has_input_masks
    )

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
            "point_coords": point_coords.numpy(),
            "point_labels": point_labels.numpy(),
            "input_masks": input_masks.numpy(),
            "has_input_masks": has_input_masks.numpy(),
        },
    )

    for i, output_name in enumerate(output_names):
        logger.info("output %s shape: %s", output_name, outputs[i].shape)

    ort_sparse_embeddings, ort_dense_embeddings, ort_image_pe = outputs
    if (
        compare_tensors_with_tolerance(
            "sparse_embeddings",
            sparse_embeddings,
            torch.tensor(ort_sparse_embeddings),
            mismatch_percentage_tolerance=0.2,
        )
        and compare_tensors_with_tolerance(
            "dense_embeddings", dense_embeddings, torch.tensor(ort_dense_embeddings), mismatch_percentage_tolerance=0.2
        )
        and compare_tensors_with_tolerance(
            "image_pe", image_pe, torch.tensor(ort_image_pe), mismatch_percentage_tolerance=0.2
        )
    ):
        print(f"onnx model has been verified: {onnx_model_path}")
    else:
        print(f"onnx model verification failed: {onnx_model_path}")
