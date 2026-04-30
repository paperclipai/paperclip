# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.  See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------

# Maps model class name to a tuple of model class
MODEL_CLASSES = [
    "AutoModel",
    "AutoModelWithLMHead",
    "AutoModelForSequenceClassification",
    "AutoModelForQuestionAnswering",
    "AutoModelForCausalLM",
]

# Pretrained model name to a tuple of input names, opset_version, use_external_data_format, optimization model type
# Some models like GPT, T5, Bart etc has its own convert_to_onnx.py in models sub-directory, and they are excluded here.
MODELS = {
    # BERT
    "bert-base-cased": (["input_ids", "attention_mask", "token_type_ids"], 16, False, "bert"),
    "bert-large-cased": (["input_ids", "attention_mask", "token_type_ids"], 16, False, "bert"),
    # Transformer-XL (Models uses Einsum, which need opset version 16 or later.)
    "transfo-xl-wt103": (["input_ids", "mems"], 16, False, "bert"),
    # XLNet
    "xlnet-base-cased": (["input_ids"], 16, False, "bert"),
    "xlnet-large-cased": (["input_ids"], 16, False, "bert"),
    # XLM
    "xlm-mlm-en-2048": (["input_ids"], 16, True, "bert"),
    "xlm-mlm-ende-1024": (["input_ids"], 16, False, "bert"),
    "xlm-mlm-enfr-1024": (["input_ids"], 16, False, "bert"),
    # RoBERTa
    "roberta-base": (["input_ids", "attention_mask"], 16, False, "bert"),
    "roberta-large": (["input_ids", "attention_mask"], 16, False, "bert"),
    "roberta-large-mnli": (["input_ids", "attention_mask"], 16, False, "bert"),
    "deepset/roberta-base-squad2": (["input_ids", "attention_mask"], 16, False, "bert"),
    "distilroberta-base": (["input_ids", "attention_mask"], 16, False, "bert"),
    # DistilBERT
    "distilbert-base-uncased": (["input_ids", "attention_mask"], 16, False, "bert"),
    "distilbert-base-uncased-distilled-squad": (["input_ids", "attention_mask"], 16, False, "bert"),
    # CTRL
    "ctrl": (["input_ids"], 16, True, "bert"),
    # CamemBERT
    "camembert-base": (["input_ids"], 16, False, "bert"),
    # ALBERT
    "albert-base-v1": (["input_ids"], 16, False, "bert"),
    "albert-large-v1": (["input_ids"], 16, False, "bert"),
    "albert-xlarge-v1": (["input_ids"], 16, True, "bert"),
    # "albert-xxlarge-v1": (["input_ids"], 16, True, "bert"),
    "albert-base-v2": (["input_ids"], 16, False, "bert"),
    "albert-large-v2": (["input_ids"], 16, False, "bert"),
    "albert-xlarge-v2": (["input_ids"], 16, True, "bert"),
    # "albert-xxlarge-v2": (["input_ids"], 16, True, "bert"),
    # XLM-RoBERTa
    "xlm-roberta-base": (["input_ids"], 16, False, "bert"),
    "xlm-roberta-large": (["input_ids"], 16, True, "bert"),
    # FlauBERT
    "flaubert/flaubert_small_cased": (["input_ids"], 16, False, "bert"),
    "flaubert/flaubert_base_cased": (["input_ids"], 16, False, "bert"),
    # "flaubert/flaubert_large_cased": (["input_ids"], 16, False, "bert"),
    # Layoutlm
    "microsoft/layoutlm-base-uncased": (["input_ids"], 16, False, "bert"),
    "microsoft/layoutlm-large-uncased": (["input_ids"], 16, False, "bert"),
    # Squeezebert
    "squeezebert/squeezebert-uncased": (["input_ids"], 16, False, "bert"),
    "squeezebert/squeezebert-mnli": (["input_ids"], 16, False, "bert"),
    "squeezebert/squeezebert-mnli-headless": (["input_ids"], 16, False, "bert"),
    "unc-nlp/lxmert-base-uncased": (["input_ids", "visual_feats", "visual_pos"], 16, False, "bert"),
    # ViT
    "google/vit-base-patch16-224": (["pixel_values"], 16, False, "vit"),
    # Swin
    "microsoft/swin-base-patch4-window7-224": (["pixel_values"], 16, False, "swin"),
    "microsoft/swin-small-patch4-window7-224": (["pixel_values"], 16, False, "swin"),
    "microsoft/swin-tiny-patch4-window7-224": (["pixel_values"], 16, False, "swin"),
}
