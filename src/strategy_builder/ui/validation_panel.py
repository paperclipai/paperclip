"""
Strategy Validation Panel - UI Component for Strategy Builder

This panel displays real-time validation results with three levels:
- Basic validation (strategy structure)
- Standard validation (logic and constraints)
- Strict validation (circular dependencies)

Integrates with StrategyValidator backend for comprehensive validation.

Author: Strategy Builder Team
Date: 2026-01-16
"""

from typing import Optional
from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QGroupBox, QScrollArea, QFrame, QApplication
)
from PyQt5.QtCore import pyqtSignal, Qt
from PyQt5.QtGui import QFont

from src.strategy_builder.integration.strategy_builder_orchestrator import (
    StrategyBuilderOrchestrator
)
from src.strategy_builder.ui.styles import (
    get_label_style, get_color, get_primary_button_stylesheet, 
    get_success_button_stylesheet
)

import logging
logger = logging.getLogger(__name__)



class ValidationPanel(QWidget):
    """
    Panel for displaying strategy validation results.
    
    Shows three levels of validation with errors and warnings.
    
    Signals:
        validation_requested: Emitted when user clicks Validate Now
        save_requested: Emitted when user clicks Save Strategy  
        generate_requested: Emitted when user clicks Generate Code
        run_test_requested: Emitted when user clicks Run Backtest
    """
    
    validation_requested = pyqtSignal()
    save_requested = pyqtSignal()
    generate_requested = pyqtSignal()
    run_test_requested = pyqtSignal()
    
    def __init__(self, orchestrator: StrategyBuilderOrchestrator, parent: Optional[QWidget] = None):
        """
        Initialize the Validation Panel.
        
        Args:
            orchestrator: StrategyBuilderOrchestrator instance
            parent: Parent widget (optional)
        """
        super().__init__(parent)
        self.orchestrator = orchestrator
        self.current_version_id = None  # Set externally by main window
        
        # UI Components
        self.status_label: Optional[QLabel] = None
        self.basic_section: Optional[QWidget] = None
        self.standard_section: Optional[QWidget] = None
        self.strict_section: Optional[QWidget] = None
        self.warnings_section: Optional[QWidget] = None
        self.nautilus_label: Optional[QLabel] = None
        self.validate_button: Optional[QPushButton] = None
        self.save_button: Optional[QPushButton] = None
        self.generate_button: Optional[QPushButton] = None
        self.run_test_button: Optional[QPushButton] = None
        
        # Validation state
        self.last_validation_result = None
        
        self._init_ui()
        self._connect_signals()
    
    def _init_ui(self):
        """Initialize the user interface components."""
        layout = QVBoxLayout()
        layout.setSpacing(15)
        layout.setContentsMargins(10, 10, 10, 10)
        
        # Group box
        group_box = QGroupBox("Strategy Validation")
        group_box_font = QFont()
        group_box_font.setBold(True)
        group_box_font.setPointSize(10)
        group_box.setFont(group_box_font)
        group_box.setStyleSheet(f"QGroupBox::title {{ color: {get_color('info')}; }}")
        
        group_layout = QVBoxLayout()
        group_layout.setSpacing(12)
        
        # Header with Validate Now button
        header_layout = QHBoxLayout()
        # Add right margin to align with scroll area content (account for scrollbar)
        header_layout.setContentsMargins(0, 0, 20, 0)
        
        # Status label
        self.status_label = QLabel("Status: Not Validated")
        status_font = QFont()
        status_font.setBold(True)
        status_font.setPointSize(11)
        self.status_label.setFont(status_font)
        self.status_label.setStyleSheet(f"color: {get_color('text_disabled')};")
        header_layout.addWidget(self.status_label)
        
        # Last validated timestamp
        self.last_validated_label = QLabel("")
        self.last_validated_label.setStyleSheet(get_label_style('muted') + " font-size: 9pt;")
        header_layout.addWidget(self.last_validated_label)
        
        header_layout.addStretch()
        
        # Validate Now button
        self.validate_button = QPushButton("🔍 Validate Now")
        self.validate_button.setStyleSheet(get_primary_button_stylesheet(compact=True))
        self.validate_button.setToolTip("Run all validation checks on the current strategy configuration")
        header_layout.addWidget(self.validate_button)
        
        group_layout.addLayout(header_layout)
        
        # Scroll area for validation results (no max height - let it expand)
        scroll_area = QScrollArea()
        scroll_area.setWidgetResizable(True)
        scroll_area.setMinimumHeight(400)
        # No maximum height - allow it to expand to fit all content
        
        # Container for validation sections
        results_container = QWidget()
        results_layout = QVBoxLayout()
        results_layout.setSpacing(10)
        results_layout.setContentsMargins(5, 5, 5, 5)
        
        # Basic Validation Section
        self.basic_section = self._create_validation_section(
            "✅ Basic Validation",
            "#4ADE80",  # Green
            []
        )
        results_layout.addWidget(self.basic_section)
        
        # Standard Validation Section
        self.standard_section = self._create_validation_section(
            "✅ Standard Validation",
            "#60A5FA",  # Blue
            []
        )
        results_layout.addWidget(self.standard_section)
        
        # Strict Validation Section
        self.strict_section = self._create_validation_section(
            "✅ Strict Validation",
            "#A78BFA",  # Purple
            []
        )
        results_layout.addWidget(self.strict_section)
        
        # Exit Condition Validation Section (Sprint 1.8 Task 1.8.38)
        self.exit_section = self._create_validation_section(
            "🔴 Exit Condition Validation",
            "#EF4444",  # Red
            []
        )
        self.exit_section.setVisible(False)  # Only show when exit conditions present
        results_layout.addWidget(self.exit_section)
        
        # Warnings Section (initially hidden)
        self.warnings_section = self._create_validation_section(
            "⚠️ Warnings",
            "#FFA500",  # Orange
            []
        )
        self.warnings_section.setVisible(False)
        results_layout.addWidget(self.warnings_section)
        
        results_layout.addStretch()
        results_container.setLayout(results_layout)
        scroll_area.setWidget(results_container)
        
        group_layout.addWidget(scroll_area)
        
        # NautilusTrader Compatibility
        nautilus_layout = QHBoxLayout()
        nautilus_layout.addWidget(QLabel("NautilusTrader Compatibility:"))
        self.nautilus_label = QLabel("✅ Compatible")
        nautilus_font = QFont()
        nautilus_font.setBold(True)
        self.nautilus_label.setFont(nautilus_font)
        self.nautilus_label.setStyleSheet(f"color: {get_color('success')};")
        nautilus_layout.addWidget(self.nautilus_label)
        nautilus_layout.addStretch()
        group_layout.addLayout(nautilus_layout)
        
        # Action buttons
        actions_layout = QHBoxLayout()
        
        self.save_button = QPushButton("💾 Save Strategy")
        self.save_button.setEnabled(False)
        self.save_button.setStyleSheet(get_success_button_stylesheet())
        self.save_button.setToolTip("Save the validated strategy to the database")
        actions_layout.addWidget(self.save_button)
        
        self.run_test_button = QPushButton("▶️ Run Backtest")
        self.run_test_button.setEnabled(False)
        self.run_test_button.setStyleSheet(get_primary_button_stylesheet(compact=True))
        self.run_test_button.setToolTip("Open the Backtest Configuration and run a walk-forward test on this strategy")
        actions_layout.addWidget(self.run_test_button)
        
        self.generate_button = QPushButton("📝 Generate Code")
        self.generate_button.setEnabled(False)
        self.generate_button.setStyleSheet(get_primary_button_stylesheet(compact=True))
        self.generate_button.setToolTip("Generate NautilusTrader Python strategy code from this configuration")
        actions_layout.addWidget(self.generate_button)
        
        actions_layout.addStretch()
        group_layout.addLayout(actions_layout)
        
        group_box.setLayout(group_layout)
        layout.addWidget(group_box)
        
        self.setLayout(layout)
    
    def _create_validation_section(self, title: str, color: str, items: list) -> QWidget:
        """
        Create a validation section widget.
        
        Args:
            title: Section title
            color: Color for the section
            items: List of validation items
            
        Returns:
            QWidget containing the section
        """
        section = QFrame()
        section.setFrameShape(QFrame.StyledPanel)
        section.setStyleSheet(f"""
            QFrame {{
                background-color: #2A2F3A;
                border: 1px solid #3C4149;
                border-left: 4px solid {color};
                border-radius: 4px;
                padding: 8px;
            }}
        """)
        
        section_layout = QVBoxLayout()
        section_layout.setContentsMargins(10, 5, 10, 5)
        section_layout.setSpacing(5)
        
        # Title
        title_label = QLabel(title)
        title_font = QFont()
        title_font.setBold(True)
        title_label.setFont(title_font)
        title_label.setStyleSheet(f"color: {color};")
        section_layout.addWidget(title_label)
        
        # Items container (will be populated dynamically)
        items_container = QWidget()
        items_container.setObjectName("items_container")
        items_layout = QVBoxLayout()
        items_layout.setContentsMargins(15, 0, 0, 0)
        items_layout.setSpacing(3)
        
        for item in items:
            item_label = QLabel(f"├─ {item}")
            item_label.setStyleSheet(f"color: {get_color('text_primary')}; font-size: 9pt;")
            items_layout.addWidget(item_label)
        
        items_container.setLayout(items_layout)
        section_layout.addWidget(items_container)
        
        section.setLayout(section_layout)
        return section
    
    def _connect_signals(self):
        """Connect UI signals to handlers."""
        self.validate_button.clicked.connect(self._on_validate_clicked)
        self.save_button.clicked.connect(self._on_save_clicked)
        self.generate_button.clicked.connect(self._on_generate_clicked)
        self.run_test_button.clicked.connect(self._on_run_test_clicked)
    
    def _on_validate_clicked(self):
        """Handle Validate Now button click."""
        self.validate_strategy()
        self.validation_requested.emit()
    
    def _on_save_clicked(self):
        """Handle Save Strategy button click."""
        self.save_requested.emit()
    
    def _on_generate_clicked(self):
        """Handle Generate Code button click."""
        self.generate_requested.emit()
    
    def _on_run_test_clicked(self):
        """Handle Run Backtest button click."""
        self.run_test_requested.emit()
    
    def validate_strategy(self):
        """Run validation and update display."""
        try:
            # Show "validating..." feedback
            self.validate_button.setEnabled(False)
            self.validate_button.setText("⏳ Validating...")
            self.last_validated_label.setText("Running validation...")
            
            # Force UI update
            QApplication.processEvents()
            
            # Get validation result from orchestrator
            result = self.orchestrator.validate_strategy()
            self.last_validation_result = result
            
            # Update display
            self._update_validation_display(result)
            
            # Persist validation status to database (Sprint 1.9 - ORM persistence)
            self._save_validation_status(result)
            
            # Update timestamp
            from datetime import datetime, timezone
            now = datetime.now(timezone.utc).strftime("%H:%M:%S")
            self.last_validated_label.setText(f"Last validated: {now}")
            
            # Re-enable button
            self.validate_button.setEnabled(True)
            self.validate_button.setText("🔍 Validate Now")
            
        except Exception as e:
            self._show_validation_error(str(e))
            self.validate_button.setEnabled(True)
            self.validate_button.setText("🔍 Validate Now")
    
    def _update_validation_display(self, result):
        """
        Update the validation display with results.
        
        Args:
            result: Validation result from orchestrator
        """
        if result.success:
            # Strategy is valid
            self.status_label.setText("Status: ✅ VALID (Strict Mode)")
            self.status_label.setStyleSheet(f"color: {get_color('success')}; font-weight: bold;")
            
            # Enable action buttons
            self.save_button.setEnabled(True)
            self.run_test_button.setEnabled(True)
            self.generate_button.setEnabled(True)
            
            # Update validation sections with success messages
            self._update_section(self.basic_section, "✅ Basic Validation", "#4ADE80", [
                "Strategy has name",
                "At least one block present",
                "All blocks have signals"
            ])
            
            self._update_section(self.standard_section, "✅ Standard Validation", "#60A5FA", [
                "All logic values valid (AND/OR)",
                "Timing constraints configured correctly",
                "No duplicate names"
            ])
            
            self._update_section(self.strict_section, "✅ Strict Validation", "#A78BFA", [
                "No circular dependencies"
            ])
            
            # Show warnings if any
            if hasattr(result, 'warnings') and result.warnings:
                self._update_section(self.warnings_section, f"⚠️ Warnings ({len(result.warnings)})", 
                                   "#FFA500", result.warnings)
                self.warnings_section.setVisible(True)
            else:
                self.warnings_section.setVisible(False)
            
        else:
            # Strategy has errors
            self.status_label.setText("Status: ❌ INVALID")
            self.status_label.setStyleSheet(f"color: {get_color('error')}; font-weight: bold;")
            
            # Disable action buttons
            self.save_button.setEnabled(False)
            self.run_test_button.setEnabled(False)
            self.generate_button.setEnabled(False)
            
            # Show errors (check both 'errors' and 'validation_errors')
            errors_list = []
            if hasattr(result, 'validation_errors') and result.validation_errors:
                errors_list = result.validation_errors
            elif hasattr(result, 'errors') and result.errors:
                errors_list = result.errors
            
            if errors_list:
                # Basic validation errors
                basic_errors = [e for e in errors_list if 'name' in e.lower() or 'block' in e.lower() or 'empty' in e.lower()]
                if basic_errors:
                    self._update_section(self.basic_section, "❌ Basic Validation", "#EF4444", basic_errors)
                else:
                    self._update_section(self.basic_section, "✅ Basic Validation", "#4ADE80", [
                        "Strategy structure valid"
                    ])
                
                # Standard validation errors
                standard_errors = [e for e in errors_list if 'logic' in e.lower() or 'timing' in e.lower() or 'duplicate' in e.lower()]
                if standard_errors:
                    self._update_section(self.standard_section, "❌ Standard Validation", "#EF4444", standard_errors)
                else:
                    self._update_section(self.standard_section, "✅ Standard Validation", "#60A5FA", [
                        "Logic and constraints valid"
                    ])
                
                # Strict validation errors  
                strict_errors = [e for e in errors_list if 'circular' in e.lower() or 'dependency' in e.lower()]
                if strict_errors:
                    self._update_section(self.strict_section, "❌ Strict Validation", "#EF4444", strict_errors)
                else:
                    self._update_section(self.strict_section, "✅ Strict Validation", "#A78BFA", [
                        "No circular dependencies"
                    ])
                
                # Exit condition validation errors (Sprint 1.8 Task 1.8.37)
                exit_errors = [e for e in errors_list if 'exit' in e.lower()]
                if exit_errors:
                    self._update_section(self.exit_section, "❌ Exit Condition Validation", "#EF4444", exit_errors)
                    self.exit_section.setVisible(True)
                else:
                    # Check if strategy has exit conditions
                    config = self.orchestrator.get_current_config()
                    has_exits = False
                    if hasattr(config, 'exit_conditions') and config.exit_conditions:
                        has_exits = True
                    if not has_exits:
                        for block in config.blocks:
                            if hasattr(block, 'exit_conditions') and block.exit_conditions:
                                has_exits = True
                                break
                            for signal in block.signals:
                                if hasattr(signal, 'exit_conditions') and signal.exit_conditions:
                                    has_exits = True
                                    break
                    
                    if has_exits:
                        self._update_section(self.exit_section, "✅ Exit Condition Validation", "#4ADE80", [
                            "All exit conditions valid"
                        ])
                        self.exit_section.setVisible(True)
                    else:
                        self.exit_section.setVisible(False)
                
                # Show all errors if they don't fit categories
                uncategorized = [e for e in errors_list if e not in basic_errors + standard_errors + strict_errors + exit_errors]
                if uncategorized:
                    self._update_section(self.basic_section, "❌ Validation Errors", "#EF4444", 
                                       basic_errors + uncategorized)
            
            # Show warnings
            if hasattr(result, 'warnings') and result.warnings:
                self._update_section(self.warnings_section, f"⚠️ Warnings ({len(result.warnings)})", 
                                   "#FFA500", result.warnings)
                self.warnings_section.setVisible(True)
    
    def _save_validation_status(self, result):
        """
        Persist validation status to database (Sprint 1.9 - ORM persistence).
        
        Updates the strategy_versions table with validation_status and validation_timestamp.
        
        Args:
            result: Validation result from orchestrator
        """
        if not self.current_version_id:
            return  # No version to update yet (strategy not saved)
        
        try:
            from src.optimizer_v3.database import get_database_manager
            from datetime import datetime, timezone
            
            db = get_database_manager()
            from sqlalchemy import text as _sa_text

            # Determine status: Pass or Fail
            validation_status = 'Pass' if result.success else 'Fail'

            # Update the strategy version in database
            db.strategy.session.execute(
                _sa_text("""
                UPDATE strategy_versions
                SET validation_status = :status,
                    validation_timestamp = :timestamp
                WHERE version_id = :version_id
                """),
                {
                    'status': validation_status,
                    'timestamp': datetime.now(timezone.utc),
                    'version_id': str(self.current_version_id)
                }
            )
            db.strategy.session.commit()
            
            logger.info(f"✅ Validation status saved: {validation_status} for version {self.current_version_id}")
            
        except Exception as e:
            logger.error(f"⚠️ Failed to save validation status: {e}")
            # Don't fail the UI if database save fails
            import traceback
            traceback.print_exc()
    
    def _update_section(self, section: QWidget, title: str, color: str, items: list):
        """
        Update a validation section with new items.
        
        Args:
            section: Section widget to update
            title: New title
            color: Section color
            items: List of items to display
        """
        # Update title
        layout = section.layout()
        title_label = layout.itemAt(0).widget()
        title_label.setText(title)
        title_label.setStyleSheet(f"color: {color}; font-weight: bold;")
        
        # Update border color
        section.setStyleSheet(f"""
            QFrame {{
                background-color: #2A2F3A;
                border: 1px solid #3C4149;
                border-left: 4px solid {color};
                border-radius: 4px;
                padding: 8px;
            }}
        """)
        
        # Update items
        items_container = layout.itemAt(1).widget()
        items_layout = items_container.layout()
        
        # Clear existing items
        while items_layout.count():
            child = items_layout.takeAt(0)
            if child.widget():
                child.widget().deleteLater()
        
        # Add new items
        for item in items:
            item_label = QLabel(f"├─ {item}")
            item_label.setStyleSheet(f"color: {get_color('text_primary')}; font-size: 9pt;")
            item_label.setWordWrap(True)
            items_layout.addWidget(item_label)
    
    def _show_validation_error(self, error_message: str):
        """
        Show validation error.
        
        Args:
            error_message: Error message to display
        """
        self.status_label.setText("Status: ❌ ERROR")
        self.status_label.setStyleSheet(f"color: {get_color('error')}; font-weight: bold;")
        
        self._update_section(self.basic_section, "❌ Validation Error", "#EF4444", [
            f"Error: {error_message}"
        ])
        
        self.save_button.setEnabled(False)
        self.run_test_button.setEnabled(False)
        self.generate_button.setEnabled(False)
    
    def refresh_from_orchestrator(self):
        """Refresh validation from orchestrator (auto-validate)."""
        self.validate_strategy()
    
    def auto_validate(self, enabled: bool = True):
        """
        Enable/disable auto-validation on changes.
        
        Args:
            enabled: Whether to auto-validate
        """
        # This would be called when blocks change
        # For now, just validate immediately if enabled
        if enabled:
            self.validate_strategy()
