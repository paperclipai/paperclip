import os
import pytest
from pr_shepherd.config import ShepherdConfig

def test_default_config():
    # Remove variables to test defaults
    for envvar in ["SHEPHERD_MAX_ROUNDS", "SHEPHERD_DIFF_THRESHOLD", "SHEPHERD_FILE_THRESHOLD", "SHEPHERD_DRY_RUN", "SHEPHERD_AUTO_MERGE"]:
        if envvar in os.environ:
            del os.environ[envvar]
            
    config = ShepherdConfig()
    assert config.max_remediation_rounds == 3
    assert config.diff_size_threshold == 400
    assert config.file_count_threshold == 15
    assert "auth/**" in config.sensitive_paths
    assert config.dry_run is True  # default dry-run is true
    assert config.auto_merge_enabled is False

def test_override_config():
    os.environ["SHEPHERD_MAX_ROUNDS"] = "5"
    os.environ["SHEPHERD_DIFF_THRESHOLD"] = "500"
    os.environ["SHEPHERD_FILE_THRESHOLD"] = "20"
    os.environ["SHEPHERD_DRY_RUN"] = "false"
    os.environ["SHEPHERD_AUTO_MERGE"] = "true"
    os.environ["SHEPHERD_SENSITIVE_PATHS"] = "foo/**,bar/**/*.py"

    config = ShepherdConfig()
    assert config.max_remediation_rounds == 5
    assert config.diff_size_threshold == 500
    assert config.file_count_threshold == 20
    assert config.dry_run is False
    assert config.auto_merge_enabled is True
    assert config.sensitive_paths == ["foo/**", "bar/**/*.py"]
