"""
Strategy Builder Main Window - Complete UI Application

This is the main window that integrates all Strategy Builder UI components:
- Strategy Information Panel
- Block Search and Selection Panel
- Strategy Blocks Configuration Panel

Features:
- Resizable panels with splitters
- Menu bar (File, Edit, Tools, Help)
- Toolbar with quick actions
- Status bar
- Inter-component communication
- Save/Load functionality

Author: Strategy Builder Team
Date: 2026-01-16
"""

import copy
from typing import Optional
from PyQt5.QtWidgets import (
    QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, QSplitter,
    QAction, QToolBar, QStatusBar, QFileDialog, QMessageBox, QLabel,
    QDialog, QPushButton, QTextBrowser, QGridLayout
)
from PyQt5.QtCore import Qt, QSize, QSettings, QTimer, QThread, pyqtSignal
from PyQt5.QtGui import QIcon, QKeySequence, QFont
from PyQt5.QtWidgets import QApplication, QStyle
from datetime import datetime, timedelta, timezone
import pandas as pd

from src.strategy_builder.integration.strategy_builder_orchestrator import (
    StrategyBuilderOrchestrator
)
from src.strategy_builder.ui.strategy_info_panel import StrategyInfoPanel
from src.strategy_builder.ui.block_search_panel import BlockSearchPanel
from src.strategy_builder.ui.strategy_blocks_panel import StrategyBlocksPanel
from src.strategy_builder.ui.validation_report_window import ValidationReportWindow
from src.strategy_builder.ui.backtest_config_dialog import BacktestConfigDialog
from src.optimizer_v3.validation.institutional_validator import InstitutionalValidator
from src.strategy_builder.ui.data_update_modal import DataUpdateModal
from src.strategy_builder.ui.data_verify_dialog import DataVerifyDialog
from src.strategy_builder.ui.alert_dialog import show_warning, ask_question
from src.strategy_builder.ui.stepper_ribbon import StepperRibbon
from src.strategy_builder.ui.styles import (
    get_main_stylesheet, apply_hand_cursor_to_buttons,
    get_dialog_stylesheet, create_font, get_primary_button_stylesheet,
    get_color, WindowGeometryMixin,
)
from src.strategy_builder.ui.new_strategy_dialog import NewStrategyDialog
from src.strategy_builder.ui.strategy_browser_dialog import StrategyBrowserDialog
from src.strategy_builder.ui.backtest_config_panel import BacktestWorker
from src.optimizer_v3.database import get_database_manager
from src.strategy_builder.ui.settings_dialog import SettingsDialog

import logging
logger = logging.getLogger(__name__)

# Import real block registry adapter
try:
    from src.strategy_builder.core.block_registry_adapter import BlockRegistryAdapter
    BLOCK_REGISTRY_ADAPTER_AVAILABLE = True
except ImportError:
    BLOCK_REGISTRY_ADAPTER_AVAILABLE = False


class _RuntimeCandleUpdateThread(QThread):
    """
    Background QThread for the runtime candle auto-update cycle.

    Fetches and persists the latest candles for *all* managed timeframes
    (15m and 1h) without blocking the Qt event loop.

    RC3 FIX: Added hard 60-second wall-clock timeout.  If verify_and_repair
    does not complete within the deadline, the thread emits finished(False,
    'timeout') and returns so the next cycle is never permanently blocked.

    RC4 FIX: Scan from session_start_time instead of now-2h so gaps older
    than 2 hours are never silently hidden.  The window is capped at 24h to
    prevent excessively long scans on very long sessions.

    RC4b FIX (BTCAAAAA-160): Use last_bar_on_disk as the scan anchor instead
    of session_start_time.  session_start_time can be *after* last_bar_on_disk
    (e.g. app starts at 19:15; last disk bar is 19:00).  When detect_gaps
    filters with start_date=19:15, the 19:00 bar is excluded from `combined`
    so the trailing-edge check never fires and the 19:15, 19:30, … bars are
    never written.  The fix reads get_last_bar_timestamp() and begins the
    scan one 15m period before that anchor.

    Signals:
        finished(success: bool, message: str)
    """
    finished = pyqtSignal(bool, str)

    # Hard wall-clock deadline for one full update cycle (seconds).
    TIMEOUT_SECONDS = 60

    # Maximum lookback from session start (prevents multi-day scan debt).
    MAX_SESSION_LOOKBACK_HOURS = 24

    def __init__(self, parent=None, session_start_time=None):
        super().__init__(parent)
        self._session_start_time = session_start_time

    def run(self) -> None:
        import time as _time
        t_start = _time.monotonic()

        def _elapsed() -> float:
            return _time.monotonic() - t_start

        def _timed_out() -> bool:
            return _elapsed() > self.TIMEOUT_SECONDS

        try:
            from datetime import datetime, timedelta, timezone
            from src.data_manager.unified_manager import UnifiedDataManager

            logger.info(f"[RuntimeUpdate] cycle start")
            manager = UnifiedDataManager(mode='live')

            # Use datetime.now(timezone.utc) for a tz-aware UTC now.
            # detect_gaps_in_binance_files normalizes naive/aware at entry so
            # both forms are accepted, but tz-aware is preferred going forward
            # (datetime.utcnow() is deprecated since Python 3.12).
            now = datetime.now(timezone.utc)

            # RC4b FIX: anchor the scan window to last_bar_on_disk rather than
            # session_start_time.
            #
            # Root cause (BTCAAAAA-160): RC4 used session_start_time as the
            # lower bound.  When the app starts at T and the last bar on disk
            # is at T-15m, detect_gaps receives start_date=T (session_start).
            # After filtering, the T-15m bar is excluded from `combined`, so
            # the trailing-edge check sees an empty or wrong last_bar_ts and
            # never fires.  The T, T+15, T+30 … bars are therefore never
            # written during the session.
            #
            # RC4c NOTE: the original RC4c used ONLY the 15m anchor, reasoning
            # "if 15m is current then 1h is always current too."  This is wrong
            # when 1h was never updated in a prior session — the 1h can have a
            # multi-hour gap while 15m is current.  The fix: compute the anchor
            # separately for each managed timeframe (15m and 1h) as
            # last_bar - 1_bar_period, then use the MINIMUM so the scan window
            # covers whichever timeframe is furthest behind.
            #
            # Cap at MAX_SESSION_LOOKBACK_HOURS to prevent multi-day scan debt.
            max_lookback = now - timedelta(hours=self.MAX_SESSION_LOOKBACK_HOURS)
            try:
                last_15m = manager.get_last_bar_timestamp('15m')
                last_1h  = manager.get_last_bar_timestamp('1h')

                anchor_candidates = []
                if last_15m is not None:
                    anchor_candidates.append(last_15m - timedelta(minutes=15))
                if last_1h is not None:
                    anchor_candidates.append(last_1h - timedelta(hours=1))

                if anchor_candidates:
                    # Use the earliest anchor so the widest gap is never missed.
                    start_date = min(anchor_candidates)
                    logger.info(
                        f"[RuntimeUpdate] scan anchor: "
                        f"last_15m={last_15m.strftime('%H:%M:%S') if last_15m else 'none'}, "
                        f"last_1h={last_1h.strftime('%H:%M:%S') if last_1h else 'none'} "
                        f"→ scan_start={start_date.strftime('%H:%M:%S')} UTC"
                    )
                else:
                    # No bars on disk yet — fall back to session_start - 15m
                    fallback_base = self._session_start_time if self._session_start_time is not None else now
                    start_date = fallback_base - timedelta(minutes=15)
                    logger.info(f"[RuntimeUpdate] no bars on disk; "
                        f"falling back to session_start-15m → {start_date.strftime('%H:%M:%S')}")
            except Exception as _anchor_exc:
                # Defensive: if get_last_bar_timestamp raises, fall back
                # gracefully to session_start_time or 2h window.
                fallback_base = self._session_start_time if self._session_start_time is not None else now
                start_date = fallback_base - timedelta(minutes=15)
                logger.error(f"[RuntimeUpdate] anchor lookup failed ({_anchor_exc}); "
                    f"falling back to {start_date.strftime('%H:%M:%S')}")
            # Normalize start_date to UTC-aware before comparison.
            # get_last_bar_timestamp returns tz-naive (on-disk convention);
            # max_lookback is tz-aware because now = datetime.now(timezone.utc).
            if start_date.tzinfo is None:
                start_date = start_date.replace(tzinfo=timezone.utc)
            # Apply hard lookback cap.
            start_date = max(start_date, max_lookback)

            # Early timeout check before the expensive verify_and_repair call.
            if _timed_out():
                self.finished.emit(False, f"timeout before verify_and_repair ({_elapsed():.1f}s elapsed)")
                return

            t_repair = _time.monotonic()
            summary = manager.verify_and_repair(
                timeframes=['15m', '1h'],
                start_date=start_date,
                end_date=now,
            )
            logger.info(f"[RuntimeUpdate] verify_and_repair completed in {_time.monotonic() - t_repair:.2f}s")

            # Timeout check after the (potentially slow) repair.
            if _timed_out():
                self.finished.emit(
                    False,
                    f"timeout after verify_and_repair ({_elapsed():.1f}s elapsed — limit {self.TIMEOUT_SECONDS}s)"
                )
                return

            tf_lines = []
            any_error = False
            for tf, s in summary.items():
                if s['errors']:
                    any_error = True
                    tf_lines.append(
                        f"{tf}: {s['gaps_repaired']}/{s['gaps_found']} gaps repaired"
                        f" | errors: {'; '.join(s['errors'])}"
                    )
                else:
                    tf_lines.append(
                        f"{tf}: {s['gaps_repaired']}/{s['gaps_found']} gaps repaired"
                        f" ({s['bars_fetched']} bars)"
                    )

            total_elapsed = _elapsed()
            msg = f"Runtime update complete ({total_elapsed:.1f}s) — " + " | ".join(tf_lines)
            logger.info(f"[RuntimeUpdate] {msg}")
            self.finished.emit(not any_error, msg)

        except Exception as exc:
            import traceback
            self.finished.emit(False, f"Runtime update error: {exc}\n{traceback.format_exc()}")


class QuickPreviewResultsDialog(QDialog):
    """Simple popup showing 30-day backtest summary metrics."""

    def __init__(self, win_rate: float, total_signals: int, total_trades: int,
                 avg_return: float, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Quick Preview — 30-Day Backtest")
        self.setModal(True)
        self.setMinimumWidth(320)
        self.setStyleSheet(get_dialog_stylesheet())
        self._build_ui(win_rate, total_signals, total_trades, avg_return)

    def _build_ui(self, win_rate: float, total_signals: int, total_trades: int,
                  avg_return: float):
        layout = QVBoxLayout(self)
        layout.setSpacing(12)
        layout.setContentsMargins(20, 20, 20, 20)

        title = QLabel("30-Day Backtest Summary")
        title.setFont(create_font(13, bold=True))
        title.setStyleSheet(f"color: {get_color('text_primary')};")
        layout.addWidget(title)

        grid = QGridLayout()
        grid.setSpacing(8)
        grid.setColumnMinimumWidth(0, 160)

        metrics = [
            ("Win Rate", f"{win_rate:.1f}%",
             'success' if win_rate >= 50 else 'error'),
            ("Total Signals", str(total_signals), 'text_primary'),
            ("Total Trades", str(total_trades), 'text_primary'),
            ("Avg Return / Trade", f"{avg_return:+.2f}%",
             'success' if avg_return >= 0 else 'error'),
        ]

        for row, (label, value, color_key) in enumerate(metrics):
            lbl = QLabel(f"{label}:")
            lbl.setFont(create_font(10))
            lbl.setStyleSheet(f"color: {get_color('text_muted')};")

            val = QLabel(value)
            val.setFont(create_font(11, bold=True))
            val.setStyleSheet(f"color: {get_color(color_key)};")

            grid.addWidget(lbl, row, 0)
            grid.addWidget(val, row, 1)

        layout.addLayout(grid)

        if total_trades == 0:
            note = QLabel("No trades found in this 30-day period.\n"
                          "Try lowering the confluence threshold.")
            note.setFont(create_font(9))
            note.setWordWrap(True)
            note.setStyleSheet(f"color: {get_color('text_muted')};")
            layout.addWidget(note)

        close_btn = QPushButton("Close")
        close_btn.setFont(create_font(10))
        close_btn.setStyleSheet(get_primary_button_stylesheet(compact=True))
        close_btn.clicked.connect(self.accept)
        layout.addWidget(close_btn)


class StrategyBuilderMainWindow(WindowGeometryMixin, QMainWindow):
    """
    Main application window for Strategy Builder.

    Integrates all UI components and provides menu bar, toolbar, and status bar.
    """

    GEOMETRY_SETTINGS_KEY = "mainWindow"
    GEOMETRY_DEFAULT_SIZE = (1400, 900)
    
    def __init__(self):
        """Initialize the main window."""
        super().__init__()
        self.setObjectName("strategy_builder_main_window")

        # Create orchestrator with real registry adapter if available
        if BLOCK_REGISTRY_ADAPTER_AVAILABLE:
            try:
                adapter = BlockRegistryAdapter()
                self.orchestrator = StrategyBuilderOrchestrator(registry=adapter)
            except Exception as e:
                logger.error(f"Warning: Failed to initialize BlockRegistryAdapter: {e}")
                # Fallback to mock registry
                self.orchestrator = StrategyBuilderOrchestrator()
        else:
            # Fallback to mock registry
            self.orchestrator = StrategyBuilderOrchestrator()
        
        # UI Components
        self.info_panel: Optional[StrategyInfoPanel] = None
        self.search_panel: Optional[BlockSearchPanel] = None
        self.blocks_panel: Optional[StrategyBlocksPanel] = None
        
        # Track current file (legacy - keep for now)
        self.current_file: Optional[str] = None
        self.is_modified = False
        
        # Track current strategy in database
        self.current_strategy_id: Optional[str] = None
        self.current_version_id: Optional[str] = None
        
        # Track workflow state (step completion flags)
        self.validation_passed = False
        self.test_completed = False
        
        # Track validation report for stepper updates from ValidationReportWindow
        self._last_validation_report = None
        
        # Flag to prevent validation reset during strategy load
        self.loading_strategy = False
        
        # Track open windows (singleton pattern)
        self.validation_window: Optional[ValidationReportWindow] = None
        self.browser_window: Optional[StrategyBrowserDialog] = None
        self.backtest_window: Optional[BacktestConfigDialog] = None
        self.log_viewer_window: Optional['LogViewerWindow'] = None

        # Quick Preview state
        self._preview_worker: Optional[BacktestWorker] = None
        self._preview_trades: list = []
        self.preview_btn: Optional[QPushButton] = None

        # Auto-update timers
        self.candle_check_timer: Optional[QTimer] = None
        self.retry_timer: Optional[QTimer] = None
        self.last_update_time: Optional[datetime] = None
        self.retry_count = 0
        self.next_check_time: Optional[datetime] = None
        self._in_quick_retry = False  # guard: only one quick-retry per cycle failure
        self._runtime_update_thread: Optional[_RuntimeCandleUpdateThread] = None  # background update thread
        self._session_start_time: Optional[datetime] = None  # RC4: scan lower bound for verify_and_repair
        
        # Countdown timer for status bar
        self.countdown_timer = QTimer()
        self.countdown_timer.timeout.connect(self._update_countdown_status)
        self.countdown_timer.start(1000)  # Update every second
        
        # Setup UI
        self._init_ui()
        self._create_menu_bar()
        self._create_toolbar()
        self._create_status_bar()
        self._connect_signals()
        
        # Set initial state
        self._update_window_title()
        self._update_status("Ready to create a new strategy")
        
        # Auto-create initial strategy so users can immediately add blocks
        self.orchestrator.create_strategy("New_Strategy")
        
        # Restore window geometry and debug settings
        self._restore_settings()
        self._restore_debug_settings()
        
        # RC2 FIX: Sequence modal BEFORE auto-update to eliminate startup race condition.
        #
        # BEFORE (broken — race condition):
        #   QTimer.singleShot(1500, self._start_auto_update_system)  # fires at t+1500ms
        #   QTimer.singleShot(2000, self._show_data_update_modal)    # fires at t+2000ms
        #   → auto-update thread starts 500ms before modal is done writing parquet files.
        #     If the first 15-min boundary falls inside the modal write window, both
        #     threads write the same file concurrently and the stale bar wins.
        #
        # AFTER (correct — exec_() blocks until modal closes, then auto-update starts):
        #   Single QTimer fires _on_app_start() at t+2000ms.
        #   _show_data_update_modal() calls exec_() which blocks until the modal is closed.
        #   _start_auto_update_system() is called only after modal fully completes.
        #
        # BUG D FIX preserved: 2000ms delay gives the OS network stack / DNS resolver
        # enough time to initialise on slow boots before the first Binance request.
        QTimer.singleShot(2000, self._on_app_start)
    
    def _init_ui(self):
        """Initialize the user interface layout."""
        # Window properties
        self.setWindowTitle("BTC Trade Engine - Strategy Builder")
        self.setGeometry(100, 100, 1400, 900)

        # BTCAAAAA-659: Explicit window flags guarantee the maximize/minimize
        # buttons are present on all platforms (especially Linux window managers
        # that do not expose these controls by default for a bare QMainWindow).
        # Qt.Window ensures an independent top-level window; the three Hint flags
        # make the standard OS title-bar controls unconditionally visible.
        # This mirrors the pattern already used by SettingsDialog (BTCAAAAA-240)
        # and StrategyBrowserDialog.
        self.setWindowFlags(
            Qt.Window
            | Qt.WindowMaximizeButtonHint
            | Qt.WindowMinimizeButtonHint
            | Qt.WindowCloseButtonHint
        )

        # Use OS title bar (change via GNOME theme - see TITLE_BAR_COLOR_FIX.md)
        
        # Apply centralized dark theme stylesheet
        self.setStyleSheet(get_main_stylesheet())
        
        # Central widget container
        central_widget = QWidget()
        self.setCentralWidget(central_widget)
        
        # Main layout
        main_layout = QVBoxLayout()
        main_layout.setContentsMargins(0, 0, 0, 0)
        central_widget.setLayout(main_layout)
        
        # Create main splitter (horizontal split)
        main_splitter = QSplitter(Qt.Horizontal)
        
        # Left side: Info panel (top) + Blocks panel (bottom)
        left_widget = QWidget()
        left_layout = QVBoxLayout()
        left_layout.setContentsMargins(5, 5, 5, 5)
        left_layout.setSpacing(10)
        
        # Create panels
        self.info_panel = StrategyInfoPanel(self.orchestrator)
        self.blocks_panel = StrategyBlocksPanel(self.orchestrator)
        
        # Add to left layout (validation panel removed - now shown as modal)
        left_layout.addWidget(self.info_panel)
        left_layout.addWidget(self.blocks_panel, stretch=1)
        left_widget.setLayout(left_layout)
        
        # Right side: Search panel
        self.search_panel = BlockSearchPanel(self.orchestrator)
        
        # Add to splitter
        main_splitter.addWidget(left_widget)
        main_splitter.addWidget(self.search_panel)
        
        # Set initial splitter sizes (40% left, 60% right)
        main_splitter.setSizes([560, 840])
        
        # CRITICAL: Prevent panels from being collapsed/disappearing
        # Index 0 = left (info + blocks), Index 1 = right (search panel)
        main_splitter.setCollapsible(0, False)  # Left cannot collapse
        main_splitter.setCollapsible(1, False)  # Right cannot collapse
        
        # Add visual drag indicator to splitter handle (match Strategy Browser)
        main_splitter.setHandleWidth(8)  # Wider handle for better visibility
        main_splitter.setStyleSheet("""
            QSplitter::handle:horizontal {
                background-color: #3C4149;
                width: 8px;
                margin: 0px;
                padding: 0px;
                image: url(none);
            }
            QSplitter::handle:horizontal:hover {
                background-color: #095983;
            }
        """)
        
        # Add drag indicator icon to handle  
        handle = main_splitter.handle(1)
        if handle:
            from PyQt5.QtGui import QFont
            from .styles import create_font
            
            handle_layout = QVBoxLayout(handle)
            handle_layout.setContentsMargins(0, 0, 0, 0)
            handle_layout.setSpacing(0)
            
            # Add centered drag icon (⋮⋮⋮) - muted color
            drag_icon = QLabel("⋮\n⋮\n⋮")
            drag_icon.setFont(create_font(10, bold=True))
            drag_icon.setStyleSheet("color: #4A4F58; background: transparent;")  # Muted gray
            drag_icon.setAlignment(Qt.AlignmentFlag.AlignCenter)
            handle_layout.addWidget(drag_icon)
        
        # Store splitter for settings save/restore
        self.main_splitter = main_splitter
        
        # Add splitter to main layout
        main_layout.addWidget(main_splitter)
    
    def _create_menu_bar(self):
        """Create the menu bar with professional icons."""
        menu_bar = self.menuBar()
        menu_bar.setNativeMenuBar(False)
        style = self.style()
        
        # File Menu
        file_menu = menu_bar.addMenu("&File")
        
        new_action = QAction(style.standardIcon(QStyle.SP_FileIcon), "&New Strategy", self)
        new_action.setShortcut(QKeySequence.New)
        new_action.setStatusTip("Create a new strategy")
        new_action.setToolTip("Create a new blank strategy in the database")
        new_action.triggered.connect(self._on_new_strategy)
        file_menu.addAction(new_action)
        
        open_action = QAction(style.standardIcon(QStyle.SP_DirOpenIcon), "&Open Strategy...", self)
        open_action.setShortcut(QKeySequence.Open)
        open_action.setStatusTip("Open an existing strategy")
        open_action.setToolTip("Browse and open a saved strategy from the database")
        open_action.triggered.connect(self._on_open_strategy)
        file_menu.addAction(open_action)
        
        file_menu.addSeparator()
        
        save_action = QAction(style.standardIcon(QStyle.SP_DialogSaveButton), "&Save Strategy", self)
        save_action.setShortcut(QKeySequence.Save)
        save_action.setStatusTip("Save the current strategy")
        save_action.setToolTip("Save the current strategy configuration to the database")
        save_action.triggered.connect(self._on_save_strategy)
        file_menu.addAction(save_action)
        
        save_as_action = QAction(style.standardIcon(QStyle.SP_DialogSaveButton), "Save Strategy &As...", self)
        save_as_action.setShortcut(QKeySequence.SaveAs)
        save_as_action.setStatusTip("Save the strategy with a new name")
        save_as_action.setToolTip("Save a copy of the current strategy under a different name")
        save_as_action.triggered.connect(self._on_save_strategy_as)
        file_menu.addAction(save_as_action)
        
        file_menu.addSeparator()
        
        exit_action = QAction(style.standardIcon(QStyle.SP_DialogCloseButton), "E&xit", self)
        exit_action.setShortcut(QKeySequence.Quit)
        exit_action.setStatusTip("Exit the application")
        exit_action.setToolTip("Exit BTC Trade Engine")
        exit_action.triggered.connect(self.close)
        file_menu.addAction(exit_action)
        
        # Edit Menu
        edit_menu = menu_bar.addMenu("&Edit")
        
        clear_action = QAction(style.standardIcon(QStyle.SP_TrashIcon), "&Clear All Blocks", self)
        clear_action.setStatusTip("Remove all blocks from strategy")
        clear_action.setToolTip("Remove all building blocks from the current strategy (cannot be undone)")
        clear_action.triggered.connect(self._on_clear_blocks)
        edit_menu.addAction(clear_action)
        
        # Tools Menu
        tools_menu = menu_bar.addMenu("&Tools")
        
        update_data_action = QAction(style.standardIcon(QStyle.SP_BrowserReload), "&Update Data...", self)
        update_data_action.setStatusTip("Check for data gaps and update from Binance")
        update_data_action.setToolTip("Check for missing BTC/USDT bars and download updates from Binance")
        update_data_action.triggered.connect(self._on_update_data)
        tools_menu.addAction(update_data_action)

        verify_data_action = QAction(style.standardIcon(QStyle.SP_DialogApplyButton), "&Verify Data...", self)
        verify_data_action.setStatusTip("Verify data integrity and check for gaps")
        verify_data_action.setToolTip("Run a full integrity scan across all data timeframes and identify repairable gaps")
        verify_data_action.triggered.connect(self._on_verify_data)
        tools_menu.addAction(verify_data_action)

        tools_menu.addSeparator()

        settings_action = QAction(style.standardIcon(QStyle.SP_FileDialogDetailedView), "&Settings...", self)
        settings_action.setStatusTip("Edit application settings (API keys, preferences, admin options)")
        settings_action.setToolTip("Configure API keys, preferences, and admin options")
        settings_action.triggered.connect(self._on_settings)
        tools_menu.addAction(settings_action)

        tools_menu.addSeparator()
        
        # Debug Logger submenu
        debug_menu = tools_menu.addMenu(style.standardIcon(QStyle.SP_FileDialogInfoView), "&Debug Logger")
        
        self.enable_console_action = QAction("Enable Debugger in Console", self)
        self.enable_console_action.setCheckable(True)
        self.enable_console_action.setChecked(True)  # Default: enabled
        self.enable_console_action.setStatusTip("Toggle debug output to console")
        self.enable_console_action.setToolTip("When enabled, debug log messages are printed to the terminal console")
        self.enable_console_action.triggered.connect(self._on_toggle_console_debug)
        debug_menu.addAction(self.enable_console_action)
        
        self.enable_logfile_action = QAction("Enable Debugger in Log File", self)
        self.enable_logfile_action.setCheckable(True)
        self.enable_logfile_action.setChecked(True)  # Default: enabled
        self.enable_logfile_action.setStatusTip("Toggle debug output to log files")
        self.enable_logfile_action.setToolTip("When enabled, debug log messages are written to the logs/ directory")
        self.enable_logfile_action.triggered.connect(self._on_toggle_logfile_debug)
        debug_menu.addAction(self.enable_logfile_action)
        
        debug_menu.addSeparator()
        
        clear_logs_action = QAction(style.standardIcon(QStyle.SP_TrashIcon), "Clear Old Logs", self)
        clear_logs_action.setStatusTip("Delete old log files")
        clear_logs_action.setToolTip("Delete old log files from the logs/ directory to free up disk space")
        clear_logs_action.triggered.connect(self._on_clear_old_logs)
        debug_menu.addAction(clear_logs_action)
        
        view_log_action = QAction(style.standardIcon(QStyle.SP_FileDialogDetailedView), "View Current Log File", self)
        view_log_action.setStatusTip("Open the current log file")
        view_log_action.setToolTip("Open the current session log file in the built-in log viewer")
        view_log_action.triggered.connect(self._on_view_current_log)
        debug_menu.addAction(view_log_action)
        
        # Help Menu
        help_menu = menu_bar.addMenu("&Help")
        
        about_action = QAction(style.standardIcon(QStyle.SP_MessageBoxInformation), "&About Strategy Builder", self)
        about_action.setStatusTip("About Strategy Builder")
        about_action.setToolTip("Show version, capabilities, and information about BTC Trade Engine")
        about_action.triggered.connect(self._on_about)
        help_menu.addAction(about_action)
    
    def _create_toolbar(self):
        """Create the toolbar with professional icons and text."""
        toolbar = QToolBar("Main Toolbar")
        toolbar.setObjectName("MainToolbar")  # Fix Qt warning on close
        toolbar.setIconSize(QSize(32, 32))  # Bigger icons
        toolbar.setToolButtonStyle(Qt.ToolButtonTextBesideIcon)  # Show text with icons
        toolbar.setMovable(False)
        self.addToolBar(toolbar)
        
        style = self.style()
        
        # New Strategy
        new_action = QAction(style.standardIcon(QStyle.SP_FileIcon), "New", self)
        new_action.setStatusTip("Create a new strategy")
        new_action.setToolTip("Create a new strategy (Ctrl+N)")
        new_action.triggered.connect(self._on_new_strategy)
        toolbar.addAction(new_action)
        
        # Open Strategy
        open_action = QAction(style.standardIcon(QStyle.SP_DirOpenIcon), "Open", self)
        open_action.setStatusTip("Open strategy")
        open_action.setToolTip("Open an existing strategy from the database (Ctrl+O)")
        open_action.triggered.connect(self._on_open_strategy)
        toolbar.addAction(open_action)
        
        # Save Strategy
        save_action = QAction(style.standardIcon(QStyle.SP_DialogSaveButton), "Save", self)
        save_action.setStatusTip("Save strategy")
        save_action.setToolTip("Save the current strategy to the database (Ctrl+S)")
        save_action.triggered.connect(self._on_save_strategy)
        toolbar.addAction(save_action)

        # Quick Preview button
        self.preview_btn = QPushButton("Quick Preview")
        self.preview_btn.setFont(create_font(10, bold=True))
        self.preview_btn.setStyleSheet(get_primary_button_stylesheet(compact=True))
        self.preview_btn.setToolTip(
            "Run a 30-day historical backtest preview in the background.\n"
            "Shows win rate, total trades, and average return."
        )
        self.preview_btn.setStatusTip("Run 30-day quick preview backtest")
        self.preview_btn.clicked.connect(self._on_quick_preview)
        toolbar.addWidget(self.preview_btn)

        toolbar.addSeparator()
        
        # Add stepper - make it expand to fill toolbar so internal margin works
        self.stepper = StepperRibbon(self)
        self.stepper.step_clicked.connect(self._on_step_clicked)
        self.stepper.setSizePolicy(QWidget().sizePolicy().Expanding, QWidget().sizePolicy().Preferred)
        toolbar.addWidget(self.stepper)
    
    def _create_status_bar(self):
        """Create the status bar."""
        self.statusBar().showMessage("Ready")
    
    def _connect_signals(self):
        """Connect signals between components."""
        # Block selection: Add to blocks panel
        self.search_panel.block_selected.connect(self._on_block_selected)
        
        # Blocks changed: Refresh other panels
        self.blocks_panel.blocks_changed.connect(self._on_blocks_changed)
        
        # Strategy name changed: Update window title
        self.info_panel.strategy_name_changed.connect(self._on_strategy_name_changed)
        
        # Strategy type changed: Reset validation (requires re-validation)
        self.info_panel.strategy_type_changed.connect(self._on_strategy_type_changed)
    
    def _on_block_selected(self, block_name: str):
        """Handle block selection from search panel."""
        # NOTE: Blocks are now added via orchestrator.add_block_with_signals()
        # which is called from the search panel. We just need to refresh the display.
        
        # Save current name if it's blank (user hasn't named strategy yet)
        current_name = self.info_panel.get_strategy_name()
        preserve_blank = (current_name == "" or current_name.strip() == "")
        
        # Refresh blocks panel to show newly added block
        self.blocks_panel.refresh_from_orchestrator()
        
        # Refresh info panel to update description and required signals
        self.info_panel.refresh_from_orchestrator()
        
        # CRITICAL: Restore blank name if user hasn't named strategy yet
        # (refresh pulls "New_Strategy" from config, which should stay hidden from user)
        if preserve_blank:
            self.info_panel.set_strategy_name("")
        
        # Mark as added in search panel
        self.search_panel.mark_block_as_added(block_name)
        
        # Update status
        block_count = self.blocks_panel.get_block_count()
        self._update_status(f"Added block: {block_name} ({block_count} blocks total)")
        self.is_modified = True
        self._update_window_title()
    
    def reset_validation(self):
        """
        CENTRAL METHOD: Reset validation state when ANY configuration changes.
        
        Called by:
        - Block changes (add/remove/reorder)
        - Signal timing/recheck configuration
        - Exit condition configuration
        - Strategy name/type changes
        - Any other strategy mutation
        
        Forces user to re-validate after ANY modification.
        """
        # FIX: Always reset if step 1 has ANY status (completed or error)
        # Must clear completed_steps AND force visual button reset FOR STEP 1 ONLY
        if 1 in self.stepper.completed_steps or 1 in self.stepper.error_steps:
            self.validation_passed = False
            # Clear step 1 from sets
            self.stepper.completed_steps.discard(1)
            self.stepper.error_steps.discard(1)
            # Force visual refresh by calling _update_display() which rebuilds button styles
            self.stepper._update_display()
    
    def _on_blocks_changed(self):
        """Handle blocks changed event."""
        # Save current name if it's blank (user hasn't named strategy yet)
        current_name = self.info_panel.get_strategy_name()
        preserve_blank = (current_name == "" or current_name.strip() == "")
        
        # Refresh info panel to update description and required signals
        self.info_panel.refresh_from_orchestrator()
        
        # CRITICAL: Restore blank name if user hasn't named strategy yet
        # (refresh pulls "New_Strategy" from config, which should stay hidden from user)
        if preserve_blank:
            self.info_panel.set_strategy_name("")
        
        # Sync search panel button states with actual strategy blocks
        self.search_panel.sync_with_strategy()
        
        # Mark as modified
        self.is_modified = True
        self._update_window_title()
        
        # RESET VALIDATION when blocks change (BUT NOT during strategy load)
        if not self.loading_strategy:
            self.reset_validation()
        
        # Update status
        block_count = self.blocks_panel.get_block_count()
        self._update_status(f"Strategy updated - {block_count} block(s) configured")
    
    def _on_strategy_name_changed(self, name: str):
        """Handle strategy name change."""
        self.is_modified = True
        self._update_window_title()
        # RESET VALIDATION when strategy name changes (BUT NOT during load)
        if not self.loading_strategy:
            self.reset_validation()
    
    def _on_strategy_type_changed(self, strategy_type: str):
        """Handle strategy type change (Bullish/Bearish)."""
        self.is_modified = True
        # RESET VALIDATION when strategy type changes (BUT NOT during load)
        if not self.loading_strategy:
            self.reset_validation()
    
    def _is_strategy_empty(self) -> bool:
        """
        Check if strategy is truly empty (nothing worth saving).
        
        Returns:
            True if strategy has no name and no blocks, False otherwise
        """
        strategy_name = self.info_panel.get_strategy_name()
        block_count = self.blocks_panel.get_block_count()
        
        # Empty if no name AND no blocks
        return (not strategy_name or strategy_name.strip() == "") and block_count == 0
    
    def _on_new_strategy(self):
        """Create a new strategy - reset to clean state."""
        # Check if current strategy should be saved (skip if empty)
        if self.is_modified and not self._is_strategy_empty():
            reply = ask_question(
                self,
                "Unsaved Changes",
                "Unsaved Changes",
                "You have unsaved changes. Do you want to save before creating a new strategy?"
            )
            
            if reply == 'yes':
                if not self._on_save_strategy():
                    return  # Save was cancelled
            elif reply == 'cancel':
                return
        
        # Reset strategy in orchestrator with placeholder (allows adding blocks immediately)
        self.orchestrator.create_strategy("New_Strategy")
        
        # Update UI with blank name field (user enters their own name)
        # The placeholder "New_Strategy" is used internally but hidden from user
        self.info_panel.set_strategy_name("")
        self.info_panel.set_description("")
        
        # Clear database IDs (new strategy, not saved yet)
        self.current_strategy_id = None
        self.current_version_id = None
        # BTCAAAAA-33: Clear orchestrator IDs too so backtest panel sees clean state
        self.orchestrator.current_strategy_id = None
        self.orchestrator.current_version_id = None
        
        # Clear file tracking
        self.current_file = None
        self.is_modified = False  # Clean state, nothing to save yet
        
        # Clear visual markers
        self.search_panel.clear_added_blocks()
        
        # Refresh blocks panel to show empty state
        self.blocks_panel.refresh_from_orchestrator()
        # NOTE: Don't refresh info_panel - it would pull "New_Strategy" from config
        # and overwrite the blank name we just set. We already set name/description above.
        
        # Reset validation and test states
        self.validation_passed = False
        self.test_completed = False
        self.stepper.reset_all_steps()
        
        # Update UI
        self._update_window_title()
        self._update_status("New strategy created - Ready to add blocks")
    
    def _on_open_strategy(self):
        """Open strategy from database using StrategyBrowserDialog (singleton pattern)."""
        # Check if browser window already exists and is visible
        if self.browser_window and self.browser_window.isVisible():
            # Focus existing window instead of creating new one
            self.browser_window.raise_()
            self.browser_window.activateWindow()
            return
        
        # Check if current strategy should be saved (skip if empty)
        if self.is_modified and not self._is_strategy_empty():
            reply = ask_question(
                self,
                "Unsaved Changes",
                "Unsaved Changes",
                "You have unsaved changes. Do you want to save before opening another strategy?"
            )
            
            if reply == 'yes':
                if not self._on_save_strategy():
                    return  # Save was cancelled
            elif reply == 'cancel':
                return
        
        # Create and show strategy browser window
        self.browser_window = StrategyBrowserDialog(mode='open', parent=self)
        
        # Connect signal for when strategy is selected
        self.browser_window.strategy_selected.connect(self._load_strategy_from_browser)
        
        # Connect signal for when strategy is deleted (handle cleanup)
        self.browser_window.strategy_deleted.connect(self._on_strategy_deleted)

        # Clear reference when window is destroyed
        self.browser_window.destroyed.connect(lambda: setattr(self, 'browser_window', None))
        
        # Show as non-modal window
        self.browser_window.show()
    
    def _load_strategy_from_browser(self, strategy_id: str, version_id: str):
        """Load strategy after selection from browser"""
        if not strategy_id or not version_id:
            QMessageBox.warning(self, "Open Failed", "No strategy selected")
            return
        
        try:
            # Load strategy from database
            db = get_database_manager()
            version = db.strategy.get_strategy_version(version_id)
            
            if not version:
                QMessageBox.warning(self, "Load Failed", "Strategy version not found in database")
                return
            
            # Load validation status from database and restore stepper state
            validation_status = version.get('validation_status', 'Un-Validated')
            
            if validation_status == 'Pass':
                self.validation_passed = True
                self.test_completed = False
                self.stepper.reset_all_steps()
                self.stepper.mark_step_complete(1)  # Green check mark
            elif validation_status == 'Fail':
                self.validation_passed = False
                self.test_completed = False
                self.stepper.reset_all_steps()
                self.stepper.mark_step_error(1)  # Red X mark
            else:  # Un-Validated
                self.validation_passed = False
                self.test_completed = False
                self.stepper.reset_all_steps()  # Default state
            
            # Load blocks from database using persistence (SAME AS FILE LOAD)
            blocks_data = version.get('blocks', [])
            exit_conditions_data = version.get('exit_conditions', [])  # Sprint 1.8: Load exit conditions
            
            # Build config dict in EXACT same format as file load
            config_dict = {
                'name': version['name'],
                'description': version.get('description', ''),
                'strategy_type': version.get('strategy_type', 'Bullish'),  # Include strategy type
                'blocks': blocks_data,
                'exit_conditions': exit_conditions_data  # Sprint 1.8: Include exit conditions
            }
            
            # SUPPRESS validation reset during load AND all refresh operations
            self.loading_strategy = True
            
            try:
                # Use persistence._dict_to_config() - EXACT same as file load
                restored_config = self.orchestrator.persistence._dict_to_config(config_dict)
                
                # Add version number to config for UI display
                restored_config.version = version['version_number']
                
                # Assign to config engine (SAME PATTERN as orchestrator.load_strategy)
                self.orchestrator.config_engine.config = restored_config
                
                logger.info(f"Successfully restored {len(restored_config.blocks)} blocks with full config")
                
            except Exception as e:
                logger.error(f"Error loading config from database: {e}")
                import traceback
                traceback.print_exc()
                # Fallback to empty config
                self.orchestrator.create_strategy(version['name'])
            
            # Update UI panels with loaded data (STILL loading)
            self.info_panel.set_strategy_name(version['name'])
            if version.get('description'):
                self.info_panel.set_description(version['description'])
            
            # Track database IDs
            self.current_strategy_id = strategy_id
            self.current_version_id = version_id
            
            # CRITICAL (Sprint 2.0.2): Tell orchestrator about loaded version for backtest
            self.orchestrator.current_version_id = version_id
            # BTCAAAAA-33: Also propagate strategy_id so BacktestConfigPanel can read it
            self.orchestrator.current_strategy_id = strategy_id
            
            # Clear file tracking
            self.current_file = None
            self.is_modified = False
            
            # Clear and refresh panels (refresh can trigger blocks_changed!)
            self.search_panel.clear_added_blocks()
            self.blocks_panel.refresh_from_orchestrator()
            self.info_panel.refresh_from_orchestrator()
            
            # CRITICAL FIX: Sync search panel with loaded strategy to update button states
            self.search_panel.sync_with_strategy()
            
            # NOW re-enable validation reset (AFTER all refresh operations)
            self.loading_strategy = False
            
            # ── Config retention: restore saved backtest config ───────────────
            # BTCAAAAA-252: Load and stash the persisted backtest_config so it
            # can be applied to the BacktestConfigPanel immediately if the
            # window is already open, or deferred until it is opened.
            saved_backtest_config = version.get('backtest_config') or {}
            # Stash on the orchestrator so _on_run_backtest can access it
            self.orchestrator._pending_backtest_config = saved_backtest_config
            if saved_backtest_config and saved_backtest_config.get('lookback_days'):
                if self.backtest_window and self.backtest_window.isVisible():
                    try:
                        self.backtest_window.backtest_panel.apply_config_from_dict(
                            saved_backtest_config, source='database'
                        )
                        logger.info(
                            "[ConfigRetention] Restored backtest config to open panel"
                        )
                    except Exception as _e:
                        logger.warning(
                            f"[ConfigRetention] Could not restore to open panel: {_e}"
                        )
            # ── End config retention ──────────────────────────────────────────

            # Update UI
            self._update_window_title()
            self._update_status(f"Loaded strategy: {version['name']} (v{version['version_number']}) from database")
            
        except Exception as e:
            QMessageBox.critical(self, "Error", f"Error loading strategy from database:\n\n{str(e)}")
            import traceback
            traceback.print_exc()
    
    def _on_strategy_deleted(self, strategy_id: str, was_entire_strategy: bool):
        """
        Handle strategy deletion from browser dialog.
        
        If the currently loaded strategy was deleted, clear the main window.
        
        Args:
            strategy_id: ID of deleted strategy
            was_entire_strategy: True if entire strategy deleted, False if just versions
        """
        # Check if the deleted strategy is the one currently loaded
        if self.current_strategy_id == strategy_id:
            if was_entire_strategy:
                # Entire strategy deleted - clear main window
                self._on_new_strategy()
                self._update_status(f"Loaded strategy was deleted - cleared workspace")
            else:
                # Specific versions deleted - check if current version still exists
                if self.current_version_id:
                    try:
                        db = get_database_manager()
                        version = db.strategy.get_strategy_version(self.current_version_id)
                        if not version:
                            # Current version was deleted - clear workspace
                            self._on_new_strategy()
                            self._update_status(f"Loaded version was deleted - cleared workspace")
                    except:
                        pass  # Silence errors
    
    def _on_save_strategy(self) -> bool:
        """Save the current strategy to database with proper rollback on failure."""
        # CRITICAL: Don't create new version if nothing changed
        if not self.is_modified:
            QMessageBox.information(
                self,
                "No Changes",
                "No changes detected - strategy is already saved.\n\n"
                "A new version will only be created if you modify the strategy."
            )
            return True  # Not an error, just nothing to do
        
        db = None
        created_strategy = False
        
        try:
            # Get strategy data from UI
            strategy_name = self.info_panel.get_strategy_name()
            description = self.info_panel.get_description()
            
            if not strategy_name or strategy_name.strip() == "":
                QMessageBox.warning(self, "Save Failed", "Strategy must have a name before saving.")
                return False
            
            # Get database manager
            db = get_database_manager()
            
            # CRITICAL: Rollback any previous failed state
            db.strategy.session.rollback()
            
            # If this is a new strategy (no strategy_id yet), create it
            if not self.current_strategy_id:
                self.current_strategy_id = db.strategy.create_strategy(strategy_name)
                created_strategy = True
            
            # Build version data from current config using persistence (SAME AS FILE SAVE)
            config = self.orchestrator.get_current_config()
            
            # CRITICAL: Update config from UI BEFORE converting to dict (same as file save)
            strategy_type = self.info_panel.get_strategy_type()
            if strategy_type and config:
                config.strategy_type = strategy_type
            
            # Use persistence._config_to_dict() - EXACT same as file save
            config_dict = self.orchestrator.persistence._config_to_dict(config) if config else {}
            
            # DOUBLE-CHECK: Read strategy type directly from UI as final override
            ui_strategy_type = self.info_panel.get_strategy_type() or 'Bullish'
            
            version_data = {
                'strategy_id': self.current_strategy_id,
                'name': strategy_name,
                'description': description or '',
                'strategy_type': ui_strategy_type,  # CRITICAL: Use UI value directly, not dict
                # CRITICAL: deepcopy JSONB fields so each saved version row holds an
                # independent snapshot — prevents shared Python list/dict references from
                # silently polluting other version rows via the SQLAlchemy session.
                'blocks': copy.deepcopy(config_dict.get('blocks', [])),
                'signals': {},  # Reserved
                'parameters': {},  # Reserved
                'entry_conditions': {},  # Reserved
                'exit_conditions': copy.deepcopy(config_dict.get('exit_conditions', [])),  # Sprint 1.8
                'risk_management': {},  # Reserved
                'backtest_config': {},  # Reserved
                'tags': []  # Reserved
            }
            
            # Create new version
            try:
                self.current_version_id = db.strategy.create_strategy_version(version_data)
                
                # CRITICAL: Get new version number from database and update UI
                new_version = db.strategy.get_strategy_version(self.current_version_id)
                if new_version:
                    new_version_number = new_version['version_number']
                    
                    # Update config with new version number
                    self.orchestrator.config_engine.config.version = new_version_number
                    
                    # Refresh info panel to show new version in display
                    self.info_panel.refresh_from_orchestrator()
                
            except Exception as version_error:
                # VERSION CREATION FAILED
                logger.error(f"\n❌ VERSION CREATION FAILED!")
                logger.error(f"   Error: {version_error}")
                logger.error(f"   Error type: {type(version_error)}")
                import traceback
                traceback.print_exc()
                
                # Note: create_strategy_version already rolled back
                
                # If we created the strategy in this save, delete the orphan
                # Use a FRESH transaction (previous one was rolled back)
                if created_strategy:
                    try:
                        from sqlalchemy import text
                        logger.info(f"   Cleaning up orphaned strategy: {self.current_strategy_id}")
                        # Execute delete in fresh transaction (no intermediate rollback needed)
                        db.strategy.session.execute(
                            text("DELETE FROM strategies WHERE strategy_id = :sid"),
                            {'sid': self.current_strategy_id}
                        )
                        db.strategy.session.commit()
                        logger.info(f"   ✅ Orphan deleted")
                    except Exception as cleanup_error:
                        # Cleanup failed - log but don't block error reporting
                        db.strategy.session.rollback()
                        logger.error(f"   ❌ Failed to cleanup orphaned strategy: {cleanup_error}")
                    
                    self.current_strategy_id = None
                
                # Re-raise the original error
                raise version_error
            
            # Mark as not modified
            self.is_modified = False
            self._update_window_title()
            self._update_status(f"Strategy saved to database: {strategy_name}")
            
            return True
            
        except Exception as e:
            # Rollback on any error
            if db:
                db.strategy.session.rollback()
            
            QMessageBox.critical(self, "Error", f"Error saving strategy to database:\n\n{str(e)}")
            import traceback
            traceback.print_exc()
            return False
    
    def _on_save_strategy_with_feedback(self) -> bool:
        """Save the current strategy with success dialog (for validation dialog)."""
        if self.current_file:
            return self._save_to_file(self.current_file, show_success=True)
        else:
            # Save As always shows its own dialog, so no need for extra feedback
            return self._on_save_strategy_as()
    
    def _on_save_strategy_as(self) -> bool:
        """Save as new strategy (creates new strategy_id in database)."""
        try:
            # Show new strategy dialog to get name for new copy
            dialog = NewStrategyDialog(self)
            if dialog.exec_() != NewStrategyDialog.Accepted:
                return False  # User cancelled
            
            # Get new strategy data
            data = dialog.get_strategy_data()
            
            # Create NEW strategy (different strategy_id)
            db = get_database_manager()
            new_strategy_id = db.strategy.create_strategy(data['name'])
            
            # Build version data from current config (SAME AS FILE SAVE)
            config = self.orchestrator.get_current_config()
            
            # Use persistence._config_to_dict() - EXACT same as file save
            config_dict = self.orchestrator.persistence._config_to_dict(config) if config else {}
            
            version_data = {
                'strategy_id': new_strategy_id,  # NEW strategy ID
                'name': data['name'],
                'description': data.get('description', ''),
                'strategy_type': config_dict.get('strategy_type', 'Bullish'),  # Save strategy type
                # CRITICAL: deepcopy JSONB fields so this version row holds an
                # independent snapshot; also fixes missing exit_conditions (was {}).
                'blocks': copy.deepcopy(config_dict.get('blocks', [])),
                'signals': {},
                'parameters': {},
                'entry_conditions': {},
                'exit_conditions': copy.deepcopy(config_dict.get('exit_conditions', [])),
                'risk_management': {},
                'backtest_config': {},
                'tags': []
            }
            
            # Create version for new strategy
            new_version_id = db.strategy.create_strategy_version(version_data)
            
            # Update tracking to new strategy
            self.current_strategy_id = new_strategy_id
            self.current_version_id = new_version_id
            
            # Update UI with new name
            self.info_panel.set_strategy_name(data['name'])
            if data.get('description'):
                self.info_panel.set_description(data['description'])
            
            # Mark as not modified
            self.is_modified = False
            self._update_window_title()
            self._update_status(f"Strategy saved as: {data['name']} (new strategy in database)")
            
            return True
            
        except Exception as e:
            QMessageBox.critical(self, "Error", f"Error saving strategy as:\n\n{str(e)}")
            import traceback
            traceback.print_exc()
            return False
    
    def _save_to_file(self, filename: str, show_success: bool = False) -> bool:
        """
        Save strategy to file.
        
        Args:
            filename: Path to save file
            show_success: Whether to show success message dialog
        """
        try:
            # Check for strategy type mismatch before saving
            if not self._check_strategy_type_match():
                return False  # User cancelled save
            
            # Update config from UI before saving
            strategy_name = self.info_panel.get_strategy_name()
            if strategy_name:
                self.orchestrator.config_engine.config.name = strategy_name
            
            # Also update strategy type from UI
            strategy_type = self.info_panel.get_strategy_type()
            if strategy_type:
                # Ensure config has strategy_type attribute
                if hasattr(self.orchestrator.config_engine.config, 'strategy_type'):
                    self.orchestrator.config_engine.config.strategy_type = strategy_type
                else:
                    # Add attribute if it doesn't exist
                    setattr(self.orchestrator.config_engine.config, 'strategy_type', strategy_type)
            
            # CRITICAL RECHECK: Verify config matches UI before saving
            ui_type = self.info_panel.get_strategy_type()
            config_type = getattr(self.orchestrator.config_engine.config, 'strategy_type', None)
            if config_type != ui_type:
                logger.warning(f"WARNING: Config mismatch before save! UI={ui_type}, Config={config_type}")
                logger.info(f"Forcing config to match UI: {ui_type}")
                # Force config to match UI
                if hasattr(self.orchestrator.config_engine.config, 'strategy_type'):
                    self.orchestrator.config_engine.config.strategy_type = ui_type
                else:
                    setattr(self.orchestrator.config_engine.config, 'strategy_type', ui_type)
                logger.info(f"Config now: {self.orchestrator.config_engine.config.strategy_type}")
            
            # PERSIST WORKFLOW STATE: Save validation status
            if self.validation_passed:
                if not hasattr(self.orchestrator.config_engine.config, 'validation_status'):
                    setattr(self.orchestrator.config_engine.config, 'validation_status', 'passed')
                else:
                    self.orchestrator.config_engine.config.validation_status = 'passed'
            
            # Save using orchestrator
            result = self.orchestrator.save_strategy(filename)
            
            if result.success:
                self.current_file = filename
                self.is_modified = False
                
                # Save directory for next time
                import os
                settings = QSettings("BTC_Engine", "StrategyBuilder")
                settings.setValue("lastDirectory", os.path.dirname(filename))
                
                self._update_window_title()
                self._update_status(f"Saved strategy to: {filename}")
                
                # Show success message if requested (e.g., when called from validation dialog)
                if show_success:
                    QMessageBox.information(
                        self,
                        "Strategy Saved",
                        f"Strategy saved successfully!\n\nFile: {filename}"
                    )
                
                return True
            else:
                QMessageBox.warning(self, "Save Failed", f"Failed to save strategy: {result.message}")
                return False
        except Exception as e:
            QMessageBox.critical(self, "Error", f"Error saving strategy: {str(e)}")
            return False
    
    def _on_clear_blocks(self):
        """Clear all blocks from strategy."""
        reply = ask_question(
            self,
            "Clear Blocks",
            "Clear All Blocks",
            "Are you sure you want to remove all blocks from the strategy?"
        )
        
        if reply == 'yes':
            # Clear blocks
            self.search_panel.clear_added_blocks()
            # Refresh will happen via blocks_changed signal
            self._update_status("All blocks cleared")
    
    def _on_validate(self):
        """Validate the current strategy."""
        try:
            result = self.orchestrator.validate_strategy()
            
            if result.success:
                QMessageBox.information(
                    self,
                    "Validation Success",
                    "Strategy configuration is valid!"
                )
                self._update_status("Strategy validated successfully")
            else:
                QMessageBox.warning(
                    self,
                    "Validation Failed",
                    f"Strategy validation failed:\n\n{result.message}"
                )
                self._update_status("Strategy validation failed")
        except Exception as e:
            QMessageBox.critical(self, "Error", f"Error validating strategy: {str(e)}")
    
    def _on_run_backtest(self):
        """Run backtest for the current strategy (singleton pattern)."""
        try:
            # Reuse existing window (closed but not destroyed) so the calibration
            # cache on BacktestConfigPanel survives close/reopen cycles.
            if self.backtest_window:
                self.backtest_window.show()
                self.backtest_window.raise_()
                self.backtest_window.activateWindow()
                return

            # Create and show backtest config dialog
            self.backtest_window = BacktestConfigDialog(self.orchestrator, self)
            
            # Clear reference when window is destroyed
            self.backtest_window.destroyed.connect(lambda: setattr(self, 'backtest_window', None))

            # ── Config retention: apply deferred saved config ─────────────────
            # BTCAAAAA-252: If a saved backtest config was stashed when a strategy
            # was opened, apply it now that the panel has been constructed.
            pending = getattr(self.orchestrator, '_pending_backtest_config', None)
            if pending and pending.get('lookback_days'):
                try:
                    self.backtest_window.backtest_panel.apply_config_from_dict(
                        pending, source='database'
                    )
                    logger.info("[ConfigRetention] Applied pending backtest config on panel open")
                except Exception as _e:
                    logger.warning(f"[ConfigRetention] Could not apply pending config: {_e}")
            # ── End config retention ──────────────────────────────────────────
            
            self.backtest_window.show()  # Non-modal so user can see strategy
            self._update_status("Backtest configuration opened")
        except Exception as e:
            QMessageBox.critical(self, "Error", f"Error opening backtest dialog: {str(e)}")
            self._update_status("Backtest configuration failed to open")

    # ──────────────────────────────────────────────────────────────────────────
    # Quick Preview (BTCAAAAA-749)
    # ──────────────────────────────────────────────────────────────────────────

    def _on_quick_preview(self):
        """Start a 30-day historical backtest in a background thread."""
        if self._preview_worker and self._preview_worker.isRunning():
            QMessageBox.information(
                self, "Preview Running",
                "A quick preview is already running. Please wait."
            )
            return

        config = self.orchestrator.get_current_config()
        if not config or not getattr(config, 'blocks', None):
            QMessageBox.warning(
                self, "No Strategy",
                "Add blocks to your strategy before running a preview."
            )
            return

        try:
            strategy_config = self.orchestrator.persistence._config_to_dict(config)
        except Exception as e:
            QMessageBox.critical(self, "Error", f"Could not read strategy config: {e}")
            return

        end_date = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        start_date = end_date - timedelta(days=30)
        backtest_config = {
            'lookback_days': 30,
            'mode': 1,
            'tpsl_mode': 'Fibonacci',
            'sl_mode': 'Static',
            'timeframe': '15m',
            'starting_capital': 10000,
            'risk_per_trade_pct': 2.0,
            'min_risk_reward': 1.5,
            'max_leverage': 10,
            'confluence_threshold': strategy_config.get('confluence_threshold', 40),
            'max_bars_held': 200,
            'use_multicore': False,
            'start_date': start_date,
            'end_date': end_date,
            'training_window': 20,
            'testing_window': 10,
            'training_end': start_date + timedelta(days=20),
            'testing_start': start_date + timedelta(days=20),
            'adaptive_sl': {
                'enabled': False,
                'delay_enabled': False,
                'delay_bars': 5,
                'emergency_sl_pct': 3.0,
                'volatility_lookback': 20,
                'volatility_multiplier': 1.2,
                'min_sl_pct': 0.5,
                'max_sl_pct': 2.0,
                'use_structure_sl': False,
                'structure_sources': ['swing_points', 'supply_demand', 'fibonacci'],
            },
        }

        strategy_config['confluence_threshold'] = strategy_config.get('confluence_threshold', 40)

        self._preview_trades = []
        self._preview_worker = BacktestWorker(strategy_config, backtest_config)
        self._preview_worker.trade_data_emit.connect(self._on_preview_trade_data)
        self._preview_worker.backtest_finished.connect(self._on_preview_finished)

        if self.preview_btn:
            self.preview_btn.setEnabled(False)
            self.preview_btn.setText("Running...")

        self._preview_worker.start()
        self._update_status("Quick Preview running — 30-day backtest in background...")

    def _on_preview_trade_data(self, trade: dict):
        """Collect closed trade records emitted by the preview worker."""
        if trade.get('status') == 'CLOSED':
            self._preview_trades.append(trade)

    def _on_preview_finished(self, success: bool, results: dict):
        """Show the results popup once the preview worker finishes."""
        if self.preview_btn:
            self.preview_btn.setEnabled(True)
            self.preview_btn.setText("Quick Preview")

        if not success:
            err = results.get('error', 'Unknown error')
            QMessageBox.critical(
                self, "Quick Preview Failed",
                f"Preview failed:\n{err}"
            )
            self._update_status("Quick Preview failed")
            return

        total_trades = results.get('trades', 0)
        closed = self._preview_trades

        win_rate = 0.0
        avg_return = 0.0
        if closed:
            winners = sum(1 for t in closed if t.get('pnl', 0) > 0)
            win_rate = (winners / len(closed)) * 100
            avg_return = sum(t.get('pnl_pct', 0) for t in closed) / len(closed)

        dialog = QuickPreviewResultsDialog(
            win_rate=win_rate,
            total_signals=total_trades,
            total_trades=total_trades,
            avg_return=avg_return,
            parent=self,
        )
        dialog.exec_()
        self._update_status("Quick Preview complete")

    def _on_step_clicked(self, step: int):
        """
        Handle stepper ribbon step click with workflow enforcement.
        
        Step 0: Design - Always active
        Step 1: Validate - Requires strategy name + blocks
        Step 2: Generate - Requires successful validation
        Step 3: Test - Requires code generated
        Step 4: Publish - Requires test completed
        """
        if step == 0:
            # Design step - just highlight it
            self.stepper.set_current_step(0)
            self._update_status("Design your strategy by adding blocks")
        
        elif step == 1:
            # Validate step - CHECK PREREQUISITES
            if not self._check_validation_prerequisites():
                return

            self.stepper.set_current_step(1)

            # Singleton pattern: reuse existing ValidationReportWindow
            if self.validation_window and self.validation_window.isVisible():
                self.validation_window.raise_()
                self.validation_window.activateWindow()
                return

            # Run institutional validation before opening window
            try:
                config = self.orchestrator.get_current_config()
                validator = InstitutionalValidator()
                report = validator.validate(config)
            except Exception as e:
                QMessageBox.critical(self, "Validation Error", f"Error validating strategy:\n\n{str(e)}")
                self._update_status("Strategy validation failed")
                return

            # Track report for stepper update when window closes
            self._last_validation_report = report

            def _on_validation_fix_applied_from_window(fix_type: str, fix_data: dict):
                """Update cached report and delegate to existing fix handler."""
                if self.validation_window:
                    self._last_validation_report = self.validation_window.report
                self._on_validation_fix_applied(fix_type, fix_data)

            def _on_validation_window_destroyed():
                """Update stepper based on final report when window closes."""
                if self._last_validation_report and self._last_validation_report.is_valid:
                    self.validation_passed = True
                    self.orchestrator.config_engine.config.validation_status = 'passed'
                    self.stepper.mark_step_complete(1)
                    self._update_status('Strategy validated successfully')
                    self._save_validation_status_to_db('Pass')
                else:
                    self.validation_passed = False
                    if hasattr(self.orchestrator.config_engine.config, 'validation_status'):
                        delattr(self.orchestrator.config_engine.config, 'validation_status')
                    self.stepper.mark_step_error(1)
                    self._update_status('Strategy validation failed')
                    self._save_validation_status_to_db('Fail')
                self.validation_window = None

            window = ValidationReportWindow(report, config, self)
            self.validation_window = window
            window.destroyed.connect(_on_validation_window_destroyed)
            window.fix_applied.connect(_on_validation_fix_applied_from_window)
            window.generate_code_requested.connect(self._on_generate_code_from_report)
            window.show()
        elif step == 2:
            # Test / Optimize step - CHECK PREREQUISITES  
            if not self._check_test_prerequisites():
                return  # Prerequisites not met, error shown
            
            self.stepper.set_current_step(2)
            self._on_run_backtest()
            # Mark complete when backtest dialog opens successfully
            self.test_completed = True
        
        elif step == 3:
            # Publish step - CHECK PREREQUISITES
            if not self._check_publish_prerequisites():
                return  # Prerequisites not met, error shown
            
            self.stepper.set_current_step(3)
            QMessageBox.information(
                self,
                "Publish Status",
                "Publish status management coming soon!\n\n"
                "Options: Draft, Unpublished, Published"
            )
            self._update_status("Publish status management coming soon")
    
    def _on_import_from_json(self):
        """Import strategy from JSON file and load into builder."""
        try:
            # Get last directory
            settings = QSettings("BTC_Engine", "StrategyBuilder")
            last_dir = settings.value("lastDirectory", "")
            
            # Show file dialog
            filename, _ = QFileDialog.getOpenFileName(
                self,
                "Import Strategy from JSON",
                last_dir,
                "Strategy Files (*.json);;All Files (*)"
            )
            
            if not filename:
                return  # User cancelled
            
            # Load strategy from JSON file
            result = self.orchestrator.load_strategy(filename)
            
            if not result.success:
                QMessageBox.warning(
                    self,
                    "Import Failed",
                    f"Failed to import strategy from JSON:\n\n{result.message}"
                )
                return
            
            # Update UI from loaded config
            config = self.orchestrator.get_current_config()
            
            # Set strategy name
            if config.name:
                self.info_panel.set_strategy_name(config.name)
            
            # Set description if available
            if hasattr(config, 'description') and config.description:
                self.info_panel.set_description(config.description)
            
            # Clear tracking (new strategy for database)
            self.current_strategy_id = None
            self.current_version_id = None
            self.current_file = None
            
            # Mark as modified so user can save to database
            self.is_modified = True
            
            # Refresh all panels
            self.search_panel.clear_added_blocks()
            self.blocks_panel.refresh_from_orchestrator()
            self.info_panel.refresh_from_orchestrator()
            
            # Update UI
            self._update_window_title()
            
            # Show success with save reminder
            QMessageBox.information(
                self,
                "Import Successful",
                f"Strategy imported from JSON file!\n\n"
                f"File: {filename}\n\n"
                f"The strategy has been loaded into the builder.\n"
                f"Press Ctrl+S or click Save to save it to the database."
            )
            
            self._update_status(f"Imported strategy from JSON - Ready to save to database")
            
        except Exception as e:
            QMessageBox.critical(
                self,
                "Import Error",
                f"Error importing strategy from JSON:\n\n{str(e)}"
            )
            import traceback
            traceback.print_exc()
    
    def _on_update_data(self):
        """
        Open the data update modal (manual mode - no auto-close).
        
        Called from Tools menu - user-initiated action.
        """
        try:
            # Manual mode: no auto-update, no auto-close
            modal = DataUpdateModal(self, auto_mode=False)
            modal.exec_()  # Show modal (blocks until closed)
            self._update_status("Data update check complete")
        except Exception as e:
            QMessageBox.critical(self, "Error", f"Error opening data update dialog: {str(e)}")
            self._update_status("Data update check failed")

    def _on_verify_data(self):
        """
        Open the Data Verify dialog (read-only integrity check).

        Called from Tools → Verify Data...
        Runs verify_and_repair(dry_run=True) in a background thread and
        displays a per-timeframe gap report.  Does not modify any stored data.
        """
        try:
            dialog = DataVerifyDialog(self)
            dialog.exec_()
            self._update_status("Data verification complete")
        except Exception as e:
            QMessageBox.critical(self, "Error", f"Error opening data verify dialog: {str(e)}")
            self._update_status("Data verification failed")

    def _on_settings(self):
        """Open the Settings dialog (Tools → Settings...)."""
        try:
            dialog = SettingsDialog(self)
            dialog.exec_()
            self._update_status("Settings closed")
        except Exception as e:
            QMessageBox.critical(self, "Error", f"Error opening Settings dialog:\n\n{str(e)}")
            self._update_status("Failed to open Settings dialog")

    def _on_about(self):
        """Show about dialog — free-floating, wider than default, content-fitted height."""
        dialog = QDialog()  # No parent: free-floating, not locked to main window position
        dialog.setWindowTitle("About BTC Trade Engine")
        dialog.resize(620, 380)
        dialog.setStyleSheet(get_main_stylesheet() + get_dialog_stylesheet())

        layout = QVBoxLayout(dialog)
        layout.setContentsMargins(24, 20, 24, 16)
        layout.setSpacing(8)

        content = QTextBrowser()
        content.setOpenExternalLinks(False)
        content.setReadOnly(True)
        content.setFont(create_font(10))
        content.setHtml(
            "<h2>BTC Trade Engine</h2>"
            "<p><b>Strategy Builder</b> &mdash; Version 1.0</p>"
            "<hr>"
            "<p>An institutional-grade automated Bitcoin trading platform built on top of "
            "<b>NautilusTrader</b>, the world's leading open-source algorithmic trading framework.</p>"
            "<p>Design, configure, and walk-forward test precise multi-signal BTC strategies "
            "using a composable block-based architecture. Run validated strategies on autopilot "
            "with full position, risk, and order lifecycle management.</p>"
            "<p><b>Key capabilities:</b></p>"
            "<ul>"
            "<li>Visual strategy builder with building-block signals</li>"
            "<li>Walk-forward backtesting with multi-window analysis</li>"
            "<li>Institutional validation with auto-fix suggestions</li>"
            "<li>Live data synchronisation from Binance (15-min bars)</li>"
            "<li>NautilusTrader execution engine integration</li>"
            "</ul>"
            "<hr>"
            "<p><small>&copy; 2026 BTC Trade Engine. "
            "Powered by NautilusTrader. Built for professional trade engineers.</small></p>"
        )
        layout.addWidget(content)

        close_btn = QPushButton("Close")
        close_btn.setFont(create_font(10))
        close_btn.setStyleSheet(get_primary_button_stylesheet())
        close_btn.setFixedWidth(100)
        close_btn.clicked.connect(dialog.accept)

        btn_row = QHBoxLayout()
        btn_row.addStretch()
        btn_row.addWidget(close_btn)
        layout.addLayout(btn_row)

        dialog.exec_()
    
    def _update_window_title(self):
        """Update the window title with strategy name and modified status."""
        title = "BTC Trade Engine - Strategy Builder"

        # Show strategy name only (from orchestrator config)
        strategy_name = None
        if self.orchestrator and self.orchestrator.config_engine.config.name:
            strategy_name = self.orchestrator.config_engine.config.name
        elif self.info_panel:
            strategy_name = self.info_panel.get_strategy_name()
        
        if strategy_name and strategy_name != "New_Strategy":
            title += f" - {strategy_name}"
        elif strategy_name == "New_Strategy":
            title += " - Untitled"

        if self.is_modified:
            title += " *"
        
        self.setWindowTitle(title)
    
    def _update_status(self, message: str):
        """Update the status bar message."""
        self.statusBar().showMessage(message)
    
    def _restore_settings(self):
        """Restore non-geometry settings (splitter sizes).

        Geometry and maximized state are restored in showEvent via
        WindowGeometryMixin to avoid the Qt5 window-state desync bug.
        """
        settings = QSettings("BTC_Engine", "StrategyBuilder")
        splitter_sizes = settings.value("mainSplitterSizes")
        if splitter_sizes:
            self.main_splitter.restoreState(splitter_sizes)
    
    def _check_strategy_type_match(self) -> bool:
        """
        Check if strategy type matches signal direction.
        
        Returns:
            True if user wants to proceed with save, False if cancelled
        """
        try:
            config = self.orchestrator.get_current_config()
            if not config or not config.blocks:
                return True  # No blocks, nothing to check
            
            # Count bullish vs bearish signals (comprehensive keyword detection)
            bullish_count = 0
            bearish_count = 0
            
            # Define directional keywords
            bullish_keywords = [
                'BULLISH', 'LONG', 'BUY', 'ABOVE', 'OVER', 'UP', 'HIGHER',
                'BREAKOUT', 'SUPPORT', 'BOUNCE', 'REVERSAL_UP', 'UPTREND',
                'ACCUMULATION', 'REACCUMULATION', 'SPRING', 'SOS', 'LPS'
            ]
            
            bearish_keywords = [
                'BEARISH', 'SHORT', 'SELL', 'BELOW', 'UNDER', 'DOWN', 'LOWER',
                'BREAKDOWN', 'RESISTANCE', 'REJECTION', 'REVERSAL_DOWN', 'DOWNTREND',
                'DISTRIBUTION', 'REDISTRIBUTION', 'UPTHRUST', 'SOW', 'LPSY'
            ]
            
            for block in config.blocks:
                for signal in block.signals:
                    signal_name_upper = signal.name.upper()
                    
                    # Check for bullish keywords
                    is_bullish = any(keyword in signal_name_upper for keyword in bullish_keywords)
                    # Check for bearish keywords
                    is_bearish = any(keyword in signal_name_upper for keyword in bearish_keywords)
                    
                    if is_bullish:
                        bullish_count += 1
                    if is_bearish:
                        bearish_count += 1
                    
                    # Note: A signal can have both (e.g., "BULLISH_REJECTION") - count both
            
            # Get current strategy type from UI
            current_type = self.info_panel.get_strategy_type()
            
            # Check for mismatch
            mismatch = False
            suggested_type = None
            
            if current_type == "Bullish" and bearish_count > bullish_count:
                mismatch = True
                suggested_type = "Bearish"
            elif current_type == "Bearish" and bullish_count > bearish_count:
                mismatch = True
                suggested_type = "Bullish"
            
            if not mismatch:
                return True  # All good, proceed with save
            
            # Show warning dialog with fix option
            msg = QMessageBox(self)
            msg.setIcon(QMessageBox.Warning)
            msg.setWindowTitle("Strategy Type Mismatch")
            msg.setText(
                f"<b>Strategy Type Mismatch Detected</b><br><br>"
                f"Current Strategy Type: <b>{current_type}</b><br>"
                f"Signal Direction: <b>{suggested_type}</b> "
                f"({bullish_count} bullish, {bearish_count} bearish)<br><br>"
                f"Your strategy contains mostly {suggested_type.lower()} signals, "
                f"but is configured as {current_type}."
            )
            msg.setInformativeText("Would you like to change the strategy type before saving?")
            
            # Add custom buttons
            change_btn = msg.addButton(f"Change to {suggested_type}", QMessageBox.AcceptRole)
            proceed_btn = msg.addButton("Save Anyway", QMessageBox.DestructiveRole)
            cancel_btn = msg.addButton("Cancel", QMessageBox.RejectRole)
            
            msg.setDefaultButton(change_btn)
            msg.exec_()
            
            clicked = msg.clickedButton()
            
            if clicked == change_btn:
                # User wants to change strategy type
                # Update BOTH UI and config immediately to ensure sync
                self.info_panel.set_strategy_type(suggested_type)
                
                # CRITICAL: Force Qt to process the radio button change NOW
                QApplication.processEvents()
                QApplication.processEvents()  # Process twice to ensure state propagates
                
                # Verify the UI actually changed
                actual_type = self.info_panel.get_strategy_type()
                if actual_type != suggested_type:
                    logger.warning(f"WARNING: UI didn't update! Expected {suggested_type}, got {actual_type}")
                
                # Also update config directly right now (don't wait for later)
                if hasattr(self.orchestrator.config_engine.config, 'strategy_type'):
                    self.orchestrator.config_engine.config.strategy_type = suggested_type
                else:
                    setattr(self.orchestrator.config_engine.config, 'strategy_type', suggested_type)
                
                self._update_status(f"Strategy type changed to {suggested_type}")
                return True  # Proceed with save
            elif clicked == proceed_btn:
                # User wants to save anyway
                return True  # Proceed with save
            else:
                # User cancelled
                return False  # Don't save
            
        except Exception as e:
            # Don't block save on error, just log and proceed
            logger.error(f"Error checking strategy type match: {e}")
            return True
    
    def _on_app_start(self):
        """
        RC2 FIX: Single sequenced startup entry point.

        Runs the data-update modal first (exec_() blocks until the modal closes),
        then starts the auto-update system.  This eliminates the startup race
        condition where the auto-update thread was starting 500ms before the modal
        finished writing parquet files (BTCAAAAA-143).
        """
        self._show_data_update_modal()   # exec_() blocks until modal is closed
        self._start_auto_update_system() # only starts after modal fully completes

    def _show_data_update_modal(self):
        """
        Show the data update modal on startup (auto mode - auto-close).
        
        Called automatically on startup - auto-updates and auto-closes.
        """
        try:
            # Auto mode (default): auto-update gaps, auto-close after countdown
            modal = DataUpdateModal(self, auto_mode=True)
            modal.exec_()  # Show modal (blocks until closed)
        except Exception as e:
            # Don't block app startup if modal fails
            logger.error(f"Warning: Data update modal failed: {e}")
            self._update_status("Data update check skipped (error occurred)")
    
    def _start_auto_update_system(self):
        """
        Start automatic data update system.

        Updates every 15 minutes:
        - Checks 0.2s after candle close
        - Retries every 2s until data is fresh
        """
        try:
            # Calculate time until next candle close (15-min candles)
            now = datetime.now(timezone.utc)

            # RC4 FIX: Record session start time the first time the auto-update
            # system initialises.  This is the lower bound for verify_and_repair
            # so gaps that predate the 2h rolling window are never hidden.
            if self._session_start_time is None:
                self._session_start_time = now
                logger.info(f"[AutoUpdate] session_start_time set to {now.strftime('%Y-%m-%d %H:%M:%S')}")

            # Next 15-min boundary
            minutes_to_next = 15 - (now.minute % 15)
            seconds_to_next = (minutes_to_next * 60) - now.second

            # BUG 4 FIX: clamp near-exact-boundary edge case (max valid wait is 900s).
            # When called at exactly minute=0/15/30/45, second=0 the formula yields 900s
            # which is correct. Guard against any arithmetic producing > 900s.
            if seconds_to_next > 900:
                seconds_to_next = 1

            # Add 2s delay after candle close so Binance has time to finalize
            # the bar before the fetch arrives. 200ms was consumed by cycle
            # overhead, causing the first fetch to hit Binance at the exact
            # boundary and return no data — triggering a 12s retry every cycle.
            ms_until_check = (seconds_to_next * 1000) + 2000

            # Schedule first check and store handle so it can be inspected / cancelled
            self.candle_check_timer = QTimer(self)
            self.candle_check_timer.setSingleShot(True)
            self.candle_check_timer.timeout.connect(self._check_and_update_data)
            self.candle_check_timer.start(ms_until_check)

            self._update_status(f"Auto-update system started - Next check in {seconds_to_next}s")
            self.retry_count = 0  # reset on successful startup

        except Exception as e:
            logger.error(f"Error starting auto-update system: {e}")
            # Exponential backoff: 2, 4, 8, 16, 30, 30, ... seconds (capped at 30s)
            delay_s = min(2 * (2 ** self.retry_count), 30)
            self.retry_count += 1
            logger.info(f"Retrying auto-update startup in {delay_s}s (attempt {self.retry_count})...")
            QTimer.singleShot(delay_s * 1000, self._start_auto_update_system)
    
    def _check_and_update_data(self):
        """
        Check if data needs updating and trigger a background update if so.

        Called 0.2s after each 15-min candle close.  All blocking I/O runs in
        _RuntimeCandleUpdateThread to avoid stalling the Qt event loop.

        Covers BOTH 15m AND 1h timeframes — the previous implementation only
        updated 15m data, leaving 1h candles perpetually stale at runtime.
        """
        try:
            self._update_status("Checking for data updates...")

            # --- Guard: skip if a previous update cycle is still running ---
            if self._runtime_update_thread is not None and self._runtime_update_thread.isRunning():
                logger.info("Runtime update thread still running — skipping this cycle trigger.")
                self._schedule_next_check()
                return

            # --- Kick off the background update for all managed timeframes ---
            self._update_status("Updating candle data (15m + 1h) in background...")
            thread = _RuntimeCandleUpdateThread(self, session_start_time=self._session_start_time)
            thread.finished.connect(self._on_runtime_update_finished)
            self._runtime_update_thread = thread
            thread.start()

            # Schedule the next check immediately (the thread runs independently).
            # The _on_runtime_update_finished slot updates the status bar when done.
            self._schedule_next_check()

        except Exception as e:
            logger.error(f"Error launching runtime update thread: {e}")
            import traceback
            traceback.print_exc()
            self._update_status(f"Data update error: {str(e)}")
            # Quick-retry path: fire once within 12s before surrendering to boundary.
            # Guard against cascading storms — only one quick retry per cycle failure.
            if not self._in_quick_retry:
                self._in_quick_retry = True
                logger.error("Cycle exception — scheduling quick retry in 12s...")
                QTimer.singleShot(12 * 1000, self._check_and_update_data)
            else:
                # Second failure in quick-retry cycle — fall back to boundary schedule
                self._in_quick_retry = False
                self._schedule_next_check()

    def _on_runtime_update_finished(self, success: bool, message: str) -> None:
        """
        Slot called when _RuntimeCandleUpdateThread finishes.

        Updates the status bar and resets state.  Schedules a quick retry on
        failure (honouring the same single-retry guard as before).
        """
        logger.info(f"[RuntimeUpdate] {'OK' if success else 'FAIL'}: {message}")
        if success:
            self.last_update_time = datetime.now(timezone.utc)
            self._in_quick_retry = False
            self._update_status(
                f"[RuntimeUpdate] OK: {message[:120]}"
            )
        else:
            self._update_status(f"[RuntimeUpdate] FAIL: {message[:120]}")
            if not self._in_quick_retry:
                self._in_quick_retry = True
                logger.error("Update failed — scheduling quick retry in 12s...")
                QTimer.singleShot(12 * 1000, self._check_and_update_data)
            else:
                self._in_quick_retry = False


    def _schedule_next_check(self):
        """Schedule the next data check at 0.2s after next candle close."""
        _FALLBACK_MS = 5 * 60 * 1000  # 5-minute fallback if boundary calc fails
        MAX_WAIT_MS = 5 * 60 * 1000   # 5-minute hard cap — prevents 38+ min gaps
        try:
            # Calculate time until next 15-min candle close
            now = datetime.now(timezone.utc)
            minutes_to_next = 15 - (now.minute % 15)
            seconds_to_next = (minutes_to_next * 60) - now.second

            # BUG 4 FIX: clamp to avoid spurious >900s waits at exact boundaries
            if seconds_to_next > 900:
                seconds_to_next = 1

            # Add 2s delay after candle close (matches _start_auto_update_system).
            ms_until_check = (seconds_to_next * 1000) + 2000

            # Cap to MAX_WAIT_MS so skipped cycles (thread still running) never
            # push the next attempt more than 5 min into the future.
            ms_until_check = min(ms_until_check, MAX_WAIT_MS)

            # Schedule check and store handle for inspection / cancellation
            self.candle_check_timer = QTimer(self)
            self.candle_check_timer.setSingleShot(True)
            self.candle_check_timer.timeout.connect(self._check_and_update_data)
            self.candle_check_timer.start(ms_until_check)

            # Save next check time for countdown
            self.next_check_time = now + timedelta(milliseconds=ms_until_check)

            logger.info(f"[RuntimeSchedule] Next check in {ms_until_check/1000:.1f}s (at {self.next_check_time.strftime('%H:%M:%S')})")

        except Exception as e:
            # BUG 1 FIX: always reschedule even when boundary calculation throws.
            # Previously the chain died permanently on any exception here.
            logger.error(f"Error scheduling next check: {e} — falling back to {_FALLBACK_MS // 1000}s fixed delay")
            try:
                self.candle_check_timer = QTimer(self)
                self.candle_check_timer.setSingleShot(True)
                self.candle_check_timer.timeout.connect(self._check_and_update_data)
                self.candle_check_timer.start(_FALLBACK_MS)
                self.next_check_time = datetime.now(timezone.utc) + timedelta(milliseconds=_FALLBACK_MS)
                logger.info(f"[RuntimeSchedule] Fallback: Next check in {_FALLBACK_MS/1000:.1f}s (at {self.next_check_time.strftime('%H:%M:%S')})")
            except Exception as inner_e:
                # Last resort: bare singleShot — cannot die here
                logger.error(f"Fallback schedule also failed: {inner_e} — using QTimer.singleShot")
                QTimer.singleShot(_FALLBACK_MS, self._check_and_update_data)
    
    def _update_countdown_status(self):
        """Update status bar with live countdown to next data check."""
        try:
            # Only show countdown when nothing else is being displayed
            current_status = self.statusBar().currentMessage()
            
            # Check if we should show countdown (not during active operations)
            if current_status and any(keyword in current_status for keyword in [
                'Added block', 'Strategy updated', 'Saved', 'Loaded', 'Checking',
                'Updating', 'Validat', 'Generated', 'cleared', 'created',
                'Data updated', 'Update failed', 'Auto-update', '[RuntimeUpdate]'
            ]):
                # Don't override active status messages
                return
            
            # Show countdown if next check is scheduled
            if self.next_check_time:
                now = datetime.now(timezone.utc)
                seconds_until = (self.next_check_time - now).total_seconds()
                
                if seconds_until > 0:
                    minutes = int(seconds_until // 60)
                    seconds = int(seconds_until % 60)
                    
                    if minutes > 0:
                        self._update_status(f"Next data check in {minutes}m {seconds}s")
                    else:
                        self._update_status(f"Next data check in {seconds}s")
                else:
                    self._update_status("Checking for data updates...")
            else:
                # No check scheduled yet
                self._update_status("Ready")
                
        except Exception as e:
            # Silently fail to avoid disrupting UI
            pass
    
    def _save_validation_status_to_db(self, status: str):
        """
        Persist validation status to database (Sprint 1.9 ORM persistence).
        
        Updates the strategy_versions table with validation_status and validation_timestamp.
        
        Args:
            status: 'Pass' or 'Fail'
        """
        if not self.current_version_id:
            return  # No version to update yet (strategy not saved)
        
        try:
            from datetime import datetime, timezone
            from src.optimizer_v3.database.models import StrategyVersion
            
            db = get_database_manager()
            
            # Get the strategy version using ORM
            version = db.strategy.session.query(StrategyVersion).filter(
                StrategyVersion.version_id == self.current_version_id
            ).first()
            
            if version:
                # Update using ORM
                version.validation_status = status
                version.validation_timestamp = datetime.now(timezone.utc)
                db.strategy.session.commit()
            
        except Exception as e:
            # Rollback on error
            try:
                db.strategy.session.rollback()
            except:
                pass
            # Don't fail the UI if database save fails - log silently
            import traceback
            traceback.print_exc()
    
    def _on_validation_fix_applied(self, fix_type: str, fix_data: dict):
        """
        Handle auto-fix applied from validation window.
        
        Automatically saves updated config to database AND reloads it
        so main window displays the exact saved version.
        
        CRITICAL: Also saves validation status as 'Pass' since fix was successful.
        
        Args:
            fix_type: Type of fix applied (rule_id)
            fix_data: Dict with fix details
        """
        logger.info(f"\n{'='*80}")
        logger.info(f"AUTO-FIX APPLIED: {fix_type}")
        logger.info(f"Saving updated configuration to database...")
        logger.info(f"{'='*80}\n")
        
        # CRITICAL FIX (BTCAAAAA-135): Sync the full fixed config from validation_window
        # into the orchestrator for ALL fix types, not just DIRECTION_001.
        # Without this, _on_save_strategy() reads orchestrator's stale config and saves
        # the unfixed version (root cause of EXIT_009, LOGIC_003, TIMING_004 not persisting).
        if self.validation_window and self.orchestrator and self.orchestrator.config_engine:
            fixed_config = self.validation_window.config
            self.orchestrator.config_engine.config = fixed_config
            # Also sync strategy_type to info_panel so UI reflects the change
            fixed_type = getattr(fixed_config, 'strategy_type', None)
            if fixed_type:
                self.info_panel.set_strategy_type(fixed_type)
        
        # CRITICAL FIX (BTCAAAAA-125): Mark as modified so _on_save_strategy() does
        # not short-circuit via the "No Changes" early-return path at line 797.
        self.is_modified = True
        
        # Save to database (creates new version with updated config)
        success = self._on_save_strategy()
        
        if success:
            logger.info(f"✅ Configuration saved to database successfully")
            
            # CRITICAL: Save validation status as 'Pass' (fix was applied successfully)
            # This must happen BEFORE reload so reload sees the Pass status
            logger.info(f"💾 Saving validation status = 'Pass' to database...")
            self._save_validation_status_to_db('Pass')
            logger.info(f"✅ Validation status saved")
            
            # CRITICAL: Reload the saved version from database
            # This ensures main window shows exact config that was saved
            if self.current_version_id:
                logger.info(f"🔄 Reloading version {self.current_version_id} from database...")
                self._reload_current_version()

            # BTCAAAAA-133: Push freshly-reloaded config to the validation window so
            # _rerun_validation() does not operate on the now-stale original reference.
            # _reload_current_version() replaces orchestrator.config_engine.config with
            # a new object; ValidationReportWindow still holds the old reference unless
            # we update it here.  This call is safe when validation_window is None.
            if self.validation_window and self.orchestrator and self.orchestrator.config_engine and self.orchestrator.config_engine.config:
                logger.info(f"🔄 Pushing reloaded config to ValidationReportWindow (BTCAAAAA-133)")
                self.validation_window.update_config(self.orchestrator.config_engine.config)
                logger.info(f"✅ ValidationReportWindow config reference updated")

            self._update_status(f"Auto-fix applied, saved, and reloaded: {fix_data.get('issue', fix_type)}")
        else:
            logger.error(f"❌ Failed to save configuration to database")
            self._update_status(f"Auto-fix applied but save failed")
    
    def _on_generate_code_from_report(self) -> None:
        """Handle Generate Code request from ValidationReportWindow."""
        try:
            result = self.orchestrator.generate_code()
            if result.success:
                QMessageBox.information(
                    self,
                    "Code Generated",
                    f"Strategy code written to:\n{result.message}",
                )
                self._update_status("Strategy code generated")
            else:
                QMessageBox.critical(
                    self,
                    "Code Generation Failed",
                    "Failed to generate strategy code:\n\n" + "\n".join(result.errors),
                )
        except Exception as e:
            QMessageBox.critical(
                self,
                "Code Generation Error",
                f"Error generating code:\n\n{str(e)}"
            )
    
    def _reload_current_version(self):
        """
        Reload current strategy version from database.
        
        Called after auto-fix to ensure main window displays
        the exact configuration that was saved.
        
        CRITICAL: Also restores validation status so stepper shows correct state.
        """
        if not self.current_version_id:
            return
        
        try:
            # Load from database
            db = get_database_manager()
            version = db.strategy.get_strategy_version(self.current_version_id)
            
            if not version:
                logger.error(f"❌ Version {self.current_version_id} not found")
                return
            
            # Extract blocks and exit conditions
            blocks_data = version.get('blocks', [])
            exit_conditions_data = version.get('exit_conditions', [])
            
            # Build config dict
            config_dict = {
                'name': version['name'],
                'description': version.get('description', ''),
                'strategy_type': version.get('strategy_type', 'Bullish'),  # Fix: include strategy_type (was missing, causing auto-fix persistence loss)
                'blocks': blocks_data,
                'exit_conditions': exit_conditions_data
            }
            
            # SUPPRESS validation reset during reload
            self.loading_strategy = True
            
            try:
                # Restore config using persistence
                restored_config = self.orchestrator.persistence._dict_to_config(config_dict)
                
                # Update orchestrator
                self.orchestrator.config_engine.config = restored_config
                
                logger.info(f"✅ Reloaded {len(restored_config.blocks)} blocks from database")
                
                # Refresh all UI panels
                self.blocks_panel.refresh_from_orchestrator()
                self.info_panel.refresh_from_orchestrator()
                self.search_panel.sync_with_strategy()
                
                logger.info(f"✅ UI refreshed with reloaded data")
                
                # CRITICAL: Restore validation status from database
                # This updates BOTH the flag AND the stepper to show correct validation state
                validation_status = version.get('validation_status', 'Un-Validated')
                
                logger.info(f"\n{'='*80}")
                logger.info(f"RESTORING VALIDATION STATUS FROM DATABASE")
                logger.info(f"{'='*80}")
                logger.info(f"Database status = '{validation_status}'")
                
                if validation_status == 'Pass':
                    # Set flag FIRST
                    self.validation_passed = True
                    logger.info(f"✅ Set validation_passed = True")
                    
                    # Clear ALL step states first
                    self.stepper.completed_steps.clear()
                    self.stepper.error_steps.clear()
                    
                    # Now mark step 1 as complete (GREEN with checkmark)
                    self.stepper.mark_step_complete(1)
                    logger.info(f"✅ Stepper step 1 marked COMPLETE (should be GREEN)")
                    logger.info(f"   completed_steps = {self.stepper.completed_steps}")
                    logger.info(f"   error_steps = {self.stepper.error_steps}")
                    
                elif validation_status == 'Fail':
                    # Set flag FIRST
                    self.validation_passed = False
                    logger.warning(f"⚠️ Set validation_passed = False")
                    
                    # Clear ALL step states first
                    self.stepper.completed_steps.clear()
                    self.stepper.error_steps.clear()
                    
                    # Mark step 1 as error (RED with X)
                    self.stepper.mark_step_error(1)
                    logger.error(f"❌ Stepper step 1 marked ERROR (should be RED)")
                    
                else:  # Un-Validated
                    # Set flag FIRST
                    self.validation_passed = False
                    logger.info(f"ℹ️ Set validation_passed = False (un-validated)")
                    
                    # Clear ALL step states - no mark needed (grey default)
                    self.stepper.completed_steps.clear()
                    self.stepper.error_steps.clear()
                    self.stepper._update_display()
                    logger.info(f"   Stepper reset to default (should be GREY)")
                
                logger.info(f"{'='*80}\n")
                
            finally:
                # Re-enable validation reset
                self.loading_strategy = False
            
        except Exception as e:
            logger.error(f"❌ Error reloading version: {e}")
            import traceback
            traceback.print_exc()
    
    def _check_validation_prerequisites(self) -> bool:
        """Check if validation prerequisites are met (strategy name + blocks)."""
        strategy_name = self.info_panel.get_strategy_name()
        block_count = self.blocks_panel.get_block_count()
        
        errors = []
        if not strategy_name or strategy_name.strip() == "":
            errors.append("• Strategy must have a name")
        if block_count == 0:
            errors.append("• Strategy must have at least one building block")
        
        if errors:
            show_warning(
                self,
                "Cannot Validate Strategy",
                "Validation Prerequisites Not Met",
                "Please complete the following before validating:\n\n" +
                "\n".join(errors)
            )
            return False
        return True
    
    def _check_generation_prerequisites(self) -> bool:
        """Check if code generation prerequisites are met (valid strategy)."""
        if not self.validation_passed:
            show_warning(
                self,
                "Cannot Generate Code",
                "Validation Required",
                "You must successfully validate your strategy before generating code.\n\n"
                "Steps:\n"
                "1. Click the Validate step\n"
                "2. Fix any validation errors\n"
                "3. Return here to generate code"
            )
            return False
        return True
    
    def _check_test_prerequisites(self) -> bool:
        """Check if testing prerequisites are met (validated strategy)."""
        if not self.validation_passed:
            # Check if validation step is in error state (RED) - means validation FAILED
            # StepperRibbon uses error_steps set to track failed steps
            if 1 in self.stepper.error_steps:  # Index 1 is Validate step
                # Validation was run but FAILED
                show_warning(
                    self,
                    "Cannot Run Test / Optimize",
                    "Strategy Validation FAILED",
                    "Your strategy failed validation and cannot be tested until all errors are resolved.\n\n"
                    "Required Actions:\n"
                    "1. Click the Validate button\n"
                    "2. Review the validation report\n"
                    "3. Fix all blocking issues (marked in RED)\n"
                    "4. Click Validate again to re-check\n"
                    "5. Return here once validation passes"
                )
            else:
                # Validation hasn't been run yet
                show_warning(
                    self,
                    "Cannot Run Test / Optimize",
                    "Validation Required",
                    "You must validate your strategy before running tests.\n\n"
                    "Steps:\n"
                    "1. Click the Validate step\n"
                    "2. Fix any validation errors\n"
                    "3. Return here to run tests and optimize"
                )
            return False
        return True
    
    def _check_publish_prerequisites(self) -> bool:
        """Check if publish prerequisites are met (tests completed)."""
        if not self.test_completed:
            show_warning(
                self,
                "Cannot Publish Strategy",
                "Testing Required",
                "You must complete testing before publishing.\n\n"
                "Steps:\n"
                "1. Complete validation\n"
                "2. Click the Test / Optimize step to run backtests\n"
                "3. Review results\n"
                "4. Return here to publish"
            )
            return False
        return True
    
    def _on_toggle_console_debug(self, checked: bool):
        """Toggle debug output to console."""
        from src.debugger_logger.config_debugger import ConfigDebugger
        
        # Update global console logging state
        ConfigDebugger.CONSOLE_ENABLED = checked
        
        # Update menu text  
        self._update_console_menu_text(checked)
        
        # Save setting
        self._save_debug_settings()
        
        status = "enabled" if checked else "disabled"
        self._update_status(f"Console debugging {status}")
    
    def _on_toggle_logfile_debug(self, checked: bool):
        """Toggle debug output to log files."""
        from src.debugger_logger.config_debugger import ConfigDebugger
        
        # Update global file logging state
        ConfigDebugger.LOGFILE_ENABLED = checked
        
        # Update menu text
        self._update_logfile_menu_text(checked)
        
        # Save setting
        self._save_debug_settings()
        
        status = "enabled" if checked else "disabled"
        self._update_status(f"Log file debugging {status}")
    
    def _on_clear_old_logs(self):
        """Delete ALL log files."""
        import os
        from pathlib import Path
        
        # Use ABSOLUTE path to logs directory
        project_root = Path(__file__).resolve().parent.parent.parent.parent
        logs_dir = project_root / 'logs'
        
        # Ask for confirmation
        reply = ask_question(
            self,
            "Clear Old Logs",
            "Delete Old Log Files",
            f"This will delete ALL log files from:\n{logs_dir}\n\nAre you sure you want to continue?"
        )
        
        if reply != 'yes':
            return
        
        try:
            if not logs_dir.exists():
                QMessageBox.information(
                    self,
                    "No Logs Found",
                    f"No logs directory found at:\n{logs_dir}"
                )
                return
            
            # Count files
            deleted_count = 0
            total_size = 0
            
            # Recursively find and delete ALL log files
            for log_file in logs_dir.rglob('*.log'):
                try:
                    file_size = log_file.stat().st_size
                    log_file.unlink()
                    deleted_count += 1
                    total_size += file_size
                except Exception as e:
                    logger.error(f"Error deleting {log_file}: {e}")
            
            # Show result
            size_mb = total_size / (1024 * 1024)
            QMessageBox.information(
                self,
                "Logs Cleared",
                f"Successfully deleted {deleted_count} log files.\n\n"
                f"Space freed: {size_mb:.2f} MB"
            )
            self._update_status(f"Deleted {deleted_count} log files ({size_mb:.1f} MB)")
            
        except Exception as e:
            QMessageBox.critical(
                self,
                "Error",
                f"Error clearing logs:\n\n{str(e)}"
            )
    
    def _on_view_current_log(self):
        """Open the most recent log file in professional log viewer (singleton pattern)."""
        from pathlib import Path
        from src.strategy_builder.ui.log_viewer_window import LogViewerWindow
        
        try:
            # Check if log viewer window already exists and is visible
            if self.log_viewer_window and self.log_viewer_window.isVisible():
                # Focus existing window instead of creating new one
                self.log_viewer_window.raise_()
                self.log_viewer_window.activateWindow()
                return
            
            # Get logs directory
            logs_dir = Path('logs')
            if not logs_dir.exists():
                QMessageBox.information(
                    self,
                    "No Logs Found",
                    "No logs directory found."
                )
                return
            
            # Create and show log viewer window (background worker handles scanning + content loading)
            self.log_viewer_window = LogViewerWindow(parent=self)
            
            # Clear reference when window is destroyed
            self.log_viewer_window.destroyed.connect(lambda: setattr(self, 'log_viewer_window', None))
            
            self.log_viewer_window.show()
            
            self._update_status("Opened log viewer")
            
        except Exception as e:
            QMessageBox.critical(
                self,
                "Error",
                f"Error opening log viewer:\n\n{str(e)}"
            )
    
    def _restore_debug_settings(self):
        """Restore debug logger settings."""
        from src.debugger_logger.config_debugger import ConfigDebugger
        
        settings = QSettings("BTC_Engine", "StrategyBuilder")
        
        # Restore console debug setting (default: False - disabled)
        console_enabled = settings.value("debug/consoleEnabled", False, type=bool)
        ConfigDebugger.CONSOLE_ENABLED = console_enabled
        self.enable_console_action.setChecked(console_enabled)
        self._update_console_menu_text(console_enabled)
        
        # Restore logfile debug setting (default: False - disabled)
        logfile_enabled = settings.value("debug/logfileEnabled", False, type=bool)
        ConfigDebugger.LOGFILE_ENABLED = logfile_enabled
        self.enable_logfile_action.setChecked(logfile_enabled)
        self._update_logfile_menu_text(logfile_enabled)
    
    def _save_debug_settings(self):
        """Save debug logger settings."""
        from src.debugger_logger.config_debugger import ConfigDebugger
        settings = QSettings("BTC_Engine", "StrategyBuilder")
        settings.setValue("debug/consoleEnabled", ConfigDebugger.CONSOLE_ENABLED)
        settings.setValue("debug/logfileEnabled", ConfigDebugger.LOGFILE_ENABLED)
    
    def _update_console_menu_text(self, enabled: bool):
        """Update console debug menu text based on state."""
        if enabled:
            self.enable_console_action.setText("Disable Debugger in Console")
        else:
            self.enable_console_action.setText("Enable Debugger in Console")
    
    def _update_logfile_menu_text(self, enabled: bool):
        """Update logfile debug menu text based on state."""
        if enabled:
            self.enable_logfile_action.setText("Disable Debugger in Log File")
        else:
            self.enable_logfile_action.setText("Enable Debugger in Log File")
    
    def _save_settings(self):
        """Save window geometry, splitter sizes, and debug settings."""
        settings = QSettings("BTC_Engine", "StrategyBuilder")
        self._save_window_geometry()
        # Save splitter sizes (user's preferred panel ratio)
        settings.setValue("mainSplitterSizes", self.main_splitter.saveState())
        self._save_debug_settings()

    def showEvent(self, event):
        """Called when window is shown - apply hand cursors to all widgets"""
        super().showEvent(event)
        self._restore_window_geometry(event)
        # Apply hand cursor AFTER Qt finishes all stylesheet processing
        # Qt may reapply stylesheets after showEvent, so delay cursor setting
        QTimer.singleShot(200, lambda: apply_hand_cursor_to_buttons(self))
    
    def closeEvent(self, event):
        """Handle window close event."""
        # Check if current strategy should be saved (skip if empty)
        if self.is_modified and not self._is_strategy_empty():
            reply = ask_question(
                self,
                "Unsaved Changes",
                "Unsaved Changes",
                "You have unsaved changes. Do you want to save before exiting?"
            )
            
            if reply == 'yes':
                if self._on_save_strategy():
                    self._save_settings()
                    event.accept()
                else:
                    event.ignore()
            elif reply == 'no':
                self._save_settings()
                event.accept()
            else:
                event.ignore()
        else:
            self._save_settings()
            event.accept()
