"""
AI Request Preview Window
=========================

INSTITUTIONAL-GRADE AI REQUEST PREVIEW SYSTEM

Displays the complete structured request that will be sent to AI, including:
1. Full strategy configuration (blocks, signals, parameters)
2. Complete backtest configuration (timeframe, SL/TP, position sizing)
3. All trade results with details
4. All metrics with ratings
5. Available building blocks catalog (all 83+ blocks)
6. Signal catalog with occurrence rates

KEY FEATURES:
- Preview request BEFORE sending (saves money on bad requests)
- Verify data completeness
- Validate JSON structure
- Test response parsing
- No actual API calls until approved

Author: Optimizer v3 Team
Date: 2026-01-23
Sprint: 1.6 (AI Request System Rebuild)
"""

import json
from typing import Dict, List, Optional, Any
from datetime import datetime
from pathlib import Path
import sys
from PyQt5.QtWidgets import (
    QMainWindow, QDialog, QVBoxLayout, QHBoxLayout, QPushButton, QTextEdit,
    QLabel, QTabWidget, QWidget, QSplitter, QCheckBox, QGroupBox, QSizePolicy, QFrame, QFileDialog, QMessageBox
)
from PyQt5.QtCore import Qt, pyqtSignal
from PyQt5.QtGui import QTextOption

import logging
logger = logging.getLogger(__name__)


# Import centralized styles
project_root = Path(__file__).parent.parent.parent.parent
sys.path.insert(0, str(project_root))
from src.strategy_builder.ui.styles import (
    get_main_stylesheet,
    get_tab_widget_stylesheet,
    get_primary_button_stylesheet,
    get_success_button_stylesheet,
    get_secondary_button_stylesheet,
    get_text_edit_stylesheet,
    get_checkbox_style,
    get_groupbox_header_stylesheet,
    create_font,
    create_monospace_font,
    COLORS
)


class AIRecommendationsPanel(QWidget):
    """
    AI Recommendations Panel

    Displays the full AI analysis results including:
    - Strategy Diagnosis: assessment, root cause analysis, implementation order
    - Recommendations: actionable recommendations from AI/data-driven engine
    - Request Preview: collapsible sections showing the full request sent to AI

    Uses QWidget as the embedded tab panel in BacktestConfigPanel.
    """
    
    # Signal emitted when user approves sending request
    send_approved = pyqtSignal(dict)  # Emits the complete request data
    
    def __init__(self, parent=None):
        super().__init__(parent)

        # Data storage
        self.request_data = {}
        self.response_data = {}
        self._ai_recommendations: List = []
        self._ai_analysis: Dict = {}
        
        # Setup UI first
        self._setup_ui()
        
    
    def _setup_ui(self):
        """Setup UI with tabs for request/response preview"""
        # Apply main application stylesheet
        self.setStyleSheet(get_main_stylesheet())
        
        # Create central widget and layout
        layout = QVBoxLayout(self)
        layout.setContentsMargins(8, 8, 8, 8)
        layout.setSpacing(8)
        
        # ── Header with Reset button ──────────────────────────────────────
        header_layout = QHBoxLayout()
        
        header = QLabel("AI Recommendations")
        header.setFont(create_font(11, bold=True))
        header.setStyleSheet(f"color: {COLORS['text_primary']}; padding: 4px;")
        header_layout.addWidget(header)
        
        header_layout.addStretch()
        
        # Reset View button
        self.reset_view_btn = QPushButton("Reset View")
        self.reset_view_btn.setStyleSheet(get_secondary_button_stylesheet())
        self.reset_view_btn.clicked.connect(self._reset_view)
        header_layout.addWidget(self.reset_view_btn)
        
        layout.addLayout(header_layout)
        
        # ── Strategy Diagnosis section (P3: assessment + root_cause + order) ─
        self.diagnosis_frame = QFrame()
        self.diagnosis_frame.setStyleSheet(
            f"QFrame {{ background-color: {COLORS['bg_medium']}; "
            f"border: 1px solid {COLORS['border']}; border-radius: 4px; }}"
        )
        diagnosis_layout = QVBoxLayout(self.diagnosis_frame)
        diagnosis_layout.setContentsMargins(8, 8, 8, 8)
        diagnosis_layout.setSpacing(4)
        
        diagnosis_header = QLabel("Strategy Diagnosis")
        diagnosis_header.setFont(create_font(11, bold=True))
        diagnosis_header.setStyleSheet(
            f"color: {COLORS['text_primary']}; border: none; background: transparent;"
        )
        diagnosis_layout.addWidget(diagnosis_header)
        
        self.diagnosis_text = QTextEdit()
        self.diagnosis_text.setReadOnly(True)
        self.diagnosis_text.setFont(create_font(9))
        self.diagnosis_text.setWordWrapMode(QTextOption.WrapMode.WordWrap)
        self.diagnosis_text.setStyleSheet(
            f"QTextEdit {{ background-color: {COLORS['bg_dark']}; "
            f"color: {COLORS['text_secondary']}; "
            f"border: 1px solid {COLORS['border']}; }}"
        )
        self.diagnosis_text.setMinimumHeight(120)
        self.diagnosis_text.setMaximumHeight(200)
        self.diagnosis_text.setPlainText(
            "Awaiting AI analysis...\n\n"
            "Run a backtest and click 'Approve & Send to AI' in the Request Preview section below."
        )
        diagnosis_layout.addWidget(self.diagnosis_text)
        
        layout.addWidget(self.diagnosis_frame)
        
        # ── AI Recommendations section (P4) ──────────────────────────────
        self.recs_frame = QFrame()
        self.recs_frame.setStyleSheet(
            f"QFrame {{ background-color: {COLORS['bg_medium']}; "
            f"border: 1px solid {COLORS['border']}; border-radius: 4px; }}"
        )
        recs_layout = QVBoxLayout(self.recs_frame)
        recs_layout.setContentsMargins(8, 8, 8, 8)
        recs_layout.setSpacing(4)
        
        recs_header = QLabel("Recommendations")
        recs_header.setFont(create_font(11, bold=True))
        recs_header.setStyleSheet(
            f"color: {COLORS['text_primary']}; border: none; background: transparent;"
        )
        recs_layout.addWidget(recs_header)
        
        self.recs_text = QTextEdit()
        self.recs_text.setReadOnly(True)
        self.recs_text.setFont(create_font(9))
        self.recs_text.setWordWrapMode(QTextOption.WrapMode.WordWrap)
        self.recs_text.setStyleSheet(
            f"QTextEdit {{ background-color: {COLORS['bg_dark']}; "
            f"color: {COLORS['text_secondary']}; "
            f"border: 1px solid {COLORS['border']}; }}"
        )
        self.recs_text.setMinimumHeight(120)
        self.recs_text.setMaximumHeight(250)
        self.recs_text.setPlainText(
            "No recommendations yet.\n\n"
            "Recommendations will appear here after AI analysis completes."
        )
        recs_layout.addWidget(self.recs_text)
        
        layout.addWidget(self.recs_frame)
        
        # ── Request Preview (collapsible, visible by default) ───────────────
        preview_toggle_layout = QHBoxLayout()
        self.preview_toggle_btn = QPushButton("Hide Request Preview")
        self.preview_toggle_btn.setStyleSheet(get_secondary_button_stylesheet())
        self.preview_toggle_btn.clicked.connect(self._toggle_request_preview)
        preview_toggle_layout.addWidget(self.preview_toggle_btn)
        preview_toggle_layout.addStretch()
        layout.addLayout(preview_toggle_layout)
        
        # Container for request preview sections (visible by default)
        self.preview_container = QWidget()
        preview_container_layout = QVBoxLayout(self.preview_container)
        preview_container_layout.setContentsMargins(0, 0, 0, 0)
        preview_container_layout.setSpacing(4)
        
        # Request content (5 sections)
        request_content = self._create_request_tab()
        preview_container_layout.addWidget(request_content)
        
        # Statistics summary - use dark theme
        self.stats_label = QLabel("Status: Backtest not executed or completed")
        self.stats_label.setStyleSheet(
            f"background-color: {COLORS['bg_medium']}; "
            f"color: {COLORS['text_secondary']}; "
            f"padding: 8px; font-family: 'Courier New';"
        )
        preview_container_layout.addWidget(self.stats_label)
        
        # Action buttons
        button_layout = QHBoxLayout()
        button_layout.addStretch()
        
        # Export button
        self.export_btn = QPushButton("Export to JSON")
        self.export_btn.clicked.connect(self._export_to_json)
        self.export_btn.setStyleSheet(get_secondary_button_stylesheet())
        self.export_btn.setFixedHeight(40)
        self.export_btn.setEnabled(False)
        button_layout.addWidget(self.export_btn)
        
        # Preview AI Request button
        self.preview_request_btn = QPushButton("Preview AI Request")
        self.preview_request_btn.clicked.connect(self._preview_ai_request)
        self.preview_request_btn.setStyleSheet(get_primary_button_stylesheet())
        self.preview_request_btn.setFixedHeight(40)
        self.preview_request_btn.setEnabled(False)
        button_layout.addWidget(self.preview_request_btn)
        
        # Approve button
        self.approve_btn = QPushButton("Approve & Send to AI")
        self.approve_btn.clicked.connect(self._approve_and_send)
        self.approve_btn.setStyleSheet(get_success_button_stylesheet())
        self.approve_btn.setFixedHeight(40)
        self.approve_btn.setEnabled(False)
        button_layout.addWidget(self.approve_btn)
        
        preview_container_layout.addLayout(button_layout)
        
        self.preview_container.setVisible(True)   # Visible by default
        layout.addWidget(self.preview_container)
        
        layout.addStretch()
    
    def _create_request_tab(self) -> QWidget:
        """Create tab showing complete request structure with collapsible sections"""
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setSpacing(4)
        layout.setContentsMargins(4, 4, 4, 4)
        
        # Track all sections for maximize functionality
        self.all_sections = []
        
        # Section 1: Strategy Configuration
        strategy_section = self._create_collapsible_section(
            "1. STRATEGY CONFIGURATION",
            "Complete strategy setup including blocks, signals, and parameters"
        )
        self.strategy_text = strategy_section['text_edit']
        layout.addWidget(strategy_section['widget'], stretch=1)
        self.all_sections.append(strategy_section)
        
        # Section 2: Backtest Configuration
        backtest_section = self._create_collapsible_section(
            "2. BACKTEST CONFIGURATION",
            "How the backtest was configured (timeframe, SL/TP, position sizing)"
        )
        self.backtest_text = backtest_section['text_edit']
        layout.addWidget(backtest_section['widget'], stretch=1)
        self.all_sections.append(backtest_section)
        
        # Section 3: Trade Results
        trades_section = self._create_collapsible_section(
            "3. TRADE RESULTS",
            "All trades executed with entry/exit details"
        )
        self.trades_text = trades_section['text_edit']
        layout.addWidget(trades_section['widget'], stretch=1)
        self.all_sections.append(trades_section)
        
        # Section 4: Metrics & Ratings
        metrics_section = self._create_collapsible_section(
            "4. METRICS & RATINGS",
            "Performance metrics with institutional ratings"
        )
        self.metrics_text = metrics_section['text_edit']
        layout.addWidget(metrics_section['widget'], stretch=1)
        self.all_sections.append(metrics_section)
        
        # Section 5: Available Building Blocks
        blocks_section = self._create_collapsible_section(
            "5. AVAILABLE BUILDING BLOCKS",
            "All 83+ building blocks available for recommendations"
        )
        self.blocks_text = blocks_section['text_edit']
        layout.addWidget(blocks_section['widget'], stretch=1)
        self.all_sections.append(blocks_section)
        
        # No addStretch() - let sections fill all space
        return widget
    
    def _create_response_tab(self) -> QWidget:
        """Create tab showing expected response structure"""
        widget = QWidget()
        layout = QVBoxLayout(widget)
        
        label = QLabel("Expected Response Structure from AI:")
        label.setFont(create_font(11, bold=True))
        layout.addWidget(label)
        
        self.response_text = QTextEdit()
        self.response_text.setReadOnly(True)
        self.response_text.setFont(create_font(9))
        self.response_text.setWordWrapMode(QTextOption.WrapMode.NoWrap)
        layout.addWidget(self.response_text)
        
        # Show expected response format
        expected_response = self._get_expected_response_format()
        self.response_text.setPlainText(expected_response)
        
        return widget
    
    def _create_validation_tab(self) -> QWidget:
        """Create tab showing validation checklist"""
        widget = QWidget()
        layout = QVBoxLayout(widget)
        
        label = QLabel("Request Validation Checklist:")
        label.setFont(create_font(11, bold=True))
        layout.addWidget(label)
        
        self.validation_text = QTextEdit()
        self.validation_text.setReadOnly(True)
        self.validation_text.setFont(create_font(9))
        layout.addWidget(self.validation_text)
        
        return widget
    
    def _create_collapsible_section(self, title: str, description: str) -> Dict:
        """Create a collapsible section with maximize/collapse buttons"""
        container = QFrame()
        container.setStyleSheet(f"QFrame {{ background-color: {COLORS['bg_medium']}; border: 1px solid {COLORS['border']}; border-radius: 4px; }}")
        main_layout = QVBoxLayout(container)
        main_layout.setContentsMargins(4, 4, 4, 4)
        main_layout.setSpacing(4)
        
        # Header with title and buttons
        header_layout = QHBoxLayout()
        
        # Title - use COLORS constant for section title color
        title_label = QLabel(title)
        title_label.setStyleSheet(
            f"color: {COLORS['text_primary']}; font-weight: bold; font-size: 12pt; "
            f"border: none; background: transparent;"
        )
        header_layout.addWidget(title_label)
        
        header_layout.addStretch()
        
        # Maximize button - FIXED SIZE (width AND height)
        maximize_btn = QPushButton("Maximize")
        maximize_btn.setFixedSize(180, 38)
        maximize_btn.setStyleSheet(get_primary_button_stylesheet())
        header_layout.addWidget(maximize_btn)
        
        # Collapse/Expand button - EXACT SAME SIZE
        toggle_btn = QPushButton("Collapse")
        toggle_btn.setFixedSize(180, 38)
        toggle_btn.setStyleSheet(get_secondary_button_stylesheet())
        header_layout.addWidget(toggle_btn)
        
        main_layout.addLayout(header_layout)
        
        # Description
        desc_label = QLabel(description)
        desc_label.setStyleSheet(
            f"color: {COLORS['text_label']}; font-weight: normal; "
            f"padding-left: 4px; border: none; background: transparent;"
        )
        desc_label.setFont(create_font(8))
        desc_label.setWordWrap(True)
        main_layout.addWidget(desc_label)
        
        # Text editor - use DARKER background like Strategy Builder inner panels
        text_edit = QTextEdit()
        text_edit.setReadOnly(True)
        text_edit.setFont(create_monospace_font(9))
        text_edit.setWordWrapMode(QTextOption.WrapMode.WordWrap)
        # Set darker background AND MUTED text (dimmer) to match Strategy Builder "Signals:" panels
        text_edit.setStyleSheet(f"QTextEdit {{ background-color: {COLORS['bg_dark']}; color: {COLORS['text_muted']}; border: 1px solid {COLORS['border']}; }}")
        # Allow widget to expand freely (QSizePolicy already imported from PyQt5)
        text_edit.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        main_layout.addWidget(text_edit)
        
        # Toggle collapse/expand with proper space management
        def toggle_section():
            is_visible = text_edit.isVisible()
            if is_visible:
                # CRITICAL FIX: If this section is maximized, un-maximize first!
                if is_maximized[0]:
                    # Restore all other sections first
                    for section in self.all_sections:
                        if section['widget'] != container:
                            section['widget'].setVisible(True)
                            section['widget'].show()
                        section['maximize_btn'].setText("🗖 Maximize")
                    is_maximized[0] = False
                
                # Now collapse this section
                text_edit.setVisible(False)
                desc_label.setVisible(False)
                toggle_btn.setText("▶ Expand")
                # Set small fixed height when collapsed (just enough for header)
                container.setMaximumHeight(50)
            else:
                # Expanding - show content and allow container to grow
                text_edit.setVisible(True)
                desc_label.setVisible(True)
                toggle_btn.setText("▼ Collapse")
                # Remove height restriction when expanded
                container.setMaximumHeight(16777215)  # Qt's QWIDGETSIZE_MAX
        
        # Toggle between maximize and minimize
        is_maximized = [False]  # Use list to allow mutation in closure
        
        def toggle_maximize():
            if not is_maximized[0]:
                # Maximize this section - hide all others and expand this one
                for section in self.all_sections:
                    if section['widget'] != container:
                        # Hide entire other sections
                        section['widget'].setVisible(False)
                        section['widget'].hide()  # Explicit hide
                    else:
                        # CRITICAL: Expand this section first (if it was collapsed)
                        section['widget'].setVisible(True)
                        section['widget'].show()
                        section['text_edit'].setVisible(True)
                        section['desc_label'].setVisible(True)
                        section['toggle_btn'].setText("▼ Collapse")
                        # Remove ALL height constraints for maximum space
                        section['widget'].setMaximumHeight(16777215)
                        # Change button text
                        maximize_btn.setText("🗗 Minimize")
                
                # Force layout update
                self.layout().update()
                self.updateGeometry()
                is_maximized[0] = True
            else:
                # Minimize - restore all sections to expanded state
                for section in self.all_sections:
                    # Show all sections again
                    section['widget'].setVisible(True)
                    section['widget'].show()  # Explicit show
                    section['text_edit'].setVisible(True)
                    section['desc_label'].setVisible(True)
                    section['toggle_btn'].setText("▼ Collapse")
                    # Remove height constraints
                    section['widget'].setMaximumHeight(16777215)
                    section['maximize_btn'].setText("🗖 Maximize")
                
                # Force layout update
                self.layout().update()
                self.updateGeometry()
                is_maximized[0] = False
        
        toggle_btn.clicked.connect(toggle_section)
        maximize_btn.clicked.connect(toggle_maximize)
        
        return {
            'widget': container,
            'text_edit': text_edit,
            'desc_label': desc_label,
            'toggle_btn': toggle_btn,
            'maximize_btn': maximize_btn
        }
    
    def populate_preview(
        self,
        strategy_config: Dict,
        backtest_config: Dict,
        trades: List[Dict],
        metrics: Dict,
        available_blocks: List[Dict],
        analysis_report: Any = None
    ):
        """
        Populate preview with complete request data
        
        Args:
            strategy_config: Full strategy configuration
            backtest_config: Complete backtest settings
            trades: All trade results
            metrics: All metrics with ratings
            available_blocks: Complete building blocks catalog
            analysis_report: Analysis report from engine
        """
        self.request_data = {
            'strategy_config': strategy_config,
            'backtest_config': backtest_config,
            'trades': trades,
            'metrics': metrics,
            'available_blocks': available_blocks,
            'analysis_report': analysis_report
        }
        
        # Populate each section
        self._populate_strategy_section(strategy_config)
        self._populate_backtest_section(backtest_config)
        self._populate_trades_section(trades)
        self._populate_metrics_section(metrics)
        self._populate_blocks_section(available_blocks)
        # Note: _populate_validation_section() removed with tabs
        self._update_statistics()
    
    def _populate_strategy_section(self, config: Dict):
        """Populate strategy configuration section"""
        formatted = json.dumps(config, indent=2, default=str, ensure_ascii=False)
        self.strategy_text.setPlainText(formatted)
    
    def _populate_backtest_section(self, config: Dict):
        """Populate backtest configuration section"""
        formatted = json.dumps(config, indent=2, default=str, ensure_ascii=False)
        # CRITICAL: Replace JSON escape sequences with actual characters for readability
        # This is ONLY for preview - the actual JSON sent to AI will have proper escapes
        formatted = formatted.replace('\\n', '\n')  # JSON newlines → actual newlines
        formatted = formatted.replace('\\t', '\t')  # JSON tabs → actual tabs
        self.backtest_text.setPlainText(formatted)
    
    def _populate_trades_section(self, trades: List[Dict]):
        """Populate trades section"""
        if not trades:
            self.trades_text.setPlainText("⚠️ NO TRADES - This is the problem!\n\nAI cannot analyze 0 trades.")
            return
        
        # Format trades nicely
        output = f"Total Trades: {len(trades)}\n\n"
        for i, trade in enumerate(trades[:10], 1):  # Show first 10
            output += f"Trade #{i}:\n"
            output += json.dumps(trade, indent=2, default=str)
            output += "\n\n"
        
        if len(trades) > 10:
            output += f"... and {len(trades) - 10} more trades\n"
        
        self.trades_text.setPlainText(output)
    
    def _populate_metrics_section(self, metrics: Dict):
        """Populate metrics section"""
        formatted = json.dumps(metrics, indent=2, default=str)
        self.metrics_text.setPlainText(formatted)
    
    def _populate_blocks_section(self, blocks: List[Dict]):
        """Populate available blocks section"""
        logger.debug(f"\n🔍 DEBUG: _populate_blocks_section called with {len(blocks)} blocks")
        
        # DEBUG: Check first block structure
        if blocks:
            first_block = blocks[0]
            logger.info(f"   First block: {first_block.get('name')}")
            logger.info(f"   Has signals key: {'signals' in first_block}")
            if 'signals' in first_block:
                logger.info(f"   Signals count: {len(first_block.get('signals', []))}")
                if first_block.get('signals'):
                    logger.info(f"   First signal: {first_block['signals'][0]}")
        
        output = f"Total Available Blocks: {len(blocks)}\n\n"
        
        # Group by category
        by_category = {}
        for block in blocks:
            category = block.get('category', 'Unknown')
            if category not in by_category:
                by_category[category] = []
            by_category[category].append(block)
        
        for category, category_blocks in sorted(by_category.items()):
            output += f"\n{'='*60}\n"
            output += f"CATEGORY: {category} ({len(category_blocks)} blocks)\n"
            output += f"{'='*60}\n\n"
            
            for block in category_blocks:  # Show ALL blocks - user wants to see everything
                output += f"  • {block.get('name', 'Unknown')}\n"
                output += f"    Description: {block.get('description', 'N/A')}\n"
                signals = block.get('signals', [])
                if signals:
                    output += f"    Signals ({len(signals)}):\n"
                    for signal in signals:  # Show ALL signals - no truncation
                        signal_name = signal.get('name', 'Unknown')
                        signal_desc = signal.get('description', 'No description')
                        output += f"      - {signal_name}: {signal_desc}\n"
                else:
                    if block.get('in_strategy'):
                        # Full (in-strategy) blocks should always have signals from registry
                        logger.warning(
                            "   ⚠️ Strategy block %s has NO signals! "
                            "Check signal_tiers in BlockRegistry for this block.",
                            block.get('name'),
                        )
                    # Compact (non-strategy) blocks have empty signals by design — no warning
                output += "\n"
        
        self.blocks_text.setPlainText(output)
        logger.info(f"✓ Blocks section populated with {len(output)} characters")
    
    def _populate_validation_section(self):
        """Populate validation checklist"""
        data = self.request_data
        
        validation = "REQUEST VALIDATION CHECKLIST\n"
        validation += "="*60 + "\n\n"
        
        # Check 1: Strategy Config
        has_strategy = bool(data.get('strategy_config'))
        validation += f"{'✅' if has_strategy else '❌'} Strategy Configuration Present\n"
        if has_strategy:
            blocks = data['strategy_config'].get('blocks', [])
            validation += f"   - Blocks: {len(blocks)}\n"
            total_signals = sum(len(b.get('signals', [])) for b in blocks)
            validation += f"   - Total Signals: {total_signals}\n"
        validation += "\n"
        
        # Check 2: Backtest Config
        has_backtest = bool(data.get('backtest_config'))
        validation += f"{'✅' if has_backtest else '❌'} Backtest Configuration Present\n"
        if has_backtest:
            config = data['backtest_config']
            validation += f"   - Timeframe: {config.get('timeframe', 'N/A')}\n"
            validation += f"   - Lookback Days: {config.get('lookback_days', 'N/A')}\n"
            validation += f"   - Stop Loss: {config.get('stop_loss', 'N/A')}\n"
            validation += f"   - Take Profit: {config.get('take_profit', 'N/A')}\n"
        validation += "\n"
        
        # Check 3: Trades
        trades = data.get('trades', [])
        has_trades = len(trades) > 0
        validation += f"{'✅' if has_trades else '⚠️'} Trade Results Present\n"
        validation += f"   - Total Trades: {len(trades)}\n"
        if has_trades:
            total_pnl = sum(t.get('pnl', 0) for t in trades)
            validation += f"   - Total PnL: ${total_pnl:.2f}\n"
            wins = sum(1 for t in trades if t.get('pnl', 0) > 0)
            validation += f"   - Win Rate: {wins/len(trades)*100:.1f}%\n"
        else:
            validation += "   ⚠️ WARNING: 0 trades means AI cannot analyze strategy!\n"
        validation += "\n"
        
        # Check 4: Metrics
        metrics = data.get('metrics', {})
        has_metrics = bool(metrics)
        validation += f"{'✅' if has_metrics else '❌'} Metrics & Ratings Present\n"
        validation += f"   - Total Metrics: {len(metrics)}\n"
        validation += "\n"
        
        # Check 5: Available Blocks
        blocks = data.get('available_blocks', [])
        has_blocks = len(blocks) > 0
        validation += f"{'✅' if has_blocks else '❌'} Available Building Blocks Catalog\n"
        validation += f"   - Total Blocks: {len(blocks)}\n"
        if has_blocks:
            categories = set(b.get('category', 'Unknown') for b in blocks)
            validation += f"   - Categories: {len(categories)}\n"
            total_signals = sum(len(b.get('signals', [])) for b in blocks)
            validation += f"   - Total Available Signals: {total_signals}\n"
        validation += "\n"
        
        # Overall assessment
        validation += "\n" + "="*60 + "\n"
        validation += "OVERALL ASSESSMENT\n"
        validation += "="*60 + "\n\n"
        
        checks_passed = sum([has_strategy, has_backtest, has_trades, has_metrics, has_blocks])
        total_checks = 5
        
        if checks_passed == total_checks:
            validation += "✅ ALL CHECKS PASSED - Request ready to send\n"
            self.approve_btn.setEnabled(True)
        elif checks_passed >= 3:
            validation += "⚠️ PARTIAL - Some data missing but can proceed\n"
            self.approve_btn.setEnabled(True)
        else:
            validation += "❌ CRITICAL - Too much data missing, do not send\n"
            self.approve_btn.setEnabled(False)
        
        validation += f"\nChecks Passed: {checks_passed}/{total_checks}\n"
        
        self.validation_text.setPlainText(validation)
    
    def _update_statistics(self):
        """Update statistics label and enable/disable ALL buttons based on data availability"""
        data = self.request_data
        
        strategy_blocks = len(data.get('strategy_config', {}).get('blocks', []))
        backtest_days = data.get('backtest_config', {}).get('lookback_days', 0)
        total_trades = len(data.get('trades', []))
        total_metrics = len(data.get('metrics', {}))
        available_blocks = len(data.get('available_blocks', []))
        
        # CRITICAL: Enable buttons only if backtest has been run (trades > 0)
        has_backtest_data = total_trades > 0 and backtest_days > 0
        
        if has_backtest_data:
            # Calculate estimated request size
            request_json = json.dumps(data, default=str)
            request_size_kb = len(request_json) / 1024
            estimated_tokens = len(request_json) / 4  # Rough estimate: 4 chars = 1 token
            
            stats_text = (
                f"📊 Request Statistics: "
                f"Strategy Blocks: {strategy_blocks} | "
                f"Backtest: {backtest_days} days | "
                f"Trades: {total_trades} | "
                f"Metrics: {total_metrics} | "
                f"Available Blocks: {available_blocks} | "
                f"Request Size: {request_size_kb:.1f} KB (~{estimated_tokens:.0f} tokens)"
            )
            
            # Enable ALL buttons when backtest data is available
            self.export_btn.setEnabled(True)
            self.preview_request_btn.setEnabled(True)
            self.approve_btn.setEnabled(True)
        else:
            # No backtest data - keep default message and disabled ALL buttons
            stats_text = "Status: Backtest not executed or completed"
            
            # Disable ALL buttons - show grey
            self.export_btn.setEnabled(False)
            self.preview_request_btn.setEnabled(False)
            self.approve_btn.setEnabled(False)
        
        self.stats_label.setText(stats_text)
    
    def _get_expected_response_format(self) -> str:
        """Get expected response format from AI"""
        return '''{
    "assessment": "Professional analysis of the strategy and situation",
    "understanding": {
        "strategy_type": "Bearish/Bullish",
        "current_blocks": ["block1", "block2"],
        "current_signals": ["signal1", "signal2"],
        "trade_count": 24,
        "key_metrics": {
            "win_rate": "58.3%",
            "profit_factor": "1.97",
            "sharpe_ratio": "0.75"
        }
    },
    "root_cause_analysis": {
        "primary_issue": "Low trade frequency / Poor win rate / etc.",
        "contributing_factors": [
            "Over-constraint from AND logic",
            "Missing validation timing",
            "Restrictive parameters"
        ],
        "confidence": 0.92
    },
    "recommendations": [
        {
            "type": "ADD_RECHECK | ADD_TIMING | ADD_BLOCK | ADJUST_PARAM",
            "priority": 1,
            "block_name": "hod",
            "signal_name": "HOD_REJECTION_RECHECK",
            "configuration": {
                "bar_delay": 25,
                "validation_mode": "SIGNAL",
                "max_candles": 20,
                "parameter_name": "stop_loss",
                "current_value": 0.02,
                "new_value": 0.025
            },
            "reasoning": "Detailed professional reasoning why this change is optimal",
            "expected_impact": {
                "win_rate": "+12% (from 58% to 70%)",
                "trade_frequency": "Maintained (24 trades/180 days)",
                "profit_factor": "+0.5 (from 1.97 to 2.47)",
                "sharpe_ratio": "+0.3 (from 0.75 to 1.05)"
            },
            "confidence": 0.88,
            "implementation_steps": [
                "Step 1: Add recheck configuration to HOD block",
                "Step 2: Set bar_delay to 25 (optimal for 15m timeframe)",
                "Step 3: Run backtest to validate"
            ],
            "warnings": [
                "May create lag in entry timing",
                "Requires minimum 20 trades to validate impact"
            ],
            "alternatives": [
                {
                    "description": "Alternative approach if primary fails",
                    "configuration": {},
                    "confidence": 0.65
                }
            ]
        }
    ],
    "implementation_order": [
        "1. ADD_RECHECK on HOD (immediate - solves trade frequency)",
        "2. Collect 20-30 trades over 30-45 days",
        "3. Analyze results and adjust if needed",
        "4. IF trade_frequency still <6/month: Consider ADJUST_PARAM",
        "5. Re-evaluate after 60 trades minimum"
    ],
    "risk_assessment": {
        "overall_risk": "LOW | MEDIUM | HIGH",
        "specific_risks": [
            "Risk 1: May increase false signals",
            "Risk 2: Could reduce win rate initially"
        ],
        "mitigation_strategies": [
            "Start with paper trading",
            "Monitor first 10 trades closely",
            "Adjust bar_delay if needed"
        ]
    },
    "estimated_improvement_timeline": {
        "immediate": "Trade frequency improvement visible in first backtest",
        "30_days": "Collect 20-30 trades for validation",
        "60_days": "Full statistical validation possible",
        "90_days": "Optimal parameter refinement"
    },
    "overall_confidence": 0.87,
    "next_steps": [
        "Implement primary recommendation",
        "Run backtest with new configuration",
        "Validate results against expectations",
        "Iterate based on actual performance"
    ]
}'''
    
    def _export_to_json(self):
        """Export request data to JSON file"""
        # QFileDialog already imported from PyQt5 at top
        filename, _ = QFileDialog.getSaveFileName(
            self,
            "Export Request to JSON",
            f"ai_request_preview_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json",
            "JSON Files (*.json)"
        )
        
        if filename:
            try:
                with open(filename, 'w') as f:
                    json.dump(self.request_data, f, indent=2, default=str)
                
                # QMessageBox already imported from PyQt5 at top
                QMessageBox.information(
                    self,
                    "Export Successful",
                    f"Request data exported to:\n{filename}"
                )
            except Exception as e:
                # QMessageBox already imported from PyQt5 at top
                QMessageBox.critical(
                    self,
                    "Export Failed",
                    f"Failed to export:\n{str(e)}"
                )
    
    def _reset_view(self):
        """Reset view to initial state - all sections expanded"""
        logger.info("✓ Resetting view to initial state...")
        for section in self.all_sections:
            # Show all widgets
            section['widget'].setVisible(True)
            section['widget'].show()
            section['text_edit'].setVisible(True)
            section['desc_label'].setVisible(True)
            
            # Reset button text
            section['toggle_btn'].setText("▼ Collapse")
            section['maximize_btn'].setText("🗖 Maximize")
            
            # Remove all height constraints
            section['widget'].setMaximumHeight(16777215)
        
        # Force layout update
        self.layout().update()
        self.updateGeometry()
        logger.info("✓ View reset complete")
    
    def _preview_ai_request(self):
        """Build and show the actual formatted AI request that will be sent to the API"""
        try:
            logger.info("[Preview] Building formatted AI request...")
            
            # Import the request builder
            from src.optimizer_v3.core.comprehensive_ai_request_builder import ComprehensiveAIRequestBuilder
            
            # Create builder and format the complete request
            builder = ComprehensiveAIRequestBuilder()
            
            # CRITICAL: Build complete backtest_results dict with ACTUAL metrics values
            # The prompt expects metrics in raw format (not dict with 'value' key)
            from decimal import Decimal
            
            metrics_raw = {}
            for key, data in self.request_data.get('metrics', {}).items():
                if isinstance(data, dict) and 'value' in data:
                    value = data['value']
                    # Convert Decimal to float (JSON serializable)
                    if isinstance(value, Decimal):
                        metrics_raw[key] = float(value)
                    else:
                        metrics_raw[key] = value
                else:
                    # Convert Decimal to float
                    if isinstance(data, Decimal):
                        metrics_raw[key] = float(data)
                    else:
                        metrics_raw[key] = data
            
            # Build complete backtest_results with trades AND metrics
            backtest_results_complete = {
                'trades': self.request_data.get('trades', []),
                'total_trades': len(self.request_data.get('trades', [])),
                **metrics_raw  # Add all metrics at root level
            }
            
            formatted_request = builder.build_complete_request(
                strategy_config=self.request_data.get('strategy_config', {}),
                backtest_results=backtest_results_complete,  # Complete dict with metrics
                metrics_with_ratings=self.request_data.get('metrics', {}),  # Keep ratings format too
                backtest_config=self.request_data.get('backtest_config', {})
            )
            
            # CRITICAL: Also build the AI prompt (the actual instructions sent to AI)
            ai_prompt = builder.format_for_ai_prompt(formatted_request)
            
            # Create dialog to show formatted request - FULLSCREEN
            dialog = QDialog(self)
            dialog.setWindowTitle("🔍 Formatted AI Request - Exact Prompt That Will Be Sent")
            dialog.showMaximized()  # FULLSCREEN on launch
            
            # Apply stylesheet
            dialog.setStyleSheet(get_main_stylesheet())
            
            layout = QVBoxLayout()
            layout.setContentsMargins(10, 10, 10, 10)
            layout.setSpacing(10)
            
            # Header
            header_label = QLabel("EXACT AI REQUEST - Complete prompt sent to API (Instructions + Data)")
            header_label.setFont(create_font(12, bold=True))
            header_label.setStyleSheet(
                f"color: {COLORS['text_primary']}; padding: 5px;"
            )
            layout.addWidget(header_label)
            
            # Text display
            text_edit = QTextEdit()
            text_edit.setReadOnly(True)
            text_edit.setFont(create_monospace_font(9))
            text_edit.setWordWrapMode(QTextOption.WrapMode.WordWrap)
            text_edit.setStyleSheet(
                f"QTextEdit {{ background-color: {COLORS['bg_dark']}; "
                f"color: {COLORS['text_muted']}; "
                f"border: 1px solid {COLORS['border']}; }}"
            )
            
            # CRITICAL: Show the COMPLETE request (prompt + data)
            complete_request = f"""{'='*80}
PART 1: AI INSTRUCTIONS (What we're asking the AI to do)
{'='*80}

{ai_prompt}

{'='*80}
PART 2: STRUCTURED DATA (JSON format for parsing)
{'='*80}

{json.dumps(formatted_request, indent=2, default=str, ensure_ascii=False)}
"""
            text_edit.setPlainText(complete_request)
            layout.addWidget(text_edit)
            
            # Stats
            request_size = len(complete_request) / 1024
            estimated_tokens = len(complete_request) / 4
            stats_label = QLabel(f"Total Size: {request_size:.1f} KB | Estimated Tokens: {estimated_tokens:.0f} | Prompt: {len(ai_prompt)} chars | Data: {len(json.dumps(formatted_request, default=str))} chars")
            stats_label.setStyleSheet(
                f"color: {COLORS['text_secondary']}; padding: 5px;"
            )
            stats_label.setFont(create_monospace_font(9))
            layout.addWidget(stats_label)
            
            # Close button
            close_btn = QPushButton("Close")
            close_btn.clicked.connect(dialog.close)
            close_btn.setStyleSheet(get_primary_button_stylesheet())
            layout.addWidget(close_btn)
            
            dialog.setLayout(layout)
            dialog.exec()
            
        except Exception as e:
            logger.error(f"❌ Failed to build AI request preview: {str(e)}")
            import traceback
            traceback.print_exc()
            
            # Show error dialog
            QMessageBox.critical(
                self,
                "Error",
                f"Failed to build AI request preview:\n\n{str(e)}"
            )
    
    def _approve_and_send(self):
        """User approved - emit signal to send request"""
        # Emit signal with request data - actual API call happens in parent
        self.send_approved.emit(self.request_data)


    def _toggle_request_preview(self):
        """Toggle visibility of the AI Request Preview sections."""
        visible = self.preview_container.isVisible()
        self.preview_container.setVisible(not visible)
        if visible:
            self.preview_toggle_btn.setText("Show Request Preview")
        else:
            self.preview_toggle_btn.setText("Hide Request Preview")

    def display_ai_analysis(self, analysis: Dict) -> None:
        """
        Display the full AI strategy diagnosis in the Diagnosis section.

        Called after AI recommendations are generated. Surfaces assessment,
        root_cause_analysis, and implementation_order from the AI JSON response.

        Args:
            analysis: Dict with keys: assessment, root_cause_analysis, implementation_order
        """
        if not analysis:
            return

        self._ai_analysis = analysis

        assessment = analysis.get('assessment', '')
        root_cause = analysis.get('root_cause_analysis', {})
        impl_order = analysis.get('implementation_order', [])

        lines = []

        if assessment:
            lines.append("ASSESSMENT")
            lines.append("=" * 60)
            lines.append(assessment)
            lines.append("")

        if root_cause:
            lines.append("ROOT CAUSE ANALYSIS")
            lines.append("=" * 60)
            if isinstance(root_cause, dict):
                primary = root_cause.get('primary_issue', '')
                if primary:
                    lines.append(f"Primary Issue: {primary}")
                factors = root_cause.get('contributing_factors', [])
                if factors:
                    lines.append("Contributing Factors:")
                    for f in factors:
                        lines.append(f"  - {f}")
                confidence = root_cause.get('confidence')
                if confidence is not None:
                    lines.append(f"Confidence: {float(confidence):.0%}")
            else:
                lines.append(str(root_cause))
            lines.append("")

        if impl_order:
            lines.append("IMPLEMENTATION ORDER")
            lines.append("=" * 60)
            for step in impl_order:
                lines.append(str(step))
            lines.append("")

        if lines:
            self.diagnosis_text.setPlainText("\n".join(lines))
        else:
            self.diagnosis_text.setPlainText(
                "AI analysis returned no diagnosis data.\n"
                "Check that the AI response includes 'assessment' and 'root_cause_analysis' fields."
            )

        logger.info("[AI Panel] Strategy diagnosis displayed")

    def display_recommendations(self, recommendations: List = None) -> None:
        """
        Display AI recommendations in the Recommendations section.

        Args:
            recommendations: List of IntegratedRecommendation objects (or dicts)
        """
        if recommendations is None:
            recommendations = []

        self._ai_recommendations = recommendations
        logger.info(f"[AI Panel] Displaying {len(recommendations)} recommendations")

        if not recommendations:
            self.recs_text.setPlainText(
                "No recommendations generated.\n\n"
                "Possible reasons:\n"
                "- No strategy config available\n"
                "- AI API key not configured (set OPENROUTER_API_KEY in .env)\n"
                "- Backtest produced no trades\n\n"
                "Data-driven recommendations are shown in the Metrics tab."
            )
            return

        lines = []
        for i, rec in enumerate(recommendations, 1):
            # Support both object attributes and dict keys
            if isinstance(rec, dict):
                rec_type = rec.get('type', 'UNKNOWN')
                block_name = rec.get('block_name', '')
                signal_name = rec.get('signal_name', '')
                reasoning = rec.get('reasoning', '')
                confidence = rec.get('combined_confidence') or rec.get('confidence', 0)
                impact = rec.get('expected_impact', {})
                ai_enhanced = rec.get('ai_enhanced', False)
            else:
                rec_type = getattr(rec, 'type', 'UNKNOWN')
                block_name = getattr(rec, 'block_name', '') or ''
                signal_name = getattr(rec, 'signal_name', '') or ''
                reasoning = getattr(rec, 'reasoning', '')
                confidence = getattr(rec, 'combined_confidence', 0) or getattr(rec, 'confidence', 0)
                impact = getattr(rec, 'expected_impact', {}) or {}
                ai_enhanced = getattr(rec, 'ai_enhanced', False)

            source = "AI-ENHANCED" if ai_enhanced else "DATA-DRIVEN"
            lines.append(f"#{i} [{source}] {rec_type}")
            if block_name:
                if signal_name:
                    lines.append(f"   Target: {block_name} :: {signal_name}")
                else:
                    lines.append(f"   Target: {block_name}")
            if confidence:
                lines.append(f"   Confidence: {float(confidence):.0%}")
            if reasoning:
                lines.append(f"   Reasoning: {reasoning[:200]}{'...' if len(reasoning) > 200 else ''}")
            if impact:
                lines.append("   Expected Impact:")
                for metric, delta in impact.items():
                    lines.append(f"     {metric}: {delta}")
            lines.append("")

        self.recs_text.setPlainText("\n".join(lines))



# Test function
def test_preview_window():
    """Test the preview window"""
    import sys
    from PyQt5.QtWidgets import QApplication
    app = QApplication(sys.argv)
    
    # Sample data
    strategy_config = {
        'name': 'HOD Rejection Test',
        'strategy_type': 'Bearish',
        'blocks': [
            {
                'name': 'hod',
                'signals': [{'name': 'HOD_REJECTION'}]
            },
            {
                'name': 'stochastic_rsi',
                'signals': [{'name': 'BEARISH_CROSS'}]
            }
        ]
    }
    
    backtest_config = {
        'timeframe': '15m',
        'lookback_days': 180,
        'stop_loss': 0.02,
        'take_profit': [0.01, 0.015, 0.02],
        'position_size': 0.1
    }
    
    trades = [
        {
            'entry_time': '2025-10-01 08:00:00',
            'exit_time': '2025-10-01 12:30:00',
            'pnl': 75.50,
            'side': 'SHORT',
            'size': 0.1
        }
    ] * 24  # 24 identical trades for testing
    
    metrics = {
        'total_pnl': {'value': 544.0, 'rating': '✓ Good'},
        'win_rate': {'value': 58.3, 'rating': '✓ Good'},
        'profit_factor': {'value': 1.97, 'rating': '⚠ Fair'}
    }
    
    available_blocks = [
        {
            'name': 'atr',
            'category': 'VOLATILITY',
            'description': 'ATR volatility filter',
            'signals': [{'name': 'HIGH_VOLATILITY'}]
        }
    ] * 10  # 10 sample blocks
    
    # Create and show window
    window = AIRequestPreviewWindow()
    window.populate_preview(
        strategy_config,
        backtest_config,
        trades,
        metrics,
        available_blocks
    )
    
    def on_send_approved(data):
        logger.info("✅ Send approved!")
        logger.info(f"Request data size: {len(json.dumps(data, default=str))} bytes")
        app.quit()
    
    window.send_approved.connect(on_send_approved)
    window.show()
    
    sys.exit(app.exec())


if __name__ == '__main__':
    test_preview_window()
