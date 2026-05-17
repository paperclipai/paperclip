"""
Backtest Configuration Dialog - Modal Window

Wrapper dialog for BacktestConfigPanel that displays as a modal window.

Author: Strategy Builder Team
Date: 2026-01-17
"""

from PyQt5.QtWidgets import QDialog, QVBoxLayout
from PyQt5.QtCore import Qt

from .backtest_config_panel import BacktestConfigPanel
from .styles import get_main_stylesheet, WindowGeometryMixin


class BacktestConfigDialog(WindowGeometryMixin, QDialog):
    """
    Modal dialog for backtest configuration.

    Displays the backtest configuration panel in a standalone window.
    """

    GEOMETRY_SETTINGS_KEY = "backtestConfigDialog"
    GEOMETRY_DEFAULT_SIZE = (1200, 800)
    
    def __init__(self, orchestrator, parent=None):
        super().__init__(parent)
        self.orchestrator = orchestrator
        self._init_ui()

    def showEvent(self, event):
        """Restore geometry or default to maximized; apply hand cursors."""
        super().showEvent(event)
        from PyQt5.QtCore import QTimer
        from .styles import apply_hand_cursor_to_buttons
        QTimer.singleShot(200, lambda: apply_hand_cursor_to_buttons(self))
        self._restore_window_geometry(event)

    def closeEvent(self, event):
        """Save window geometry on close."""
        self._save_window_geometry()
        super().closeEvent(event)

    
    def _init_ui(self):
        """Initialize the dialog UI"""
        self.setObjectName("backtest_config_dialog")
        self.setWindowTitle("BTC Trade Engine - Backtest Configuration")
        self.setModal(False)  # Non-modal so user can see strategy
        
        # Set window flags to enable maximize/minimize/close buttons.
        # Qt.Window is required for an independent OS title bar with working
        # maximize/minimize on all platforms.
        self.setWindowFlags(
            Qt.Window |
            Qt.WindowMaximizeButtonHint |
            Qt.WindowMinimizeButtonHint |
            Qt.WindowCloseButtonHint
        )
        
        # Layout (geometry/maximized state is set in showEvent)
        layout = QVBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)
        
        # Add backtest panel
        self.backtest_panel = BacktestConfigPanel(self.orchestrator, self)
        layout.addWidget(self.backtest_panel)
        
        self.setLayout(layout)
        
        # Apply centralized dark theme
        self.setStyleSheet(get_main_stylesheet())
