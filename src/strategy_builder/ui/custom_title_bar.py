"""
Custom Title Bar Widget - Professional Dark Theme

Provides a custom title bar that matches our application theme,
replacing the OS-controlled window title bar.

Features:
- Custom minimize/maximize/close buttons
- Window dragging support
- Application icon and title
- Professional dark theme (#0F1419)

Author: Strategy Builder Team
Date: 2026-01-16
"""

from typing import Optional
from PyQt5.QtWidgets import (
    QWidget, QHBoxLayout, QLabel, QPushButton, QSizePolicy
)
from PyQt5.QtCore import Qt, QPoint, pyqtSignal
from PyQt5.QtGui import QFont, QMouseEvent


class CustomTitleBar(QWidget):
    """
    Custom title bar widget with minimize/maximize/close controls.
    
    Signals:
        minimize_clicked: Emitted when minimize button is clicked
        maximize_clicked: Emitted when maximize button is clicked
        close_clicked: Emitted when close button is clicked
    """
    
    minimize_clicked = pyqtSignal()
    maximize_clicked = pyqtSignal()
    close_clicked = pyqtSignal()
    
    def __init__(self, parent: Optional[QWidget] = None, title: str = "Application"):
        """
        Initialize the custom title bar.
        
        Args:
            parent: Parent widget
            title: Window title to display
        """
        super().__init__(parent)
        self.parent_window = parent
        self.title_text = title
        
        # Track dragging
        self._dragging = False
        self._drag_position = QPoint()
        
        self._init_ui()
    
    def _init_ui(self):
        """Initialize the UI components."""
        # Set fixed height for title bar (compact)
        self.setFixedHeight(32)
        
        # Dark background matching darkest theme color
        self.setStyleSheet("""
            CustomTitleBar {
                background-color: #0F1419;
                border-bottom: 1px solid #3C4149;
            }
        """)
        
        # Main layout
        layout = QHBoxLayout()
        layout.setContentsMargins(10, 0, 0, 0)
        layout.setSpacing(10)
        
        # App icon placeholder (optional - can add icon later)
        # icon_label = QLabel("📊")
        # icon_label.setStyleSheet("font-size: 18pt;")
        # layout.addWidget(icon_label)
        
        # Title label
        self.title_label = QLabel(self.title_text)
        title_font = QFont()
        title_font.setPointSize(10)
        title_font.setBold(False)
        self.title_label.setFont(title_font)
        from src.strategy_builder.ui.styles import get_color
        self.title_label.setStyleSheet(f"color: {get_color('text_primary')}; background: transparent;")
        layout.addWidget(self.title_label)
        
        # Spacer
        layout.addStretch()
        
        # Window control buttons
        button_style = """
            QPushButton {
                background: transparent;
                border: none;
                color: #A0AEC0;
                font-size: 18pt;
                font-weight: bold;
                padding: 0px 12px;
                min-width: 40px;
                max-width: 40px;
            }
            QPushButton:hover {
                background-color: #2A2F3A;
            }
            QPushButton:pressed {
                background-color: #374151;
            }
        """
        
        close_button_style = """
            QPushButton {
                background: transparent;
                border: none;
                color: #A0AEC0;
                font-size: 18pt;
                font-weight: bold;
                padding: 0px 12px;
                min-width: 40px;
                max-width: 40px;
            }
            QPushButton:hover {
                background-color: #EF4444;
                color: white;
            }
            QPushButton:pressed {
                background-color: #DC2626;
                color: white;
            }
        """
        
        # Minimize button
        self.minimize_button = QPushButton("−")
        self.minimize_button.setStyleSheet(button_style)
        self.minimize_button.setToolTip("Minimize")
        self.minimize_button.clicked.connect(self.minimize_clicked.emit)
        layout.addWidget(self.minimize_button)
        
        # Maximize/Restore button
        self.maximize_button = QPushButton("□")
        self.maximize_button.setStyleSheet(button_style)
        self.maximize_button.setToolTip("Maximize")
        self.maximize_button.clicked.connect(self.maximize_clicked.emit)
        layout.addWidget(self.maximize_button)
        
        # Close button
        self.close_button = QPushButton("×")
        self.close_button.setStyleSheet(close_button_style)
        self.close_button.setToolTip("Close")
        self.close_button.clicked.connect(self.close_clicked.emit)
        layout.addWidget(self.close_button)
        
        self.setLayout(layout)
    
    def set_title(self, title: str):
        """
        Update the window title.
        
        Args:
            title: New title text
        """
        self.title_text = title
        self.title_label.setText(title)
    
    def set_maximized_state(self, is_maximized: bool):
        """
        Update the maximize button icon based on window state.
        
        Args:
            is_maximized: True if window is maximized
        """
        if is_maximized:
            self.maximize_button.setText("❐")  # Restore icon
            self.maximize_button.setToolTip("Restore Down")
        else:
            self.maximize_button.setText("□")  # Maximize icon
            self.maximize_button.setToolTip("Maximize")
    
    def mousePressEvent(self, event: QMouseEvent):
        """Handle mouse press for dragging."""
        if event.button() == Qt.LeftButton:
            self._dragging = True
            self._drag_position = event.globalPos() - self.parent_window.frameGeometry().topLeft()
            event.accept()
    
    def mouseMoveEvent(self, event: QMouseEvent):
        """Handle mouse move for dragging."""
        if self._dragging and event.buttons() == Qt.LeftButton:
            self.parent_window.move(event.globalPos() - self._drag_position)
            event.accept()
    
    def mouseReleaseEvent(self, event: QMouseEvent):
        """Handle mouse release to stop dragging."""
        if event.button() == Qt.LeftButton:
            self._dragging = False
            event.accept()
    
    def mouseDoubleClickEvent(self, event: QMouseEvent):
        """Handle double-click to maximize/restore."""
        if event.button() == Qt.LeftButton:
            self.maximize_clicked.emit()
            event.accept()
