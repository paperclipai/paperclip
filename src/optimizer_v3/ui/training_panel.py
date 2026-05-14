"""
TrainingPanelUI — Signal Calibration Widget (preserved, not in main dialog)
============================================================================

## Current status (as of BTCAAAAA-338)

``TrainingPanelUI`` is **no longer instantiated inside the BacktestConfigDialog**.
The dedicated "⚙️ Calibrate" tab that previously existed as tab index 1 in that
dialog has been removed.

Calibration is now performed **automatically** inside ``BacktestConfigPanel``
via ``_run_auto_calibration()`` each time the user clicks "▶️ Run Test".  The
auto-calibration uses fixed parameters (15m timeframe, 180-day lookback,
production mode, all strategy blocks) and applies the results directly to the
backtest config before execution.  No user action or tab navigation is required.

This module is preserved for:
- Potential future use as a standalone calibration tool or developer utility.
- The ``TrainingThread`` integration it demonstrates.

## Original purpose (Sprint 2.1)

Provided a forward-looking signal analysis UI with:
- Block selection from BlockRegistry
- Testing/Production mode selection
- Configurable analysis period
- Multi-timeframe analysis via inline QCheckBox controls
- Resource estimation, progress tracking, and results export
"""

import logging
import sys
from pathlib import Path
from typing import Dict, List, Optional
from decimal import Decimal
from datetime import datetime, timedelta

from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QGroupBox, QFormLayout,
    QCheckBox, QComboBox, QSpinBox, QLabel, QPushButton,
    QMessageBox, QProgressBar, QTextEdit
)
from PyQt5.QtCore import Qt, pyqtSignal

# Import centralized styles
project_root = Path(__file__).parent.parent.parent.parent
sys.path.insert(0, str(project_root))
from src.strategy_builder.ui.styles import (
    get_primary_button_stylesheet,
    get_secondary_button_stylesheet,
    get_groupbox_header_stylesheet,
    get_panel_title_stylesheet,
    get_text_edit_stylesheet,
    get_color,
    create_font
)

# Import configuration
from src.optimizer_v3.config.training_config import get_training_config
from src.optimizer_v3.database import calibration_cache

logger = logging.getLogger(__name__)


class TrainingPanelUI(QWidget):
    """
    Signal Calibration widget (standalone — not embedded in BacktestConfigDialog).

    As of BTCAAAAA-338, calibration runs automatically via
    ``BacktestConfigPanel._run_auto_calibration()`` when the user clicks
    "▶️ Run Test".  This class is preserved for potential future use as a
    developer/standalone calibration tool.

    Original features:
    - Block selection from BlockRegistry
    - Testing/Production mode selection
    - Configurable analysis period
    - Multi-timeframe analysis via inline QCheckBox controls
    - Resource estimation, progress tracking, and results export
    """
    
    # Signals
    training_started = pyqtSignal(dict)  # Emits training config
    training_stopped = pyqtSignal()
    
    def __init__(self, orchestrator=None, parent=None):
        super().__init__(parent)
        
        # Store orchestrator reference to access strategy
        self.orchestrator = orchestrator
        
        # Load configuration
        self.config = get_training_config()
        
        # Training state
        self.training_running = False
        self.selected_blocks = []
        self.selected_timeframes = []
        
        # Training worker
        self.training_thread = None

        # Timeframe checkboxes (inline, replaces QListWidget)
        self.timeframe_checkboxes = {}

        # Calibration cache — shared with BacktestConfigPanel via disk store
        self._calibration_fingerprint: Optional[str] = None
        self._calibration_cache: Optional[dict] = None
        self._calibration_cache_from_disk: bool = False
        self._pending_fingerprint: Optional[str] = None  # fingerprint in-flight during TrainingThread
        _fp, _dm = calibration_cache.load_cache()
        if _fp is not None:
            self._calibration_fingerprint = _fp
            self._calibration_cache = _dm
            self._calibration_cache_from_disk = True
            logger.info("Manual calibration: shared cache loaded from disk.")

        # Setup UI
        self._setup_ui()
    
    def _setup_ui(self):
        """Setup UI with zero hardcoded styles"""
        # Main layout - INCREASED SPACING for better readability
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)  # More padding around edges
        layout.setSpacing(16)  # More space between sections
        
        # Header (title + description)
        header = self._create_header()
        layout.addWidget(header)
        
        # Configuration section (Tasks 2.1.2-2.1.5)
        config_section = self._create_configuration_section()
        layout.addWidget(config_section)
        
        # Progress section (Task 2.1.21)
        progress_section = self._create_progress_section()
        layout.addWidget(progress_section)
        
        # Results section (Task 2.1.22)
        results_section = self._create_results_section()
        layout.addWidget(results_section, stretch=1)
        
        # Action buttons
        action_section = self._create_action_section()
        layout.addWidget(action_section)
    
    def _create_header(self) -> QWidget:
        """Create header with title and explanatory description"""
        header_widget = QWidget()
        header_layout = QVBoxLayout(header_widget)
        header_layout.setContentsMargins(4, 4, 4, 8)
        header_layout.setSpacing(8)

        # Title row
        title_row = QHBoxLayout()
        title = QLabel("⚙️ Signal Calibration")
        title.setFont(create_font(12, bold=True))
        title.setStyleSheet(get_panel_title_stylesheet())
        title_row.addWidget(title)
        title_row.addStretch()
        header_layout.addLayout(title_row)

        # Explanatory description
        description = QLabel(
            "What this does: Each building block signal has a timing window — a period after "
            "the signal fires during which the engine should wait before re-evaluating it. If "
            "this delay is too short, the engine takes noise re-entries; too long, and it misses "
            "valid ones. This panel analyses your historical bar data to calculate the statistically "
            "optimal re-evaluation delay for each selected block on each selected timeframe.\n\n"
            "How to use it: Select the building blocks you want to calibrate, choose your lookback "
            "period, select your timeframes, then click Start Calibration. Apply the resulting delay "
            "values to your strategy's RECHECK configuration before running your backtest."
        )
        description.setWordWrap(True)
        description.setFont(create_font(9))
        description.setStyleSheet(f"color: {get_color('text_muted')}; padding: 4px;")
        header_layout.addWidget(description)

        return header_widget
    
    def _create_configuration_section(self) -> QWidget:
        """
        Create configuration section
        
        REUSES: BacktestConfigurationPanel patterns
        - QGroupBox with QFormLayout
        - QCheckBox for block selection
        - QComboBox for mode selection
        - QSpinBox for period selection
        - inline QCheckBox controls for timeframe selection
        """
        config_group = QGroupBox("Calibration Configuration")
        config_group.setStyleSheet(get_groupbox_header_stylesheet())
        
        config_layout = QVBoxLayout()
        config_layout.setSpacing(12)  # Space between rows
        config_layout.setContentsMargins(16, 16, 16, 16)
        
        # Task 2.1.2: Block Selection
        block_section = self._create_block_selection()
        config_layout.addWidget(block_section)
        
        # ALL THREE CONFIG ITEMS IN ONE HORIZONTAL ROW
        single_row_layout = QHBoxLayout()
        single_row_layout.setSpacing(20)
        
        # Analysis Mode
        mode_label = QLabel("Analysis Mode:")
        mode_label.setFont(create_font(size=10))
        single_row_layout.addWidget(mode_label)
        
        self.mode_combo = QComboBox()
        self.mode_combo.addItems(['Testing Mode (Limited Data)', 'Production Mode (Full Data)'])
        self.mode_combo.setCurrentIndex(0)
        self.mode_combo.setStyleSheet(f"""
            QComboBox {{
                padding: 4px 8px;
                border: 1px solid {get_color('border')};
                border-radius: 3px;
                background-color: {get_color('bg_light')};
                min-height: 24px;
                color: {get_color('text_primary')};
            }}
            QComboBox:hover {{
                border-color: {get_color('border_focus')};
            }}
            QComboBox::drop-down {{
                border: none;
                width: 20px;
            }}
        """)
        self.mode_combo.setToolTip(
            "Testing Mode uses a subset of data for speed. "
            "Production Mode analyses the full lookback period."
        )
        single_row_layout.addWidget(self.mode_combo)
        
        # Separator
        single_row_layout.addSpacing(20)
        
        # Lookback Period
        period_label = QLabel("Lookback Period:")
        period_label.setFont(create_font(size=10))
        single_row_layout.addWidget(period_label)
        
        self.period_spin = QSpinBox()
        self.period_spin.setRange(7, 365)
        self.period_spin.setValue(self.config['training']['max_lookback'])
        self.period_spin.setSuffix(" days")
        self.period_spin.setStyleSheet(f"""
            QSpinBox {{
                padding: 4px 8px;
                border: 1px solid {get_color('border')};
                border-radius: 3px;
                background-color: {get_color('bg_light')};
                min-height: 24px;
                color: {get_color('text_primary')};
            }}
            QSpinBox:hover {{
                border-color: {get_color('border_focus')};
            }}
        """)
        self.period_spin.setToolTip(
            "Number of historical days to analyse. "
            "More days = more signal occurrences = higher confidence in results."
        )
        single_row_layout.addWidget(self.period_spin)
        
        # Separator
        single_row_layout.addSpacing(20)
        
        # Timeframes
        timeframe_label = QLabel("Timeframe(s):")
        timeframe_label.setFont(create_font(size=10))
        single_row_layout.addWidget(timeframe_label)
        
        timeframe_section = self._create_timeframe_selection()
        single_row_layout.addWidget(timeframe_section)
        
        single_row_layout.addStretch()
        config_layout.addLayout(single_row_layout)
        
        config_group.setLayout(config_layout)
        return config_group
    
    def _create_block_selection(self) -> QWidget:
        """
        Create block selection checkboxes - HORIZONTAL INLINE LAYOUT
        
        LOADS FROM STRATEGY: Gets blocks from current strategy configuration
        """
        block_widget = QWidget()
        main_layout = QVBoxLayout(block_widget)
        main_layout.setSpacing(12)  # More space between rows
        main_layout.setContentsMargins(0, 4, 0, 4)  # Add vertical padding
        
        # Load blocks from strategy configuration
        blocks = self._get_strategy_blocks()
        
        if not blocks:
            # Fallback if no strategy loaded
            no_blocks_label = QLabel("⚠️ No strategy loaded. Please add building blocks first.")
            no_blocks_label.setStyleSheet(f"color: {get_color('warning')};")
            main_layout.addWidget(no_blocks_label)
            self.block_checkboxes = []
            return block_widget
        
        # HORIZONTAL LAYOUT for checkboxes
        checkboxes_layout = QHBoxLayout()
        checkboxes_layout.setSpacing(20)
        
        self.block_checkboxes = []
        for block_name in blocks:
            checkbox = QCheckBox(block_name)
            checkbox.setFont(create_font(size=10))
            checkbox.setStyleSheet(f"""
                QCheckBox {{
                    spacing: 8px;
                    color: {get_color('text_primary')};
                }}
                QCheckBox::indicator {{
                    width: 18px;
                    height: 18px;
                    border: 2px solid {get_color('border')};
                    border-radius: 3px;
                    background-color: {get_color('bg_light')};
                }}
                QCheckBox::indicator:checked {{
                    background-color: {get_color('button_primary')};
                    border-color: {get_color('button_primary')};
                }}
                QCheckBox::indicator:hover {{
                    border-color: {get_color('button_primary')};
                }}
            """)
            checkbox.setToolTip("Select this block to calibrate its optimal signal re-evaluation delay")
            checkboxes_layout.addWidget(checkbox)
            self.block_checkboxes.append(checkbox)
        
        checkboxes_layout.addStretch()
        main_layout.addLayout(checkboxes_layout)
        
        # Select All / Deselect All buttons
        button_layout = QHBoxLayout()
        
        select_all_btn = QPushButton("Select All")
        select_all_btn.setStyleSheet(get_secondary_button_stylesheet())
        select_all_btn.setFixedHeight(36)
        select_all_btn.clicked.connect(lambda: self._toggle_all_blocks(True))
        button_layout.addWidget(select_all_btn)
        
        deselect_all_btn = QPushButton("Deselect All")
        deselect_all_btn.setStyleSheet(get_secondary_button_stylesheet())
        deselect_all_btn.setFixedHeight(36)
        deselect_all_btn.clicked.connect(lambda: self._toggle_all_blocks(False))
        button_layout.addWidget(deselect_all_btn)
        
        button_layout.addStretch()
        main_layout.addLayout(button_layout)
        
        return block_widget
    
    def _create_timeframe_selection(self) -> QWidget:
        """
        Create timeframe selection as 4 inline QCheckBox controls.

        Replaces the previous QListWidget multi-select.
        Default: 15m checked only.
        """
        timeframe_widget = QWidget()
        timeframe_layout = QHBoxLayout(timeframe_widget)
        timeframe_layout.setSpacing(12)
        timeframe_layout.setContentsMargins(0, 0, 0, 0)

        timeframes = ['5m', '15m', '1h', '4h']

        self.timeframe_checkboxes = {}
        for tf in timeframes:
            cb = QCheckBox(tf)
            cb.setChecked(tf == '15m')  # Default: only 15m selected
            cb.setFont(create_font(size=10))
            cb.setStyleSheet(f"""
                QCheckBox {{
                    spacing: 8px;
                    color: {get_color('text_primary')};
                    font-size: 10pt;
                }}
                QCheckBox::indicator {{
                    width: 16px;
                    height: 16px;
                    border: 2px solid {get_color('border')};
                    border-radius: 3px;
                    background-color: {get_color('bg_light')};
                }}
                QCheckBox::indicator:checked {{
                    background-color: {get_color('button_primary')};
                    border-color: {get_color('button_primary')};
                }}
                QCheckBox::indicator:hover {{
                    border-color: {get_color('border_focus')};
                }}
            """)
            cb.setToolTip(f"Include {tf} timeframe in calibration analysis")
            self.timeframe_checkboxes[tf] = cb
            timeframe_layout.addWidget(cb)

        timeframe_layout.addStretch()
        return timeframe_widget
    
    def _create_progress_section(self) -> QWidget:
        """
        Create progress tracking section
        
        Task 2.1.21: Progress tracking UI
        """
        progress_group = QGroupBox("Calibration Progress")
        progress_group.setStyleSheet(get_groupbox_header_stylesheet())
        
        progress_layout = QVBoxLayout()
        progress_layout.setSpacing(4)
        progress_layout.setContentsMargins(8, 12, 8, 8)
        
        # Status label
        self.status_label = QLabel("Status: Ready")
        self.status_label.setStyleSheet(f"color: {get_color('text_secondary')}; font-weight: bold;")
        progress_layout.addWidget(self.status_label)
        
        # Progress bar
        self.progress_bar = QProgressBar()
        self.progress_bar.setValue(0)
        self.progress_bar.setStyleSheet(f"""
            QProgressBar {{
                border: 2px solid {get_color('border')};
                border-radius: 5px;
                text-align: center;
                height: 24px;
                background-color: {get_color('bg_light')};
            }}
            QProgressBar::chunk {{
                background-color: {get_color('button_primary')};
                border-radius: 3px;
            }}
        """)
        progress_layout.addWidget(self.progress_bar)
        
        # ETA label
        self.eta_label = QLabel("ETA: Not started")
        self.eta_label.setStyleSheet(f"color: {get_color('text_muted')}; font-size: 9pt;")
        progress_layout.addWidget(self.eta_label)
        
        progress_group.setLayout(progress_layout)
        return progress_group
    
    def _create_results_section(self) -> QWidget:
        """
        Create results display section
        
        Task 2.1.22: Results display table
        (Full implementation will be in training_results_table.py)
        """
        results_group = QGroupBox("Calibration Results")
        results_group.setStyleSheet(get_groupbox_header_stylesheet())
        
        results_layout = QVBoxLayout()
        results_layout.setSpacing(4)
        results_layout.setContentsMargins(8, 12, 8, 8)
        
        # Results text area (placeholder - will be replaced with table)
        self.results_text = QTextEdit()
        self.results_text.setReadOnly(True)
        self.results_text.setPlainText(
            "No calibration results yet. Run calibration to see optimal RECHECK delay parameters "
            "for your selected blocks."
        )
        # INCREASED FONT SIZE for readability
        self.results_text.setStyleSheet(get_text_edit_stylesheet() + """
            QTextEdit {
                font-size: 11pt;
                line-height: 1.5;
            }
        """)
        results_layout.addWidget(self.results_text)
        
        results_group.setLayout(results_layout)
        return results_group
    
    def _create_action_section(self) -> QWidget:
        """Create action buttons section"""
        action_widget = QWidget()
        action_layout = QHBoxLayout(action_widget)
        action_layout.setContentsMargins(0, 0, 0, 0)
        action_layout.setSpacing(8)
        
        action_layout.addStretch()
        
        # Export button
        self.export_btn = QPushButton("Export Calibration Results")
        self.export_btn.setStyleSheet(get_primary_button_stylesheet(compact=True))
        self.export_btn.setFixedHeight(52)
        self.export_btn.setEnabled(False)
        self.export_btn.clicked.connect(self._export_results)
        action_layout.addWidget(self.export_btn)
        
        # Stop button (hidden by default)
        self.stop_btn = QPushButton("⏹ Stop Calibration")
        self.stop_btn.setStyleSheet(get_primary_button_stylesheet(compact=True))
        self.stop_btn.setFixedHeight(52)
        self.stop_btn.setVisible(False)
        self.stop_btn.clicked.connect(self._stop_training)
        action_layout.addWidget(self.stop_btn)
        
        # Start button
        self.start_btn = QPushButton("▶ Start Calibration")
        self.start_btn.setStyleSheet(get_primary_button_stylesheet())
        self.start_btn.setFixedSize(200, 52)
        self.start_btn.setToolTip(
            "Analyse historical bar data to calculate the optimal RECHECK delay "
            "for each selected block."
        )
        self.start_btn.clicked.connect(self._start_training)
        action_layout.addWidget(self.start_btn)
        
        return action_widget
    
    def _get_selected_timeframes(self) -> list:
        """Return list of timeframe strings whose checkboxes are checked."""
        return [tf for tf, cb in self.timeframe_checkboxes.items() if cb.isChecked()]

    def _toggle_all_blocks(self, checked: bool):
        """Toggle all block checkboxes"""
        for checkbox in self.block_checkboxes:
            checkbox.setChecked(checked)
    
    def _start_training(self):
        """
        Start calibration with confirmation dialog
        
        Task 2.1.7: Confirmation dialog
        """
        # Get selected blocks
        selected_blocks = [
            cb.text() for cb in self.block_checkboxes if cb.isChecked()
        ]
        
        # Get selected timeframes from checkboxes
        selected_timeframes = self._get_selected_timeframes()
        
        # Validation
        if not selected_blocks:
            QMessageBox.warning(
                self,
                "No Blocks Selected",
                "Please select at least one building block to analyze."
            )
            return
        
        if not selected_timeframes:
            QMessageBox.warning(
                self,
                "No Timeframes Selected",
                "Please select at least one timeframe to analyze."
            )
            return
        
        # Build configuration
        training_config = {
            'blocks': selected_blocks,
            'timeframes': selected_timeframes,
            'period_days': self.period_spin.value(),
            'mode': 'testing' if self.mode_combo.currentIndex() == 0 else 'production',
            'config': self.config
        }
        
        # Confirmation dialog (Task 2.1.7)
        msg = f"""
        <h3>Confirm Calibration Configuration</h3>
        <p><b>Selected Blocks:</b> {len(selected_blocks)}</p>
        <ul>{''.join(f'<li>{block}</li>' for block in selected_blocks)}</ul>
        <p><b>Timeframes:</b> {', '.join(selected_timeframes)}</p>
        <p><b>Lookback Period:</b> {self.period_spin.value()} days</p>
        <p><b>Mode:</b> {self.mode_combo.currentText()}</p>
        <br>
        <p><b>Estimated Analysis Time:</b> 5-15 minutes</p>
        <p>This will analyze historical signals and calculate optimal RECHECK delay parameters.</p>
        """
        
        reply = QMessageBox.question(
            self,
            "Confirm Calibration",
            msg,
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.Yes
        )
        
        if reply == QMessageBox.StandardButton.Yes:
            self._execute_training(training_config)
    
    def _execute_training(self, config: dict):
        """Execute calibration with given configuration"""
        # ------------------------------------------------------------------
        # Cache gate — check shared calibration cache before spawning TrainingThread
        # ------------------------------------------------------------------
        block_names = config['blocks']  # list[str] from checkbox text
        timeframe = ",".join(sorted(config['timeframes']))
        current_fingerprint = calibration_cache.compute_fingerprint(
            block_names=block_names,
            timeframe=timeframe,
            period_days=config['period_days'],
            mode=config['mode'],
        )

        if (
            self._calibration_fingerprint is not None
            and self._calibration_cache is not None
            and current_fingerprint == self._calibration_fingerprint
        ):
            _source = "loaded from disk" if self._calibration_cache_from_disk else "in-session"
            logger.info(f"Manual calibration: cache hit ({_source}).")
            msg_box = QMessageBox(self)
            msg_box.setWindowTitle("Cached Results Available")
            msg_box.setText(
                "Cached calibration results are available for the selected settings.\n\n"
                "Use cached results, or re-calibrate?"
            )
            use_btn = msg_box.addButton("Use Cached", QMessageBox.AcceptRole)
            msg_box.addButton("Re-calibrate", QMessageBox.DestructiveRole)
            msg_box.setDefaultButton(use_btn)
            msg_box.exec_()

            if msg_box.clickedButton() == use_btn:
                cached_delay_map = self._calibration_cache
                logger.info(
                    f"Manual calibration: applying cached delay_map "
                    f"(cache hit — skipping TrainingThread). "
                    f"Blocks: {list(cached_delay_map.keys())}"
                )
                result_lines = ["✓ Cached calibration results applied.\n", "Block → Optimal Delay:"]
                for name, delay in cached_delay_map.items():
                    result_lines.append(f"  {name}: {delay} bars")
                    logger.info(
                        f"Manual calibration: cached optimal_delay={delay} for block '{name}'"
                    )
                self.results_text.setPlainText("\n".join(result_lines))
                self.status_label.setText("Status: Using cached calibration results ✓")
                self.status_label.setStyleSheet(
                    f"color: {get_color('success')}; font-weight: bold;"
                )
                self.export_btn.setEnabled(True)
                return

            logger.info("Manual calibration: user chose re-calibrate, ignoring cache.")

        # Store fingerprint so _on_training_complete can write the cache on success
        self._pending_fingerprint = current_fingerprint
        # ------------------------------------------------------------------

        self.training_running = True
        
        # Update UI state
        self.start_btn.setEnabled(False)
        self.stop_btn.setVisible(True)
        self.status_label.setText("Status: Calibration in progress...")
        self.status_label.setStyleSheet(f"color: {get_color('warning')}; font-weight: bold;")
        
        # Disable configuration inputs
        for checkbox in self.block_checkboxes:
            checkbox.setEnabled(False)
        for cb in self.timeframe_checkboxes.values():
            cb.setEnabled(False)
        self.mode_combo.setEnabled(False)
        self.period_spin.setEnabled(False)
        
        # Create and start training thread
        from src.optimizer_v3.core.training_thread import TrainingThread
        
        self.training_thread = TrainingThread(
            selected_blocks=config['blocks'],
            mode=config['mode'],
            period_days=config['period_days'],
            selected_timeframes=config['timeframes'],
            logger=None  # Optional logger
        )
        
        # Connect signals
        self.training_thread.progress_update.connect(self._on_progress_update)
        self.training_thread.block_complete.connect(self._on_block_complete)
        self.training_thread.training_complete.connect(self._on_training_complete)
        self.training_thread.error_occurred.connect(self._on_training_error)
        self.training_thread.eta_update.connect(self._on_eta_update)
        
        # Start training
        self.training_thread.start()
    
    def _stop_training(self):
        """Stop calibration"""
        reply = QMessageBox.question(
            self,
            "Stop Calibration",
            "Are you sure you want to stop the calibration?\n\nPartial results will be saved.",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No
        )
        
        if reply == QMessageBox.StandardButton.Yes:
            self.training_stopped.emit()
            self._reset_ui_state()
    
    def _reset_ui_state(self):
        """Reset UI state after calibration completes or stops"""
        self.training_running = False
        
        # Update UI state
        self.start_btn.setEnabled(True)
        self.stop_btn.setVisible(False)
        self.status_label.setText("Status: Ready")
        self.status_label.setStyleSheet(f"color: {get_color('text_secondary')}; font-weight: bold;")
        
        # Enable configuration inputs
        for checkbox in self.block_checkboxes:
            checkbox.setEnabled(True)
        for cb in self.timeframe_checkboxes.values():
            cb.setEnabled(True)
        self.mode_combo.setEnabled(True)
        self.period_spin.setEnabled(True)
        
        # Reset progress
        self.progress_bar.setValue(0)
        self.eta_label.setText("ETA: Not started")
    
    def update_progress(self, progress: int, message: str, eta: str):
        """Update progress bar and status"""
        self.progress_bar.setValue(progress)
        self.status_label.setText(f"Status: {message}")
        self.eta_label.setText(f"ETA: {eta}")
    
    def training_complete(self, results: dict):
        """Handle calibration completion"""
        self._reset_ui_state()
        
        # Update status
        self.status_label.setText("Status: Calibration complete ✓")
        self.status_label.setStyleSheet(f"color: {get_color('success')}; font-weight: bold;")
        self.progress_bar.setValue(100)
        self.eta_label.setText("ETA: Complete")
        
        # Enable export
        self.export_btn.setEnabled(True)
        
        # Display results (placeholder - will use TrainingResultsTable)
        self.results_text.setPlainText(f"Calibration complete!\n\nResults: {results}")
    
    def _on_progress_update(self, current: int, total: int, message: str):
        """Handle progress update from training thread"""
        if total > 0:
            percentage = int((current / total) * 100)
            self.progress_bar.setValue(percentage)
        self.status_label.setText(f"Status: {message}")
    
    def _on_block_complete(self, block_name: str, result: dict):
        """Handle single block completion"""
        # Add to results display
        confidence = result.get('confidence', 0)
        delay = result.get('optimal_delay', 0)
        current_text = self.results_text.toPlainText()
        
        if current_text == (
            "No calibration results yet. Run calibration to see optimal RECHECK delay parameters "
            "for your selected blocks."
        ):
            current_text = "Calibration Results:\n\n"
        
        current_text += f"✓ {block_name}: Optimal delay = {delay} bars (confidence: {float(confidence):.0%})\n"
        self.results_text.setPlainText(current_text)
    
    def _on_training_complete(self, results: list):
        """Handle calibration completion"""
        self._reset_ui_state()

        # Update status
        self.status_label.setText("Status: Calibration complete ✓")
        self.status_label.setStyleSheet(f"color: {get_color('success')}; font-weight: bold;")
        self.progress_bar.setValue(100)
        self.eta_label.setText("ETA: Complete")

        # Enable export
        self.export_btn.setEnabled(True)

        # Write results to shared calibration cache
        if self._pending_fingerprint is not None:
            delay_map: dict = {}
            for r in results:
                name = r.get('signal_name', '')
                delay = r.get('optimal_delay')
                if name and delay is not None:
                    delay_map[name] = int(delay)
            if delay_map:
                self._calibration_fingerprint = self._pending_fingerprint
                self._calibration_cache = delay_map
                self._calibration_cache_from_disk = False
                calibration_cache.save_cache(self._pending_fingerprint, delay_map)
                logger.info("Manual calibration: shared cache updated with new fingerprint.")
            self._pending_fingerprint = None

        # Display summary
        summary = f"\n\n{'='*50}\nCALIBRATION COMPLETE\n{'='*50}\n"
        summary += f"Total results: {len(results)}\n"
        summary += f"High confidence (>80%): {len([r for r in results if r.get('confidence', 0) > 0.8])}\n"
        summary += f"Medium confidence (50-80%): {len([r for r in results if 0.5 <= r.get('confidence', 0) <= 0.8])}\n"
        summary += f"Low confidence (<50%): {len([r for r in results if r.get('confidence', 0) < 0.5])}\n"

        current_text = self.results_text.toPlainText()
        self.results_text.setPlainText(current_text + summary)
    
    def _on_training_error(self, error_message: str):
        """Handle calibration error"""
        self._pending_fingerprint = None
        self._reset_ui_state()
        
        # Update status
        self.status_label.setText("Status: Error occurred")
        self.status_label.setStyleSheet(f"color: {get_color('error')}; font-weight: bold;")
        
        # Display error
        self.results_text.setPlainText(f"❌ Calibration Error:\n\n{error_message}")
        
        # Show error dialog
        QMessageBox.critical(
            self,
            "Calibration Error",
            f"An error occurred during calibration:\n\n{error_message}"
        )
    
    def _on_eta_update(self, seconds_remaining: int):
        """Handle ETA update"""
        if seconds_remaining < 60:
            eta_text = f"{seconds_remaining}s"
        elif seconds_remaining < 3600:
            minutes = seconds_remaining // 60
            eta_text = f"{minutes}m {seconds_remaining % 60}s"
        else:
            hours = seconds_remaining // 3600
            minutes = (seconds_remaining % 3600) // 60
            eta_text = f"{hours}h {minutes}m"
        
        self.eta_label.setText(f"ETA: {eta_text}")
    
    def _get_strategy_blocks(self) -> List[str]:
        """
        Get building block names from loaded strategy
        
        Returns:
            List[str]: Block names from strategy, or empty list if no strategy
        """
        try:
            if not self.orchestrator:
                return []
            
            # Get current strategy configuration
            config = self.orchestrator.get_current_config()
            if not config or not hasattr(config, 'blocks'):
                return []
            
            # Extract block names
            block_names = []
            for block in config.blocks:
                if hasattr(block, 'name'):
                    block_names.append(block.name)
            
            return block_names
            
        except Exception as e:
            # Silently fail - UI will show warning
            return []
    
    def _export_results(self):
        """
        Export calibration results
        
        Task 2.1.23: Export functionality
        (Full implementation will be in training_results_table.py)
        """
        # Placeholder for export
        QMessageBox.information(
            self,
            "Export Calibration Results",
            "Export functionality will be implemented in training_results_table.py"
        )
