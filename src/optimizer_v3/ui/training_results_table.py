"""
Training Results Table - Sprint 2.1, Task 2.1.22
================================================

Institutional-grade results display for training analysis.
Adapts TradesPanel patterns for training results.

REUSED PATTERNS:
- NumericTableWidgetItem for proper sorting
- Color-coded confidence scores (green/yellow/red)
- Multi-select support for export
- Export to CSV/clipboard functionality
- Real-time table updates

ZERO HARDCODED STYLES - All from styles.py

Author: Optimizer v3 Team
Date: 2026-02-05
Sprint: 2.1 (Automated Trainer - Task 2.1.22)
"""

from typing import List, Dict, Optional
from datetime import datetime
from pathlib import Path

from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QGroupBox, QTableWidget, QTableWidgetItem, QHeaderView,
    QAbstractItemView
)
from PyQt6.QtCore import Qt, pyqtSignal
from PyQt6.QtGui import QColor

# Import centralized styles - ZERO hardcoded styles
from src.strategy_builder.ui.styles import (
    get_groupbox_header_stylesheet,
    get_label_style,
    get_panel_title_stylesheet,
    get_primary_button_stylesheet,
    get_table_stylesheet,
    get_color
)

import logging
logger = logging.getLogger(__name__)



class NumericTableWidgetItem(QTableWidgetItem):
    """
    REUSED FROM TRADESPANEL - Custom QTableWidgetItem for numeric sorting.
    
    Ensures delay/sample size columns sort numerically (1,2,3...10,11,12...)
    instead of as strings (1,10,11,12...2,20,21...).
    """
    
    def __lt__(self, other):
        """Less than comparison using numeric value"""
        try:
            return int(self.text()) < int(other.text())
        except ValueError:
            # Fallback to string comparison if not numeric
            return super().__lt__(other)


class TrainingResultsTable(QWidget):
    """
    Training Results Table - Adapted from TradesPanel
    
    REUSED PATTERNS:
    - NumericTableWidgetItem for proper sorting
    - Color-coded confidence scores (green/yellow/red like P&L)
    - Multi-select support (ExtendedSelection)
    - Sortable columns
    - Export to CSV functionality
    - Copy to clipboard (all or selection)
    - Real-time table updates
    
    Features:
    - Displays optimal RECHECK delays from training
    - Shows confidence scores with color coding
    - Sample size validation
    - Range display (min-max delays)
    - Export training results
    """
    
    # Signals
    result_selected = pyqtSignal(dict)  # Emits selected result data
    
    def __init__(self, parent=None):
        super().__init__(parent)
        self.results: List[Dict] = []  # Training results from OptimalParameterCalculator
        self._init_ui()
    
    def _init_ui(self) -> None:
        """Initialize the user interface"""
        layout = QVBoxLayout()
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(15)
        
        # Title
        title_label = QLabel("📊 Training Results")
        title_label.setStyleSheet(get_panel_title_stylesheet())
        layout.addWidget(title_label)
        
        # Results table
        table_group = self._create_results_table()
        layout.addWidget(table_group)
        
        # Control buttons at bottom
        control_bar = self._create_control_bar()
        layout.addLayout(control_bar)
        
        self.setLayout(layout)
    
    def _create_results_table(self) -> QGroupBox:
        """Create results table - ADAPTED FROM TRADESPANEL._create_trades_table()"""
        group = QGroupBox("Training Results")
        group.setStyleSheet(get_groupbox_header_stylesheet())
        
        layout = QVBoxLayout()
        layout.setContentsMargins(10, 15, 10, 10)
        
        # Create table
        self.table = QTableWidget()
        self.table.setColumnCount(8)
        self.table.setHorizontalHeaderLabels([
            'Signal', 'Timeframe', 'Optimal Delay (bars)', 'Range (Min-Max)', 
            'Sample Size', 'Confidence', 'Method', 'Reasoning'
        ])
        
        # Table styling - REUSED PATTERN from TradesPanel
        self.table.setStyleSheet(get_table_stylesheet())
        self.table.setAlternatingRowColors(True)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)  # Multi-select
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.setSortingEnabled(True)
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Interactive)
        self.table.verticalHeader().setVisible(False)
        
        # Set column widths
        column_widths = [200, 120, 150, 150, 120, 120, 120, 500]
        for i, width in enumerate(column_widths):
            self.table.setColumnWidth(i, width)
        
        # Set stretch on columns 0-6, keep Reasoning (7) fixed
        for i in range(7):
            self.table.horizontalHeader().setSectionResizeMode(i, QHeaderView.ResizeMode.Stretch)
        
        # Connect signals
        self.table.itemSelectionChanged.connect(self._on_selection_changed)
        
        layout.addWidget(self.table)
        group.setLayout(layout)
        return group
    
    def _create_control_bar(self) -> QHBoxLayout:
        """Create control buttons - REUSED PATTERN from TradesPanel"""
        layout = QHBoxLayout()
        layout.setSpacing(20)
        
        # Filter info
        self.filter_label = QLabel("Showing: <b>All Results (0)</b>")
        self.filter_label.setStyleSheet(get_label_style())
        layout.addWidget(self.filter_label)
        
        layout.addStretch()
        
        # Copy Selection button (REUSED from TradesPanel)
        copy_selection_btn = QPushButton("📋 Copy Selection")
        copy_selection_btn.setStyleSheet(get_primary_button_stylesheet(compact=True))
        copy_selection_btn.setFixedSize(245, 42)
        copy_selection_btn.clicked.connect(self._copy_selection)
        copy_selection_btn.setToolTip("Copy selected results to clipboard (Ctrl+Click for multi-select)")
        layout.addWidget(copy_selection_btn)
        
        # Copy All button (REUSED from TradesPanel)
        copy_btn = QPushButton("📋 Copy All")
        copy_btn.setStyleSheet(get_primary_button_stylesheet(compact=True))
        copy_btn.setFixedSize(135, 42)
        copy_btn.clicked.connect(self._copy_results)
        copy_btn.setToolTip("Copy all results to clipboard")
        layout.addWidget(copy_btn)
        
        # Export button (REUSED from TradesPanel)
        export_btn = QPushButton("💾 Export")
        export_btn.setStyleSheet(get_primary_button_stylesheet(compact=True))
        export_btn.setFixedSize(130, 42)
        export_btn.clicked.connect(self._export_results)
        export_btn.setToolTip("Export all results to CSV file")
        layout.addWidget(export_btn)
        
        return layout
    
    def clear_results(self) -> None:
        """Clear all results from panel"""
        self.results.clear()
        self._update_table()
        logger.info("🧹 Training results cleared")
    
    def add_result(self, result_data: Dict) -> None:
        """
        Add training result - SAME PATTERN as TradesPanel.add_trade()
        
        REUSED DUPLICATE DETECTION LOGIC from TradesPanel
        
        Args:
            result_data: {
                'signal_name': str,
                'timeframe': str,
                'optimal_delay': int,
                'min_delay': int,
                'max_delay': int,
                'sample_size': int,
                'confidence': Decimal (0.0-1.0),
                'method': str,
                'reasoning': str
            }
        """
        # Check for duplicate (same signal+timeframe combination)
        signal_key = f"{result_data['signal_name']}_{result_data['timeframe']}"
        for i, existing in enumerate(self.results):
            existing_key = f"{existing['signal_name']}_{existing['timeframe']}"
            if existing_key == signal_key:
                # Update existing result
                logger.info(f"🔄 Result for {signal_key} already exists - updating")
                self.results[i].update(result_data)
                self._update_table()
                return
        
        # Add new result
        logger.info(f"➕ Adding new result for {signal_key}")
        self.results.append(result_data)
        self._update_table()
    
    def _update_table(self) -> None:
        """Update table - ADAPTED FROM TRADESPANEL._update_table()"""
        # Disable sorting during update to prevent visual artifacts
        was_sorting_enabled = self.table.isSortingEnabled()
        if was_sorting_enabled:
            self.table.setSortingEnabled(False)
        
        self.table.setRowCount(len(self.results))
        
        for row, result in enumerate(self.results):
            # Signal name
            self.table.setItem(row, 0, self._create_item(result.get('signal_name', '')))
            
            # Timeframe
            self.table.setItem(row, 1, self._create_item(result.get('timeframe', '')))
            
            # Optimal Delay - NumericTableWidgetItem for proper sorting (REUSED from TradesPanel)
            delay_item = NumericTableWidgetItem(str(result.get('optimal_delay', '')))
            delay_item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
            self.table.setItem(row, 2, delay_item)
            
            # Range (Min-Max)
            min_delay = result.get('min_delay', 0)
            max_delay = result.get('max_delay', 0)
            range_str = f"{min_delay}-{max_delay}" if min_delay != max_delay else str(min_delay)
            self.table.setItem(row, 3, self._create_item(range_str))
            
            # Sample Size - NumericTableWidgetItem for proper sorting (REUSED from TradesPanel)
            sample_item = NumericTableWidgetItem(str(result.get('sample_size', '')))
            sample_item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
            self.table.setItem(row, 4, sample_item)
            
            # Confidence - COLOR-CODED like P&L in TradesPanel (ADAPTED PATTERN)
            confidence = float(result.get('confidence', 0))
            conf_item = self._create_item(f"{confidence*100:.0f}%")
            if confidence >= 0.8:
                # High confidence: Green (like winning trade)
                conf_item.setForeground(QColor(get_color('success')))
            elif confidence >= 0.5:
                # Medium confidence: Yellow/Orange (like neutral)
                conf_item.setForeground(QColor(get_color('warning')))
            else:
                # Low confidence: Red (like losing trade)
                conf_item.setForeground(QColor(get_color('error')))
            self.table.setItem(row, 5, conf_item)
            
            # Method
            method = result.get('method', 'unknown')
            self.table.setItem(row, 6, self._create_item(method))
            
            # Reasoning
            reasoning = result.get('reasoning', '')
            self.table.setItem(row, 7, self._create_item(reasoning))
        
        # Re-enable sorting
        if was_sorting_enabled:
            self.table.setSortingEnabled(True)
            # Default sort by signal name
            self.table.sortItems(0, Qt.SortOrder.AscendingOrder)
        
        # Update filter label
        self.filter_label.setText(f"Showing: <b>All Results ({len(self.results)})</b>")
    
    def _create_item(self, text: str) -> QTableWidgetItem:
        """REUSED FROM TRADESPANEL - Create centered table item"""
        item = QTableWidgetItem(text)
        item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
        return item
    
    def _on_selection_changed(self) -> None:
        """Handle row selection - REUSED PATTERN from TradesPanel"""
        selected_rows = self.table.selectionModel().selectedRows()
        if selected_rows:
            row = selected_rows[0].row()
            if row < len(self.results):
                self.result_selected.emit(self.results[row])
    
    def _copy_selection(self) -> None:
        """Copy selected results - REUSED FROM TRADESPANEL._copy_selection()"""
        from PyQt6.QtWidgets import QApplication
        
        selected_rows = self.table.selectionModel().selectedRows()
        if not selected_rows:
            logger.warning("⚠️ No results selected - select rows with Ctrl+Click")
            return
        
        try:
            # Get selected indices
            selected_indices = sorted([row.row() for row in selected_rows])
            selected_results = [self.results[i] for i in selected_indices]
            
            # Build tab-separated content (Excel-compatible)
            lines = []
            lines.append("Signal\tTimeframe\tOptimal Delay\tRange\tSample Size\tConfidence\tMethod\tReasoning")
            
            for result in selected_results:
                confidence = float(result.get('confidence', 0))
                min_delay = result.get('min_delay', 0)
                max_delay = result.get('max_delay', 0)
                range_str = f"{min_delay}-{max_delay}" if min_delay != max_delay else str(min_delay)
                
                lines.append(
                    f"{result.get('signal_name', '')}\t"
                    f"{result.get('timeframe', '')}\t"
                    f"{result.get('optimal_delay', '')}\t"
                    f"{range_str}\t"
                    f"{result.get('sample_size', '')}\t"
                    f"{confidence*100:.0f}%\t"
                    f"{result.get('method', '')}\t"
                    f"{result.get('reasoning', '')}"
                )
            
            # Copy to clipboard
            content = '\n'.join(lines)
            clipboard = QApplication.clipboard()
            clipboard.setText(content)
            
            logger.info(f"✅ {len(selected_results)} selected results copied to clipboard")
            
        except Exception as e:
            logger.error(f"❌ Copy selection failed: {str(e)}")
    
    def _copy_results(self) -> None:
        """Copy all results - REUSED FROM TRADESPANEL._copy_trades()"""
        from PyQt6.QtWidgets import QApplication
        if not self.results:
            logger.warning("⚠️ No results to copy")
            return
        
        try:
            # Build tab-separated content (Excel-compatible)
            lines = []
            lines.append("Signal\tTimeframe\tOptimal Delay\tRange\tSample Size\tConfidence\tMethod\tReasoning")
            
            for result in self.results:
                confidence = float(result.get('confidence', 0))
                min_delay = result.get('min_delay', 0)
                max_delay = result.get('max_delay', 0)
                range_str = f"{min_delay}-{max_delay}" if min_delay != max_delay else str(min_delay)
                
                lines.append(
                    f"{result.get('signal_name', '')}\t"
                    f"{result.get('timeframe', '')}\t"
                    f"{result.get('optimal_delay', '')}\t"
                    f"{range_str}\t"
                    f"{result.get('sample_size', '')}\t"
                    f"{confidence*100:.0f}%\t"
                    f"{result.get('method', '')}\t"
                    f"{result.get('reasoning', '')}"
                )
            
            # Copy to clipboard
            content = '\n'.join(lines)
            clipboard = QApplication.clipboard()
            clipboard.setText(content)
            
            logger.info(f"✅ {len(self.results)} results copied to clipboard")
            
        except Exception as e:
            logger.error(f"❌ Copy failed: {str(e)}")
    
    def _export_results(self) -> None:
        """Export results to CSV - REUSED FROM TRADESPANEL._export_trades()"""
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        filename = f"training_results_{timestamp}.csv"
        
        try:
            with open(filename, 'w') as f:
                # Write header
                f.write("Signal,Timeframe,Optimal Delay,Min Delay,Max Delay,Sample Size,Confidence,Method,Reasoning\n")
                
                # Write results
                for result in self.results:
                    confidence = float(result.get('confidence', 0))
                    f.write(
                        f"{result.get('signal_name', '')},"
                        f"{result.get('timeframe', '')},"
                        f"{result.get('optimal_delay', '')},"
                        f"{result.get('min_delay', '')},"
                        f"{result.get('max_delay', '')},"
                        f"{result.get('sample_size', '')},"
                        f"{confidence*100:.0f}%,"
                        f"{result.get('method', '')},"
                        f"\"{result.get('reasoning', '')}\"\n"
                    )
            
            logger.info(f"✅ Training results exported to {filename}")
            
        except Exception as e:
            logger.error(f"❌ Export failed: {str(e)}")
    
    def get_results(self) -> List[Dict]:
        """Get all results"""
        return self.results.copy()
