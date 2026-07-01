"""Provider catalog shape test for the unified dashboard."""
from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ["ENVIRONMENT"] = "development"
os.environ["JARVIS_API_KEY"] = "dev-change-me"

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from fastapi.testclient import TestClient
from app.main import app


def main() -> None:
    with TestClient(app) as client:
        response = client.get("/providers/catalog")
        response.raise_for_status()
        payload = response.json()

        assert payload["total_providers"] >= 50
        assert payload["total_models"] >= payload["total_providers"]
        assert isinstance(payload["providers"], list)
        assert payload["providers"], "expected at least one provider"

        first = payload["providers"][0]
        assert first["id"]
        assert first["name"]
        assert first["category"]
        assert first["models"], "each provider should expose at least one model"
        assert all(model["id"] and model["name"] for model in first["models"])

    print("Provider catalog test passed.")


if __name__ == "__main__":
    main()
