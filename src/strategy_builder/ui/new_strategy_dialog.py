"""
New Strategy Dialog
SPRINT 1.6.1 - Phase 2 Day 4-5

Simple dialog for creating new strategies in database.
Replaces file-based new strategy workflow.
"""

from typing import Optional
from PyQt5.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QLineEdit,
    QPushButton, QLabel, QTextEdit, QWidget
)
from PyQt5.QtCore import Qt

from src.optimizer_v3.database import get_database_manager
from .styles import (
    get_dialog_stylesheet,
    get_primary_button_stylesheet,
    get_secondary_button_stylesheet,
    get_input_field_stylesheet,
    get_text_edit_stylesheet,
    create_font,
    get_color,
    WindowGeometryMixin,
)


class NewStrategyDialog(WindowGeometryMixin, QDialog):
    """
    Dialog for creating new strategy in database

    Simple form with name and optional description.
    Creates parent strategy record ready for version creation.
    """

    GEOMETRY_SETTINGS_KEY = "newStrategyDialog"
    GEOMETRY_DEFAULT_SIZE = (600, 400)
    
    def __init__(self, parent: Optional[QWidget] = None):
        """Initialize new strategy dialog"""
        super().__init__(parent)
        self.strategy_id = None
        self.db = None
        
        self._init_ui()
    
    def _init_ui(self):
        """Initialize user interface"""
        self.setObjectName("new_strategy_dialog")
        self.setWindowTitle("New Strategy")
        self.setWindowFlags(
            Qt.Window
            | Qt.WindowTitleHint
            | Qt.WindowCloseButtonHint
            | Qt.WindowMinimizeButtonHint
            | Qt.WindowMaximizeButtonHint
        )
        self.setMinimumSize(500, 300)
        self.setStyleSheet(get_dialog_stylesheet())
        
        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        layout.setContentsMargins(24, 24, 24, 24)
        
        # Title
        title_label = QLabel("📝 Create New Strategy")
        title_label.setFont(create_font(16, bold=True))
        title_label.setStyleSheet(f"color: {get_color('text_primary')};")
        layout.addWidget(title_label)
        
        # Name field
        name_label = QLabel("Strategy Name *")
        name_label.setFont(create_font(10, bold=True))
        name_label.setStyleSheet(f"color: {get_color('text_secondary')};")
        layout.addWidget(name_label)
        
        self.name_input = QLineEdit()
        self.name_input.setObjectName("strategy_name_input")
        self.name_input.setPlaceholderText("Enter strategy name...")
        self.name_input.setStyleSheet(get_input_field_stylesheet())
        self.name_input.setToolTip("A unique name for your strategy — used as the identifier in the database")
        self.name_input.textChanged.connect(self._validate)
        layout.addWidget(self.name_input)
        
        # Description field
        desc_label = QLabel("Description (Optional)")
        desc_label.setFont(create_font(10, bold=True))
        desc_label.setStyleSheet(f"color: {get_color('text_secondary')};")
        layout.addWidget(desc_label)
        
        self.desc_input = QTextEdit()
        self.desc_input.setObjectName("strategy_desc_input")
        self.desc_input.setPlaceholderText("Enter strategy description...")
        self.desc_input.setStyleSheet(get_text_edit_stylesheet())
        self.desc_input.setMinimumHeight(100)
        self.desc_input.setToolTip("Optional description — explain the market thesis or signal combination this strategy uses")
        layout.addWidget(self.desc_input)
        
        # Help text
        help_label = QLabel("💡 Tip: You can modify the name and description later in the Strategy Info panel.")
        help_label.setFont(create_font(9))
        help_label.setStyleSheet(f"color: {get_color('text_tertiary')};")
        help_label.setWordWrap(True)
        layout.addWidget(help_label)
        
        layout.addStretch()
        
        # Buttons
        button_layout = QHBoxLayout()
        button_layout.addStretch()
        
        self.cancel_btn = QPushButton("Cancel")
        self.cancel_btn.setObjectName("cancel_btn")
        self.cancel_btn.setStyleSheet(get_secondary_button_stylesheet())
        self.cancel_btn.setToolTip("Discard and close this dialog without creating a strategy")
        self.cancel_btn.clicked.connect(self.reject)
        button_layout.addWidget(self.cancel_btn)
        
        self.create_btn = QPushButton("Create Strategy")
        self.create_btn.setObjectName("create_strategy_btn")
        self.create_btn.setStyleSheet(get_primary_button_stylesheet())
        self.create_btn.setEnabled(False)
        self.create_btn.setToolTip("Create a new strategy record in the database with the given name")
        self.create_btn.clicked.connect(self._on_create)
        button_layout.addWidget(self.create_btn)
        
        layout.addLayout(button_layout)
        
        # Focus on name input
        self.name_input.setFocus()
    
    def _validate(self):
        """Validate form and enable/disable create button"""
        name = self.name_input.text().strip()
        self.create_btn.setEnabled(len(name) > 0)
    
    def _on_create(self):
        """Handle create button click"""
        name = self.name_input.text().strip()
        
        if not name:
            from .alert_dialog import show_error
            show_error(self, "New Strategy", "Error", "Please enter a strategy name")
            return
        
        try:
            # Create database manager
            self.db = get_database_manager()
            
            # Create parent strategy
            self.strategy_id = self.db.strategy.create_strategy(name)
            
            # Save description for later use if provided
            self.description = self.desc_input.toPlainText().strip()
            
            # Close dialog
            self.accept()
            
        except Exception as e:
            from .alert_dialog import show_error
            show_error(self, "New Strategy", "Error", f"Failed to create strategy:\n{e}")
    
    def get_strategy_data(self) -> dict:
        """
        Get created strategy data
        
        Returns:
            Dict with strategy_id, name, and description
        """
        return {
            'strategy_id': self.strategy_id,
            'name': self.name_input.text().strip(),
            'description': self.desc_input.toPlainText().strip()
        }
    
    def showEvent(self, event):
        """Called when window is shown - apply hand cursors to all widgets"""
        super().showEvent(event)
        from PyQt5.QtCore import QTimer
        from .styles import apply_hand_cursor_to_buttons
        QTimer.singleShot(200, lambda: apply_hand_cursor_to_buttons(self))
        self._restore_window_geometry(event)

    def closeEvent(self, event):
        """Handle dialog close"""
        self._save_window_geometry()
        if self.db:
            self.db.close()
        super().closeEvent(event)
