"""
Exit Condition Dialog - Configure exit conditions for strategy
Sprint 1.8 Phase 7 - Task 1.8.46

Allows users to configure exit conditions with:
- Percentage-based partial exits (0-100%)
- Exit mode selection (ABSOLUTE/FLEXIBLE)
- FLEXIBLE mode parameters (TP proximity, reversal trigger)
- RECHECK validation support

Author: Strategy Builder Team
Date: 2026-01-27
"""

from typing import Optional
from PyQt5.QtWidgets import (
    QMainWindow, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QSpinBox, QDoubleSpinBox, QRadioButton, QGroupBox, QCheckBox, QButtonGroup, QComboBox, QWidget
)
from PyQt5.QtCore import Qt
from src.strategy_builder.ui.styles import (
    get_exit_dialog_stylesheet, get_color, get_primary_button_stylesheet,
    get_secondary_button_stylesheet, get_label_style, get_radio_button_style,
    get_checkbox_style, create_font, get_recheck_gear_button_stylesheet,
    WindowGeometryMixin,
)

import logging
logger = logging.getLogger(__name__)



class ExitConditionDialog(WindowGeometryMixin, QMainWindow):
    """
    Window for configuring exit conditions.
    
    Features:
    - Percentage input (1-100%)
    - Exit mode: ABSOLUTE or FLEXIBLE
    - FLEXIBLE mode parameters
    - RECHECK enable checkbox
    - Tooltips for all fields
    - Fully resizable window
    """

    GEOMETRY_SETTINGS_KEY = "exitConditionDialog"
    GEOMETRY_DEFAULT_SIZE = (800, 600)

    def __init__(
        self,
        signal_name: Optional[str] = None,
        existing_percentage: Optional[float] = None,
        existing_exit_mode: str = "ABSOLUTE",
        existing_tp_proximity: float = 2.0,
        existing_reversal: float = 0.5,
        existing_recheck_enabled: bool = False,
        existing_recheck_bar_delay: int = 3,
        parent=None,
        orchestrator=None,
        is_duplicate: bool = False,
        binding_level: str = "STRATEGY",
        block_name: Optional[str] = None,
        parent_signal_name: Optional[str] = None
    ):
        """
        Initialize exit condition dialog.
        
        Args:
            signal_name: Name of exit signal (None = show signal selector)
            existing_percentage: Existing percentage (0.0-1.0) if editing
            existing_exit_mode: Existing mode ("ABSOLUTE" or "FLEXIBLE")
            existing_tp_proximity: Existing TP proximity threshold
            existing_reversal: Existing reversal trigger
            parent: Parent widget
            orchestrator: StrategyBuilderOrchestrator instance (optional, will find via parent if not provided)
            is_duplicate: True if opened from duplicate button, False for config button
            binding_level: Initial binding level to pre-select ("STRATEGY", "BLOCK", "SIGNAL")
            block_name: Block name if binding to block/signal
            parent_signal_name: Parent signal name if binding to signal
        """
        super().__init__(parent)
        
        # Issue 3: Make window draggable (non-modal)
        self.setWindowFlags(
            Qt.Window
            | Qt.WindowCloseButtonHint
            | Qt.WindowMinimizeButtonHint
            | Qt.WindowMaximizeButtonHint
        )
        
        self.signal_name = signal_name  # May be None - signal selector mode
        self.signal_selector_mode = (signal_name is None)
        self.exit_mode = existing_exit_mode
        self.orchestrator = orchestrator  # Store orchestrator reference
        self.is_duplicate = is_duplicate  # Track if this is duplicate operation
        
        # Determine if this is EDIT mode (config button) vs ADD mode (duplicate/red button)
        # EDIT: existing_percentage provided (editing existing exit with saved percentage)
        # ADD: existing_percentage is None (adding new exit, even if signal pre-selected)
        self.is_edit_mode = (existing_percentage is not None)
        
        # Issue 1: Store binding context for auto-selection
        self.initial_binding_level = binding_level
        self.initial_block_name = block_name
        self.initial_parent_signal_name = parent_signal_name
        
        # Convert percentage from 0.0-1.0 to 1-100 for display
        if existing_percentage is not None:
            self.percentage = int(existing_percentage * 100)
        else:
            self.percentage = 50  # Default 50%
        
        self.tp_proximity_threshold = existing_tp_proximity
        self.reversal_trigger = existing_reversal
        # Initialize RECHECK from existing values
        self.recheck_enabled = existing_recheck_enabled
        self.recheck_bar_delay = existing_recheck_bar_delay
        logger.debug(f"DEBUG: Initialized RECHECK: enabled={self.recheck_enabled}, bar_delay={self.recheck_bar_delay}")
        
        # UI components
        self.signal_selector: Optional[QComboBox] = None
        self.percentage_spin: Optional[QSpinBox] = None
        self.absolute_radio: Optional[QRadioButton] = None
        self.flexible_radio: Optional[QRadioButton] = None
        self.tp_proximity_spin: Optional[QSpinBox] = None
        self.reversal_spin: Optional[QSpinBox] = None
        self.recheck_checkbox: Optional[QCheckBox] = None
        
        self._init_ui()
        self._connect_signals()
    
    def showEvent(self, event):
        """Override showEvent to load signals after dialog is added to widget tree."""
        super().showEvent(event)
        
        # Restore window geometry via mixin
        self._restore_window_geometry(event)

        # Load signals on first show (after dialog is in widget tree)
        if self.signal_selector_mode and self.signal_selector and self.signal_selector.count() == 0:
            logger.debug("DEBUG: showEvent - Loading available signals now that dialog is shown")
            self._load_available_signals()
        
        # Issue 1: Auto-select binding level based on duplication source
        if hasattr(self, '_binding_level_set'):
            return  # Already set, don't do it again
        
        self._binding_level_set = True
        logger.debug(f"DEBUG: Auto-selecting binding level: {self.initial_binding_level}")
        
        if self.initial_binding_level == "BLOCK":
            self.block_radio.setChecked(True)
            # Pre-select the block if provided
            if self.initial_block_name:
                self._populate_block_selector()
                # Find and select the block
                for i in range(self.block_selector.count()):
                    if self.block_selector.itemText(i) == self.initial_block_name:
                        self.block_selector.setCurrentIndex(i)
                        break
        elif self.initial_binding_level == "SIGNAL":
            self.signal_radio.setChecked(True)
            # Pre-select the signal if provided
            if self.initial_block_name and self.initial_parent_signal_name:
                self._populate_signal_selector()
                # Find and select the signal
                target_data = f"{self.initial_block_name}::{self.initial_parent_signal_name}"
                for i in range(self.signal_binding_selector.count()):
                    if self.signal_binding_selector.itemData(i) == target_data:
                        self.signal_binding_selector.setCurrentIndex(i)
                        break
        else:
            # STRATEGY - already checked by default
            pass
    
    def _init_ui(self):
        """Initialize the user interface."""
        # Set window title based on mode - without signal name (gets cut off)
        if self.is_duplicate:
            self.setWindowTitle("Duplicate Exit Condition")
        else:
            self.setWindowTitle("Configure Exit Condition")
        
        self.setStyleSheet(get_exit_dialog_stylesheet())
        # Allow dialog to expand as needed
        self.setMinimumWidth(900)
        
        layout = QVBoxLayout()
        layout.setSpacing(15)
        layout.setContentsMargins(20, 20, 20, 20)
        
        # Title - show mode in label as well (use consistent blue/teal color)
        if self.signal_selector_mode:
            title_label = QLabel("⚙ Configure Strategy Exit Condition")
        else:
            if self.is_duplicate:
                title_label = QLabel(f"⚙ Duplicate EXIT: {self.signal_name}")
            else:
                title_label = QLabel(f"⚙ Configure EXIT: {self.signal_name}")
        title_font = create_font(size=13, bold=True)
        title_label.setFont(title_font)
        title_label.setStyleSheet("color: #095983;")  # Match main UI blue/teal
        layout.addWidget(title_label)
        
        # Signal selector (only if signal_name not provided)
        if self.signal_selector_mode:
            signal_group = QGroupBox("Select Exit Signal")
            signal_layout = QVBoxLayout()
            
            signal_row = QHBoxLayout()
            signal_label = QLabel("Signal:")
            signal_label.setStyleSheet(get_label_style('default'))
            signal_label.setToolTip("Choose which signal will trigger the exit condition")
            signal_row.addWidget(signal_label)
            
            self.signal_selector = QComboBox()
            self.signal_selector.setMinimumWidth(900)
            self.signal_selector.setToolTip("Select an exit signal from the building blocks registry")
            signal_row.addWidget(self.signal_selector, stretch=1)
            
            signal_layout.addLayout(signal_row)
            signal_group.setLayout(signal_layout)
            layout.addWidget(signal_group)
        
        # Binding Level section (Sprint 1.8 - Task 1.8.49)
        # Binding section - only show when ADDING or DUPLICATING (not when EDITING)
        binding_group = QGroupBox("Exit Binding Level")
        binding_layout = QVBoxLayout()
        
        # Create button group for binding level
        self.binding_button_group = QButtonGroup()
        
        # STRATEGY binding
        self.strategy_radio = QRadioButton("STRATEGY - Apply to all positions")
        self.strategy_radio.setStyleSheet(get_radio_button_style('error'))
        self.strategy_radio.setToolTip("Exit condition applies to ALL positions from this strategy")
        self.strategy_radio.setChecked(True)  # Default
        self.binding_button_group.addButton(self.strategy_radio)
        binding_layout.addWidget(self.strategy_radio)
        
        strategy_desc = QLabel("    └─ Global exit for entire strategy")
        strategy_desc.setStyleSheet(get_label_style('muted'))
        strategy_desc_font = create_font(size=9)
        strategy_desc.setFont(strategy_desc_font)
        binding_layout.addWidget(strategy_desc)
        
        # BLOCK binding
        self.block_radio = QRadioButton("BLOCK - Apply to specific block positions")
        self.block_radio.setStyleSheet(get_radio_button_style('warning'))
        self.block_radio.setToolTip("Exit condition applies only to positions from selected block")
        self.binding_button_group.addButton(self.block_radio)
        binding_layout.addWidget(self.block_radio)
        
        block_desc = QLabel("    └─ Exit only for positions from specific block")
        block_desc.setStyleSheet(get_label_style('muted'))
        block_desc_font = create_font(size=9)
        block_desc.setFont(block_desc_font)
        binding_layout.addWidget(block_desc)
        
        # Block selector dropdown (shown only when BLOCK is selected)
        self.block_selector_row = QHBoxLayout()
        block_selector_label = QLabel("        Select Block:")
        block_selector_label.setStyleSheet(get_label_style('default'))
        self.block_selector_row.addWidget(block_selector_label)
        
        self.block_selector = QComboBox()
        self.block_selector.setToolTip("Choose which block to bind this exit condition to")
        self.block_selector_row.addWidget(self.block_selector, stretch=1)
        self.block_selector_widget = QWidget()
        self.block_selector_widget.setLayout(self.block_selector_row)
        self.block_selector_widget.setVisible(False)  # Hidden by default
        binding_layout.addWidget(self.block_selector_widget)
        
        # SIGNAL binding
        self.signal_radio = QRadioButton("SIGNAL - Apply to specific signal positions")
        self.signal_radio.setStyleSheet(get_radio_button_style('info'))
        self.signal_radio.setToolTip("Exit condition applies only to positions from selected signal")
        self.binding_button_group.addButton(self.signal_radio)
        binding_layout.addWidget(self.signal_radio)
        
        signal_desc = QLabel("    └─ Granular exit for specific signal only")
        signal_desc.setStyleSheet(get_label_style('muted'))
        signal_desc_font = create_font(size=9)
        signal_desc.setFont(signal_desc_font)
        binding_layout.addWidget(signal_desc)
        
        # Signal selector dropdown (shown only when SIGNAL is selected)
        self.signal_selector_row = QHBoxLayout()
        signal_selector_label = QLabel("        Select Signal:")
        signal_selector_label.setStyleSheet(get_label_style('default'))
        self.signal_selector_row.addWidget(signal_selector_label)
        
        self.signal_binding_selector = QComboBox()
        self.signal_binding_selector.setToolTip("Choose which signal to bind this exit condition to")
        self.signal_selector_row.addWidget(self.signal_binding_selector, stretch=1)
        self.signal_selector_widget = QWidget()
        self.signal_selector_widget.setLayout(self.signal_selector_row)
        self.signal_selector_widget.setVisible(False)  # Hidden by default
        binding_layout.addWidget(self.signal_selector_widget)
        
        binding_group.setLayout(binding_layout)
        
        # CRITICAL FIX: Hide binding section when editing existing exit (config button)
        # Binding cannot be changed after creation - would break strategy structure
        if self.is_edit_mode:
            binding_group.setVisible(False)
            logger.debug(f"DEBUG: EDIT MODE - Hiding binding section, preserving: {self.initial_binding_level}")
        else:
            layout.addWidget(binding_group)
            logger.debug(f"DEBUG: ADD MODE - Showing binding section")
        
        # Percentage section
        percentage_group = QGroupBox("Exit Percentage")
        percentage_layout = QVBoxLayout()
        
        percentage_row = QHBoxLayout()
        percentage_label = QLabel("Close % of Position:")
        percentage_label.setStyleSheet(get_label_style('default'))
        percentage_label.setToolTip("Percentage of position to close when signal triggers (1-100%)")
        percentage_row.addWidget(percentage_label)
        
        self.percentage_spin = QSpinBox()
        self.percentage_spin.setRange(1, 100)
        self.percentage_spin.setValue(self.percentage)
        self.percentage_spin.setSuffix("%")
        self.percentage_spin.setToolTip("How much of the position to exit (1-100%)")
        percentage_row.addWidget(self.percentage_spin)
        
        # Quick preset buttons inline
        for pct in [10, 15, 20,25, 50, 75, 100]:
            btn = QPushButton(f"{pct}%")
            btn.setFixedSize(80, 32)
            btn.setStyleSheet("""
                QPushButton {
                    background-color: #244647;
                    color: #999999;
                    border: none;
                    border-radius: 6px;
                    padding: 2px 4px;
                    text-align: center;
                }
                QPushButton:hover {
                    background-color: #1a3334;
                }
                QPushButton:pressed {
                    background-color: #0f2021;
                }
            """)
            # Set font AFTER stylesheet to prevent override
            btn_font = create_font(size=8)
            btn.setFont(btn_font)
            btn.clicked.connect(lambda checked, p=pct: self.percentage_spin.setValue(p))
            percentage_row.addWidget(btn)
        
        percentage_row.addStretch()
        percentage_layout.addLayout(percentage_row)
        
        percentage_group.setLayout(percentage_layout)
        layout.addWidget(percentage_group)
        
        # Exit mode section
        mode_group = QGroupBox("Exit Mode")
        mode_layout = QVBoxLayout()
        
        # Create button group for radio buttons
        self.mode_button_group = QButtonGroup()
        
        # ABSOLUTE mode
        self.absolute_radio = QRadioButton("ABSOLUTE - Exit Immediately")
        self.absolute_radio.setStyleSheet(get_radio_button_style('default'))
        self.absolute_radio.setToolTip("Exit position immediately when signal triggers (no TP proximity check)")
        self.mode_button_group.addButton(self.absolute_radio)
        mode_layout.addWidget(self.absolute_radio)
        
        absolute_desc = QLabel("    └─ Executes partial exit as soon as signal fires")
        absolute_desc.setStyleSheet(get_label_style('muted'))
        absolute_desc_font = create_font(size=9)
        absolute_desc.setFont(absolute_desc_font)
        mode_layout.addWidget(absolute_desc)
        
        # FLEXIBLE mode
        self.flexible_radio = QRadioButton("FLEXIBLE - TP-Aware Exit")
        self.flexible_radio.setStyleSheet(get_radio_button_style('info'))
        self.flexible_radio.setToolTip("Check TP proximity before exiting; defer if price heading toward TP")
        self.mode_button_group.addButton(self.flexible_radio)
        mode_layout.addWidget(self.flexible_radio)
        
        flexible_desc = QLabel("    └─ Defers exit if price moving toward TP; fires on reversal")
        flexible_desc.setStyleSheet(get_label_style('muted'))
        flexible_desc_font = create_font(size=9)
        flexible_desc.setFont(flexible_desc_font)
        mode_layout.addWidget(flexible_desc)
        
        # Set initial state
        if self.exit_mode == "ABSOLUTE":
            self.absolute_radio.setChecked(True)
        else:
            self.flexible_radio.setChecked(True)
        
        mode_group.setLayout(mode_layout)
        layout.addWidget(mode_group)
        
        # FLEXIBLE mode parameters
        self.flexible_params_group = QGroupBox("FLEXIBLE Mode Parameters")
        flexible_params_layout = QVBoxLayout()
        
        # TP Proximity Threshold
        proximity_row = QHBoxLayout()
        proximity_label = QLabel("TP Proximity Threshold:")
        proximity_label.setStyleSheet(get_label_style('default'))
        proximity_label.setToolTip("Distance from TP to consider 'close to TP' (percentage)")
        proximity_row.addWidget(proximity_label)
        
        self.tp_proximity_spin = QDoubleSpinBox()
        self.tp_proximity_spin.setRange(0.25, 10.0)
        self.tp_proximity_spin.setDecimals(2)
        self.tp_proximity_spin.setSingleStep(0.25)
        self.tp_proximity_spin.setValue(self.tp_proximity_threshold)
        self.tp_proximity_spin.setSuffix("%")
        self.tp_proximity_spin.setToolTip("If price is within this % of TP, consider deferring exit")
        proximity_row.addWidget(self.tp_proximity_spin)
        
        # Quick preset buttons inline
        for val in [0.25, 0.5, 1.0, 1.5, 2.0]:
            btn = QPushButton(f"{val}%")
            btn.setFixedSize(100, 32)
            btn.setStyleSheet("""
                QPushButton {
                    background-color: #244647;
                    color: #999999;
                    border: none;
                    border-radius: 6px;
                    padding: 2px 4px;
                    text-align: center;
                }
                QPushButton:hover {
                    background-color: #1a3334;
                }
                QPushButton:pressed {
                    background-color: #0f2021;
                }
            """)
            # Set font AFTER stylesheet to prevent override
            btn_font = create_font(size=8)
            btn.setFont(btn_font)
            btn.clicked.connect(lambda checked, v=val: self.tp_proximity_spin.setValue(v))
            proximity_row.addWidget(btn)
        
        proximity_row.addStretch()
        self.proximity_widget = QWidget()
        self.proximity_widget.setLayout(proximity_row)
        flexible_params_layout.addWidget(self.proximity_widget)
        
        # Reversal Trigger
        reversal_row = QHBoxLayout()
        reversal_label = QLabel("Reversal Trigger:")
        reversal_label.setStyleSheet(get_label_style('default'))
        reversal_label.setToolTip("Pullback % from peak that triggers deferred exit")
        reversal_row.addWidget(reversal_label)
        
        self.reversal_spin = QSpinBox()
        self.reversal_spin.setRange(1, 10)
        self.reversal_spin.setValue(int(self.reversal_trigger * 10))  # Convert 0.5 to 5
        self.reversal_spin.setSuffix("%")
        self.reversal_spin.setToolTip("If price pulls back this % from peak, execute deferred exit")
        reversal_row.addWidget(self.reversal_spin)
        
        # Quick preset buttons inline
        for val in [1, 2, 3, 4, 5, 6, 7, 8]:
            btn = QPushButton(f"{val}%")
            btn.setFixedSize(80, 32)
            btn.setStyleSheet("""
                QPushButton {
                    background-color: #244647;
                    color: #999999;
                    border: none;
                    border-radius: 6px;
                    padding: 2px 4px;
                    text-align: center;
                }
                QPushButton:hover {
                    background-color: #1a3334;
                }
                QPushButton:pressed {
                    background-color: #0f2021;
                }
            """)
            # Set font AFTER stylesheet to prevent override
            btn_font = create_font(size=8)
            btn.setFont(btn_font)
            btn.clicked.connect(lambda checked, v=val: self.reversal_spin.setValue(v))
            reversal_row.addWidget(btn)
        
        reversal_row.addStretch()
        self.reversal_widget = QWidget()
        self.reversal_widget.setLayout(reversal_row)
        flexible_params_layout.addWidget(self.reversal_widget)
        
        self.flexible_params_group.setLayout(flexible_params_layout)
        layout.addWidget(self.flexible_params_group)
        
        # Enable/disable FLEXIBLE parameters based on mode
        self.flexible_params_group.setEnabled(self.exit_mode == "FLEXIBLE")
        
        # RECHECK section
        recheck_group = QGroupBox("RECHECK Validation")
        recheck_layout = QVBoxLayout()
        
        self.recheck_checkbox = QCheckBox("Enable RECHECK for this exit condition")
        self.recheck_checkbox.setStyleSheet(get_checkbox_style('default'))
        self.recheck_checkbox.setToolTip("Require signal to be true again after delay before executing exit")
        recheck_layout.addWidget(self.recheck_checkbox)
        
        # RECHECK bar delay input (visible when checked)
        self.recheck_delay_row = QHBoxLayout()
        recheck_delay_label = QLabel("    Bar Delay:")
        recheck_delay_label.setStyleSheet(get_label_style('default'))
        recheck_delay_label.setToolTip("Number of bars within which exit signal must reoccur")
        self.recheck_delay_row.addWidget(recheck_delay_label)
        
        self.recheck_delay_spin = QSpinBox()
        self.recheck_delay_spin.setRange(1, 500)
        self.recheck_delay_spin.setValue(self.recheck_bar_delay)
        self.recheck_delay_spin.setToolTip("Number of bars for RECHECK validation")
        self.recheck_delay_row.addWidget(self.recheck_delay_spin)
        
        # Quick preset buttons inline
        for val in [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]:
            btn = QPushButton(str(val))
            btn.setFixedSize(50, 32)
            btn.setStyleSheet("""
                QPushButton {
                    background-color: #244647;
                    color: #999999;
                    border: none;
                    border-radius: 6px;
                    padding: 2px 4px;
                    text-align: center;
                }
                QPushButton:hover {
                    background-color: #1a3334;
                }
                QPushButton:pressed {
                    background-color: #0f2021;
                }
            """)
            # Set font AFTER stylesheet to prevent override
            btn_font = create_font(size=8)
            btn.setFont(btn_font)
            btn.clicked.connect(lambda checked, v=val: self.recheck_delay_spin.setValue(v))
            self.recheck_delay_row.addWidget(btn)
        
        self.recheck_delay_row.addStretch()
        
        self.recheck_delay_widget = QWidget()
        self.recheck_delay_widget.setLayout(self.recheck_delay_row)
        self.recheck_delay_widget.setVisible(self.recheck_enabled)  # Show only if RECHECK enabled
        recheck_layout.addWidget(self.recheck_delay_widget)
        
        recheck_group.setLayout(recheck_layout)
        layout.addWidget(recheck_group)
        
        # Buttons
        button_layout = QHBoxLayout()
        button_layout.addStretch()
        
        cancel_button = QPushButton("Cancel")
        cancel_button.setStyleSheet(get_secondary_button_stylesheet())
        cancel_button.clicked.connect(self.reject)
        button_layout.addWidget(cancel_button)
        
        # Button text depends on mode
        if self.is_edit_mode:
            ok_button = QPushButton("Update Exit Condition")
        else:
            ok_button = QPushButton("Add Exit Condition")
        ok_button.setStyleSheet(get_primary_button_stylesheet())
        ok_button.clicked.connect(self.accept)
        ok_button.setDefault(True)
        button_layout.addWidget(ok_button)
        
        layout.addLayout(button_layout)
        
        # QMainWindow requires central widget with layout
        central_widget = QWidget()
        central_widget.setLayout(layout)
        self.setCentralWidget(central_widget)
        
        # Track accepted state for exec-like behavior
        self._accepted = False
        
        # CRITICAL: Set checkbox state AFTER layout but BEFORE connecting signals
        # This prevents triggering the prompt dialog when loading existing RECHECK state
        if self.recheck_enabled:
            self.recheck_checkbox.blockSignals(True)
            self.recheck_checkbox.setChecked(True)
            self.recheck_checkbox.blockSignals(False)
            logger.debug(f"DEBUG: Loaded existing RECHECK state: checked={True}, bar_delay={self.recheck_bar_delay}")
    
    def _connect_signals(self):
        """Connect UI signals to handlers."""
        self.absolute_radio.toggled.connect(self._on_mode_changed)
        self.flexible_radio.toggled.connect(self._on_mode_changed)
        
        # Connect binding level radio buttons ONLY if not in edit mode
        # In edit mode, binding section is hidden and widgets are deleted by Qt
        if not self.is_edit_mode:
            self.strategy_radio.toggled.connect(self._on_binding_level_changed)
            self.block_radio.toggled.connect(self._on_binding_level_changed)
            self.signal_radio.toggled.connect(self._on_binding_level_changed)
        
        # Issue 4: Connect RECHECK checkbox to prompt for bar delay
        self.recheck_checkbox.stateChanged.connect(self._on_recheck_changed)
    
    def _find_orchestrator(self):
        """
        Find orchestrator by traversing widget tree to find StrategyBlocksPanel.
        
        Returns:
            StrategyBuilderOrchestrator or None
        """
        widget = self.parent()
        while widget is not None:
            if hasattr(widget, 'orchestrator'):
                logger.debug(f"DEBUG: Found orchestrator on {type(widget).__name__}")
                return widget.orchestrator
            widget = widget.parent()
        
        logger.debug("DEBUG: No orchestrator found in widget tree")
        return None
    
    def _on_mode_changed(self, checked):
        """Handle exit mode radio button changes."""
        if self.absolute_radio.isChecked():
            self.exit_mode = "ABSOLUTE"
            self.flexible_params_group.setEnabled(False)
        else:
            self.exit_mode = "FLEXIBLE"
            self.flexible_params_group.setEnabled(True)
    
    def _on_recheck_changed(self, state):
        """
        Handle RECHECK checkbox state change - show/hide bar delay spinbox.
        """
        if state == Qt.Checked:
            # Show bar delay spinbox
            self.recheck_delay_widget.setVisible(True)
            self.recheck_enabled = True
            logger.debug(f"DEBUG: RECHECK enabled, showing bar delay spinbox (value={self.recheck_delay_spin.value()})")
        else:
            # Hide bar delay spinbox
            self.recheck_delay_widget.setVisible(False)
            self.recheck_enabled = False
            logger.debug("DEBUG: RECHECK disabled, hiding bar delay spinbox")
    
    def _on_binding_level_changed(self):
        """Handle binding level radio button changes - show/hide selectors."""
        # Show/hide appropriate selectors
        self.block_selector_widget.setVisible(self.block_radio.isChecked())
        self.signal_selector_widget.setVisible(self.signal_radio.isChecked())
        
        # Populate selectors when shown
        if self.block_radio.isChecked():
            self._populate_block_selector()
        elif self.signal_radio.isChecked():
            self._populate_signal_selector()
    
    def _populate_block_selector(self):
        """Populate block selector with blocks from current strategy config."""
        self.block_selector.clear()
        
        try:
            # Use stored orchestrator or find in widget tree
            orchestrator = self.orchestrator or self._find_orchestrator()
            if not orchestrator:
                logger.warning("DEBUG: Could not find orchestrator")
                self.block_selector.addItem("No blocks available")
                return
            
            config = orchestrator.get_current_config()
            
            if not config or not config.blocks:
                logger.debug("DEBUG: No blocks in config")
                self.block_selector.addItem("No blocks in strategy")
                return
            
            # Successfully found blocks
            logger.debug(f"DEBUG: Found {len(config.blocks)} blocks in strategy")
            for block in config.blocks:
                self.block_selector.addItem(block.name)
                logger.info(f"  - Added block: {block.name}")
        
        except Exception as e:
            logger.error(f"Error populating block selector: {e}")
            import traceback
            traceback.print_exc()
            self.block_selector.addItem("Error loading blocks")
    
    def _populate_signal_selector(self):
        """Populate signal selector with signals from current strategy config."""
        self.signal_binding_selector.clear()
        
        try:
            # Use stored orchestrator or find in widget tree
            orchestrator = self.orchestrator or self._find_orchestrator()
            if not orchestrator:
                logger.warning("DEBUG: Could not find orchestrator for signal selector")
                self.signal_binding_selector.addItem("No signals available")
                return
            
            config = orchestrator.get_current_config()
            
            if not config or not config.blocks:
                logger.debug("DEBUG: No blocks in config for signal selector")
                self.signal_binding_selector.addItem("No blocks in strategy")
                return
            
            # Collect all signals from all blocks
            logger.debug(f"DEBUG: Populating signal selector with signals from {len(config.blocks)} blocks")
            for block in config.blocks:
                for signal in block.signals:
                    # Format: "block_name::signal_name"
                    display_text = f"{block.name} → {signal.name}"
                    self.signal_binding_selector.addItem(display_text, f"{block.name}::{signal.name}")
                    logger.info(f"  - Added signal: {block.name} → {signal.name}")
            
            if self.signal_binding_selector.count() == 0:
                logger.debug("DEBUG: No signals found in any block")
                self.signal_binding_selector.addItem("No signals in strategy")
        
        except Exception as e:
            logger.error(f"Error populating signal selector: {e}")
            import traceback
            traceback.print_exc()
            self.signal_binding_selector.addItem("Error loading signals")
    
    def _load_available_signals(self):
        """Load available signals from registry (only in selector mode)."""
        if not self.signal_selector_mode or not self.signal_selector:
            logger.debug("DEBUG: Not in signal selector mode or no signal selector widget")
            return
        
        try:
            # Use stored orchestrator or traverse widget tree
            orchestrator = self.orchestrator or self._find_orchestrator()
            
            if not orchestrator:
                logger.warning("Warning: Cannot access orchestrator - not found in widget tree")
                self.signal_selector.addItem("No orchestrator available")
                self.signal_selector.setEnabled(False)
                return
            
            logger.debug(f"DEBUG: Successfully found orchestrator: {type(orchestrator).__name__}")
            
            # Get all blocks from registry
            search_results = orchestrator.search_blocks("")  # Empty = all blocks
            logger.debug(f"DEBUG: Found {len(search_results)} blocks in registry")
            
            # Collect all signals marked for exit conditions
            signals_set = set()
            for result in search_results:
                block_info = orchestrator.registry_interface.get_block(result.block_name)
                if block_info and block_info.signals:
                    for signal in block_info.signals:
                        # Only include signals that are visible in UI and marked as exit signals
                        ui_visible = getattr(signal, 'ui_visible', True)
                        is_exit_signal = getattr(signal, 'is_exit_signal', False)
                        
                        # Include if: ui_visible is True AND (is_exit_signal OR no is_exit_signal attribute)
                        # This ensures backward compatibility with blocks that don't have is_exit_signal yet
                        if ui_visible and (is_exit_signal or not hasattr(signal, 'is_exit_signal')):
                            signals_set.add(signal.name)
                            logger.info(f"  - Added signal: {signal.name} (is_exit={is_exit_signal})")
            
            logger.debug(f"DEBUG: Total unique signals collected: {len(signals_set)}")
            
            # Sort and populate combo box
            for signal_name in sorted(signals_set):
                self.signal_selector.addItem(signal_name)
            
            if self.signal_selector.count() == 0:
                logger.warning("WARNING: No signals found in registry")
                self.signal_selector.addItem("No signals available")
                self.signal_selector.setEnabled(False)
            else:
                logger.info(f"SUCCESS: Populated signal selector with {self.signal_selector.count()} signals")
            
        except Exception as e:
            logger.error(f"ERROR loading signals: {e}")
            import traceback
            traceback.print_exc()
            self.signal_selector.addItem("Error loading signals")
            self.signal_selector.setEnabled(False)
    
    def get_config(self) -> dict:
        """
        Get exit condition configuration from dialog.
        
        Returns:
            Dictionary with exit condition settings including block_name and parent_signal_name
        """
        # Get signal name from selector if in selector mode
        if self.signal_selector_mode and self.signal_selector:
            selected_signal = self.signal_selector.currentText()
            if selected_signal and selected_signal not in ["No signals available", "Error loading signals"]:
                self.signal_name = selected_signal
        
        # CRITICAL FIX: If editing existing exit, preserve original binding (binding section was hidden)
        if self.is_edit_mode:
            # Use the original binding that was passed when dialog was opened
            binding_level = self.initial_binding_level
            block_name = self.initial_block_name
            parent_signal_name = self.initial_parent_signal_name
            logger.debug(f"DEBUG: EDIT MODE - Preserving original binding: {binding_level}, block={block_name}, signal={parent_signal_name}")
        else:
            # ADD MODE: Get binding from radio buttons (user can choose)
            binding_level = "STRATEGY"  # Default
            block_name = None
            parent_signal_name = None
            
            if hasattr(self, 'block_radio') and self.block_radio.isChecked():
                binding_level = "BLOCK"
                # Get selected block
                if self.block_selector.currentText() and self.block_selector.currentText() not in ["No blocks available", "No blocks in strategy", "Error loading blocks"]:
                    block_name = self.block_selector.currentText()
            
            elif hasattr(self, 'signal_radio') and self.signal_radio.isChecked():
                binding_level = "SIGNAL"
                # Get selected signal (stored as "block_name::signal_name" in itemData)
                current_data = self.signal_binding_selector.currentData()
                if current_data and "::" in current_data:
                    parts = current_data.split("::")
                    block_name = parts[0]
                    parent_signal_name = parts[1]
        
        config = {
            'signal_name': self.signal_name,
            'percentage': self.percentage_spin.value() / 100.0,  # Convert to 0.0-1.0
            'exit_mode': self.exit_mode,
            'binding_level': binding_level,
            'tp_proximity_threshold': float(self.tp_proximity_spin.value()),
            'reversal_trigger': self.reversal_spin.value() / 10.0,  # Convert to 0.0-1.0
            'recheck_enabled': self.recheck_checkbox.isChecked(),
            'recheck_bar_delay': self.recheck_delay_spin.value() if self.recheck_checkbox.isChecked() else None
        }
        
        # Add block_name and parent_signal_name if applicable
        if block_name:
            config['block_name'] = block_name
        if parent_signal_name:
            config['parent_signal_name'] = parent_signal_name
        
        return config
    
    def accept(self):
        """Accept the dialog - mark as accepted and close."""
        self._accepted = True
        self.close()
    
    def reject(self):
        """Reject the dialog - mark as rejected and close."""
        self._accepted = False
        self.close()
    
    def closeEvent(self, event):
        """Save window geometry on close."""
        self._save_window_geometry()
        super().closeEvent(event)
    
    def exec_(self):
        """
        Execute the window modally (QDialog compatibility).
        
        Returns:
            1 if accepted, 0 if rejected
        """
        from PyQt5.QtWidgets import QDialog
        # Re-entrancy guard: if already visible, bring to front and return Rejected
        # to prevent duplicate dialog instances from accumulating.
        if self.isVisible():
            self.raise_()
            self.activateWindow()
            return QDialog.Rejected
        self.setWindowModality(Qt.ApplicationModal)
        self.show()
        
        # Block until window is closed
        from PyQt5.QtWidgets import QApplication
        while self.isVisible():
            QApplication.processEvents()
        
        return QDialog.Accepted if self._accepted else QDialog.Rejected
