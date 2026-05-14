"""
Custom Alert Dialog - Matching Data Update Modal Design

Replaces standard QMessageBox with institutional-grade styled alerts.
Matches the size and design of Data Update Modal for consistency.

Author: Strategy Builder Team
Date: 2026-01-19
"""

from typing import Optional
from PyQt5.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QLabel, QPushButton, QGroupBox
)
from PyQt5.QtCore import Qt
from src.strategy_builder.ui.styles import (
    get_main_stylesheet, get_panel_title_stylesheet,
    get_primary_button_stylesheet, get_secondary_button_stylesheet,
    create_font, get_color
)


class AlertDialog(QDialog):
    """
    Custom alert dialog matching Data Update Modal design.
    
    Replaces standard QMessageBox for consistent institutional-grade UI.
    Size: 600x400 (large enough to be readable but not overwhelming)
    """
    
    def __init__(
        self,
        title: str,
        heading: str,
        message: str,
        icon: str = "⚠️",
        parent: Optional['QWidget'] = None
    ):
        """
        Initialize the alert dialog.
        
        Args:
            title: Window title
            heading: Bold heading text
            message: Main message text (supports HTML)
            icon: Emoji icon (⚠️, ✅, ❌, ℹ️)
            parent: Parent widget (optional)
        """
        super().__init__(parent)
        self.setWindowTitle(title)
        
        # Make dialog independent and draggable (matching Data Update Modal)
        self.setWindowFlags(
            Qt.Window | Qt.WindowTitleHint | Qt.WindowCloseButtonHint | Qt.WindowStaysOnTopHint
        )
        self.setModal(True)
        
        # Large size matching Data Update Modal style (25% taller, 50% wider per user request)
        self.setMinimumSize(900, 500)
        self.resize(900, 550)
        
        # Apply centralized dark theme
        self.setStyleSheet(get_main_stylesheet())
        
        self._init_ui(heading, message, icon)
    
    def _init_ui(self, heading: str, message: str, icon: str):
        """Initialize the user interface."""
        layout = QVBoxLayout()
        layout.setSpacing(20)
        layout.setContentsMargins(30, 30, 30, 30)
        
        # Header with icon and heading
        header_layout = QHBoxLayout()
        header_layout.setSpacing(15)
        
        # Icon
        icon_label = QLabel(icon)
        icon_label.setFont(create_font(32))
        header_layout.addWidget(icon_label)
        
        # Heading
        heading_label = QLabel(heading)
        heading_label.setFont(create_font(16, bold=True))
        heading_label.setStyleSheet(get_panel_title_stylesheet())
        heading_label.setWordWrap(True)
        header_layout.addWidget(heading_label, stretch=1)
        
        layout.addLayout(header_layout)
        
        # Message content
        message_label = QLabel(message)
        message_label.setWordWrap(True)
        message_label.setTextFormat(Qt.RichText)
        message_label.setFont(create_font(11))
        message_label.setStyleSheet(f"color: {get_color('text_secondary')}; line-height: 1.6;")
        layout.addWidget(message_label)
        
        layout.addStretch()
        
        # OK button
        button_layout = QHBoxLayout()
        button_layout.addStretch()
        
        ok_button = QPushButton("✓ OK")
        ok_button.setMinimumWidth(120)
        ok_button.setMinimumHeight(40)
        ok_button.setStyleSheet(get_primary_button_stylesheet())
        ok_button.clicked.connect(self.accept)
        button_layout.addWidget(ok_button)
        
        layout.addLayout(button_layout)
        
        self.setLayout(layout)


def show_alert(
    parent,
    title: str,
    heading: str,
    message: str,
    icon: str = "⚠️"
):
    """
    Convenience function to show an alert dialog.
    
    Args:
        parent: Parent widget
        title: Window title
        heading: Bold heading text
        message: Main message text (supports HTML)
        icon: Emoji icon (⚠️, ✅, ❌, ℹ️)
    """
    dialog = AlertDialog(title, heading, message, icon, parent)
    dialog.exec_()


def show_warning(parent, title: str, heading: str, message: str):
    """Show a warning alert (yellow triangle icon)."""
    show_alert(parent, title, heading, message, "⚠️")


def show_error(parent, title: str, heading: str, message: str):
    """Show an error alert (red X icon)."""
    show_alert(parent, title, heading, message, "❌")


def show_info(parent, title: str, heading: str, message: str):
    """Show an info alert (blue i icon)."""
    show_alert(parent, title, heading, message, "ℹ️")


def show_success(parent, title: str, heading: str, message: str):
    """Show a success alert (green checkmark icon)."""
    show_alert(parent, title, heading, message, "✅")


class QuestionDialog(QDialog):
    """
    Custom question dialog with Yes/No/Cancel buttons.
    
    Size: 2250x1375 (matching AlertDialog)
    Returns: 'yes', 'no', or 'cancel'
    """
    
    def __init__(
        self,
        title: str,
        heading: str,
        message: str,
        icon: str = "❓",
        parent: Optional['QWidget'] = None
    ):
        """Initialize the question dialog."""
        super().__init__(parent)
        self.setWindowTitle(title)
        self.result = 'cancel'  # Default result
        
        # Make dialog independent and draggable
        self.setWindowFlags(
            Qt.Window | Qt.WindowTitleHint | Qt.WindowCloseButtonHint | Qt.WindowStaysOnTopHint
        )
        self.setModal(True)
        
        # Standard size (same as AlertDialog)
        self.setMinimumSize(900, 500)
        self.resize(900, 550)
        
        # Apply centralized dark theme
        self.setStyleSheet(get_main_stylesheet())
        
        self._init_ui(heading, message, icon)
    
    def _init_ui(self, heading: str, message: str, icon: str):
        """Initialize the user interface."""
        layout = QVBoxLayout()
        layout.setSpacing(20)
        layout.setContentsMargins(30, 30, 30, 30)
        
        # Header with icon and heading
        header_layout = QHBoxLayout()
        header_layout.setSpacing(15)
        
        # Icon
        icon_label = QLabel(icon)
        icon_label.setFont(create_font(32))
        header_layout.addWidget(icon_label)
        
        # Heading
        heading_label = QLabel(heading)
        heading_label.setFont(create_font(16, bold=True))
        heading_label.setStyleSheet(get_panel_title_stylesheet())
        heading_label.setWordWrap(True)
        header_layout.addWidget(heading_label, stretch=1)
        
        layout.addLayout(header_layout)
        
        # Message content
        message_label = QLabel(message)
        message_label.setWordWrap(True)
        message_label.setTextFormat(Qt.RichText)
        message_label.setFont(create_font(11))
        message_label.setStyleSheet(f"color: {get_color('text_secondary')}; line-height: 1.6;")
        layout.addWidget(message_label)
        
        layout.addStretch()
        
        # Buttons (Cancel, No, Yes)
        button_layout = QHBoxLayout()
        button_layout.addStretch()
        
        # Cancel button
        cancel_button = QPushButton("❌ Cancel")
        cancel_button.setMinimumWidth(120)
        cancel_button.setMinimumHeight(40)
        cancel_button.setStyleSheet(get_secondary_button_stylesheet())
        cancel_button.clicked.connect(self._on_cancel)
        button_layout.addWidget(cancel_button)
        
        # No button
        no_button = QPushButton("🔴 No")
        no_button.setMinimumWidth(120)
        no_button.setMinimumHeight(40)
        no_button.setStyleSheet(get_secondary_button_stylesheet())
        no_button.clicked.connect(self._on_no)
        button_layout.addWidget(no_button)
        
        # Yes button
        yes_button = QPushButton("✅ Yes")
        yes_button.setMinimumWidth(120)
        yes_button.setMinimumHeight(40)
        yes_button.setStyleSheet(get_primary_button_stylesheet())
        yes_button.clicked.connect(self._on_yes)
        button_layout.addWidget(yes_button)
        
        layout.addLayout(button_layout)
        
        self.setLayout(layout)
    
    def _on_yes(self):
        """Handle Yes button."""
        self.result = 'yes'
        self.accept()
    
    def _on_no(self):
        """Handle No button."""
        self.result = 'no'
        self.accept()
    def showEvent(self, event):
        """Called when window is shown - apply hand cursors to all widgets"""
        super().showEvent(event)
        from PyQt5.QtCore import QTimer
        from .styles import apply_hand_cursor_to_buttons
        QTimer.singleShot(200, lambda: apply_hand_cursor_to_buttons(self))

    
    def _on_cancel(self):
        """Handle Cancel button."""
        self.result = 'cancel'
        self.reject()


def ask_question(
    parent,
    title: str,
    heading: str,
    message: str,
    icon: str = "❓"
) -> str:
    """
    Show a question dialog with Yes/No/Cancel buttons.
    
    Args:
        parent: Parent widget
        title: Window title
        heading: Bold heading text
        message: Main message text (supports HTML)
        icon: Emoji icon (default: ❓)
    
    Returns:
        'yes', 'no', or 'cancel'
    """
    dialog = QuestionDialog(title, heading, message, icon, parent)
    dialog.exec_()
    return dialog.result
