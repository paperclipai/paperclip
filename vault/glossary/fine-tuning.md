---
term: "Fine-tuning"
definition: "Fine-tuning is the process of further training a pre-trained large language model on a smaller, task-specific dataset to specialize its behavior — adjusting either all model weights (full fine-tuning) or a small adapter layer (parameter-efficient fine-tuning, e.g., LoRA, QLoRA)."
category: "training"
related_terms: [llm, rlhf, lora]
related_courses: []
sameAs:
  - https://en.wikipedia.org/wiki/Fine-tuning_(deep_learning)
---

Common fine-tuning workflows in 2026 include: instruction tuning (teaching a base model to follow instructions, typically using supervised fine-tuning on instruction-response pairs); domain adaptation (specializing a model for medical, legal, or proprietary corpora); style adaptation (matching a brand voice or persona); and tool-use fine-tuning (improving function-calling accuracy on a fixed tool surface).

Parameter-efficient methods dominate practical fine-tuning. LoRA (Low-Rank Adaptation, Hu et al. 2021) trains a small rank-decomposition matrix while keeping base weights frozen; QLoRA adds 4-bit quantization to fit larger models on smaller hardware. These cut memory cost 4-16× with minimal quality loss.

When fine-tuning is the right tool: when prompt engineering and RAG cannot achieve the desired behavior, when you need a smaller model to behave like a larger one (distillation), or when latency requirements demand a specialized smaller deployment. Most production AI applications do not fine-tune; prompting + RAG + agent loops are usually sufficient.
