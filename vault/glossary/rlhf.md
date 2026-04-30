---
term: "Reinforcement Learning from Human Feedback (RLHF)"
definition: "Reinforcement Learning from Human Feedback (RLHF) is a training technique in which a language model's policy is fine-tuned using a reward model that has been trained on human preference rankings, aligning model output with human-judged quality on dimensions like helpfulness and harmlessness."
category: "training"
related_terms: [llm, fine-tuning, constitutional-ai, dpo]
related_courses: []
sameAs:
  - https://en.wikipedia.org/wiki/Reinforcement_learning_from_human_feedback
  - https://arxiv.org/abs/2203.02155
---

RLHF was popularized by OpenAI's InstructGPT paper (Ouyang et al., 2022) and is the canonical alignment technique behind ChatGPT's helpful-assistant behavior. The pipeline has three stages: supervised fine-tuning on human-written demonstrations, reward-model training on human-ranked output pairs, and policy optimization via PPO (or increasingly DPO, which collapses the latter two stages into a single supervised loss).

Anthropic's Constitutional AI extends RLHF by adding a self-critique step: the model rewrites its own outputs against a written constitution before the human-feedback stage, reducing the volume of harmful-output labeling humans must do. RLHF and Constitutional AI together explain most of Claude's safety behavior.

Newer variants include DPO (Direct Preference Optimization, Rafailov et al. 2023), which avoids the explicit reward model; KTO (Kahneman-Tversky Optimization), which uses single-output binary feedback; and online RLHF, which continuously collects preference data from production deployments.
