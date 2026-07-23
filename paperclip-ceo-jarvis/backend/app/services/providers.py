from __future__ import annotations

from datetime import datetime



def _model(model_id: str, name: str, context_window: str, modalities: list[str], notes: str = "") -> dict:
    return {
        "id": model_id,
        "name": name,
        "context_window": context_window,
        "modalities": modalities,
        "notes": notes,
    }



def _provider(provider_id: str, name: str, category: str, description: str, website: str, models: list[dict]) -> dict:
    return {
        "id": provider_id,
        "name": name,
        "category": category,
        "description": description,
        "website": website,
        "models": models,
        "refresh_mode": "catalog",
        "live_refresh_supported": True,
    }


CATALOG: list[dict] = [
    _provider("openai", "OpenAI", "frontier", "General-purpose frontier models for reasoning, coding, and multimodal work.", "https://openai.com", [
        _model("gpt-5", "GPT-5", "200k", ["text", "vision"], "Flagship reasoning and orchestration model."),
        _model("gpt-4.1", "GPT-4.1", "128k", ["text", "vision"], "Balanced high-quality general model."),
        _model("o4-mini", "o4-mini", "128k", ["text"], "Fast compact reasoning model."),
        _model("o3", "o3", "128k", ["text"], "Deep reasoning model for complex tasks."),
        _model("text-embedding-3-large", "text-embedding-3-large", "8k", ["text"], "Embedding model for semantic search."),
    ]),
    _provider("anthropic", "Anthropic", "frontier", "Claude family models for long-context analysis and writing.", "https://anthropic.com", [
        _model("claude-opus-4", "Claude Opus 4", "200k", ["text", "vision"], "Highest capability Claude model."),
        _model("claude-sonnet-4", "Claude Sonnet 4", "200k", ["text", "vision"], "Strong general-purpose model."),
        _model("claude-3.7-sonnet", "Claude 3.7 Sonnet", "200k", ["text", "vision"], "Previous generation reasoning model."),
        _model("claude-3.5-haiku", "Claude 3.5 Haiku", "200k", ["text", "vision"], "Fast compact model."),
    ]),
    _provider("google", "Google Gemini", "frontier", "Gemini models for multimodal reasoning and large-context work.", "https://ai.google.dev", [
        _model("gemini-2.5-pro", "Gemini 2.5 Pro", "1M", ["text", "vision", "audio"], "Flagship reasoning model."),
        _model("gemini-2.5-flash", "Gemini 2.5 Flash", "1M", ["text", "vision", "audio"], "Fast multimodal model."),
        _model("gemini-2.0-flash-lite", "Gemini 2.0 Flash Lite", "128k", ["text", "vision"], "Low-latency compact model."),
    ]),
    _provider("xai", "xAI", "frontier", "Grok models with long-form reasoning and search-style interaction.", "https://x.ai", [
        _model("grok-3", "Grok 3", "128k", ["text", "vision"], "Flagship Grok reasoning model."),
        _model("grok-3-mini", "Grok 3 Mini", "128k", ["text"], "Smaller fast Grok variant."),
        _model("grok-2", "Grok 2", "128k", ["text", "vision"], "Earlier frontier model."),
    ]),
    _provider("meta", "Meta", "open_weights", "Llama family open-weight models for broad deployment.", "https://ai.meta.com", [
        _model("llama-4-maverick", "Llama 4 Maverick", "128k", ["text", "vision"], "High-capacity multimodal Llama."),
        _model("llama-4-scout", "Llama 4 Scout", "128k", ["text", "vision"], "Fast multimodal Llama."),
        _model("llama-3.3-70b", "Llama 3.3 70B", "128k", ["text"], "Strong general open-weight model."),
        _model("llama-3.1-405b", "Llama 3.1 405B", "128k", ["text"], "Largest open-weight family model."),
    ]),
    _provider("mistral", "Mistral", "frontier", "High-performance European models for production use.", "https://mistral.ai", [
        _model("mistral-large-latest", "Mistral Large Latest", "128k", ["text", "vision"], "Flagship reasoning model."),
        _model("mistral-small-latest", "Mistral Small Latest", "128k", ["text", "vision"], "Fast compact model."),
        _model("codestral", "Codestral", "128k", ["text"], "Code-specialized model."),
        _model("ministral-8b", "Ministral 8B", "128k", ["text"], "Efficient compact model."),
    ]),
    _provider("cohere", "Cohere", "enterprise", "Enterprise LLMs, embeddings, and rerank models.", "https://cohere.com", [
        _model("command-r-plus", "Command R+", "128k", ["text"], "Retrieval-optimized flagship model."),
        _model("command-r", "Command R", "128k", ["text"], "General enterprise model."),
        _model("embed-v4.0", "Embed v4.0", "64k", ["text"], "Embedding model."),
        _model("rerank-v3.5", "Rerank v3.5", "64k", ["text"], "Ranking model for retrieval pipelines."),
    ]),
    _provider("ai21", "AI21", "enterprise", "Jamba and Jurassic family models for enterprise reasoning.", "https://ai21.com", [
        _model("jamba-1.5-large", "Jamba 1.5 Large", "256k", ["text"], "Long-context enterprise model."),
        _model("jamba-1.5-mini", "Jamba 1.5 Mini", "256k", ["text"], "Faster compact Jamba model."),
        _model("jurassic-2-ultra", "Jurassic-2 Ultra", "8k", ["text"], "Older high-capacity model."),
    ]),
    _provider("deepseek", "DeepSeek", "open_weights", "Strong open-weight reasoning and coding models.", "https://deepseek.com", [
        _model("deepseek-r1", "DeepSeek R1", "128k", ["text"], "Reasoning-focused model."),
        _model("deepseek-v3", "DeepSeek V3", "128k", ["text"], "General flagship model."),
        _model("deepseek-coder-v2", "DeepSeek Coder V2", "128k", ["text"], "Code-specialized model."),
    ]),
    _provider("qwen", "Qwen", "open_weights", "Alibaba Qwen models for multilingual and code-heavy work.", "https://qwenlm.github.io", [
        _model("qwen-max", "Qwen Max", "128k", ["text", "vision"], "Flagship model."),
        _model("qwen-plus", "Qwen Plus", "128k", ["text", "vision"], "Balanced model."),
        _model("qwen-turbo", "Qwen Turbo", "128k", ["text"], "Fast low-latency model."),
        _model("qwen2.5-72b-instruct", "Qwen2.5 72B Instruct", "128k", ["text"], "Popular open-weight instruct model."),
        _model("qwen2.5-coder-32b-instruct", "Qwen2.5 Coder 32B Instruct", "128k", ["text"], "Coding-specialized model."),
    ]),
    _provider("baidu", "Baidu ERNIE", "regional", "ERNIE models from Baidu for Chinese and multilingual deployments.", "https://yiyan.baidu.com", [
        _model("ernie-4.5", "ERNIE 4.5", "128k", ["text", "vision"], "Flagship ERNIE model."),
        _model("ernie-speed", "ERNIE Speed", "128k", ["text"], "Fast model."),
        _model("ernie-lite", "ERNIE Lite", "128k", ["text"], "Compact model."),
    ]),
    _provider("zhipu", "Zhipu AI", "regional", "GLM models for Chinese enterprise workflows.", "https://www.zhipuai.cn", [
        _model("glm-4-plus", "GLM-4 Plus", "128k", ["text", "vision"], "Flagship model."),
        _model("glm-4-air", "GLM-4 Air", "128k", ["text"], "Faster compact model."),
        _model("glm-4-9b", "GLM-4 9B", "128k", ["text"], "Open-weight compact model."),
    ]),
    _provider("moonshot", "Moonshot AI", "regional", "Kimi family long-context models.", "https://moonshot.cn", [
        _model("kimi-k2", "Kimi K2", "128k", ["text"], "Long-context reasoning model."),
        _model("kimi-latest", "Kimi Latest", "128k", ["text"], "Current general model."),
        _model("kimi-thinking", "Kimi Thinking", "128k", ["text"], "Deliberate reasoning model."),
    ]),
    _provider("minimax", "MiniMax", "regional", "Large-scale Chinese models for general and multimodal use.", "https://www.minimaxi.com", [
        _model("abab-6.5s", "ABAB 6.5S", "128k", ["text"], "Fast model."),
        _model("abab-6.5t", "ABAB 6.5T", "128k", ["text"], "Balanced model."),
        _model("abab-5.5s", "ABAB 5.5S", "128k", ["text"], "Compact model."),
    ]),
    _provider("stepfun", "StepFun", "regional", "Step series models for reasoning and multimodal tasks.", "https://www.stepfun.com", [
        _model("step-2-16k", "Step 2 16K", "16k", ["text"], "General model."),
        _model("step-1v-8k", "Step 1V 8K", "8k", ["text", "vision"], "Vision model."),
        _model("step-1.5v", "Step 1.5V", "32k", ["text", "vision"], "Improved multimodal model."),
    ]),
    _provider("yi", "01.AI", "open_weights", "Yi family open models for reasoning and coding.", "https://01.ai", [
        _model("yi-large", "Yi Large", "200k", ["text"], "Large flagship model."),
        _model("yi-lightning", "Yi Lightning", "200k", ["text"], "Fast model."),
        _model("yi-coder", "Yi Coder", "200k", ["text"], "Code-specialized model."),
    ]),
    _provider("tencent-hunyuan", "Tencent Hunyuan", "regional", "Hunyuan models for general and enterprise workloads.", "https://hunyuan.tencent.com", [
        _model("hunyuan-turbos", "Hunyuan Turbos", "128k", ["text"], "Fast model."),
        _model("hunyuan-pro", "Hunyuan Pro", "128k", ["text"], "Higher-capacity model."),
        _model("hunyuan-lite", "Hunyuan Lite", "128k", ["text"], "Compact model."),
    ]),
    _provider("bytedance-doubao", "ByteDance Doubao", "regional", "Doubao models for assistant and multimodal workloads.", "https://www.doubao.com", [
        _model("doubao-pro-32k", "Doubao Pro 32K", "32k", ["text", "vision"], "General model."),
        _model("doubao-lite-32k", "Doubao Lite 32K", "32k", ["text"], "Fast compact model."),
        _model("doubao-vision-pro", "Doubao Vision Pro", "32k", ["text", "vision"], "Vision-capable model."),
    ]),
    _provider("sensetime", "SenseTime", "regional", "SenseNova family for enterprise reasoning and vision.", "https://www.sensetime.com", [
        _model("sensenova-5.0", "SenseNova 5.0", "128k", ["text", "vision"], "Flagship model."),
        _model("sensenova-lite", "SenseNova Lite", "128k", ["text"], "Compact model."),
    ]),
    _provider("ibm-watsonx", "IBM watsonx", "enterprise", "Enterprise AI models and governance tooling from IBM.", "https://www.ibm.com/watsonx", [
        _model("granite-3-8b-instruct", "Granite 3 8B Instruct", "128k", ["text"], "Instruction model."),
        _model("granite-3-2b-instruct", "Granite 3 2B Instruct", "128k", ["text"], "Compact instruct model."),
        _model("llama-3-70b-instruct", "Llama 3 70B Instruct", "128k", ["text"], "IBM-hosted open-weight model."),
    ]),
    _provider("databricks", "Databricks Mosaic AI", "enterprise", "Databricks hosted models for data and enterprise workflows.", "https://www.databricks.com/product/machine-learning/ai", [
        _model("dbrx-instruct", "DBRX Instruct", "128k", ["text"], "Mixture-of-experts model."),
        _model("mixtral-8x7b-instruct", "Mixtral 8x7B Instruct", "32k", ["text"], "Instruction model."),
        _model("llama-3-70b-instruct", "Llama 3 70B Instruct", "128k", ["text"], "Hosted open-weight model."),
    ]),
    _provider("nvidia", "NVIDIA", "enterprise", "Nemotron and other NVIDIA-hosted enterprise models.", "https://www.nvidia.com/en-us/ai-data-science/", [
        _model("nemotron-4-340b-instruct", "Nemotron-4 340B Instruct", "128k", ["text"], "Large reasoning model."),
        _model("llama-3.1-nemotron-70b", "Llama 3.1 Nemotron 70B", "128k", ["text"], "Instruction-tuned model."),
        _model("mixtral-nemotron", "Mixtral Nemotron", "128k", ["text"], "Mixtral-based model."),
    ]),
    _provider("amazon-bedrock", "Amazon Bedrock", "enterprise", "Managed access to multiple foundational model families.", "https://aws.amazon.com/bedrock/", [
        _model("nova-pro", "Nova Pro", "128k", ["text", "vision"], "Amazon native flagship model."),
        _model("nova-lite", "Nova Lite", "128k", ["text", "vision"], "Fast Amazon model."),
        _model("claude-opus-4", "Claude Opus 4", "200k", ["text", "vision"], "Anthropic via Bedrock."),
        _model("llama-3.1-70b", "Llama 3.1 70B", "128k", ["text"], "Meta via Bedrock."),
    ]),
    _provider("azure-ai-foundry", "Azure AI Foundry", "enterprise", "Azure-hosted foundation models with enterprise controls.", "https://azure.microsoft.com/products/ai-services/ai-foundry", [
        _model("gpt-5", "GPT-5", "200k", ["text", "vision"], "OpenAI via Azure."),
        _model("gpt-4.1", "GPT-4.1", "128k", ["text", "vision"], "OpenAI via Azure."),
        _model("o4-mini", "o4-mini", "128k", ["text"], "Reasoning model via Azure."),
        _model("phi-4", "Phi-4", "128k", ["text"], "Microsoft compact model."),
    ]),
    _provider("oracle-oci-genai", "Oracle OCI GenAI", "enterprise", "Oracle-hosted generative AI for enterprise applications.", "https://www.oracle.com/artificial-intelligence/generative-ai/", [
        _model("cohere-command-r-plus", "Cohere Command R+", "128k", ["text"], "Cohere model via OCI."),
        _model("llama-3.1-70b", "Llama 3.1 70B", "128k", ["text"], "Hosted open-weight model."),
        _model("mistral-large-latest", "Mistral Large Latest", "128k", ["text"], "Hosted Mistral model."),
    ]),
    _provider("salesforce-einstein", "Salesforce Einstein", "enterprise", "Salesforce-hosted models for CRM and workflow orchestration.", "https://www.salesforce.com/products/einstein/", [
        _model("xgen-7b", "XGen 7B", "32k", ["text"], "Salesforce general model."),
        _model("xgen-8b", "XGen 8B", "32k", ["text"], "Salesforce general model."),
        _model("llama-3.1-70b", "Llama 3.1 70B", "128k", ["text"], "Hosted open-weight model."),
    ]),
    _provider("snowflake-cortex", "Snowflake Cortex", "enterprise", "Snowflake-hosted AI for governed data apps.", "https://www.snowflake.com/en/data-cloud/cortex/", [
        _model("llama-3.1-70b", "Llama 3.1 70B", "128k", ["text"], "Hosted open-weight model."),
        _model("mistral-large-latest", "Mistral Large Latest", "128k", ["text"], "Hosted Mistral model."),
        _model("mixtral-8x22b", "Mixtral 8x22B", "64k", ["text"], "Large open-weight model."),
    ]),
    _provider("perplexity-sonar", "Perplexity Sonar", "search", "Search-augmented models for grounded answers.", "https://www.perplexity.ai", [
        _model("sonar-pro", "Sonar Pro", "128k", ["text"], "Search-native flagship model."),
        _model("sonar", "Sonar", "128k", ["text"], "General search model."),
        _model("sonar-reasoning", "Sonar Reasoning", "128k", ["text"], "Reasoning-focused search model."),
    ]),
    _provider("groq", "Groq", "inference", "Ultra-low-latency inference for open-weight models.", "https://groq.com", [
        _model("llama-3.1-70b-versatile", "Llama 3.1 70B Versatile", "128k", ["text"], "Low-latency model."),
        _model("mixtral-8x7b-32768", "Mixtral 8x7B 32768", "32k", ["text"], "Fast open-weight model."),
        _model("deepseek-r1-distill-llama-70b", "DeepSeek R1 Distill Llama 70B", "128k", ["text"], "Reasoning distillation."),
        _model("gemma2-9b-it", "Gemma 2 9B IT", "8k", ["text"], "Compact instruct model."),
    ]),
    _provider("together", "Together.ai", "inference", "Open model hosting and orchestration platform.", "https://www.together.ai", [
        _model("llama-3.1-405b", "Llama 3.1 405B", "128k", ["text"], "Large open model."),
        _model("qwen2.5-72b-instruct", "Qwen2.5 72B Instruct", "128k", ["text"], "Open-weight instruct model."),
        _model("deepseek-v3", "DeepSeek V3", "128k", ["text"], "General flagship model."),
        _model("mixtral-8x22b", "Mixtral 8x22B", "64k", ["text"], "Large mixture-of-experts model."),
    ]),
    _provider("fireworks", "Fireworks AI", "inference", "Fast inference and fine-tuned open models.", "https://fireworks.ai", [
        _model("llama-3.1-405b", "Llama 3.1 405B", "128k", ["text"], "Large model."),
        _model("qwen2.5-coder-32b", "Qwen2.5 Coder 32B", "128k", ["text"], "Coding model."),
        _model("deepseek-r1", "DeepSeek R1", "128k", ["text"], "Reasoning model."),
        _model("phi-4", "Phi-4", "128k", ["text"], "Compact Microsoft model."),
    ]),
    _provider("openrouter", "OpenRouter", "gateway", "Model gateway with routing across many providers.", "https://openrouter.ai", [
        _model("gpt-5", "GPT-5", "200k", ["text", "vision"], "Routed OpenAI model."),
        _model("claude-opus-4", "Claude Opus 4", "200k", ["text", "vision"], "Routed Anthropic model."),
        _model("gemini-2.5-pro", "Gemini 2.5 Pro", "1M", ["text", "vision", "audio"], "Routed Google model."),
        _model("llama-4-maverick", "Llama 4 Maverick", "128k", ["text", "vision"], "Routed Meta model."),
        _model("deepseek-r1", "DeepSeek R1", "128k", ["text"], "Routed reasoning model."),
        _model("qwen-max", "Qwen Max", "128k", ["text", "vision"], "Routed Alibaba model."),
    ]),
    _provider("huggingface", "Hugging Face Inference", "registry", "Public model registry and hosted inference endpoints.", "https://huggingface.co", [
        _model("meta-llama/Llama-3.1-70B-Instruct", "Llama 3.1 70B Instruct", "128k", ["text"], "Popular instruct model."),
        _model("mistralai/Mistral-Large-Instruct-2407", "Mistral Large Instruct 2407", "128k", ["text"], "Hosted model."),
        _model("Qwen/Qwen2.5-72B-Instruct", "Qwen2.5 72B Instruct", "128k", ["text"], "Hosted model."),
    ]),
    _provider("replicate", "Replicate", "registry", "Model registry and hosted custom inference platform.", "https://replicate.com", [
        _model("meta-llama/Llama-3.1-405B-Instruct", "Llama 3.1 405B Instruct", "128k", ["text"], "Hosted open model."),
        _model("deepseek-ai/DeepSeek-R1", "DeepSeek R1", "128k", ["text"], "Hosted reasoning model."),
        _model("anthropic/claude-3.7-sonnet", "Claude 3.7 Sonnet", "200k", ["text", "vision"], "Hosted Anthropic model."),
    ]),
    _provider("baseten", "Baseten", "inference", "Inference platform for model deployment and serving.", "https://baseten.co", [
        _model("llama-3.1-405b", "Llama 3.1 405B", "128k", ["text"], "Hosted open-weight model."),
        _model("qwen2.5-72b", "Qwen2.5 72B", "128k", ["text"], "Hosted open-weight model."),
        _model("deepseek-v3", "DeepSeek V3", "128k", ["text"], "Hosted model."),
    ]),
    _provider("modal", "Modal", "inference", "Serverless compute platform with model deployment support.", "https://modal.com", [
        _model("llama-3.1-70b", "Llama 3.1 70B", "128k", ["text"], "Hosted model."),
        _model("qwen2.5-coder-32b", "Qwen2.5 Coder 32B", "128k", ["text"], "Coding model."),
        _model("phi-4", "Phi-4", "128k", ["text"], "Compact model."),
    ]),
    _provider("lambda", "Lambda", "inference", "Cloud GPU platform with hosted model APIs.", "https://lambda.ai", [
        _model("lfm2", "LFM2", "128k", ["text"], "Lambda flagship model family."),
        _model("llama-3.1-70b", "Llama 3.1 70B", "128k", ["text"], "Hosted open model."),
        _model("mistral-large-latest", "Mistral Large Latest", "128k", ["text"], "Hosted Mistral model."),
    ]),
    _provider("deepinfra", "DeepInfra", "inference", "Low-cost hosted inference for many open models.", "https://deepinfra.com", [
        _model("llama-3.1-405b", "Llama 3.1 405B", "128k", ["text"], "Hosted open model."),
        _model("qwen2.5-72b", "Qwen2.5 72B", "128k", ["text"], "Hosted open model."),
        _model("deepseek-r1", "DeepSeek R1", "128k", ["text"], "Hosted reasoning model."),
    ]),
    _provider("ollama", "Ollama", "local", "Local model runner for open-weight models.", "https://ollama.com", [
        _model("llama3.3", "Llama 3.3", "local", ["text"], "Local model family."),
        _model("qwen2.5", "Qwen 2.5", "local", ["text"], "Local model family."),
        _model("mistral", "Mistral", "local", ["text"], "Local model family."),
        _model("deepseek-r1", "DeepSeek R1", "local", ["text"], "Local reasoning model."),
    ]),
    _provider("lm-studio", "LM Studio", "local", "Desktop local model runner and server.", "https://lmstudio.ai", [
        _model("local-llama", "Local Llama", "local", ["text"], "User-managed local model."),
        _model("local-qwen", "Local Qwen", "local", ["text"], "User-managed local model."),
        _model("local-mistral", "Local Mistral", "local", ["text"], "User-managed local model."),
    ]),
    _provider("vertex-ai", "Google Vertex AI", "enterprise", "Enterprise access to Google-hosted foundation models.", "https://cloud.google.com/vertex-ai", [
        _model("gemini-2.5-pro", "Gemini 2.5 Pro", "1M", ["text", "vision", "audio"], "Google flagship model."),
        _model("gemini-2.5-flash", "Gemini 2.5 Flash", "1M", ["text", "vision", "audio"], "Fast Google model."),
        _model("text-embedding-004", "Text Embedding 004", "8k", ["text"], "Embedding model."),
    ]),
    _provider("cloudflare-workers-ai", "Cloudflare Workers AI", "edge", "Edge-hosted open models near users.", "https://developers.cloudflare.com/workers-ai/", [
        _model("llama-3.1-70b-instruct", "Llama 3.1 70B Instruct", "128k", ["text"], "Edge-hosted model."),
        _model("qwen2.5-72b-instruct", "Qwen2.5 72B Instruct", "128k", ["text"], "Edge-hosted model."),
        _model("mistral-small-3.1", "Mistral Small 3.1", "128k", ["text"], "Edge-hosted model."),
    ]),
    _provider("vercel-ai-gateway", "Vercel AI Gateway", "gateway", "Routing gateway for multiple model providers.", "https://vercel.com/docs/ai-gateway", [
        _model("gpt-5", "GPT-5", "200k", ["text", "vision"], "Routed OpenAI model."),
        _model("claude-sonnet-4", "Claude Sonnet 4", "200k", ["text", "vision"], "Routed Anthropic model."),
        _model("gemini-2.5-pro", "Gemini 2.5 Pro", "1M", ["text", "vision", "audio"], "Routed Google model."),
        _model("llama-4-scout", "Llama 4 Scout", "128k", ["text", "vision"], "Routed Meta model."),
    ]),
    _provider("cerebras", "Cerebras Cloud", "inference", "Fast inference for large open models.", "https://cerebras.ai", [
        _model("llama-3.3-70b", "Llama 3.3 70B", "128k", ["text"], "Hosted open-weight model."),
        _model("llama-3.1-70b", "Llama 3.1 70B", "128k", ["text"], "Hosted open-weight model."),
        _model("qwen2.5-72b", "Qwen2.5 72B", "128k", ["text"], "Hosted open-weight model."),
    ]),
    _provider("sambanova", "SambaNova Cloud", "inference", "Enterprise inference platform for open models.", "https://sambanova.ai", [
        _model("llama-3.1-70b", "Llama 3.1 70B", "128k", ["text"], "Hosted open model."),
        _model("qwen2.5-72b", "Qwen2.5 72B", "128k", ["text"], "Hosted open model."),
        _model("deepseek-r1", "DeepSeek R1", "128k", ["text"], "Hosted reasoning model."),
    ]),
    _provider("writer", "Writer", "enterprise", "Enterprise LLMs for brand-safe corporate workflows.", "https://writer.com", [
        _model("palmyra-x5", "Palmyra X5", "128k", ["text"], "Flagship model."),
        _model("palmyra-med", "Palmyra Med", "128k", ["text"], "Mid-size model."),
        _model("palmyra-mini", "Palmyra Mini", "128k", ["text"], "Compact model."),
    ]),
    _provider("aleph-alpha", "Aleph Alpha", "enterprise", "European enterprise model provider.", "https://www.aleph-alpha.com", [
        _model("luminous-extended", "Luminous Extended", "128k", ["text"], "Flagship model."),
        _model("luminous-supreme", "Luminous Supreme", "128k", ["text"], "High-capacity model."),
        _model("luminous-base", "Luminous Base", "128k", ["text"], "Compact model."),
    ]),
    _provider("reka", "Reka AI", "frontier", "Multimodal models for enterprise assistants.", "https://www.reka.ai", [
        _model("reka-core", "Reka Core", "128k", ["text", "vision"], "Flagship model."),
        _model("reka-flash", "Reka Flash", "128k", ["text", "vision"], "Fast model."),
        _model("reka-orbit", "Reka Orbit", "128k", ["text", "vision"], "General model."),
    ]),
    _provider("phind", "Phind", "search", "Search-native developer assistant models.", "https://www.phind.com", [
        _model("phind-1.5", "Phind 1.5", "128k", ["text", "vision"], "General developer model."),
        _model("phind-coder", "Phind Coder", "128k", ["text"], "Code-focused model."),
        _model("phind-search", "Phind Search", "128k", ["text"], "Search-augmented model."),
    ]),
    _provider("replit", "Replit", "inference", "Replit-hosted coding and agentic models.", "https://replit.com", [
        _model("replit-code-v1", "Replit Code v1", "128k", ["text"], "Code-focused model."),
        _model("replit-agent", "Replit Agent", "128k", ["text"], "Agentic coding model."),
        _model("replit-mixtral", "Replit Mixtral", "32k", ["text"], "Hosted open model."),
    ]),
]



def provider_catalog() -> dict:
    providers = sorted(CATALOG, key=lambda item: (item["category"], item["name"].lower()))
    total_models = sum(len(provider["models"]) for provider in providers)
    return {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "total_providers": len(providers),
        "total_models": total_models,
        "providers": providers,
        "categories": sorted({provider["category"] for provider in providers}),
        "source": "paperclip-ceo-jarvis catalog",
    }
