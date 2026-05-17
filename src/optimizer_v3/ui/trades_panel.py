"""
Trades Panel - Institutional-Grade Trade Tracking

Excel-like interface for comprehensive trade tracking:
- Real-time trade updates
- Trade status indicators
- Entry/exit details
- PnL tracking with proper Money types
- Risk metrics analysis
- Interactive sorting and filtering
- Export capabilities

ZERO HARDCODED STYLES - All from styles.py

Author: Optimizer v3 Team
Date: 2026-01-20
Sprint: 1.4 (UI Integration - Task 1.4.5)
"""

from typing import List, Dict, Optional
from decimal import Decimal
from datetime import datetime
from pathlib import Path
from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QGroupBox, QTableWidget, QTableWidgetItem, QHeaderView,
    QAbstractItemView, QMenu
)
from PyQt5.QtCore import Qt, pyqtSignal, QTimer
from PyQt5.QtGui import QColor, QContextMenuEvent

# Import centralized styles - ZERO hardcoded styles
from src.strategy_builder.ui.styles import (
    get_groupbox_header_stylesheet,
    get_label_style,
    get_panel_title_stylesheet,
    get_primary_button_stylesheet,
    get_table_stylesheet,
    get_color
)

# Import institutional-grade logger for trade tracking
from src.debugger_logger.config_debugger import ConfigDebugger, DebugLevel

import logging
logger = logging.getLogger(__name__)

class NumericTableWidgetItem(QTableWidgetItem):
    """
    Custom QTableWidgetItem that implements proper numeric comparison.
    
    This ensures ID column sorts numerically with dot notation support:
    - Simple: 1, 2, 3...10, 11, 12... (not 1, 10, 11, 12...2, 20, 21...)
    - Dot notation: 1.1, 1.2, 2.1, 3.1, 3.2, 3.3 (not 1.1, 10.1, 100.1, 101.1...)
    """
    
    def __lt__(self, other):
        """Less than comparison using numeric value with dot notation support"""
        try:
            # Parse dot notation: "5.1" -> (5, 1)
            self_text = self.text()
            other_text = other.text()
            
            if '.' in self_text or '.' in other_text:
                # Handle dot notation (e.g., "1.1", "1.2", "2.1")
                def parse_id(text):
                    if '.' in text:
                        parts = text.split('.')
                        return (int(parts[0]), int(parts[1]))
                    else:
                        # Legacy integer: "5" -> (5, 0)
                        return (int(text), 0)
                
                self_tuple = parse_id(self_text)
                other_tuple = parse_id(other_text)
                return self_tuple < other_tuple
            else:
                # Simple integer comparison
                return int(self_text) < int(other_text)
        except (ValueError, IndexError):
            # Fallback to string comparison if parsing fails
            return super().__lt__(other)


class TradesPanel(QWidget):
    """
    Institutional-Grade Trades Panel
    
    Features:
    - Real-time trade tracking
    - Excel-like table interface
    - Interactive sorting/filtering
    - PnL tracking with Money types
    - Risk metrics analysis
    - Export capabilities
    - Dark theme compatible
    """
    
    # Signals
    trade_selected = pyqtSignal(dict)  # Emits selected trade data
    metrics_updated = pyqtSignal(dict)  # Emits real-time metrics to Metrics Display Panel
    
    def __init__(self, parent=None):
        super().__init__(parent)
        self.trades: List[Dict] = []
        self.filtered_trades: List[Dict] = []
        self.current_sort_column = 0
        self.current_sort_order = Qt.SortOrder.DescendingOrder
        
        # Performance tracking
        self.total_pnl = Decimal('0.0')
        self.win_count = 0
        self.loss_count = 0
        
        # Initialize institutional-grade logger for trade tracking
        log_dir = Path("logs/trades")
        log_dir.mkdir(parents=True, exist_ok=True)
        log_file = log_dir / f"trades_panel_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"
        
        self.logger = ConfigDebugger(
            name="TradesPanel",
            level=DebugLevel.HIGH,  # Log all important operations
            log_file=log_file,
            console_output=True  # Also print to console for real-time monitoring
        )
        
        self.logger._write_log("✓ TradesPanel initialized with institutional-grade logging", force=True)
        
        self._init_ui()
        
        # Update timer for metrics
        self.metrics_timer = QTimer(self)  # Set parent to ensure proper cleanup
        self.metrics_timer.timeout.connect(self._update_metrics)
        self.metrics_timer.start(1000)  # Update every second
    
    def closeEvent(self, event):
        """Handle widget close event - stop timer to prevent threading issues"""
        if hasattr(self, 'metrics_timer') and self.metrics_timer.isActive():
            self.metrics_timer.stop()
            self.logger._write_log("🛑 Metrics timer stopped on close", force=True)
        super().closeEvent(event)
    
    def _console_print(self, message: str):
        """Print to console only if console debugging is enabled"""
        from src.debugger_logger.config_debugger import ConfigDebugger
        if ConfigDebugger.CONSOLE_ENABLED:
            logger.info(message)
    
    def _init_ui(self) -> None:
        """Initialize the user interface"""
        layout = QVBoxLayout()
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(15)
        
        # Title
        title_label = QLabel("📊 Trades Panel")
        title_label.setStyleSheet(get_panel_title_stylesheet())
        layout.addWidget(title_label)
        
        # Performance summary
        summary_group = self._create_performance_summary()
        layout.addWidget(summary_group)
        
        # Trades table
        table_group = self._create_trades_table()
        layout.addWidget(table_group)
        
        # Control buttons at bottom
        control_bar = self._create_control_bar()
        layout.addLayout(control_bar)
        
        self.setLayout(layout)
    
    def _create_performance_summary(self) -> QGroupBox:
        """Create performance summary panel"""
        group = QGroupBox("Performance Summary")
        group.setStyleSheet(get_groupbox_header_stylesheet())
        group.setMaximumHeight(120)
        
        layout = QHBoxLayout()
        layout.setSpacing(30)
        layout.setContentsMargins(15, 20, 15, 15)
        
        # Total PnL
        self.pnl_label = QLabel("Total P&L: <b>$0.00</b>")
        self.pnl_label.setStyleSheet(get_label_style())
        layout.addWidget(self.pnl_label)
        
        # Win Rate
        self.winrate_label = QLabel("Win Rate: <b>0.00%</b>")
        self.winrate_label.setStyleSheet(get_label_style())
        layout.addWidget(self.winrate_label)
        
        # Long Trades
        self.long_trades_label = QLabel("Long Trades: <b>0</b>")
        self.long_trades_label.setStyleSheet(get_label_style())
        layout.addWidget(self.long_trades_label)
        
        # Short Trades
        self.short_trades_label = QLabel("Short Trades: <b>0</b>")
        self.short_trades_label.setStyleSheet(get_label_style())
        layout.addWidget(self.short_trades_label)
        
        # Winning Trades
        self.winning_trades_label = QLabel("Winning Trades: <b>0</b>")
        self.winning_trades_label.setStyleSheet(get_label_style())
        layout.addWidget(self.winning_trades_label)
        
        # Losing Trades
        self.losing_trades_label = QLabel("Losing Trades: <b>0</b>")
        self.losing_trades_label.setStyleSheet(get_label_style())
        layout.addWidget(self.losing_trades_label)
        
        layout.addStretch()
        
        group.setLayout(layout)
        return group
    
    def _create_trades_table(self) -> QGroupBox:
        """Create trades table with Excel-like interface"""
        group = QGroupBox("Trade History")
        group.setStyleSheet(get_groupbox_header_stylesheet())
        
        layout = QVBoxLayout()
        layout.setContentsMargins(10, 15, 10, 10)
        
        # Create table
        self.table = QTableWidget()
        self.table.setColumnCount(13)  # Removed Exit Type & Exit Condition (redundant with Notes)
        self.table.setHorizontalHeaderLabels([
            'ID', 'Time', 'Symbol', 'Side', 'Size', 'Entry', 
            'Exit', 'Duration', 'P&L', 'P&L %', 'Status',
            'Partial %', 'Notes'  # Exit Type/Condition removed
        ])
        
        # Table styling - using helper function from styles.py (ZERO hardcoded styles)
        self.table.setStyleSheet(get_table_stylesheet())
        
        # Table configuration
        self.table.setAlternatingRowColors(True)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)  # Allow multi-selection
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        # Enable sorting - ID column uses NumericTableWidgetItem for proper numeric sorting
        self.table.setSortingEnabled(True)
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Interactive)
        self.table.verticalHeader().setVisible(False)
        
        # Set column widths - UPDATED: Removed Exit Type/Condition columns
        # Columns: ID, Time, Symbol, Side, Size, Entry, Exit, Duration, P&L, P&L%, Status, Partial%, Notes
        # ID=115px (fixed), Partial%=360px (wider, reclaimed from removed columns), Notes=500px (fixed)
        column_widths = [115, 120, 120, 120, 120, 120, 120, 120, 120, 120, 120, 360, 500]
        for i, width in enumerate(column_widths):
            self.table.setColumnWidth(i, width)
        
        # Set stretch on standard columns (1-10) to fill window equally
        # ID (0), Partial% (11), and Notes (12) stay fixed
        for i in range(1, 11):  # Columns 1-10 (Time through Status)
            self.table.horizontalHeader().setSectionResizeMode(i, QHeaderView.ResizeMode.Stretch)
        
        # Connect signals
        self.table.itemSelectionChanged.connect(self._on_selection_changed)
        # Note: Header sorting disabled - data is pre-sorted by ID
        
        layout.addWidget(self.table)
        group.setLayout(layout)
        return group
    
    def _create_control_bar(self) -> QHBoxLayout:
        """Create control buttons at bottom"""
        layout = QHBoxLayout()
        layout.setSpacing(20)
        
        # Filter info
        self.filter_label = QLabel("Showing: <b>All Trades (0)</b>")
        self.filter_label.setStyleSheet(get_label_style())
        layout.addWidget(self.filter_label)
        
        layout.addStretch()
        
        # Copy Selection button (for selected rows)
        copy_selection_btn = QPushButton("📋 Copy Selection")
        copy_selection_btn.setStyleSheet(get_primary_button_stylesheet(compact=True))
        copy_selection_btn.setFixedSize(245, 42)
        copy_selection_btn.clicked.connect(self._copy_selection)
        copy_selection_btn.setToolTip("Copy selected trades to clipboard (Ctrl+Click for multi-select)")
        layout.addWidget(copy_selection_btn)
        
        # Copy All button
        copy_btn = QPushButton("📋 Copy All")
        copy_btn.setStyleSheet(get_primary_button_stylesheet(compact=True))
        copy_btn.setFixedSize(135, 42)
        copy_btn.clicked.connect(self._copy_trades)
        copy_btn.setToolTip("Copy all trades to clipboard")
        layout.addWidget(copy_btn)
        
        # Export button
        export_btn = QPushButton("💾 Export")
        export_btn.setStyleSheet(get_primary_button_stylesheet(compact=True))
        export_btn.setFixedSize(130, 42)
        export_btn.clicked.connect(self._export_trades)
        export_btn.setToolTip("Export all trades to CSV file")
        layout.addWidget(export_btn)
        
        return layout
    
    def sync_from_registry(self) -> None:
        """
        Sync trades from TradeRegistry (single source of truth)
        
        CRITICAL FIX: Instead of accumulating trades from signals (which contain duplicates),
        we pull from the TradeRegistry which has already deduplicated.
        
        Call this method after backtest completion to display final unique trades.
        """
        from src.optimizer_v3.core.trade_registry import get_trade_registry
        
        registry = get_trade_registry()
        unique_trades = registry.get_all_trades()
        
        # Convert registry format to panel format
        self.trades.clear()
        for trade in unique_trades:
            # Map registry keys to panel keys
            panel_trade = {
                'id': str(trade.get('trade_id', '')),
                'timestamp': trade.get('entry_timestamp'),
                'symbol': 'BTC.P/USDT',
                'side': trade.get('side', 'LONG'),
                # ✅ FIX: Get actual position_size from registry, NOT hardcoded 0.1
                'position_size': trade.get('position_size'),
                'partial_size': trade.get('partial_size'),
                'size': trade.get('size', 0.1),  # Legacy fallback
                'entry_price': trade.get('entry_price', 0),
                'exit_price': trade.get('exit_price', 0),
                'duration': self._format_duration(trade),
                'pnl': trade.get('pnl', 0),
                'pnl_pct': trade.get('pnl_pct', 0),
                'status': trade.get('status', 'CLOSED'),
                'notes': self._format_notes(trade),
                'exit_condition_name': trade.get('exit_condition_name'),
                'exit_type': trade.get('exit_type')
            }
            self.trades.append(panel_trade)
        
        self.filtered_trades = self.trades.copy()
        self._update_table()
        self._update_metrics()
        
        logger.info(f"✅ Synced {len(self.trades)} unique trades from TradeRegistry")
        self.logger._write_log(
            f"📊 Synced trades from registry: {len(unique_trades)} unique trades loaded",
            force=True
        )
    
    def clear_trades(self) -> None:
        """Clear all trades from panel (call at start of new backtest)"""
        # Log snapshot of all trades before clearing
        if self.trades:
            self.logger.log_multiple_positions(self.trades, location="clear_trades()")
            self.logger._write_log(f"🧹 Clearing {len(self.trades)} trades for new backtest", force=True)
        
        self.trades.clear()
        self.filtered_trades.clear()
        self._update_table()
        self._update_metrics()
        self._console_print("🧹 Trades panel cleared for new backtest")
    
    def add_trade(self, trade_data: Dict) -> None:
        """
        Add trade to panel - SUPPORTS PARTIAL EXITS (multiple records same ID).
        
        CRITICAL: Partial exits (TP1, TP2, TP3) with same entry ID are APPENDED,
        not updated, so aggregation can group them later.
        
        Args:
            trade_data: Dictionary with trade information
                Required keys: id, timestamp, symbol, side, size, entry_price
                Optional keys: exit_price, exit_timestamp, pnl, status, notes
        """
        trade_id = trade_data.get('id')
        exit_condition = trade_data.get('exit_condition_name', '')
        
        # Log attempt to add trade
        self.logger.log_trade_opened(trade_id, trade_data, location="add_trade()")
        
        # CRITICAL: For PARTIAL EXITS, always append (don't update)
        # Each partial exit (TP1, TP2, TP3) is a separate record to aggregate later
        if exit_condition in ['TP1', 'TP2', 'TP3', 'SL']:
            logger.info(f"➕ Adding partial exit #{trade_id} ({exit_condition})")
            self.trades.append(trade_data)
            self.filtered_trades = self.trades.copy()
            self._update_table()
            self._update_metrics()
            return
        
        # For OPEN status or non-partial exits, check for duplicates
        trade_id_str = str(trade_id)
        for i, existing_trade in enumerate(self.trades):
            if str(existing_trade.get('id')) == trade_id_str:
                # Duplicate OPEN/CLOSED (not partial) - update instead
                self.logger.log_trade_updated(
                    trade_id,
                    old_data=existing_trade,
                    new_data=trade_data,
                    location="add_trade() - duplicate non-partial"
                )
                logger.info(f"🔄 Trade #{trade_id} non-partial - updating")
                self.trades[i].update(trade_data)
                self.filtered_trades = self.trades.copy()
                self._update_table()
                self._update_metrics()
                return
        
        # Trade doesn't exist - add it
        logger.info(f"➕ Adding new trade #{trade_id}")
        self.trades.append(trade_data)
        self.filtered_trades = self.trades.copy()
        self._update_table()
        self._update_metrics()
    
    def update_trade(self, trade_id, trade_data: Dict) -> None:
        """
        Update existing trade in real-time (called when trade closes during execution).
        
        CRITICAL: This is where positions are closed. Must ensure correct ID matching.
        
        Args:
            trade_id: ID of trade to update (string or int)
            trade_data: Updated trade information (exit_price, pnl, status, etc.)
        """
        # Convert to string for comparison (IDs stored as strings)
        trade_id_str = str(trade_id)
        
        # Find trade by ID and update it
        for i, trade in enumerate(self.trades):
            if str(trade.get('id')) == trade_id_str:
                # FOUND MATCH - Log the update with old/new data comparison
                old_data = self.trades[i].copy()
                
                self.logger.log_trade_updated(
                    trade_id,
                    old_data=old_data,
                    new_data=trade_data,
                    location="update_trade() - position found"
                )
                
                # Update trade with new data
                self.trades[i].update(trade_data)
                self.filtered_trades = self.trades.copy()
                
                # Immediately refresh UI to show closed trade
                self._update_table()
                self._update_metrics()
                
                # Log remaining open positions after close
                open_positions = [t for t in self.trades if t.get('status') == 'OPEN']
                if open_positions:
                    self.logger.log_multiple_positions(
                        open_positions,
                        location="update_trade() - after position closed"
                    )
                
                logger.info(f"✅ Trade #{trade_id} updated in real-time")
                return
        
        # TRADE NOT FOUND - CRITICAL ERROR
        self.logger.log_trade_not_found(
            trade_id,
            operation="UPDATE/CLOSE",
            location="update_trade() - ID not in trades list"
        )
        
        # Log all current trade IDs for debugging
        all_ids = [str(t.get('id')) for t in self.trades]
        self.logger._write_log(
            f"⚠️ Current trade IDs in panel: {all_ids}\n"
            f"   Attempted to update ID: {trade_id_str}\n"
            f"   Total trades in panel: {len(self.trades)}",
            force=True
        )
        
        logger.warning(f"⚠️ Trade #{trade_id} not found for update - adding as new trade")
        # If not found, add as new trade (shouldn't happen, but safety fallback)
        self.add_trade(trade_data)
    
    def _update_table(self) -> None:
        """Update table with current trades - GROUP BY TRADE_ID FOR PARTIAL EXITS"""
        # Disable sorting during update to prevent visual artifacts
        was_sorting_enabled = self.table.isSortingEnabled()
        if was_sorting_enabled:
            self.table.setSortingEnabled(False)
        
        # CRITICAL: Group trades by trade_id (1 entry can have multiple exits)
        grouped_trades = {}
        for trade in self.filtered_trades:
            trade_id = trade.get('id')
            if trade_id not in grouped_trades:
                grouped_trades[trade_id] = []
            grouped_trades[trade_id].append(trade)
        
        # Display one row per unique trade_id (grouped by entry)
        display_trades = []
        for trade_id, exits in grouped_trades.items():
            # Aggregate all exits for this trade_id
            aggregated_trade = self._aggregate_exits(exits)
            display_trades.append(aggregated_trade)
        
        # Sort by trade_id for chronological order (supports dot notation "5.1", "5.2")
        def sort_key(trade):
            trade_id = str(trade.get('id', '0'))
            if '.' in trade_id:
                # Dot notation: "5.1" -> (5, 1)
                parts = trade_id.split('.')
                return (int(parts[0]), int(parts[1]))
            else:
                # Legacy integer: "5" -> (5, 0)
                try:
                    return (int(trade_id), 0)
                except ValueError:
                    return (0, 0)
        
        display_trades.sort(key=sort_key)
        
        self.table.setRowCount(len(display_trades))
        
        for row, trade in enumerate(display_trades):
            # ID - Use NumericTableWidgetItem for proper numeric sorting
            id_item = NumericTableWidgetItem(str(trade.get('id', '')))
            id_item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
            self.table.setItem(row, 0, id_item)
            
            # Time
            timestamp = trade.get('timestamp', datetime.now())
            time_str = timestamp.strftime('%H:%M:%S') if isinstance(timestamp, datetime) else str(timestamp)
            self.table.setItem(row, 1, self._create_item(time_str))
            
            # Symbol
            self.table.setItem(row, 2, self._create_item(trade.get('symbol', 'BTC/USDT')))
            
            # Side (LONG/SHORT for futures trading)
            side = trade.get('side', 'LONG')
            side_item = self._create_item(side)
            if side == 'LONG':
                side_item.setForeground(QColor(get_color('success')))  # Green for LONG
            else:  # SHORT
                side_item.setForeground(QColor(get_color('error')))  # Red for SHORT
            self.table.setItem(row, 3, side_item)
            
            # Size - ✅ INSTITUTIONAL FIX: Display actual position_size with fallback
            # Priority: partial_size (for this specific exit) > position_size (total) > legacy 'size' field
            partial_size = trade.get('partial_size')
            position_size = trade.get('position_size')
            legacy_size = trade.get('size', '0.0')
            
            # Use partial_size if available (most accurate for this specific exit)
            # Otherwise use position_size (total position)
            # Fall back to legacy 'size' field for backward compatibility
            if partial_size is not None:
                size_display = partial_size
            elif position_size is not None:
                size_display = position_size
            else:
                size_display = float(legacy_size)
            
            self.table.setItem(row, 4, self._create_item(f"{float(size_display):.4f}"))
            
            # Entry Price
            entry = trade.get('entry_price', '0.0')
            self.table.setItem(row, 5, self._create_item(f"${float(entry):,.2f}"))
            
            # Exit Price
            exit_price = trade.get('exit_price')
            if exit_price:
                self.table.setItem(row, 6, self._create_item(f"${float(exit_price):,.2f}"))
            else:
                self.table.setItem(row, 6, self._create_item('-'))
            
            # Duration
            duration = trade.get('duration', '00:00:00')
            self.table.setItem(row, 7, self._create_item(str(duration)))
            
            # P&L
            pnl = trade.get('pnl', 0.0)
            pnl_item = self._create_item(f"${float(pnl):,.2f}")
            if float(pnl) > 0:
                pnl_item.setForeground(QColor(get_color('success')))
            elif float(pnl) < 0:
                pnl_item.setForeground(QColor(get_color('error')))
            self.table.setItem(row, 8, pnl_item)
            
            # P&L %
            pnl_pct = trade.get('pnl_pct', 0.0)
            pnl_pct_item = self._create_item(f"{float(pnl_pct):.2f}%")
            if float(pnl_pct) > 0:
                pnl_pct_item.setForeground(QColor(get_color('success')))
            elif float(pnl_pct) < 0:
                pnl_pct_item.setForeground(QColor(get_color('error')))
            self.table.setItem(row, 9, pnl_pct_item)
            
            # Status
            status = trade.get('status', 'OPEN')
            status_item = self._create_item(status)
            if status == 'CLOSED':
                status_item.setForeground(QColor(get_color('text_muted')))
            elif status == 'OPEN':
                status_item.setForeground(QColor(get_color('success')))
            self.table.setItem(row, 10, status_item)
            
            # Partial Exit Breakdown (aggregated: "TP1: $X | TP2: $Y | TP3: $Z")
            # Column 11 (Exit Type/Condition removed)
            partial_breakdown = trade.get('partial_exit_breakdown', '-')
            partial_item = self._create_item(str(partial_breakdown))
            # Color based on total PnL, not just existence
            if partial_breakdown != '-':
                if float(pnl) > 0:
                    partial_item.setForeground(QColor(get_color('success')))  # Green for profit
                else:
                    partial_item.setForeground(QColor(get_color('error')))  # Red for loss
            self.table.setItem(row, 11, partial_item)
            
            # Notes (aggregated: "ALL TP Exits" or specific exit info)
            # Column 12
            notes = trade.get('notes', '')
            notes_item = self._create_item(str(notes))
            
            # Add tooltip explaining dynamic TP behavior (Fibonacci mode)
            if 'TP' in notes:
                notes_item.setToolTip(
                    "⚠️ DYNAMIC TP ORDERING (Fibonacci Mode)\n\n"
                    "TPs may hit out of numerical order (e.g., TP2 before TP1).\n"
                    "This is CORRECT institutional behavior:\n\n"
                    "• TPs use dynamic Fibonacci calculations (0.382, 0.618, 1.0)\n"
                    "• TP placement based on market structure (S&D zones, swings)\n"
                    "• System exits at BEST available levels, not fixed percentages\n"
                    "• TP2 might be closer than TP1 based on Fibonacci analysis\n\n"
                    "This ensures optimal profit-taking at key market levels.\n"
                    "For fixed TP order, use 'PERCENTAGE' mode instead of 'FIBONACCI'."
                )
            
            self.table.setItem(row, 12, notes_item)
        
        # Re-enable sorting and apply default sort (ID ascending for chronological order)
        if was_sorting_enabled:
            self.table.setSortingEnabled(True)
            # Sort by ID column (ascending) for chronological order
            self.table.sortItems(0, Qt.SortOrder.AscendingOrder)
    
    def _aggregate_exits(self, exits: List[Dict]) -> Dict:
        """
        Aggregate multiple exits for the same trade_id into single display row.
        
        Args:
            exits: List of exit records for same entry (same trade_id)
        
        Returns:
            Aggregated trade dict with formatted Partial % and Notes
        """
        # Use first exit as base (has entry data)
        base_trade = exits[0].copy()
        
        # Aggregate PnL from all exits
        total_pnl = sum(float(e.get('pnl', 0)) for e in exits)
        total_pnl_pct = sum(float(e.get('pnl_pct', 0)) for e in exits)
        
        # Build Partial % breakdown: "TP1: $X | TP2: $Y | TP3: $Z"
        tp_breakdown = []
        tp_counts = {'TP1': 0, 'TP2': 0, 'TP3': 0, 'SL': 0, 'MAX_BARS': 0}
        max_bars_pnl = 0.0  # Track MAX_BARS PnL separately (can be duplicated in data)
        
        for exit_record in exits:
            exit_cond = exit_record.get('exit_condition_name', '')
            exit_type = exit_record.get('exit_type', '')
            pnl = float(exit_record.get('pnl', 0))
            
            if exit_cond in ['TP1', 'TP2', 'TP3']:
                tp_breakdown.append(f"{exit_cond}: ${pnl:.2f}")
                tp_counts[exit_cond] += 1
            elif exit_cond == 'SL':
                tp_breakdown.append(f"SL: ${pnl:.2f}")
                tp_counts['SL'] += 1
            elif exit_cond == 'MAX_BARS' or exit_type == 'TIME_LIMIT':
                # MAX_BARS exit detected - DEDUPLICATE (backtest emits multiple times)
                if tp_counts['MAX_BARS'] == 0:
                    # First MAX_BARS - add it
                    max_bars_pnl = pnl
                    tp_breakdown.append(f"Max Bars: ${pnl:.2f}")
                    tp_counts['MAX_BARS'] = 1
                # else: Skip duplicate MAX_BARS emissions
        
        # CRITICAL: If MAX_BARS or SL present, they dominate (terminal exits)
        # Remove any TP exits when terminal exit exists
        if tp_counts['MAX_BARS'] > 0:
            # MAX_BARS is terminal - ONLY show MAX_BARS, ignore TP exits
            partial_display = f"Max Bars: ${max_bars_pnl:.2f}"
            notes = "Max Bars Exit"
        elif tp_counts['SL'] > 0:
            # SL is terminal - ONLY show SL exits
            sl_breakdown = [item for item in tp_breakdown if item.startswith('SL:')]
            partial_display = " | ".join(sl_breakdown)
            notes = f"Stop Loss Hit ({tp_counts['SL']} exits)"
        else:
            # Normal partial exits (TPs only)
            partial_display = " | ".join(tp_breakdown) if tp_breakdown else "-"
            
            # Determine Notes based on exits hit
            if tp_counts['TP1'] > 0 and tp_counts['TP2'] > 0 and tp_counts['TP3'] > 0:
                notes = "ALL TP Exits"
            elif len(exits) > 1:
                hit_tps = [tp for tp, count in tp_counts.items() if count > 0 and tp not in ['SL', 'MAX_BARS']]
                notes = f"Partial Exits: {', '.join(hit_tps)}"
            else:
                notes = exits[0].get('notes', '')
        
        # Update aggregated trade
        base_trade['pnl'] = total_pnl
        base_trade['pnl_pct'] = total_pnl_pct
        base_trade['partial_exit_breakdown'] = partial_display
        base_trade['notes'] = notes
        
        # Use last exit's data for exit price, duration, status
        last_exit = exits[-1]
        base_trade['exit_price'] = last_exit.get('exit_price')
        base_trade['duration'] = last_exit.get('duration')
        base_trade['status'] = last_exit.get('status')
        
        return base_trade
    
    def _create_item(self, text: str) -> QTableWidgetItem:
        """Create centered table item"""
        item = QTableWidgetItem(text)
        item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
        return item
    
    def _update_metrics(self) -> None:
        """Update performance metrics and emit to Metrics Display Panel"""
        if not self.trades:
            return
        
        # Calculate metrics
        total_trades = len(self.trades)
        wins = len([t for t in self.trades if float(t.get('pnl', 0)) > 0])
        losses = len([t for t in self.trades if float(t.get('pnl', 0)) < 0])
        
        total_pnl = sum(float(t.get('pnl', 0)) for t in self.trades)
        win_rate = (wins / total_trades * 100) if total_trades > 0 else 0.0
        avg_trade = total_pnl / total_trades if total_trades > 0 else 0.0
        
        # Profit factor
        gross_profit = sum(float(t.get('pnl', 0)) for t in self.trades if float(t.get('pnl', 0)) > 0)
        gross_loss = abs(sum(float(t.get('pnl', 0)) for t in self.trades if float(t.get('pnl', 0)) < 0))
        profit_factor = gross_profit / gross_loss if gross_loss > 0 else 0.0
        
        # Sharpe ratio calculation (simplified)
        if losses > 0:
            avg_win = gross_profit / wins if wins > 0 else 0.0
            avg_loss = gross_loss / losses if losses > 0 else 0.0
            std_dev = ((avg_win ** 2 + avg_loss ** 2) / 2) ** 0.5 if (avg_win + avg_loss) > 0 else 1.0
            sharpe_ratio = (avg_trade / std_dev) if std_dev > 0 else 0.0
        else:
            sharpe_ratio = 0.0
        
        # Calculate max drawdown
        cumulative_pnl = 0.0
        peak = 0.0
        max_drawdown = 0.0
        
        for trade in self.trades:
            cumulative_pnl += float(trade.get('pnl', 0))
            if cumulative_pnl > peak:
                peak = cumulative_pnl
            drawdown = peak - cumulative_pnl
            if drawdown > max_drawdown:
                max_drawdown = drawdown
        
        # Calculate average win/loss
        avg_win = gross_profit / wins if wins > 0 else 0.0
        avg_loss = gross_loss / losses if losses > 0 else 0.0
        
        # Find largest win/loss
        all_pnls = [float(t.get('pnl', 0)) for t in self.trades]
        largest_win = max([p for p in all_pnls if p > 0], default=0.0)
        largest_loss = min([p for p in all_pnls if p < 0], default=0.0)
        
        # Risk/reward ratio (average)
        risk_reward_ratio = abs(avg_win / avg_loss) if avg_loss != 0 else 0.0
        
        # Recovery factor
        recovery_factor = total_pnl / max_drawdown if max_drawdown > 0 else 0.0
        
        # Update labels with color coding - consistent font size with other labels
        pnl_text = f"Total P&L: <b>${total_pnl:,.2f}</b>"
        if total_pnl > 0:
            self.pnl_label.setStyleSheet(f"color: {get_color('success')};")
        elif total_pnl < 0:
            self.pnl_label.setStyleSheet(f"color: {get_color('error')};")
        else:
            self.pnl_label.setStyleSheet(get_label_style())
        self.pnl_label.setText(pnl_text)
        
        # Count LONG and SHORT trades
        long_trades = len([t for t in self.trades if t.get('side') == 'LONG'])
        short_trades = len([t for t in self.trades if t.get('side') == 'SHORT'])
        
        # Update individual labels
        self.winrate_label.setText(f"Win Rate: <b>{win_rate:.2f}%</b>")
        self.long_trades_label.setText(f"Long Trades: <b>{long_trades}</b>")
        self.short_trades_label.setText(f"Short Trades: <b>{short_trades}</b>")
        self.winning_trades_label.setText(f"Winning Trades: <b>{wins}</b>")
        self.losing_trades_label.setText(f"Losing Trades: <b>{losses}</b>")
        
        # Update filter label
        self.filter_label.setText(f"Showing: <b>All Trades ({len(self.filtered_trades)})</b>")
        
        # Calculate additional risk metrics
        # Max drawdown %
        starting_capital = 10000.0  # Assuming $10k starting capital
        max_drawdown_pct = (max_drawdown / starting_capital) * 100 if starting_capital > 0 else 0.0
        
        # Drawdown duration (simplified - count trades in drawdown)
        drawdown_duration_days = 0  # Would need timestamp analysis for accurate calculation
        
        # Value at Risk (95%) - simplified using standard deviation
        if len(all_pnls) > 0:
            import numpy as np
            pnl_array = np.array(all_pnls)
            var_95 = np.percentile(pnl_array, 5) if len(pnl_array) > 0 else 0.0
            expected_shortfall = np.mean(pnl_array[pnl_array <= var_95]) if len(pnl_array[pnl_array <= var_95]) > 0 else 0.0
        else:
            var_95 = 0.0
            expected_shortfall = 0.0
        
        # Sortino Ratio (uses downside deviation instead of standard deviation)
        if losses > 0:
            losing_trades = [float(t.get('pnl', 0)) for t in self.trades if float(t.get('pnl', 0)) < 0]
            downside_deviation = (sum(p**2 for p in losing_trades) / len(losing_trades)) ** 0.5 if losing_trades else 1.0
            sortino_ratio = (avg_trade / downside_deviation) if downside_deviation > 0 else 0.0
        else:
            downside_deviation = 0.0
            sortino_ratio = 0.0
        
        # Calmar Ratio (return / max drawdown)
        calmar_ratio = (total_pnl / max_drawdown) if max_drawdown > 0 else 0.0
        
        # Consecutive wins/losses
        max_consecutive_wins = 0
        max_consecutive_losses = 0
        current_wins = 0
        current_losses = 0
        
        for trade in self.trades:
            if float(trade.get('pnl', 0)) > 0:
                current_wins += 1
                current_losses = 0
                max_consecutive_wins = max(max_consecutive_wins, current_wins)
            else:
                current_losses += 1
                current_wins = 0
                max_consecutive_losses = max(max_consecutive_losses, current_losses)
        
        # Average drawdown (average of all drawdown periods)
        avg_drawdown = max_drawdown / 2 if max_drawdown > 0 else 0.0  # Simplified
        
        # Standard deviation of returns
        if len(all_pnls) > 0:
            import numpy as np
            std_deviation = float(np.std(all_pnls))
        else:
            std_deviation = 0.0
        
        # Ulcer Index (measure of downside volatility)
        ulcer_index = (max_drawdown_pct / 100) if max_drawdown_pct > 0 else 0.0
        
        # 🔥 EMIT METRICS TO METRICS DISPLAY PANEL (real-time update)
        metrics_dict = {
            # Performance metrics
            'total_pnl': total_pnl,
            'total_return': (total_pnl / starting_capital) * 100,
            'sharpe_ratio': sharpe_ratio,
            'win_rate': win_rate,
            'profit_factor': profit_factor,
            'max_drawdown': max_drawdown,
            'total_trades': total_trades,
            'avg_trade_pnl': avg_trade,
            'avg_win': avg_win,
            'avg_loss': avg_loss,
            'largest_win': largest_win,
            'largest_loss': largest_loss,
            'risk_reward_ratio': risk_reward_ratio,
            'recovery_factor': recovery_factor,
            
            # Risk metrics
            'max_drawdown_pct': max_drawdown_pct,
            'max_drawdown_duration': drawdown_duration_days,
            'var_95': var_95,
            'expected_shortfall': expected_shortfall,
            'sortino_ratio': sortino_ratio,
            'calmar_ratio': calmar_ratio,
            'max_consecutive_losses': max_consecutive_losses,
            'max_consecutive_wins': max_consecutive_wins,
            'avg_drawdown': avg_drawdown,
            'std_deviation': std_deviation,
            'downside_deviation': downside_deviation,
            'ulcer_index': ulcer_index,
            
            # CRITICAL FIX: Include trades data for AI Recommendations Panel
            'trades': self.trades.copy()  # Include complete trades list
        }
        
        # 🔥 EMIT METRICS TO METRICS DISPLAY PANEL (via proper signal)
        self.metrics_updated.emit(metrics_dict)  # Dedicated signal for metrics updates
    
    def _on_selection_changed(self) -> None:
        """Handle row selection"""
        selected_rows = self.table.selectionModel().selectedRows()
        if selected_rows:
            row = selected_rows[0].row()
            if row < len(self.filtered_trades):
                self.trade_selected.emit(self.filtered_trades[row])
    
    def _copy_selection(self) -> None:
        """Copy selected trades to clipboard in CSV format"""
        from PyQt5.QtWidgets import QApplication
        
        # Get selected row indices
        selected_rows = self.table.selectionModel().selectedRows()
        if not selected_rows:
            self._console_print("⚠️ No trades selected - select rows with Ctrl+Click or Shift+Click")
            return
        
        try:
            # Get selected trade indices
            selected_indices = sorted([row.row() for row in selected_rows])
            selected_trades = [self.filtered_trades[i] for i in selected_indices]
            
            # Build CSV content
            lines = []
            # Header
            lines.append("ID\tTime\tSymbol\tSide\tSize\tEntry\tExit\tDuration\tP&L\tP&L %\tStatus\tNotes")
            
            # Data rows (only selected)
            for trade in selected_trades:
                timestamp = trade.get('timestamp', datetime.now())
                time_str = timestamp.strftime('%H:%M:%S') if isinstance(timestamp, datetime) else str(timestamp)
                
                lines.append(
                    f"{trade.get('id', '')}\t"
                    f"{time_str}\t"
                    f"{trade.get('symbol', '')}\t"
                    f"{trade.get('side', '')}\t"
                    f"{trade.get('size', '')}\t"
                    f"${float(trade.get('entry_price', 0)):,.2f}\t"
                    f"${float(trade.get('exit_price', 0)):,.2f}\t"
                    f"{trade.get('duration', '')}\t"
                    f"${float(trade.get('pnl', 0)):,.2f}\t"
                    f"{float(trade.get('pnl_pct', 0)):.2f}%\t"
                    f"{trade.get('status', '')}\t"
                    f"{trade.get('notes', '')}"
                )
            
            # Copy to clipboard
            csv_content = '\n'.join(lines)
            clipboard = QApplication.clipboard()
            clipboard.setText(csv_content)
            
            logger.info(f"✅ {len(selected_trades)} selected trades copied to clipboard")
            
        except Exception as e:
            logger.error(f"❌ Copy selection failed: {str(e)}")
    
    def _copy_trades(self) -> None:
        """Copy all trades to clipboard in CSV format"""
        from PyQt5.QtWidgets import QApplication
        
        if not self.trades:
            self._console_print("⚠️ No trades to copy")
            return
        
        try:
            # Build CSV content
            lines = []
            # Header
            lines.append("ID\tTime\tSymbol\tSide\tSize\tEntry\tExit\tDuration\tP&L\tP&L %\tStatus\tNotes")
            
            # Data rows
            for trade in self.trades:
                timestamp = trade.get('timestamp', datetime.now())
                time_str = timestamp.strftime('%H:%M:%S') if isinstance(timestamp, datetime) else str(timestamp)
                
                lines.append(
                    f"{trade.get('id', '')}\t"
                    f"{time_str}\t"
                    f"{trade.get('symbol', '')}\t"
                    f"{trade.get('side', '')}\t"
                    f"{trade.get('size', '')}\t"
                    f"${float(trade.get('entry_price', 0)):,.2f}\t"
                    f"${float(trade.get('exit_price', 0)):,.2f}\t"
                    f"{trade.get('duration', '')}\t"
                    f"${float(trade.get('pnl', 0)):,.2f}\t"
                    f"{float(trade.get('pnl_pct', 0)):.2f}%\t"
                    f"{trade.get('status', '')}\t"
                    f"{trade.get('notes', '')}"
                )
            
            # Copy to clipboard
            csv_content = '\n'.join(lines)
            clipboard = QApplication.clipboard()
            clipboard.setText(csv_content)
            
            logger.info(f"✅ {len(self.trades)} trades copied to clipboard")
            
        except Exception as e:
            logger.error(f"❌ Copy failed: {str(e)}")
    
    def _export_trades(self) -> None:
        """
        Export trades to CSV - READS FROM TRADEREGISTRY (single source of truth)
        
        CRITICAL FIX: Export from TradeRegistry, NOT from panel's list
        Panel list may contain duplicates from multicore worker messages.
        """
        from src.optimizer_v3.core.trade_registry import get_trade_registry
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        filename = f"trades_export_{timestamp}.csv"
        
        try:
            # Get unique trades from registry
            registry = get_trade_registry()
            unique_trades = registry.get_all_trades()
            
            if not unique_trades:
                logger.warning("⚠️ No trades in registry to export")
                return
            
            with open(filename, 'w') as f:
                # Write header - INSTITUTIONAL GRADE: Added Exit Time for precise verification
                f.write("ID,Time,Symbol,Side,Size,Entry,Exit,Exit Time,Duration,P&L,P&L %,Status,Notes\n")

                # Write trades from registry (guaranteed unique)
                for trade in unique_trades:
                    f.write(
                        f"{trade.get('trade_id', trade.get('id', ''))},"
                        f"{trade.get('entry_timestamp', trade.get('timestamp', ''))},"
                        f"BTC.P/USDT,"
                        f"{trade.get('side', '')},"
                        f"0.1,"
                        f"{trade.get('entry_price', '')},"
                        f"{trade.get('exit_price', '')},"
                        f"{trade.get('exit_timestamp', '')},"  # ✅ INSTITUTIONAL FIX: Exact exit timestamp
                        f"{self._format_duration(trade)},"
                        f"{trade.get('pnl', '')},"
                        f"{trade.get('pnl_pct', '')},"
                        f"{trade.get('status', '')},"
                        f"{self._format_notes(trade)}\n"
                    )
            
            logger.info(f"✅ {len(unique_trades)} unique trades exported to {filename} (from TradeRegistry)")
            
        except Exception as e:
            logger.error(f"❌ Export failed: {str(e)}")
    
    def _format_duration(self, trade: Dict) -> str:
        """Format trade duration from bars_held"""
        bars_held = trade.get('bars_held', 0)
        if bars_held == 0:
            return '-'
        
        # Assuming 15m timeframe
        total_minutes = bars_held * 15
        
        if total_minutes < 60:
            return f"{total_minutes}m"
        elif total_minutes < 1440:  # Less than 1 day
            hours = total_minutes // 60
            mins = total_minutes % 60
            return f"{hours}h {mins}m" if mins > 0 else f"{hours}h"
        else:  # 1 day or more
            days = total_minutes // 1440
            hours = (total_minutes % 1440) // 60
            return f"{days}d {hours}h" if hours > 0 else f"{days}d"
    
    def _format_notes(self, trade: Dict) -> str:
        """Format trade notes from exit_condition_name and exit_reason"""
        exit_cond = trade.get('exit_condition_name', '')
        exit_reason = trade.get('exit_reason', '')
        
        if exit_cond in ['TP1', 'TP2', 'TP3']:
            return f"{exit_cond} Hit"
        elif exit_cond == 'SL':
            return "Stop Loss Hit"
        elif exit_cond == 'MAX_BARS':
            return f"Max Hold Time ({trade.get('bars_held', 0)} bars)"
        elif exit_reason:
            return exit_reason
        return '-'
    
    def get_trades(self) -> List[Dict]:
        """Get all trades"""
        return self.trades.copy()
    
    def get_metrics(self) -> Dict:
        """Get current performance metrics"""
        if not self.trades:
            return {
                'total_pnl': 0.0,
                'win_rate': 0.0,
                'total_trades': 0,
                'avg_trade': 0.0,
                'profit_factor': 0.0
            }
        
        total_trades = len(self.trades)
        wins = len([t for t in self.trades if float(t.get('pnl', 0)) > 0])
        total_pnl = sum(float(t.get('pnl', 0)) for t in self.trades)
        win_rate = (wins / total_trades * 100) if total_trades > 0 else 0.0
        avg_trade = total_pnl / total_trades if total_trades > 0 else 0.0
        
        gross_profit = sum(float(t.get('pnl', 0)) for t in self.trades if float(t.get('pnl', 0)) > 0)
        gross_loss = abs(sum(float(t.get('pnl', 0)) for t in self.trades if float(t.get('pnl', 0)) < 0))
        profit_factor = gross_profit / gross_loss if gross_loss > 0 else 0.0
        
        return {
            'total_pnl': total_pnl,
            'win_rate': win_rate,
            'total_trades': total_trades,
            'avg_trade': avg_trade,
            'profit_factor': profit_factor
        }
