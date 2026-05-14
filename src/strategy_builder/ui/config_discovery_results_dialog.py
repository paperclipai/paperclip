"""
Config Discovery Results Dialog — Phase 3 UI

Presents the output of a Config Discovery run in a sortable, filterable table.
Each row is one DiscoveryScenario with aggregated metrics.

Key features (Phase 3.1–3.5):
- Sortable columns: Total PnL, Win Rate, Sharpe, Trade Count, Avg PnL
- Filterable: min trade count slider, metric selector for primary sort
- "Apply Config" button: applies selected row's delta to BacktestConfigPanel
- Grading badges: gold / silver / bronze per ranking category
- Baseline row: current config preserved as BASELINE for comparison

Styling: all values come from src/strategy_builder/ui/styles.py.
No hardcoded hex, pixel, or font values in this file.

Author: UIEngineer (BTCAAAAA-149)
Date: 2026-05-04
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from PyQt5.QtCore import (
    Qt, QSortFilterProxyModel, QThread, pyqtSignal,
)
from PyQt5.QtGui import QStandardItem, QStandardItemModel
from PyQt5.QtWidgets import (
    QAbstractItemView, QComboBox, QDialog, QDialogButtonBox, QGroupBox,
    QHBoxLayout, QHeaderView, QLabel, QMessageBox, QProgressBar, QPushButton,
    QSlider, QSplitter, QTableView, QTableWidget, QTableWidgetItem,
    QTextEdit, QVBoxLayout, QWidget, QApplication,
)

from src.strategy_builder.ui.styles import (
    COLORS,
    create_font,
    create_monospace_font,
    get_color,
    get_groupbox_header_stylesheet,
    get_label_style,
    get_panel_title_stylesheet,
    get_primary_button_stylesheet,
    get_secondary_button_stylesheet,
    get_success_button_stylesheet,
    get_table_view_stylesheet,
    get_text_edit_stylesheet,
    MAIN_STYLESHEET,
    WindowGeometryMixin,
)
from src.strategy_builder.ui.config_permutation_engine import DiscoveryResult


# ---------------------------------------------------------------------------
# Column definitions
# ---------------------------------------------------------------------------

# (column_index, header, tooltip, numeric)
COLUMNS = [
    (0,  'Rank',           'Overall rank by primary metric',          True),
    (1,  'Badge',          'Gold / Silver / Bronze award',            False),
    (2,  'Scenario',       'Parameter axis and value',                False),
    (3,  'Trades',         'Total trades executed',                   True),
    (4,  'Win Rate %',     'Percentage of winning trades',            True),
    (5,  'Total PnL $',    'Total realised profit/loss (USD)',        True),
    (6,  'Avg PnL $',      'Average PnL per trade (USD)',             True),
    (7,  'Sharpe',         'Sharpe ratio (annualised, per trade)',    True),
    (8,  'TP1',            'Exits via TP1',                           True),
    (9,  'TP2',            'Exits via TP2',                           True),
    (10, 'TP3',            'Exits via TP3',                           True),
    (11, 'SL',             'Exits via Stop Loss',                     True),
    (12, 'Time',           'Exits via Max Bars Held',                 True),
    (13, 'Avg Bars',       'Average bars held per trade',             True),
    (14, 'Max DD $',       'Maximum peak-to-trough drawdown (USD)',   True),
    (15, 'Type',           'Baseline or discovery scenario',          False),
]

COL_RANK      = 0
COL_BADGE     = 1
COL_SCENARIO  = 2
COL_TRADES    = 3
COL_WINRATE   = 4
COL_PNL       = 5
COL_AVG_PNL   = 6
COL_SHARPE    = 7
COL_TP1       = 8
COL_TP2       = 9
COL_TP3       = 10
COL_SL        = 11
COL_TIME      = 12
COL_AVG_BARS  = 13
COL_MAXDD     = 14
COL_TYPE      = 15


# ---------------------------------------------------------------------------
# Badge helpers
# ---------------------------------------------------------------------------

# Maps badge tier → display text (no inline styles — badge colours handled
# by cell foreground set via Qt.ForegroundRole)
_BADGE_TEXT = {
    'gold':   '★ Gold',
    'silver': '☆ Silver',
    'bronze': '▲ Bronze',
    'none':   '',
}

_BADGE_COLORS = {
    'gold':   COLORS['warning'],     # FFA500
    'silver': COLORS['text_muted'],  # 9AA0A6
    'bronze': COLORS['orange'],      # a25c51
    'none':   COLORS['text_muted'],
}


def assign_badges(results: List[DiscoveryResult]) -> Dict[str, Dict[str, str]]:
    """
    Compute gold/silver/bronze badges for three ranking categories:
      - most_profitable (highest total_pnl)
      - most_frequent   (highest trade_count)
      - best_sharpe     (highest sharpe_ratio)

    Only scenarios with total_pnl > 0 are eligible for any badge tier.
    A money-losing scenario receives no badge regardless of trade count or Sharpe.

    Returns:
        {scenario_id: {'most_profitable': 'gold'|'silver'|'bronze'|'none', ...}}
    """
    badges: Dict[str, Dict[str, str]] = {
        r.scenario_id: {'most_profitable': 'none', 'most_frequent': 'none', 'best_sharpe': 'none'}
        for r in results
    }

    def rank_category(key: str, attr: str, require_positive_pnl: bool = True):
        candidates = [r for r in results if r.total_pnl > 0] if require_positive_pnl else results
        sorted_ids = [
            r.scenario_id
            for r in sorted(candidates, key=lambda r: getattr(r, attr), reverse=True)
        ]
        for tier, sid in zip(['gold', 'silver', 'bronze'], sorted_ids[:3]):
            badges[sid][key] = tier

    rank_category('most_profitable', 'total_pnl', require_positive_pnl=True)
    rank_category('most_frequent', 'trade_count', require_positive_pnl=True)
    rank_category('best_sharpe', 'sharpe_ratio', require_positive_pnl=True)

    return badges


def _badge_summary(badge_dict: Dict[str, str]) -> str:
    """Produce a single compact badge summary string, e.g. '★ Gold (Sharpe)'."""
    priority = [
        ('most_profitable', 'PnL'),
        ('best_sharpe', 'Sharpe'),
        ('most_frequent', 'Freq'),
    ]
    for key, label in priority:
        tier = badge_dict.get(key, 'none')
        if tier != 'none':
            return f"{_BADGE_TEXT[tier]} ({label})"
    return ''


def _badge_color(badge_dict: Dict[str, str]) -> str:
    """Return the hex colour for the best badge this scenario holds."""
    priority = ['gold', 'silver', 'bronze']
    all_tiers = list(badge_dict.values())
    for tier in priority:
        if tier in all_tiers:
            return _BADGE_COLORS[tier]
    return _BADGE_COLORS['none']


# ---------------------------------------------------------------------------
# Table model
# ---------------------------------------------------------------------------

class DiscoveryTableModel(QStandardItemModel):
    """
    QStandardItemModel populated from a list of DiscoveryResult objects.

    Baseline row (if provided) is prepended with type='BASELINE'.
    """

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setHorizontalHeaderLabels([c[1] for c in COLUMNS])
        self._results: List[DiscoveryResult] = []
        self._badges: Dict[str, Dict[str, str]] = {}

    def load_results(
        self,
        results: List[DiscoveryResult],
        baseline: Optional[DiscoveryResult] = None,
    ):
        """Populate the model. Baseline row, if supplied, is prepended."""
        self.removeRows(0, self.rowCount())

        all_results = ([baseline] if baseline else []) + list(results)
        self._results = all_results
        self._badges = assign_badges([r for r in all_results if r.scenario_id != 'BASELINE'])

        # Rank by total_pnl for the rank column
        ranked = sorted(
            [r for r in all_results if r.scenario_id != 'BASELINE'],
            key=lambda r: r.total_pnl,
            reverse=True,
        )
        rank_map = {r.scenario_id: i + 1 for i, r in enumerate(ranked)}

        for result in all_results:
            is_baseline = result.scenario_id == 'BASELINE'
            badge_dict = self._badges.get(result.scenario_id, {})

            rank = 0 if is_baseline else rank_map.get(result.scenario_id, 0)
            badge_text = 'BASELINE' if is_baseline else _badge_summary(badge_dict)
            badge_color = COLORS['info'] if is_baseline else _badge_color(badge_dict)

            def _num(v: float) -> QStandardItem:
                item = QStandardItem()
                item.setData(round(v, 4), Qt.UserRole)
                item.setText(f'{v:.2f}')
                item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
                item.setEditable(False)
                return item

            def _int_item(v: int) -> QStandardItem:
                item = QStandardItem()
                item.setData(v, Qt.UserRole)
                item.setText(str(v))
                item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
                item.setEditable(False)
                return item

            def _str_item(s: str, color: Optional[str] = None) -> QStandardItem:
                item = QStandardItem(s)
                item.setTextAlignment(Qt.AlignLeft | Qt.AlignVCenter)
                item.setEditable(False)
                if color:
                    from PyQt5.QtGui import QColor
                    item.setForeground(QColor(color))
                return item

            rank_item = _int_item(rank)
            badge_item = _str_item(badge_text, badge_color)
            scenario_item = _str_item(result.description)
            if is_baseline:
                from PyQt5.QtGui import QColor
                scenario_item.setForeground(QColor(COLORS['info']))
            elif result.error:
                scenario_item.setForeground(QColor(COLORS['error']))
                scenario_item.setText(f"ERROR: {result.description}")

            pnl_item = _num(result.total_pnl)
            # Color PnL: green if positive, red if negative
            from PyQt5.QtGui import QColor as _QC
            pnl_item.setForeground(
                _QC(COLORS['success']) if result.total_pnl >= 0 else _QC(COLORS['error'])
            )

            avg_pnl_item = _num(result.avg_pnl_per_trade)
            avg_pnl_item.setForeground(
                _QC(COLORS['success']) if result.avg_pnl_per_trade >= 0 else _QC(COLORS['error'])
            )

            row = [
                rank_item,
                badge_item,
                scenario_item,
                _int_item(result.trade_count),
                _num(result.win_rate),
                pnl_item,
                avg_pnl_item,
                _num(result.sharpe_ratio),
                _int_item(result.exit_tp1),
                _int_item(result.exit_tp2),
                _int_item(result.exit_tp3),
                _int_item(result.exit_sl),
                _int_item(result.exit_time),
                _num(result.avg_bars_held),
                _num(result.max_drawdown),
                _str_item('BASELINE' if is_baseline else 'DISCOVERY'),
            ]
            self.appendRow(row)

    def get_result(self, row: int) -> Optional[DiscoveryResult]:
        """Return the DiscoveryResult for the given model row."""
        if 0 <= row < len(self._results):
            return self._results[row]
        return None


# ---------------------------------------------------------------------------
# Numeric sort proxy
# ---------------------------------------------------------------------------

class NumericSortProxyModel(QSortFilterProxyModel):
    """
    Proxy that sorts numeric columns by Qt.UserRole (float/int) value
    rather than the display text, and filters rows by a minimum trade-count
    threshold.

    Set ``min_trades`` before calling ``invalidateFilter()`` to activate the
    row filter.  A value of 0 (the default) accepts all rows.
    """

    def __init__(self, parent=None):
        super().__init__(parent)
        self.min_trades: int = 0

    def lessThan(self, left, right):
        left_data = left.data(Qt.UserRole)
        right_data = right.data(Qt.UserRole)
        if left_data is not None and right_data is not None:
            try:
                return float(left_data) < float(right_data)
            except (TypeError, ValueError):
                pass
        return super().lessThan(left, right)

    def filterAcceptsRow(self, source_row: int, source_parent) -> bool:
        """
        Qt virtual override — called by Qt on every row whenever
        invalidateFilter() is triggered.

        Excludes rows where the Trades column value is below ``min_trades``.
        A ``min_trades`` of 0 accepts all rows unconditionally.
        """
        if self.min_trades == 0:
            return True
        source_model = self.sourceModel()
        if source_model is None:
            return True
        # Qt passes a valid QModelIndex as source_parent; guard against None
        # for test-harness calls that pass None directly.
        from PyQt5.QtCore import QModelIndex
        parent_idx = source_parent if source_parent is not None else QModelIndex()
        idx = source_model.index(source_row, COL_TRADES, parent_idx)
        val = source_model.data(idx, Qt.UserRole)
        try:
            return int(val) >= self.min_trades
        except (TypeError, ValueError):
            return True


# ---------------------------------------------------------------------------
# Summary panel
# ---------------------------------------------------------------------------

def _build_summary_text(
    results: List[DiscoveryResult],
    badges: Dict[str, Dict[str, str]],
) -> str:
    """Build plain-text summary for the detail pane."""
    if not results:
        return "No results yet."

    non_baseline = [r for r in results if r.scenario_id != 'BASELINE' and not r.error]
    if not non_baseline:
        return "All scenarios errored."

    best_pnl = max(non_baseline, key=lambda r: r.total_pnl)
    best_sharpe = max(non_baseline, key=lambda r: r.sharpe_ratio)
    best_freq = max(non_baseline, key=lambda r: r.trade_count)

    lines = [
        "=== DISCOVERY SUMMARY ===",
        f"Scenarios run:   {len(non_baseline)}",
        f"Errored:         {sum(1 for r in results if r.error)}",
        "",
        "=== GOLD WINNERS ===",
        f"Most Profitable: {best_pnl.description}",
        f"  Total PnL: ${best_pnl.total_pnl:.2f}  Win Rate: {best_pnl.win_rate:.1f}%  Trades: {best_pnl.trade_count}",
        "",
        f"Best Sharpe:     {best_sharpe.description}",
        f"  Sharpe: {best_sharpe.sharpe_ratio:.3f}  Total PnL: ${best_sharpe.total_pnl:.2f}  Trades: {best_sharpe.trade_count}",
        "",
        f"Most Frequent:   {best_freq.description}",
        f"  Trades: {best_freq.trade_count}  Win Rate: {best_freq.win_rate:.1f}%  Total PnL: ${best_freq.total_pnl:.2f}",
    ]
    return '\n'.join(lines)


# ---------------------------------------------------------------------------
# Apply Config confirmation dialog
# ---------------------------------------------------------------------------

def _flatten_dict(d: dict, prefix: str = '') -> list:
    """
    Flatten a nested dict into a list of (key_path, display_value) tuples.
    Nested keys are joined with '.'.  Python True/False → Yes/No.
    """
    rows = []
    for k, v in d.items():
        full_key = f"{prefix}{k}" if prefix else k
        if isinstance(v, dict):
            rows.extend(_flatten_dict(v, prefix=f"{full_key}."))
        else:
            if isinstance(v, bool):
                display = "Yes" if v else "No"
            elif isinstance(v, float):
                display = f"{v:g}"
            else:
                display = str(v)
            rows.append((full_key, display))
    return rows


class _ApplyConfigDialog(QDialog):
    """
    Custom styled confirmation dialog for Apply Config.

    Shows:
    - Scenario description header
    - Table of flattened key → value changes
    - Apply / Cancel buttons (primary / secondary styling)
    """

    def __init__(
        self,
        scenario_description: str,
        config_delta: dict,
        parent: Optional[QWidget] = None,
    ):
        super().__init__(parent)
        self.setWindowTitle("Apply Config")
        self.setModal(True)
        self.setMinimumWidth(520)
        self.setMinimumHeight(400)
        self.resize(760, 560)
        self.setSizeGripEnabled(True)
        self.setStyleSheet(MAIN_STYLESHEET)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 12)
        layout.setSpacing(10)

        # Header
        header = QLabel("Apply scenario:")
        header.setStyleSheet(get_label_style('muted'))
        header.setFont(create_font(9))
        layout.addWidget(header)

        desc_label = QLabel(scenario_description)
        desc_label.setFont(create_font(11, bold=True))
        desc_label.setWordWrap(True)
        layout.addWidget(desc_label)

        # Changes label
        changes_label = QLabel("Changes to apply:")
        changes_label.setStyleSheet(get_label_style('muted'))
        changes_label.setFont(create_font(9))
        layout.addWidget(changes_label)

        # Table of changes
        rows = _flatten_dict(config_delta)
        table = QTableWidget(len(rows), 2, self)
        table.setHorizontalHeaderLabels(["Parameter", "Value"])
        table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        table.setSelectionMode(QAbstractItemView.NoSelection)
        table.setAlternatingRowColors(True)
        table.setFont(create_monospace_font(9))
        table.horizontalHeader().setFont(create_font(9, bold=True))
        table.verticalHeader().setVisible(False)
        table.setStyleSheet(get_table_view_stylesheet())
        table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeToContents)
        table.horizontalHeader().setSectionResizeMode(1, QHeaderView.Stretch)

        for i, (key, val) in enumerate(rows):
            key_item = QTableWidgetItem(key)
            key_item.setFont(create_monospace_font(9))
            val_item = QTableWidgetItem(val)
            val_item.setFont(create_monospace_font(9))
            val_item.setTextAlignment(Qt.AlignLeft | Qt.AlignVCenter)
            val_item.setToolTip(val)
            table.setItem(i, 0, key_item)
            table.setItem(i, 1, val_item)

        table.resizeRowsToContents()
        layout.addWidget(table)

        # Buttons
        btn_box = QHBoxLayout()
        btn_box.addStretch()

        apply_btn = QPushButton("Apply")
        apply_btn.setDefault(True)
        apply_btn.setStyleSheet(get_primary_button_stylesheet())
        apply_btn.clicked.connect(self.accept)
        btn_box.addWidget(apply_btn)

        cancel_btn = QPushButton("Cancel")
        cancel_btn.setStyleSheet(get_secondary_button_stylesheet())
        cancel_btn.clicked.connect(self.reject)
        btn_box.addWidget(cancel_btn)

        layout.addLayout(btn_box)


# ---------------------------------------------------------------------------
# Main dialog
# ---------------------------------------------------------------------------

class ConfigDiscoveryResultsDialog(WindowGeometryMixin, QDialog):
    """
    Phase 3 Results Window.

    Shows all DiscoveryResult rows in a sortable table with:
    - Column sorting on click
    - Min-trades filter slider
    - Primary metric selector (for re-ranking)
    - "Apply Config" button
    - Gold/Silver/Bronze badges
    - Baseline row for comparison
    - Live result streaming (rows added as each scenario completes)

    Signals:
        config_applied(dict)  — emitted when user clicks Apply Config;
                                payload is the config_delta to merge into
                                BacktestConfigPanel.
    """

    config_applied = pyqtSignal(dict)

    GEOMETRY_SETTINGS_KEY = "configDiscoveryDialog"
    GEOMETRY_DEFAULT_SIZE = (1200, 800)

    def __init__(
        self,
        apply_config_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
        parent: Optional[QWidget] = None,
    ):
        super().__init__(parent)
        self._apply_callback = apply_config_callback
        self._results: List[DiscoveryResult] = []
        self._baseline: Optional[DiscoveryResult] = None
        self._worker: Optional[QThread] = None

        self.setWindowTitle("Config Discovery Results")
        self.setMinimumSize(900, 600)
        self.setModal(False)
        # Qt.Window flag required for maximize to work on all platforms —
        # QDialog defaults to Qt.Dialog which may suppress the maximize button.
        # WindowMaximizeButtonHint / WindowMinimizeButtonHint are added
        # explicitly for platforms (e.g. some Linux WMs) that do not
        # infer them from Qt.Window alone.
        self.setWindowFlags(
            Qt.Window |
            Qt.WindowMaximizeButtonHint |
            Qt.WindowMinimizeButtonHint |
            Qt.WindowCloseButtonHint
        )

        # Apply global dark stylesheet
        self.setStyleSheet(MAIN_STYLESHEET)

        self._build_ui()
        # Geometry/maximized state is handled in showEvent

    # ------------------------------------------------------------------
    # UI construction
    # ------------------------------------------------------------------

    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(12, 12, 12, 12)
        root.setSpacing(8)

        # Title bar
        title_row = QHBoxLayout()
        title = QLabel("Config Discovery Results")
        title.setStyleSheet(get_panel_title_stylesheet())
        title.setFont(create_font(13, bold=True))
        title_row.addWidget(title)
        title_row.addStretch()

        self._status_label = QLabel("Ready")
        self._status_label.setStyleSheet(get_label_style('muted'))
        self._status_label.setFont(create_font(9))
        title_row.addWidget(self._status_label)
        root.addLayout(title_row)

        # Progress bar (hidden until discovery running)
        self._progress_bar = QProgressBar()
        self._progress_bar.setRange(0, 100)
        self._progress_bar.setValue(0)
        self._progress_bar.setVisible(False)
        self._progress_bar.setMaximumHeight(6)
        root.addWidget(self._progress_bar)

        # Controls bar
        controls = self._build_controls()
        root.addWidget(controls)

        # Splitter: table on top, summary on bottom
        splitter = QSplitter(Qt.Vertical)

        # Table
        self._table_model = DiscoveryTableModel(self)
        self._proxy = NumericSortProxyModel(self)
        self._proxy.setSourceModel(self._table_model)
        self._proxy.setFilterKeyColumn(-1)

        self._table = QTableView()
        self._table.setModel(self._proxy)
        self._table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self._table.setSelectionMode(QAbstractItemView.SingleSelection)
        self._table.setSortingEnabled(True)
        self._table.setAlternatingRowColors(True)
        self._table.verticalHeader().setVisible(False)
        # Column sizing: Scenario column stretches to fill; others resize to content
        header = self._table.horizontalHeader()
        header.setStretchLastSection(False)
        header.setSectionResizeMode(QHeaderView.ResizeToContents)
        header.setSectionResizeMode(COL_SCENARIO, QHeaderView.Stretch)
        header.setMinimumSectionSize(50)
        self._table.setStyleSheet(get_table_view_stylesheet())
        self._table.selectionModel().selectionChanged.connect(self._on_selection_changed)
        splitter.addWidget(self._table)

        # Summary text pane
        summary_group = QGroupBox("Detail / Summary")
        summary_group.setStyleSheet(get_groupbox_header_stylesheet())
        summary_layout = QVBoxLayout(summary_group)
        self._summary_text = QTextEdit()
        self._summary_text.setReadOnly(True)
        # 11pt: stylesheet font-size takes precedence over setFont(); pass size directly
        self._summary_text.setStyleSheet(get_text_edit_stylesheet(font_size_pt=11))
        summary_layout.addWidget(self._summary_text)
        splitter.addWidget(summary_group)

        splitter.setSizes([600, 300])
        root.addWidget(splitter, 1)

        # Action buttons
        btn_row = QHBoxLayout()
        btn_row.addStretch()

        self._apply_btn = QPushButton("Apply Config to Panel")
        self._apply_btn.setStyleSheet(get_primary_button_stylesheet())
        self._apply_btn.setEnabled(False)
        self._apply_btn.setToolTip("Apply selected scenario's config delta to BacktestConfigPanel")
        self._apply_btn.clicked.connect(self._on_apply_clicked)
        btn_row.addWidget(self._apply_btn)

        self._export_btn = QPushButton("Export CSV")
        self._export_btn.setStyleSheet(get_secondary_button_stylesheet())
        self._export_btn.setEnabled(False)
        self._export_btn.clicked.connect(self._on_export_csv)
        btn_row.addWidget(self._export_btn)

        close_btn = QPushButton("Close")
        close_btn.setStyleSheet(get_secondary_button_stylesheet())
        close_btn.clicked.connect(self.close)
        btn_row.addWidget(close_btn)

        root.addLayout(btn_row)

    def _build_controls(self) -> QWidget:
        """Build the filter / sort controls bar."""
        group = QGroupBox("Filters")
        group.setStyleSheet(get_groupbox_header_stylesheet())
        layout = QHBoxLayout(group)
        layout.setContentsMargins(8, 8, 8, 8)
        layout.setSpacing(12)

        # Min trades filter
        min_trades_label = QLabel("Min Trades:")
        min_trades_label.setStyleSheet(get_label_style('muted'))
        min_trades_label.setFont(create_font(9))
        layout.addWidget(min_trades_label)

        self._min_trades_slider = QSlider(Qt.Horizontal)
        self._min_trades_slider.setRange(0, 100)
        self._min_trades_slider.setValue(0)
        self._min_trades_slider.setMaximumWidth(150)
        self._min_trades_slider.valueChanged.connect(self._apply_filter)
        layout.addWidget(self._min_trades_slider)

        self._min_trades_value_label = QLabel("0")
        self._min_trades_value_label.setStyleSheet(get_label_style('muted'))
        self._min_trades_value_label.setFont(create_font(9))
        self._min_trades_value_label.setMinimumWidth(28)
        layout.addWidget(self._min_trades_value_label)

        layout.addSpacing(16)

        # Primary sort metric
        sort_label = QLabel("Sort By:")
        sort_label.setStyleSheet(get_label_style('muted'))
        sort_label.setFont(create_font(9))
        layout.addWidget(sort_label)

        self._sort_combo = QComboBox()
        self._sort_combo.addItems([
            'Total PnL $',
            'Win Rate %',
            'Sharpe',
            'Trade Count',
            'Avg PnL $',
        ])
        self._sort_combo.currentIndexChanged.connect(self._apply_sort)
        layout.addWidget(self._sort_combo)

        layout.addStretch()
        return group

    # ------------------------------------------------------------------
    # Public API — called by BacktestConfigPanel
    # ------------------------------------------------------------------

    def set_baseline(self, baseline: DiscoveryResult):
        """
        Set the baseline result (current config before discovery).
        Must be called before or during set_results().
        """
        baseline.scenario_id = 'BASELINE'
        baseline.description = f"[BASELINE] Current config"
        self._baseline = baseline

    def set_results(self, results: List[DiscoveryResult]):
        """Replace all results and refresh the table."""
        self._results = list(results)
        self._refresh_table()
        self._export_btn.setEnabled(bool(results))

    def append_result(self, result: DiscoveryResult):
        """
        Append a single result (live streaming as each scenario finishes).
        Called from ConfigPermutationWorker.scenario_complete signal handler.
        """
        self._results.append(result)
        self._refresh_table()
        self._export_btn.setEnabled(True)

    def set_progress(self, current: int, total: int, message: str = ''):
        """Update the progress bar (0–100 based on current/total)."""
        self._progress_bar.setVisible(True)
        if total == 1 and current == 0:
            # Indeterminate: bar loading phase
            self._progress_bar.setRange(0, 0)  # indeterminate spinner
        else:
            self._progress_bar.setRange(0, 100)
            if total > 0:
                pct = int((current / total) * 100)
                self._progress_bar.setValue(pct)
        self._status_label.setText(message or f"{current}/{total}")
        if current >= total and total > 1:
            self._progress_bar.setRange(0, 100)
            self._progress_bar.setValue(100)
            self._progress_bar.setVisible(False)
            self._status_label.setText(f"Complete — {len(self._results)} scenarios")

    def set_worker(self, worker: QThread):
        """Store reference to the running worker for cancel support."""
        self._worker = worker

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _refresh_table(self):
        """Reload the table model from current results."""
        self._table_model.load_results(self._results, self._baseline)
        self._apply_filter()
        self._apply_sort()
        # Update summary
        all_results = ([self._baseline] if self._baseline else []) + self._results
        badges = assign_badges([r for r in all_results if r.scenario_id != 'BASELINE'])
        self._summary_text.setPlainText(
            _build_summary_text(self._results, badges)
        )

    def _apply_filter(self):
        """Apply min-trades filter to the proxy model."""
        min_trades = self._min_trades_slider.value()
        self._min_trades_value_label.setText(str(min_trades))
        # Push the threshold onto the proxy so filterAcceptsRow() can read it,
        # then invalidate so Qt re-evaluates every row via the proxy's override.
        self._proxy.min_trades = min_trades
        self._proxy.invalidateFilter()

    def _apply_sort(self):
        """Sort the table by the selected primary metric."""
        col_map = {
            'Total PnL $':   COL_PNL,
            'Win Rate %':    COL_WINRATE,
            'Sharpe':        COL_SHARPE,
            'Trade Count':   COL_TRADES,
            'Avg PnL $':     COL_AVG_PNL,
        }
        label = self._sort_combo.currentText()
        col = col_map.get(label, COL_PNL)
        self._proxy.sort(col, Qt.DescendingOrder)

    def _on_selection_changed(self):
        """Enable Apply Config button when a non-baseline row is selected."""
        indexes = self._table.selectionModel().selectedRows()
        if not indexes:
            self._apply_btn.setEnabled(False)
            return

        proxy_row = indexes[0].row()
        source_row = self._proxy.mapToSource(indexes[0]).row()
        result = self._table_model.get_result(source_row)

        is_baseline = result and result.scenario_id == 'BASELINE'
        has_error = result and bool(result.error)
        self._apply_btn.setEnabled(bool(result) and not is_baseline and not has_error)

        # Update detail pane with selected result
        if result:
            self._show_result_detail(result)

    def _show_result_detail(self, result: DiscoveryResult):
        """Show per-scenario detail in the summary text pane."""
        if result.error:
            self._summary_text.setPlainText(f"ERROR in {result.description}:\n{result.error}")
            return

        lines = [
            f"=== {result.scenario_id}: {result.description} ===",
            "",
            f"Trades:        {result.trade_count}",
            f"Win Rate:      {result.win_rate:.1f}%",
            f"Total PnL:     ${result.total_pnl:.2f}",
            f"Avg PnL/Trade: ${result.avg_pnl_per_trade:.2f}",
            f"Sharpe Ratio:  {result.sharpe_ratio:.3f}",
            f"Avg Bars Held: {result.avg_bars_held:.1f}",
            f"Max Drawdown:  ${result.max_drawdown:.2f}",
            "",
            "Exit Distribution:",
            f"  TP1: {result.exit_tp1}  TP2: {result.exit_tp2}  TP3: {result.exit_tp3}",
            f"  SL:  {result.exit_sl}   Time: {result.exit_time}",
            "",
            "Config Delta (applied to base config):",
        ]
        for k, v in result.config_delta.items():
            lines.append(f"  {k}: {v}")

        self._summary_text.setPlainText('\n'.join(lines))

    def _on_apply_clicked(self):
        """Apply the selected scenario's config_delta to the strategy panel."""
        indexes = self._table.selectionModel().selectedRows()
        if not indexes:
            return

        source_row = self._proxy.mapToSource(indexes[0]).row()
        result = self._table_model.get_result(source_row)
        if not result or result.scenario_id == 'BASELINE' or result.error:
            return

        # Confirm with a styled human-readable dialog (not raw Python dict)
        dlg = _ApplyConfigDialog(
            scenario_description=result.description,
            config_delta=result.config_delta,
            parent=self,
        )
        if dlg.exec_() != QDialog.Accepted:
            return

        # Emit and call callback
        self.config_applied.emit(result.config_delta)
        if self._apply_callback:
            self._apply_callback(result.config_delta)

        self._status_label.setText(f"Applied: {result.description}")

    def _on_export_csv(self):
        """Export all results to a CSV file."""
        from pathlib import Path
        from datetime import datetime
        import csv

        report_dir = Path('tests/integration/results')
        report_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        out_path = report_dir / f'discovery_results_{ts}.csv'

        all_results = ([self._baseline] if self._baseline else []) + self._results

        with open(out_path, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerow([
                'scenario_id', 'description', 'type',
                'trade_count', 'win_rate', 'total_pnl', 'avg_pnl_per_trade',
                'sharpe_ratio', 'exit_tp1', 'exit_tp2', 'exit_tp3',
                'exit_sl', 'exit_time', 'avg_bars_held', 'max_drawdown',
            ])
            for r in all_results:
                writer.writerow([
                    r.scenario_id,
                    r.description,
                    'BASELINE' if r.scenario_id == 'BASELINE' else 'DISCOVERY',
                    r.trade_count, f'{r.win_rate:.2f}',
                    f'{r.total_pnl:.2f}', f'{r.avg_pnl_per_trade:.2f}',
                    f'{r.sharpe_ratio:.3f}',
                    r.exit_tp1, r.exit_tp2, r.exit_tp3,
                    r.exit_sl, r.exit_time,
                    f'{r.avg_bars_held:.1f}', f'{r.max_drawdown:.2f}',
                ])

        QMessageBox.information(
            self,
            "Export Complete",
            f"Discovery results exported to:\n{out_path}",
        )
        self._status_label.setText(f"Exported to {out_path.name}")

    # ------------------------------------------------------------------
    # Geometry persistence
    # ------------------------------------------------------------------

    def showEvent(self, event):
        """Restore saved window geometry, or default to maximized on first run."""
        super().showEvent(event)
        self._restore_window_geometry(event)

    def closeEvent(self, event):
        """Save window geometry on close."""
        self._save_window_geometry()
        super().closeEvent(event)
