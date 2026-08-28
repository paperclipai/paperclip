import os
from typing import List

class ShepherdConfig:
    def __init__(self):
        self.max_remediation_rounds = int(os.environ.get("SHEPHERD_MAX_ROUNDS", "3"))
        self.diff_size_threshold = int(os.environ.get("SHEPHERD_DIFF_THRESHOLD", "400"))
        self.file_count_threshold = int(os.environ.get("SHEPHERD_FILE_THRESHOLD", "15"))
        
        # Load sensitive paths as a list
        sensitive_paths_raw = os.environ.get(
            "SHEPHERD_SENSITIVE_PATHS",
            "auth/**,secrets/**,.github/**,billing/**,infra/deploy/**,**/*.sql"
        )
        self.sensitive_paths = [p.strip() for p in sensitive_paths_raw.split(",") if p.strip()]
        
        # Boolean flags
        self.dry_run = os.environ.get("SHEPHERD_DRY_RUN", "true").lower() in ("true", "1", "yes")
        self.auto_merge_enabled = os.environ.get("SHEPHERD_AUTO_MERGE", "false").lower() in ("true", "1", "yes")
        
        # Credentials & API Configurations
        self.github_token = os.environ.get("GITHUB_TOKEN", "")
        self.llm_api_key = os.environ.get("LLM_API_KEY", "")
        self.llm_provider = os.environ.get("LLM_PROVIDER", "mock")  # Options: 'mock', 'anthropic', 'gemini'
        
        # Digest settings
        self.digest_cadence = os.environ.get("SHEPHERD_DIGEST_CADENCE", "daily")
        self.digest_issue_title = os.environ.get("SHEPHERD_DIGEST_TITLE", "PR-Shepherd Daily Digest")
