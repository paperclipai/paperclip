import os
import pytest

@pytest.fixture(autouse=True)
def clean_environment():
    """Backup env variables, clean up, run test, and restore environment."""
    original_env = dict(os.environ)
    
    # Clean up shepherd env variables
    for k in list(os.environ.keys()):
        if k.startswith("SHEPHERD_") or k == "GITHUB_TOKEN" or k == "LLM_API_KEY":
            del os.environ[k]
            
    yield
    
    # Restore original environment
    os.environ.clear()
    os.environ.update(original_env)
