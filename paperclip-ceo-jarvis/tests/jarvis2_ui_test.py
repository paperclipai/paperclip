"""Static checks for the imported Jarvis2 command center package."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    index_html = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
    app_js = (ROOT / "frontend" / "app.js").read_text(encoding="utf-8")
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "showTab('jarvis2', this)" in index_html
    assert 'id="jarvis2View"' in index_html
    assert 'id="jarvis2Status"' in index_html
    assert 'Command Center' in readme
    assert "function loadUnifiedDashboard" in app_js
    assert "function renderUnifiedDashboard" in app_js
    assert "function unifiedProviderChooserHtml" in app_js
    assert "function apiWithTimeout" in app_js
    assert "Promise.allSettled" in app_js
    assert "function loadJarvis2" in app_js
    assert "function renderJarvis2" in app_js
    assert "function jarvis2DecisionAction" in app_js
    assert "function jarvis2SeedLiveDefaults" in app_js
    assert "apiWithTimeout('/providers/catalog'" in app_js
    assert "apiWithTimeout('/v5/company/health-forecast'" in app_js
    assert "api('/v5/audit')" in app_js
    assert "Zip import benchmark" not in app_js
    assert 'id="unifiedDashboard"' in index_html
    assert 'id="providerCatalog"' in index_html
    assert 'id="corpAnalytics"' in index_html
    assert (ROOT / "docs" / "jarvis2" / "JARVIS_QUICK_START.md").exists()
    assert (ROOT / "docs" / "jarvis2" / "jarvis_system_spec.md").exists()
    assert (ROOT / "docs" / "jarvis2" / "jarvis_agent_orchestration.md").exists()
    assert (ROOT / "docs" / "jarvis2" / "jarvis_deployment_playbooks.md").exists()
    assert (ROOT / "docs" / "jarvis2" / "jarvis_command_center.jsx").exists()

    print("Jarvis2 UI import test passed.")


if __name__ == "__main__":
    main()
