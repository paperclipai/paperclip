"""
Data Verify Dialog - Data Integrity Check UI

Shows per-symbol/timeframe gap analysis for stored Binance OHLCV data.
Called from Tools → Verify Data...

Verification calls detect_gaps_in_binance_files() for each timeframe, then
classifies every gap as either:
  - repairable  — gap_start is within the Binance API 90-day horizon
  - too_old     — gap_start predates the horizon; requires LakeAPI backfill

Repair uses verify_and_repair(dry_run=False) to fetch and fill each repairable
gap from Binance directly — NOT the general DataUpdateModal date-range download.

After repair completes the dialog automatically re-runs verification so the
user can confirm the data is now clean.

Author: Strategy Builder Team
Date: 2026-05-02
"""

from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, List
from PyQt5.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QProgressBar, QTableWidget, QTableWidgetItem, QHeaderView,
    QGroupBox, QAbstractItemView
)
from PyQt5.QtCore import Qt, QThread, pyqtSignal
from PyQt5.QtGui import QColor

from src.data_manager.unified_manager import UnifiedDataManager
from src.strategy_builder.ui.styles import (
    get_main_stylesheet,
    get_panel_title_stylesheet,
    get_label_style,
    get_italic_label_style,
    get_status_label_style,
    get_primary_button_stylesheet,
    get_secondary_button_stylesheet,
    get_table_stylesheet,
    create_font,
    apply_hand_cursor_to_buttons,
    COLORS,
    WindowGeometryMixin,
)

# Binance free API only serves the last N days — gaps older than this cannot
# be repaired from Binance and require a LakeAPI backfill.
_BINANCE_HORIZON_DAYS = 90


# ---------------------------------------------------------------------------
# Background threads
# ---------------------------------------------------------------------------

class DataVerifyThread(QThread):
    """
    Background thread: detect and classify gaps without modifying any data.

    For each timeframe calls detect_gaps_in_binance_files(), then splits
    each gap into 'repairable' (within the 90-day Binance horizon) or
    'too_old' (predates the horizon — LakeAPI backfill needed).

    Signals:
        progress(int, int, str): (current, total, message)
        finished(bool, dict): (success, report)

    Report structure::

        {
            '15m': {
                'repairable': [gap_dict, ...],   # within Binance horizon
                'too_old':    [gap_dict, ...],   # older than horizon
                'gaps_found': int,               # repairable + too_old
                'repairable_count': int,
                'too_old_count': int,
                'total_missing_bars': int,       # across all gaps
                'repairable_missing_bars': int,
                'too_old_missing_bars': int,
                'last_candle_ts': datetime|None, # most recent stored bar
            },
            ...
            '_error': str,  # only present on exception
        }
    """

    progress = pyqtSignal(int, int, str)
    finished = pyqtSignal(bool, dict)

    _TIMEFRAMES = ['15m', '1h', '1d']

    def run(self):
        try:
            self.progress.emit(10, 100, "Initialising data manager…")
            manager = UnifiedDataManager(mode='live')
            # horizon_cutoff must be tz-aware UTC to match gap_start timestamps
            # returned by detect_gaps_in_binance_files (tz-aware since utc=True was
            # added to pd.to_datetime in unified_manager.py post-bcdf0db).
            horizon_cutoff = datetime.now(timezone.utc) - timedelta(days=_BINANCE_HORIZON_DAYS)

            report: Dict = {}
            steps = len(self._TIMEFRAMES)
            for i, tf in enumerate(self._TIMEFRAMES):
                pct_start = 20 + int(i * 70 / steps)
                pct_end = 20 + int((i + 1) * 70 / steps)
                self.progress.emit(pct_start, 100, f"Scanning {tf} data for gaps…")

                all_gaps: List[Dict] = manager.detect_gaps_in_binance_files(tf)
                last_candle_ts: Optional[datetime] = manager.get_last_bar_timestamp(tf)

                repairable = [g for g in all_gaps if g['gap_start'] >= horizon_cutoff]
                too_old = [g for g in all_gaps if g['gap_start'] < horizon_cutoff]

                report[tf] = {
                    'repairable': repairable,
                    'too_old': too_old,
                    'gaps_found': len(all_gaps),
                    'repairable_count': len(repairable),
                    'too_old_count': len(too_old),
                    'total_missing_bars': sum(g['missing_bars'] for g in all_gaps),
                    'repairable_missing_bars': sum(g['missing_bars'] for g in repairable),
                    'too_old_missing_bars': sum(g['missing_bars'] for g in too_old),
                    'last_candle_ts': last_candle_ts,
                }
                self.progress.emit(
                    pct_end, 100,
                    f"{tf}: {len(all_gaps)} gap(s) "
                    f"({len(repairable)} repairable, {len(too_old)} too old)."
                )

            self.progress.emit(100, 100, "Verification complete.")
            self.finished.emit(True, report)

        except Exception as exc:
            self.finished.emit(False, {'_error': str(exc)})


class DataRepairThread(QThread):
    """
    Background thread: repair repairable gaps by fetching missing bars from Binance.

    Calls verify_and_repair(dry_run=False) which targets each specific gap
    within the Binance API horizon rather than a broad date-range download.
    Gaps older than the horizon are automatically skipped by the backend.

    Signals:
        progress(int, int, str): (current, total, message)
        finished(bool, dict): (success, repair_summary)
    """

    progress = pyqtSignal(int, int, str)
    finished = pyqtSignal(bool, dict)

    def run(self):
        try:
            self.progress.emit(5, 100, "Starting gap repair via Binance…")
            manager = UnifiedDataManager(mode='live')

            self.progress.emit(20, 100, "Fetching missing bars from Binance (this may take a moment)…")
            summary = manager.verify_and_repair(
                timeframes=['15m', '1h', '1d'],
                dry_run=False,
            )

            self.progress.emit(100, 100, "Repair complete.")
            self.finished.emit(True, summary)

        except Exception as exc:
            self.finished.emit(False, {'_error': str(exc)})


# ---------------------------------------------------------------------------
# Dialog
# ---------------------------------------------------------------------------

class DataVerifyDialog(WindowGeometryMixin, QDialog):
    """
    Dialog for verifying (and repairing) data integrity.

    States
    ------
    - verifying  — DataVerifyThread running
    - results    — table populated
      - Fix Gaps shown  → at least one repairable gap exists
      - Fix Gaps hidden → all gaps are too old, or no gaps
    - repairing  — DataRepairThread running
    - done       — repair finished, re-verification auto-started

    Each timeframe renders as one or two rows:
      Row A (always): overall status — Clean | Repairable Gaps | Too Old (LakeAPI)
      When both repairable AND too-old gaps exist, a second row shows the
      too-old count so the user knows how many Binance can't fix.
    """

    # ------------------------------------------------------------------
    # Construction
    # ------------------------------------------------------------------

    GEOMETRY_SETTINGS_KEY = "dataVerifyDialog"
    GEOMETRY_DEFAULT_SIZE = (1380, 800)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._verify_thread: Optional[DataVerifyThread] = None
        self._repair_thread: Optional[DataRepairThread] = None
        self._last_report: Dict = {}
        self._has_repairable_gaps: bool = False

        self._init_ui()
        self._start_verification()

    def _init_ui(self):
        self.setWindowTitle("Verify Data — Data Integrity Check")
        self.setWindowFlags(
            Qt.Window
            | Qt.WindowTitleHint
            | Qt.WindowCloseButtonHint
            | Qt.WindowMinimizeButtonHint
            | Qt.WindowMaximizeButtonHint
        )
        self.setModal(True)
        self.setMinimumWidth(1300)
        self.setMinimumHeight(720)
        self.resize(1380, 800)
        self.setStyleSheet(get_main_stylesheet())

        root = QVBoxLayout()
        root.setSpacing(12)
        root.setContentsMargins(20, 20, 20, 20)

        # Header
        header = QLabel("Data Integrity Verification")
        header.setFont(create_font(size=14, bold=True))
        header.setStyleSheet(get_panel_title_stylesheet())
        root.addWidget(header)

        subtitle = QLabel(
            "Checking stored Binance OHLCV data for gaps in BTCUSDT Perpetual across all timeframes."
        )
        subtitle.setFont(create_font(size=9))
        subtitle.setStyleSheet(get_label_style('muted'))
        subtitle.setWordWrap(True)
        root.addWidget(subtitle)

        # Summary banner
        summary_group = QGroupBox("Summary")
        summary_layout = QVBoxLayout()
        summary_layout.setContentsMargins(10, 4, 10, 8)
        summary_layout.setSpacing(2)

        self._summary_label = QLabel("Starting verification…")
        self._summary_label.setFont(create_font(size=10, bold=True))
        self._summary_label.setAlignment(Qt.AlignCenter)
        self._summary_label.setWordWrap(True)
        self._summary_label.setStyleSheet(get_status_label_style('default'))
        summary_layout.addWidget(self._summary_label)

        summary_group.setLayout(summary_layout)
        root.addWidget(summary_group)

        # Current UTC time label — updated each time verification starts
        # Positioned below the Summary block so it reads as a timestamp annotation
        # for the verification run, not as part of the header section.
        self._utc_time_label = QLabel(self._format_utc_now())
        self._utc_time_label.setFont(create_font(size=9))
        self._utc_time_label.setStyleSheet(get_label_style('muted'))
        self._utc_time_label.setAlignment(Qt.AlignRight)
        root.addWidget(self._utc_time_label)

        # Results table
        results_group = QGroupBox("Results")
        results_layout = QVBoxLayout()
        results_layout.setContentsMargins(10, 10, 10, 10)

        self._table = QTableWidget(0, 6)
        self._table.setHorizontalHeaderLabels(
            ["Timeframe", "Status", "Gaps Found", "Missing Bars", "Last Candle", "Notes"]
        )
        hdr = self._table.horizontalHeader()
        hdr.setSectionResizeMode(QHeaderView.ResizeToContents)
        hdr.setSectionResizeMode(5, QHeaderView.Stretch)  # Notes gets all remaining space
        self._table.setAlternatingRowColors(True)
        self._table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self._table.setSelectionMode(QAbstractItemView.SingleSelection)
        self._table.setMinimumHeight(200)
        self._table.setStyleSheet(get_table_stylesheet())
        results_layout.addWidget(self._table)

        results_group.setLayout(results_layout)
        root.addWidget(results_group)

        # Progress
        self._progress_bar = QProgressBar()
        self._progress_bar.setVisible(False)
        root.addWidget(self._progress_bar)

        self._progress_label = QLabel("")
        self._progress_label.setFont(create_font(size=9))
        self._progress_label.setStyleSheet(get_italic_label_style('muted'))
        self._progress_label.setVisible(False)
        root.addWidget(self._progress_label)

        root.addStretch()

        # Buttons
        btn_row = QHBoxLayout()
        btn_row.addStretch()

        self._run_btn = QPushButton("Run Verification")
        self._run_btn.setMinimumWidth(160)
        self._run_btn.setMinimumHeight(38)
        self._run_btn.setStyleSheet(get_secondary_button_stylesheet())
        self._run_btn.setToolTip("Scan all data files for gaps and missing bars across all timeframes")
        self._run_btn.clicked.connect(self._start_verification)
        btn_row.addWidget(self._run_btn)

        self._fix_btn = QPushButton("Fix Gaps")
        self._fix_btn.setMinimumWidth(130)
        self._fix_btn.setMinimumHeight(38)
        self._fix_btn.setStyleSheet(get_primary_button_stylesheet())
        self._fix_btn.setToolTip("Download and fill all repairable data gaps from Binance")
        self._fix_btn.clicked.connect(self._start_repair)
        self._fix_btn.setVisible(False)
        btn_row.addWidget(self._fix_btn)

        self._close_btn = QPushButton("Close")
        self._close_btn.setMinimumWidth(100)
        self._close_btn.setMinimumHeight(38)
        self._close_btn.setStyleSheet(get_secondary_button_stylesheet())
        self._close_btn.setToolTip("Close the data verification dialog")
        self._close_btn.clicked.connect(self.reject)
        btn_row.addWidget(self._close_btn)

        root.addLayout(btn_row)
        self.setLayout(root)

    # ------------------------------------------------------------------
    # Verification
    # ------------------------------------------------------------------

    def _start_verification(self):
        """Kick off DataVerifyThread (read-only gap scan)."""
        if (self._verify_thread and self._verify_thread.isRunning()) or \
           (self._repair_thread and self._repair_thread.isRunning()):
            return

        self._utc_time_label.setText(self._format_utc_now())
        self._table.setRowCount(0)
        self._has_repairable_gaps = False
        self._fix_btn.setVisible(False)
        self._run_btn.setEnabled(False)
        self._summary_label.setText("Verification in progress…")
        self._summary_label.setStyleSheet(get_status_label_style('default'))
        self._show_progress(True, "Initialising…")

        self._verify_thread = DataVerifyThread()
        self._verify_thread.progress.connect(self._on_progress)
        self._verify_thread.finished.connect(self._on_verify_finished)
        self._verify_thread.start()

    def _on_verify_finished(self, success: bool, report: Dict):
        self._show_progress(False)
        self._run_btn.setEnabled(True)
        self._last_report = report

        if not success:
            error_msg = report.get('_error', 'Unknown error')
            self._summary_label.setText(f"Verification failed: {error_msg}")
            self._summary_label.setStyleSheet(get_status_label_style('error'))
            self._add_error_row(error_msg)
            return

        self._populate_table(report)

    def _populate_table(self, report: Dict):
        """Fill the results table with per-timeframe gap classification."""
        self._table.setRowCount(0)

        total_repairable = 0
        total_too_old = 0
        total_repairable_missing = 0
        total_too_old_missing = 0

        def cell(text: str, color: Optional[str] = None, bold: bool = False) -> QTableWidgetItem:
            item = QTableWidgetItem(str(text))
            item.setTextAlignment(Qt.AlignCenter)
            if color:
                item.setForeground(QColor(color))
            if bold:
                item.setFont(create_font(size=9, bold=True))
            return item

        for tf, tf_data in report.items():
            if tf.startswith('_'):
                continue

            r_count: int = tf_data.get('repairable_count', 0)
            o_count: int = tf_data.get('too_old_count', 0)
            r_missing: int = tf_data.get('repairable_missing_bars', 0)
            o_missing: int = tf_data.get('too_old_missing_bars', 0)
            r_gaps: List[Dict] = tf_data.get('repairable', [])
            o_gaps: List[Dict] = tf_data.get('too_old', [])
            last_candle_ts: Optional[datetime] = tf_data.get('last_candle_ts')

            total_repairable += r_count
            total_too_old += o_count
            total_repairable_missing += r_missing
            total_too_old_missing += o_missing

            if r_count > 0:
                self._has_repairable_gaps = True

            gaps_found = r_count + o_count

            # Format the last candle timestamp for display (col 4)
            if last_candle_ts is not None:
                last_candle_text = last_candle_ts.strftime('%Y-%m-%d %H:%M UTC')
                last_candle_color = COLORS['text_secondary']
            else:
                last_candle_text = "—"
                last_candle_color = COLORS['text_muted']

            # --- Primary row ---
            if gaps_found == 0:
                status_text = "Clean"
                status_color = COLORS['success']
                gaps_cell = "0"
                missing_cell = "—"
                notes = "No action required"
            elif r_count > 0 and o_count == 0:
                # Only repairable gaps
                status_text = "Gaps Found"
                status_color = COLORS['error']
                gaps_cell = str(r_count)
                missing_cell = str(r_missing)
                earliest = min(g['gap_start'] for g in r_gaps)
                notes = f"Earliest: {earliest.strftime('%Y-%m-%d %H:%M')}"
            elif r_count == 0 and o_count > 0:
                # Only too-old gaps — Binance cannot fix these
                status_text = "Too Old — LakeAPI needed"
                status_color = COLORS['warning']
                gaps_cell = str(o_count)
                missing_cell = str(o_missing)
                earliest = min(g['gap_start'] for g in o_gaps)
                notes = f"From {earliest.strftime('%Y-%m-%d')} — beyond {_BINANCE_HORIZON_DAYS}d horizon"
            else:
                # Mixed: some repairable, some too old
                status_text = "Mixed Gaps"
                status_color = COLORS['warning']
                gaps_cell = str(gaps_found)
                missing_cell = str(r_missing + o_missing)
                notes = f"{r_count} fixable, {o_count} need LakeAPI"

            row = self._table.rowCount()
            self._table.insertRow(row)
            self._table.setItem(row, 0, cell(tf))
            self._table.setItem(row, 1, cell(status_text, status_color, bold=True))
            self._table.setItem(row, 2, cell(gaps_cell))
            self._table.setItem(row, 3, cell(missing_cell))
            self._table.setItem(row, 4, cell(last_candle_text, last_candle_color))
            self._table.setItem(row, 5, cell(notes))

            # --- Secondary row for mixed case: detail the too-old portion ---
            if r_count > 0 and o_count > 0:
                row2 = self._table.rowCount()
                self._table.insertRow(row2)
                earliest_old = min(g['gap_start'] for g in o_gaps)
                self._table.setItem(row2, 0, cell(f"{tf} (old)"))
                self._table.setItem(row2, 1, cell("Too Old — LakeAPI needed", COLORS['warning'], bold=True))
                self._table.setItem(row2, 2, cell(str(o_count)))
                self._table.setItem(row2, 3, cell(str(o_missing)))
                self._table.setItem(row2, 4, cell("—", COLORS['text_muted']))  # no separate last-candle for sub-row
                self._table.setItem(
                    row2, 5,
                    cell(f"From {earliest_old.strftime('%Y-%m-%d')} — beyond {_BINANCE_HORIZON_DAYS}d horizon")
                )

        # --- Summary banner ---
        if total_repairable == 0 and total_too_old == 0:
            self._summary_label.setText("All data is complete — no gaps found")
            self._summary_label.setStyleSheet(get_status_label_style('success'))
            self._fix_btn.setVisible(False)
        elif total_repairable > 0 and total_too_old == 0:
            self._summary_label.setText(
                f"{total_repairable} gap(s) found ({total_repairable_missing} missing bars) "
                f"— use Fix Gaps to repair from Binance"
            )
            self._summary_label.setStyleSheet(get_status_label_style('warning'))
            self._fix_btn.setVisible(True)
        elif total_repairable == 0 and total_too_old > 0:
            self._summary_label.setText(
                f"{total_too_old} gap(s) found ({total_too_old_missing} missing bars) are older "
                f"than the {_BINANCE_HORIZON_DAYS}-day Binance horizon — LakeAPI backfill needed"
            )
            self._summary_label.setStyleSheet(get_status_label_style('warning'))
            self._fix_btn.setVisible(False)   # Fix Gaps can't help here
        else:
            # Mixed
            self._summary_label.setText(
                f"{total_repairable} gap(s) fixable via Binance "
                f"({total_repairable_missing} bars) + "
                f"{total_too_old} gap(s) need LakeAPI backfill "
                f"({total_too_old_missing} bars)"
            )
            self._summary_label.setStyleSheet(get_status_label_style('warning'))
            self._fix_btn.setVisible(True)    # Fix what we can

        # Force Qt to repaint all inserted rows — without this, the last row(s)
        # inserted programmatically may not appear until the viewport is scrolled
        # or the window is resized (known Qt rendering artefact with QTableWidget).
        self._table.resizeRowsToContents()
        # Auto-size table height to show all rows without scrolling.
        # Use setMinimumHeight (not setFixedHeight) so the dialog layout can
        # still distribute any extra vertical space and the table grows with the
        # window when the user resizes it.
        total_row_height = sum(
            self._table.rowHeight(r) for r in range(self._table.rowCount())
        )
        header_height = self._table.horizontalHeader().height()
        self._table.setMinimumHeight(total_row_height + header_height + 4)
        self._table.viewport().update()

    # ------------------------------------------------------------------
    # Repair
    # ------------------------------------------------------------------

    def _start_repair(self):
        """
        Kick off DataRepairThread.

        Calls verify_and_repair(dry_run=False) which fetches each gap within
        the Binance API horizon individually. Gaps older than the horizon are
        skipped by the backend with a warning.

        After repair finishes, automatically re-runs verification.
        """
        if self._repair_thread and self._repair_thread.isRunning():
            return

        self._fix_btn.setVisible(False)
        self._run_btn.setEnabled(False)
        self._summary_label.setText("Repairing gaps — fetching missing bars from Binance…")
        self._summary_label.setStyleSheet(get_status_label_style('info'))
        self._show_progress(True, "Starting repair…")

        self._repair_thread = DataRepairThread()
        self._repair_thread.progress.connect(self._on_progress)
        self._repair_thread.finished.connect(self._on_repair_finished)
        self._repair_thread.start()

    def _on_repair_finished(self, success: bool, summary: Dict):
        self._show_progress(False)

        if not success:
            error_msg = summary.get('_error', 'Unknown error')
            self._summary_label.setText(f"Repair failed: {error_msg}")
            self._summary_label.setStyleSheet(get_status_label_style('error'))
            self._run_btn.setEnabled(True)
            return

        repaired = sum(v.get('gaps_repaired', 0) for k, v in summary.items() if not k.startswith('_'))
        too_old = sum(v.get('gaps_too_old', 0) for k, v in summary.items() if not k.startswith('_'))
        bars = sum(v.get('bars_fetched', 0) for k, v in summary.items() if not k.startswith('_'))
        errors = [e for k, v in summary.items() if not k.startswith('_') for e in v.get('errors', [])]

        if errors:
            msg = (
                f"Repair completed with warnings: {repaired} gap(s) fixed, "
                f"{len(errors)} error(s) — re-verifying…"
            )
            self._summary_label.setStyleSheet(get_status_label_style('warning'))
        elif too_old > 0 and repaired == 0:
            msg = (
                f"All gaps are older than {_BINANCE_HORIZON_DAYS} days — "
                f"Binance cannot repair them (LakeAPI backfill needed) — re-verifying…"
            )
            self._summary_label.setStyleSheet(get_status_label_style('warning'))
        elif too_old > 0:
            msg = (
                f"Repair done: {repaired} gap(s) fixed ({bars} bars), "
                f"{too_old} gap(s) still need LakeAPI backfill — re-verifying…"
            )
            self._summary_label.setStyleSheet(get_status_label_style('warning'))
        else:
            msg = f"Repair done: {repaired} gap(s) fixed, {bars} bars fetched — re-verifying…"
            self._summary_label.setStyleSheet(get_status_label_style('success'))

        self._summary_label.setText(msg)
        self._start_verification()

    # ------------------------------------------------------------------
    # Shared helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _format_utc_now() -> str:
        """Return a human-readable current UTC time string for display in the header."""
        return "Current UTC time: " + datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')

    def _on_progress(self, current: int, total: int, message: str):
        self._progress_bar.setMaximum(total)
        self._progress_bar.setValue(current)
        self._progress_label.setText(message)

    def _show_progress(self, visible: bool, message: str = ""):
        self._progress_bar.setVisible(visible)
        self._progress_label.setVisible(visible)
        if visible:
            self._progress_label.setText(message)
            self._progress_bar.setValue(0)

    def _add_error_row(self, error_msg: str):
        self._table.setRowCount(1)
        item = QTableWidgetItem(error_msg)
        item.setTextAlignment(Qt.AlignLeft | Qt.AlignVCenter)
        item.setForeground(QColor(COLORS['error']))
        self._table.setItem(0, 5, item)

    # ------------------------------------------------------------------
    # Qt overrides
    # ------------------------------------------------------------------

    def showEvent(self, event):
        super().showEvent(event)
        from PyQt5.QtCore import QTimer
        QTimer.singleShot(200, lambda: apply_hand_cursor_to_buttons(self))
        self._restore_window_geometry(event)

    def closeEvent(self, event):
        for thread in (self._verify_thread, self._repair_thread):
            if thread and thread.isRunning():
                thread.quit()
                thread.wait(2000)
        self._save_window_geometry()
        super().closeEvent(event)
