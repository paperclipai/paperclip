"""
Strategy Validation Dialog - Modal Dialog Wrapper

This dialog wraps the ValidationPanel in a modal window to save screen space.
Opens when user clicks "Validate" from the stepper ribbon.

Author: Strategy Builder Team
Date: 2026-01-17
"""

from typing import Optional
from PyQt5.QtWidgets import QDialog, QVBoxLayout, QPushButton, QHBoxLayout, QMessageBox
from PyQt5.QtCore import Qt

from src.strategy_builder.ui.validation_panel import ValidationPanel
from src.strategy_builder.ui.styles import get_main_stylesheet, get_secondary_button_stylesheet, WindowGeometryMixin
from src.strategy_builder.integration.strategy_builder_orchestrator import (
    StrategyBuilderOrchestrator
)


class ValidationDialog(WindowGeometryMixin, QDialog):
    """
    Modal dialog containing the validation panel.

    Shows validation results in a separate window to save main UI space.
    """

    GEOMETRY_SETTINGS_KEY = "validationDialog"
    GEOMETRY_DEFAULT_SIZE = (800, 600)
    
    def __init__(self, orchestrator: StrategyBuilderOrchestrator, parent: Optional['QWidget'] = None):
        """
        Initialize the validation dialog.
        
        Args:
            orchestrator: StrategyBuilderOrchestrator instance
            parent: Parent widget (optional)
        """
        super().__init__(parent)
        self.orchestrator = orchestrator
        self.validation_panel: Optional[ValidationPanel] = None
        
        self._init_ui()
        self._connect_signals()
    
    def _init_ui(self):
        """Initialize the user interface."""
        self.setWindowTitle("BTC Trade Engine - Strategy Validation")
        
        # Make dialog independent and draggable
        self.setWindowFlags(Qt.Window | Qt.WindowCloseButtonHint | Qt.WindowMinimizeButtonHint | Qt.WindowMaximizeButtonHint)
        
        # Larger size to fit all content without scrolling (increased to eliminate scrollbar)
        self.setMinimumSize(1100, 950)
        self.resize(1200, 1050)
        
        # Apply centralized dark theme stylesheet
        self.setStyleSheet(get_main_stylesheet())
        
        # Main layout
        layout = QVBoxLayout()
        layout.setContentsMargins(15, 15, 15, 15)
        layout.setSpacing(15)
        
        # Add validation panel
        self.validation_panel = ValidationPanel(self.orchestrator)
        layout.addWidget(self.validation_panel)
        
        # Bottom button row
        button_layout = QHBoxLayout()
        button_layout.addStretch()
        
        # Close button with centralized styling
        close_button = QPushButton("Close")
        close_button.setStyleSheet(get_secondary_button_stylesheet())
        close_button.setToolTip("Close the validation dialog — you must validate again after any strategy changes")
        close_button.clicked.connect(self.accept)
        button_layout.addWidget(close_button)
        
        layout.addLayout(button_layout)
        
        self.setLayout(layout)
    
    def _connect_signals(self):
        """Connect signals from validation panel to this dialog."""
        self.validation_panel.generate_requested.connect(self._on_generate_requested)

    def _on_generate_requested(self):
        """Handle Generate Code button: invoke orchestrator and report result."""
        result = self.orchestrator.generate_code()
        if result.success:
            QMessageBox.information(
                self,
                "Code Generated",
                f"Strategy code written to:\n{result.message}",
            )
        else:
            QMessageBox.critical(
                self,
                "Code Generation Failed",
                f"Failed to generate strategy code:\n\n" + "\n".join(result.errors),
            )
    
    def showEvent(self, event):
        """
        Called when dialog is shown.

        Auto-validate the current strategy when opening.
        """
        super().showEvent(event)
        self._restore_window_geometry(event)
        # Auto-validate when dialog opens
        self.validation_panel.validate_strategy()

    def closeEvent(self, event):
        """Save window geometry on close."""
        self._save_window_geometry()
        super().closeEvent(event)
