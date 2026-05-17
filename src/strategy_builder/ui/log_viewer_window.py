"""
Institutional-Grade Log Viewer Window — Freeze Fix v2

Multi-tabbed log viewer with event-based filtering across all log types.
- Background content loading via QThreadPool (never block UI thread)
- Pre-classified lines for O(1) per-line event matching during filtering
- FreezeDetector watchdog captures stack traces if UI thread blocks >4s
- QPlainTextEdit + QSyntaxHighlighter for performant large-file rendering
- Lazy tab loading (content loaded on first activation)
- Capped line reads per file to prevent memory exhaustion

ZERO HARDCODED STYLES — All from styles.py
"""

from typing import Dict, List, Optional, Set, Tuple
from pathlib import Path
import re
import sys
import threading
import time
import traceback
from PyQt5.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QPlainTextEdit, QPushButton,
    QCheckBox, QLabel, QGroupBox, QApplication, QMessageBox,
    QTabWidget, QWidget, QGridLayout,
)
from PyQt5.QtCore import Qt, QSettings, QRunnable, QThreadPool, pyqtSignal, QTimer, QObject
from PyQt5.QtGui import QSyntaxHighlighter, QTextCharFormat, QColor

from src.strategy_builder.ui.styles import (
    get_groupbox_header_stylesheet,
    get_label_style,
    get_panel_title_stylesheet,
    get_primary_button_stylesheet,
    get_log_text_edit_stylesheet,
    get_event_filter_checkbox_style,
    get_color,
    create_font,
    create_monospace_font,
    WindowGeometryMixin,
)

import logging
logger = logging.getLogger(__name__)

MAX_LINES_PER_FILE = 5000
MAX_FILES_ALL_LOGS = 100

EVENT_PATTERNS: Dict[str, Tuple[str, str]] = {
    "TRADE_OPENED": (
        r"TRADE OPENED|trade.*opened|Opening trade|🟢.*TRADE",
        "success",
    ),
    "TRADE_CLOSED": (
        r"TRADE CLOSED|trade.*closed|Position closed|Closing trade|😘.*TRADE",
        "info",
    ),
    "TRADE_UPDATED": (r"TRADE UPDATED|trade.*updated|Update.*trade|🔄.*TRADE", "gold"),
    "POSITIONS_SNAPSHOT": (
        r"POSITIONS SNAPSHOT|OPEN POSITIONS|Position.*snapshot|📊",
        "purple",
    ),
    "TRADE_NOT_FOUND": (r"TRADE.*NOT FOUND|Trade.*not found|❌.*TRADE", "error"),
    "MULTIPLE_POSITIONS": (
        r"multiple.*position|Multiple.*open|Several.*position|🔀",
        "dark_orange",
    ),
    "CONFIG_INITIALIZED": (
        r"Logger initialized|BlockRegistryAdapter initialized|Institutional Logger initialized",
        "success",
    ),
    "CONFIG_READ": (r"Reading|Loading|load blocks|Calling.*search", "info"),
    "CONFIG_VALIDATED": (r"validated|validation.*pass|Config.*valid|Validation complete", "success"),
    "CONFIG_MISMATCH": (r"MISMATCH|mismatch|Config.*error|Invalid.*config", "error"),
    "CONFIG_MISSING": (r"not found|missing|Config.*missing|Cannot find", "dark_orange"),
    "STARTED": (r"Starting to load|Starting", "success"),
    "STOPPED": (r"Stopped|Stopping|Shutdown|Terminated|Ending", "text_muted"),
    "PROGRESS": (r"Processing|Working|Running|progress", "info"),
    "COMPLETED": (
        r"Successfully loaded|Successfully|Success|Finished",
        "success",
    ),
    "CRITICAL": (r"CRITICAL|FATAL", "error"),
    "ERROR": (r"ERROR", "dark_orange"),
    "WARNING": (r"WARNING", "gold"),
    "BLOCK_LOADED": (
        r"Successfully loaded \d+ blocks|loaded.*blocks|Processing first block",
        "purple",
    ),
    "BLOCK_ADDED": (r"Added.*block|Block.*added|Block.*config", "success"),
    "SEARCH_RESULTS": (r"Retrieved \d+ search results|Retrieved.*search", "info"),
    "DECISION": (r"decision|deciding|evaluate|Decision:", "gold"),
    "CONDITION_MET": (r"Condition.*met|Threshold.*met|Criteria.*met", "success"),
    "SIGNAL_DETECTED": (r"Signal.*detect|Pattern.*found|Signal.*found|Detected:", "success"),
}

_HEADER_SEP = "=" * 80

_COMPILED_PATTERNS: List[Tuple[str, re.Pattern, str]] = [
    (key, re.compile(pattern_str, re.IGNORECASE), color_key)
    for key, (pattern_str, color_key) in EVENT_PATTERNS.items()
]


_CONTEXT_PREFIXES = (
    "  ", "\t", "Location:", "Timestamp:", "Trade ID:",
    "Side:", "Size:", "Entry Price:", "Status:",
)


class LineClassification:
    """Pre-classified data for a single log line — zero regex at filter time."""

    __slots__ = ('text', 'matching_events')

    def __init__(self, text: str, matching_events: Set[str]):
        self.text = text
        self.matching_events = matching_events

    @property
    def is_context_line(self) -> bool:
        t = self.text
        return (
            t.startswith("  ")
            or t.startswith("\t")
            or t.startswith("Location:")
            or t.startswith("Timestamp:")
            or t.startswith("Trade ID:")
            or t.startswith("Side:")
            or t.startswith("Size:")
            or t.startswith("Entry Price:")
            or t.startswith("Status:")
        )


class ContentCache:
    """Holds pre-classified lines for fast event filtering.

    Filtering is O(n) with simple set intersection per line instead of
    O(n*m) regex matching.  _update_stats also avoids re-splitting.
    """

    def __init__(self, lines: List[LineClassification]):
        self.lines = lines
        self.total_count = len(lines)

    @staticmethod
    def build_from_text(text: str) -> 'ContentCache':
        classified: List[LineClassification] = []
        for line in text.split('\n'):
            matching: Set[str] = set()
            for event_key, pattern, _ in _COMPILED_PATTERNS:
                if pattern.search(line):
                    matching.add(event_key)
            classified.append(LineClassification(line, matching))
        return ContentCache(classified)

    def filter(self, enabled_events: Set[str]) -> Tuple[str, int]:
        """Build filtered text + event count using pre-classified data.

        Returns (filtered_text, event_count).
        """
        parts: List[str] = []
        event_count = 0
        in_context = False
        for cl in self.lines:
            if enabled_events and cl.matching_events.intersection(enabled_events):
                parts.append(cl.text)
                event_count += 1
                in_context = True
            elif in_context and (cl.is_context_line or not cl.text.strip()):
                parts.append(cl.text)
            else:
                in_context = False
        return '\n'.join(parts), event_count


class BackgroundContentSignals(QObject):
    """Signal carrier for BackgroundContentLoader."""

    loaded = pyqtSignal(int, object)
    error = pyqtSignal(int, str)


class BackgroundContentLoader(QRunnable):
    """Reads log files and builds a ContentCache in a background thread.

    Emits loaded(index, ContentCache) when done.
    """

    def __init__(self, tab_index: int, meta):
        super().__init__()
        self.tab_index = tab_index
        self.meta = meta
        self._cancelled = False
        self.signals = BackgroundContentSignals()

    def cancel(self):
        self._cancelled = True

    def run(self):
        try:
            cache = self._build_cache()
            if not self._cancelled:
                self.signals.loaded.emit(self.tab_index, cache)
        except Exception as e:
            if not self._cancelled:
                self.signals.error.emit(self.tab_index, str(e))

    def _build_cache(self) -> ContentCache:
        chunks: List[str] = []
        for f in self.meta.files:
            chunks.append(f"\n{_HEADER_SEP}\n")
            chunks.append(f"LOG FILE: {f.name}\n")
            chunks.append(f"{_HEADER_SEP}\n\n")
            try:
                line_count = 0
                with open(f, "r", encoding="utf-8", errors="replace") as fh:
                    for line in fh:
                        if line_count >= MAX_LINES_PER_FILE:
                            chunks.append(
                                f"... [truncated at {MAX_LINES_PER_FILE} lines]"
                            )
                            break
                        chunks.append(line)
                        line_count += 1
            except Exception as exc:
                chunks.append(f"ERROR: Could not read file - {exc}\n")
            if self._cancelled:
                return ContentCache([])
        raw = "".join(chunks)
        return ContentCache.build_from_text(raw)


class LogSyntaxHighlighter(QSyntaxHighlighter):
    """Applies color coding to log lines via QSyntaxHighlighter — uses
    pre-compiled module-level patterns."""

    def __init__(self, document):
        super().__init__(document)
        self._rules: List[Tuple[re.Pattern, QTextCharFormat]] = []
        for _, pattern, color_key in _COMPILED_PATTERNS:
            fmt = QTextCharFormat()
            fmt.setForeground(QColor(get_color(color_key)))
            self._rules.append((pattern, fmt))

    def highlightBlock(self, text: str) -> None:
        for pattern, fmt in self._rules:
            for match in pattern.finditer(text):
                self.setFormat(match.start(), match.end() - match.start(), fmt)


class TabMetadata:
    """Holds tab metadata with lazy background loading."""

    def __init__(self, name: str, files: List[Path]):
        self.name = name
        self.files = files
        self.cache: Optional[ContentCache] = None
        self._loading = False

    @property
    def is_loaded(self) -> bool:
        return self.cache is not None

    def is_loading(self) -> bool:
        return self._loading

    def set_loading(self, val: bool):
        self._loading = val

    def set_cache(self, cache: ContentCache):
        self.cache = cache
        self._loading = False


class FreezeDetector(QObject):
    """Watchdog that captures stack traces when the Qt event loop is blocked.

    A daemon thread monitors a timestamp that the UI timer periodically
    updates.  If the timestamp is >4s stale, the main thread's call stack
    is captured to a log file while the freeze is still in progress.
    """

    freeze_detected = pyqtSignal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._running = False
        self._last_alive = [0.0]
        self._watchdog: Optional[QTimer] = None
        self._thread: Optional[threading.Thread] = None

    def start(self):
        if self._running:
            return
        self._running = True
        self._last_alive[0] = time.monotonic()

        self._watchdog = QTimer()
        self._watchdog.setInterval(1000)
        self._watchdog.timeout.connect(self._mark_alive)
        self._watchdog.start()

        self._thread = threading.Thread(target=self._monitor, daemon=True)
        self._thread.start()

    def stop(self):
        self._running = False
        if self._watchdog is not None:
            self._watchdog.stop()
            self._watchdog = None
        self._thread = None

    def _mark_alive(self):
        self._last_alive[0] = time.monotonic()

    def _monitor(self):
        while self._running:
            time.sleep(1.5)
            elapsed = time.monotonic() - self._last_alive[0]
            if elapsed > 4.0:
                frames = sys._current_frames()
                main_thread_id = threading.main_thread().ident
                stack = frames.get(main_thread_id)
                if stack is not None:
                    trace = ''.join(traceback.format_stack(stack))
                    msg = (
                        f"[FREEZE] UI thread blocked for {elapsed:.1f}s\n"
                        f"{trace}"
                    )
                    logger.critical(msg)
                    freeze_path = (
                        f"/tmp/log_viewer_freeze_{int(time.time())}.txt"
                    )
                    try:
                        with open(freeze_path, 'w') as f:
                            f.write(msg)
                    except OSError:
                        pass


class LogLoadSignals(QObject):
    """Signal carrier for LogLoadRunnable."""
    finished = pyqtSignal(object)


class LogLoadRunnable(QRunnable):
    """Background worker that scans log directories and builds tab metadata."""

    def __init__(self, logs_base_dir: Path, current_log_file: Optional[Path] = None):
        super().__init__()
        self.logs_base_dir = logs_base_dir
        self.current_log_file = current_log_file
        self._cancelled = False
        self.signals = LogLoadSignals()

    def cancel(self):
        self._cancelled = True

    def run(self):
        try:
            result = self._build_tabs()
            if not self._cancelled:
                self.signals.finished.emit(result)
        except Exception as e:
            if not self._cancelled:
                self.signals.finished.emit({"error": str(e)})

    def _build_tabs(self):
        tabs: List[TabMetadata] = []
        all_log_files: List[Path] = []
        log_directories: Set[str] = set()

        if not self.logs_base_dir.exists():
            tabs.append(TabMetadata("All Logs", []))
            return {"tabs": tabs, "focused_tab": 0}

        all_log_files = list(self.logs_base_dir.rglob("*.log"))

        for f in all_log_files:
            try:
                rel = f.relative_to(self.logs_base_dir)
                if len(rel.parts) > 1:
                    log_directories.add(rel.parts[0])
            except ValueError:
                pass

        capped_all = sorted(
            all_log_files, key=lambda p: p.stat().st_mtime, reverse=True
        )[:MAX_FILES_ALL_LOGS]
        tabs.append(TabMetadata("All Logs", capped_all))
        if self._cancelled:
            return None

        for log_type in sorted(log_directories):
            type_files = [f for f in all_log_files if log_type in str(f)]
            tabs.append(TabMetadata(log_type.replace("_", " ").title(), type_files))
            if self._cancelled:
                return None

        root_log_files = [f for f in all_log_files if f.parent == self.logs_base_dir]

        signal_log = next(
            (f for f in root_log_files if f.name == "signal_evaluator.log"), None
        )
        if signal_log is not None and not self._cancelled:
            tabs.append(TabMetadata("🔍 Signal Evaluator", [signal_log]))

        ai_log = next(
            (f for f in root_log_files if f.name == "ai_recommendations.log"), None
        )
        if ai_log is None:
            ai_log = next(
                (f for f in root_log_files if f.name == "test_ai_recommendations.log"), None
            )
        if ai_log is not None and not self._cancelled:
            tabs.append(TabMetadata("🤖 AI Recommendations", [ai_log]))

        focused_tab = 0
        if self.current_log_file is None and capped_all:
            self.current_log_file = capped_all[0]
        if self.current_log_file is not None and self.current_log_file.exists():
            cname = self.current_log_file.name
            if cname in ("ai_recommendations.log", "test_ai_recommendations.log"):
                for i, t in enumerate(tabs):
                    if "AI" in t.name or "🤖" in t.name:
                        focused_tab = i
                        break
            else:
                tab_name = (
                    "Session" if cname.startswith("session_") else f"📄 {cname}"
                )
                tabs.append(TabMetadata(tab_name, [self.current_log_file]))
                focused_tab = len(tabs) - 1

        if self._cancelled:
            return None

        return {"tabs": tabs, "focused_tab": focused_tab}


class LogViewerWindow(WindowGeometryMixin, QDialog):
    """
    Institutional-grade log viewer with tabs and event-based filtering.

    Features:
      - Background content loading (never blocks the UI thread)
      - Pre-classified lines for O(1) per-line filter matching
      - FreezeDetector watchdog for capturing stack traces
      - QPlainTextEdit + QSyntaxHighlighter for performant rendering
      - Lazy tab loading: content loaded only when tab is first activated
      - Background worker for directory scanning
      - Event-based filtering with contextual detail lines
      - Window maximize support
      - Geometry persistence (via WindowGeometryMixin)
    """

    GEOMETRY_SETTINGS_KEY = "logViewerWindow"
    GEOMETRY_DEFAULT_SIZE = (1100, 700)

    def __init__(self, log_file_path: Path = None, parent=None):
        super().__init__(parent)

        project_root = Path(__file__).resolve().parent.parent.parent.parent
        self.logs_base_dir = project_root / "logs"
        self.current_log_file = log_file_path

        self.event_filters: Dict[str, bool] = {event: True for event in EVENT_PATTERNS}

        self._tabs_meta: List[TabMetadata] = []
        self._tab_widgets: Dict[int, QPlainTextEdit] = {}
        self._tab_content_loaded: Set[int] = set()

        self._worker: Optional[LogLoadRunnable] = None
        self._content_loaders: List[BackgroundContentLoader] = []

        self._freeze_detector = FreezeDetector(self)
        self._freeze_detector.start()

        self._init_ui()
        QTimer.singleShot(0, self._start_loading)

    # =================================================================== #
    # UI Construction
    # =================================================================== #

    def _init_ui(self):
        self.setWindowFlags(
            Qt.Window
            | Qt.WindowTitleHint
            | Qt.WindowSystemMenuHint
            | Qt.WindowMinimizeButtonHint
            | Qt.WindowMaximizeButtonHint
            | Qt.WindowCloseButtonHint
        )

        log_name = self.current_log_file.name if self.current_log_file else "All Logs"
        self.setWindowTitle(f"Log Viewer - {log_name}")
        self.setMinimumSize(1200, 700)
        self.resize(1600, 1000)

        main_layout = QVBoxLayout()
        main_layout.setContentsMargins(10, 10, 10, 10)
        main_layout.setSpacing(15)

        self.title_label = QLabel(f"● Institutional Log Viewer - {log_name}")
        self.title_label.setStyleSheet(get_panel_title_stylesheet())
        main_layout.addWidget(self.title_label)

        self.tabs = QTabWidget()
        self.tabs.currentChanged.connect(self._on_tab_changed)
        main_layout.addWidget(self.tabs)

        filters_group = self._create_event_filters()
        main_layout.addWidget(filters_group)

        bottom_bar = self._create_bottom_bar()
        main_layout.addLayout(bottom_bar)

        self.setLayout(main_layout)

    def _create_log_panel(self) -> QWidget:
        widget = QWidget()
        layout = QVBoxLayout()
        layout.setContentsMargins(5, 5, 5, 5)

        text_edit = QPlainTextEdit()
        text_edit.setReadOnly(True)

        large_font = create_monospace_font(16)
        text_edit.setFont(large_font)
        text_edit.document().setDefaultFont(large_font)

        text_edit.setStyleSheet(get_log_text_edit_stylesheet())

        highlighter = LogSyntaxHighlighter(text_edit.document())
        text_edit._highlighter = highlighter

        layout.addWidget(text_edit)
        widget.setLayout(layout)
        widget.text_edit = text_edit

        return widget

    def _display_content(self, tab_index: int):
        if tab_index not in self._tab_widgets:
            return
        if tab_index >= len(self._tabs_meta):
            return
        meta = self._tabs_meta[tab_index]
        if meta.cache is None:
            return

        enabled = self._get_enabled_events()
        filtered, event_count = meta.cache.filter(enabled)
        self._tab_widgets[tab_index].setPlainText(filtered)
        self._update_stats(meta.cache, filtered, event_count)

    def _create_event_filters(self) -> QGroupBox:
        group = QGroupBox("📊 Event Filters")
        group.setStyleSheet(get_groupbox_header_stylesheet())

        container = QWidget()
        grid_layout = QGridLayout()
        grid_layout.setSpacing(10)
        grid_layout.setContentsMargins(15, 20, 15, 15)

        all_events = [
            ("TRADE_OPENED", "🟢 Trade Opened"),
            ("TRADE_CLOSED", "📘 Trade Closed"),
            ("TRADE_UPDATED", "🔄 Trade Updated"),
            ("POSITIONS_SNAPSHOT", "📊 Positions"),
            ("TRADE_NOT_FOUND", "❌ Not Found"),
            ("MULTIPLE_POSITIONS", "🔀 Multi Pos"),
            ("CONFIG_INITIALIZED", "✓ Config Init"),
            ("CONFIG_READ", "📖 Config Read"),
            ("CONFIG_VALIDATED", "✓ Validated"),
            ("CONFIG_MISMATCH", "❌ Mismatch"),
            ("CONFIG_MISSING", "⚠ Missing"),
            ("STARTED", "▶ Started"),
            ("STOPPED", "⏹ Stopped"),
            ("PROGRESS", "⏳ Progress"),
            ("COMPLETED", "✅ Completed"),
            ("CRITICAL", "🔴 Critical"),
            ("ERROR", "❌ Error"),
            ("WARNING", "⚠ Warning"),
            ("BLOCK_LOADED", "📦 Block Loaded"),
            ("BLOCK_ADDED", "➕ Block Added"),
            ("SEARCH_RESULTS", "🔍 Search"),
            ("DECISION", "🎯 Decision"),
            ("CONDITION_MET", "✓ Condition"),
            ("SIGNAL_DETECTED", "📡 Signal"),
        ]

        self.event_checkboxes: Dict[str, QCheckBox] = {}

        col = 0
        row = 0
        max_cols = 6

        for event_key, display_name in all_events:
            if event_key in EVENT_PATTERNS:
                _, color_key = EVENT_PATTERNS[event_key]
                checkbox = QCheckBox(display_name)
                checkbox.setChecked(True)
                checkbox.setFont(create_font(11))
                checkbox.setFixedWidth(320)

                hex_color = get_color(color_key)
                checkbox.setStyleSheet(
                    get_event_filter_checkbox_style(hex_color)
                )
                checkbox.stateChanged.connect(
                    lambda state, e=event_key: self._on_event_filter_changed(e, state)
                )
                self.event_checkboxes[event_key] = checkbox

                grid_layout.addWidget(checkbox, row, col)

                col += 1
                if col >= max_cols:
                    col = 0
                    row += 1

        row += 1
        self.toggle_all_btn = QPushButton("Toggle All")
        self.toggle_all_btn.setStyleSheet(
            get_primary_button_stylesheet(compact=True)
        )
        self.toggle_all_btn.setFixedSize(140, 36)
        self.toggle_all_btn.setToolTip(
            "Enable or disable all event filters at once"
        )
        self.toggle_all_btn.clicked.connect(self._toggle_all_filters)
        grid_layout.addWidget(self.toggle_all_btn, row, 0, 1, 1)

        container.setLayout(grid_layout)

        group_layout = QVBoxLayout()
        group_layout.setContentsMargins(0, 0, 0, 0)
        group_layout.addWidget(container)
        group.setLayout(group_layout)

        return group

    def _create_bottom_bar(self) -> QHBoxLayout:
        layout = QHBoxLayout()
        layout.setSpacing(15)

        self.msg_count_label = QLabel("Total Lines: <b>0</b>")
        self.msg_count_label.setStyleSheet(get_label_style())
        layout.addWidget(self.msg_count_label)

        self.filtered_count_label = QLabel("Displayed: <b>0</b>")
        self.filtered_count_label.setStyleSheet(get_label_style())
        layout.addWidget(self.filtered_count_label)

        self.event_count_label = QLabel("Events: <b>0</b>")
        self.event_count_label.setStyleSheet(get_label_style("warning"))
        layout.addWidget(self.event_count_label)

        layout.addStretch()

        copy_btn = QPushButton("📋 Copy")
        copy_btn.setStyleSheet(get_primary_button_stylesheet(compact=True))
        copy_btn.setFixedSize(130, 52)
        copy_btn.setToolTip("Copy all visible log content to the clipboard")
        copy_btn.clicked.connect(self._copy_to_clipboard)
        layout.addWidget(copy_btn)

        copy_selection_btn = QPushButton("📋 Copy Selection")
        copy_selection_btn.setStyleSheet(
            get_primary_button_stylesheet(compact=True)
        )
        copy_selection_btn.setFixedSize(240, 52)
        copy_selection_btn.setToolTip(
            "Copy only the currently selected text in the log viewer to the clipboard"
        )
        copy_selection_btn.clicked.connect(self._copy_selection)
        layout.addWidget(copy_selection_btn)

        clear_logs_btn = QPushButton("🗑️ Clear All Logs")
        clear_logs_btn.setStyleSheet(
            get_primary_button_stylesheet(compact=True)
        )
        clear_logs_btn.setFixedSize(220, 52)
        clear_logs_btn.clicked.connect(self._clear_all_logs)
        clear_logs_btn.setToolTip("Delete ALL log files from logs directory")
        layout.addWidget(clear_logs_btn)

        close_btn = QPushButton("✖ Close")
        close_btn.setStyleSheet(get_primary_button_stylesheet(compact=True))
        close_btn.setFixedSize(130, 52)
        close_btn.setToolTip("Close the log viewer window")
        close_btn.clicked.connect(self.close)
        layout.addWidget(close_btn)

        return layout

    # =================================================================== #
    # Background Loading
    # =================================================================== #

    def _start_loading(self):
        if self._worker is not None:
            return
        self._worker = LogLoadRunnable(self.logs_base_dir, self.current_log_file)
        self._worker.signals.finished.connect(self._on_logs_loaded)
        QThreadPool.globalInstance().start(self._worker)

    def _on_logs_loaded(self, result):
        self._worker = None
        if result is None:
            return
        if isinstance(result, dict) and "error" in result:
            try:
                self._show_error_tab(str(result["error"]))
            except RuntimeError:
                pass
            return
        try:
            self._tabs_meta = result.get("tabs", [])
            focused_tab = result.get("focused_tab", 0)

            for i, meta in enumerate(self._tabs_meta):
                panel = self._create_log_panel()
                self._tab_widgets[i] = panel.text_edit
                self.tabs.addTab(panel, meta.name)

            if focused_tab < self.tabs.count():
                self.tabs.setCurrentIndex(focused_tab)

            # _activate_tab not called explicitly — setCurrentIndex above triggers
            # _on_tab_changed which dispatches background loading via _activate_tab.
            self._restore_last_tab()
        except RuntimeError:
            pass

    def _show_error_tab(self, error_msg: str):
        panel = self._create_log_panel()
        self._tab_widgets[0] = panel.text_edit
        self.tabs.addTab(panel, "Error")
        panel.text_edit.setPlainText(f"Error loading logs:\n{error_msg}")

    # =================================================================== #
    # Lazy Tab Activation (background loading)
    # =================================================================== #

    def _on_tab_changed(self, index: int):
        if index < 0:
            return
        if index not in self._tab_content_loaded:
            self._activate_tab(index)
        self._update_filter_visibility(index)
        if index in self._tab_content_loaded:
            self._display_content(index)

    def _activate_tab(self, index: int):
        if index in self._tab_content_loaded:
            return
        if index >= len(self._tabs_meta):
            return

        meta = self._tabs_meta[index]
        if meta.cache is not None:
            self._tab_content_loaded.add(index)
            self._display_content(index)
            return

        if meta.is_loading():
            return

        meta.set_loading(True)

        if index in self._tab_widgets:
            self._tab_widgets[index].setPlainText("(Loading log content...)")

        loader = BackgroundContentLoader(index, meta)
        loader.signals.loaded.connect(self._on_content_loaded)
        loader.signals.error.connect(self._on_content_error)
        self._content_loaders.append(loader)
        QThreadPool.globalInstance().start(loader)

    def _on_content_loaded(self, tab_index: int, cache: ContentCache):
        self._content_loaders = [
            cl for cl in self._content_loaders
            if cl.tab_index != tab_index
        ]
        if tab_index >= len(self._tabs_meta):
            return
        meta = self._tabs_meta[tab_index]
        meta.set_cache(cache)
        self._tab_content_loaded.add(tab_index)

        if self.tabs.currentIndex() == tab_index:
            self._display_content(tab_index)

    def _on_content_error(self, tab_index: int, error_msg: str):
        self._content_loaders = [
            cl for cl in self._content_loaders
            if cl.tab_index != tab_index
        ]
        logger.error("Error loading tab %d: %s", tab_index, error_msg)
        if tab_index in self._tab_widgets:
            self._tab_widgets[tab_index].setPlainText(
                f"Error loading content: {error_msg}"
            )

    # =================================================================== #
    # Event Filtering (uses pre-classified ContentCache)
    # =================================================================== #

    def _get_enabled_events(self) -> Set[str]:
        return {k for k, v in self.event_filters.items() if v}

    def _on_event_filter_changed(self, event: str, state: int):
        self.event_filters[event] = state == Qt.Checked
        self._update_toggle_button_text()
        self._refresh_current_tab()

    def _update_filter_visibility(self, tab_index: int):
        tab_name = self.tabs.tabText(tab_index).replace("📄 ", "").lower()

        tab_event_map = {
            "all logs": list(EVENT_PATTERNS.keys()),
            "trades": [
                "TRADE_OPENED", "TRADE_CLOSED", "TRADE_UPDATED",
                "POSITIONS_SNAPSHOT", "TRADE_NOT_FOUND", "MULTIPLE_POSITIONS",
                "CRITICAL", "ERROR", "WARNING",
            ],
            "strategy builder": [
                "CONFIG_INITIALIZED", "CONFIG_READ", "CONFIG_VALIDATED",
                "CONFIG_MISMATCH", "CONFIG_MISSING", "STARTED", "STOPPED",
                "PROGRESS", "COMPLETED", "CRITICAL", "ERROR", "WARNING",
                "BLOCK_LOADED", "BLOCK_ADDED", "SEARCH_RESULTS",
            ],
            "session": [
                "CONFIG_INITIALIZED", "CONFIG_READ", "CONFIG_VALIDATED",
                "STARTED", "STOPPED", "COMPLETED", "ERROR", "WARNING",
                "BLOCK_LOADED", "SEARCH_RESULTS",
            ],
            "optimizer": [
                "STARTED", "STOPPED", "PROGRESS", "COMPLETED",
                "CRITICAL", "ERROR", "WARNING",
            ],
            "backtest": [
                "TRADE_OPENED", "TRADE_CLOSED", "TRADE_UPDATED", "STARTED",
                "STOPPED", "PROGRESS", "COMPLETED", "CRITICAL", "ERROR", "WARNING",
            ],
        }

        relevant_events: Optional[List[str]] = None
        for key, events in tab_event_map.items():
            if key in tab_name:
                relevant_events = events
                break
        if relevant_events is None:
            relevant_events = list(EVENT_PATTERNS.keys())

        filter_group: Optional[QGroupBox] = None
        for i in range(self.layout().count()):
            w = self.layout().itemAt(i).widget()
            if isinstance(w, QGroupBox) and "Event Filters" in w.title():
                filter_group = w
                break

        if not filter_group:
            return

        container = filter_group.layout().itemAt(0).widget()
        grid_layout = container.layout()

        if not isinstance(grid_layout, QGridLayout):
            return

        for checkbox in self.event_checkboxes.values():
            grid_layout.removeWidget(checkbox)
            checkbox.hide()

        col = 0
        row = 0
        max_cols = 6

        all_events_ordered = [
            "TRADE_OPENED", "TRADE_CLOSED", "TRADE_UPDATED",
            "POSITIONS_SNAPSHOT", "TRADE_NOT_FOUND", "MULTIPLE_POSITIONS",
            "CONFIG_INITIALIZED", "CONFIG_READ", "CONFIG_VALIDATED",
            "CONFIG_MISMATCH", "CONFIG_MISSING", "STARTED", "STOPPED",
            "PROGRESS", "COMPLETED", "CRITICAL", "ERROR", "WARNING",
            "BLOCK_LOADED", "BLOCK_ADDED", "SEARCH_RESULTS",
            "DECISION", "CONDITION_MET", "SIGNAL_DETECTED",
        ]

        for event_key in all_events_ordered:
            if event_key in relevant_events and event_key in self.event_checkboxes:
                checkbox = self.event_checkboxes[event_key]
                checkbox.show()
                grid_layout.addWidget(checkbox, row, col)
                col += 1
                if col >= max_cols:
                    col = 0
                    row += 1

    def _refresh_current_tab(self):
        index = self.tabs.currentIndex()
        if index < 0:
            return
        self._display_content(index)

    def _toggle_all_filters(self):
        new_state = self.toggle_all_btn.text() == "Select All"

        for checkbox in self.event_checkboxes.values():
            checkbox.blockSignals(True)
            checkbox.setChecked(new_state)
            checkbox.blockSignals(False)

        for event_key in self.event_filters:
            self.event_filters[event_key] = new_state

        self._update_toggle_button_text()
        self._refresh_current_tab()

    def _update_toggle_button_text(self):
        all_selected = all(self.event_filters.values())
        self.toggle_all_btn.setText(
            "Unselect All" if all_selected else "Select All"
        )

    def _update_stats(self, cache: ContentCache, filtered: str, event_count: int):
        total_lines = cache.total_count
        displayed_lines = len(filtered.split("\n")) if filtered else 0

        self.msg_count_label.setText(
            f"Total Lines: <b>{total_lines:,}</b>"
        )
        self.filtered_count_label.setText(
            f"Displayed: <b>{displayed_lines:,}</b>"
        )
        self.event_count_label.setText(
            f"Events: <b>{event_count:,}</b>"
        )

    # =================================================================== #
    # Actions
    # =================================================================== #

    def _copy_to_clipboard(self):
        index = self.tabs.currentIndex()
        if index not in self._tab_widgets:
            return
        content = self._tab_widgets[index].toPlainText()
        if not content:
            QMessageBox.information(self, "Nothing to Copy", "No content to copy.")
            return
        QApplication.clipboard().setText(content)
        line_count = len(content.split("\n"))
        self.filtered_count_label.setText(
            f"✅ Copied {line_count:,} lines to clipboard"
        )

    def _copy_selection(self):
        index = self.tabs.currentIndex()
        if index not in self._tab_widgets:
            return
        selected = (
            self._tab_widgets[index]
            .textCursor()
            .selectedText()
            .replace("\u2029", "\n")
        )
        if not selected:
            QMessageBox.information(
                self, "No Selection", "Please select text to copy."
            )
            return
        QApplication.clipboard().setText(selected)
        line_count = len(selected.split("\n"))
        self.filtered_count_label.setText(
            f"✅ Copied {line_count:,} selected lines"
        )

    def _clear_all_logs(self):
        try:
            if not self.logs_base_dir.exists():
                QMessageBox.critical(
                    self, "Directory Not Found",
                    f"Logs directory does not exist:\n{self.logs_base_dir}",
                )
                return

            fresh_log_files = list(self.logs_base_dir.rglob("*.log"))

            if not fresh_log_files:
                QMessageBox.warning(
                    self, "No Logs", "No log files found to delete."
                )
                return

            reply = QMessageBox.question(
                self,
                "Clear All Logs",
                f"⚠️  DELETE {len(fresh_log_files)} log files?"
                f"\n\nThis action cannot be undone.\n\n"
                f"Are you sure you want to continue?",
                QMessageBox.Yes | QMessageBox.No,
                QMessageBox.No,
            )

            if reply != QMessageBox.Yes:
                return

            deleted_count = 0
            total_size = 0
            failed_files: List[str] = []

            for log_file in fresh_log_files:
                try:
                    file_size = log_file.stat().st_size
                    log_file.unlink()
                    deleted_count += 1
                    total_size += file_size
                except Exception as e:
                    failed_files.append(f"{log_file.name}: {e}")
                    logger.error("Error deleting %s: %s", log_file, e)

            size_mb = total_size / (1024 * 1024)
            QMessageBox.information(
                self,
                "Logs Cleared",
                f"Successfully deleted {deleted_count} log files."
                f"\n\nSpace freed: {size_mb:.2f} MB",
            )

            self._tabs_meta.clear()
            self._tab_widgets.clear()
            self._tab_content_loaded.clear()

            while self.tabs.count() > 0:
                self.tabs.removeTab(0)

            empty_meta = TabMetadata("All Logs", [])
            self._tabs_meta.append(empty_meta)
            panel = self._create_log_panel()
            self._tab_widgets[0] = panel.text_edit
            self.tabs.addTab(panel, "All Logs")
            self._tab_content_loaded.add(0)
            panel.text_edit.setPlainText("(No logs available)")

            self.filtered_count_label.setText(
                f"✅ Cleared {deleted_count} log files ({size_mb:.1f} MB)"
            )

        except Exception as e:
            QMessageBox.critical(
                self, "Error", f"Error clearing logs:\n\n{str(e)}"
            )

    def _restore_last_tab(self):
        settings = QSettings("BTC_Engine", "LogViewer")
        last_tab = settings.value("lastTab", 0, type=int)
        if 0 <= last_tab < self.tabs.count():
            self.tabs.setCurrentIndex(last_tab)

    def showEvent(self, event):
        super().showEvent(event)
        self._restore_window_geometry(event)
        QTimer.singleShot(200, lambda: apply_hand_cursor_to_buttons(self))

    def closeEvent(self, event):
        self._freeze_detector.stop()

        if self._worker is not None:
            self._worker.cancel()
            self._worker = None

        for cl in self._content_loaders:
            cl.cancel()
        self._content_loaders.clear()

        self._save_window_geometry()
        settings = QSettings("BTC_Engine", "LogViewer")
        settings.setValue("lastTab", self.tabs.currentIndex())
        super().closeEvent(event)


from .styles import apply_hand_cursor_to_buttons
