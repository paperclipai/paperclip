"""
Web dashboard for EMR Automation.

Provides a lightweight Flask-based UI for:
- Patient queue monitoring
- One-click template actions
- Dosage calculations
- Audit log viewer
- Configuration editor
- Real-time status via SSE
"""

from emr_automation.dashboard.app import create_app

__all__ = ["create_app"]
