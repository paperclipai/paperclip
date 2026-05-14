"""
Backtest Configuration Panel - Strategy Builder UI Component

Comprehensive backtest configuration with:
- Lookback days and training window control
- Mode 1 (historical) / Mode 2 (live replay) selection
- TP/SL configuration integration
- Live progress tracking with candle/trade counters
- TP/SL adjustment tracking (per type)
- Pause/Resume/Stop controls
- **Automatic signal calibration** before every backtest run

NAUTILUS EXPERT: Institutional-grade backtest execution with real-time monitoring

## Tab structure (BacktestConfigDialog — 6 tabs)
1. 💠 Config        — configure backtest parameters and launch the run
2. ● Live Output    — real-time execution log
3. 💰 Trades        — live trade table
4. 💹 Metrics       — performance analysis
5. 🤖 AI Recommendations — AI request preview and send
6. 🔁 Compare       — side-by-side configuration comparison

The dedicated "⚙️ Calibrate" tab was removed in sprint BTCAAAAA-338.
Calibration now runs automatically when "▶️ Run Test" is clicked (see
``_run_auto_calibration`` and ``_on_run_clicked``).

Author: Strategy Builder Team
Date: 2026-01-17
"""

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from decimal import Decimal, DecimalException
from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QSpinBox, QDoubleSpinBox,
    QRadioButton, QButtonGroup, QComboBox, QProgressBar,
    QPushButton, QGroupBox, QTextEdit, QTabWidget, QCheckBox,
    QLineEdit, QApplication, QMessageBox, QProgressDialog
)
from PyQt5.QtCore import Qt, QThread, pyqtSignal
from PyQt5.QtGui import QFont, QColor

# NautilusTrader types for institutional-grade money handling
from nautilus_trader.model.objects import Money, Currency

# Import centralized styles
from src.strategy_builder.ui.styles import (
    MAIN_STYLESHEET,
    get_label_style,
    get_radio_button_style,
    get_checkbox_style,
    get_primary_button_stylesheet,
    get_tab_widget_stylesheet,
    get_spinbox_button_stylesheet,
    get_panel_title_stylesheet,
    get_groupbox_header_stylesheet,
    get_preset_day_button_stylesheet,
    get_separator_stylesheet,
    get_input_field_stylesheet,
    get_status_label_style,
    create_font,
    get_color
)
# Import universal combo box fix
from src.strategy_builder.ui.combobox_fix import fix_combobox_white_bars

# Sprint 2.0.1 Task 2.0.1.3: Real data integration
from src.optimizer_v3.core.backtest_data_provider import get_backtest_provider

import logging
logger = logging.getLogger(__name__)

from src.optimizer_v3.database import calibration_cache

class StdoutCapture:
    """
    Captures stdout (print) output and emits via Qt signal.
    
    Used to redirect terminal output from DataManager/NautilusLoader
    into the Status panel during backtest execution.
    """
    
    def __init__(self, signal, original_stdout):
        self.signal = signal
        self.original_stdout = original_stdout
        self._buffer = ""
    
    def write(self, text):
        """Capture written text and emit via signal"""
        # Always write to original stdout (terminal still shows output)
        self.original_stdout.write(text)
        
        # Buffer partial lines, emit complete lines
        self._buffer += text
        while "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)
            line = line.rstrip()
            if line:  # Skip empty lines
                self.signal.emit(line)
    
    def flush(self):
        """Flush remaining buffer"""
        self.original_stdout.flush()
        if self._buffer.strip():
            self.signal.emit(self._buffer.strip())
            self._buffer = ""


class QtLogHandler(logging.Handler):
    """
    Python logging handler that emits log records via a Qt signal.

    Installed temporarily during BacktestWorker.run() so that
    logger.info() / logger.warning() calls inside NautilusDataLoader,
    UnifiedDataManager, and BarAggregator reach the Status panel in the
    same way as print() output captured by StdoutCapture.

    Only INFO and above are forwarded (DEBUG is too noisy).
    The handler is installed on specific logger names to avoid routing
    unrelated application logs into the Status panel.
    """

    # Loggers whose output should be routed to the Status panel
    TARGET_LOGGERS = [
        'src.data_manager.nautilus_loader',
        'src.data_manager.unified_manager',
        'src.optimizer_v3.core.backtest_data_provider',
    ]

    def __init__(self, signal):
        super().__init__(level=logging.INFO)
        self.signal = signal
        self._installed_on: list = []

    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = self.format(record)
            self.signal.emit(msg)
        except Exception:
            self.handleError(record)

    def install(self) -> None:
        """Attach this handler to each target logger."""
        formatter = logging.Formatter('%(message)s')
        self.setFormatter(formatter)
        for name in self.TARGET_LOGGERS:
            log = logging.getLogger(name)
            log.addHandler(self)
            self._installed_on.append(log)

    def uninstall(self) -> None:
        """Remove this handler from all loggers it was added to."""
        for log in self._installed_on:
            log.removeHandler(self)
        self._installed_on.clear()


class DictWrapper:
    """
    Lightweight wrapper to provide attribute access to Dict objects
    
    Sprint 2.0.2: Database returns Dict, but InstitutionalSignalEvaluator expects object attributes.
    This wrapper allows Dict['key'] to be accessed as obj.key transparently.
    
    Handles nested dicts and lists of dicts automatically.
    """
    
    def __init__(self, data):
        """
        Initialize wrapper with dict data
        
        Args:
            data: Dict or any value to wrap
        """
        self._data = data
    
    def __getattr__(self, name):
        """Provide attribute access to dict keys"""
        if isinstance(self._data, dict):
            value = self._data.get(name)
            # Recursively wrap dicts
            if isinstance(value, dict):
                return DictWrapper(value)
            # Wrap lists of dicts
            elif isinstance(value, list):
                return [DictWrapper(item) if isinstance(item, dict) else item for item in value]
            return value
        return None
    
    def keys(self):
        if isinstance(self._data, dict):
            return self._data.keys()
        return []

    def __getitem__(self, key):
        if isinstance(self._data, dict):
            return self._data[key]
        raise KeyError(key)

    def __iter__(self):
        if isinstance(self._data, dict):
            return iter(self._data)
        return iter([])

    def __len__(self):
        if isinstance(self._data, dict):
            return len(self._data)
        return 0

    def items(self):
        if isinstance(self._data, dict):
            return self._data.items()
        return []

    def values(self):
        if isinstance(self._data, dict):
            return self._data.values()
        return []

    def __repr__(self):
        return f"DictWrapper({self._data})"


class BacktestWorker(QThread):
    """Worker thread for running backtests without blocking UI"""
    
    # Signals
    progress_updated = pyqtSignal(int, int, str)  # current, total, message
    backtest_finished = pyqtSignal(bool, dict)  # success, results
    live_message = pyqtSignal(str, str, str)  # message, level, category - NEW for real-time messages
    trade_data_emit = pyqtSignal(dict)  # Emits trade data (OPEN initially, then updates when CLOSED)
    status_message = pyqtSignal(str)  # Captured stdout for Status panel
    
    def __init__(
        self, 
        strategy_config: dict, 
        backtest_config: dict, 
        output_panel=None,
        trades_panel=None,  # MULTICORE FIX: Need reference for direct trade addition
        cached_bars=None  # PHASE 1: Support pre-loaded bars
    ):
        """
        Initialize backtest worker with PRE-SERIALIZED config
        
        INSTITUTIONAL PATTERN: Database Isolation
        - No orchestrator reference (prevents database access)
        - Strategy config is plain Dict (no ORM objects)
        - All data pre-loaded before worker creation
        
        PHASE 1 ENHANCEMENT: Data Caching
        - Accepts optional pre-loaded bars for performance
        - Skips data loading if bars provided (massive speedup for testing)
        - Maintains backward compatibility (cached_bars=None)
        
        Args:
            strategy_config: Serialized strategy configuration (from orchestrator)
            backtest_config: Backtest parameters (lookback, mode, etc.)
            output_panel: Optional reference to live output panel
            trades_panel: Optional reference to trades panel (for multicore)
            cached_bars: Optional pre-loaded bars (Phase 1 optimization)
        """
        super().__init__()
        self.strategy_config = strategy_config  # Plain Dict, no database
        self.config = backtest_config
        self.is_paused = False
        self.should_stop = False
        self.output_panel = output_panel
        self.trades_panel = trades_panel  # MULTICORE FIX: Store reference
        self.timeframe = backtest_config.get('timeframe', '15m')
        
        # PHASE 1: Store cached bars (None if not provided)
        self.cached_bars = cached_bars
        
        # PHASE 2: Multicore engine flag (default: enabled for performance)
        self.use_multicore = backtest_config.get('use_multicore', True)
        
        # Sprint 2.0.1 Task 2.0.1.3: Data provider for real bar loading
        self.data_provider = get_backtest_provider()
        
        # Sprint 2.0.2 Task 2.0.2.7: Signal evaluator for institutional-grade trade decisions
        self.signal_evaluator = None
        
        # PHASE 2: Multicore backtest engine (instantiated on demand)
        self.multicore_engine = None
    
    def _bars_to_duration(self, num_bars: int) -> str:
        """
        Convert bar count to human-readable time duration.
        
        Args:
            num_bars: Number of bars held
        
        Returns:
            Time duration string (e.g., "5m", "1h 30m", "2d 4h")
        """
        if num_bars <= 0:
            return "0m"
        
        # Parse timeframe
        timeframe = self.timeframe
        if timeframe.endswith('m'):
            minutes_per_bar = int(timeframe[:-1])
            total_minutes = num_bars * minutes_per_bar
        elif timeframe.endswith('h'):
            hours_per_bar = int(timeframe[:-1])
            total_minutes = num_bars * hours_per_bar * 60
        elif timeframe.endswith('d'):
            days_per_bar = int(timeframe[:-1])
            total_minutes = num_bars * days_per_bar * 1440
        else:
            # Fallback if unknown format
            return f"{num_bars} bars"
        
        # Format as human-readable
        if total_minutes < 60:
            return f"{total_minutes}m"
        elif total_minutes < 1440:  # Less than 1 day
            hours = total_minutes // 60
            mins = total_minutes % 60
            if mins > 0:
                return f"{hours}h {mins}m"
            return f"{hours}h"
        else:  # 1 day or more
            days = total_minutes // 1440
            hours = (total_minutes % 1440) // 60
            if hours > 0:
                return f"{days}d {hours}h"
            return f"{days}d"
    
    def run(self):
        """Run backtest in background thread with LIVE message streaming"""
        try:
            import sys
            
            # Track TP/SL adjustments (REAL tracking, not hardcoded)
            tp_sl_adjustments = {'TP1': 0, 'TP2': 0, 'TP3': 0, 'SL': 0}
            
            # ========== LOG ALL BACKTEST CONFIGURATION (FIRST THING!) ==========
            self.live_message.emit("=" * 80, "INFO", "SYSTEM")
            self.live_message.emit("BACKTEST CONFIGURATION", "INFO", "SYSTEM")
            self.live_message.emit("=" * 80, "INFO", "SYSTEM")
            
            # Capital & Risk Settings
            self.live_message.emit(f"💰 Starting Capital: ${self.config['starting_capital']:,} USD", "INFO", "SYSTEM")
            self.live_message.emit(f"   Risk per Trade: {self.config['risk_per_trade_pct']}% of capital", "INFO", "SYSTEM")
            self.live_message.emit(f"   Min Risk:Reward Ratio: {self.config['min_risk_reward']}:1", "INFO", "SYSTEM")
            self.live_message.emit(f"   Max Leverage: {self.config['max_leverage']}x", "INFO", "SYSTEM")
            self.live_message.emit(f"   Max Bars Held: {self.config['max_bars_held']} bars", "INFO", "SYSTEM")
            self.live_message.emit("", "INFO", "SYSTEM")
            
            # Signal & Strategy Settings
            self.live_message.emit(f"🎯 Confluence Threshold: {self.config['confluence_threshold']} points", "INFO", "SYSTEM")
            self.live_message.emit("", "INFO", "SYSTEM")
            
            # TP/SL Configuration
            self.live_message.emit(f"📊 TP/SL Configuration:", "INFO", "SYSTEM")
            self.live_message.emit(f"   Initial TP/SL Mode: {self.config['tpsl_mode']}", "INFO", "SYSTEM")
            self.live_message.emit(f"   SL Adjustment Mode: {self.config['sl_mode']}", "INFO", "SYSTEM")
            
            # Adaptive SL v2.0 Details
            if self.config['adaptive_sl']['enabled']:
                asl = self.config['adaptive_sl']
                self.live_message.emit("", "INFO", "SYSTEM")
                self.live_message.emit(f"🔧 Adaptive SL v2.0: ENABLED", "INFO", "SYSTEM")
                self.live_message.emit(f"   Delay Enabled: {asl['delay_enabled']}", "INFO", "SYSTEM")
                if asl['delay_enabled']:
                    self.live_message.emit(f"   → Delay Period: {asl['delay_bars']} bars", "INFO", "SYSTEM")
                    self.live_message.emit(f"   → Emergency SL: {asl['emergency_sl_pct']}% (during delay)", "INFO", "SYSTEM")
                self.live_message.emit(f"   Volatility Analysis:", "INFO", "SYSTEM")
                self.live_message.emit(f"   → Lookback: {asl['volatility_lookback']} bars", "INFO", "SYSTEM")
                self.live_message.emit(f"   → Multiplier: {asl['volatility_multiplier']}x ATR", "INFO", "SYSTEM")
                self.live_message.emit(f"   SL Range: {asl['min_sl_pct']}% to {asl['max_sl_pct']}%", "INFO", "SYSTEM")
                self.live_message.emit(f"   Market Structure SL: {asl['use_structure_sl']}", "INFO", "SYSTEM")
                if asl['use_structure_sl']:
                    sources = ', '.join(asl['structure_sources'])
                    self.live_message.emit(f"   → Sources: {sources}", "INFO", "SYSTEM")
            else:
                self.live_message.emit(f"   Adaptive SL: DISABLED (Static SL)", "INFO", "SYSTEM")
            
            self.live_message.emit("=" * 80, "INFO", "SYSTEM")
            self.live_message.emit("", "INFO", "SYSTEM")
            
            # Continue with backtest
            trade_count = 0
            
            # PHASE 1.2: Use cached bars if provided, otherwise load from data manager
            if self.cached_bars is not None:
                # FAST PATH: Use pre-loaded bars (MASSIVE speedup for testing!)
                bars = self.cached_bars
                self.live_message.emit(
                    f"✅ Using cached data: {len(bars):,} bars (fast path)",
                    "INFO",
                    "SYSTEM"
                )
                self.live_message.emit(
                    "⚡ Skipped data loading - saved ~10 seconds!",
                    "INFO",
                    "SYSTEM"
                )
            else:
                # NORMAL PATH: Load bars from data manager
                self.live_message.emit("Loading real historical data from DataManager...", "INFO", "SYSTEM")
                
                # CAPTURE STDOUT: Redirect print() output to Status panel
                # DataManager/NautilusLoader/BarAggregator use print() for progress
                original_stdout = sys.stdout
                stdout_capture = StdoutCapture(self.status_message, original_stdout)
                sys.stdout = stdout_capture

                # CAPTURE LOGGER: Route logger.info() calls from NautilusDataLoader,
                # UnifiedDataManager, and BacktestDataProvider to the Status panel.
                # These loaders use Python's logging module, not print(), so StdoutCapture
                # alone does not capture them.
                import logging as _logging
                qt_log_handler = QtLogHandler(self.status_message)
                qt_log_handler.install()
                
                try:
                    # Load bars using data provider with progress callback
                    bars = self.data_provider.load_bars_for_backtest(
                        timeframe=self.config['timeframe'],
                        start_date=self.config['start_date'],
                        end_date=self.config['end_date'],
                        progress_callback=self._on_data_load_progress
                    )
                    
                    # INSTITUTIONAL OPTIMIZATION: Cache the loaded bars for future use
                    from src.optimizer_v3.core.data_cache_manager import get_data_cache_manager
                    cache_manager = get_data_cache_manager()
                    cache_manager.cache_bars(bars, self.config)  # FIXED: Correct parameter order
                    self.live_message.emit(
                        f"💾 Cached {len(bars):,} bars for future reuse",
                        "INFO",
                        "SYSTEM"
                    )
                finally:
                    # ALWAYS restore stdout and logger handler (even on error)
                    stdout_capture.flush()
                    sys.stdout = original_stdout
                    qt_log_handler.uninstall()
            
            # Sprint 2.0.1 Task 2.0.1.4: Use REAL count from loaded bars
            total_candles = len(bars)
            
            # CRITICAL: Initialize progress bar with actual total
            self.progress_updated.emit(0, total_candles, f"Loaded {total_candles:,} bars, starting backtest...")
            
            self.live_message.emit(
                f"✅ Loaded {total_candles:,} real 15m bars from DataManager",
                "INFO",
                "SYSTEM"
            )
            self.msleep(200)
            
            # Sprint 2.0.2 Task 2.0.2.7: Initialize institutional signal evaluator
            self.live_message.emit("Initializing institutional signal evaluator...", "INFO", "SYSTEM")

            # INSTITUTIONAL PATTERN: Use pre-loaded config (NO DATABASE ACCESS!)
            strategy_config = self.strategy_config
            if not strategy_config:
                raise ValueError("No strategy config provided - internal error")

            # Handle Dict from serialized config
            strategy_name = strategy_config.get('name', 'Unknown')
            blocks = strategy_config.get('blocks', [])
            blocks_count = len(blocks)
            signals_count = sum(len(b.get('signals', [])) for b in blocks)
            
            self.live_message.emit(f"✅ Strategy loaded: {strategy_name} ({blocks_count} blocks, {signals_count} signals)", "INFO", "SYSTEM")

            # Wrap Dict to provide attribute access for evaluator
            strategy_config_wrapped = DictWrapper(strategy_config)

            # Initialize evaluator with strategy
            from src.optimizer_v3.core.institutional_signal_evaluator import InstitutionalSignalEvaluator
            evaluator = InstitutionalSignalEvaluator(strategy_config_wrapped)

            self.live_message.emit("✅ Signal evaluator initialized with strategy configuration", "INFO", "SYSTEM")
            self.live_message.emit("Risk management initialized: Max position size = 0.1 BTC", "INFO", "RISK")
            self.live_message.emit("Signal detection active: Multi-level RECHECK, Sequential TIMING, 3-tier EXIT", "INFO", "SIGNAL")
            self.msleep(100)
            
            # REAL SIGNAL-DRIVEN BACKTESTING (Sprint 2.0.2)
            # Replace hardcoded schedule with real signal evaluation
            
            # Determine trade side once (used for both entry and TP/SL hit detection)
            side = 'SHORT' if strategy_config.get('strategy_type') == 'Bearish' else 'LONG'
            
            # Initialize Adaptive SL Manager (if enabled)
            adaptive_sl_manager = None
            if self.config['adaptive_sl']['enabled']:
                from src.optimizer_v3.core.adaptive_sl_manager import get_adaptive_sl_manager
                adaptive_sl_manager = get_adaptive_sl_manager()
            
            # MODE 2 (Live Replay): Override use_multicore to force bar-by-bar sequential path.
            # Mode 2 spec: "Feeds data bar-by-bar as if live" — multicore processes all bars
            # in parallel chunks which breaks the sequential "only sees past data" guarantee.
            # Mode 1 (Historical): can use multicore for speed.
            # Mode 2 (Live Replay): always single-core to maintain strict temporal ordering.
            mode = self.config.get('mode', 1)
            if mode == 2:
                self.use_multicore = False
                self.live_message.emit(
                    "🔄 Mode 2 (Live Replay): Switching to bar-by-bar sequential execution",
                    "INFO",
                    "SYSTEM"
                )

            # PHASE 2: MULTICORE vs SINGLE-CORE ROUTING
            if self.use_multicore:
                # ========== MULTICORE PATH: Parallel Processing ==========
                self.live_message.emit("🚀 Using multicore backtest engine", "INFO", "SYSTEM")
                
                from src.optimizer_v3.core.multicore_backtest_engine import MulticoreBacktestEngine
                engine = MulticoreBacktestEngine()  # Auto-detects CPUs
                
                self.live_message.emit(
                    f"Detected {engine.num_processes} CPUs for parallel processing",
                    "INFO",
                    "SYSTEM"
                )
                
                # CRITICAL FIX 2026-02-13: Pass COMPLETE config to multicore engine
                # Previous bug: Only passed 3 keys, lost adaptive_sl + all risk parameters
                mc_config = self.config.copy()  # ← Pass ALL 23+ parameters!
                mc_config['strategy_type'] = strategy_config.get('strategy_type', 'Bullish')
                
                # VALIDATION LOGGING: Verify config completeness AND VALUES
                import logging
                from pathlib import Path
                Path("logs/wiring-test").mkdir(parents=True, exist_ok=True)
                mc_logger = logging.getLogger('multicore_config')
                if not mc_logger.handlers:
                    mc_logger.setLevel(logging.INFO)
                    fh = logging.FileHandler('logs/wiring-test/multicore_config.log')
                    fh.setFormatter(logging.Formatter('[%(asctime)s] %(message)s'))
                    mc_logger.addHandler(fh)

                # Log ACTUAL VALUES (not just counts!)
                asl = mc_config.get('adaptive_sl', {})
                mc_logger.info(f"=== BACKTEST CONFIG ===")
                mc_logger.info(f"Vol Lookback: {asl.get('volatility_lookback')}, Vol Multi: {asl.get('volatility_multiplier')}")
                mc_logger.info(f"Delay Bars: {asl.get('delay_bars')}, Emergency SL: {asl.get('emergency_sl_pct')}%")
                mc_logger.info(f"Min SL: {asl.get('min_sl_pct')}, Max SL: {asl.get('max_sl_pct')}")
                
                # Run multicore backtest
                mc_results = engine.run_backtest(
                    bars=bars,
                    strategy_config=strategy_config,
                    backtest_config=mc_config,
                    progress_callback=lambda curr, total, msg: self.progress_updated.emit(curr, total, msg)
                )
                
                # Process multicore results
                trades_list = mc_results.get('trades', [])
                trade_count = len(trades_list)
                
                self.live_message.emit(
                    f"✅ Multicore backtest complete: {trade_count} trades found",
                    "INFO",
                    "SYSTEM"
                )
                
                # CRITICAL: Emit ALL collected messages from subprocesses (matches single-core!)
                # Subprocesses collected messages as dicts, now emit them in main thread
                all_messages = mc_results.get('messages', [])
                if all_messages:
                    self.live_message.emit("", "INFO", "SYSTEM")
                    self.live_message.emit("📋 Trade Details (from parallel processing):", "INFO", "SYSTEM")
                    for msg in all_messages:
                        self.live_message.emit(msg['text'], msg['level'], msg['category'])
                
                # CRITICAL: Emit each trade to the UI
                # MULTICORE NOTE: Trades are already CLOSED (never emitted as OPEN)
                # Must use signal (thread-safe), NOT direct widget access (deadlocks!)
                for trade in trades_list:
                    # Convert multicore trade format to UI format
                    # CRITICAL FIX: Use sequential trade_id (not entry_bar!)
                    trade_data = {
                        'id': str(trade.get('trade_id', trade.get('entry_bar', 0))),  # Sequential ID
                        'timestamp': trade.get('entry_timestamp'),
                        'symbol': 'BTC.P/USDT',
                        'side': trade.get('side', side),
                        'size': 0.1,
                        'entry_price': trade.get('entry_price', 0),
                        'exit_price': trade.get('exit_price', 0),
                        'duration': self._bars_to_duration(trade.get('bars_held', 0)),
                        'pnl': trade.get('pnl', 0),
                        'pnl_pct': trade.get('pnl_pct', 0),
                        'status': 'CLOSED',
                        'notes': trade.get('exit_reason', 'Trade closed'),
                        'exit_type': trade.get('exit_type'),
                        'exit_condition_name': trade.get('exit_condition_name'),
                        'partial_exit_percentage': None
                    }
                    
                    # Emit via signal (thread-safe) - handler adds to trades panel
                    self.trade_data_emit.emit(trade_data)
                
                self.live_message.emit(
                    f"✅ Emitted all {trade_count} trades to UI",
                    "INFO",
                    "SYSTEM"
                )
                
                # CRITICAL FIX: Emit summary performance metrics (since subprocess can't emit detailed messages)
                if trade_count > 0:
                    winning_trades = sum(1 for t in trades_list if t.get('pnl', 0) > 0)
                    win_rate = (winning_trades / trade_count) * 100
                    total_pnl = sum(t.get('pnl', 0) for t in trades_list)
                    
                    self.live_message.emit("", "INFO", "SYSTEM")
                    self.live_message.emit("📊 Performance Summary:", "INFO", "OPTIMIZER")
                    self.live_message.emit(
                        f"   {trade_count} trades, Win Rate: {win_rate:.1f}%, Total PnL: ${total_pnl:.2f}",
                        "INFO",
                        "OPTIMIZER"
                    )
                    
                    # Show sample trades
                    self.live_message.emit("", "INFO", "SYSTEM")
                    self.live_message.emit("📋 Sample Trades (first 5):", "INFO", "TRADE")
                    for i, trade in enumerate(trades_list[:5], 1):
                        status = "WIN" if trade.get('pnl', 0) > 0 else "LOSS"
                        self.live_message.emit(
                            f"   Trade #{i}: {status} - Entry ${trade.get('entry_price', 0):.2f}, "
                            f"Exit ${trade.get('exit_price', 0):.2f}, "
                            f"PnL: ${trade.get('pnl', 0):.2f} ({trade.get('pnl_pct', 0):.2f}%)",
                            "ACTION" if trade.get('pnl', 0) > 0 else "WARNING",
                            "TRADE"
                        )
                
                # Emit final progress
                self.progress_updated.emit(total_candles, total_candles, f"Multicore complete: {trade_count} trades")
                
                # Calculate results
                results = {
                    'total_candles': total_candles,
                    'trades': trade_count,
                    'trades_list': trades_list,  # PHASE 1.1: Full per-trade data for discovery metrics
                    'tp_adjustments': mc_results.get('tp_adjustments', {'TP1': 0, 'TP2': 0, 'TP3': 0, 'SL': 0}),  # From multicore engine
                    'sl_adjustments': mc_results.get('sl_adjustments', 0)
                }
                
                self.live_message.emit(
                    f"✅ Backtest completed successfully! {trade_count} trades executed.",
                    "INFO",
                    "SYSTEM"
                )
                
                self.backtest_finished.emit(True, results)
                return
            
            # ========== SINGLE-CORE PATH: Sequential Processing ==========
            if mode == 2:
                self.live_message.emit(
                    "🔄 Mode 2 (Live Replay): Bar-by-bar sequential execution — simulating real-time feed",
                    "INFO",
                    "SYSTEM"
                )
                # Small per-bar delay (ms) to pace the replay and surface each candle
                # in the progress bar clearly. Kept short (1 ms) to avoid making runs
                # impractically slow while still guaranteeing sequential order and giving
                # the UI event loop time to process signals.
                mode2_bar_delay_ms = 1
            else:
                self.live_message.emit("Using single-core backtest engine", "INFO", "SYSTEM")
                mode2_bar_delay_ms = 0
            
            for i in range(total_candles):  # Process bar-by-bar
                if self.should_stop:
                    self.live_message.emit("Backtest stopped by user", "WARNING", "SYSTEM")
                    self.backtest_finished.emit(False, {'error': 'Stopped by user'})
                    return
                
                # Wait while paused
                while self.is_paused and not self.should_stop:
                    self.msleep(100)
                
                # Mode 2: pace replay with a small inter-bar delay
                if mode2_bar_delay_ms > 0:
                    self.msleep(mode2_bar_delay_ms)
                
                # Get current bar and lookback window
                current_bar = bars[i]
                # CRITICAL FIX: Pass ALL available historical data, not just 100 bars
                # Building blocks need sufficient history (50-200 bars minimum)
                # User configured 180 day lookback = ~17,280 bars for 15min timeframe
                lookback_bars = bars[0:i]  # ALL bars from start to current

                # Evaluate signals for current bar (REAL signal-driven!)
                result = evaluator.evaluate_bar(current_bar, i, lookback_bars, total_candles)
                
                # ENTRY DECISION (REAL signal-driven!)
                if result.should_enter and not evaluator.current_trade:
                    trade_count += 1
                    
                    # Emit live messages (side already determined above)
                    self.live_message.emit(
                        f"Entry #{trade_count}: Confluence {result.confluence_score} pts, signals: {', '.join(result.signals_fired[:3])}",
                        "DECISION",
                        "SIGNAL"
                    )
                    self.live_message.emit(
                        f"Risk: Position size 0.1 BTC, max loss $100",
                        "INFO",
                        "RISK"
                    )
                    
                    # Create trade with real data
                    from datetime import datetime, timezone as _tz
                    entry_price = float(current_bar.close)
                    entry_timestamp = datetime.fromtimestamp(current_bar.ts_init / 1e9, tz=_tz.utc).replace(tzinfo=None)
                    
                    # Enter trade via evaluator
                    evaluator.enter_trade(current_bar, i, side)
                    
                    # CRITICAL: Store entry_timestamp in current_trade (TradeState doesn't have it by default)
                    evaluator.current_trade.entry_timestamp = entry_timestamp

                    # CRITICAL FIX: Calculate TP/SL levels on entry (Issue #5)
                    from src.optimizer_v3.core.tpsl_calculator import get_tpsl_calculator
                    tpsl_calc = get_tpsl_calculator()
                    
                    tpsl_mode = self.config.get('tpsl_mode', 'Fibonacci')
                    tpsl_levels = tpsl_calc.calculate_levels(
                        entry_price=entry_price,
                        mode=tpsl_mode,
                        lookback_bars=lookback_bars,
                        config=self.config,
                        entry_side=side
                    )
                    
                    # Store TP/SL levels in evaluator's current_trade
                    evaluator.current_trade.tpsl_levels = tpsl_levels
                    evaluator.current_trade.initial_sl = tpsl_levels.stop_loss  # Track initial for comparison
                    
                    # Log TP/SL levels for transparency with MODE and R:R
                    self.live_message.emit(
                        f"TP/SL Mode: {tpsl_mode} | R:R= {tpsl_levels.risk_reward_ratio:.2f}:1",
                        "INFO",
                        "RISK"
                    )
                    self.live_message.emit(
                        f"  Entry: ${entry_price:.2f} | SL: ${tpsl_levels.stop_loss:.2f} (Risk: ${abs(entry_price - tpsl_levels.stop_loss):.2f})",
                        "INFO",
                        "RISK"
                    )
                    self.live_message.emit(
                        f"  TP1: ${tpsl_levels.take_profit_1:.2f} | TP2: ${tpsl_levels.take_profit_2:.2f} | TP3: ${tpsl_levels.take_profit_3:.2f}",
                        "INFO",
                        "RISK"
                    )

                    # Emit trade as OPEN
                    open_trade_data = {
                        'id': str(trade_count),
                        'timestamp': entry_timestamp,
                        'symbol': 'BTC.P/USDT',
                        'side': side,
                        'size': 0.1,
                        'entry_price': entry_price,
                        'exit_price': None,
                        'duration': '-',
                        'pnl': 0.0,
                        'pnl_pct': 0.0,
                        'status': 'OPEN',
                        'notes': f'Signal-driven entry #{trade_count}',
                        'exit_type': None,
                        'exit_condition_name': None,
                        'partial_exit_percentage': None
                    }
                    self.trade_data_emit.emit(open_trade_data)
                
                # ADAPTIVE SL UPDATE: Adjust SL every bar (if enabled and trade is open)
                if adaptive_sl_manager and evaluator.current_trade and hasattr(evaluator.current_trade, 'tpsl_levels'):
                    bars_since_entry = i - evaluator.current_trade.entry_bar
                    
                    # Call Adaptive SL manager
                    sl_result = adaptive_sl_manager.update_sl(
                        position_entry_price=float(evaluator.current_trade.entry_price),
                        current_bar=current_bar,
                        bars_since_entry=bars_since_entry,
                        lookback_bars=lookback_bars[-self.config['adaptive_sl']['volatility_lookback']:] if len(lookback_bars) > 0 else [],
                        config=self.config['adaptive_sl'],
                        entry_side=side
                    )
                    
                    # Check if SL changed
                    old_sl = evaluator.current_trade.tpsl_levels.stop_loss
                    new_sl = sl_result.new_sl
                    
                    if abs(new_sl - old_sl) > 0.01:  # Changed by more than $0.01
                        # Update SL level
                        evaluator.current_trade.tpsl_levels.stop_loss = new_sl
                        tp_sl_adjustments['SL'] += 1
                        
                        # Log adjustment
                        self.live_message.emit(
                            f"SL Adjusted: {old_sl:.2f} → {new_sl:.2f} ({sl_result.sl_mode}, {sl_result.reason})",
                            "INFO",
                            "OPTIMIZER"
                        )
                
                # CHECK TP/SL HITS - but ONLY if no exit signal from evaluate_bar!
                # Exit conditions have PRIORITY over TP/SL (institutional hierarchy)
                if not result.should_exit and evaluator.current_trade and hasattr(evaluator.current_trade, 'tpsl_levels'):
                    current_price = float(current_bar.close)
                    tpsl = evaluator.current_trade.tpsl_levels
                    
                    # CRITICAL FIX #1: Check MAX BARS HELD (time limit) FIRST
                    bars_held = i - evaluator.current_trade.entry_bar
                    max_bars = self.config.get('max_bars_held', 200)
                    
                    if bars_held >= max_bars:
                        result.should_exit = True
                        result.exit_reason = f"Max Hold Time ({max_bars} bars)"
                        result.exit_percentage = evaluator.current_trade.remaining_position
                        result.exit_type = "TIME_LIMIT"
                        result.exit_condition_name = "MAX_BARS"
                    
                    # CRITICAL FIX #2: Check SL/TP with proper TP tracking
                    elif True:  # Only check prices if time limit not hit
                        # Track which TPs already hit (use tp_hits list in TradeState)
                        tp_hits = evaluator.current_trade.tp_hits
                        
                        # PARTIAL EXITS: TP1=33%, TP2=33%, TP3=34% (total 100%)
                        remaining = evaluator.current_trade.remaining_position
                        
                        if side == 'LONG':
                            # LONG: Check SL hit (price below SL) first
                            if current_price <= tpsl.stop_loss:
                                result.should_exit = True
                                result.exit_reason = "Stop Loss Hit"
                                result.exit_percentage = remaining  # Exit ALL remaining
                                result.exit_type = "STOP_LOSS"
                                result.exit_condition_name = "SL"
                            
                            # Check TPs in order - only if NOT already hit
                            elif 'TP1' not in tp_hits and current_price >= tpsl.take_profit_1:
                                result.should_exit = True
                                result.exit_reason = "TP1 Hit"
                                result.exit_percentage = min(0.33, remaining)  # 33% or remaining
                                result.exit_type = "TAKE_PROFIT"
                                result.exit_condition_name = "TP1"
                            
                            elif 'TP2' not in tp_hits and current_price >= tpsl.take_profit_2:
                                result.should_exit = True
                                result.exit_reason = "TP2 Hit"
                                result.exit_percentage = min(0.33, remaining)  # 33% or remaining
                                result.exit_type = "TAKE_PROFIT"
                                result.exit_condition_name = "TP2"
                            
                            elif 'TP3' not in tp_hits and current_price >= tpsl.take_profit_3:
                                result.should_exit = True
                                result.exit_reason = "TP3 Hit"
                                result.exit_percentage = remaining  # Exit ALL remaining (last TP)
                                result.exit_type = "TAKE_PROFIT"
                                result.exit_condition_name = "TP3"
                        
                        else:  # SHORT
                            # SHORT: Check SL hit (price above SL) first
                            if current_price >= tpsl.stop_loss:
                                result.should_exit = True
                                result.exit_reason = "Stop Loss Hit"
                                result.exit_percentage = remaining
                                result.exit_type = "STOP_LOSS"
                                result.exit_condition_name = "SL"
                            
                            # Check TPs in order - only if NOT already hit
                            elif 'TP1' not in tp_hits and current_price <= tpsl.take_profit_1:
                                result.should_exit = True
                                result.exit_reason = "TP1 Hit"
                                result.exit_percentage = min(0.33, remaining)
                                result.exit_type = "TAKE_PROFIT"
                                result.exit_condition_name = "TP1"
                            
                            elif 'TP2' not in tp_hits and current_price <= tpsl.take_profit_2:
                                result.should_exit = True
                                result.exit_reason = "TP2 Hit"
                                result.exit_percentage = min(0.33, remaining)
                                result.exit_type = "TAKE_PROFIT"
                                result.exit_condition_name = "TP2"
                            
                            elif 'TP3' not in tp_hits and current_price <= tpsl.take_profit_3:
                                result.should_exit = True
                                result.exit_reason = "TP3 Hit"
                                result.exit_percentage = remaining  # Exit ALL remaining (last TP)
                                result.exit_type = "TAKE_PROFIT"
                                result.exit_condition_name = "TP3"
                
                # EXIT DECISION (signal-driven - only if no TP/SL exit triggered)
                if result.should_exit and evaluator.current_trade:
                    exit_price = float(current_bar.close)
                    entry_bar = evaluator.current_trade.entry_bar  # FIXED: use entry_bar, not entry_bar_idx
                    
                    # CRITICAL: Handle None entry_bar (defensive programming)
                    if entry_bar is None:
                        self.live_message.emit(
                            f"Warning: Trade #{trade_count} has no entry_bar, using 0 duration",
                            "WARNING",
                            "SYSTEM"
                        )
                        num_bars = 0
                    else:
                        num_bars = i - entry_bar
                    
                    duration_text = self._bars_to_duration(num_bars)
                    
                    # Calculate PnL
                    entry_price = float(evaluator.current_trade.entry_price)  # FIXED: convert Price to float
                    if side == 'LONG':
                        pnl_pct = ((exit_price - entry_price) / entry_price) * 100
                    else:
                        pnl_pct = ((entry_price - exit_price) / entry_price) * 100
                    pnl = pnl_pct * 10  # Simplified
                    
                    # Emit trade update (PARTIAL or CLOSED)
                    is_full_exit = result.exit_percentage >= evaluator.current_trade.remaining_position
                    
                    closed_trade_data = {
                        'id': str(trade_count),
                        'timestamp': evaluator.current_trade.entry_timestamp,
                        'symbol': 'BTC.P/USDT',
                        'side': side,
                        'size': 0.1,
                        'entry_price': entry_price,
                        'exit_price': exit_price,
                        'duration': duration_text,
                        'pnl': pnl,
                        'pnl_pct': pnl_pct,
                        'status': 'CLOSED' if is_full_exit else 'PARTIAL',
                        'notes': f'{result.exit_reason}',
                        'exit_type': getattr(result, 'exit_type', None),
                        'exit_condition_name': getattr(result, 'exit_condition_name', None),
                        'partial_exit_percentage': f"{int(result.exit_percentage * 100)}%" if not is_full_exit else None
                    }
                    self.trade_data_emit.emit(closed_trade_data)
                    
                    # Persist trade to TradeRegistry (single-core path fix)
                    # Previously only the multicore path wrote to the registry;
                    # the single-core path emitted to UI but never persisted trades.
                    from src.optimizer_v3.core.trade_registry import get_trade_registry as _get_trade_registry
                    _registry = _get_trade_registry()
                    _exit_timestamp = datetime.fromtimestamp(current_bar.ts_init / 1e9, tz=_tz.utc).replace(tzinfo=None)
                    _registry.add_trade({
                        'entry_timestamp': evaluator.current_trade.entry_timestamp if evaluator.current_trade else None,
                        'exit_timestamp': _exit_timestamp,
                        'entry_price': entry_price,
                        'exit_price': exit_price,
                        'entry_bar': entry_bar if entry_bar is not None else 0,
                        'exit_bar': i,
                        'side': side,
                        'pnl': pnl,
                        'pnl_pct': pnl_pct,
                        'bars_held': num_bars,
                        'exit_reason': result.exit_reason,
                        'exit_type': getattr(result, 'exit_type', None),
                        'exit_condition_name': getattr(result, 'exit_condition_name', None),
                        'partial_exit': not is_full_exit,
                        'exit_percentage': float(result.exit_percentage),
                        'status': 'CLOSED' if is_full_exit else 'PARTIAL',
                    })
                    
                    # Log exit
                    status = "WIN" if pnl > 0 else "LOSS"
                    self.live_message.emit(
                        f"Exit #{trade_count}: {status} - PnL: ${pnl:.2f} ({pnl_pct:.2f}%) - Reason: {result.exit_reason}",
                        "ACTION" if pnl > 0 else "WARNING",
                        "TRADE"
                    )
                    
                # CRITICAL FIX #3: Track which TP was hit before clearing position
                # Guard: current_trade may already be None if a prior partial-exit call
                # consumed the remaining position and exit_trade() set it to None.
                if evaluator.current_trade and hasattr(result, 'exit_condition_name') and result.exit_condition_name:
                    if result.exit_condition_name in ['TP1', 'TP2', 'TP3']:
                        # Record TP hit in trade state
                        evaluator.current_trade.tp_hits.append(result.exit_condition_name)
                        
                        # FIX 2026-02-13: Increment TP counter for UI display
                        tp_sl_adjustments[result.exit_condition_name] += 1

                # Only call exit_trade when an actual exit is triggered.
                # Calling unconditionally with exit_percentage=0.0 on every bar is
                # architecturally wrong and could cause subtle accumulation issues.
                if result.should_exit:
                    evaluator.exit_trade(result.exit_percentage)
                
                # Update progress bar every 100 candles
                # Mode 2: label explicitly says "Candles X/Y" per spec
                if i % 100 == 0:
                    if mode == 2:
                        progress_msg = f"Live Replay: Candles {i}/{total_candles}"
                    else:
                        progress_msg = f"Processing candles {i}/{total_candles}"
                    self.progress_updated.emit(i, total_candles, progress_msg)
                
                # Emit progress messages every 500 candles for summary  
                if i % 500 == 0 and i > 0:
                    self.live_message.emit(
                        f"Progress: {int((i/total_candles)*100)}% complete, {trade_count} trades executed",
                        "INFO",
                        "OPTIMIZER"
                    )
            
            # Emit FINAL 100% progress update
            if mode == 2:
                self.progress_updated.emit(total_candles, total_candles, f"Live Replay: Candles {total_candles}/{total_candles}")
            else:
                self.progress_updated.emit(total_candles, total_candles, f"Processing candles {total_candles}/{total_candles}")
            
            # Emit completion message LIVE
            self.live_message.emit(
                f"✅ Backtest completed successfully! {trade_count} trades executed.",
                "INFO",
                "SYSTEM"
            )
            self.live_message.emit(
                f"Total candles processed: {total_candles:,}",
                "INFO",
                "SYSTEM"
            )
            
            # Calculate results (REAL adjustments, not hardcoded!)
            from src.optimizer_v3.core.trade_registry import get_trade_registry as _get_registry_sc
            trades_list = _get_registry_sc().get_all_trades()
            results = {
                'total_candles': total_candles,
                'trades': trade_count,
                'trades_list': trades_list,
                'tp_adjustments': tp_sl_adjustments,  # Real tracked adjustments
                'strategy_config': self.strategy_config,  # BTCAAAAA-736: pass to AI panel
            }
            self.backtest_finished.emit(True, results)
            
        except Exception as e:
            import traceback
            full_tb = traceback.format_exc()
            # Emit the full traceback to the live output so it is visible in the UI
            # and does NOT silently swallow the exception (previous behaviour caused
            # the backtest to appear to finish with 0 trades instead of surfacing
            # the real AttributeError).
            self.live_message.emit(f"Error: {str(e)}", "ERROR", "SYSTEM")
            self.live_message.emit(full_tb, "ERROR", "SYSTEM")
            logger.error("BacktestWorker uncaught exception:\n%s", full_tb)
            self.backtest_finished.emit(False, {'error': str(e)})
    
    def _on_data_load_progress(self, current: int, total: int, message: str):
        """
        Handle data loading progress callback
        
        Sprint 2.0.1 Task 2.0.1.3: Progress updates during bar loading
        
        Args:
            current: Current progress value (0-100 percentage or actual bar count)
            total: Total progress value (100 for percentage or total bars)
            message: Progress message
        """
        # NOTE: During data loading, current/total are percentages (0-100)
        # Don't emit these to progress bar as they're misleading
        # Progress bar will be updated once we know total_candles after loading
        
        # Emit to Live Output if complete
        if current == total:  # Load complete
            self.live_message.emit(message, "INFO", "SYSTEM")
    
    def pause(self):
        """Pause the backtest"""
        self.is_paused = True
    
    def resume(self):
        """Resume the backtest"""
        self.is_paused = False
    
    def stop(self):
        """Stop the backtest"""
        self.should_stop = True


class BacktestConfigPanel(QWidget):
    """
    Backtest Configuration Panel
    
    Provides comprehensive backtest configuration and live execution monitoring.
    
    NAUTILUS EXPERT: Institutional-grade backtest execution with:
    - NautilusTrader Money type for starting capital
    - Proper validation ($500-$1M for futures with leverage)
    - Real-time progress monitoring
    """
    
    # Signals
    capital_changed = pyqtSignal(Money)  # Emits when starting capital changes
    config_changed = pyqtSignal()  # NEW: Emits when ANY config parameter changes (triggers auto-save)

    def __init__(self, orchestrator, parent=None):
        super().__init__(parent)
        self.orchestrator = orchestrator
        self.parent_window = parent  # Store reference to main window for auto-save
        self.worker: Optional[BacktestWorker] = None
        
        # Starting Capital (NautilusTrader Money type)
        self.starting_capital = Money('10000', Currency.from_str('USD'))  # Default $10,000
        
        # Storage for custom preset values
        self.custom_values = {}
        self._loading_preset = False  # Flag to prevent auto-switch to Custom during preset load

        # Calibration cache — populated from disk on init, updated on each successful run
        self._calibration_fingerprint: Optional[str] = None  # SHA-256 hex of last calibrated settings
        self._calibration_cache: Optional[dict] = None  # delay_map from last successful calibration
        self._calibration_cache_from_disk: bool = False  # True when fingerprint was loaded from disk
        self._load_calibration_disk_cache()
        
        # INSTITUTIONAL PATTERN: Data cache manager (singleton)
        from src.optimizer_v3.core.data_cache_manager import get_data_cache_manager
        self.cache_manager = get_data_cache_manager()
        
        # Data provider for Config Discovery and bar loading
        self.data_provider = get_backtest_provider()
        
        self._init_ui()
        
        # CRITICAL: Auto-calculate confluence from strategy on window open
        # This replaces the manual "Reset From Strategy" button click
        self._auto_calculate_confluence_on_init()
    
    def closeEvent(self, event):
        """Handle widget close - CRITICAL: Stop running thread before destruction"""
        self._cleanup_thread()
        super().closeEvent(event)
    
    def __del__(self):
        """Destructor - ensure thread is cleaned up"""
        self._cleanup_thread()
    
    def _cleanup_thread(self):
        """Cleanup running worker thread to prevent QThread crash"""
        if self.worker and self.worker.isRunning():
            # Stop the worker
            self.worker.stop()
            # Wait for thread to finish (max 2 seconds)
            self.worker.wait(2000)
            # If still running, force terminate
            if self.worker.isRunning():
                self.worker.terminate()
                self.worker.wait()
            self.worker = None
    
    def _init_ui(self):
        """Initialize the user interface"""
        main_layout = QVBoxLayout()
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.setSpacing(0)
        
        # Create tab widget with centralized styling
        self.tab_widget = QTabWidget()
        self.tab_widget.setStyleSheet(get_tab_widget_stylesheet())
        
        # Tab 1: Configuration (existing content)
        config_tab = self._create_config_tab()
        self.tab_widget.addTab(config_tab, "💠 Config")

        # Tab 2: Live Output (Optimizer v3 - INTEGRATED)
        from src.optimizer_v3.ui.live_output_panel import LiveOutputPanel
        strategy_name = self._get_strategy_name()
        self.output_panel = LiveOutputPanel(strategy_name=strategy_name)
        # Create tab and set initial red state
        self.live_output_tab_index = self.tab_widget.addTab(self.output_panel, "● Live Output")
        self._set_live_output_color("red")  # Red for idle
        
        # Tab 3: Trades (Optimizer v3 - INTEGRATED)
        from src.optimizer_v3.ui.trades_panel import TradesPanel
        self.trades_panel = TradesPanel()
        self.tab_widget.addTab(self.trades_panel, "💰 Trades")
        
        # Tab 4: AI Recommendations (Optimizer v3 - INTEGRATED)
        # Placed before Metrics so the user sees this tab first when AI response arrives,
        # then auto-switches to Metrics where the Apply buttons live.
        from src.optimizer_v3.ui.ai_recommendations_panel import AIRecommendationsPanel
        self.ai_recommendations_panel = AIRecommendationsPanel()
        self.tab_widget.addTab(self.ai_recommendations_panel, "🤖 AI Recommendations")

        # Tab 5: Metrics (Optimizer v3 - INTEGRATED)
        from src.optimizer_v3.ui.metrics_display_panel import MetricsDisplayPanel
        self.metrics_panel = MetricsDisplayPanel()
        self.tab_widget.addTab(self.metrics_panel, "💹 Metrics")
        
        # 🔥 CONNECT TRADES PANEL TO METRICS PANEL (Real-time updates)
        # 🔥 CRITICAL FIX: Connect trades_panel metrics_updated signal (emitted every second)
        # to metrics_panel update_metrics() for real-time metric calculations
        self.trades_panel.metrics_updated.connect(self.metrics_panel.update_metrics)

        # Connect AI panel's send_approved signal to metrics panel's handler
        # When user clicks "Approve & Send to AI" button, trigger AI request
        if hasattr(self.metrics_panel, '_on_ai_request_approved'):
            self.ai_recommendations_panel.send_approved.connect(
                self.metrics_panel._on_ai_request_approved
            )

        # Connect metrics panel to AI recommendations panel
        # When metrics panel generates recommendations, forward them to AI panel
        if hasattr(self.metrics_panel, 'recommendations_generated'):
            self.metrics_panel.recommendations_generated.connect(
                self.ai_recommendations_panel.display_recommendations
            )
        
        # Tab 6: Compare (Optimizer v3 - INTEGRATED)
        from src.optimizer_v3.ui.compare_view_panel import CompareViewPanel
        self.compare_panel = CompareViewPanel()
        self.tab_widget.addTab(self.compare_panel, "🔁 Compare")
        
        main_layout.addWidget(self.tab_widget)
        self.setLayout(main_layout)
    
    def _create_config_tab(self) -> QWidget:
        """Create configuration tab (original content)"""
        widget = QWidget()
        layout = QVBoxLayout()
        layout.setSpacing(15)
        layout.setContentsMargins(10, 10, 10, 10)
        
        # Title (using centralized panel title style - matches main window "Strategy Information")
        # Dynamic title with strategy name
        strategy_name = self._get_strategy_name()
        if strategy_name:
            title_text = f"💠 Backtest Configuration - {strategy_name} Strategy"
        else:
            title_text = "💠 Backtest Configuration"
        
        self.title_label = QLabel(title_text)
        self.title_label.setStyleSheet(get_panel_title_stylesheet())
        layout.addWidget(self.title_label)
        
        # Configuration Group
        config_group = self._create_config_group()
        layout.addWidget(config_group)
        
        # Progress Group
        progress_group = self._create_progress_group()
        layout.addWidget(progress_group)
        
        # Control Buttons
        control_layout = self._create_control_buttons()
        layout.addLayout(control_layout)
        
        # Status Display
        self.results_text = QTextEdit()
        self.results_text.setReadOnly(True)
        self.results_text.setPlaceholderText(
            "Status updates will appear here when backtest starts...\n\n"
            "During backtest you will see:\n"
            "✅ Data loading progress from Unified Data Manager\n"
            "✅ NautilusTrader initialization\n"
            "✅ Bar aggregation status\n"
            "✅ Hybrid data source routing (LakeAPI + Binance)\n"
            "✅ Real-time processing updates\n\n"
            "All terminal output will be captured and displayed here."
        )
        # Config retention indicator — shown when a saved config is restored
        # or persisted after a test run / config discovery.
        self.config_retention_label = QLabel()
        self.config_retention_label.setFont(create_font(9))
        self.config_retention_label.setStyleSheet(get_status_label_style('info'))
        self.config_retention_label.setVisible(False)  # Hidden until config is retained
        layout.addWidget(self.config_retention_label)

        layout.addWidget(QLabel("📊 Status:"))
        layout.addWidget(self.results_text)  # Will expand to fill remaining space
        widget.setLayout(layout)
        return widget
    
    def _create_placeholder_tab(self, title: str, message: str) -> QWidget:
        """Create a placeholder tab for future implementation"""
        widget = QWidget()
        layout = QVBoxLayout()
        layout.setContentsMargins(20, 20, 20, 20)
        
        # Title
        title_label = QLabel(title)
        title_font = QFont()
        title_font.setPointSize(16)
        title_font.setBold(True)
        title_label.setFont(title_font)
        title_label.setAlignment(Qt.AlignCenter)
        layout.addWidget(title_label)
        
        # Coming soon message
        msg_label = QLabel(f"{message}\n\n🚧 Coming Soon 🚧")
        msg_label.setAlignment(Qt.AlignCenter)
        msg_label.setStyleSheet(get_label_style('muted') + " font-size: 14px; padding: 20px;")
        layout.addWidget(msg_label)
        
        layout.addStretch()
        widget.setLayout(layout)
        return widget
    
    def _create_config_group(self) -> QGroupBox:
        """Create configuration controls group - 3-column layout with proper proportions"""
        group = QGroupBox("Configuration")
        group.setStyleSheet(get_groupbox_header_stylesheet())
        group.setMaximumHeight(600)  # Compact config panel - extra space goes to Results
        main_layout = QHBoxLayout()
        main_layout.setSpacing(20)
        
        # Column 1: Basic Settings (35% width)
        col1 = self._create_basic_settings_column()
        main_layout.addWidget(col1, 7)  # stretch factor 7 (35%)
        
        # Column 2: Adaptive SL v2.0 (35% width)
        col2 = self._create_adaptive_sl_column()
        main_layout.addWidget(col2, 7)  # stretch factor 7 (35%)
        
        # Column 3: Risk/Reward (30% width)
        col3 = self._create_risk_reward_column()
        main_layout.addWidget(col3, 6)  # stretch factor 6 (30%)
        
        group.setLayout(main_layout)
        
        # NOW connect preset signals (after all widgets are created)
        self.conservative_radio.toggled.connect(lambda checked: self._apply_conservative_preset() if checked else None)
        self.balanced_radio.toggled.connect(lambda checked: self._apply_balanced_preset() if checked else None)
        self.aggressive_radio.toggled.connect(lambda checked: self._apply_aggressive_preset() if checked else None)
        self.custom_radio.toggled.connect(lambda checked: self._apply_custom_preset() if checked else None)
        
        # Connect all spinboxes to detect manual changes and auto-switch to Custom
        self._connect_value_change_detection()
        
        # Set default preset (this will trigger the signal and load values)
        self.balanced_radio.setChecked(True)
        
        # CRITICAL: Connect ALL controls to auto-save (must be AFTER preset initialization!)
        self._connect_auto_save()
        
        return group
    
    def _create_basic_settings_column(self) -> QGroupBox:
        """Create Basic Settings column"""
        group = QGroupBox("Basic Settings")
        group.setStyleSheet(get_groupbox_header_stylesheet())
        # No height constraint - let layout manage naturally
        layout = QVBoxLayout()
        layout.setSpacing(12)
        
        # Lookback Days - SINGLE HORIZONTAL LINE
        lookback_layout = QHBoxLayout()
        lookback_layout.setSpacing(8)
        
        # Label
        lookback_label = QLabel("Lookback:")
        lookback_label.setStyleSheet(get_label_style('muted'))
        lookback_layout.addWidget(lookback_label)
        
        # Quick preset buttons - OPTIMIZED SIZE & FONT
        for days in [30, 60, 90, 120, 180, 240, 360]:
            btn = QPushButton(f"{days}")
            # 2-digit: 65px, 3-digit: 67px
            width = 67 if days >= 100 else 65
            btn.setFixedSize(width, 50)
            btn.setStyleSheet(get_preset_day_button_stylesheet())
            btn.clicked.connect(lambda checked, d=days: self.lookback_spin.setValue(d))
            lookback_layout.addWidget(btn)
        
        self.lookback_spin = QSpinBox()
        self.lookback_spin.setRange(1, 365)
        self.lookback_spin.setValue(180)
        self.lookback_spin.setSuffix(" days")
        self.lookback_spin.setMaximumWidth(195)  # Reduced by 25px
        self.lookback_spin.setStyleSheet(get_spinbox_button_stylesheet())
        self.lookback_spin.setToolTip(
            "Historical Data Lookback Period\n\n"
            "Total days of historical data to load for backtesting.\n\n"
            "Includes:\n"
            "• Training period (for strategy calibration)\n"
            "• Testing period (for strategy validation)\n\n"
            "Example: 180 days allows 90-day training + 90-day testing\n\n"
            "Recommendation: At least 2x training period"
        )
        lookback_layout.addWidget(self.lookback_spin)
        layout.addLayout(lookback_layout)
        
        # Training Window - SINGLE HORIZONTAL LINE
        training_layout = QHBoxLayout()
        training_layout.setSpacing(8)
        
        # Label
        training_label = QLabel("Training:")
        training_label.setStyleSheet(get_label_style('muted'))
        training_layout.addWidget(training_label)
        
        # Quick preset buttons - OPTIMIZED SIZE & FONT
        for days in [30, 60, 90, 120, 180, 240, 360]:
            btn = QPushButton(f"{days}")
            # 2-digit: 65px, 3-digit: 67px
            width = 67 if days >= 100 else 65
            btn.setFixedSize(width, 50)
            btn.setStyleSheet(get_preset_day_button_stylesheet())
            btn.clicked.connect(lambda checked, d=days: self.training_spin.setValue(d))
            training_layout.addWidget(btn)
        
        self.training_spin = QSpinBox()
        self.training_spin.setRange(1, 365)
        self.training_spin.setValue(90)
        self.training_spin.setSuffix(" days")
        self.training_spin.setMaximumWidth(195)  # Reduced by 25px
        self.training_spin.setStyleSheet(get_spinbox_button_stylesheet())
        self.training_spin.setToolTip(
            "Strategy Training Window\n\n"
            "Period used to calibrate strategy parameters and learn patterns.\n\n"
            "Used for:\n"
            "• Pattern recognition training\n"
            "• Parameter optimization\n"
            "• Feature learning\n\n"
            "Best Practice:\n"
            "• Minimum 60 days for reliable patterns\n"
            "• 90 days recommended for crypto volatility"
        )
        training_layout.addWidget(self.training_spin)
        layout.addLayout(training_layout)
        
        # Testing Window - SINGLE HORIZONTAL LINE
        testing_layout = QHBoxLayout()
        testing_layout.setSpacing(8)
        
        # Label
        testing_label = QLabel("Testing:")
        testing_label.setStyleSheet(get_label_style('muted'))
        testing_layout.addWidget(testing_label)
        
        # Quick preset buttons - OPTIMIZED SIZE & FONT
        for days in [30, 60, 90, 120, 180, 240, 360]:
            btn = QPushButton(f"{days}")
            # 2-digit: 65px, 3-digit: 67px
            width = 67 if days >= 100 else 65
            btn.setFixedSize(width, 50)
            btn.setStyleSheet(get_preset_day_button_stylesheet())
            btn.clicked.connect(lambda checked, d=days: self.testing_spin.setValue(d))
            testing_layout.addWidget(btn)
        
        self.testing_spin = QSpinBox()
        self.testing_spin.setRange(1, 365)
        self.testing_spin.setValue(30)
        self.testing_spin.setSuffix(" days")
        self.testing_spin.setMaximumWidth(195)  # Fixed typo
        self.testing_spin.setStyleSheet(get_spinbox_button_stylesheet())
        self.testing_spin.setToolTip(
            "Strategy Testing Window\n\n"
            "Out-of-sample period for strategy validation.\n\n"
            "Purpose:\n"
            "• Test strategy on unseen data\n"
            "• Detect overfitting\n"
            "• Validate performance metrics\n\n"
            "Best Practice:\n"
            "• At least 30 days for meaningful results\n"
            "• Should represent diverse market conditions"
        )
        testing_layout.addWidget(self.testing_spin)
        layout.addLayout(testing_layout)
        
        # Separator above Mode
        sep_top = QLabel()
        sep_top.setStyleSheet(get_separator_stylesheet())
        sep_top.setFixedHeight(1)
        layout.addWidget(sep_top)
        
        # Test Mode (exactly like other fields - all on one line)
        mode_layout = QHBoxLayout()
        mode_layout.setAlignment(Qt.AlignLeft)  # FORCE left alignment
        mode_label = QLabel("Mode:")
        mode_label.setStyleSheet(get_label_style('muted'))
        mode_layout.addWidget(mode_label)
        
        self.mode_group = QButtonGroup()
        self.mode1_radio = QRadioButton("Mode 1 (Historical)")
        self.mode1_radio.setStyleSheet(get_radio_button_style('info'))  # Blue
        self.mode1_radio.setToolTip(
            "Mode 1: Historical Backtest\n\n"
            "Standard historical data analysis mode.\n\n"
            "How it works:\n"
            "• Loads all historical data at once\n"
            "• Processes bars sequentially\n"
            "• Fast execution\n\n"
            "Best for:\n"
            "• Quick strategy testing\n"
            "• Parameter optimization\n"
            "• Walk-forward analysis\n\n"
            "Limitation: Can't simulate real-time conditions"
        )
        mode_layout.addWidget(self.mode1_radio)
        
        self.mode2_radio = QRadioButton("Mode 2 (Live Replay)")
        self.mode2_radio.setStyleSheet(get_radio_button_style('bullish'))  # Green
        self.mode2_radio.setToolTip(
            "Mode 2: Live Replay Simulation\n\n"
            "Simulates real-time trading conditions.\n\n"
            "How it works:\n"
            "• Feeds data bar-by-bar as if live\n"
            "• Strategy only sees past data\n"
            "• More realistic execution\n\n"
            "Best for:\n"
            "• Final strategy validation\n"
            "• Testing order execution logic\n"
            "• Real-time decision verification\n\n"
            "Note: Slower than Mode 1, more realistic"
        )
        mode_layout.addWidget(self.mode2_radio)
        
        self.mode1_radio.setChecked(True)
        self.mode_group.addButton(self.mode1_radio, 1)
        self.mode_group.addButton(self.mode2_radio, 2)
        
        layout.addLayout(mode_layout)
        
        # Separator below Mode
        sep_bottom = QLabel()
        sep_bottom.setStyleSheet(get_separator_stylesheet())
        sep_bottom.setFixedHeight(1)
        layout.addWidget(sep_bottom)
        
        # TP/SL Configuration
        tpsl_layout = QVBoxLayout()
        tpsl_label = QLabel("TP/SL Config:")
        tpsl_label.setStyleSheet(get_label_style('muted'))
        tpsl_layout.addWidget(tpsl_label)
        self.tpsl_combo = QComboBox()
        self.tpsl_combo.addItems(["Fibonacci", "Hybrid", "Fixed"])
        fix_combobox_white_bars(self.tpsl_combo)  # Comprehensive fix
        self.tpsl_combo.setToolTip(
            "TP/SL Initial Calculation Method\n\n"
            "💠 This controls HOW initial TP/SL levels are calculated at entry.\n\n"
            "Fibonacci:\n"
            "• TP levels at Fibonacci retracements (0.382, 0.618, 1.0)\n"
            "• SL at key Fibonacci support/resistance\n"
            "• Dynamic based on recent price structure\n"
            "• Best for: Trend-following strategies\n"
            "• Example: Entry at $50k, SL at $49k (Fib support)\n\n"
            "Hybrid (Recommended):\n"
            "• Combines Fibonacci levels with volatility (ATR)\n"
            "• Adapts to market conditions\n"
            "• Best for: All-weather strategies\n"
            "• Example: Fib level adjusted by current volatility\n\n"
            "Fixed:\n"
            "• Static percentage-based TP/SL from entry\n"
            "• Simple, predictable risk/reward\n"
            "• Best for: Scalping, high-frequency strategies\n"
            "• Example: Entry $50k, SL -2%, TP +3%\n"
            "• ⚠️ Currently no UI to configure Fixed % - coming soon!\n\n"
            "NOTE: This is separate from SL Adjustment below!"
        )
        tpsl_layout.addWidget(self.tpsl_combo)
        layout.addLayout(tpsl_layout)
        
        # Stop Loss Adjustment Mode
        sl_layout = QVBoxLayout()
        sl_label = QLabel("Stop Loss Adjustment:")
        sl_label.setStyleSheet(get_label_style('muted'))
        sl_layout.addWidget(sl_label)
        self.sl_combo = QComboBox()
        self.sl_combo.addItems(["Adaptive v2.0", "Static"])
        fix_combobox_white_bars(self.sl_combo)  # Comprehensive fix
        self.sl_combo.setToolTip(
            "Stop Loss Adjustment Behavior\n\n"
            "🔄 This controls WHETHER the SL adjusts AFTER entry.\n\n"
            "Adaptive v2.0 (Recommended):\n"
            "• SL dynamically adjusts during trade lifetime\n"
            "• Widens in volatile conditions (protects from noise)\n"
            "• Tightens in calm markets (locks in profits)\n"
            "• Uses market structure (swing highs/lows)\n"
            "• Delayed activation to avoid stop-hunting\n"
            "• Emergency SL for immediate catastrophic protection\n\n"
            "How it works:\n"
            "1. Entry: Initial SL placed (using TP/SL Config above)\n"
            "2. Delay period: Emergency SL active (2% typical)\n"
            "3. Post-delay: SL adjusts based on ATR + structure\n"
            "4. Trades continuation: SL trails or widens as needed\n\n"
            "Benefits:\n"
            "✓ Adapts to changing conditions\n"
            "✓ Reduces false stop-outs by 15-25%\n"
            "✓ Improves win rate by 10-15%\n"
            "✓ Institutional-grade protection\n\n"
            "Static:\n"
            "• SL stays fixed after entry (no adjustment)\n"
            "• Simple, predictable behavior\n"
            "• Uses initial calculation only\n"
            "• Best for: Fixed strategies, simple backtesting\n\n"
            "📊 DIFFERENCE FROM TP/SL CONFIG:\n"
            "• TP/SL Config = How to CALCULATE initial levels\n"
            "• SL Adjustment = Whether SL CHANGES during trade"
        )
        sl_layout.addWidget(self.sl_combo)
        layout.addLayout(sl_layout)
        
        layout.addStretch()
        group.setLayout(layout)
        return group
    
    def _create_adaptive_sl_column(self) -> QGroupBox:
        """Create Adaptive SL v2.0 column"""
        group = QGroupBox("Adaptive SL v2.0")
        group.setStyleSheet(get_groupbox_header_stylesheet())
        # No height constraint - let layout manage naturally
        layout = QVBoxLayout()
        layout.setSpacing(12)
        
        # Presets - INLINE HORIZONTAL LAYOUT with label
        presets_layout = QHBoxLayout()
        presets_layout.setSpacing(12)
        
        presets_label = QLabel("Presets:")
        presets_label.setStyleSheet(get_label_style('muted'))
        presets_layout.addWidget(presets_label)
        
        self.preset_group = QButtonGroup()
        self.conservative_radio = QRadioButton("🐢 Conservative")
        self.conservative_radio.setStyleSheet(get_radio_button_style())
        self.balanced_radio = QRadioButton("⚖️ Balanced")
        self.balanced_radio.setStyleSheet(get_radio_button_style())
        self.aggressive_radio = QRadioButton("🚀 Aggressive")
        self.aggressive_radio.setStyleSheet(get_radio_button_style())
        self.custom_radio = QRadioButton("💠 Custom")
        self.custom_radio.setStyleSheet(get_radio_button_style())
        self.custom_radio.setToolTip(
            "💠 Custom Preset\n\n"
            "Your manually configured settings.\n\n"
            "How it works:\n"
            "• When you select a preset (Conservative/Balanced/Aggressive)\n"
            "• Then manually adjust any value\n"
            "• Custom preset automatically activates\n"
            "• Your manual settings are saved\n\n"
            "Benefits:\n"
            "• Experiment with preset starting points\n"
            "• Fine-tune to your exact needs\n"
            "• Always return to your custom configuration\n"
            "• Never lose your manual adjustments\n\n"
            "Example workflow:\n"
            "1. Start with 'Balanced' preset\n"
            "2. Change Emergency SL from 2% to 2.5%\n"
            "3. Custom automatically selected\n"
            "4. Try 'Aggressive' preset (Custom values saved)\n"
            "5. Click 'Custom' to restore your 2.5% setting"
        )
        
        self.conservative_radio.setToolTip(
            "🐢 Conservative Preset\n\n"
            "Wider stop losses for maximum protection.\n\n"
            "Configuration:\n"
            "• Delay: 3 bars (maximum protection window)\n"
            "• Emergency SL: 3% (wider safety net)\n"
            "• Vol Multi: 1.5x (50% beyond volatility)\n"
            "• Min SL: 1.0% | Max SL: 2.5%\n"
            "• Market Structure: Enabled\n\n"
            "Trading Profile:\n"
            "• Win Rate: 60-70% (higher)\n"
            "• Trade Frequency: Lower (quality over quantity)\n"
            "• Risk per Trade: Lower\n"
            "• Ideal for: Risk-averse traders, volatile markets"
        )
        self.balanced_radio.setToolTip(
            "⚖️ Balanced Preset (Recommended)\n\n"
            "Optimal balance of protection and opportunity.\n\n"
            "Configuration:\n"
            "• Delay: 2 bars (standard protection)\n"
            "• Emergency SL: 2% (standard safety)\n"
            "• Vol Multi: 1.2x (20% beyond volatility)\n"
            "• Min SL: 0.7% | Max SL: 2.0%\n"
            "• Market Structure: Enabled\n\n"
            "Trading Profile:\n"
            "• Win Rate: 50-60% (balanced)\n"
            "• Trade Frequency: Moderate\n"
            "• Risk per Trade: Moderate\n"
            "• Ideal for: Most traders, general market conditions"
        )
        self.aggressive_radio.setToolTip(
            "🚀 Aggressive Preset\n\n"
            "Tighter stops for maximum trade frequency.\n\n"
            "Configuration:\n"
            "• Delay: 1 bar (minimal protection window)\n"
            "• Emergency SL: 2% (standard safety)\n"
            "• Vol Multi: 1.0x (at volatility level)\n"
            "• Min SL: 0.6% | Max SL: 1.5%\n"
            "• Market Structure: Enabled\n\n"
            "Trading Profile:\n"
            "• Win Rate: 40-50% (lower)\n"
            "• Trade Frequency: Higher (more opportunities)\n"
            "• Risk per Trade: Higher\n"
            "• Ideal for: Active traders, momentum strategies"
        )
        
        self.preset_group.addButton(self.conservative_radio, 1)
        self.preset_group.addButton(self.balanced_radio, 2)
        self.preset_group.addButton(self.aggressive_radio, 3)
        self.preset_group.addButton(self.custom_radio, 4)
        
        # Add radio buttons to horizontal layout
        presets_layout.addWidget(self.conservative_radio)
        presets_layout.addWidget(self.balanced_radio)
        presets_layout.addWidget(self.aggressive_radio)
        presets_layout.addWidget(self.custom_radio)
        presets_layout.addStretch()
        
        # Add horizontal layout to main column layout
        layout.addLayout(presets_layout)
        
        # Separator above checkboxes
        sep_top = QLabel()
        sep_top.setStyleSheet(get_separator_stylesheet())
        sep_top.setFixedHeight(1)
        layout.addWidget(sep_top)
        
        # Checkboxes inline - Delay Stop Loss and Market Structure
        checkboxes_layout = QHBoxLayout()
        checkboxes_layout.setSpacing(20)
        
        # Delay Stop Loss Activation
        self.delayed_sl_check = QCheckBox("Delay Stop Loss")
        self.delayed_sl_check.setStyleSheet(get_checkbox_style())
        self.delayed_sl_check.setChecked(True)
        self.delayed_sl_check.setToolTip(
            "Delayed Stop Loss Activation\n\n"
            "Delays stop loss activation after entry to avoid immediate stop-outs.\n\n"
            "How it works:\n"
            "• Entry at bar N\n"
            "• SL activates at bar N + Delay Period\n"
            "• Emergency SL protects immediately\n\n"
            "Benefits:\n"
            "✓ Reduces false stop-outs from entry volatility\n"
            "✓ Improves win rate by 10-15%\n"
            "✓ Emergency SL provides immediate protection\n\n"
            "Recommendation: 2 bars for 15m timeframe"
        )
        checkboxes_layout.addWidget(self.delayed_sl_check)
        
        # Market Structure Stop Loss checkbox (moved inline)
        self.structure_check = QCheckBox("Market Structure Stop Loss")
        self.structure_check.setStyleSheet(get_checkbox_style())
        self.structure_check.setChecked(True)
        self.structure_check.setToolTip(
            "Market Structure Stop Loss Placement\n\n"
            "When enabled, places stop loss at key market structure levels:\n"
            "• Swing highs/lows (recent price pivots)\n"
            "• Supply/Demand zones\n"
            "• Fibonacci retracement levels\n\n"
            "Benefits:\n"
            "✓ Stop loss placed beyond key levels\n"
            "✓ Reduces false stop-outs\n"
            "✓ Increases win rate by 5-10%\n\n"
            "When disabled:\n"
            "Uses percentage-based SL only (volatility multiplier)"
        )
        checkboxes_layout.addWidget(self.structure_check)
        checkboxes_layout.addStretch()
        
        layout.addLayout(checkboxes_layout)
        
        # Separator below checkboxes
        sep_bottom = QLabel()
        sep_bottom.setStyleSheet(get_separator_stylesheet())
        sep_bottom.setFixedHeight(1)
        layout.addWidget(sep_bottom)
        
        # Delay Period WITH QUICK-SET BUTTONS
        delay_layout = QHBoxLayout()
        delay_layout.setSpacing(8)
        
        delay_label = QLabel("Stop Loss Delay:")
        delay_label.setStyleSheet(get_label_style('muted'))
        delay_layout.addWidget(delay_label)
        
        # Quick preset buttons - UNIFORM GRID
        for val in [1, 2, 3, 4, 5, 6, 7]:
            btn = QPushButton(str(val))
            btn.setFixedSize(75, 50)
            btn.setStyleSheet(get_preset_day_button_stylesheet())
            btn.clicked.connect(lambda checked, v=val: self.delay_spin.setValue(v))
            delay_layout.addWidget(btn)
        
        self.delay_spin = QSpinBox()
        self.delay_spin.setRange(0, 20)
        self.delay_spin.setValue(2)
        self.delay_spin.setSuffix(" bars")
        self.delay_spin.setFixedWidth(150)
        self.delay_spin.setStyleSheet(get_spinbox_button_stylesheet())
        self.delay_spin.setToolTip(
            "Stop Loss Delay Period\n\n"
            "Number of bars to wait before activating normal stop loss.\n\n"
            "During delay:\n"
            "• Emergency SL protects position\n"
            "• Normal SL is not yet active\n"
            "• Prevents immediate stop-outs\n\n"
            "Guidelines:\n"
            "• 0 bars: Traditional SL (no delay)\n"
            "• 1-2 bars: Balanced (recommended)\n"
            "• 3+ bars: Conservative (wider protection)"
        )
        delay_layout.addWidget(self.delay_spin)
        layout.addLayout(delay_layout)
        
        # Emergency SL WITH QUICK-SET BUTTONS
        emergency_layout = QHBoxLayout()
        emergency_layout.setSpacing(8)
        
        emergency_label = QLabel("Emergency:")
        emergency_label.setStyleSheet(get_label_style('muted'))
        emergency_layout.addWidget(emergency_label)
        
        # Quick preset buttons - UNIFORM GRID
        for val in [1.0, 1.25, 1.5, 1.75, 2.0, 2.15, 2.25]:
            btn = QPushButton(str(val))
            btn.setFixedSize(75, 50)
            btn.setStyleSheet(get_preset_day_button_stylesheet())
            btn.clicked.connect(lambda checked, v=val: self.emergency_spin.setValue(v))
            emergency_layout.addWidget(btn)
        
        self.emergency_spin = QDoubleSpinBox()
        self.emergency_spin.setRange(0.5, 10.0)
        self.emergency_spin.setDecimals(2)
        self.emergency_spin.setValue(2.0)
        self.emergency_spin.setSuffix("%")
        self.emergency_spin.setSingleStep(0.25)
        self.emergency_spin.setFixedWidth(150)
        self.emergency_spin.setStyleSheet(get_spinbox_button_stylesheet())
        self.emergency_spin.setToolTip(
            "Emergency Stop Loss\n\n"
            "Wide catastrophic-loss protection during delay period.\n\n"
            "Purpose:\n"
            "• Protects against flash crashes\n"
            "• Prevents total capital loss\n"
            "• Active immediately after entry\n\n"
            "Setting Guidelines:\n"
            "• 2%: Standard (recommended)\n"
            "• 3%: Conservative (more room)\n"
            "• 1.5%: Aggressive (tighter)\n\n"
            "Should be 2-3x wider than normal SL"
        )
        emergency_layout.addWidget(self.emergency_spin)
        layout.addLayout(emergency_layout)
        
        # Volatility Lookback WITH QUICK-SET BUTTONS
        vol_lookback_layout = QHBoxLayout()
        vol_lookback_layout.setSpacing(8)
        
        vol_lookback_label = QLabel("Volatility Lookback:")
        vol_lookback_label.setStyleSheet(get_label_style('muted'))
        vol_lookback_layout.addWidget(vol_lookback_label)
        
        # Quick preset buttons - UNIFORM GRID
        for val in [5, 10, 15, 20, 25, 30, 35]:
            btn = QPushButton(str(val))
            btn.setFixedSize(75, 50)
            btn.setStyleSheet(get_preset_day_button_stylesheet())
            btn.clicked.connect(lambda checked, v=val: self.vol_lookback_spin.setValue(v))
            vol_lookback_layout.addWidget(btn)
        
        self.vol_lookback_spin = QSpinBox()
        self.vol_lookback_spin.setRange(5, 100)
        self.vol_lookback_spin.setValue(20)
        self.vol_lookback_spin.setSuffix(" bars")
        self.vol_lookback_spin.setFixedWidth(150)
        self.vol_lookback_spin.setStyleSheet(get_spinbox_button_stylesheet())
        self.vol_lookback_spin.setToolTip(
            "Volatility Lookback Period\n\n"
            "Number of bars used to calculate recent volatility (ATR).\n\n"
            "Purpose:\n"
            "• Measures market volatility\n"
            "• Adapts SL to current conditions\n"
            "• Wider SL in volatile markets\n\n"
            "Guidelines:\n"
            "• 14-20 bars: Standard ATR period\n"
            "• 10 bars: More responsive\n"
            "• 30+ bars: Smoother, less reactive\n\n"
            "Recommendation: 20 bars (default ATR)"
        )
        vol_lookback_layout.addWidget(self.vol_lookback_spin)
        layout.addLayout(vol_lookback_layout)
        
        # Volatility Multiplier WITH QUICK-SET BUTTONS
        vol_multi_layout = QHBoxLayout()
        vol_multi_layout.setSpacing(8)
        
        vol_multi_label = QLabel("Volatility Multiplier:")
        vol_multi_label.setStyleSheet(get_label_style('muted'))
        vol_multi_layout.addWidget(vol_multi_label)
        
        # Quick preset buttons - UNIFORM GRID
        for val in [1, 2, 3, 4, 5, 6, 7]:
            btn = QPushButton(str(val))
            btn.setFixedSize(75, 50)
            btn.setStyleSheet(get_preset_day_button_stylesheet())
            btn.clicked.connect(lambda checked, v=val: self.vol_multi_spin.setValue(v))
            vol_multi_layout.addWidget(btn)
        
        self.vol_multi_spin = QDoubleSpinBox()
        self.vol_multi_spin.setRange(0.5, 10.0)
        self.vol_multi_spin.setDecimals(1)
        self.vol_multi_spin.setSingleStep(0.1)
        self.vol_multi_spin.setSuffix("x")
        self.vol_multi_spin.setValue(1.2)
        self.vol_multi_spin.setFixedWidth(150)
        self.vol_multi_spin.setStyleSheet(get_spinbox_button_stylesheet())
        self.vol_multi_spin.setToolTip(
            "Volatility Multiplier\n\n"
            "How many times ATR to use for stop loss distance.\n\n"
            "Formula: SL = Entry ± (ATR × Multiplier / 10)\n\n"
            "Examples (ATR = $100):\n"
            "• 10 (1.0x): SL at $100 from entry\n"
            "• 12 (1.2x): SL at $120 from entry (recommended)\n"
            "• 15 (1.5x): SL at $150 from entry (conservative)\n\n"
            "Guidelines:\n"
            "• Lower = Tighter SL, higher risk\n"
            "• Higher = Wider SL, more breathing room"
        )
        vol_multi_layout.addWidget(self.vol_multi_spin)
        layout.addLayout(vol_multi_layout)
        
        # Min SL % WITH QUICK-SET BUTTONS
        min_sl_layout = QHBoxLayout()
        min_sl_layout.setSpacing(8)
        
        min_sl_label = QLabel("Min Stop Loss:")
        min_sl_label.setStyleSheet(get_label_style('muted'))
        min_sl_layout.addWidget(min_sl_label)
        
        # Quick preset buttons - UNIFORM GRID (removed 5, starts from 6)
        for val in [0.5, 1, 1.5, 2, 2.5, 3, 3.5]:
            btn = QPushButton(str(val))
            btn.setFixedSize(75, 50)
            btn.setStyleSheet(get_preset_day_button_stylesheet())
            btn.clicked.connect(lambda checked, v=val: self.min_sl_spin.setValue(v))
            min_sl_layout.addWidget(btn)
        
        self.min_sl_spin = QDoubleSpinBox()
        self.min_sl_spin.setRange(0.1, 10.0)
        self.min_sl_spin.setDecimals(1)
        self.min_sl_spin.setSingleStep(0.1)
        self.min_sl_spin.setSuffix("%")
        self.min_sl_spin.setValue(0.7)
        self.min_sl_spin.setFixedWidth(150)
        self.min_sl_spin.setStyleSheet(get_spinbox_button_stylesheet())
        self.min_sl_spin.setToolTip(
            "Minimum Stop Loss Distance\n\n"
            "Minimum allowed SL distance as % from entry.\n\n"
            "Purpose:\n"
            "• Prevents stops too tight to entry\n"
            "• Ensures minimum breathing room\n"
            "• Floor for volatile-based SL\n\n"
            "Value shown is 10x actual (7 = 0.7%)\n\n"
            "Guidelines:\n"
            "• 0.5-0.7%: Aggressive, scalping\n"
            "• 0.8-1.0%: Balanced (recommended)\n"
            "• 1.5%+: Conservative, swing trading"
        )
        min_sl_layout.addWidget(self.min_sl_spin)
        layout.addLayout(min_sl_layout)
        
        # Max SL % WITH QUICK-SET BUTTONS
        max_sl_layout = QHBoxLayout()
        max_sl_layout.setSpacing(8)
        
        max_sl_label = QLabel("Max Stop Loss:")
        max_sl_label.setStyleSheet(get_label_style('muted'))
        max_sl_layout.addWidget(max_sl_label)
        
        # Quick preset buttons - UNIFORM GRID
        for val in [1, 2, 3, 4, 5, 6, 7]:
            btn = QPushButton(str(val))
            btn.setFixedSize(75, 50)
            btn.setStyleSheet(get_preset_day_button_stylesheet())
            btn.clicked.connect(lambda checked, v=val: self.max_sl_spin.setValue(v))
            max_sl_layout.addWidget(btn)
        
        self.max_sl_spin = QDoubleSpinBox()
        self.max_sl_spin.setRange(0.1, 10.0)
        self.max_sl_spin.setDecimals(1)
        self.max_sl_spin.setSingleStep(0.1)
        self.max_sl_spin.setSuffix("%")
        self.max_sl_spin.setValue(2.0)
        self.max_sl_spin.setFixedWidth(150)
        self.max_sl_spin.setStyleSheet(get_spinbox_button_stylesheet())
        self.max_sl_spin.setToolTip(
            "Maximum Stop Loss Distance\n\n"
            "Maximum allowed SL distance as % from entry.\n\n"
            "Purpose:\n"
            "• Caps risk per trade\n"
            "• Prevents excessive stop distances\n"
            "• Ceiling for volatility-based SL\n\n"
            "Value shown is 10x actual (20 = 2.0%)\n\n"
            "Guidelines:\n"
            "• 1.5%: Tight risk control\n"
            "• 2.0%: Standard (recommended)\n"
            "• 2.5%+: Larger swingtrading stops"
        )
        max_sl_layout.addWidget(self.max_sl_spin)
        layout.addLayout(max_sl_layout)
        
        layout.addStretch()
        group.setLayout(layout)
        return group
    
    def _create_risk_reward_column(self) -> QGroupBox:
        """
        Create Risk/Reward column
        
        NAUTILUS EXPERT: Includes institutional-grade Starting Capital input
        with NautilusTrader Money type validation ($500-$1M for futures)
        """
        group = QGroupBox("Risk/Reward")
        group.setStyleSheet(get_groupbox_header_stylesheet())
        # No height constraint - let layout manage naturally
        layout = QVBoxLayout()
        layout.setSpacing(12)
        
        # Starting Capital WITH QUICK-SET BUTTONS (CRITICAL - Phase 0)
        capital_layout = QHBoxLayout()
        capital_layout.setSpacing(8)
        
        capital_label = QLabel("💰 Starting Capital:")
        capital_label.setStyleSheet(get_label_style('muted'))
        capital_layout.addWidget(capital_label)
        
        # Quick preset buttons - COMMON VALUES with correct labels
        preset_values = [
            (500, "500"),
            (1000, "1k"),
            (2000, "2k"),
            (5000, "5k"),
            (10000, "10k"),
            (25000, "25k"),
            (50000, "50k")
        ]
        for val, label in preset_values:
            btn = QPushButton(label)
            btn.setFixedSize(75, 50)
            btn.setStyleSheet(get_preset_day_button_stylesheet())
            btn.clicked.connect(lambda checked, v=val: self.capital_spin.setValue(v))
            capital_layout.addWidget(btn)
        
        # SpinBox with up/down arrows
        self.capital_spin = QSpinBox()
        self.capital_spin.setRange(500, 1000000)
        self.capital_spin.setValue(int(self.starting_capital.as_decimal()))
        self.capital_spin.setPrefix("$")
        self.capital_spin.setGroupSeparatorShown(True)  # Show thousands separator
        self.capital_spin.setSingleStep(100)
        self.capital_spin.setFixedWidth(150)
        self.capital_spin.setStyleSheet(get_spinbox_button_stylesheet())
        self.capital_spin.valueChanged.connect(self._on_capital_changed_spinbox)
        self.capital_spin.setToolTip(
            "Starting Capital Amount (USD)\n\n"
            "NAUTILUS EXPERT: Uses NautilusTrader Money type\n\n"
            "Critical for:\n"
            "• Position sizing calculations\n"
            "• Risk management (% of capital per trade)\n"
            "• Metric calculations (return %, drawdown %)\n"
            "• ML training features\n\n"
            "Validation (Futures with Leverage):\n"
            "• Minimum: $500 (small accounts with leverage)\n"
            "• Maximum: $1,000,000 (institutional size)\n\n"
            "Examples:\n"
            "• $500: Micro account (high leverage required)\n"
            "• $1,000: Small account (10-20x leverage typical)\n"
            "• $10,000: Standard account (balanced leverage)\n"
            "• $100,000: Large account (lower leverage needed)\n\n"
            "Recommended:\n"
            "• Backtesting: $10,000 default\n"
            "• Match your actual trading capital for realistic results"
        )
        capital_layout.addWidget(self.capital_spin)
        
        layout.addLayout(capital_layout)
        
        # Separator after Starting Capital (important field)
        sep_capital = QLabel()
        sep_capital.setStyleSheet(get_separator_stylesheet())
        sep_capital.setFixedHeight(1)
        layout.addWidget(sep_capital)
        
        # Min R:R Ratio WITH QUICK-SET BUTTONS
        rr_layout = QHBoxLayout()
        rr_layout.setSpacing(8)
        
        rr_label = QLabel("Min Risk:Reward:")
        rr_label.setStyleSheet(get_label_style('muted'))
        rr_layout.addWidget(rr_label)
        
        # Quick preset buttons - UNIFORM GRID
        for val in [12, 15, 20, 22, 25, 27, 30]:
            btn = QPushButton(str(val))
            btn.setFixedSize(75, 50)
            btn.setStyleSheet(get_preset_day_button_stylesheet())
            btn.clicked.connect(lambda checked, v=val: self.rr_spin.setValue(v))
            rr_layout.addWidget(btn)
        
        self.rr_spin = QSpinBox()
        self.rr_spin.setRange(10, 50)
        self.rr_spin.setValue(12)
        self.rr_spin.setSuffix("")
        self.rr_spin.setSingleStep(1)
        self.rr_spin.setFixedWidth(150)
        self.rr_spin.setStyleSheet(get_spinbox_button_stylesheet())
        self.rr_spin.setToolTip(
            "Minimum Risk to Reward Ratio\n\n"
            "Required profit potential vs risk for trade entry.\n\n"
            "Formula: Reward / Risk\n\n"
            "Examples:\n"
            "• 12 (1.2:1): $120 reward for $100 risk\n"
            "• 15 (1.5:1): $150 reward for $100 risk\n"
            "• 20 (2.0:1): $200 reward for $100 risk\n\n"
            "Guidelines:\n"
            "• 1.0-1.2: Aggressive (high win rate needed)\n"
            "• 1.5-2.0: Balanced (recommended)\n"
            "• 2.5+: Conservative (lower win rate acceptable)\n\n"
            "Value shown is 10x actual (12 = 1.2:1)"
        )
        rr_layout.addWidget(self.rr_spin)
        layout.addLayout(rr_layout)
        
        # Risk Per Trade % WITH QUICK-SET BUTTONS
        risk_layout = QHBoxLayout()
        risk_layout.setSpacing(8)
        
        risk_label = QLabel("Risk %:")
        risk_label.setStyleSheet(get_label_style('muted'))
        risk_layout.addWidget(risk_label)
        
        # Quick preset buttons - UNIFORM GRID
        for val in [1, 2, 5, 7, 10, 12, 15]:
            btn = QPushButton(str(val))
            btn.setFixedSize(75, 50)
            btn.setStyleSheet(get_preset_day_button_stylesheet())
            btn.clicked.connect(lambda checked, v=val: self.risk_spin.setValue(v))
            risk_layout.addWidget(btn)
        
        self.risk_spin = QSpinBox()
        self.risk_spin.setRange(1, 100)
        self.risk_spin.setValue(10)
        self.risk_spin.setSuffix("%")
        self.risk_spin.setFixedWidth(150)
        self.risk_spin.setStyleSheet(get_spinbox_button_stylesheet())
        self.risk_spin.setToolTip(
            "Risk Per Trade (% of Capital)\n\n"
            "Percentage of capital risked on each trade.\n\n"
            "Examples ($10,000 account):\n"
            "• 5%: Risk $500 per trade\n"
            "• 10%: Risk $1,000 per trade (backtest only!)\n"
            "• 2%: Risk $200 per trade (conservative)\n\n"
            "Guidelines:\n"
            "• Backtesting: 5-10% acceptable for testing\n"
            "• Live Trading: 1-2% maximum (institutional standard)\n"
            "• Never risk more than you can afford to lose\n\n"
            "⚠️ High values for testing only - use 1-2% for live!"
        )
        risk_layout.addWidget(self.risk_spin)
        layout.addLayout(risk_layout)
        
        # Max Leverage WITH QUICK-SET BUTTONS
        leverage_layout = QHBoxLayout()
        leverage_layout.setSpacing(8)
        
        leverage_label = QLabel("Leverage:")
        leverage_label.setStyleSheet(get_label_style('muted'))
        leverage_layout.addWidget(leverage_label)
        
        # Quick preset buttons - UNIFORM GRID
        for val in [3, 5, 10, 15, 20, 25, 30]:
            btn = QPushButton(str(val))
            btn.setFixedSize(75, 50)
            btn.setStyleSheet(get_preset_day_button_stylesheet())
            btn.clicked.connect(lambda checked, v=val: self.leverage_spin.setValue(v))
            leverage_layout.addWidget(btn)
        
        self.leverage_spin = QSpinBox()
        self.leverage_spin.setRange(1, 100)
        self.leverage_spin.setValue(10)
        self.leverage_spin.setSuffix("x")
        self.leverage_spin.setFixedWidth(150)
        self.leverage_spin.setStyleSheet(get_spinbox_button_stylesheet())
        self.leverage_spin.setToolTip(
            "Maximum Leverage Multiplier\n\n"
            "Maximum position size relative to capital.\n\n"
            "Examples ($10,000 capital):\n"
            "• 1x: $10,000 max position (no leverage)\n"
            "• 10x: $100,000 max position\n"
            "• 20x: $200,000 max position\n\n"
            "Risk Levels:\n"
            "• 1x: No leverage (safest)\n"
            "• 2-5x: Conservative leveraged\n"
            "• 10-20x: Moderate (crypto standard)\n"
            "• 50x+: High risk (volatile liquidation risk)\n\n"
            "⚠️ Higher leverage = Higher liquidation risk!"
        )
        leverage_layout.addWidget(self.leverage_spin)
        layout.addLayout(leverage_layout)
        
        # Min Confluence WITH RESET & INCREMENT/DECREMENT BUTTONS
        confluence_layout = QHBoxLayout()
        confluence_layout.setSpacing(8)
        
        confluence_label = QLabel("Confluence:")
        confluence_label.setStyleSheet(get_label_style('muted'))
        confluence_layout.addWidget(confluence_label)
        
        # Reset From Strategy button
        reset_btn = QPushButton("Reset From Strategy")
        reset_btn.setFixedSize(241, 50)
        reset_btn.setStyleSheet(get_preset_day_button_stylesheet())
        reset_btn.setToolTip(
            "Reset Confluence From Strategy\n\n"
            "Automatically analyzes your current strategy configuration:\n"
            "• Counts required blocks (AND logic)\n"
            "• Counts optional blocks (OR logic)\n"
            "• Calculates total possible confluence points\n"
            "• Sets recommended threshold\n\n"
            "Formula:\n"
            "• Required points: Sum of all AND block weights\n"
            "• Optional points: Sum of all OR block weights\n"
            "• Recommended: 60-70% of total points\n\n"
            "Example:\n"
            "If strategy has 50 required + 25 optional = 75 total pts\n"
            "Recommended confluence = 50 pts (67% of total)\n\n"
            "This ensures:\n"
            "✓ All required signals must trigger\n"
            "✓ Most optional signals should trigger\n"
            "✓ Quality trades over quantity"
        )
        reset_btn.clicked.connect(self._calculate_confluence_from_strategy)
        confluence_layout.addWidget(reset_btn)
        
        # Decrement buttons
        for val in [-1, -2]:
            btn = QPushButton(str(val))
            btn.setFixedSize(75, 50)
            btn.setStyleSheet(get_preset_day_button_stylesheet())
            btn.clicked.connect(lambda checked, v=val: self.confluence_spin.setValue(self.confluence_spin.value() + v))
            confluence_layout.addWidget(btn)
        
        # Increment buttons
        for val in [+1, +2]:
            btn = QPushButton(f"+{val}")
            btn.setFixedSize(75, 50)
            btn.setStyleSheet(get_preset_day_button_stylesheet())
            btn.clicked.connect(lambda checked, v=val: self.confluence_spin.setValue(self.confluence_spin.value() + v))
            confluence_layout.addWidget(btn)
        
        self.confluence_spin = QSpinBox()
        self.confluence_spin.setRange(0, 100)
        self.confluence_spin.setValue(40)
        self.confluence_spin.setSuffix(" pts")
        self.confluence_spin.setFixedWidth(150)
        self.confluence_spin.setStyleSheet(get_spinbox_button_stylesheet())
        self.confluence_spin.setToolTip(
            "Minimum Confluence Points (Strategy-Specific)\n\n"
            "Required signal strength for trade entry.\n"
            "⚠️ Points vary based on selected strategy!\n\n"
            "How Confluence Works:\n"
            "• Each building block contributes points\n"
            "• Required signals: Always add points\n"
            "• Optional signals: Bonus points\n"
            "• Timing requirements: Must align\n\n"
            "Example Strategy (5 blocks, 9 total signals):\n"
            "• Pattern detection: 25 pts (required)\n"
            "• Volume confirmation: 15 pts (required)\n"
            "• Trend alignment: 10 pts (optional)\n"
            "• Support/Resistance: 10 pts (optional)\n"
            "• Indicator agreement: 15 pts (optional)\n"
            "Total possible: 75 pts\n\n"
            "Setting Guidelines:\n"
            "• 20-30 pts: Aggressive (required signals only)\n"
            "• 40-60 pts: Balanced (required + some optional)\n"
            "• 70+ pts: Conservative (require most optionals)\n\n"
            "Recommendation:\n"
            "Start at 40 pts and adjust based on:\n"
            "• Too many trades? Raise confluence\n"
            "• Too few trades? Lower confluence\n"
            "• Check your strategy's signal distribution!"
        )
        confluence_layout.addWidget(self.confluence_spin)
        layout.addLayout(confluence_layout)
        
        # Max Bars Held WITH QUICK-SET BUTTONS
        bars_layout = QHBoxLayout()
        bars_layout.setSpacing(8)
        
        bars_label = QLabel("Max Bars Held:")
        bars_label.setStyleSheet(get_label_style('muted'))
        bars_layout.addWidget(bars_label)
        
        # Quick preset buttons - UNIFORM GRID
        for val in [15, 20, 25, 30, 40, 50, 75]:
            btn = QPushButton(str(val))
            btn.setFixedSize(75, 50)
            btn.setStyleSheet(get_preset_day_button_stylesheet())
            btn.clicked.connect(lambda checked, v=val: self.max_bars_spin.setValue(v))
            bars_layout.addWidget(btn)
        
        self.max_bars_spin = QSpinBox()
        self.max_bars_spin.setRange(1, 500)
        self.max_bars_spin.setValue(200)
        self.max_bars_spin.setSuffix(" bars")
        self.max_bars_spin.setFixedWidth(150)
        self.max_bars_spin.setStyleSheet(get_spinbox_button_stylesheet())
        self.max_bars_spin.setToolTip(
            "Maximum Position Hold Time\n\n"
            "Auto-close trades that exceed this duration.\n\n"
            "Purpose:\n"
            "• Prevents stuck positions\n"
            "• Forces capital recycling\n"
            "• Limits opportunity cost\n\n"
            "Examples (15m timeframe):\n"
            "• 50 bars: 12.5 hours max hold\n"
            "• 200 bars: 50 hours (~2 days)\n"
            "• 500 bars: 125 hours (~5 days)\n\n"
            "Guidelines:\n"
            "• Scalping: 20-100 bars\n"
            "• Day trading: 100-300 bars\n"
            "• Swing: 300+ bars"
        )
        bars_layout.addWidget(self.max_bars_spin)
        layout.addLayout(bars_layout)
        
        layout.addStretch()
        group.setLayout(layout)
        return group
    
    def _create_progress_group(self) -> QGroupBox:
        """Create progress monitoring group - COMPACT INLINE DESIGN"""
        group = QGroupBox("Progress")
        group.setStyleSheet(get_groupbox_header_stylesheet())
        layout = QVBoxLayout()
        layout.setSpacing(8)
        
        # Progress Bar
        self.progress_bar = QProgressBar()
        self.progress_bar.setValue(0)
        self.progress_bar.setMaximumHeight(20)
        layout.addWidget(self.progress_bar)
        
        # ALL STATS ON ONE INLINE ROW - COMPACT
        stats_line = QHBoxLayout()
        stats_line.setSpacing(20)
        stats_line.setContentsMargins(0, 0, 0, 0)
        
        # Candles (inline)
        candles_widget = QLabel("Candles: <b>0 / 0</b>")
        from src.strategy_builder.ui.styles import get_color
        candles_widget.setStyleSheet(f"color: {get_color('text_primary')};")
        self.candles_label = candles_widget  # Store reference
        stats_line.addWidget(candles_widget)
        
        # Separator
        sep1 = QLabel("|")
        sep1.setStyleSheet(f"color: {get_color('border')};")
        stats_line.addWidget(sep1)
        
        # Trades (inline)
        trades_widget = QLabel("Trades: <b>0</b>")
        trades_widget.setStyleSheet(f"color: {get_color('text_primary')};")
        self.trades_label = trades_widget  # Store reference
        stats_line.addWidget(trades_widget)
        
        # Separator
        sep2 = QLabel("|")
        sep2.setStyleSheet(f"color: {get_color('border')};")
        stats_line.addWidget(sep2)
        
        # TP/SL Adjustments (inline with breakdown)
        adj_widget = QLabel("TP/SL Adjustments: <b>0</b> <span style='color: #9AA0A6;'>(TP1: 0, TP2: 0, TP3: 0, SL: 0)</span>")
        adj_widget.setStyleSheet(f"color: {get_color('text_primary')};")
        self.adjustments_label = adj_widget  # Store reference
        self.breakdown_label = adj_widget  # Same widget contains breakdown
        stats_line.addWidget(adj_widget)
        
        stats_line.addStretch()
        layout.addLayout(stats_line)
        
        group.setLayout(layout)
        return group
    
    def _create_control_buttons(self) -> QHBoxLayout:
        """Create control button layout"""
        layout = QHBoxLayout()
        
        # Run Button
        self.run_btn = QPushButton("▶️ Run Test")
        self.run_btn.clicked.connect(self._on_run_clicked)
        self.run_btn.setStyleSheet(get_primary_button_stylesheet())
        self.run_btn.setToolTip("Run the walk-forward backtest with the current configuration")
        layout.addWidget(self.run_btn)
        
        # Pause Button
        self.pause_btn = QPushButton("⏸️ Pause")
        self.pause_btn.clicked.connect(self._on_pause_clicked)
        self.pause_btn.setEnabled(False)
        self.pause_btn.setToolTip("Pause the currently running backtest")
        layout.addWidget(self.pause_btn)
        
        # Stop Button
        self.stop_btn = QPushButton("⏹️ Stop")
        self.stop_btn.clicked.connect(self._on_stop_clicked)
        self.stop_btn.setEnabled(False)
        self.stop_btn.setToolTip("Stop and cancel the currently running backtest")
        layout.addWidget(self.stop_btn)
        
         # CONFIG DISCOVERY Button — Phase 3 launcher
        self.config_discovery_btn = QPushButton("Config Discovery")
        self.config_discovery_btn.clicked.connect(self._on_config_discovery_clicked)
        self.config_discovery_btn.setStyleSheet(get_primary_button_stylesheet(compact=True))
        self.config_discovery_btn.setToolTip(
            "Config Discovery\n\n"
            "Runs N permutations of strategy parameters and shows ranked results.\n\n"
            "Metrics per run:\n"
            "  Total PnL, Win Rate, Sharpe Ratio\n"
            "  Exit Type Distribution (TP1/TP2/TP3/SL/Time)\n"
            "  Avg PnL per Trade, Avg Bars Held\n\n"
            "Shows gold/silver/bronze badges for:\n"
            "  Most Profitable, Best Sharpe, Most Frequent\n\n"
            "Uses cached bars for speed (no repeated data loading)."
        )
        layout.addWidget(self.config_discovery_btn)
        
        layout.addStretch()
        
        # View Results Button
        self.results_btn = QPushButton("💠 View Live Results")
        self.results_btn.setEnabled(False)
        self.results_btn.setToolTip("View the detailed results from the most recently completed backtest")
        layout.addWidget(self.results_btn)
        
        return layout
    
    def _apply_calibration_results(self, blocks: list, delay_map: dict) -> None:
        """Apply a delay_map from calibration results to strategy blocks in-place.

        Called from both the cache-hit path and the live calibration path so
        the delay-application logic lives in exactly one place.

        Args:
            blocks: List of block dicts from strategy_config_dict['blocks'].
                    Each dict is modified in-place with ``optimal_delay``.
            delay_map: Mapping of block name → optimal delay (int bars).
        """
        for block in blocks:
            bname = block.get('name') or block.get('block_name', '')
            if bname in delay_map:
                block['optimal_delay'] = delay_map[bname]
                logger.info(
                    f"Auto-calibration: applied optimal_delay={delay_map[bname]} "
                    f"to block '{bname}'"
                )

    # ------------------------------------------------------------------
    # Calibration disk-cache helpers
    # ------------------------------------------------------------------

    def _load_calibration_disk_cache(self) -> None:
        """Populate in-memory calibration cache from disk on startup."""
        fp, dm = calibration_cache.load_cache()
        if fp is not None:
            self._calibration_fingerprint = fp
            self._calibration_cache = dm
            self._calibration_cache_from_disk = True
            logger.info(
                "Auto-calibration: cache loaded from disk — "
                "cache hit (loaded from disk) on next matching run."
            )

    def _save_calibration_disk_cache(self) -> None:
        """Atomically write fingerprint + delay_map to disk."""
        calibration_cache.save_cache(
            self._calibration_fingerprint,
            self._calibration_cache,
        )
    def _repair_if_unreachable(self, strategy_config_dict: dict) -> Optional[dict]:
        """Check whether the strategy can theoretically reach its confluence threshold.

        If the sum of all configured signal weights is less than the threshold,
        the backtest would produce zero trades regardless of market conditions.
        The strategy config is sourced from the PostgreSQL database (source of truth),
        not from JSON files — no automatic repair is attempted.

        Returns the config dict if reachable, or None to abort the run.
        """
        blocks = strategy_config_dict.get('blocks', [])
        threshold = strategy_config_dict.get('confluence_threshold', 40)
        max_possible = sum(
            (s.get('weight') or 10)
            for block in blocks
            for s in block.get('signals', [])
        )

        if max_possible >= threshold:
            return strategy_config_dict  # Reachable — nothing to do

        self.results_text.setText(
            f"❌ Unreachable confluence threshold: {max_possible}pts max "
            f"< {threshold}pt threshold.\n\n"
            f"Every bar will score below threshold → 0 trades guaranteed.\n"
            f"Lower the threshold or add more blocks to the strategy in the UI."
        )
        return None

    def _run_auto_calibration(self, strategy_config_dict: dict) -> None:
        """
        Run signal calibration automatically on all strategy blocks before backtest.

        Calibration parameters (hardcoded):
        - Timeframe: 15m
        - Lookback: 180 days
        - Mode: production (full data)

        A SHA-256 fingerprint of the calibration inputs (sorted block names,
        timeframe, period, mode) is computed before each run.  If the fingerprint
        matches the one from the last successful calibration, the cached
        ``delay_map`` is applied directly and calibration is skipped.

        On success, optimal delay parameters are applied to each block in
        strategy_config_dict in-place.

        On any failure the method logs a warning and returns without modifying
        the config so the backtest proceeds with uncalibrated parameters
        (graceful degradation — calibration failure never blocks the backtest).
        """
        blocks = strategy_config_dict.get('blocks', [])
        if not blocks:
            logger.info("Auto-calibration: no blocks found, skipping.")
            return

        block_names = sorted(
            b.get('name') or b.get('block_name') or f"block_{i}"
            for i, b in enumerate(blocks)
        )

        # Compute fingerprint of the current calibration inputs
        current_fingerprint = calibration_cache.compute_fingerprint(
            block_names=block_names,
            timeframe="15m",
            period_days=180,
            mode="production",
        )

        # Cache-hit path: settings unchanged since last successful calibration
        if (
            self._calibration_fingerprint is not None
            and self._calibration_cache is not None
            and current_fingerprint == self._calibration_fingerprint
        ):
            _source = "loaded from disk" if self._calibration_cache_from_disk else "in-session"
            logger.info(f"Auto-calibration: cache hit ({_source}) — applying cached delay_map.")
            self.results_text.setText(
                "✓ Calibration already complete for current settings — skipping. Using cached parameters."
            )
            QApplication.processEvents()
            # Apply cached delay_map to blocks in-place
            cached_delay_map = self._calibration_cache
            for block in blocks:
                bname = block.get('name') or block.get('block_name', '')
                if bname in cached_delay_map:
                    block['optimal_delay'] = cached_delay_map[bname]
                    logger.info(
                        f"Auto-calibration: applied cached optimal_delay={cached_delay_map[bname]} "
                        f"to block '{bname}'"
                    )
            return

        # Cache-miss path: settings changed or first run — run calibration
        self.results_text.setText(
            "⚙️ Calibration required — running calibration before backtest..."
        )
        QApplication.processEvents()

        # Show indeterminate progress animation while calibration runs
        self.progress_bar.setRange(0, 0)
        self.progress_bar.setFormat("Calibrating blocks...")
        self.progress_bar.setValue(0)
        self.run_btn.setEnabled(False)
        QApplication.processEvents()

        self.results_text.append(
            "⚙️ Running signal calibration on all blocks (15m)...\n"
            "This may take a moment."
        )
        QApplication.processEvents()

        try:
            from src.optimizer_v3.core.training_thread import TrainingThread

            # Run the training thread synchronously in the current thread by
            # calling its run() logic directly via a temporary QThread.
            # We use a blocking event-loop wait to keep things safe.
            calibration_thread = TrainingThread(
                selected_blocks=block_names,
                mode='production',
                period_days=180,
                selected_timeframes=['15m'],
                logger=None,
            )

            calibration_results: list = []

            def _on_complete(results: list) -> None:
                calibration_results.extend(results)

            calibration_thread.training_complete.connect(_on_complete)
            calibration_thread.start()

            # Wait up to 60 seconds; UI stays responsive via processEvents
            waited_ms = 0
            while calibration_thread.isRunning() and waited_ms < 60_000:
                calibration_thread.wait(200)
                QApplication.processEvents()
                waited_ms += 200

            if calibration_thread.isRunning():
                calibration_thread.stop()
                calibration_thread.wait(2000)
                logger.warning("Auto-calibration timed out; proceeding with uncalibrated parameters.")
                self.results_text.append(
                    "⚠️ Calibration timed out. Proceeding without calibration."
                )
                # Reset progress bar before returning; run_btn stays disabled
                # (the subsequent backtest launch in _on_run_clicked will keep it
                # disabled, so we must NOT re-enable here — the existing
                # completion handler at line ~2576 handles re-enable on finish).
                self.progress_bar.setRange(0, 100)
                self.progress_bar.setValue(0)
                self.progress_bar.setFormat("%p%")
                return

            # Gap 2 fix: ensure thread fully terminated and signal queue flushed.
            # isRunning() returning False does not guarantee training_complete has
            # been delivered — wait() blocks until the QThread's event loop exits,
            # and processEvents() drains any queued cross-thread signals so that
            # _on_complete() fires before we read calibration_results below.
            calibration_thread.wait()
            QApplication.processEvents()

            # Guard: skip applying results when TrainingThread is in simulation
            # mode (random/dummy delays) to protect manually-tuned block delays.
            if calibration_thread.is_simulation_mode:
                logger.info(
                    "Auto-calibration: skipped apply step (simulation mode) — "
                    "using configured block delays."
                )
                self.results_text.append(
                    "⚙️ Calibration skipped (simulation mode) — using configured block delays"
                )
            else:
                # Gap 1 fix: store fingerprint unconditionally whenever calibration
                # ran to completion — empty calibration_results means "calibration
                # ran and produced no delay-map entries", which is still a valid
                # cached outcome.  Without this, an empty-result run would never
                # write _calibration_fingerprint and every subsequent call would
                # bypass the cache and trigger a redundant full calibration run.
                delay_map: dict = {}
                if calibration_results:
                    for r in calibration_results:
                        name = r.get('signal_name', '')
                        delay = r.get('optimal_delay')
                        if name and delay is not None:
                            delay_map[name] = int(delay)

                    # Apply delay_map to blocks in-place
                    for block in blocks:
                        bname = block.get('name') or block.get('block_name', '')
                        if bname in delay_map:
                            block['optimal_delay'] = delay_map[bname]
                            logger.info(
                                f"Auto-calibration: applied optimal_delay={delay_map[bname]} "
                                f"to block '{bname}'"
                            )

                # Cache fingerprint and delay_map (empty or not) so the next
                # call with the same blocks skips calibration entirely.
                # (not reached in simulation_mode — see guard above)
                self._calibration_fingerprint = current_fingerprint
                self._calibration_cache = delay_map
                self._calibration_cache_from_disk = False
                logger.info("Auto-calibration: cache updated with new fingerprint.")
                self._save_calibration_disk_cache()

            self.results_text.append("✓ Calibration complete. Starting backtest...")
            # Reset progress bar; run_btn remains disabled until backtest finishes
            self.progress_bar.setRange(0, 100)
            self.progress_bar.setValue(0)
            self.progress_bar.setFormat("%p%")
            QApplication.processEvents()

        except Exception as e:
            logger.warning(f"Auto-calibration failed (non-blocking): {e}")
            self.results_text.append(
                f"⚠️ Calibration skipped ({e}). Proceeding with uncalibrated parameters."
            )
            # Reset progress bar on exception; run_btn re-enable handled by
            # backtest completion logic so we leave it disabled here.
            self.progress_bar.setRange(0, 100)
            self.progress_bar.setValue(0)
            self.progress_bar.setFormat("%p%")
            QApplication.processEvents()


    def _on_run_clicked(self):
        """Handle run button click.

        Sequence of operations when the user clicks "▶️ Run Test":

        1. **Auto-calibration** (via ``_run_auto_calibration``):
           Before the backtest starts, signal calibration is run automatically
           on all building blocks in the loaded strategy.  Parameters are fixed:
           - Timeframe: 15m
           - Lookback: 180 days
           - Mode: production (full data)
           The Config tab displays "⚙️ Calibrating all blocks (15m, 180 days)..."
           while calibration is in progress.  If calibration fails or times out,
           a warning is shown in the Config panel and the backtest proceeds with
           uncalibrated parameters (graceful degradation — calibration failure
           never blocks the backtest).

        2. **Backtest execution**:
           After calibration completes (or is skipped on failure), the backtest
           is launched with the user-specified parameters (lookback period,
           timeframe, TP/SL settings, etc.).  The Live Output tab activates and
           streams real-time progress.

        Note: The dedicated "⚙️ Calibrate" tab that previously existed in the
        BacktestConfigDialog has been removed (see BTCAAAAA-338).  All
        calibration is now handled automatically here, requiring no user action.
        """
        # CRITICAL: Close ALL PostgreSQL connections in MAIN THREAD FIRST
        # Main UI thread has open connections from strategy loading (strategy_builder_main_window, browser_dialog, etc.)
        # These connections will be inherited by fork() when bar_aggregator creates 31 workers
        # Must close BEFORE any worker/thread creation
        try:
            from src.optimizer_v3.database import get_database_manager
            db = get_database_manager()
            if hasattr(db, 'engine') and db.engine is not None:
                db.engine.dispose()  # Force close all connections in pool
                logger.info("✅ Pre-backtest cleanup: Closed PostgreSQL connections in main thread")
        except Exception as e:
            logger.warning(f"⚠️ Could not close database connections in main thread: {e}")
        
        # Validate strategy
        validation = self.orchestrator.validate_strategy()
        if not validation.success:
            self.results_text.setText(f"❌ Strategy validation failed:\n{validation.message}")
            return
        
        # INSTITUTIONAL PATTERN: Serialize config BEFORE creating worker
        try:
            strategy_config_dict = self.orchestrator.serialize_config_for_backtest()
        except ValueError as e:
            self.results_text.setText(f"❌ Failed to prepare strategy:\n{str(e)}")
            return
        
        # CRITICAL FIX: Inject UI confluence threshold into strategy config
        # The serialized config doesn't include UI values - must add manually
        strategy_config_dict['confluence_threshold'] = self.confluence_spin.value()

        # CONFLUENCE REACHABILITY CHECK: if configured signals can never reach the
        # threshold (e.g. a block was dropped from the DB copy of the strategy),
        # abort with error — no automatic repair from stale JSON files.
        strategy_config_dict = self._repair_if_unreachable(strategy_config_dict)
        if strategy_config_dict is None:
            return  # Blocked — error already shown in results_text

        # AUTO-CALIBRATION: Run signal calibration on all blocks before backtest
        self._run_auto_calibration(strategy_config_dict)

        # Sprint 2.0.1: Get configuration with calculated dates and timeframe
        backtest_config = self.get_config()
        
        # INSTITUTIONAL OPTIMIZATION: Check data cache
        cached_bars = self.cache_manager.get_cached_bars(backtest_config)
        
        if cached_bars:
            # Cache hit - show performance message
            metrics = self.cache_manager.get_metrics()
            self.results_text.append(
                f"⚡ Cache HIT: Using {len(cached_bars):,} cached bars\n"
                f"⏱️ Time saved: ~12 seconds\n"
                f"📊 Cache hit rate: {metrics['hit_rate_pct']:.1f}%\n\n"
                f"Starting backtest with cached data..."
            )
            self._update_cache_status()
        else:
            # Cache miss - will load fresh data
            self.results_text.append(
                "🔄 Cache MISS: Loading fresh data from DataManager...\n"
                "This will take ~10-15 seconds.\n\n"
                "💡 Future tests with same data config will be instant!"
            )
        
        # Clear previous trades before starting new backtest
        # CRITICAL: Clear TradeRegistry (single source of truth) FIRST
        from src.optimizer_v3.core.trade_registry import get_trade_registry
        registry = get_trade_registry()
        registry.clear()
        
        # Then clear UI panel
        self.trades_panel.clear_trades()
        
        # Create worker with serialized config AND cached bars (if available)
        self.worker = BacktestWorker(
            strategy_config=strategy_config_dict,
            backtest_config=backtest_config,
            output_panel=self.output_panel,
            trades_panel=self.trades_panel,  # MULTICORE FIX: Pass trades panel reference
            cached_bars=cached_bars  # INSTITUTIONAL OPTIMIZATION: Pass cached bars
        )
        self.worker.progress_updated.connect(self._on_progress_updated)
        self.worker.backtest_finished.connect(self._on_backtest_finished)
        # Connect live messages to output panel for REAL-TIME display
        self.worker.live_message.connect(self.output_panel.add_message)
        # Connect trade_data_emit signal - handles both OPEN (add) and CLOSED (update)
        self.worker.trade_data_emit.connect(self._on_trade_data)
        # Connect stdout capture to Status panel (shows data loading progress)
        self.worker.status_message.connect(self._on_status_message)
        self.worker.start()
        
        # Update UI state
        self.run_btn.setEnabled(False)
        self.pause_btn.setEnabled(True)
        self.stop_btn.setEnabled(True)
        self.results_btn.setEnabled(True)
        
        # Update Live Output icon to green (running) - both panel title AND tab text  
        self.output_panel.set_running(True)
        self.tab_widget.setTabText(self.live_output_tab_index, "▶ Live Output")
        # Apply green color
        self._set_live_output_color("green")
        
        self.results_text.append("🔄 Backtest started...")
    
    def _on_pause_clicked(self):
        """Handle pause button click"""
        if self.worker and self.worker.isRunning():
            if self.worker.is_paused:
                self.worker.resume()
                self.pause_btn.setText("⏸️ Pause")
                self.results_text.append("▶️ Resumed")
            else:
                self.worker.pause()
                self.pause_btn.setText("▶️ Resume")
                self.results_text.append("⏸️ Paused")
    
    def _on_stop_clicked(self):
        """Handle stop button click"""
        if self.worker and self.worker.isRunning():
            self.worker.stop()
            self.results_text.append("⏹️ Stopping...")
    
    def _on_trade_data(self, trade_data: dict):
        """
        Handle trade data from worker - intelligently adds OPEN or updates to CLOSED.
        
        CRITICAL: Supports BOTH execution modes:
        - Single-core: OPEN (add) → CLOSED (update)
        - Multicore: CLOSED only (add directly, no prior OPEN)
        
        When status is OPEN: Add new trade to table
        When status is CLOSED: Try update first, fall back to add if doesn't exist
        """
        trade_id = trade_data.get('id')
        status = trade_data.get('status')
        
        if status == 'OPEN':
            # Single-core: New trade opened - add to table
            self.trades_panel.add_trade(trade_data)
        elif status == 'CLOSED':
            # Try to update existing trade (single-core case)
            # If update fails/returns False, add as new (multicore case)
            try:
                success = self.trades_panel.update_trade(trade_id, trade_data)
                if not success:
                    # Trade didn't exist - add it (multicore case)
                    self.trades_panel.add_trade(trade_data)
            except (AttributeError, KeyError, Exception):
                # Any error means trade doesn't exist - add it (multicore case)
                self.trades_panel.add_trade(trade_data)
    
    def _on_status_message(self, message: str):
        """
        Handle captured stdout message from BacktestWorker.
        
        Appends data loading progress (from DataManager/NautilusLoader/BarAggregator)
        to the Status panel in real-time.
        
        Args:
            message: Captured stdout line from print() calls
        """
        self.results_text.append(message)
        # Auto-scroll to bottom
        scrollbar = self.results_text.verticalScrollBar()
        scrollbar.setValue(scrollbar.maximum())
    
    def _on_progress_updated(self, current: int, total: int, message: str):
        """Handle progress update from worker - INLINE HTML FORMAT"""
        progress_pct = int((current / total) * 100) if total > 0 else 0
        self.progress_bar.setValue(progress_pct)
        self.candles_label.setText(f"Candles: <b>{current:,} / {total:,}</b>")
    
    def _on_backtest_finished(self, success: bool, results: dict):
        """Handle backtest completion - POPULATE ALL TABS"""
        # Update UI state
        self.run_btn.setEnabled(True)
        self.pause_btn.setEnabled(False)
        self.stop_btn.setEnabled(False)
        self.pause_btn.setText("⏸️ Pause")
        
        # Update Live Output icon to stopped (idle) - both panel title AND tab text
        self.output_panel.set_running(False)
        self.tab_widget.setTabText(self.live_output_tab_index, "● Live Output")
        # Apply red color
        self._set_live_output_color("red")
        
        if success:
            # CRITICAL FIX: Sync trades from TradeRegistry (single source of truth)
            # This replaces any duplicate trades received via signals with unique trades only
            logger.info("📊 Syncing trades from TradeRegistry...")
            self.trades_panel.sync_from_registry()
            
            # Update displays - INLINE HTML FORMAT
            trades = results.get('trades', 0)
            self.trades_label.setText(f"Trades: <b>{trades}</b>")
            
            tp_adj = results.get('tp_adjustments', {})
            total_adj = sum(tp_adj.values())
            breakdown = f"(TP1: {tp_adj.get('TP1', 0)}, TP2: {tp_adj.get('TP2', 0)}, TP3: {tp_adj.get('TP3', 0)}, SL: {tp_adj.get('SL', 0)})"
            self.adjustments_label.setText(
                f"TP/SL Adjustments: <b>{total_adj}</b> <span style='color: #9AA0A6;'>{breakdown}</span>"
            )
            
            # Show results in Config tab
            self.results_text.append(f"\n✅ Backtest completed successfully!")
            self.results_text.append(f"Total Candles: {results.get('total_candles', 0):,}")
            self.results_text.append(f"Trades: {results.get('trades', 0)}")
            self.results_text.append(f"TP/SL Adjustments: {total_adj}")
            
            # ✅ POPULATE OTHER TABS WITH RESULTS
            self._populate_tabs_with_results(results)
        else:
            error = results.get('error', 'Unknown error')
            self.results_text.append(f"\n❌ Backtest failed: {error}")
            self.output_panel.add_message(f"Backtest failed: {error}", "ERROR", "SYSTEM")
        
        self.worker = None
    
    def _populate_tabs_with_results(self, results: dict):
        """Populate all tabs with backtest results"""
        from nautilus_trader.model.objects import Money, Quantity, Price, Currency
        from decimal import Decimal
        from datetime import datetime, timedelta
        from src.debugger_logger.config_debugger import ConfigDebugger
        from pathlib import Path
        
        # Initialize AI debugger for complete pipeline tracing
        # CRITICAL: Enable file logging (global flag)
        ConfigDebugger.LOGFILE_ENABLED = True
        ai_debugger = ConfigDebugger(
            name="AI_Recommendations",
            log_file=Path("logs/ai_recommendations.log")
        )
        
        # ============================================================================
        # CRITICAL FIX 2026-02-12: Use TradeRegistry as SINGLE SOURCE OF TRUTH
        # Previous code used HARDCODED metrics (0.58 win rate, fake PnL values)
        # This caused Summary 2 to show wrong metrics (+$810.91 error!)
        # ============================================================================
        
        # Get ACTUAL trades from TradeRegistry (single source of truth)
        from src.optimizer_v3.core.trade_registry import get_trade_registry
        registry = get_trade_registry()
        all_trades = registry.get_all_trades()
        
        trade_count = len(all_trades)
        
        # LOG POINT 1: Backtest completion
        ai_debugger.log_action(
            action="BACKTEST_COMPLETE",
            config_keys_used=[],
            parameters={
                'total_candles': results.get('total_candles'),
                'total_trades': trade_count,
                'tp_adjustments': results.get('tp_adjustments')
            }
        )
        
        # Add completion message to Live Output
        self.output_panel.add_message(
            f"Backtest completed successfully! {trade_count} trades executed.", 
            "INFO", 
            "SYSTEM"
        )
        self.output_panel.add_message(
            f"Total candles processed: {results.get('total_candles', 0):,}", 
            "INFO", 
            "SYSTEM"
        )
        
        # Calculate REAL metrics from ACTUAL trades (NO MORE FAKE DATA!)
        if trade_count > 0:
            # Extract PnL values
            pnl_values = [t['pnl'] for t in all_trades]
            total_pnl = sum(pnl_values)
            winning_trades = sum(1 for p in pnl_values if p > 0)
            losing_trades = sum(1 for p in pnl_values if p < 0)
            win_rate = (winning_trades / trade_count) * 100
            
            # Calculate win/loss metrics
            wins = [p for p in pnl_values if p > 0]
            losses = [p for p in pnl_values if p < 0]
            
            avg_win = sum(wins) / len(wins) if wins else 0
            avg_loss = sum(losses) / len(losses) if losses else 0
            largest_win = max(wins) if wins else 0
            largest_loss = min(losses) if losses else 0
            
            # Calculate profit factor (gross profit / gross loss)
            gross_profit = sum(wins) if wins else 0
            gross_loss = abs(sum(losses)) if losses else 0
            profit_factor = gross_profit / gross_loss if gross_loss > 0 else 0
            
            # Calculate risk metrics
            import numpy as np
            pnl_array = np.array(pnl_values)
            std_dev = float(np.std(pnl_array))
            downside_returns = pnl_array[pnl_array < 0]
            downside_dev = float(np.std(downside_returns)) if len(downside_returns) > 0 else 0
            
            # Calculate max drawdown
            cumulative_pnl = np.cumsum(pnl_array)
            running_max = np.maximum.accumulate(cumulative_pnl)
            drawdown = cumulative_pnl - running_max
            max_drawdown = float(np.min(drawdown))
            max_drawdown_pct = (max_drawdown / self.capital_spin.value()) * 100 if self.capital_spin.value() > 0 else 0
            
            # Calculate Sharpe & Sortino (simplified)
            avg_pnl = total_pnl / trade_count
            sharpe_ratio = (avg_pnl / std_dev) if std_dev > 0 else 0
            sortino_ratio = (avg_pnl / downside_dev) if downside_dev > 0 else 0
            
            # Total return %
            starting_capital = self.capital_spin.value()
            total_return = (total_pnl / starting_capital) * 100 if starting_capital > 0 else 0

            # ── P1 Risk Metrics: calculated from real trade data ─────────────
            # Max drawdown duration (number of trades in the longest drawdown period)
            in_drawdown = drawdown < 0
            max_dd_duration = 0
            current_dd_len = 0
            for is_dd in in_drawdown:
                if is_dd:
                    current_dd_len += 1
                    if current_dd_len > max_dd_duration:
                        max_dd_duration = current_dd_len
                else:
                    current_dd_len = 0

            # Value at Risk 95% — 5th percentile of trade P&L distribution
            var_95 = float(np.percentile(pnl_array, 5)) if trade_count > 0 else 0.0

            # Expected Shortfall (CVaR) — mean of losses beyond VaR threshold
            tail_threshold = var_95
            tail_losses = pnl_array[pnl_array <= tail_threshold]
            expected_shortfall = float(np.mean(tail_losses)) if len(tail_losses) > 0 else var_95

            # Max consecutive losses and wins
            max_consecutive_losses = 0
            max_consecutive_wins = 0
            _cur_losses = 0
            _cur_wins = 0
            for p in pnl_values:
                if p < 0:
                    _cur_losses += 1
                    _cur_wins = 0
                    if _cur_losses > max_consecutive_losses:
                        max_consecutive_losses = _cur_losses
                else:
                    _cur_wins += 1
                    _cur_losses = 0
                    if _cur_wins > max_consecutive_wins:
                        max_consecutive_wins = _cur_wins

            # Average drawdown — mean of all drawdown values (non-zero only)
            dd_values = drawdown[drawdown < 0]
            avg_drawdown = float(np.mean(dd_values)) if len(dd_values) > 0 else 0.0

            # Ulcer Index — RMS of percentage drawdowns (measures drawdown pain)
            # UI = sqrt( mean( (drawdown_pct_i)^2 ) ) across all observations
            if starting_capital > 0:
                drawdown_pcts = (drawdown / starting_capital) * 100  # as % of capital
            else:
                drawdown_pcts = drawdown * 0
            ulcer_index = float(np.sqrt(np.mean(drawdown_pcts ** 2))) if trade_count > 0 else 0.0
            
        else:
            # No trades - all zeros
            total_pnl = 0
            winning_trades = 0
            losing_trades = 0
            win_rate = 0
            avg_win = 0
            avg_loss = 0
            largest_win = 0
            largest_loss = 0
            profit_factor = 0
            std_dev = 0
            downside_dev = 0
            max_drawdown = 0
            max_drawdown_pct = 0
            sharpe_ratio = 0
            sortino_ratio = 0
            total_return = 0
            max_dd_duration = 0
            var_95 = 0.0
            expected_shortfall = 0.0
            max_consecutive_losses = 0
            max_consecutive_wins = 0
            avg_drawdown = 0.0
            ulcer_index = 0.0
        
        # Build metrics dict with REAL values ONLY
        metrics_data = {
            'total_pnl': Decimal(str(total_pnl)),
            'total_return': Decimal(str(total_return)),
            'sharpe_ratio': Decimal(str(sharpe_ratio)),
            'win_rate': Decimal(str(win_rate)),
            'profit_factor': Decimal(str(profit_factor)),
            'max_drawdown': Decimal(str(max_drawdown)),
            'total_trades': trade_count,
            'avg_trade_pnl': Decimal(str(total_pnl / trade_count)) if trade_count > 0 else Decimal('0'),
            'avg_win': Decimal(str(avg_win)),
            'avg_loss': Decimal(str(avg_loss)),
            'largest_win': Decimal(str(largest_win)),
            'largest_loss': Decimal(str(largest_loss)),
            'risk_reward_ratio': Decimal(str(abs(avg_win / avg_loss))) if avg_loss != 0 else Decimal('0'),
            'recovery_factor': Decimal(str(total_pnl / abs(max_drawdown))) if max_drawdown != 0 else Decimal('0'),
            # Risk metrics
            'max_drawdown_pct': Decimal(str(max_drawdown_pct)),
            'max_drawdown_duration': max_dd_duration,
            'var_95': Decimal(str(var_95)),
            'expected_shortfall': Decimal(str(expected_shortfall)),
            'sortino_ratio': Decimal(str(sortino_ratio)),
            'calmar_ratio': Decimal(str(total_return / abs(max_drawdown_pct))) if max_drawdown_pct != 0 else Decimal('0'),
            'max_consecutive_losses': max_consecutive_losses,
            'max_consecutive_wins': max_consecutive_wins,
            'avg_drawdown': Decimal(str(avg_drawdown)),
            'std_deviation': Decimal(str(std_dev)),
            'downside_deviation': Decimal(str(downside_dev)),
            'ulcer_index': Decimal(str(ulcer_index)),
        }
        
        # Add metrics summary to Live Output
        self.output_panel.add_message(
            f"Performance Summary: {trade_count} trades, "
            f"Win Rate: {float(metrics_data['win_rate']):.1f}%, "
            f"Total PnL: ${float(metrics_data['total_pnl']):.2f}",
            "INFO",
            "OPTIMIZER"
        )
        
        # ✅ CRITICAL: Update metrics WITH backtest_complete=True AND full results to trigger AI recommendations
        logger.info("[Backtest] COMPLETE - Triggering AI recommendations...")
        # FIXED: Pass full results dict (includes trade list) for AI analysis
        full_results = {
            'metrics': metrics_data,
            'trades': [],  # Will be populated from trades_panel
            'total_candles': results.get('total_candles', 0),
            'tp_adjustments': results.get('tp_adjustments', {}),
            'strategy_config': results.get('strategy_config', {}),  # BTCAAAAA-736: thread through
        }
        
        # Get trade list from trades panel
        if hasattr(self.trades_panel, 'get_all_trades'):
            full_results['trades'] = self.trades_panel.get_all_trades()
            
            # LOG POINT 2: Trade retrieval (CRITICAL - shows if trades are empty!)
            ai_debugger.log_action(
                action="TRADES_RETRIEVED",
                config_keys_used=[],
                parameters={
                    'trade_count': len(full_results['trades']),
                    'first_trade_id': full_results['trades'][0].get('id') if full_results['trades'] else None,
                    'has_trades': len(full_results['trades']) > 0
                }
            )
        
        self.metrics_panel.update_metrics(metrics_data, backtest_complete=True, backtest_results=full_results)

        # ── Persist backtest results to strategy_test_results ──────────────────
        # Only persist when a strategy has been saved (both IDs available).
        try:
            from src.optimizer_v3.database import get_database_manager
            from datetime import datetime

            # BTCAAAAA-33: Read IDs from orchestrator (set by main window on strategy load).
            # self.parent_window is BacktestConfigDialog, NOT StrategyBuilderMainWindow,
            # so the old getattr(self.parent_window, 'current_strategy_id', None) always
            # returned None and persistence was silently skipped for every test.
            strategy_id = getattr(self.orchestrator, 'current_strategy_id', None)
            version_id = getattr(self.orchestrator, 'current_version_id', None)

            if strategy_id and version_id:
                backtest_config = self.get_config()

                # Convert Decimal/int metrics to plain Python scalars for JSON serialisation
                _total_trades = int(metrics_data.get('total_trades', 0))
                _win_rate = float(metrics_data.get('win_rate', 0))
                # Derive win/loss counts from total_trades and win_rate (win_rate is a percentage)
                _win_count = round(_total_trades * _win_rate / 100) if _total_trades > 0 else 0
                _loss_count = _total_trades - _win_count
                metrics_for_db = {
                    'total_return_pct': float(metrics_data.get('total_return', 0)),
                    'sharpe_ratio': float(metrics_data.get('sharpe_ratio', 0)),
                    'max_drawdown_pct': float(metrics_data.get('max_drawdown_pct', 0)),
                    'win_rate': _win_rate,
                    'profit_factor': float(metrics_data.get('profit_factor', 0)),
                    'total_trades': _total_trades,
                    'win_count': _win_count,
                    'loss_count': _loss_count,
                    'sortino_ratio': float(metrics_data.get('sortino_ratio', 0)),
                    'calmar_ratio': float(metrics_data.get('calmar_ratio', 0)),
                    'std_deviation': float(metrics_data.get('std_deviation', 0)),
                }

                # Determine test_type from mode: Mode 1 (Historical) → walk_forward,
                # Mode 2 (Live Replay) → backtest (BTCAAAAA-33)
                test_mode = backtest_config.get('mode', 2)
                test_type = 'walk_forward' if test_mode == 1 else 'backtest'

                test_data = {
                    'strategy_id': strategy_id,
                    'strategy_version_id': version_id,
                    'test_type': test_type,
                    'test_config': {
                        'lookback_days': backtest_config.get('lookback_days'),
                        'starting_capital': backtest_config.get('starting_capital'),
                        'risk_per_trade_pct': backtest_config.get('risk_per_trade_pct'),
                        'timeframe': backtest_config.get('timeframe'),
                    },
                    'start_date': backtest_config.get('start_date', datetime.now(timezone.utc)),
                    'end_date': backtest_config.get('end_date', datetime.now(timezone.utc)),
                    'metrics': metrics_for_db,
                    'trades': full_results.get('trades', []),
                }

                db = get_database_manager()
                result_id = db.test_results.create_test_result(test_data)
                logger.info(f"[Backtest] Test result saved: {result_id}")
                self.output_panel.add_message(
                    f"📥 Results saved to database (id: {result_id[:8]}…)",
                    "INFO",
                    "SYSTEM"
                )

                # ── Config retention: save backtest config after test run ──────
                # BTCAAAAA-252: Persist current panel config so it can be
                # auto-restored the next time this strategy version is opened.
                try:
                    db.strategy.save_backtest_config_for_version(
                        version_id, backtest_config, source='test_run'
                    )
                    logger.info(
                        f"[Backtest] Config retained for version {version_id[:8]}…"
                    )
                    self._mark_config_retained('test run')
                except Exception as _cfg_exc:
                    logger.warning(
                        f"[Backtest] Config retention warning: {_cfg_exc}"
                    )
                # ── End config retention ────────────────────────────────────────
            else:
                logger.info("[Backtest] Skipping DB persist: strategy not saved yet (no strategy_id / version_id)")
        except Exception as _persist_exc:
            logger.warning(f"[Backtest] Warning: could not save test result to DB: {_persist_exc}")
        # ── End persistence block ───────────────────────────────────────────────

        # Add note to Live Output about tab availability
        self.output_panel.add_message(
            "📊 Switch to other tabs to view detailed trades, metrics, and comparisons",
            "INFO",
            "SYSTEM"
        )
        self.output_panel.add_message(
            f"✅ All {trade_count} trades have been processed and are ready for analysis",
            "INFO",
            "SYSTEM"
        )
    
    def get_config(self) -> dict:
        """
        Get current backtest configuration with calculated date ranges
        
        SPRINT 2.0.1 Task 2.0.1.1: Calculate start_date and end_date from lookback_days
        CRITICAL FIX: Include ALL UI parameters (was missing TP/SL, Risk, Adaptive SL)
        
        Returns:
            dict: Complete configuration with ALL parameters for backtest execution
        """
        from datetime import datetime, timedelta
        
        lookback_days = self.lookback_spin.value()
        training_days = self.training_spin.value()
        testing_days = self.testing_spin.value()
        mode = self.mode_group.checkedId()
        
        end_date = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)

        # Mode 1: start_date is derived from training_days + testing_days
        # so the full data window exactly covers both phases regardless of
        # lookback_days (which is a separate UI parameter for Mode 2).
        if mode == 1:
            start_date = end_date - timedelta(days=training_days + testing_days)
        else:
            start_date = end_date - timedelta(days=lookback_days)

        config = {
            # Basic settings
            'lookback_days': lookback_days,
            'mode': mode,
            'tpsl_mode': self.tpsl_combo.currentText(),
            'sl_mode': self.sl_combo.currentText(),
            'start_date': start_date,
            'end_date': end_date,
            'timeframe': '15m',

            # Risk/Reward settings (CRITICAL - was missing!)
            'starting_capital': self.capital_spin.value(),
            'risk_per_trade_pct': self.risk_spin.value(),
            'min_risk_reward': self.rr_spin.value() / 10.0,  # UI shows 10x
            'max_leverage': self.leverage_spin.value(),
            'confluence_threshold': self.confluence_spin.value(),
            'max_bars_held': self.max_bars_spin.value(),

            # Adaptive SL v2.0 settings (CRITICAL - was missing!)
            'adaptive_sl': {
                'enabled': self.sl_combo.currentText() == 'Adaptive v2.0',
                'delay_enabled': self.delayed_sl_check.isChecked(),
                'delay_bars': self.delay_spin.value(),
                'emergency_sl_pct': self.emergency_spin.value(),
                'volatility_lookback': self.vol_lookback_spin.value(),
                'volatility_multiplier': self.vol_multi_spin.value(),  # Direct value (e.g., 1.2)
                'min_sl_pct': self.min_sl_spin.value(),  # Direct value (e.g., 0.7)
                'max_sl_pct': self.max_sl_spin.value(),  # Direct value (e.g., 2.0)
                'use_structure_sl': self.structure_check.isChecked(),
                'structure_sources': ['swing_points', 'supply_demand', 'fibonacci']
            }
        }

        # Mode 1: Include training/testing windows with correct split dates
        if mode == 1:
            config['training_window'] = training_days
            config['testing_window'] = testing_days

            # Calculate split dates for Mode 1
            config['training_end'] = start_date + timedelta(days=training_days)
            config['testing_start'] = config['training_end']
        
        # Mode 2: Training/testing windows NOT included (ignored)
        # Only lookback_days matters for Mode 2
        
        return config

    # ──────────────────────────────────────────────────────────────────────────
    # Config retention helpers  (BTCAAAAA-252)
    # ──────────────────────────────────────────────────────────────────────────

    def apply_config_from_dict(self, saved: dict, source: str = 'database') -> bool:
        """
        Restore BacktestConfigPanel widgets from a previously persisted config dict.

        Called by StrategyBuilderMainWindow when a strategy version is opened
        and a non-empty backtest_config snapshot exists in the database.

        Args:
            saved:  The dict that was stored by save_backtest_config_for_version().
                    datetime values may be ISO-8601 strings (they are ignored;
                    dates are always recalculated from lookback_days at runtime).
            source: Human-readable label used in the status indicator.

        Returns:
            True if at least one widget was updated; False if the dict was empty
            or contained no recognised keys.
        """
        if not saved:
            return False

        applied_any = False

        try:
            # Suppress config-changed signal noise while we bulk-restore
            self._loading_preset = True

            # ── Basic fields ──────────────────────────────────────────────
            if 'lookback_days' in saved:
                self.lookback_spin.setValue(int(saved['lookback_days']))
                applied_any = True
            if 'mode' in saved:
                mode_btn = self.mode_group.button(int(saved['mode']))
                if mode_btn:
                    mode_btn.setChecked(True)
                    applied_any = True
            if 'tpsl_mode' in saved:
                self.tpsl_combo.setCurrentText(str(saved['tpsl_mode']))
                applied_any = True
            if 'sl_mode' in saved:
                self.sl_combo.setCurrentText(str(saved['sl_mode']))
                applied_any = True
            if 'starting_capital' in saved:
                # QSpinBox requires int; cast explicitly to avoid TypeError from float
                self.capital_spin.setValue(int(float(saved['starting_capital'])))
                applied_any = True
            if 'risk_per_trade_pct' in saved:
                self.risk_spin.setValue(int(float(saved['risk_per_trade_pct'])))
                applied_any = True
            if 'min_risk_reward' in saved:
                # UI shows 10x the actual value (see get_config); cast to int for QSpinBox
                self.rr_spin.setValue(int(float(saved['min_risk_reward']) * 10.0))
                applied_any = True
            if 'max_leverage' in saved:
                self.leverage_spin.setValue(int(float(saved['max_leverage'])))
                applied_any = True
            if 'confluence_threshold' in saved:
                self.confluence_spin.setValue(int(float(saved['confluence_threshold'])))
                applied_any = True
            if 'max_bars_held' in saved:
                self.max_bars_spin.setValue(int(saved['max_bars_held']))
                applied_any = True

            # ── Mode-1 specific ───────────────────────────────────────────
            if 'training_window' in saved:
                self.training_spin.setValue(int(saved['training_window']))
                applied_any = True
            if 'testing_window' in saved:
                self.testing_spin.setValue(int(saved['testing_window']))
                applied_any = True

            # ── Adaptive SL sub-dict ──────────────────────────────────────
            asl = saved.get('adaptive_sl', {})
            if asl:
                if 'delay_enabled' in asl:
                    self.delayed_sl_check.setChecked(bool(asl['delay_enabled']))
                    applied_any = True
                if 'delay_bars' in asl:
                    self.delay_spin.setValue(int(asl['delay_bars']))
                    applied_any = True
                if 'emergency_sl_pct' in asl:
                    self.emergency_spin.setValue(float(asl['emergency_sl_pct']))
                    applied_any = True
                if 'volatility_lookback' in asl:
                    self.vol_lookback_spin.setValue(int(asl['volatility_lookback']))
                    applied_any = True
                if 'volatility_multiplier' in asl:
                    self.vol_multi_spin.setValue(float(asl['volatility_multiplier']))
                    applied_any = True
                if 'min_sl_pct' in asl:
                    self.min_sl_spin.setValue(float(asl['min_sl_pct']))
                    applied_any = True
                if 'max_sl_pct' in asl:
                    self.max_sl_spin.setValue(float(asl['max_sl_pct']))
                    applied_any = True
                if 'use_structure_sl' in asl:
                    self.structure_check.setChecked(bool(asl['use_structure_sl']))
                    applied_any = True

        finally:
            self._loading_preset = False

        if applied_any:
            self._mark_config_retained(source)

        return applied_any

    def _mark_config_retained(self, source: str = 'database') -> None:
        """
        Update the status label to indicate configuration was loaded from
        persistence.  Called both after a restore on open and after a save
        post-run / post-discovery.

        Args:
            source: Short label describing the trigger
                    ('test run', 'config discovery', 'database').
        """
        try:
            from datetime import datetime as _dt
            ts = _dt.now().strftime('%H:%M')
            label_map = {
                'test run':        f'Config saved at {ts} (after test run)',
                'config discovery': f'Config saved at {ts} (after discovery)',
                'database':        f'Config restored from last test run',
                'test_run':        f'Config saved at {ts} (after test run)',
                'config_discovery': f'Config saved at {ts} (after discovery)',
            }
            msg = label_map.get(source, f'Config retained ({source})')

            # Prefer a dedicated retention label if one is wired into the panel;
            # fall back to the output panel log so there is always some feedback.
            if hasattr(self, 'config_retention_label'):
                self.config_retention_label.setText(msg)
                self.config_retention_label.setVisible(True)
            else:
                if hasattr(self, 'output_panel') and self.output_panel is not None:
                    self.output_panel.add_message(
                        f'ℹ️  {msg}', 'INFO', 'SYSTEM'
                    )
        except Exception:
            pass  # Never break the backtest flow over a UI label update

    def _get_strategy_name(self) -> str:
        """Get current strategy name from Strategy Info Panel (Name field in UI)"""
        try:
            # Access the main window to get the strategy info panel
            main_window = self.window()
            if hasattr(main_window, 'strategy_info_panel'):
                return main_window.strategy_info_panel.get_strategy_name()
            
            # Fallback to config if panel not accessible
            config = self.orchestrator.get_current_config()
            if config and hasattr(config, 'name') and config.name:
                return config.name
            return ""
        except:
            return ""
    
    def update_strategy_title(self):
        """Update title when strategy changes"""
        strategy_name = self._get_strategy_name()
        if strategy_name:
            self.title_label.setText(f"💠 Backtest Configuration - {strategy_name} Strategy")
        else:
            self.title_label.setText("💠 Backtest Configuration")
    
    def _apply_conservative_preset(self):
        """Apply conservative SL preset (wider SLs, higher win rate, fewer trades)"""
        self._loading_preset = True
        self.delayed_sl_check.setChecked(True)
        self.delay_spin.setValue(3)
        self.emergency_spin.setValue(3.0)
        self.vol_lookback_spin.setValue(20)
        self.vol_multi_spin.setValue(1.5)  # 1.5x
        self.min_sl_spin.setValue(1.0)  # 1.0%
        self.max_sl_spin.setValue(2.5)  # 2.5%
        self.structure_check.setChecked(True)
        self._loading_preset = False
    
    def _apply_balanced_preset(self):
        """Apply balanced SL preset (default settings)"""
        self._loading_preset = True
        self.delayed_sl_check.setChecked(True)
        self.delay_spin.setValue(2)
        self.emergency_spin.setValue(2.0)
        self.vol_lookback_spin.setValue(20)
        self.vol_multi_spin.setValue(1.2)  # 1.2x
        self.min_sl_spin.setValue(0.7)  # 0.7%
        self.max_sl_spin.setValue(2.0)  # 2.0%
        self.structure_check.setChecked(True)
        self._loading_preset = False
    
    def _apply_aggressive_preset(self):
        """Apply aggressive SL preset (tighter SLs, more trades, lower win rate)"""
        self._loading_preset = True
        self.delayed_sl_check.setChecked(True)
        self.delay_spin.setValue(1)
        self.emergency_spin.setValue(2.0)
        self.vol_lookback_spin.setValue(20)
        self.vol_multi_spin.setValue(1.0)  # 1.0x
        self.min_sl_spin.setValue(0.6)  # 0.6%
        self.max_sl_spin.setValue(1.5)  # 1.5%
        self.structure_check.setChecked(True)
        self._loading_preset = False
    
    def _apply_custom_preset(self):
        """Load saved custom values when Custom preset is selected"""
        if not self.custom_values:
            # No custom values saved yet, use current Balanced defaults
            return
        
        self._loading_preset = True
        self.delayed_sl_check.setChecked(self.custom_values.get('delayed_sl', True))
        self.delay_spin.setValue(self.custom_values.get('delay', 2))
        self.emergency_spin.setValue(self.custom_values.get('emergency', 2))
        self.vol_lookback_spin.setValue(self.custom_values.get('vol_lookback', 20))
        self.vol_multi_spin.setValue(self.custom_values.get('vol_multi', 12))
        self.min_sl_spin.setValue(self.custom_values.get('min_sl', 7))
        self.max_sl_spin.setValue(self.custom_values.get('max_sl', 20))
        self.structure_check.setChecked(self.custom_values.get('structure', True))
        self._loading_preset = False
    
    def _save_custom_values(self):
        """Save current values to custom preset storage"""
        self.custom_values = {
            'delayed_sl': self.delayed_sl_check.isChecked(),
            'delay': self.delay_spin.value(),
            'emergency': self.emergency_spin.value(),
            'vol_lookback': self.vol_lookback_spin.value(),
            'vol_multi': self.vol_multi_spin.value(),
            'min_sl': self.min_sl_spin.value(),
            'max_sl': self.max_sl_spin.value(),
            'structure': self.structure_check.isChecked()
        }
    
    def _on_manual_value_change(self):
        """Detect manual value changes and auto-activate Custom preset"""
        # Skip if we're currently loading a preset
        if self._loading_preset:
            return
        
        # Skip if Custom is already selected
        if self.custom_radio.isChecked():
            # Still save the new custom value
            self._save_custom_values()
            return
        
        # Save current values to custom storage
        self._save_custom_values()
        
        # Auto-activate Custom preset
        self._loading_preset = True  # Prevent recursion
        self.custom_radio.setChecked(True)
        self._loading_preset = False
    
    def _connect_value_change_detection(self):
        """Connect all value-changing widgets to detect manual changes"""
        # Connect spinboxes
        self.delay_spin.valueChanged.connect(self._on_manual_value_change)
        self.emergency_spin.valueChanged.connect(self._on_manual_value_change)
        self.vol_lookback_spin.valueChanged.connect(self._on_manual_value_change)
        self.vol_multi_spin.valueChanged.connect(self._on_manual_value_change)
        self.min_sl_spin.valueChanged.connect(self._on_manual_value_change)
        self.max_sl_spin.valueChanged.connect(self._on_manual_value_change)
        
        # Connect checkboxes
        self.delayed_sl_check.stateChanged.connect(self._on_manual_value_change)
        self.structure_check.stateChanged.connect(self._on_manual_value_change)
    
    def _connect_auto_save(self):
        """
        Connect ALL UI controls to auto-save to database.
        
        CRITICAL: Any parameter change immediately updates database strategy.
        This ensures UI and DB are ALWAYS synchronized - no more stale configs!
        
        Called AFTER preset initialization to avoid saving during setup.
        """
        # Basic Settings Column
        self.lookback_spin.valueChanged.connect(self._on_config_changed)
        self.training_spin.valueChanged.connect(self._on_config_changed)
        self.testing_spin.valueChanged.connect(self._on_config_changed)
        self.mode_group.buttonClicked.connect(self._on_config_changed)
        self.tpsl_combo.currentTextChanged.connect(self._on_config_changed)
        self.sl_combo.currentTextChanged.connect(self._on_config_changed)
        
        # Adaptive SL v2.0 Column (already connected via _on_manual_value_change, but connect directly too)
        self.preset_group.buttonClicked.connect(self._on_config_changed)
        self.delayed_sl_check.stateChanged.connect(self._on_config_changed)
        self.structure_check.stateChanged.connect(self._on_config_changed)
        self.delay_spin.valueChanged.connect(self._on_config_changed)
        self.emergency_spin.valueChanged.connect(self._on_config_changed)
        self.vol_lookback_spin.valueChanged.connect(self._on_config_changed)
        self.vol_multi_spin.valueChanged.connect(self._on_config_changed)
        self.min_sl_spin.valueChanged.connect(self._on_config_changed)
        self.max_sl_spin.valueChanged.connect(self._on_config_changed)
        
        # Risk/Reward Column
        self.capital_spin.valueChanged.connect(self._on_config_changed)
        self.rr_spin.valueChanged.connect(self._on_config_changed)
        self.risk_spin.valueChanged.connect(self._on_config_changed)
        self.leverage_spin.valueChanged.connect(self._on_config_changed)
        self.confluence_spin.valueChanged.connect(self._on_config_changed)
        self.max_bars_spin.valueChanged.connect(self._on_config_changed)
    
    def _on_config_changed(self):
        """
        Handle config parameter change - auto-save to database.
        
        CRITICAL: Called whenever ANY UI control changes.
        Updates strategy in database immediately so UI changes persist.
        
        Skip during:
        - Preset loading (avoid multiple saves)
        - No parent window (standalone panel)
        - No strategy loaded (nothing to save)
        """
        # Skip if loading preset (batch update)
        if self._loading_preset:
            return
        
        # Skip if no parent window (can't access save)
        if not self.parent_window or not hasattr(self.parent_window, '_on_save_strategy'):
            return
        
        # Trigger silent save in parent window
        # This updates database without showing success dialog
        try:
            self.parent_window._on_save_strategy()
            # Emit signal for other components that may listen
            self.config_changed.emit()
        except Exception as e:
            # Silently log but don't interrupt user workflow
            logger.error(f"Auto-save failed: {e}")
    
    def _set_live_output_color(self, color: str) -> None:
        """
        Set color for Live Output tab via dynamic property.
        
        Qt-native solution: Set property on tab bar, style via property selector.
        
        Args:
            color: "red" or "green"
        """
        # Set dynamic property on tab bar for Qt stylesheet selector
        self.tab_widget.tabBar().setProperty("liveOutputState", color)
        
        # Force stylesheet refresh to apply property-based styling
        self.tab_widget.style().unpolish(self.tab_widget.tabBar())
        self.tab_widget.style().polish(self.tab_widget.tabBar())
    
    def _on_capital_changed_spinbox(self, value: int):
        """
        Handle starting capital spinbox value change
        
        NAUTILUS EXPERT: Updates NautilusTrader Money type when value changes
        """
        try:
            usd = Currency.from_str('USD')
            self.starting_capital = Money(str(value), usd)
            
            # Emit signal for other components
            self.capital_changed.emit(self.starting_capital)
        except Exception as e:
            # Silently fail - spinbox already validates range
            pass
    
    def get_starting_capital(self) ->Money:
        """
        Get current starting capital (NautilusTrader Money type)
        
        Returns:
            Money: Starting capital in USD
        """
        return self.starting_capital
    
    def set_starting_capital(self, amount: str):
        """
        Set starting capital amount
        
        Args:
            amount: Amount in USD as string or int
        """
        try:
            self.capital_spin.setValue(int(amount))
        except (ValueError, TypeError):
            pass
     
    def _capture_ui_state(self) -> dict:
        """Capture current UI parameter values"""
        return {
            'lookback': self.lookback_spin.value(),
            'training': self.training_spin.value(),
            'testing': self.testing_spin.value(),
            'tpsl_mode': self.tpsl_combo.currentText(),
            'sl_mode': self.sl_combo.currentText(),
            'delay': self.delay_spin.value(),
            'emergency': self.emergency_spin.value(),
            'capital': self.capital_spin.value(),
            'risk': self.risk_spin.value(),
            'leverage': self.leverage_spin.value(),
            'confluence': self.confluence_spin.value(),
            'max_bars': self.max_bars_spin.value()
        }
    
    def _restore_ui_state(self, state: dict):
        """Restore UI to saved state"""
        self.lookback_spin.setValue(state['lookback'])
        self.training_spin.setValue(state['training'])
        self.testing_spin.setValue(state['testing'])
        self.tpsl_combo.setCurrentText(state['tpsl_mode'])
        self.sl_combo.setCurrentText(state['sl_mode'])
        self.delay_spin.setValue(state['delay'])
        self.emergency_spin.setValue(state['emergency'])
        self.capital_spin.setValue(state['capital'])
        self.risk_spin.setValue(state['risk'])
        self.leverage_spin.setValue(state['leverage'])
        self.confluence_spin.setValue(state['confluence'])
        self.max_bars_spin.setValue(state['max_bars'])
    
    def _apply_scenario_to_ui(self, config: dict):
        """
        Apply scenario configuration to UI widgets
        
        CRITICAL FIX: Handle BOTH formats:
        1. Top-level keys (for simple scenarios)
        2. Nested 'adaptive_sl' dict (for detailed tests)
        """
        # Top-level settings
        if 'tpsl_mode' in config:
            self.tpsl_combo.setCurrentText(config['tpsl_mode'])
        if 'sl_adjustment' in config:
            self.sl_combo.setCurrentText(config['sl_adjustment'])
        if 'sl_delay' in config:
            self.delay_spin.setValue(config['sl_delay'])
        if 'emergency_sl' in config:
            self.emergency_spin.setValue(config['emergency_sl'])
        if 'risk_pct' in config:
            self.risk_spin.setValue(config['risk_pct'])
        if 'leverage' in config:
            self.leverage_spin.setValue(config['leverage'])
        if 'starting_capital' in config:
            self.capital_spin.setValue(config['starting_capital'])
        
        # CRITICAL FIX: Handle nested 'adaptive_sl' dict
        # Test scenarios like PARAM_VOL_LB_LOW pass this format!
        if 'adaptive_sl' in config:
            asl = config['adaptive_sl']
            
            # Apply all adaptive SL parameters to UI widgets
            if 'delay_bars' in asl:
                self.delay_spin.setValue(asl['delay_bars'])
            if 'emergency_sl_pct' in asl:
                self.emergency_spin.setValue(int(asl['emergency_sl_pct']))
            if 'volatility_lookback' in asl:
                self.vol_lookback_spin.setValue(asl['volatility_lookback'])
            if 'volatility_multiplier' in asl:
                # Direct decimal value (e.g., 1.2)
                self.vol_multi_spin.setValue(float(asl['volatility_multiplier']))
            if 'min_sl_pct' in asl:
                # Direct decimal value (e.g., 0.7)
                self.min_sl_spin.setValue(float(asl['min_sl_pct']))
            if 'max_sl_pct' in asl:
                # Direct decimal value (e.g., 2.0)
                self.max_sl_spin.setValue(float(asl['max_sl_pct']))
        
        # CRITICAL FIX: Force Qt to process events so spinbox values update
        # Without this, get_config() reads OLD values before UI updates!
        QApplication.processEvents()
    
    def _run_test_and_wait(self) -> dict:
        """Click Run button and wait for backtest to complete"""
        from PyQt5.QtCore import QEventLoop
        
        # Container for results
        results = {}
        
        # Connect to completion signal
        def on_complete(success, data):
            results.update(data)
            results['success'] = success
            loop.quit()
        
        # Create event loop
        loop = QEventLoop()
        
        # Click Run button programmatically
        self._on_run_clicked()
        
        # Wait for worker to be created
        while not self.worker:
            QApplication.processEvents()
            self.app.thread().msleep(100)
        
        # Connect to worker's finished signal
        self.worker.backtest_finished.connect(on_complete)
        
        # Wait for completion
        loop.exec_()
        
        return results
    
    def _generate_discovery_report(self, test_results: list, mode: str = 'wiring'):
        """
        Generate enhanced Config Discovery report with per-trade exit metrics.
        
        Phase 1.2 implementation: aggregates total_pnl, win_rate, sharpe,
        avg_pnl_per_trade, exit_type_distribution per scenario.
        
        Args:
            test_results: List of dicts with scenario results (includes trades_list).
            mode: 'wiring' (CSV + dialog) or 'discovery' (show ConfigDiscoveryResultsDialog).
        """
        from pathlib import Path
        import pandas as pd
        from datetime import datetime
        from src.strategy_builder.ui.config_permutation_engine import aggregate_metrics, DiscoveryScenario
        from src.strategy_builder.ui.config_discovery_results_dialog import ConfigDiscoveryResultsDialog

        # Create report directory
        report_dir = Path('tests/integration/results')
        report_dir.mkdir(parents=True, exist_ok=True)

        # Build DiscoveryResult objects from test_results
        discovery_results = []
        for r in test_results:
            scenario = DiscoveryScenario(
                scenario_id=r.get('scenario_id', 'UNKNOWN'),
                description=r.get('description', ''),
                config_delta=r.get('config', {}),
                param_labels=[],
            )
            trades_list = r.get('trades_list', [])
            error = None if r.get('success', False) or trades_list else 'Backtest failed or no trades'
            dr = aggregate_metrics(scenario, trades_list, error=error)
            discovery_results.append(dr)

        # Save enhanced CSV
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")
        rows = []
        for dr in discovery_results:
            rows.append({
                'scenario_id': dr.scenario_id,
                'description': dr.description,
                'trade_count': dr.trade_count,
                'win_rate_pct': round(dr.win_rate, 2),
                'total_pnl': round(dr.total_pnl, 2),
                'avg_pnl_per_trade': round(dr.avg_pnl_per_trade, 2),
                'sharpe_ratio': round(dr.sharpe_ratio, 3),
                'exit_tp1': dr.exit_tp1,
                'exit_tp2': dr.exit_tp2,
                'exit_tp3': dr.exit_tp3,
                'exit_sl': dr.exit_sl,
                'exit_time': dr.exit_time,
                'avg_bars_held': round(dr.avg_bars_held, 1),
                'max_drawdown': round(dr.max_drawdown, 2),
            })
        df = pd.DataFrame(rows)
        csv_path = report_dir / f'wiring_test_{timestamp}.csv'
        df.to_csv(csv_path, index=False)

        # Analyze for wiring bugs (preserve original logic)
        wiring_bugs = []
        trade_counts = [r.get('trades', 0) for r in test_results]
        unique_counts = set(trade_counts)
        if len(unique_counts) < len(test_results) * 0.5:
            wiring_bugs.append("Too many identical trade counts - parameters may not be wired!")

        # Generate summary
        passed = sum(1 for r in test_results if r.get('success', False))
        total = len(test_results)
        total_pnl_sum = sum(dr.total_pnl for dr in discovery_results)
        avg_win_rate = (sum(dr.win_rate for dr in discovery_results) / total) if total else 0

        summary = f"""
\u2554{'='*72}\u2557
\u2551 WIRING VERIFICATION TEST COMPLETE                                        \u2551
\u255a{'='*72}\u255d

Total Tests:   {total}
Successful:    {passed}
Failed:        {total - passed}

Enhanced Metrics:
  Combined PnL:   ${total_pnl_sum:.2f}
  Avg Win Rate:   {avg_win_rate:.1f}%

Trade Count Distribution:
  Unique Results: {len(unique_counts)}
  Range: {min(trade_counts)} - {max(trade_counts)} trades

{'WARNING: WIRING BUGS DETECTED:' if wiring_bugs else 'All parameters appear to be wired correctly!'}
{chr(10).join(f'  - {bug}' for bug in wiring_bugs) if wiring_bugs else ''}

Detailed report saved to:
{csv_path}
"""

        # Show in discovery results dialog if mode is 'discovery', else handle other modes
        if mode == 'csv_only':
            # CSV already saved above; no dialog action needed
            logger.info(summary)
        elif mode == 'discovery':
            def apply_cb(delta):
                self._apply_discovery_config_to_ui(delta)

            dialog = ConfigDiscoveryResultsDialog(
                apply_config_callback=apply_cb,
                parent=self,
            )
            dialog.set_results(discovery_results)
            dialog.show()
            logger.info(summary)
        else:
            # Legacy wiring report dialog
            msg = QMessageBox(self)
            msg.setStyleSheet(MAIN_STYLESHEET)
            msg.setIcon(QMessageBox.Information if not wiring_bugs else QMessageBox.Warning)
            msg.setText("Wiring Test Complete")
            msg.setDetailedText(summary)
            msg.setStandardButtons(QMessageBox.Ok)
            msg.exec_()

        logger.info(summary)

    def _apply_discovery_config_to_ui(self, config_delta: dict):
        """
        Apply a Config Discovery result delta to the UI widgets.
        
        Translates dot-notation keys (e.g. 'adaptive_sl.volatility_lookback')
        to the appropriate widget update calls.
        
        Phase 3.3: Called when user clicks "Apply Config" in the results dialog.
        BTCAAAAA-252: Also persists the resulting full config to the DB.
        """
        # Flatten nested keys: 'adaptive_sl.volatility_lookback' → 'adaptive_sl' sub-dict
        top_level = {}
        nested = {}
        for key, val in config_delta.items():
            if '.' in key:
                parts = key.split('.', 1)
                if parts[0] not in nested:
                    nested[parts[0]] = {}
                nested[parts[0]][parts[1]] = val
            else:
                top_level[key] = val

        # Apply top-level keys (same as _apply_scenario_to_ui)
        self._apply_scenario_to_ui({**top_level, **nested})

        # Show brief confirmation
        self.results_text.append(
            "\n[Config Discovery] Applied config delta from selected scenario.\n"
            + "\n".join(f"  {k}: {v}" for k, v in config_delta.items())
        )

        # ── Config retention: save full config after discovery apply ──────────
        # BTCAAAAA-252: Persist current panel state so it survives app restart.
        try:
            version_id = getattr(self.orchestrator, 'current_version_id', None)
            if version_id:
                from src.optimizer_v3.database import get_database_manager as _get_db
                _db = _get_db()
                _db.strategy.save_backtest_config_for_version(
                    version_id, self.get_config(), source='config_discovery'
                )
                logger.info(
                    f"[ConfigDiscovery] Config retained for version {version_id[:8]}…"
                )
                self._mark_config_retained('config discovery')
        except Exception as _cfg_exc:
            logger.warning(
                f"[ConfigDiscovery] Config retention warning: {_cfg_exc}"
            )
        # ── End config retention ──────────────────────────────────────────────
    
    def _update_cache_status(self):
        """Update UI with cache status information"""
        metrics = self.cache_manager.get_metrics()
        cache_info = (
            f"\n💾 Cache Status:\n"
            f"   Entries: {metrics['cache_size']}/{self.cache_manager.max_size}\n"
            f"   Hit Rate: {metrics['hit_rate_pct']:.1f}%\n"
            f"   Total Hits: {metrics['hits']}\n"
            f"   Total Misses: {metrics['misses']}"
        )
        self.results_text.append(cache_info)
    
    def _auto_calculate_confluence_on_init(self):
        """
        Auto-calculate confluence from strategy on window initialization.
        
        CRITICAL: Automatically runs on panel open to set proper confluence value.
        Silent version - doesn't show messages in results_text during init.
        """
        try:
            # Get current strategy configuration from orchestrator
            config = self.orchestrator.get_current_config()
            
            if not config or not hasattr(config, 'blocks') or not config.blocks:
                # No strategy yet - keep default value (40)
                return
            
            # Calculate required and optional points
            required_points = 0
            optional_points = 0
            
            for block in config.blocks:
                if not hasattr(block, 'signals'):
                    continue
                
                for signal in block.signals:
                    # Use actual signal weight if available, otherwise default to 10
                    signal_weight = getattr(signal, 'weight', 10) or 10
                    
                    if hasattr(signal, 'logic'):
                        if signal.logic == 'AND':
                            required_points += signal_weight
                        elif signal.logic == 'OR':
                            optional_points += signal_weight
            
            total_points = required_points + optional_points
            
            if total_points == 0:
                # No signals - keep default value
                return
            
            # Recommended confluence: Required points + 50-70% of optional points
            recommended = required_points + int(optional_points * 0.6)
            
            # Set the calculated value (silent during init)
            self.confluence_spin.setValue(recommended)
            
        except Exception as e:
            # Silent fail - keep default value of 40
            pass
    
    def _calculate_confluence_from_strategy(self):
        """
        Calculate optimal confluence points from current strategy configuration.
        
        NAUTILUS EXPERT: Analyze strategy blocks and signals to determine
        the recommended confluence threshold based on required vs optional signals.
        
        This is the MANUAL version (triggered by button click) - shows verbose output.
        """
        try:
            # Get current strategy configuration from orchestrator
            config = self.orchestrator.get_current_config()
            
            if not config or not hasattr(config, 'blocks') or not config.blocks:
                self.results_text.setText(
                    "⚠️ No strategy configured yet!\n\n"
                    "Please add building blocks to your strategy first,\n"
                    "then click 'Reset From Strategy' to determine optimal confluence."
                )
                return
            
            # Calculate required and optional points
            required_points = 0
            optional_points = 0
            
            for block in config.blocks:
                if not hasattr(block, 'signals'):
                    continue
                
                for signal in block.signals:
                    # Use actual signal weight if available, otherwise default to 10
                    signal_weight = getattr(signal, 'weight', 10) or 10
                    
                    if hasattr(signal, 'logic'):
                        if signal.logic == 'AND':
                            required_points += signal_weight
                        elif signal.logic == 'OR':
                            optional_points += signal_weight
            
            total_points = required_points + optional_points
            
            if total_points == 0:
                self.results_text.setText(
                    "⚠️ No signals detected in strategy!\n\n"
                    "Add signals to your building blocks first."
                )
                return
            
            # Recommended confluence: Required points + 50-70% of optional points
            # This ensures all required signals trigger + most optional signals
            recommended = required_points + int(optional_points * 0.6)
            
            # Set the calculated value
            self.confluence_spin.setValue(recommended)
            
            # Show calculation details in results
            self.results_text.setText(
                f"📊 Confluence Calculated from Strategy:\n\n"
                f"Required Signals: {required_points} pts (AND logic)\n"
                f"Optional Signals: {optional_points} pts (OR logic)\n"
                f"Total Possible: {total_points} pts\n\n"
                f"✅ Recommended Confluence: {recommended} pts\n"
                f"   ({int((recommended / total_points) * 100)}% of total)\n\n"
                f"This ensures:\n"
                f"• All required signals must trigger\n"
                f"• ~60% of optional signals should trigger\n"
                f"• Quality trades over quantity\n\n"
                f"You can adjust manually if needed."
            )
            
        except Exception as e:
            self.results_text.setText(
                f"❌ Error calculating confluence:\n{str(e)}\n\n"
                "Using default value of 40 pts."
            )
            self.confluence_spin.setValue(40)

    def _on_config_discovery_clicked(self):
        """
        Launch Config Discovery run using BacktestWorker via _run_test_and_wait().

        Replaces the broken ConfigPermutationWorker path which bypassed
        BacktestWorker and produced 0 trades.  This implementation uses
        the identical execution path so every scenario goes through the real
        BacktestWorker, emits Live Output, and returns genuine trade data.

        Threading contract:
        - All Qt widget access (_apply_scenario_to_ui, _run_test_and_wait,
          results_dialog.append_result) runs on the main thread.
        - QProgressDialog + QApplication.processEvents() keeps the UI
          responsive between sequential scenario runs.
        - _run_test_and_wait() uses QEventLoop internally; no blocking I/O.

        Flow:
        1. Load 23 scenarios (CRITICAL + EDGE + PARAMETER_VARIATION)
        2. Confirm with user (count + estimated time)
        3. Save current UI state
        4. Capture baseline result (current config, no UI change)
        5. Open ConfigDiscoveryResultsDialog immediately (maximised)
        6. Loop over each scenario on main thread:
              a. _apply_scenario_to_ui(scenario.config)
              b. QApplication.processEvents()
              c. result = _run_test_and_wait()
              d. build DiscoveryResult via aggregate_metrics()
              e. results_dialog.append_result(dr)
              f. update progress dialog
        7. Restore UI state
        8. Finalise dialog + generate CSV report

        Does NOT use ConfigPermutationWorker or MulticoreBacktestEngine.
        """
        from PyQt5.QtWidgets import QMessageBox, QProgressDialog
        from src.strategy_builder.ui.config_permutation_engine import (
            DiscoveryScenario,
            aggregate_metrics,
        )
        from src.strategy_builder.ui.config_discovery_results_dialog import (
            ConfigDiscoveryResultsDialog,
        )

        # ------------------------------------------------------------------
        # Step 1: Load the wiring test scenarios (same set as wiring test)
        # ------------------------------------------------------------------
        try:
            from tests.integration.test_scenarios import (
                CRITICAL_SCENARIOS,
                EDGE_SCENARIOS,
                PARAMETER_VARIATION_SCENARIOS,
            )
            all_scenarios = CRITICAL_SCENARIOS + EDGE_SCENARIOS + PARAMETER_VARIATION_SCENARIOS
        except ImportError:
            QMessageBox.critical(
                self,
                "Config Discovery Error",
                "Could not load test scenarios.\n\n"
                "Expected: tests/integration/test_scenarios.py\n"
                "Ensure the file defines CRITICAL_SCENARIOS, EDGE_SCENARIOS, "
                "and PARAMETER_VARIATION_SCENARIOS.",
            )
            return

        total_scenarios = len(all_scenarios)
        est_mins = max(1, (total_scenarios * 30) // 60)

        # ------------------------------------------------------------------
        # Step 2: Confirm with user
        # ------------------------------------------------------------------
        msg = QMessageBox(self)
        msg.setStyleSheet(MAIN_STYLESHEET)
        msg.setIcon(QMessageBox.Question)
        msg.setText("Config Discovery — BacktestWorker Execution")
        msg.setInformativeText(
            f"Run {total_scenarios} wiring test scenarios?\n\n"
            f"  Scenarios: {total_scenarios} (from tests/integration/test_scenarios.py)\n"
            f"  Est. time: ~{est_mins} min ({total_scenarios} × ~30 sec each)\n\n"
            "Each scenario runs through the real BacktestWorker (same as\n"
            "Run button) so Live Output is produced for every run.\n\n"
            "Results populate live in the results dialog.\n\n"
            "Continue?"
        )
        msg.setStandardButtons(QMessageBox.Yes | QMessageBox.No)
        msg.setDefaultButton(QMessageBox.No)
        if msg.exec_() != QMessageBox.Yes:
            return

        # ------------------------------------------------------------------
        # Step 3: Save current UI state so we can restore it after all runs
        # ------------------------------------------------------------------
        original_config = self._capture_ui_state()

        # ------------------------------------------------------------------
        # Step 4: Capture baseline — run once with current UI config
        # ------------------------------------------------------------------
        baseline_result = None
        try:
            baseline_raw = self._run_test_and_wait()
            baseline_scenario = DiscoveryScenario(
                scenario_id='BASELINE',
                description='[BASELINE] Current config before discovery',
                config_delta={},
                param_labels=[],
            )
            baseline_result = aggregate_metrics(
                baseline_scenario,
                baseline_raw.get('trades_list', []),
                error=None if baseline_raw.get('success', False) else 'Baseline backtest failed',
            )
        except Exception as exc:
            # Non-fatal — proceed without baseline
            self.results_text.append(f"[Config Discovery] Baseline run failed: {exc}")

        # ------------------------------------------------------------------
        # Step 5: Open results dialog immediately (maximised)
        # ------------------------------------------------------------------
        def apply_cb(delta):
            self._apply_discovery_config_to_ui(delta)

        results_dialog = ConfigDiscoveryResultsDialog(
            apply_config_callback=apply_cb,
            parent=self,
        )
        if baseline_result is not None:
            results_dialog.set_baseline(baseline_result)
        results_dialog.showMaximized()
        # Ensure the results dialog is visible and on top when it opens
        results_dialog.raise_()
        results_dialog.activateWindow()

        # Progress dialog so the user sees per-scenario status
        progress = QProgressDialog(
            "Running Config Discovery...",
            "Cancel",
            0,
            total_scenarios,
            self,
        )
        progress.setWindowTitle("Config Discovery")
        progress.setWindowModality(Qt.WindowModal)
        # Show progress dialog in the foreground so the user knows a scan is
        # in progress — without this it can open behind other windows
        progress.show()
        progress.raise_()
        progress.activateWindow()

        # ------------------------------------------------------------------
        # Step 6: Loop over each scenario on the main thread
        # ------------------------------------------------------------------
        test_results = []

        for i, scenario in enumerate(all_scenarios):
            if progress.wasCanceled():
                break

            progress.setValue(i)
            progress.setLabelText(
                f"Scenario {i + 1}/{total_scenarios}: {scenario.description}"
            )
            results_dialog.set_progress(i, total_scenarios, scenario.description)

            # a. Apply scenario config to UI widgets
            self._apply_scenario_to_ui(scenario.config)

            # b. Allow Qt to process widget updates before running backtest
            QApplication.processEvents()

            # c. Run backtest via BacktestWorker (same path as Run button)
            try:
                result = self._run_test_and_wait()
            except Exception as exc:
                result = {'trades': 0, 'trades_list': [], 'total_candles': 0, 'success': False}
                self.results_text.append(
                    f"[Config Discovery] Scenario '{scenario.description}' failed: {exc}"
                )

            # d. Build DiscoveryResult using aggregate_metrics (same as
            #    _generate_discovery_report uses for the wiring test)
            disc_scenario = DiscoveryScenario(
                scenario_id=scenario.id,
                description=scenario.description,
                config_delta=scenario.config,
                param_labels=[(k, str(v)) for k, v in scenario.config.items()],
            )
            error = None if result.get('success', False) else 'Backtest failed or no trades'
            dr = aggregate_metrics(
                disc_scenario,
                result.get('trades_list', []),
                error=error,
            )

            # e. Stream result live into the results dialog
            results_dialog.append_result(dr)

            # Keep raw dict for CSV generation later
            test_results.append({
                'scenario_id': scenario.id,
                'description': scenario.description,
                'config': scenario.config,
                'trades': result.get('trades', 0),
                'trades_list': result.get('trades_list', []),
                'total_candles': result.get('total_candles', 0),
                'success': result.get('success', False),
            })

            # f. Keep UI responsive
            QApplication.processEvents()

        progress.setValue(total_scenarios)
        progress.close()
        results_dialog.set_progress(total_scenarios, total_scenarios, "Complete")

        # Re-raise and activate results dialog now that the progress modal is gone
        results_dialog.raise_()
        results_dialog.activateWindow()
        QApplication.processEvents()

        # ------------------------------------------------------------------
        # Step 7: Restore original UI state
        # ------------------------------------------------------------------
        self._restore_ui_state(original_config)

        # ------------------------------------------------------------------
        # Step 8: Generate CSV report (non-blocking — data already in dialog)
        # ------------------------------------------------------------------
        self._generate_discovery_report(test_results, mode='csv_only')

        self.results_text.append(
            f"\n[Config Discovery] Complete — {len(test_results)} scenarios run.\n"
            "Results dialog shows ranked scenarios.\n"
            "Select a row and click 'Apply Config' to use that config."
        )

    def _on_discovery_complete(self, all_results: list, dialog=None):
        """
        Called when all Config Discovery scenarios have finished.
        
        Phase 3: Final summary appended to results pane.
        """
        total = len(all_results)
        errors = sum(1 for r in all_results if r.error)
        if total > 0:
            best = max((r for r in all_results if not r.error), key=lambda r: r.total_pnl, default=None)
        else:
            best = None

        self.results_text.append(
            f"\n[Config Discovery] Complete — {total} scenarios, {errors} errors."
        )
        if best:
            self.results_text.append(
                f"Best PnL:  {best.description}\n"
                f"  PnL: ${best.total_pnl:.2f}  Win Rate: {best.win_rate:.1f}%  Sharpe: {best.sharpe_ratio:.3f}"
            )

        # Save enhanced CSV via discovery report helper
        self._generate_discovery_report(
            [
                {
                    'scenario_id': r.scenario_id,
                    'description': r.description,
                    'config': r.config_delta,
                    'trades': r.trade_count,
                    'trades_list': r.raw_trades,
                    'success': not bool(r.error),
                }
                for r in all_results
            ],
            mode='csv_only',  # Don't reopen dialog; it's already showing
        )
