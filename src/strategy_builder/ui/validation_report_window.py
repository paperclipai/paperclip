"""
Validation Report Window - Institutional-Grade Professional UI
Sprint 1.9 - Complete Redesign to Match Strategy Browser

Professional table-based validation report with:
- Table layout matching Strategy Browser style
- Blue section headers matching system theme
- Institutional-grade content and explanations
- Clear, actionable guidance for users
- One-click fix buttons integrated

Author: BTC Trade Engine
Date: 2026-01-30 (Redesigned)
"""

from copy import deepcopy
from typing import Optional
from PyQt5.QtWidgets import (
    QDialog, QMainWindow, QVBoxLayout, QPushButton, QHBoxLayout, QLabel,
    QWidget, QTableWidget, QTableWidgetItem, QHeaderView,
    QMessageBox, QFileDialog, QTabWidget, QTextEdit, QGroupBox, QFrame,
    QSizePolicy
)
from PyQt5.QtCore import Qt, QSettings, pyqtSignal, QTimer
from PyQt5.QtGui import QColor
from datetime import datetime
import csv
from src.optimizer_v3.validation.institutional_validator import (
    InstitutionalValidator,
    ValidationReport,
    ValidationSeverity
)
from src.strategy_builder.ui.styles import (
    COLORS, create_font, create_monospace_font, get_main_stylesheet,
    get_primary_button_stylesheet, get_secondary_button_stylesheet,
    get_table_stylesheet, get_text_edit_stylesheet, get_scroll_area_stylesheet,
    get_tab_widget_stylesheet, set_hand_cursor, apply_hand_cursor_to_buttons,
    get_auto_fix_button_style,
    WindowGeometryMixin,
)
from src.strategy_builder.validation.auto_fix import (
    auto_fix_strategy_type,
    auto_fix_recheck_delay,
    auto_fix_duplicate_exits,
    auto_fix_dead_code,
    AutoFixSafety
)
from src.strategy_builder.validation.undo_manager import UndoManager
from src.strategy_builder.ui.auto_fix_confirm_dialog import AutoFixConfirmDialog
from src.strategy_builder.testing.walkforward_test_engine import WalkforwardResult

import logging
logger = logging.getLogger(__name__)



class ValidationReportWindow(WindowGeometryMixin, QMainWindow):
    """
    Professional validation report window matching Strategy Browser style
    
    Features:
    - Table-based issue display
    - Tab-based organization (Summary, Issues, Metrics)
    - Blue headers matching system theme
    - Institutional-grade explanations
    - Integrated fix buttons
    - NON-BLOCKING window (QMainWindow for independence)
    """
    
    # Signals
    fix_applied = pyqtSignal(str, dict)  # fix_type, fix_data
    generate_code_requested = pyqtSignal()

    GEOMETRY_SETTINGS_KEY = "validationReportWindow"
    GEOMETRY_DEFAULT_SIZE = (1000, 700)
    
    def __init__(
        self,
        report: ValidationReport,
        config: any,
        parent: Optional[QWidget] = None,
        walkforward_result: Optional[WalkforwardResult] = None,
    ):
        """Initialize professional validation window"""
        super().__init__(parent)
        self.report = report
        self.config = config
        self.walkforward_result = walkforward_result
        self.undo_manager = UndoManager()

        self._init_ui()
        self._populate_data()

    def update_config(self, new_config) -> None:
        """Update the config reference after parent window reloads from database.

        Called by strategy_builder_main_window after _reload_current_version()
        replaces orchestrator.config_engine.config with a freshly-restored object.
        Without this, _rerun_validation() would validate the now-stale original
        reference and the fixed issue would appear not to have been resolved.

        Refs: BTCAAAAA-133
        """
        self.config = new_config

    def _init_ui(self):
        """Initialize UI with professional styling - QMainWindow is NON-BLOCKING by default"""
        self.setWindowTitle("BTC Trade Engine - Validation Report")
        # Explicit flags required: QMainWindow with a parent can inherit
        # limiting flags from the parent on some Linux window managers, which
        # removes the native maximize/minimize buttons.
        self.setWindowFlags(
            Qt.Window |
            Qt.WindowMaximizeButtonHint |
            Qt.WindowMinimizeButtonHint |
            Qt.WindowCloseButtonHint
        )
        self.setMinimumSize(1400, 900)
        self.resize(1600, 1000)
        
        # QMainWindow is naturally non-blocking - no modal flag needed
        
        # Apply main stylesheet
        self.setStyleSheet(get_main_stylesheet())
        
        # QMainWindow requires central widget
        central_widget = QWidget()
        self.setCentralWidget(central_widget)
        
        # Main layout
        layout = QVBoxLayout(central_widget)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(16)
        
        # Header with blue title and inline status (Screenshot 2 design)
        header = self._create_header()
        layout.addWidget(header)
        
        # Tab widget for organized content
        self.tabs = self._create_tabs()
        layout.addWidget(self.tabs, 1)
        
        # Footer with actions
        footer = self._create_footer()
        layout.addWidget(footer)
    
    def _create_header(self) -> QWidget:
        """Create header with title and inline status with background (Screenshot 2 design)"""
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setSpacing(8)
        layout.setContentsMargins(0, 0, 0, 12)
        
        # Title matching Strategy Browser style (#095983 - teal/blue)
        title = QLabel("💼 Validation Report")
        title.setFont(create_font(18, bold=True))
        title.setStyleSheet("color: #095983; font-size: 16pt; font-weight: bold; background: transparent;")
        layout.addWidget(title)
        
        # Strategy info with inline status badge (Screenshot 2 design)
        info_container = QWidget()
        info_layout = QHBoxLayout(info_container)
        info_layout.setContentsMargins(0, 0, 0, 0)
        info_layout.setSpacing(12)
        
        # Strategy info text (left side)
        strategy_name = self.report.strategy_summary.get('name', 'Unknown')
        version = self.report.strategy_summary.get('version', None)
        timestamp = datetime.fromisoformat(self.report.timestamp).strftime('%Y-%m-%d %H:%M:%S')
        
        if version:
            info_text = f"Strategy: {strategy_name} (v{version})  •  Validated: {timestamp}"
        else:
            info_text = f"Strategy: {strategy_name}  •  Validated: {timestamp}"
        
        info_label = QLabel(info_text)
        info_label.setFont(create_font(11))
        info_label.setStyleSheet(f"color: {COLORS['text_secondary']}; background: transparent;")
        info_layout.addWidget(info_label)
        
        # Status badge with colored background (Screenshot 2 design - 3 separate widgets)
        status_container = QWidget()
        status_layout = QHBoxLayout(status_container)
        status_layout.setContentsMargins(0, 0, 0, 0)
        status_layout.setSpacing(0)
        
        if self.report.is_valid:
            # Container styling (green background)
            status_container.setStyleSheet(f"""
                QWidget {{
                    background-color: rgba(16, 185, 129, 0.15);
                    border-radius: 4px;
                }}
            """)
            
            # Left bar - rounded on RIGHT
            left_bar = QFrame()
            left_bar.setFixedWidth(4)
            left_bar.setStyleSheet(f"background-color: {COLORS['success']}; border-radius: 0px 2px 2px 0px;")
            status_layout.addWidget(left_bar)
            
            # Status text with icon
            status_label = QLabel("  ✅ VALIDATION PASSED  ")
            status_label.setFont(create_font(11, bold=True))
            status_label.setStyleSheet(f"color: {COLORS['success']}; background: transparent;")
            status_layout.addWidget(status_label)
            
            # Right bar - rounded on LEFT
            right_bar = QFrame()
            right_bar.setFixedWidth(4)
            right_bar.setStyleSheet(f"background-color: {COLORS['success']}; border-radius: 2px 0px 0px 2px;")
            status_layout.addWidget(right_bar)
            
            # Description
            desc_label = QLabel("  Your strategy meets all institutional-grade requirements and is ready for backtesting.")
            desc_label.setFont(create_font(11))
            desc_label.setStyleSheet(f"color: {COLORS['text_secondary']}; background: transparent;")
            desc_label.setWordWrap(True)
            status_layout.addWidget(desc_label, 1)
            
        else:
            blocking = self.report.blocking_issues()
            
            # Container styling (red background)
            status_container.setStyleSheet(f"""
                QWidget {{
                    background-color: rgba(220, 53, 69, 0.15);
                    border-radius: 4px;
                }}
            """)
            
            # Left bar - rounded on RIGHT
            left_bar = QFrame()
            left_bar.setFixedWidth(4)
            left_bar.setStyleSheet(f"background-color: {COLORS['error']}; border-radius: 0px 2px 2px 0px;")
            status_layout.addWidget(left_bar)
            
            # Status text with icon
            status_label = QLabel("  ❌ VALIDATION FAILED  ")
            status_label.setFont(create_font(11, bold=True))
            status_label.setStyleSheet(f"color: {COLORS['error']}; background: transparent;")
            status_layout.addWidget(status_label)
            
            # Right bar - rounded on LEFT
            right_bar = QFrame()
            right_bar.setFixedWidth(4)
            right_bar.setStyleSheet(f"background-color: {COLORS['error']}; border-radius: 2px 0px 0px 2px;")
            status_layout.addWidget(right_bar)
            
            # Description
            desc_label = QLabel(f"  {blocking} blocking issue(s) must be fixed before backtest.")
            desc_label.setFont(create_font(11))
            desc_label.setStyleSheet(f"color: {COLORS['text_secondary']}; background: transparent;")
            desc_label.setWordWrap(True)
            status_layout.addWidget(desc_label, 1)
        
        info_layout.addWidget(status_container, 1)  # Stretch to take remaining space
        
        layout.addWidget(info_container)
        
        return widget
    
    def _create_status_banner(self) -> QWidget:
        """Create status banner showing pass/fail"""
        widget = QWidget()
        layout = QHBoxLayout(widget)
        layout.setContentsMargins(12, 12, 12, 12)
        
        if self.report.is_valid:
            # PASSED
            icon = QLabel("✅")
            icon.setFont(create_font(24))
            title = QLabel("VALIDATION PASSED")
            title.setFont(create_font(14, bold=True))
            title.setStyleSheet(f"color: {COLORS['success']};")
            
            desc = QLabel("Your strategy meets all requirements and is ready for backtesting.")
            desc.setFont(create_font(11))
            desc.setStyleSheet(f"color: {COLORS['text_secondary']};")
            desc.setWordWrap(True)
            
            widget.setStyleSheet(f"""
                QWidget {{
                    background-color: rgba(16, 185, 129, 0.1);
                    border-left: 4px solid {COLORS['success']};
                    border-radius: 4px;
                }}
            """)
        else:
            # FAILED - Smaller font, muted icon
            icon = QLabel("❌")
            icon.setFont(create_font(14))  # Reduced from 24 to 14
            icon.setStyleSheet(f"color: {COLORS['text_muted']};")  # Muted icon
            title = QLabel(f"VALIDATION FAILED")
            title.setFont(create_font(12, bold=True))  # Reduced from 14 to 12
            title.setStyleSheet(f"color: {COLORS['error']};")
            
            blocking = self.report.blocking_issues()
            desc = QLabel(
                f"{blocking} blocking issue(s) must be fixed before backtest. "
                "Review the Issues tab below for detailed guidance on resolving each issue."
            )
            desc.setFont(create_font(10))  # Reduced from 11 to 10
            desc.setStyleSheet(f"color: {COLORS['text_secondary']};")
            desc.setWordWrap(True)
            
            widget.setStyleSheet(f"""
                QWidget {{
                    background-color: rgba(220, 53, 69, 0.1);
                    border-left: 4px solid {COLORS['error']};
                    border-radius: 4px;
                }}
            """)
        
        layout.addWidget(icon)
        
        text_layout = QVBoxLayout()
        text_layout.setSpacing(4)
        text_layout.addWidget(title)
        text_layout.addWidget(desc)
        layout.addLayout(text_layout, 1)
        
        return widget
    
    def _create_tabs(self) -> QTabWidget:
        """Create tab widget with Summary, Issues, Metrics"""
        tabs = QTabWidget()
        tabs.setStyleSheet(get_tab_widget_stylesheet())
        
        # Tab 1: Summary
        summary_tab = self._create_summary_tab()
        tabs.addTab(summary_tab, "📊 Summary")
        
        # Tab 2: Issues (main tab - most important)
        issues_tab = self._create_issues_tab()
        tabs.addTab(issues_tab, "⚠️ Issues")
        
        # Tab 3: Metrics (shortened to avoid text cutoff)
        metrics_tab = self._create_metrics_tab()
        tabs.addTab(metrics_tab, "📈 Metrics")
        
        # Summary tab is ALWAYS default (tab index 0)
        # User requested: Summary tab should be default regardless of validation status
        tabs.setCurrentIndex(0)
        
        return tabs
    
    def _create_summary_tab(self) -> QWidget:
        """Create summary overview tab"""
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setSpacing(16)
        layout.setContentsMargins(16, 16, 16, 16)
        
        # Horizontal layout for Summary and Composition side by side
        top_row = QHBoxLayout()
        top_row.setSpacing(16)
        
        # Issue count summary
        summary_group = QGroupBox("Validation Summary")
        summary_group.setFont(create_font(12, bold=True))
        summary_layout = QVBoxLayout()
        
        counts = [
            ("Critical Issues", len(self.report.critical_issues), COLORS['error']),
            ("Errors", len(self.report.errors), COLORS['warning']),
            ("Warnings", len(self.report.warnings), "#FFD700"),
            ("Notices", len(self.report.notices), COLORS['info']),
            ("Info", len(self.report.info), COLORS['text_secondary'])
        ]
        
        for label, count, color in counts:
            row = QWidget()
            row.setStyleSheet(f"QWidget {{ background-color: {COLORS['bg_input']}; }}")
            row_layout = QHBoxLayout(row)
            row_layout.setContentsMargins(4, 4, 4, 4)
            
            label_widget = QLabel(f"{label}:")
            label_widget.setFont(create_font(11))
            label_widget.setMinimumWidth(150)
            row_layout.addWidget(label_widget)
            
            count_widget = QLabel(str(count))
            count_widget.setFont(create_font(11, bold=True))
            count_widget.setStyleSheet(f"color: {color};")
            row_layout.addWidget(count_widget)
            
            row_layout.addStretch()
            summary_layout.addWidget(row)
        
        summary_group.setLayout(summary_layout)
        top_row.addWidget(summary_group)
        
        # Strategy Composition
        composition_group = QGroupBox("Strategy Composition")
        composition_group.setFont(create_font(12, bold=True))
        composition_layout = QVBoxLayout()
        
        # Extract composition data from config
        composition_data = self._get_strategy_composition()
        
        composition_items = [
            ("Building Blocks", composition_data['blocks'], COLORS['info']),
            ("Total Signals", composition_data['signals'], COLORS['info']),
            ("Recheck", composition_data['rechecks'], COLORS['text_secondary']),
            ("Exit Conditions", composition_data['exits'], COLORS['success']),
            ("Entry Signals", composition_data['entry_signals'], COLORS['info']),
        ]
        
        for label, count, color in composition_items:
            row = QWidget()
            row.setStyleSheet(f"QWidget {{ background-color: {COLORS['bg_input']}; }}")
            row_layout = QHBoxLayout(row)
            row_layout.setContentsMargins(4, 4, 4, 4)
            
            label_widget = QLabel(f"{label}:")
            label_widget.setFont(create_font(11))
            label_widget.setMinimumWidth(150)
            row_layout.addWidget(label_widget)
            
            count_widget = QLabel(str(count))
            count_widget.setFont(create_font(11, bold=True))
            count_widget.setStyleSheet(f"color: {color};")
            row_layout.addWidget(count_widget)
            
            row_layout.addStretch()
            composition_layout.addWidget(row)
        
        composition_group.setLayout(composition_layout)
        top_row.addWidget(composition_group)
        
        layout.addLayout(top_row)
        
        # Complexity summary - SINGLE ROW with score and rating side by side
        complexity = self.report.complexity_metrics.get('complexity_score', 0)
        complexity_group = QGroupBox("Strategy Complexity")
        complexity_group.setFont(create_font(12, bold=True))  # Match other group boxes
        complexity_layout = QVBoxLayout()
        
        # Single row with both score and rating
        complexity_row = QWidget()
        complexity_row.setStyleSheet(f"QWidget {{ background-color: {COLORS['bg_input']}; }}")
        complexity_row_layout = QHBoxLayout(complexity_row)
        complexity_row_layout.setContentsMargins(4, 4, 4, 4)
        
        complexity_label = QLabel("Complexity Score:")
        complexity_label.setFont(create_font(11))  # Match other labels
        complexity_label.setMinimumWidth(150)
        complexity_row_layout.addWidget(complexity_label)
        
        complexity_value = QLabel(f"{complexity}/100")
        complexity_value.setFont(create_font(11, bold=True))  # Match other values
        
        if complexity < 30:
            rating = "Simple - Excellent for reliability"
            color = COLORS['success']
        elif complexity < 60:
            rating = "Moderate - Good balance"
            color = COLORS['info']
        else:
            rating = "Complex - Review for optimization opportunities"
            color = COLORS['warning']
        
        complexity_value.setStyleSheet(f"color: {color};")
        complexity_row_layout.addWidget(complexity_value)
        
        # Add separator
        separator = QLabel(" • ")
        separator.setFont(create_font(11))
        separator.setStyleSheet(f"color: {COLORS['text_muted']};")
        complexity_row_layout.addWidget(separator)
        
        # Add rating on same row
        rating_label = QLabel(rating)
        rating_label.setFont(create_font(11))
        rating_label.setStyleSheet(f"color: {color};")
        complexity_row_layout.addWidget(rating_label)
        
        complexity_row_layout.addStretch()
        
        complexity_layout.addWidget(complexity_row)
        complexity_group.setLayout(complexity_layout)
        layout.addWidget(complexity_group)
        
        # NEW: Strategy Flow Visualization - Institutional Grade
        # Uses stretch factor of 1 to expand and fill remaining space
        flow_group = self._create_strategy_flow_panel()
        layout.addWidget(flow_group, 1)  # Stretch factor 1 - fills remaining space
        
        # NO addStretch() here - flow panel should expand to fill space
        
        return widget
    
    def _create_issues_tab(self) -> QWidget:
        """Create issues table tab (main content)"""
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        
        # Create table
        table = QTableWidget()
        table.setStyleSheet(get_table_stylesheet())
        
        # Set columns
        table.setColumnCount(6)
        table.setHorizontalHeaderLabels([
            "Severity", "Category", "Issue", "Location", "Description & Guidance", "Action"
        ])
        
        # Collect all issues
        all_issues = []
        for issue in self.report.critical_issues:
            all_issues.append(('CRITICAL', issue))
        for issue in self.report.errors:
            all_issues.append(('ERROR', issue))
        for issue in self.report.warnings:
            all_issues.append(('WARNING', issue))
        for issue in self.report.notices:
            all_issues.append(('NOTICE', issue))
        for issue in self.report.info:
            all_issues.append(('INFO', issue))
        
        table.setRowCount(len(all_issues))
        
        # Populate rows
        for row, (severity, issue) in enumerate(all_issues):
            # Column 0: Severity
            severity_item = QTableWidgetItem(severity)
            severity_item.setFont(create_font(10, bold=True))
            severity_color = {
                'CRITICAL': COLORS['error'],
                'ERROR': COLORS['warning'],
                'WARNING': '#FFD700',
                'NOTICE': COLORS['info'],
                'INFO': COLORS['text_secondary']
            }[severity]
            severity_item.setForeground(QColor(severity_color))
            table.setItem(row, 0, severity_item)
            
            # Column 1: Category
            category_item = QTableWidgetItem(issue.category)
            category_item.setFont(create_font(10))
            table.setItem(row, 1, category_item)
            
            # Column 2: Issue
            issue_item = QTableWidgetItem(issue.rule_name)
            issue_item.setFont(create_font(10, bold=True))
            table.setItem(row, 2, issue_item)
            
            # Column 3: Location (formatted hierarchically)
            formatted_location = self._format_location(issue.location)
            location_item = QTableWidgetItem(formatted_location)
            location_item.setFont(create_font(10))
            table.setItem(row, 3, location_item)
            
            # Column 4: Description & Guidance (institutional-grade)
            desc_text = self._get_institutional_description(issue)
            # Add 1 line padding at the end
            desc_text += "\n"
            desc_item = QTableWidgetItem(desc_text)
            desc_item.setFont(create_font(10))
            desc_item.setTextAlignment(Qt.AlignLeft | Qt.AlignTop)
            # Enable word wrap for long descriptions
            desc_item.setFlags(desc_item.flags() | Qt.ItemIsEditable)
            table.setItem(row, 4, desc_item)
            
            # Column 5: Action - Sprint 1.9.2 Auto-Fix Button Integration
            if severity == 'INFO':
                # INFO level - no action needed
                action_item = QTableWidgetItem("✓ Passed")
                action_item.setFont(create_font(10))
                table.setItem(row, 5, action_item)
            elif hasattr(issue, 'auto_fix_available') and issue.auto_fix_available:
                # Create clickable fix button
                fix_btn = QPushButton("🔧 Fix Now")
                fix_btn.setFont(create_font(9))
                fix_btn.setMinimumWidth(110)  # enough for emoji + text
                fix_btn.setSizePolicy(QSizePolicy.Minimum, QSizePolicy.Fixed)
                fix_btn.setStyleSheet(get_auto_fix_button_style())
                fix_btn.setCursor(Qt.PointingHandCursor)
                fix_btn.setToolTip(self._get_fix_button_tooltip(issue))
                fix_btn.clicked.connect(lambda checked, iss=issue: self._handle_fix_click(iss))
                
                # Right-click for preview (stub for Task 1.9.2.7)
                fix_btn.setContextMenuPolicy(Qt.CustomContextMenu)
                fix_btn.customContextMenuRequested.connect(
                    lambda pos, iss=issue: self._show_fix_preview(iss)
                )
                
                table.setCellWidget(row, 5, fix_btn)
            else:
                # No auto-fix available
                action_text = self._get_action_text(issue)
                action_item = QTableWidgetItem(action_text)
                action_item.setFont(create_font(10))
                if severity in ['CRITICAL', 'ERROR']:
                    action_item.setForeground(QColor(COLORS['error']))
                table.setItem(row, 5, action_item)
        
        # Configure table
        table.setEditTriggers(QTableWidget.NoEditTriggers)
        table.setSelectionBehavior(QTableWidget.SelectRows)
        table.setSelectionMode(QTableWidget.SingleSelection)
        table.setAlternatingRowColors(True)
        table.verticalHeader().setVisible(False)
        
        # Enable word wrapping for all cells
        table.setWordWrap(True)
        table.setTextElideMode(Qt.ElideNone)
        
        # Set column widths
        header = table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.ResizeToContents)  # Severity
        header.setSectionResizeMode(1, QHeaderView.ResizeToContents)  # Category
        header.setSectionResizeMode(2, QHeaderView.ResizeToContents)  # Issue - fit to text
        header.setSectionResizeMode(3, QHeaderView.ResizeToContents)  # Location - fit to text
        header.setSectionResizeMode(4, QHeaderView.Stretch)  # Description (takes remaining space)
        header.setSectionResizeMode(5, QHeaderView.ResizeToContents)  # Action
        
        # CRITICAL FIX: Set vertical header to resize to contents automatically
        table.verticalHeader().setSectionResizeMode(QHeaderView.ResizeToContents)
        
        layout.addWidget(table)
        
        # Store table reference for later use
        self.issues_table = table
        
        return widget
    
    def _create_metrics_tab(self) -> QWidget:
        """Create metrics and analysis tab with collapsible sections (like AI Recommendations)"""
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setSpacing(8)
        layout.setContentsMargins(8, 8, 8, 8)
        
        # Track all sections for maximize functionality
        self.metrics_sections = []
        
        # Exit strategy analysis - collapsible (always green - informational)
        exit_section = self._create_metrics_collapsible_section(
            "✅ Exit Strategy Analysis",
            self._get_exit_strategy_info()
        )
        layout.addWidget(exit_section['widget'], 1)
        self.metrics_sections.append(exit_section)
        
        # Timing Conflict analysis - collapsible (RED if conflicts exist)
        if self.report.timing_conflicts:
            timing_section = self._create_metrics_collapsible_section(
                "❌ Timing Conflict Analysis",
                self._get_timing_conflicts_info(),
                title_color=COLORS['error']  # RED for errors
            )
            layout.addWidget(timing_section['widget'], 1)
            self.metrics_sections.append(timing_section)
        
        # Signal Direction analysis - collapsible (green if aligned, yellow if mixed)
        # Check if there are direction conflicts
        has_direction_issues = False
        for issue in (self.report.errors + self.report.warnings):
            if hasattr(issue, 'rule_id') and issue.rule_id == "DIRECTION_001":
                has_direction_issues = True
                break
        
        if has_direction_issues:
            direction_icon = "⚠️"
        else:
            direction_icon = "✅"
        
        direction_section = self._create_metrics_collapsible_section(
            f"{direction_icon} Signal Direction Analysis",
            self._get_direction_info()
        )
        layout.addWidget(direction_section['widget'], 1)
        self.metrics_sections.append(direction_section)

        # Walkforward Adjustment Counts - only shown when walkforward_result is provided
        if self.walkforward_result is not None:
            walkforward_section = self._create_metrics_collapsible_section(
                "📊 Walkforward Adjustment Counts",
                self._get_walkforward_adjustment_info()
            )
            layout.addWidget(walkforward_section['widget'], 1)
            self.metrics_sections.append(walkforward_section)

        # NO addStretch() - let sections expand to fill space

        return widget
    
    def _create_metrics_collapsible_section(self, title: str, content: str, title_color: str = "#095983") -> dict:
        """Create a collapsible section for Metrics tab (copied from AI Request Preview pattern)"""
        from PyQt5.QtWidgets import QFrame, QSizePolicy
        from PyQt5.QtGui import QTextOption
        
        container = QFrame()
        container.setStyleSheet(f"QFrame {{ background-color: {COLORS['bg_medium']}; border: 1px solid {COLORS['border']}; border-radius: 4px; }}")
        main_layout = QVBoxLayout(container)
        main_layout.setContentsMargins(8, 8, 8, 8)
        main_layout.setSpacing(8)
        
        # Header with title and buttons
        header_layout = QHBoxLayout()
        
        # Title - use custom color or default to Strategy Builder blue
        title_label = QLabel(title)
        title_label.setStyleSheet(f"color: {title_color}; font-weight: bold; font-size: 12pt; border: none; background: transparent;")
        header_layout.addWidget(title_label)
        
        header_layout.addStretch()
        
        # Maximize button
        maximize_btn = QPushButton("🗖 Maximize")
        set_hand_cursor(maximize_btn)
        maximize_btn.setFixedSize(180, 38)
        maximize_btn.setStyleSheet(f"""
            QPushButton {{
                background-color: {COLORS['button_primary']};
                color: white;
                font-weight: normal;
                padding: 3px 12px;
                border-radius: 3px;
                font-size: 9pt;
                border: none;
            }}
            QPushButton:hover {{
                background-color: {COLORS['button_primary_hover']};
            }}
        """)
        header_layout.addWidget(maximize_btn)
        
        # Collapse/Expand button
        toggle_btn = QPushButton("▼ Collapse")
        set_hand_cursor(toggle_btn)
        toggle_btn.setFixedSize(180, 38)
        toggle_btn.setStyleSheet(f"""
            QPushButton {{
                background-color: {COLORS['button_secondary']};
                color: white;
                font-weight: normal;
                padding: 3px 12px;
                border-radius: 3px;
                font-size: 9pt;
                border: none;
            }}
            QPushButton:hover {{
                background-color: {COLORS['button_secondary_hover']};
            }}
        """)
        header_layout.addWidget(toggle_btn)
        
        main_layout.addLayout(header_layout)
        
        # Text editor - Use same background as Strategy Flow for consistency
        text_edit = QTextEdit()
        text_edit.setReadOnly(True)
        text_edit.setFont(create_monospace_font(10))
        text_edit.setWordWrapMode(QTextOption.WrapMode.WordWrap)
        text_edit.setStyleSheet(f"QTextEdit {{ background-color: {COLORS['bg_input']}; color: {COLORS['text_primary']}; border: 1px solid {COLORS['border']}; padding: 8px; }}")
        text_edit.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        text_edit.setPlainText(content)
        main_layout.addWidget(text_edit)
        
        # Toggle collapse/expand
        def toggle_section():
            is_visible = text_edit.isVisible()
            if is_visible:
                # Check if maximized first
                if is_maximized[0]:
                    # Restore all sections
                    for section in self.metrics_sections:
                        if section['widget'] != container:
                            section['widget'].setVisible(True)
                        section['maximize_btn'].setText("🗖 Maximize")
                    is_maximized[0] = False
                
                # Now collapse
                text_edit.setVisible(False)
                toggle_btn.setText("▶ Expand")
                container.setMaximumHeight(60)
            else:
                # Expand
                text_edit.setVisible(True)
                toggle_btn.setText("▼ Collapse")
                container.setMaximumHeight(16777215)
        
        # Maximize/Minimize toggle
        is_maximized = [False]
        
        def toggle_maximize():
            if not is_maximized[0]:
                # Maximize - hide others
                for section in self.metrics_sections:
                    if section['widget'] != container:
                        section['widget'].setVisible(False)
                    else:
                        section['widget'].setVisible(True)
                        section['text_edit'].setVisible(True)
                        section['toggle_btn'].setText("▼ Collapse")
                        section['widget'].setMaximumHeight(16777215)
                        maximize_btn.setText("🗗 Minimize")
                is_maximized[0] = True
            else:
                # Minimize - restore all
                for section in self.metrics_sections:
                    section['widget'].setVisible(True)
                    section['text_edit'].setVisible(True)
                    section['toggle_btn'].setText("▼ Collapse")
                    section['widget'].setMaximumHeight(16777215)
                    section['maximize_btn'].setText("🗖 Maximize")
                is_maximized[0] = False
        
        toggle_btn.clicked.connect(toggle_section)
        maximize_btn.clicked.connect(toggle_maximize)
        
        return {
            'widget': container,
            'text_edit': text_edit,
            'toggle_btn': toggle_btn,
            'maximize_btn': maximize_btn
        }
    
    def _create_footer(self) -> QWidget:
        """Create footer with action buttons"""
        widget = QWidget()
        layout = QHBoxLayout(widget)
        layout.setSpacing(8)
        layout.setContentsMargins(0, 0, 0, 0)
        
        # Export CSV button
        export_btn = QPushButton("📄 Export Report to CSV")
        set_hand_cursor(export_btn)
        export_btn.setFont(create_font(11))
        export_btn.clicked.connect(self._export_csv)
        layout.addWidget(export_btn)
        
        layout.addStretch()
        
        # Undo button — enabled only when undo_manager.can_undo() is True
        self.undo_btn = QPushButton("↩ Undo Last Fix")
        set_hand_cursor(self.undo_btn)
        self.undo_btn.setFont(create_font(11))
        self.undo_btn.setMinimumWidth(140)
        self.undo_btn.setEnabled(False)
        self.undo_btn.setStyleSheet(get_secondary_button_stylesheet())
        self.undo_btn.setToolTip("Revert the most recently applied auto-fix and re-run validation")
        self.undo_btn.clicked.connect(self._handle_undo_click)
        layout.addWidget(self.undo_btn)
        
        # Generate Code button (primary action)
        self.generate_btn = QPushButton("📝 Generate Code")
        set_hand_cursor(self.generate_btn)
        self.generate_btn.setFont(create_font(11))
        self.generate_btn.setMinimumWidth(170)
        self.generate_btn.setStyleSheet(get_primary_button_stylesheet())
        self.generate_btn.setToolTip("Generate NautilusTrader Python strategy code from this configuration")
        self.generate_btn.clicked.connect(self._on_generate_code)
        layout.addWidget(self.generate_btn)
        
        # Close button
        close_btn = QPushButton("Close")
        set_hand_cursor(close_btn)
        close_btn.setFont(create_font(11))
        close_btn.setMinimumWidth(120)
        close_btn.clicked.connect(self.close)  # QMainWindow uses close(), not accept()
        layout.addWidget(close_btn)
        
        return widget
    
    def _on_generate_code(self) -> None:
        """Emit generate_code_requested signal for main window to handle."""
        self.generate_code_requested.emit()

    def _get_institutional_description(self, issue: any) -> str:
        """
        Get institutional-grade description with clear explanation and guidance
        
        This provides professional, institutional-grade content that helps users
        understand the issue and know exactly how to fix it.
        """
        # Base description
        desc = issue.message
        
        # Add suggestion if available
        if issue.suggestion:
            desc += f"\n\n💡 How to Fix: {issue.suggestion}"
        
        # Add institutional context for common issues
        if issue.rule_id == "TIMING_004":
            desc += "\n\n⚠️ Why This Matters: When RECHECK delays exceed timing windows, signals will never trigger because the recheck validation occurs after the window has already closed. This makes the signal functionally dead code."
        elif issue.rule_id == "DIRECTION_001":
            desc += "\n\n⚠️ Why This Matters: Trading in the wrong direction (e.g., bearish signals in a bullish strategy) will cause losses. Institutional traders never mix signal directions."
        elif issue.rule_id == "RECHECK_001":
            desc += "\n\n⚠️ Why This Matters: Circular RECHECK dependencies create infinite loops that prevent strategy execution. This is a critical structural error."
        elif issue.category == "EXIT_STRATEGY":
            desc += "\n\n📊 Note: Exit strategy analysis is informational. Multiple exit opportunities increase probability of profit-taking without blocking validation."
        
        return desc
    
    def _format_location(self, location: str) -> str:
        """
        Format location string hierarchically
        
        Input: "Block::hod::Signal::BELOW_HOD"
        Output: "Block: Hod\n└── Signal: BELOW_HOD"
        
        Capitalizes block names for better readability
        """
        if not location or '::' not in location:
            return location
        
        parts = location.split('::')
        formatted_lines = []
        
        # Process pairs (label::value)
        for i in range(0, len(parts), 2):
            if i + 1 < len(parts):
                label = parts[i]
                value = parts[i + 1]
                
                # Capitalize block names only (not signal names)
                if label == "Block":
                    value = value.capitalize()
                
                # Add tree structure indent for nested items
                if i == 0:
                    formatted_lines.append(f"{label}: {value}")
                else:
                    formatted_lines.append(f"└── {label}: {value}")
        
        return '\n'.join(formatted_lines)
    
    def _get_strategy_composition(self) -> dict:
        """
        Extract strategy composition data from config
        
        Uses EXACT same counting logic as main window (strategy_info_panel.py)
        
        Returns counts for:
        - Building blocks
        - Total signals
        - RECHECK conditions
        - Exit conditions
        - Entry signals
        """
        blocks_count = 0
        signals_count = 0
        rechecks_count = 0
        exits_count = 0
        entry_signals_count = 0
        
        if hasattr(self.config, 'blocks') and self.config.blocks:
            blocks_count = len(self.config.blocks)
            
            for block in self.config.blocks:
                if hasattr(block, 'signals') and block.signals:
                    signals_count += len(block.signals)
                    
                    for signal in block.signals:
                        # Count RECHECKs - EXACT logic from main window
                        # Check signal.recheck_config.enabled (not recheck_conditions!)
                        if hasattr(signal, 'recheck_config') and signal.recheck_config and signal.recheck_config.enabled:
                            rechecks_count += 1
                        
                        # Count entry signals (signals that are NOT exits)
                        is_exit = False
                        
                        if hasattr(signal, 'is_exit_signal') and signal.is_exit_signal:
                            is_exit = True
                        
                        if hasattr(signal, 'exit_for') and signal.exit_for and len(signal.exit_for) > 0:
                            is_exit = True
                        
                        # Only count as entry if NOT an exit signal
                        if not is_exit:
                            entry_signals_count += 1
        
        # Count exit conditions at ALL levels - EXACT logic from main window
        # Strategy-level exits
        if hasattr(self.config, 'exit_conditions') and self.config.exit_conditions:
            exits_count += len(self.config.exit_conditions)
        
        # Block-level exits
        if hasattr(self.config, 'blocks'):
            for block in self.config.blocks:
                if hasattr(block, 'exit_conditions') and block.exit_conditions:
                    exits_count += len(block.exit_conditions)
                
                # Signal-level exits
                if hasattr(block, 'signals'):
                    for signal in block.signals:
                        if hasattr(signal, 'exit_conditions') and signal.exit_conditions:
                            exits_count += len(signal.exit_conditions)
        
        return {
            'blocks': blocks_count,
            'signals': signals_count,
            'rechecks': rechecks_count,
            'exits': exits_count,
            'entry_signals': entry_signals_count
        }
    
    def _get_action_text(self, issue: any) -> str:
        """Get action text for issue"""
        if issue.auto_fix_available:
            return "🔧 Fix Available"
        elif issue.severity.name in ['CRITICAL', 'ERROR']:
            return "⚠️ Must Fix"
        elif issue.severity.name == 'WARNING':
            return "⚡ Should Review"
        else:
            return "ℹ️ Review"
    
    def _get_exit_strategy_info(self) -> str:
        """Get exit strategy analysis - Extract actual data from config"""
        lines = []
        lines.append("EXIT STRATEGY BREAKDOWN")
        lines.append("=" * 60)
        lines.append("")
        
        exit_count = 0
        
        # Strategy-level exits
        if hasattr(self.config, 'exit_conditions') and self.config.exit_conditions:
            lines.append("📍 STRATEGY-LEVEL EXITS:")
            for idx, exit_cond in enumerate(self.config.exit_conditions, 1):
                signal_name = getattr(exit_cond, 'signal_name', 'Unknown')
                percentage = getattr(exit_cond, 'percentage', 0) * 100
                mode = getattr(exit_cond, 'exit_mode', 'ABSOLUTE')
                lines.append(f"   Exit #{idx}: {signal_name} → Close {percentage:.0f}% ({mode})")
                exit_count += 1
            lines.append("")
        
        # Block-level exits
        if hasattr(self.config, 'blocks'):
            for block_idx, block in enumerate(self.config.blocks, 1):
                if hasattr(block, 'exit_conditions') and block.exit_conditions:
                    lines.append(f"📦 BLOCK {block_idx} ({block.name.upper()}) EXITS:")
                    for idx, exit_cond in enumerate(block.exit_conditions, 1):
                        signal_name = getattr(exit_cond, 'signal_name', 'Unknown')
                        percentage = getattr(exit_cond, 'percentage', 0) * 100
                        mode = getattr(exit_cond, 'exit_mode', 'ABSOLUTE')
                        lines.append(f"   Exit #{idx}: {signal_name} → Close {percentage:.0f}% ({mode})")
                        exit_count += 1
                    lines.append("")
                
                # Signal-level exits
                if hasattr(block, 'signals'):
                    for signal in block.signals:
                        if hasattr(signal, 'exit_conditions') and signal.exit_conditions:
                            lines.append(f"🎯 SIGNAL ({signal.name}) EXITS:")
                            for idx, exit_cond in enumerate(signal.exit_conditions, 1):
                                exit_signal_name = getattr(exit_cond, 'signal_name', 'Unknown')
                                percentage = getattr(exit_cond, 'percentage', 0) * 100
                                mode = getattr(exit_cond, 'exit_mode', 'ABSOLUTE')
                                lines.append(f"   Exit #{idx}: {exit_signal_name} → Close {percentage:.0f}% ({mode})")
                                exit_count += 1
                            lines.append("")
        
        if exit_count == 0:
            return "⚠️ WARNING: No exit conditions configured!\n\nThis strategy has no defined exit points. You must add exit conditions to close positions."
        
        lines.append("=" * 60)
        lines.append(f"TOTAL EXIT CONDITIONS: {exit_count}")
        lines.append("")
        lines.append("EXIT MODE EXPLANATIONS:")
        lines.append("")
        lines.append("✓ ABSOLUTE mode:")
        lines.append("  - Exits immediately when signal triggers")
        lines.append("  - Closes exact percentage of position")
        lines.append("  - No deferral logic")
        lines.append("")
        lines.append("✓ FLEXIBLE mode (Sprint 1.8 intelligent exits):")
        lines.append("  - Checks if price is heading toward TP")
        lines.append("  - DEFERS exit if within TP proximity threshold")
        lines.append("  - Allows position to reach TP first")
        lines.append("  - Executes on REVERSAL (price pulls back from TP)")
        lines.append("  - Protects gains from premature exits")
        lines.append("")
        lines.append("BENEFITS:")
        lines.append("✓ Multiple exit levels provide flexibility")
        lines.append("✓ Partial exits allow position scaling")
        lines.append("✓ FLEXIBLE mode maximizes TP capture rate")
        
        return "\n".join(lines)

    def _get_walkforward_adjustment_info(self) -> str:
        """Format walkforward adjustment counts for the Metrics tab section."""
        wf = self.walkforward_result
        lines = []
        lines.append("WALKFORWARD ADJUSTMENT COUNTS")
        lines.append("=" * 60)
        lines.append("")
        lines.append(f"  {'Metric':<35} {'Value':>10}")
        lines.append(f"  {'-'*35} {'-'*10}")
        lines.append(f"  {'TP1 Adjustments (total)':<35} {wf.tp1_adjustments:>10,}")
        lines.append(f"  {'TP2 Adjustments (total)':<35} {wf.tp2_adjustments:>10,}")
        lines.append(f"  {'TP3 Adjustments (total)':<35} {wf.tp3_adjustments:>10,}")
        lines.append(f"  {'SL Adjustments (total)':<35} {wf.sl_adjustments:>10,}")
        lines.append(f"  {'-'*35} {'-'*10}")
        lines.append(f"  {'Avg Adjustments / Position':<35} {wf.adjustments_per_position:>10.2f}")
        lines.append(f"  {'Total Positions':<35} {wf.total_positions:>10,}")
        lines.append("")
        lines.append("=" * 60)
        return "\n".join(lines)

    def _get_timing_conflicts_info(self) -> str:
        """Get timing conflicts detailed info with clear explanation"""
        if not self.report.timing_conflicts:
            return "✅ No timing conflicts detected.\n\nAll RECHECK delays are within their timing windows."
        
        lines = []
        lines.append("⚠️ TIMING CONFLICT DETECTED - CRITICAL ISSUE")
        lines.append("=" * 60)
        lines.append("")
        lines.append("WHAT THIS MEANS:")
        lines.append("Your RECHECK delay is longer than the timing window,")
        lines.append("which means the signal will NEVER successfully trigger.")
        lines.append("")
        lines.append("=" * 60)
        lines.append("")
        
        for idx, conflict in enumerate(self.report.timing_conflicts, 1):
            signal = conflict.get('signal', 'Unknown')
            timing_window = conflict.get('timing_window', 'N/A')
            recheck_delay = conflict.get('recheck_delay', 'N/A')
            
            lines.append(f"CONFLICT #{idx}:")
            lines.append(f"Signal: {signal}")
            lines.append("")
            lines.append(f"❌ Problem:")
            lines.append(f"   Timing Window: {timing_window} bars")
            lines.append(f"   RECHECK Delay: {recheck_delay} bars")
            lines.append("")
            lines.append(f"   The RECHECK happens at bar {recheck_delay},")
            lines.append(f"   but the timing window expires at bar {timing_window}.")
            lines.append(f"   This signal will NEVER trigger!")
            lines.append("")
            lines.append(f"✅ Solution:")
            lines.append(f"   1. Reduce RECHECK delay to ≤ {timing_window} bars, OR")
            lines.append(f"   2. Increase timing window to ≥ {recheck_delay} bars")
            lines.append("")
            lines.append("=" * 60)
            lines.append("")
        
        return "\n".join(lines)
    
    def _get_direction_info(self) -> str:
        """Get signal direction breakdown - Extract from config"""
        lines = []
        lines.append("SIGNAL DIRECTION BREAKDOWN")
        lines.append("=" * 60)
        lines.append("")
        
        bullish_signals = []
        bearish_signals = []
        neutral_signals = []
        
        # Extract signals from config and determine direction
        if hasattr(self.config, 'blocks'):
            for block in self.config.blocks:
                if hasattr(block, 'signals'):
                    for signal in block.signals:
                        signal_name = signal.name
                        
                        # Determine direction from signal name (common patterns)
                        signal_lower = signal_name.lower()
                        
                        # Bullish indicators
                        if any(word in signal_lower for word in ['bullish', 'bull', 'long', 'buy', 'support', 'bounce', 'breakout_up', 'cross_up']):
                            bullish_signals.append(signal_name)
                        # Bearish indicators
                        elif any(word in signal_lower for word in ['bearish', 'bear', 'short', 'sell', 'resistance', 'rejection', 'breakout_down', 'cross_down']):
                            bearish_signals.append(signal_name)
                        else:
                            neutral_signals.append(signal_name)
        
        bullish_count = len(bullish_signals)
        bearish_count = len(bearish_signals)
        neutral_count = len(neutral_signals)
        total = bullish_count + bearish_count + neutral_count
        
        if total == 0:
            return "⚠️ No signals detected in strategy.\n\nPlease add building blocks with signals."
        
        # Get strategy type from config
        strategy_type = getattr(self.config, 'strategy_type', 'Unknown')
        if not strategy_type or strategy_type == 'Unknown':
            strategy_type = getattr(self.config, 'type', 'Not Specified')
        
        lines.append(f"Strategy Type: {strategy_type}")
        lines.append("")
        
        lines.append(f"Total Signals: {total}")
        lines.append("")
        
        if bullish_count > 0:
            bullish_pct = (bullish_count / total) * 100
            lines.append(f"📈 BULLISH SIGNALS: {bullish_count} ({bullish_pct:.1f}%)")
            for signal in bullish_signals:
                lines.append(f"   • {signal}")
            lines.append("")
        
        if bearish_count > 0:
            bearish_pct = (bearish_count / total) * 100
            lines.append(f"📉 BEARISH SIGNALS: {bearish_count} ({bearish_pct:.1f}%)")
            for signal in bearish_signals:
                lines.append(f"   • {signal}")
            lines.append("")
        
        if neutral_count > 0:
            neutral_pct = (neutral_count / total) * 100
            lines.append(f"⚖️ NEUTRAL/EXIT SIGNALS: {neutral_count} ({neutral_pct:.1f}%)")
            for signal in neutral_signals:
                lines.append(f"   • {signal}")
            lines.append("")
        
        lines.append("=" * 60)
        lines.append("ANALYSIS:")
        lines.append("")
        
        # Analysis
        if bullish_count > 0 and bearish_count == 0:
            lines.append("✓ Pure bullish strategy - All signals aligned")
        elif bearish_count > 0 and bullish_count == 0:
            lines.append("✓ Pure bearish strategy - All signals aligned")
        elif bullish_count > 0 and bearish_count > 0:
            lines.append("⚠️ Mixed direction signals detected")
            lines.append("   Consider separating into distinct bullish/bearish strategies")
        elif neutral_count == total:
            lines.append("ℹ️ All signals are neutral (exits/conditions)")
        
        return "\n".join(lines)
    
    def _create_strategy_flow_panel(self) -> QGroupBox:
        """
        Create institutional-grade Strategy Flow visualization panel with maximize/minimize
        
        Presents the strategy execution flow in simple, user-friendly language
        with visual hierarchy showing signal flow, timing, and RECHECKs
        """
        from PyQt5.QtWidgets import QFrame
        
        # Use QFrame instead of QGroupBox for custom header
        flow_container = QFrame()
        flow_container.setStyleSheet(f"QFrame {{ background-color: {COLORS['bg_medium']}; border: 1px solid {COLORS['border']}; border-radius: 4px; }}")
        main_layout = QVBoxLayout(flow_container)
        main_layout.setContentsMargins(8, 8, 8, 8)
        main_layout.setSpacing(8)
        
        # Header with title and maximize button
        header_layout = QHBoxLayout()
        
        # Title
        title_label = QLabel("📋 Strategy Execution Flow")
        title_label.setStyleSheet("color: #095983; font-weight: bold; font-size: 12pt; border: none; background: transparent;")
        header_layout.addWidget(title_label)
        
        header_layout.addStretch()
        
        # Maximize/Minimize button only (no collapse)
        self.flow_maximize_btn = QPushButton("🗖 Maximize")
        self.flow_maximize_btn.setFixedSize(180, 38)
        self.flow_maximize_btn.setStyleSheet(f"""
            QPushButton {{
                background-color: {COLORS['button_primary']};
                color: white;
                font-weight: normal;
                padding: 3px 12px;
                border-radius: 3px;
                font-size: 9pt;
                border: none;
            }}
            QPushButton:hover {{
                background-color: {COLORS['button_primary_hover']};
            }}
        """)
        header_layout.addWidget(self.flow_maximize_btn)
        
        main_layout.addLayout(header_layout)
        
        # Create monospace text area for flow visualization
        flow_text_widget = QTextEdit()
        flow_text_widget.setReadOnly(True)
        flow_text_widget.setMinimumHeight(300)  # Minimum height, but can expand
        # No maxHeight - let it fill available space
        flow_text_widget.setFont(create_monospace_font(10))  # Monospace for alignment
        flow_text_widget.setStyleSheet(f"QTextEdit {{ color: {COLORS['text_primary']}; background-color: {COLORS['bg_input']}; border: 1px solid {COLORS['border']}; padding: 8px; }}")
        
        # Generate flow visualization with error handling
        try:
            flow_content = self._generate_strategy_flow()
            # Use HTML to support colored text for validation failures
            flow_text_widget.setHtml(f"<pre style='font-family: Courier New; font-size: 10pt; color: {COLORS['text_primary']};'>{flow_content}</pre>")
        except Exception as e:
            # Graceful fallback if flow generation fails
            error_msg = f"Error generating strategy flow: {str(e)}\n\nPlease check your strategy configuration."
            flow_text_widget.setPlainText(error_msg)
            flow_text_widget.setStyleSheet(f"QTextEdit {{ color: {COLORS['error']}; background-color: {COLORS['bg_input']}; border: 1px solid {COLORS['border']}; padding: 8px; }}")
        
        main_layout.addWidget(flow_text_widget)
        
        # Store references for maximize functionality
        self.flow_text_widget = flow_text_widget
        self.flow_container = flow_container
        
        # Maximize/minimize logic
        # Track other widgets in Summary tab to hide/show
        is_maximized = [False]
        
        def toggle_flow_maximize():
            if not is_maximized[0]:
                # Maximize - hide all other widgets in Summary tab
                # Get the Summary tab widget
                summary_tab = self.flow_container.parent()
                if summary_tab:
                    # Hide all children except flow_container
                    for child in summary_tab.findChildren(QWidget):
                        if child != self.flow_container and child.parent() == summary_tab:
                            child.setVisible(False)
                
                self.flow_maximize_btn.setText("🗗 Minimize")
                is_maximized[0] = True
            else:
                # Minimize - restore all widgets
                summary_tab = self.flow_container.parent()
                if summary_tab:
                    # Show all children again
                   for child in summary_tab.findChildren(QWidget):
                        if child.parent() == summary_tab:
                            child.setVisible(True)
                
                self.flow_maximize_btn.setText("🗖 Maximize")
                is_maximized[0] = False
        
        self.flow_maximize_btn.clicked.connect(toggle_flow_maximize)
        
        return flow_container
    
    def _generate_strategy_flow(self) -> str:
        """
        Generate institutional-grade strategy flow visualization with HTML coloring
        
        Shows:
        - Entry signal flow with timing windows
        - RECHECK validation chains
        - Exit conditions
        - Failed items highlighted in RED
        """
        if not hasattr(self.config, 'blocks') or not self.config.blocks:
            return "No strategy flow available - strategy has no building blocks."
        
        # Collect failed signal names from validation issues
        failed_signals = set()
        failed_blocks = set()
        timing_failed_signals = set()
        
        for issue in (self.report.critical_issues + self.report.errors):
            # Extract signal/block names from location
            if hasattr(issue, 'location') and issue.location:
                parts = issue.location.split('::')
                for i in range(0, len(parts)-1, 2):
                    if i+1 < len(parts):
                        label = parts[i]
                        value = parts[i+1]
                        if label == "Signal":
                            failed_signals.add(value)
                        elif label == "Block":
                            failed_blocks.add(value.lower())
            
            # Mark timing conflicts
            if hasattr(issue, 'rule_id') and issue.rule_id == "TIMING_004":
                if hasattr(issue, 'location') and 'Signal::' in issue.location:
                    parts = issue.location.split('::')
                    for i in range(len(parts)):
                        if parts[i] == "Signal" and i+1 < len(parts):
                            timing_failed_signals.add(parts[i+1])
        
        lines = []
        lines.append("=" * 80)
        lines.append("STRATEGY EXECUTION FLOW - HOW YOUR STRATEGY WORKS")
        lines.append("=" * 80)
        lines.append("")
        
        # Add validation failure notice if strategy failed
        if not self.report.is_valid:
            blocking = self.report.blocking_issues()
            lines.append('<span style="color: #FFA500;">⚠️  VALIDATION FAILED</span>')
            lines.append(f'<span style="color: #FFA500;">⚠️  {blocking} blocking issue(s) detected - items marked in RED below</span>')
            lines.append('<span style="color: #FFA500;">⚠️  See \'Issues\' tab for detailed fix instructions</span>')
            lines.append("")
            lines.append("=" * 80)
            lines.append("")
        
        # Process each block
        for block_idx, block in enumerate(self.config.blocks, 1):
            block_logic = getattr(block, 'logic', 'AND')
            # Clearer explanation for OR logic
            if block_logic == "AND":
                logic_text = "ALL signals required"
            else:
                logic_text = "OPTIONAL - any 1 signal triggers entry"
            
            lines.append(f"📦 BLOCK {block_idx}: {block.name.upper()} ({logic_text})")
            lines.append("")
            
            if not hasattr(block, 'signals') or not block.signals:
                lines.append("   (No signals configured)")
                lines.append("")
                continue
            
            # Process each signal in block
            for sig_idx, signal in enumerate(block.signals, 1):
                # Check if it's an exit signal
                is_exit = False
                if hasattr(signal, 'is_exit_signal') and signal.is_exit_signal:
                    is_exit = True
                elif hasattr(signal, 'exit_for') and signal.exit_for and len(signal.exit_for) > 0:
                    is_exit = True
                
                # Check if signal failed validation
                signal_failed = signal.name in failed_signals or signal.name in timing_failed_signals
                
                if is_exit:
                    signal_line = f"   🚪 EXIT SIGNAL: {signal.name}"
                else:
                    signal_line = f"   🎯 ENTRY SIGNAL: {signal.name}"
                
                # Apply red color if failed
                if signal_failed:
                    lines.append(f'<span style="color: #FF4444;">{signal_line} ⚠️ FAILED VALIDATION</span>')
                else:
                    lines.append(signal_line)
                
                # Check for timing constraints
                if hasattr(signal, 'timing_constraint') and signal.timing_constraint:
                    timing = signal.timing_constraint
                    ref = getattr(timing, 'reference', 'previous signal')
                    window = getattr(timing, 'max_candles', 0)
                    if window > 0:
                        lines.append(f"      └── ⏱️  Timing: Must trigger within {window} candles of '{ref}'")
                
                # Check for RECHECK configurations
                if hasattr(signal, 'recheck_config') and signal.recheck_config:
                    if hasattr(signal.recheck_config, 'enabled') and signal.recheck_config.enabled:
                        delay = getattr(signal.recheck_config, 'bar_delay', 0)
                        parent = getattr(signal.recheck_config, 'parent_signal', None)
                        # FIX: If parent is None, default to signal's own name
                        if not parent:
                            parent = signal.name
                        
                        lines.append(f"      └── 🔄 RECHECK: Validate '{parent}' after {delay} bars")
                        lines.append(f"          ├── If found: Signal VALID ✓")
                        lines.append(f"          └── If not found: Signal RESET ✗")
                        
                        # Check for nested RECHECK chain
                        if hasattr(signal, 'recheck_chain') and signal.recheck_chain:
                            for recheck_idx, recheck in enumerate(signal.recheck_chain, 1):
                                recheck_delay = getattr(recheck, 'bar_delay', 0)
                                recheck_parent = getattr(recheck, 'parent_signal', None)
                                # FIX: If parent is None, default to signal's own name
                                if not recheck_parent:
                                    recheck_parent = signal.name
                                indent = "             " + ("   " * recheck_idx)
                                lines.append(f"{indent}└── 🔄 RECHECK #{recheck_idx+1}: Validate '{recheck_parent}' after {recheck_delay} bars")
                
                # Check for signal-level exit conditions
                if hasattr(signal, 'exit_conditions') and signal.exit_conditions:
                    for exit_idx, exit_cond in enumerate(signal.exit_conditions, 1):
                        exit_signal_name = getattr(exit_cond, 'signal_name', 'Unknown')
                        exit_percentage = getattr(exit_cond, 'percentage', 0) * 100
                        exit_mode = getattr(exit_cond, 'exit_mode', 'ABSOLUTE')
                        lines.append(f"      └── 🚪 EXIT: {exit_signal_name} → Close {exit_percentage:.0f}% ({exit_mode})")
                
                lines.append("")
            
            # Add block-level exit conditions
            if hasattr(block, 'exit_conditions') and block.exit_conditions:
                lines.append("   📍 BLOCK-LEVEL EXITS:")
                for exit_idx, exit_cond in enumerate(block.exit_conditions, 1):
                    exit_signal_name = getattr(exit_cond, 'signal_name', 'Unknown')
                    exit_percentage = getattr(exit_cond, 'percentage', 0) * 100
                    exit_mode = getattr(exit_cond, 'exit_mode', 'ABSOLUTE')
                    lines.append(f"      🚪 EXIT #{exit_idx}: {exit_signal_name} → Close {exit_percentage:.0f}% ({exit_mode})")
                lines.append("")
        
        # Add exit conditions from strategy level
        if hasattr(self.config, 'exit_conditions') and self.config.exit_conditions:
            lines.append("=" * 80)
            lines.append("EXIT CONDITIONS (Strategy-Level)")
            lines.append("=" * 80)
            lines.append("")
            
            for exit_idx, exit_cond in enumerate(self.config.exit_conditions, 1):
                signal_name = getattr(exit_cond, 'signal_name', 'Unknown')
                percentage = getattr(exit_cond, 'percentage', 0) * 100
                mode = getattr(exit_cond, 'exit_mode', 'ABSOLUTE')
                
                lines.append(f"   🚪 EXIT #{exit_idx}: {signal_name} triggers")
                lines.append(f"      └── Action: Close {percentage:.0f}% of position ({mode} mode)")
                lines.append("")
        
        lines.append("=" * 80)
        lines.append("POSITION OPENING LOGIC - INSTITUTIONAL-GRADE CONFLUENCE SYSTEM")
        lines.append("=" * 80)
        lines.append("")
        
        # Count REQUIRED vs OPTIONAL blocks
        required_blocks = [b for b in self.config.blocks if getattr(b, 'logic', 'AND') == 'AND']
        optional_blocks = [b for b in self.config.blocks if getattr(b, 'logic', 'AND') == 'OR']
        
        lines.append("BLOCK TYPES IN YOUR STRATEGY:")
        lines.append("")
        
        # Show each block with correct terminology
        for block_idx, block in enumerate(self.config.blocks, 1):
            block_logic = getattr(block, 'logic', 'AND')
            num_signals = len(block.signals) if hasattr(block, 'signals') else 0
            
            if block_logic == "AND":
                lines.append(f"Block {block_idx} ({block.name.upper()}) - REQUIRED (AND logic)")
                lines.append(f"   • Type: REQUIRED - ALL {num_signals} signals must trigger")
                lines.append(f"   • Contributes: ~{num_signals * 10} pts (required)")
                lines.append(f"   • If ANY signal missing → 0 points from this block")
            else:  # OR logic
                lines.append(f"Block {block_idx} ({block.name.upper()}) - OPTIONAL (OR logic)")
                lines.append(f"   • Type: OPTIONAL - ANY 1 of {num_signals} signals can trigger")
                lines.append(f"   • Contributes: ~{num_signals * 10} pts (bonus)")
                lines.append(f"   • Adds bonus points if signals fire")
            lines.append("")
        
        lines.append("=" * 80)
        lines.append("CONFLUENCE SCORING SYSTEM - HOW POSITION ACTUALLY OPENS")
        lines.append("=" * 80)
        lines.append("")
        
        # Calculate points
        required_points = sum(len(b.signals) * 10 for b in required_blocks if hasattr(b, 'signals'))
        optional_points = sum(len(b.signals) * 10 for b in optional_blocks if hasattr(b, 'signals'))
        total_possible = required_points + optional_points
        
        lines.append(f"Your Strategy Point Breakdown:")
        lines.append(f"   • Required Points: {required_points} pts ({len(required_blocks)} REQUIRED blocks)")
        lines.append(f"   • Optional Points: {optional_points} pts ({len(optional_blocks)} OPTIONAL blocks)")
        lines.append(f"   • Total Possible: {total_possible} pts")
        lines.append("")
        lines.append("POSITION OPENS WHEN:")
        lines.append(f"   ⇨ Confluence Score >= Threshold (e.g., 40 pts)")
        lines.append(f"   ⇨ ONLY ONE POSITION opens when threshold met")
        lines.append(f"   ⇨ Once open, strategy manages THIS POSITION with exits/TP/SL")
        lines.append("")
        
        # Real examples from user's strategy
        lines.append("Real-World Scenarios:")
        lines.append("")
        lines.append("Scenario A: All REQUIRED blocks fire (high confidence)")
        # FIXED: Show ALL required blocks, not just first 2
        for idx, block in enumerate(required_blocks, 1):
            lines.append(f"   • Block {idx} ({block.name.upper()}): ALL signals ✓ → +{len(block.signals) * 10} pts")
        if len(optional_blocks) > 0:
            lines.append(f"   • Optional blocks: Not needed")
        lines.append(f"   Total: {required_points} pts → POSITION OPENS ✓")
        lines.append("")
        
        if len(optional_blocks) > 0:
            lines.append("Scenario B: Some REQUIRED + OPTIONAL blocks (mixed)")
            if len(required_blocks) > 0:
                lines.append(f"   • Block 1 ({required_blocks[0].name.upper()}): ALL signals ✓ → +{len(required_blocks[0].signals) * 10} pts")
            if len(optional_blocks) > 0:
                lines.append(f"   • Block {len(required_blocks)+1} ({optional_blocks[0].name.upper()}): 1 signal ✓ → +10 pts")
            estimated = (len(required_blocks[0].signals) * 10 if required_blocks else 0) + 10
            if estimated >= 40:
                lines.append(f"   Total: ~{estimated} pts → POSITION OPENS ✓")
            else:
                lines.append(f"   Total: ~{estimated} pts → Need more signals")
            lines.append("")
        
        lines.append("Scenario C: Insufficient confluence (no position)")
        if len(required_blocks) > 0:
            lines.append(f"   • Block 1 ({required_blocks[0].name.upper()}): Missing 1 signal ✗ → 0 pts")
        if len(optional_blocks) > 0:
            lines.append(f"   • Optional blocks: 1-2 signals ✓ → +20 pts")
        lines.append(f"   Total: ~20 pts → Below threshold, NO POSITION")
        lines.append("")
        
        lines.append("=" * 80)
        lines.append("KEY TAKEAWAYS:")
        lines.append("=" * 80)
        lines.append("")
        lines.append("✓ REQUIRED blocks (AND): Must have ALL signals to contribute points")
        lines.append("✓ OPTIONAL blocks (OR): Contribute bonus points if ANY signal fires")
        lines.append("✓ Position opens when: Total points >= Confluence Threshold")
        lines.append("✓ ONE POSITION only: Not multiple trades")
        lines.append("✓ Threshold configurable: In backtest config (default ~40 pts)")
        lines.append("")
        lines.append("=" * 80)
        lines.append("EXECUTION: Signals evaluated bar-by-bar in real-time")
        lines.append("=" * 80)
        
        return "\n".join(lines)
    
    def _export_csv(self):
        """Export validation report to CSV"""
        filename, _ = QFileDialog.getSaveFileName(
            self,
            "Export Validation Report",
            f"validation_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv",
            "CSV Files (*.csv)"
        )
        
        if filename:
            try:
                with open(filename, 'w', newline='') as f:
                    writer = csv.writer(f)
                    
                    # Header
                    writer.writerow(['BTC Trade Engine - Institutional Validation Report'])
                    writer.writerow([])
                    writer.writerow(['Strategy:', self.report.strategy_summary.get('name', 'Unknown')])
                    writer.writerow(['Validated:', datetime.fromisoformat(self.report.timestamp).strftime('%Y-%m-%d %H:%M:%S')])
                    writer.writerow(['Status:', 'PASSED' if self.report.is_valid else 'FAILED'])
                    writer.writerow([])
                    
                    # Issues table
                    writer.writerow(['Severity', 'Category', 'Rule ID', 'Issue', 'Location', 'Description', 'Suggestion'])
                    
                    all_issues = (
                        self.report.critical_issues +
                        self.report.errors +
                        self.report.warnings +
                        self.report.notices +
                        self.report.info
                    )
                    
                    for issue in all_issues:
                        writer.writerow([
                            issue.severity.name,
                            issue.category,
                            issue.rule_id,
                            issue.rule_name,
                            issue.location,
                            issue.message,
                            issue.suggestion or ''
                        ])
                
                QMessageBox.information(
                    self,
                    "Export Complete",
                    f"Validation report exported successfully!\n\nFile: {filename}"
                )
            except Exception as e:
                QMessageBox.critical(
                    self,
                    "Export Error",
                    f"Failed to export report:\n\n{str(e)}"
                )
    
    def _populate_data(self):
        """Populate window with report data (called after UI init)"""
        # Data populated via _create_tabs and table population
        pass
    
    def _restore_geometry(self):
        """Deprecated: geometry is now restored via WindowGeometryMixin in showEvent."""
        pass
    
    def showEvent(self, event):
        """Called when window is shown - apply hand cursors to all widgets"""
        super().showEvent(event)
        self._restore_window_geometry(event)
        # Apply hand cursor AFTER Qt finishes all stylesheet processing
        QTimer.singleShot(200, lambda: apply_hand_cursor_to_buttons(self))
    
    def closeEvent(self, event):
        """Save window geometry on close"""
        self._save_window_geometry()
        super().closeEvent(event)
    
    # =========================================================================
    # AUTO-FIX BUTTON HANDLERS - Sprint 1.9.2
    # =========================================================================
    
    def _get_fix_button_tooltip(self, issue: any) -> str:
        """
        Get institutional tooltip for fix button
        Sprint 1.9.2 Task 1.9.2.6
        
        Provides specific guidance based on issue type
        """
        tooltips = {
            'DIRECTION_001': "Click to automatically switch strategy direction to match signal bias. Right-click to preview changes before applying.",
            'TIMING_004': "Click to reduce RECHECK delay to fit within timing window. Right-click to see exact adjustments.",
            'EXIT_003': "Click to merge duplicate exit conditions. Right-click to preview consolidated result.",
            'DEAD_CODE_001': "Click to disable unreachable signals. Right-click to preview which signals will be affected."
        }
        
        rule_id = getattr(issue, 'rule_id', '')
        return tooltips.get(rule_id, "Click to apply automated fix. Right-click to preview changes.")
    
    def _build_fix_dialog_args(self, issue: any) -> dict:
        """
        Build AutoFixConfirmDialog constructor arguments from a ValidationIssue.

        Returns a dict with keys: fix_type, fix_description, before_state,
        after_state, impact_analysis, options.
        """
        auto_fix_data = getattr(issue, 'auto_fix_data', {}) or {}
        rule_id = getattr(issue, 'rule_id', '')

        if rule_id == 'DIRECTION_001':
            current_type = auto_fix_data.get('current_type', 'Unknown')
            suggested_type = auto_fix_data.get('suggested_type', 'Unknown')
            return {
                'fix_type': 'Switch Direction',
                'fix_description': (
                    f"Switch strategy direction from '{current_type}' to '{suggested_type}' "
                    f"to match the majority signal bias."
                ),
                'before_state': {
                    'strategy_type': current_type,
                    'issue': issue.message,
                },
                'after_state': {
                    'strategy_type': suggested_type,
                    'issue': 'Resolved — direction matches signal bias',
                },
                'impact_analysis': (
                    f"Strategy type will be changed from '{current_type}' to '{suggested_type}'. "
                    f"All existing signals and blocks are preserved. "
                    f"Re-validation will run automatically to confirm the fix."
                ),
                'options': None,
            }

        elif rule_id == 'TIMING_004':
            timing_window = auto_fix_data.get('timing_window', 'N/A')
            current_delay = auto_fix_data.get('current_delay', 'N/A')
            suggested_delay = auto_fix_data.get('suggested_delay', 'N/A')
            signal_name = getattr(issue, 'location', '').split('::')[-1] if '::' in getattr(issue, 'location', '') else 'Unknown'
            return {
                'fix_type': 'Reduce RECHECK Delay',
                'fix_description': (
                    f"Reduce RECHECK delay for signal '{signal_name}' from {current_delay} bars "
                    f"to {suggested_delay} bars (timing window: {timing_window} candles)."
                ),
                'before_state': {
                    'signal': signal_name,
                    'recheck_delay': f"{current_delay} bars",
                    'timing_window': f"{timing_window} candles",
                    'status': 'NEVER TRIGGERS — delay exceeds window',
                },
                'after_state': {
                    'signal': signal_name,
                    'recheck_delay': f"{suggested_delay} bars",
                    'timing_window': f"{timing_window} candles",
                    'status': 'Will trigger within window',
                },
                'impact_analysis': (
                    f"RECHECK delay reduced from {current_delay} to {suggested_delay} bars "
                    f"(75% of the {timing_window}-candle timing window). "
                    f"Signal will now be reachable within the configured timing window."
                ),
                'options': None,
            }

        elif rule_id == 'EXIT_009':
            signal_name = auto_fix_data.get('signal_name', 'Unknown')
            return {
                'fix_type': 'Consolidate Exit Conditions',
                'fix_description': (
                    f"Merge conflicting exit conditions for signal '{signal_name}' "
                    f"into a single consistent exit mode."
                ),
                'before_state': {
                    'signal': signal_name,
                    'exit_modes': 'Multiple conflicting modes',
                    'issue': issue.message,
                },
                'after_state': {
                    'signal': signal_name,
                    'exit_modes': 'Single consolidated mode',
                    'issue': 'Resolved',
                },
                'impact_analysis': (
                    f"Duplicate/conflicting exit conditions for '{signal_name}' will be merged. "
                    f"The dominant exit mode will be retained. "
                    f"Re-validation runs automatically to confirm."
                ),
                'options': None,
            }

        elif rule_id == 'LOGIC_003':
            signal_name = auto_fix_data.get('signal_name', 'Unknown')
            return {
                'fix_type': 'Disable Dead Code Signal',
                'fix_description': (
                    f"Disable unreachable signal '{signal_name}' "
                    f"which references a future signal and can never trigger."
                ),
                'before_state': {
                    'signal': signal_name,
                    'status': 'Active (but unreachable — dead code)',
                    'issue': issue.message,
                },
                'after_state': {
                    'signal': signal_name,
                    'status': 'Disabled (removed from active evaluation)',
                    'issue': 'Resolved',
                },
                'impact_analysis': (
                    f"Signal '{signal_name}' will be disabled. "
                    f"It currently has impossible timing (references a future signal) "
                    f"and will never evaluate. Disabling removes it from active logic without deleting it."
                ),
                'options': {
                    'disable_only': {
                        'label': 'Disable only (keep signal for reference)',
                        'default': True,
                        'tooltip': 'Signal is disabled but preserved in the config — safer option',
                    },
                },
            }

        else:
            # Generic fallback for unrecognised rules
            return {
                'fix_type': issue.rule_name,
                'fix_description': issue.message,
                'before_state': {'rule': rule_id, 'status': 'Issue detected', 'message': issue.message},
                'after_state': {'rule': rule_id, 'status': 'Fixed'},
                'impact_analysis': (
                    f"Auto-fix will be applied for rule '{rule_id}'. "
                    f"A safety backup is created before any changes. "
                    f"Validation re-runs automatically to confirm the result."
                ),
                'options': None,
            }

    def _handle_fix_click(self, issue: any) -> None:
        """
        Handle fix button click - INSTITUTIONAL GRADE DIRECT ACCESS
        Sprint 1.9.2 - Refactored to use validator-provided data

        Flow: Extract data from issue → Show AutoFixConfirmDialog → Apply fix
              → Feedback → Re-validate

        Key: Uses issue.auto_fix_data dict and issue.location (no regex needed)
        """
        # Build and show the institutional-grade confirmation dialog
        dialog_args = self._build_fix_dialog_args(issue)
        dialog = AutoFixConfirmDialog(
            fix_type=dialog_args['fix_type'],
            fix_description=dialog_args['fix_description'],
            before_state=dialog_args['before_state'],
            after_state=dialog_args['after_state'],
            impact_analysis=dialog_args['impact_analysis'],
            options=dialog_args['options'],
            parent=self,
        )
        dialog.exec_()

        if not dialog.user_confirmed:
            return

        # Capture pre-fix snapshot for undo support
        pre_fix_snapshot = deepcopy(self.config)

        # Extract location components (block_name, signal_name)
        location_data = self._extract_location_components(issue.location)
        
        # Get auto-fix data from validator (already computed!)
        auto_fix_data = getattr(issue, 'auto_fix_data', {}) or {}

        # Capture user options from dialog (e.g. disable_only for LOGIC_003)
        user_options = dialog.user_options
        
        # Apply fix - institutional grade direct access approach
        success = False
        error_msg = None
        
        try:
            if issue.rule_id == 'DIRECTION_001':
                # Direction switch - use suggested_type from auto_fix_data
                suggested_type = auto_fix_data.get('suggested_type')
                if suggested_type:
                    success = auto_fix_strategy_type(self.config, suggested_type)
                else:
                    error_msg = "No suggested direction in fix data"
          
            
            elif issue.rule_id == 'TIMING_004':
                # RECHECK timing fix - use data from auto_fix_data
                timing_window = auto_fix_data.get('timing_window')
                signal_name = location_data.get('signal_name')
                
                if signal_name and timing_window:
                    success = self._apply_recheck_timing_fix(signal_name, timing_window)
                else:
                    error_msg = f"Missing data - signal:{signal_name}, window:{timing_window}"
            
            elif issue.rule_id == 'EXIT_009':
                # Exit consolidation - use signal_name from auto_fix_data
                signal_name = auto_fix_data.get('signal_name')
                if signal_name:
                    # Determine level from location
                    if 'Signal::' in issue.location:
                        level = 'signal'
                    elif 'Block::' in issue.location:
                        level = 'block'
                    else:
                        level = 'strategy'
                    
                    success = self._apply_exit_consolidation_fix(signal_name, level)
                else:
                    error_msg = "No signal name in fix data"
            
            elif issue.rule_id == 'LOGIC_003':
                # Dead code - use signal_name from auto_fix_data
                signal_name = auto_fix_data.get('signal_name') or location_data.get('signal_name')
                block_name = location_data.get('block_name')
                # Honour user choice: disable_only=True → preserve_history=True (disable),
                #                     disable_only=False → preserve_history=False (remove)
                disable_only = user_options.get('disable_only', True)
                
                if signal_name and block_name:
                    success = self._apply_dead_code_fix(signal_name, block_name, preserve_history=disable_only)
                else:
                    error_msg = f"Missing data - signal:{signal_name}, block:{block_name}"
            
            else:
                error_msg = f"No auto-fix handler for rule {issue.rule_id}"
                
        except Exception as e:
            error_msg = str(e)
            success = False
        
        # Show result feedback
        if success:
            # Record snapshot into undo history so the fix can be reverted
            self.undo_manager.record_fix(pre_fix_snapshot, label=issue.rule_name)
            self._refresh_undo_button()
            
            # CRITICAL FIX (BTCAAAAA-125): Show success dialog BEFORE emitting the
            # fix_applied signal. Previously the signal was emitted first, which
            # synchronously called _on_save_strategy() in the parent window — that
            # could show its own "No Changes" dialog — and only then the success
            # dialog appeared here, giving the user two sequential message boxes.
            # Showing our dialog first ensures the user sees exactly one box.
            msg = QMessageBox(self)
            msg.setWindowTitle("✅ Fix Applied Successfully")
            msg.setText(
                f"Auto-fix completed: {issue.rule_name}\n\n"
                f"Validation will re-run automatically to verify the fix.\n\n"
                f"The fix will be saved to the database automatically."
            )
            msg.setIcon(QMessageBox.Information)
            msg.setMinimumWidth(400)
            msg.exec_()
            
            # Emit signal to notify parent window of config changes.
            # Parent window (Strategy Builder) handles database persistence.
            # Emitting AFTER the dialog ensures only one message box appears.
            self.fix_applied.emit(issue.rule_id, {'issue': issue.rule_name})
            
            # Re-run validation
            self._rerun_validation()
        else:
            QMessageBox.warning(
                self,
                "❌ Fix Failed",
                f"Could not apply auto-fix: {issue.rule_name}\n\n"
                f"Error: {error_msg or 'Unknown error'}\n\n"
                f"Your strategy has been restored to its original state.\n"
                f"No changes were made."
            )
    
    def _refresh_undo_button(self) -> None:
        """Update Undo button enabled/disabled state to match undo_manager."""
        if hasattr(self, 'undo_btn'):
            can_undo = self.undo_manager.can_undo()
            self.undo_btn.setEnabled(can_undo)
            label = self.undo_manager.peek_last_label()
            if can_undo and label:
                self.undo_btn.setToolTip(f"Undo: {label}")
            else:
                self.undo_btn.setToolTip("No fixes to undo")
    
    def _handle_undo_click(self) -> None:
        """
        Handle Undo button click — revert most recent auto-fix and re-run validation.
        
        Flow: restore config from snapshot → update undo stack →
              refresh Undo button state → re-run validation.
        """
        if not self.undo_manager.can_undo():
            return
        
        label = self.undo_manager.peek_last_label()
        result = QMessageBox.question(
            self,
            "Confirm Undo",
            f"Undo the fix for '{label}'?\n\n"
            f"The strategy will be restored to the state before this fix was applied.\n\n"
            f"Proceed?",
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.Yes,
        )
        
        if result != QMessageBox.Yes:
            return
        
        success = self.undo_manager.undo_last_fix(self.config)
        
        if success:
            self._refresh_undo_button()
            QMessageBox.information(
                self,
                "↩ Undo Successful",
                f"Fix '{label}' has been reverted.\n\n"
                f"Validation will re-run to reflect the restored strategy.\n\n"
                f"⚠️ IMPORTANT: Please save your strategy to persist this change.",
            )
            self._rerun_validation()
        else:
            QMessageBox.warning(
                self,
                "Undo Failed",
                "Could not restore the previous strategy state.\n\n"
                "No changes were made.",
            )
    
    def _show_fix_preview(self, issue: any) -> None:
        """
        Show fix preview on right-click
        Sprint 1.9.2 Task 1.9.2.6 (stub for Task 1.9.2.7)
        
        Full preview dialog will be implemented in Task 1.9.2.7
        """
        QMessageBox.information(
            self,
            "Fix Preview",
            f"Preview for: {issue.rule_name}\n\n"
            f"Detailed before/after comparison coming in Task 1.9.2.7.\n\n"
            f"This will show:\n"
            f"• Current configuration\n"
            f"• Proposed changes\n"
            f"• Impact analysis\n"
            f"• Cascading effects (if any)"
        )
    
    def _rerun_validation(self) -> None:
        """
        Re-run validation after applying fix
        Sprint 1.9.2 Task 1.9.2.8
        
        Updates validation report with new results
        Refreshes all tabs (Summary, Issues, Metrics)
        """
        from PyQt5.QtWidgets import QApplication
        
        # Show progress indicator
        QApplication.setOverrideCursor(Qt.WaitCursor)
        
        try:
            # Run validation - FIXED: Method is validate(), not validate_strategy_config()
            validator = InstitutionalValidator()
            new_report = validator.validate(self.config)
            
            # Update report
            self.report = new_report
            
            # Recreate tabs with new data
            self._reinitialize_ui()
            
            # Navigate to Issues tab (index 1) so user can confirm the fix
            # was applied and see remaining issues (or empty table if all resolved).
            if hasattr(self, 'tabs'):
                self.tabs.setCurrentIndex(1)
            
        except Exception as e:
            QMessageBox.warning(
                self,
                "Validation Error",
                f"Could not re-run validation:\n\n{str(e)}\n\n"
                f"Please close and reopen the validation report."
            )
        finally:
            QApplication.restoreOverrideCursor()
    
    def _reinitialize_ui(self) -> None:
        """Reinitialize UI with updated report data (Screenshot 2 design)"""
        # Get central widget
        central = self.centralWidget()
        if not central:
            return
        
        # Clear layout
        layout = central.layout()
        if layout:
            while layout.count():
                item = layout.takeAt(0)
                if item.widget():
                    item.widget().deleteLater()
        
        # Recreate UI components
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(16)
        
        # Header with inline status (Screenshot 2 design - NO separate status banner)
        header = self._create_header()
        layout.addWidget(header)
        
        # Tabs (no status banner between header and tabs)
        self.tabs = self._create_tabs()
        layout.addWidget(self.tabs, 1)
        
        # Footer
        footer = self._create_footer()
        layout.addWidget(footer)
        
        # Sync Undo button state with current undo history
        self._refresh_undo_button()
    
    # =========================================================================
    # AUTO-FIX DATA EXTRACTION - INSTITUTIONAL GRADE (Direct Access)
    # =========================================================================
    
    def _extract_location_components(self, location: str) -> dict:
        """
        Extract block and signal names from location string
        
        Location format: "Block::block_name::Signal::signal_name"
        
        Returns dict with 'block_name' and 'signal_name' keys
        """
        components = {'block_name': None, 'signal_name': None}
        
        if not location or '::' not in location:
            return components
        
        parts = location.split('::')
        for i in range(len(parts)):
            if parts[i] == "Block" and i+1 < len(parts):
                components['block_name'] = parts[i+1]
            if parts[i] == "Signal" and i+1 < len(parts):
                components['signal_name'] = parts[i+1]
        
        return components
    
    # =========================================================================
    # AUTO-FIX APPLICATION METHODS
    # =========================================================================
    
    def _apply_recheck_timing_fix(self, signal_name: str, timing_window: int) -> bool:
        """
        Apply RECHECK timing fix - INSTITUTIONAL GRADE APPROACH
        
        PRESERVES user's strategic RECHECK delays (core strategy)
        ADJUSTS timing window constraint to accommodate delays
        
        This is the correct approach because:
        - RECHECK delays are strategic choices (when to validate)
        - Timing windows are constraints (ordering/synchronization)
        - Should adjust constraint, NOT strategy
        """
        try:
            logger.info(f"\n{'='*80}")
            logger.debug("RECHECK TIMING FIX - INSTITUTIONAL APPROACH")
            logger.info(f"{'='*80}")
            logger.info(f"Signal name: {signal_name}")
            logger.info(f"Current timing window: {timing_window} bars")
            
            # Find signal in config
            for block in self.config.blocks:
                for signal in block.signals:
                    if signal.name == signal_name:
                        logger.debug(f"  ✓ FOUND target signal '{signal_name}'")
                        
                        # Calculate CUMULATIVE delay (same as validator)
                        cumulative_delay = 0
                        if hasattr(signal, 'recheck_config') and signal.recheck_config:
                            cumulative_delay = signal.recheck_config.bar_delay
                            logger.debug(f"  Main recheck_config.bar_delay = {signal.recheck_config.bar_delay} bars")
                        
                        if hasattr(signal, 'recheck_chain') and signal.recheck_chain:
                            chain_delays = [rc.bar_delay for rc in signal.recheck_chain]
                            cumulative_delay += sum(chain_delays)
                            logger.debug(f"  RECHECK CHAIN: {len(signal.recheck_chain)} items")
                            logger.debug(f"  Chain delays: {chain_delays}")
                        
                        logger.debug(f"  CUMULATIVE RECHECK DELAY = {cumulative_delay} bars (PRESERVED)")
                        
                        # INSTITUTIONAL FIX: Increase timing window to fit delays + buffer
                        # Add 20% buffer for safety
                        buffer = int(cumulative_delay * 0.2)
                        new_timing_window = cumulative_delay + buffer
                        
                        logger.debug(f"  Required window = {cumulative_delay} + {buffer} buffer = {new_timing_window} bars")
                        
                        # Update timing constraint
                        if hasattr(signal, 'timing_constraint') and signal.timing_constraint:
                            old_window = signal.timing_constraint.max_candles
                            signal.timing_constraint.max_candles = new_timing_window
                            
                            logger.debug(f"  TIMING WINDOW BEFORE = {old_window} bars")
                            logger.debug(f"  TIMING WINDOW AFTER = {new_timing_window} bars")
                            logger.debug("  ✅ RECHECK delays PRESERVED (strategic choice)")
                            logger.debug("  ✅ Timing window ADJUSTED (constraint)")
                        else:
                            logger.error(f"  ❌ No timing_constraint found for signal '{signal_name}'")
                            logger.info(f"{'='*80}\n")
                            return False
                        
                        logger.debug(f"  ✅ Fix successful! Window {old_window} → {new_timing_window} bars")
                        logger.info(f"{'='*80}\n")
                        
                        return True
            
            logger.error(f"❌ Signal '{signal_name}' not found in config")
            logger.info(f"{'='*80}\n")
            return False
            
        except Exception as e:
            logger.exception(f"❌ Unexpected error in _apply_recheck_timing_fix for signal '{signal_name}': {e}")
            logger.info(f"{'='*80}\n")
            return False
    
    def _apply_exit_consolidation_fix(self, signal_name: str, level: str) -> bool:
        """Apply exit consolidation fix across ALL levels for a given signal_name.

        EXIT_009 fires when the same signal_name has conflicting exit modes
        (ABSOLUTE vs FLEXIBLE) across any binding level (strategy, block, or signal).
        The previous per-level approach failed for cross-level conflicts because
        auto_fix_duplicate_exits only saw one entry per level and returned unchanged.

        This implementation collects ALL exit conditions for signal_name from every
        level, determines the canonical mode (ABSOLUTE beats FLEXIBLE), and updates
        every matching condition in-place so re-validation no longer sees a conflict.

        The ``level`` parameter is retained in the signature for backward compatibility
        but is intentionally unused — the cross-level scan supersedes it.
        """
        try:
            # Collect all exit condition objects for this signal across every level.
            # We mutate them in-place rather than rebuilding lists so references held
            # elsewhere in the config remain valid.
            all_matching = []

            # Strategy level
            if hasattr(self.config, 'exit_conditions'):
                for ec in self.config.exit_conditions:
                    if ec.signal_name == signal_name:
                        all_matching.append(ec)

            # Block level and signal level
            if hasattr(self.config, 'blocks'):
                for block in self.config.blocks:
                    if hasattr(block, 'exit_conditions'):
                        for ec in block.exit_conditions:
                            if ec.signal_name == signal_name:
                                all_matching.append(ec)
                    if hasattr(block, 'signals'):
                        for signal in block.signals:
                            if hasattr(signal, 'exit_conditions'):
                                for ec in signal.exit_conditions:
                                    if ec.signal_name == signal_name:
                                        all_matching.append(ec)

            if not all_matching:
                return False

            # Determine canonical mode: ABSOLUTE takes priority over FLEXIBLE,
            # matching the merge rule used by auto_fix_duplicate_exits.
            canonical_mode = (
                "ABSOLUTE"
                if any(ec.exit_mode == "ABSOLUTE" for ec in all_matching)
                else "FLEXIBLE"
            )

            # Apply the canonical mode to every exit condition for this signal
            # at every level so re-validation sees a consistent single mode.
            for ec in all_matching:
                ec.exit_mode = canonical_mode

            return True

        except Exception as e:
            logger.error(f"Exit consolidation fix failed: {e}")
            return False
    
    def _apply_dead_code_fix(self, signal_name: str, block_name: str, preserve_history: bool = True) -> bool:
        """Apply dead code fix to disable (or remove) unreachable signal.

        Args:
            signal_name: Name of the unreachable signal.
            block_name: Name of the block containing the signal.
            preserve_history: If True, disable the signal (keep for audit);
                              if False, permanently remove it.
        """
        try:
            # Find block
            for block in self.config.blocks:
                if block.name.lower() == block_name.lower():
                    # Apply fix using auto_fix module
                    success = auto_fix_dead_code(
                        block,
                        [signal_name],
                        preserve_history=preserve_history
                    )
                    return success
            
            return False
            
        except Exception as e:
            logger.error(f"Dead code fix failed: {e}")
            return False
