import os
import tempfile
import pytest
from config import read_secret

def test_read_secret_found():
    """Test reading an existing secret from file."""
    with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.env') as f:
        f.write("OPENAI_API_KEY=secret-key-123\n")
        f.write("OTHER_KEY=other-value\n")
        temp_path = f.name

    try:
        result = read_secret(temp_path, "OPENAI_API_KEY")
        assert result == "secret-key-123"
    finally:
        os.unlink(temp_path)

def test_read_secret_with_whitespace():
    """Test reading secret with surrounding whitespace."""
    with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.env') as f:
        f.write("  MAILHUB_SECRET=secret-with-spaces  \n")
        temp_path = f.name

    try:
        result = read_secret(temp_path, "MAILHUB_SECRET")
        assert result == "secret-with-spaces"
    finally:
        os.unlink(temp_path)

def test_read_secret_partial_match_not_found():
    """Test that partial key matches are rejected (e.g. FOO must not match FOOBAR)."""
    with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.env') as f:
        f.write("FOOBAR=value1\n")
        f.write("FOOBAZ=value2\n")
        temp_path = f.name

    try:
        with pytest.raises(RuntimeError) as exc_info:
            read_secret(temp_path, "FOO")
        assert "FOO" in str(exc_info.value)
        assert temp_path in str(exc_info.value)
    finally:
        os.unlink(temp_path)

def test_read_secret_missing_key():
    """Test that missing key raises RuntimeError with clear message."""
    with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.env') as f:
        f.write("OTHER_KEY=value\n")
        temp_path = f.name

    try:
        with pytest.raises(RuntimeError) as exc_info:
            read_secret(temp_path, "MISSING_KEY")
        error_msg = str(exc_info.value)
        assert "MISSING_KEY" in error_msg
        assert temp_path in error_msg
    finally:
        os.unlink(temp_path)
