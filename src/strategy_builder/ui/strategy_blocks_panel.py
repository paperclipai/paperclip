"""
Strategy Blocks Configuration Panel - UI Component for Strategy Builder

This panel displays the added building blocks and allows configuration:
- Display blocks in order with signals
- Reorder blocks (up/down)
- Remove blocks
- Show AND/OR logic
- Configure timing constraints
- Visual feedback
- Integration with orchestrator

Author: Strategy Builder Team
Date: 2026-01-16
"""

from typing import Optional, List, Tuple
from functools import partial
from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QGroupBox, QScrollArea, QFrame, QDialog, QScroller
)
from PyQt5.QtCore import pyqtSignal, Qt
from PyQt5.QtGui import QFont

from src.strategy_builder.integration.strategy_builder_orchestrator import (
    StrategyBuilderOrchestrator
)
from src.strategy_builder.ui.timing_constraint_dialog import TimingConstraintDialog
from src.strategy_builder.ui.exit_condition_dialog import ExitConditionDialog
# Import centralized styles
from src.strategy_builder.ui.styles import (
    get_label_style, get_logic_badge_style, get_primary_button_stylesheet,
    get_danger_button_stylesheet, get_icon_button_style, get_block_label_style,
    get_recheck_button_stylesheet, get_recheck_gear_button_stylesheet,
    get_recheck_duplicate_button_stylesheet, get_recheck_remove_button_stylesheet,
    get_spinbox_button_stylesheet, get_success_button_stylesheet, get_color,
    get_dialog_stylesheet, get_radio_container_stylesheet, get_signal_radio_stylesheet,
    get_recheck_radio_stylesheet, get_exit_tree_item_style, get_exit_button_stylesheet,
    set_hand_cursor, format_block_name
)

import logging
logger = logging.getLogger(__name__)



class BlockConfigItem(QWidget):
    """
    Custom widget for displaying a configured block with controls.
    """
    
    move_up_clicked = pyqtSignal(str)  # block_name
    move_down_clicked = pyqtSignal(str)  # block_name
    remove_clicked = pyqtSignal(str)  # block_name
    configure_timing_clicked = pyqtSignal(str, str)  # block_name, signal_name
    
    def __init__(
        self,
        block_name: str,
        block_info: dict,
        position: int,
        total: int,
        orchestrator: Optional[StrategyBuilderOrchestrator] = None,
        parent: Optional[QWidget] = None
    ):
        super().__init__(parent)
        self.block_name = block_name
        self.block_info = block_info
        self.position = position
        self.total = total
        self.orchestrator = orchestrator
        
        self._init_ui()
    
    def _init_ui(self):
        """Initialize the UI for this block item."""
        layout = QVBoxLayout()
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(8)
        
        # Main header layout
        header_layout = QHBoxLayout()
        
        # Position indicator - Use centralized color from styles.py
        from src.strategy_builder.ui.styles import get_color
        position_label = QLabel(f"#{self.position}")
        position_font = QFont()
        position_font.setBold(True)
        position_font.setPointSize(12)
        position_label.setFont(position_font)
        position_label.setStyleSheet(f"color: {get_color('button_primary')}; font-weight: bold; min-width: 40px;")
        header_layout.addWidget(position_label)
        
        # Block info layout
        info_layout = QVBoxLayout()
        
        # Block name with AND/OR badge - format to title case with "and" lowercase
        name_layout = QHBoxLayout()
        name_layout.setSpacing(10)
        
        name_label = QLabel(f"📊 {format_block_name(self.block_name)}")
        name_font = QFont()
        name_font.setBold(True)
        name_font.setPointSize(10)
        name_label.setFont(name_font)
        name_label.setStyleSheet(get_label_style('default'))
        name_layout.addWidget(name_label)
        
        # NEW: AND/OR Badge - prominent display with centralized styling
        logic_type = self.block_info.get('logic', 'AND')
        if logic_type == 'AND':
            badge_text = "REQUIRED"
            badge_type_style = 'required'
            badge_tooltip = "This block is REQUIRED - all signals must trigger"
        else:
            badge_text = "OPTIONAL"
            badge_type_style = 'optional'
            badge_tooltip = "This block is OPTIONAL - boosts strategy when triggered"
        
        logic_badge = QLabel(badge_text)
        logic_badge.setStyleSheet(get_logic_badge_style(badge_type_style))
        logic_badge.setToolTip(badge_tooltip)
        # Set size policy to prevent expansion
        from PyQt5.QtWidgets import QSizePolicy
        logic_badge.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Fixed)
        name_layout.addWidget(logic_badge)
        name_layout.addStretch()
        
        info_layout.addLayout(name_layout)
        
        # Signals count
        signals_count = len(self.block_info.get('signals', []))
        signals_label = QLabel(f"Signals: {signals_count}")
        signals_label.setStyleSheet(get_label_style('muted') + " font-size: 9pt;")
        info_layout.addWidget(signals_label)
        
        header_layout.addLayout(info_layout, stretch=1)
        
        # Control buttons layout
        controls_layout = QVBoxLayout()
        controls_layout.setSpacing(5)

        # Move buttons - aligned to the right
        move_layout = QHBoxLayout()
        move_layout.addStretch()  # Push buttons to the right

        self.up_button = QPushButton("▴")  # Sharp small triangle up
        set_hand_cursor(self.up_button)
        self.up_button.setMaximumWidth(40)
        self.up_button.setStyleSheet("font-size: 18px; font-weight: bold;")  # Bigger triangle
        self.up_button.setToolTip("Move block up")
        self.up_button.clicked.connect(lambda: self.move_up_clicked.emit(self.block_name))
        self.up_button.setEnabled(self.position > 1)  # Disable if first
        move_layout.addWidget(self.up_button)

        self.down_button = QPushButton("▾")  # Sharp small triangle down
        set_hand_cursor(self.down_button)
        self.down_button.setMaximumWidth(40)
        self.down_button.setStyleSheet("font-size: 18px; font-weight: bold;")  # Bigger triangle
        self.down_button.setToolTip("Move block down")
        self.down_button.clicked.connect(lambda: self.move_down_clicked.emit(self.block_name))
        self.down_button.setEnabled(self.position < self.total)  # Disable if last
        move_layout.addWidget(self.down_button)

        controls_layout.addLayout(move_layout)
        
        # Configure button for blocks #2+ (need reference to previous block)
        if self.position > 1:
            self.configure_block_button = QPushButton("⚙️ Config")
            set_hand_cursor(self.configure_block_button)
            self.configure_block_button.setMinimumWidth(100)
            self.configure_block_button.setStyleSheet(get_primary_button_stylesheet())
            self.configure_block_button.setToolTip("Configure timing constraint for this block")
            # Emit with empty string as signal_name to indicate block-level config
            self.configure_block_button.clicked.connect(lambda: self.configure_timing_clicked.emit(self.block_name, ""))
            controls_layout.addWidget(self.configure_block_button)
        
        # Remove button
        self.remove_button = QPushButton("✕ Remove")
        set_hand_cursor(self.remove_button)
        self.remove_button.setMinimumWidth(100)  # Changed from setMaximumWidth(90)
        self.remove_button.setStyleSheet(get_danger_button_stylesheet())
        self.remove_button.clicked.connect(lambda: self.remove_clicked.emit(self.block_name))
        controls_layout.addWidget(self.remove_button)
        
        header_layout.addLayout(controls_layout)
        
        layout.addLayout(header_layout)
        
        # Signals section - dark theme with timing constraints and dependencies
        if self.block_info.get('signals'):
            signals_widget = QFrame()
            signals_widget.setFrameShape(QFrame.StyledPanel)
            from src.strategy_builder.ui.styles import get_color
            signals_widget.setStyleSheet(f"background-color: {get_color('bg_light')}; border: 1px solid {get_color('border')}; border-radius: 6px; padding: 5px;")
            
            signals_layout = QVBoxLayout()
            signals_layout.setContentsMargins(10, 5, 10, 5)
            
            signals_header = QLabel("Signals:")
            signals_header.setStyleSheet(get_label_style('info') + " font-weight: bold;")
            signals_layout.addWidget(signals_header)
            
            for idx, signal in enumerate(self.block_info['signals'], 1):
                signal_name = signal.get('name', 'Unknown')
                signal_logic = signal.get('logic', 'AND')
                timing_constraint = signal.get('timing_constraint')
                
                # Create horizontal layout for signal and configure button
                signal_row_layout = QHBoxLayout()
                signal_row_layout.setSpacing(8)
                
                # Logic indicator color - brighter for dark theme
                logic_color = "#4ADE80" if signal_logic == "AND" else "#60A5FA"
                
                # Check if this signal has dependencies (references previous signals)
                has_dependency = timing_constraint is not None
                
                # Build signal text with inline timing in orange if present
                if has_dependency:
                    ref_signal = timing_constraint.get('reference_signal', 'previous signal')
                    max_candles = timing_constraint.get('max_candles', 'N/A')
                    # Use HTML for inline orange timing text
                    signal_text = f'<span style="color: {logic_color};">{idx}. {signal_name} [{signal_logic}]</span> <span style="color: #FFA500;">⏱️ Within {max_candles} candles of {ref_signal}</span>'
                    signal_label = QLabel(signal_text)
                    signal_label.setTextFormat(Qt.RichText)
                    signal_label.setStyleSheet("font-size: 9pt; margin-left: 0px; padding-left: 0px;")
                else:
                    signal_text = f"{idx}. {signal_name} [{signal_logic}]"
                    signal_label = QLabel(signal_text)
                    signal_label.setStyleSheet(f"color: {logic_color}; font-size: 9pt; margin-left: 0px; padding-left: 0px;")
                
                # Add tooltip with full signal info
                tooltip_parts = [f"Signal: {signal_name}", f"Logic: {signal_logic}"]
                if timing_constraint:
                    ref_signal = timing_constraint.get('reference_signal', 'previous signal')
                    max_candles = timing_constraint.get('max_candles', 'N/A')
                    tooltip_parts.append(f"Timing: Within {max_candles} candles of {ref_signal}")
                signal_label.setToolTip("\n".join(tooltip_parts))
                
                signal_row_layout.addWidget(signal_label, stretch=1)
                
                # Add "Recheck On Delayed Candles" button - hide if recheck already configured
                if not signal.get('recheck_config') or not signal['recheck_config'].get('enabled'):
                    recheck_btn = QPushButton("Recheck On Delayed Candles")
                    set_hand_cursor(recheck_btn)
                    recheck_btn.setMinimumWidth(180)
                    recheck_btn.setMinimumHeight(28)
                    recheck_btn.setStyleSheet(get_recheck_button_stylesheet())
                    recheck_btn.setToolTip("Require this signal to reoccur within specified bars for validation")
                    recheck_btn.clicked.connect(
                        lambda checked, sname=signal_name: self._on_recheck_clicked(sname)
                    )
                    signal_row_layout.addWidget(recheck_btn)
                
                # Add configure button for signals after the first (need reference signal)
                if idx > 1:
                    configure_btn = QPushButton("⚙️ Config")
                    set_hand_cursor(configure_btn)
                    configure_btn.setMinimumWidth(90)
                    configure_btn.setMinimumHeight(28)
                    configure_btn.setStyleSheet(get_primary_button_stylesheet())
                    configure_btn.setToolTip("Configure timing constraint for this signal")
                    configure_btn.clicked.connect(
                        lambda checked, sname=signal_name: self.configure_timing_clicked.emit(self.block_name, sname)
                    )
                    signal_row_layout.addWidget(configure_btn)
                
                signals_layout.addLayout(signal_row_layout)
                
                # Hierarchical display of RECHECKs, EXITs
                # Level 2: RECHECK configuration (if exists)
                if signal.get('recheck_config'):
                    recheck_cfg = signal['recheck_config']
                    if recheck_cfg.get('enabled'):
                        bar_delay = recheck_cfg.get('bar_delay', 0)
                        recheck_mode = recheck_cfg.get('mode', 'WITHIN')
                        
                        # Create recheck row with input and buttons
                        recheck_row_layout = QHBoxLayout()
                        recheck_row_layout.setSpacing(8)
                        
                        # FIXED INDENT: 4 spaces (Level 2 - sibling to TIME CONSTRAINT and EXIT)
                        recheck_text = f"    └── RECHECK ({recheck_mode} {bar_delay} bars)"
                        recheck_label = QLabel(recheck_text)
                        recheck_label.setStyleSheet(get_label_style('success') + " font-size: 9pt; font-weight: bold;")
                        recheck_label.setToolTip(f"This signal must reoccur within {bar_delay} bars for validation")
                        recheck_row_layout.addWidget(recheck_label, stretch=1)
                        
                        # Gear icon button for RECHECK configuration
                        gear_btn = QPushButton("⚙")
                        set_hand_cursor(gear_btn)
                        gear_btn.setStyleSheet(get_recheck_gear_button_stylesheet())
                        gear_btn.setToolTip("Configure RECHECK validation")
                        gear_btn.clicked.connect(
                            lambda checked, sname=signal_name: self._on_recheck_config_clicked(sname)
                        )
                        recheck_row_layout.addWidget(gear_btn)
                        
                        # Duplicate button for nested RECHECK
                        duplicate_btn = QPushButton("⎘")
                        set_hand_cursor(duplicate_btn)
                        duplicate_btn.setStyleSheet(get_recheck_duplicate_button_stylesheet())
                        duplicate_btn.setToolTip("Add nested RECHECK validation")
                        duplicate_btn.clicked.connect(
                            lambda checked, sname=signal_name: self._on_recheck_duplicate_clicked(sname)
                        )
                        recheck_row_layout.addWidget(duplicate_btn)
                        
                        # Remove recheck button
                        remove_recheck_btn = QPushButton("✕")
                        set_hand_cursor(remove_recheck_btn)
                        remove_recheck_btn.setStyleSheet(get_recheck_remove_button_stylesheet())
                        remove_recheck_btn.setToolTip("Remove recheck validation")
                        remove_recheck_btn.clicked.connect(
                            lambda checked, sname=signal_name: self._on_remove_recheck(sname)
                        )
                        recheck_row_layout.addWidget(remove_recheck_btn)
                        
                        signals_layout.addLayout(recheck_row_layout)
                        
                        # Level 3: Nested RECHECKs (if exist)
                        if signal.get('recheck_chain'):
                            for chain_idx, nested_recheck in enumerate(signal['recheck_chain'], 1):
                                if nested_recheck.get('enabled'):
                                    nested_delay = nested_recheck.get('bar_delay', 0)
                                    validation_mode = nested_recheck.get('validation_mode', 'SIGNAL')
                                    nested_mode = nested_recheck.get('mode', 'WITHIN')
                                    
                                    # Create nested recheck row
                                    nested_row_layout = QHBoxLayout()
                                    nested_row_layout.setSpacing(8)
                                    
                                    # Determine validation target description
                                    # FIXED INDENTATION (matching Browser): All nested RECHECKs use same indent level
                                    if validation_mode == "SIGNAL":
                                        target_desc = "of Signal"
                                    else:
                                        target_desc = "of RECHECK"
                                    
                                    # Show mode in display: "AT 2 bars" or "WITHIN 2 bars"
                                    # FIXED INDENT: 8 spaces (Level 3 - matching Browser)
                                    mode_display = f"{nested_mode} {nested_delay} bars"
                                    nested_text = f"        └── RECHECK {target_desc} ({mode_display})"
                                    nested_label = QLabel(nested_text)
                                    nested_label.setStyleSheet(get_label_style('info') + " font-size: 9pt;")
                                    nested_label.setToolTip(
                                        f"Nested RECHECK validation\n"
                                        f"Validates against: {'Original Signal' if validation_mode == 'SIGNAL' else 'Previous RECHECK'}\n"
                                        f"Bar delay: {nested_delay}\n"
                                        f"Mode: {nested_mode}"
                                    )
                                    nested_row_layout.addWidget(nested_label, stretch=1)
                                    
                                    # Add config/duplicate/remove buttons (same as primary RECHECK)
                                    # Config button
                                    nested_config_btn = QPushButton("⚙")
                                    set_hand_cursor(nested_config_btn)
                                    nested_config_btn.setStyleSheet(get_recheck_gear_button_stylesheet())
                                    nested_config_btn.setToolTip("Configure nested RECHECK")
                                    # Connect to handler with chain index
                                    nested_config_btn.clicked.connect(
                                        lambda checked, sname=signal_name, idx=chain_idx-1: 
                                            self._on_nested_recheck_config_clicked(sname, idx)
                                    )
                                    nested_row_layout.addWidget(nested_config_btn)
                                    
                                    # Duplicate button
                                    nested_duplicate_btn = QPushButton("⎘")
                                    set_hand_cursor(nested_duplicate_btn)
                                    nested_duplicate_btn.setStyleSheet(get_recheck_duplicate_button_stylesheet())
                                    nested_duplicate_btn.setToolTip("Add another nested RECHECK")
                                    # Reuse the same handler - it will add another nested RECHECK
                                    nested_duplicate_btn.clicked.connect(
                                        lambda checked, sname=signal_name: self._on_recheck_duplicate_clicked(sname)
                                    )
                                    nested_row_layout.addWidget(nested_duplicate_btn)
                                    
                                    # Remove button
                                    nested_remove_btn = QPushButton("✕")
                                    set_hand_cursor(nested_remove_btn)
                                    nested_remove_btn.setStyleSheet(get_recheck_remove_button_stylesheet())
                                    nested_remove_btn.setToolTip("Remove this nested RECHECK")
                                    # Connect to handler with chain index
                                    nested_remove_btn.clicked.connect(
                                        lambda checked, sname=signal_name, idx=chain_idx-1:
                                            self._on_nested_recheck_remove_clicked(sname, idx)
                                    )
                                    nested_row_layout.addWidget(nested_remove_btn)
                                    
                                    signals_layout.addLayout(nested_row_layout)
                
                # Level 4: Exit Conditions (Sprint 1.8 Task 1.8.48) - after RECHECK chains
                if signal.get('exit_conditions'):
                    for exit_cond in signal['exit_conditions']:
                        current_exit_signal_name = exit_cond.get('signal_name', 'Unknown')
                        exit_percentage = exit_cond.get('percentage', 0.5)
                        exit_mode = exit_cond.get('exit_mode', 'ABSOLUTE')
                        
                        # Format percentage for display (0.5 -> 50%)
                        pct_display = int(exit_percentage * 100)
                        
                        # Create exit condition row
                        exit_row_layout = QHBoxLayout()
                        exit_row_layout.setSpacing(8)
                        
                        # FIXED INDENT: 4 spaces (same level as primary RECHECK - siblings, not children)
                        exit_text = f"    └── 🔴 EXIT: {current_exit_signal_name} ({pct_display}%)"
                        exit_label = QLabel(exit_text)
                        exit_label.setStyleSheet(get_exit_tree_item_style() + " font-size: 9pt;")
                        exit_label.setToolTip(
                            f"Signal-Level Exit Condition\n"
                            f"Signal: {current_exit_signal_name}\n"
                            f"Percentage: {pct_display}%\n"
                            f"Mode: {exit_mode}\n"
                            f"Binding: SIGNAL"
                        )
                        exit_row_layout.addWidget(exit_label, stretch=1)
                        
                        # Config button - same style as other exits
                        exit_config_btn = QPushButton("⚙")
                        set_hand_cursor(exit_config_btn)
                        exit_config_btn.setStyleSheet(get_recheck_gear_button_stylesheet())
                        exit_config_btn.setToolTip("Configure signal exit condition")
                        exit_config_btn.clicked.connect(
                            lambda checked, bname=self.block_name, sname=signal_name, esig=current_exit_signal_name:
                                self._on_signal_exit_config_clicked(bname, sname, esig)
                        )
                        exit_row_layout.addWidget(exit_config_btn)
                        
                        # Duplicate button - add another exit to this signal
                        exit_duplicate_btn = QPushButton("⎘")
                        set_hand_cursor(exit_duplicate_btn)
                        exit_duplicate_btn.setStyleSheet(get_recheck_duplicate_button_stylesheet())
                        exit_duplicate_btn.setToolTip("Add another exit condition to this signal")
                        exit_duplicate_btn.clicked.connect(
                            lambda checked, bname=self.block_name, sname=signal_name, esig=current_exit_signal_name:
                                self._on_signal_exit_duplicate_clicked(bname, sname, esig)
                        )
                        exit_row_layout.addWidget(exit_duplicate_btn)
                        
                        # Remove button - remove this exit
                        exit_remove_btn = QPushButton("✕")
                        set_hand_cursor(exit_remove_btn)
                        exit_remove_btn.setStyleSheet(get_recheck_remove_button_stylesheet())
                        exit_remove_btn.setToolTip("Remove this signal exit condition")
                        exit_remove_btn.clicked.connect(
                            lambda checked, bname=self.block_name, sname=signal_name, esig=current_exit_signal_name:
                                self._on_signal_exit_remove_clicked(bname, sname, esig)
                        )
                        exit_row_layout.addWidget(exit_remove_btn)
                        
                        signals_layout.addLayout(exit_row_layout)
                        
                        # Level 5: RECHECK for Exit Condition (if exists)
                        if exit_cond.get('recheck_config'):
                            recheck_cfg = exit_cond['recheck_config']
                            if recheck_cfg.get('enabled'):
                                bar_delay = recheck_cfg.get('bar_delay', 0)
                                recheck_mode = recheck_cfg.get('mode', 'WITHIN')
                                
                                # Create RECHECK row with buttons
                                recheck_row_layout = QHBoxLayout()
                                recheck_row_layout.setSpacing(8)
                                
                                # FIXED INDENT: 8 spaces (Level 3 - child of EXIT at Level 2)
                                recheck_text = f"        └── RECHECK ({recheck_mode} {bar_delay} bars)"
                                recheck_label = QLabel(recheck_text)
                                recheck_label.setStyleSheet(get_label_style('success') + " font-size: 9pt; font-weight: bold;")
                                recheck_label.setToolTip(f"Exit signal must reoccur within {bar_delay} bars for validation")
                                recheck_row_layout.addWidget(recheck_label, stretch=1)
                                
                                # Gear icon button for RECHECK configuration
                                recheck_gear_btn = QPushButton("⚙")
                                set_hand_cursor(recheck_gear_btn)
                                recheck_gear_btn.setStyleSheet(get_recheck_gear_button_stylesheet())
                                recheck_gear_btn.setToolTip("Configure RECHECK validation for this exit")
                                recheck_gear_btn.clicked.connect(
                                    lambda checked, bname=self.block_name, sname=signal_name, esig=current_exit_signal_name:
                                        self._on_exit_recheck_config_clicked(bname, sname, esig)
                                )
                                recheck_row_layout.addWidget(recheck_gear_btn)
                                
                                # Remove recheck button
                                recheck_remove_btn = QPushButton("✕")
                                set_hand_cursor(recheck_remove_btn)
                                recheck_remove_btn.setStyleSheet(get_recheck_remove_button_stylesheet())
                                recheck_remove_btn.setToolTip("Remove RECHECK validation from this exit")
                                recheck_remove_btn.clicked.connect(
                                    lambda checked, bname=self.block_name, sname=signal_name, esig=current_exit_signal_name:
                                        self._on_exit_recheck_remove_clicked(bname, sname, esig)
                                )
                                recheck_row_layout.addWidget(recheck_remove_btn)
                                
                                signals_layout.addLayout(recheck_row_layout)
            
            signals_widget.setLayout(signals_layout)
            layout.addWidget(signals_widget)
        
        # Block-level exit conditions (Sprint 1.8 - display exits bound to this block)
        if hasattr(self.block_info, 'exit_conditions') or (isinstance(self.block_info, dict) and 'exit_conditions' in self.block_info):
            # Get exit conditions for this block
            exit_conditions = self.block_info.get('exit_conditions', []) if isinstance(self.block_info, dict) else getattr(self.block_info, 'exit_conditions', [])
            
            if exit_conditions:
                # Create frame for block-level exits
                block_exits_widget = QFrame()
                block_exits_widget.setFrameShape(QFrame.StyledPanel)
                from src.strategy_builder.ui.styles import get_color
                block_exits_widget.setStyleSheet(
                    f"background-color: {get_color('bg_light')}; "
                    f"border: 1px solid {get_color('border')}; "
                    f"border-radius: 6px; padding: 5px;"
                )
                
                block_exits_layout = QVBoxLayout()
                block_exits_layout.setContentsMargins(10, 5, 10, 5)
                
                # Header
                exits_header = QLabel("Block-Level Exit Conditions:")
                exits_header.setStyleSheet(get_label_style('error') + " font-weight: bold;")
                block_exits_layout.addWidget(exits_header)
                
                # Display each exit
                for exit_cond in exit_conditions:
                    current_exit_signal_name = exit_cond.get('signal_name', 'Unknown')
                    exit_percentage = exit_cond.get('percentage', 0.5)
                    exit_mode = exit_cond.get('exit_mode', 'ABSOLUTE')
                    
                    pct_display = int(exit_percentage * 100)
                    
                    # Create exit row
                    exit_row_layout = QHBoxLayout()
                    exit_row_layout.setSpacing(8)
                    
                    exit_text = f"🔴  {current_exit_signal_name} ({pct_display}%) - {exit_mode} mode"
                    exit_label = QLabel(exit_text)
                    exit_label.setStyleSheet(get_exit_tree_item_style() + " font-size: 9pt;")  # Removed bold
                    exit_label.setToolTip(
                        f"Block-Level Exit Condition\n"
                        f"Signal: {current_exit_signal_name}\n"
                        f"Percentage: {pct_display}%\n"
                        f"Mode: {exit_mode}\n"
                        f"Binding: BLOCK"
                    )
                    exit_row_layout.addWidget(exit_label, stretch=1)
                    
                    # Config/Edit button - same style as strategy exit buttons
                    config_btn = QPushButton("⚙")
                    set_hand_cursor(config_btn)
                    config_btn.setStyleSheet(get_recheck_gear_button_stylesheet())
                    config_btn.setToolTip("Configure block exit condition")
                    # Use lambda to call panel method with captured variables
                    config_btn.clicked.connect(
                        lambda checked, bname=self.block_name, sname=current_exit_signal_name: 
                            self._on_block_exit_config_clicked(bname, sname)
                    )
                    exit_row_layout.addWidget(config_btn)
                    
                    # Duplicate button - add another exit to this block
                    duplicate_btn = QPushButton("⎘")
                    set_hand_cursor(duplicate_btn)
                    duplicate_btn.setStyleSheet(get_recheck_duplicate_button_stylesheet())
                    duplicate_btn.setToolTip("Add another exit condition to this block")
                    duplicate_btn.clicked.connect(
                        lambda checked, bname=self.block_name, esig=current_exit_signal_name:
                            self._on_duplicate_block_exit_clicked(bname, esig)
                    )
                    exit_row_layout.addWidget(duplicate_btn)
                    
                    # Remove button - same style as strategy exit buttons
                    remove_btn = QPushButton("✕")
                    set_hand_cursor(remove_btn)
                    remove_btn.setStyleSheet(get_recheck_remove_button_stylesheet())
                    remove_btn.setToolTip("Remove this block exit condition")
                    # Use lambda to call panel method with captured variables
                    remove_btn.clicked.connect(
                        lambda checked, bname=self.block_name, sname=current_exit_signal_name:
                            self._on_block_exit_remove_clicked(bname, sname)
                    )
                    exit_row_layout.addWidget(remove_btn)
                    
                    block_exits_layout.addLayout(exit_row_layout)
                
                block_exits_widget.setLayout(block_exits_layout)
                layout.addWidget(block_exits_widget)
        
        # Styling - dark theme
        from src.strategy_builder.ui.styles import get_color
        self.setStyleSheet(f"""
            BlockConfigItem {{
                border: 2px solid {get_color('button_primary')};
                border-radius: 8px;
                background-color: {get_color('bg_medium')};
            }}
        """)
        
        self.setLayout(layout)
    
    def _on_recheck_clicked(self, signal_name: str):
        """Handle recheck button click - show dialog to configure bar delay and mode."""
        from PyQt5.QtWidgets import QDialog, QVBoxLayout, QSpinBox, QPushButton, QLabel, QRadioButton, QButtonGroup, QFrame
        
        dialog = QDialog(self)
        dialog.setWindowTitle("Configure RECHECK Validation")
        dialog.setStyleSheet(get_dialog_stylesheet())
        layout = QVBoxLayout()
        layout.setSpacing(15)
        layout.setContentsMargins(20, 20, 20, 20)
        
        # Signal name label
        signal_label = QLabel(f"Signal: {signal_name}")
        signal_label.setStyleSheet(get_label_style('info') + " font-weight: bold; font-size: 11pt;")
        layout.addWidget(signal_label)
        
        # Description
        desc = QLabel("Enter number of bars within which signal must reoccur for validation:")
        desc.setWordWrap(True)
        desc.setStyleSheet(get_label_style('info'))
        layout.addWidget(desc)
        
        # Bar delay spinner
        delay_input = QSpinBox()
        delay_input.setRange(1, 500)
        delay_input.setValue(3)
        delay_input.setStyleSheet(get_spinbox_button_stylesheet())
        layout.addWidget(delay_input)
        
        # RECHECK Mode Selection
        layout.addSpacing(10)
        mode_label = QLabel("RECHECK Mode:")
        mode_label.setStyleSheet(get_label_style('info') + " font-weight: bold;")
        layout.addWidget(mode_label)
        
        mode_container = QFrame()
        mode_container.setStyleSheet(get_radio_container_stylesheet())
        mode_layout = QVBoxLayout()
        mode_layout.setSpacing(10)
        
        mode_group = QButtonGroup(dialog)
        
        within_radio = QRadioButton("WITHIN bar window (signal reoccurs anywhere within N bars)")
        within_radio.setStyleSheet(get_signal_radio_stylesheet())
        within_radio.setChecked(True)
        mode_group.addButton(within_radio)
        mode_layout.addWidget(within_radio)
        
        at_radio = QRadioButton("AT exact bar (signal reoccurs at exactly bar N)")
        at_radio.setStyleSheet(get_recheck_radio_stylesheet())
        mode_group.addButton(at_radio)
        mode_layout.addWidget(at_radio)
        
        mode_container.setLayout(mode_layout)
        layout.addWidget(mode_container)
        
        layout.addSpacing(15)
        
        # Buttons
        button_layout = QHBoxLayout()
        button_layout.setSpacing(10)
        
        cancel_btn = QPushButton("✕ Cancel")
        set_hand_cursor(cancel_btn)
        cancel_btn.setStyleSheet(get_danger_button_stylesheet())
        cancel_btn.clicked.connect(dialog.reject)
        button_layout.addWidget(cancel_btn)
        
        ok_btn = QPushButton("✓ OK")
        set_hand_cursor(ok_btn)
        ok_btn.setStyleSheet(get_success_button_stylesheet())
        ok_btn.clicked.connect(dialog.accept)
        button_layout.addWidget(ok_btn)
        
        layout.addLayout(button_layout)
        dialog.setLayout(layout)
        
        if dialog.exec_() == QDialog.Accepted:
            bar_delay = delay_input.value()
            mode = "WITHIN" if within_radio.isChecked() else "AT"
            
            # Find the StrategyBlocksPanel (traverse up the widget tree)
            panel = self._find_strategy_blocks_panel()
            if panel and hasattr(panel, '_on_signal_recheck_configured'):
                panel._on_signal_recheck_configured(self.block_name, signal_name, bar_delay, mode)
    
    def _on_recheck_config_clicked(self, signal_name: str):
        """Handle recheck gear icon click - show configuration dialog with mode."""
        from PyQt5.QtWidgets import QDialog, QVBoxLayout, QSpinBox, QPushButton, QLabel, QRadioButton, QButtonGroup, QFrame
        
        # Get current config
        config = self.orchestrator.get_current_config()
        if not config:
            return
            
        # Find current recheck config
        current_delay = 25
        current_mode = "WITHIN"  # Default
        for block in config.blocks:
            if block.name == self.block_name:
                for signal in block.signals:
                    if signal.name == signal_name and signal.recheck_config:
                        current_delay = signal.recheck_config.bar_delay
                        current_mode = getattr(signal.recheck_config, 'mode', 'WITHIN')
                        break
                break
        
        # Create custom dialog
        dialog = QDialog(self)
        dialog.setWindowTitle("Configure RECHECK Validation")
        dialog.setStyleSheet(get_dialog_stylesheet())
        layout = QVBoxLayout()
        layout.setSpacing(15)
        layout.setContentsMargins(20, 20, 20, 20)
        
        # Signal name label
        signal_label = QLabel(f"Signal: {signal_name}")
        signal_label.setStyleSheet(get_label_style('info') + " font-weight: bold; font-size: 11pt;")
        layout.addWidget(signal_label)
        
        # Description
        desc = QLabel("Enter number of bars within which signal must reoccur for validation:")
        desc.setWordWrap(True)
        desc.setStyleSheet(get_label_style('info'))
        layout.addWidget(desc)
        
        # Bar delay spinner
        delay_input = QSpinBox()
        delay_input.setRange(1, 500)
        delay_input.setValue(current_delay)
        delay_input.setStyleSheet(get_spinbox_button_stylesheet())
        layout.addWidget(delay_input)
        
        # RECHECK Mode Selection
        layout.addSpacing(10)
        mode_label = QLabel("RECHECK Mode:")
        mode_label.setStyleSheet(get_label_style('info') + " font-weight: bold;")
        layout.addWidget(mode_label)
        
        mode_container = QFrame()
        mode_container.setStyleSheet(get_radio_container_stylesheet())
        mode_layout = QVBoxLayout()
        mode_layout.setSpacing(10)
        
        mode_group = QButtonGroup(dialog)
        
        within_radio = QRadioButton("WITHIN bar window (signal reoccurs anywhere within N bars)")
        within_radio.setStyleSheet(get_signal_radio_stylesheet())
        within_radio.setChecked(current_mode == "WITHIN")
        mode_group.addButton(within_radio)
        mode_layout.addWidget(within_radio)
        
        at_radio = QRadioButton("AT exact bar (signal reoccurs at exactly bar N)")
        at_radio.setStyleSheet(get_recheck_radio_stylesheet())
        at_radio.setChecked(current_mode == "AT")
        mode_group.addButton(at_radio)
        mode_layout.addWidget(at_radio)
        
        mode_container.setLayout(mode_layout)
        layout.addWidget(mode_container)
        
        layout.addSpacing(15)
        
        # Buttons
        button_layout = QHBoxLayout()
        button_layout.setSpacing(10)
        
        cancel_btn = QPushButton("✕ Cancel")
        set_hand_cursor(cancel_btn)
        cancel_btn.setStyleSheet(get_danger_button_stylesheet())
        cancel_btn.clicked.connect(dialog.reject)
        button_layout.addWidget(cancel_btn)
        
        ok_btn = QPushButton("✓ OK")
        set_hand_cursor(ok_btn)
        ok_btn.setStyleSheet(get_success_button_stylesheet())
        ok_btn.clicked.connect(dialog.accept)
        button_layout.addWidget(ok_btn)
        
        layout.addLayout(button_layout)
        dialog.setLayout(layout)
        
        if dialog.exec_() == QDialog.Accepted:
            bar_delay = delay_input.value()
            mode = "WITHIN" if within_radio.isChecked() else "AT"
            
            # Find the StrategyBlocksPanel
            panel = self._find_strategy_blocks_panel()
            if panel and hasattr(panel, '_on_signal_recheck_configured'):
                panel._on_signal_recheck_configured(self.block_name, signal_name, bar_delay, mode)
    
    def _on_recheck_duplicate_clicked(self, signal_name: str):
        """Handle recheck duplicate button click - show nested recheck dialog."""
        from PyQt5.QtWidgets import QDialog, QVBoxLayout, QCheckBox, QSpinBox, QPushButton, QLabel, QDialogButtonBox
        
        dialog = QDialog(self)
        dialog.setWindowTitle("Add Nested RECHECK")
        dialog.setStyleSheet(get_dialog_stylesheet())
        layout = QVBoxLayout()
        layout.setSpacing(15)
        layout.setContentsMargins(20, 20, 20, 20)
        
        # Add description with styling
        desc = QLabel(
            f"Configure nested RECHECK validation for {signal_name}.\n"
            "Choose what to validate against and specify the bar delay."
        )
        desc.setWordWrap(True)
        desc.setStyleSheet(get_label_style('info'))
        desc.setMinimumHeight(50)
        layout.addWidget(desc)
        
        # Add spacing
        layout.addSpacing(10)
        
        # Add validation target selection
        target_label = QLabel("Validate Against:")
        target_label.setStyleSheet(get_label_style('info') + " font-weight: bold;")
        layout.addWidget(target_label)
        
        from PyQt5.QtWidgets import QRadioButton, QButtonGroup, QFrame
        
        # Create radio button container with background
        radio_container = QFrame()
        radio_container.setStyleSheet(get_radio_container_stylesheet())
        radio_layout = QVBoxLayout()
        radio_layout.setSpacing(10)
        
        # Create button group for mutual exclusion
        target_group = QButtonGroup(dialog)
        
        # Signal radio with green accent
        signal_radio = QRadioButton("Original Signal")
        signal_radio.setStyleSheet(get_signal_radio_stylesheet())
        signal_radio.setChecked(True)
        target_group.addButton(signal_radio)
        radio_layout.addWidget(signal_radio)
        
        # RECHECK radio with blue accent
        recheck_radio = QRadioButton("Previous RECHECK")
        recheck_radio.setStyleSheet(get_recheck_radio_stylesheet())
        target_group.addButton(recheck_radio)
        radio_layout.addWidget(recheck_radio)
        
        radio_container.setLayout(radio_layout)
        layout.addWidget(radio_container)
        
        # Add spacing
        layout.addSpacing(10)
        
        # Add bar delay input with styling
        delay_label = QLabel("Bar Delay:")
        delay_label.setStyleSheet(get_label_style('info') + " font-weight: bold;")
        layout.addWidget(delay_label)
        
        delay_input = QSpinBox()
        delay_input.setRange(1, 500)
        delay_input.setValue(25)
        delay_input.setStyleSheet(get_spinbox_button_stylesheet())
        layout.addWidget(delay_input)
        
        # Add spacing for mode section
        layout.addSpacing(10)
        
        # RECHECK Mode Selection
        mode_label = QLabel("RECHECK Mode:")
        mode_label.setStyleSheet(get_label_style('info') + " font-weight: bold;")
        layout.addWidget(mode_label)
        
        mode_container = QFrame()
        mode_container.setStyleSheet(get_radio_container_stylesheet())
        mode_layout = QVBoxLayout()
        mode_layout.setSpacing(10)
        
        mode_group = QButtonGroup(dialog)
        
        within_radio = QRadioButton("WITHIN bar window (signal reoccurs anywhere within N bars)")
        within_radio.setStyleSheet(get_signal_radio_stylesheet())
        within_radio.setChecked(True)
        mode_group.addButton(within_radio)
        mode_layout.addWidget(within_radio)
        
        at_radio = QRadioButton("AT exact bar (signal reoccurs at exactly bar N)")
        at_radio.setStyleSheet(get_recheck_radio_stylesheet())
        mode_group.addButton(at_radio)
        mode_layout.addWidget(at_radio)
        
        mode_container.setLayout(mode_layout)
        layout.addWidget(mode_container)
        
        # Add spacing
        layout.addSpacing(15)
        
        # Add dialog buttons with custom styling
        button_layout = QHBoxLayout()
        button_layout.setSpacing(10)
        
        cancel_btn = QPushButton("Cancel")
        set_hand_cursor(cancel_btn)
        cancel_btn.setStyleSheet(get_danger_button_stylesheet())
        cancel_btn.clicked.connect(dialog.reject)
        button_layout.addWidget(cancel_btn)
        
        ok_btn = QPushButton("OK")
        set_hand_cursor(ok_btn)
        ok_btn.setStyleSheet(get_success_button_stylesheet())
        ok_btn.clicked.connect(dialog.accept)
        button_layout.addWidget(ok_btn)
        
        layout.addLayout(button_layout)
        
        dialog.setLayout(layout)
        
        if dialog.exec_() == QDialog.Accepted:
            # Process the nested recheck configuration
            validate_against = "SIGNAL" if signal_radio.isChecked() else "RECHECK"
            bar_delay = delay_input.value()
            mode = "WITHIN" if within_radio.isChecked() else "AT"
            
            # Find the StrategyBlocksPanel
            panel = self._find_strategy_blocks_panel()
            if panel and hasattr(panel, '_on_nested_recheck_configured'):
                panel._on_nested_recheck_configured(
                    self.block_name,
                    signal_name,
                    validate_against,
                    bar_delay,
                    mode
                )
    
    def _on_remove_recheck(self, signal_name: str):
        """Handle remove recheck button click."""
        # Find the StrategyBlocksPanel (traverse up the widget tree)
        panel = self._find_strategy_blocks_panel()
        if panel and hasattr(panel, '_on_signal_recheck_removed'):
            panel._on_signal_recheck_removed(self.block_name, signal_name)
    
    def _on_block_exit_config_clicked(self, block_name: str, signal_name: str):
        """Handle config button for block-level exit - forward to panel."""
        panel = self._find_strategy_blocks_panel()
        if panel and hasattr(panel, '_on_edit_block_exit'):
            panel._on_edit_block_exit(block_name, signal_name)
    
    def _on_block_exit_remove_clicked(self, block_name: str, signal_name: str):
        """Handle remove button for block-level exit - forward to panel."""
        panel = self._find_strategy_blocks_panel()
        if panel and hasattr(panel, '_on_remove_block_exit'):
            panel._on_remove_block_exit(block_name, signal_name)
    
    def _on_duplicate_block_exit_clicked(self, block_name: str, exit_signal_name: str):
        """Handle duplicate button for block-level exit - forward to panel."""
        panel = self._find_strategy_blocks_panel()
        if panel and hasattr(panel, '_on_duplicate_block_exit'):
            panel._on_duplicate_block_exit(block_name, exit_signal_name)
    
    def _on_signal_exit_config_clicked(self, block_name: str, signal_name: str, exit_signal_name: str):
        """Handle config button for signal-level exit - forward to panel."""
        panel = self._find_strategy_blocks_panel()
        if panel and hasattr(panel, '_on_signal_exit_config_clicked'):
            panel._on_signal_exit_config_clicked(block_name, signal_name, exit_signal_name)
    
    def _on_signal_exit_duplicate_clicked(self, block_name: str, signal_name: str, exit_signal_name: str):
        """Handle duplicate button for signal-level exit - forward to panel with signal name."""
        panel = self._find_strategy_blocks_panel()
        if panel and hasattr(panel, '_on_signal_exit_duplicate_clicked'):
            panel._on_signal_exit_duplicate_clicked(block_name, signal_name, exit_signal_name)
    
    def _on_signal_exit_remove_clicked(self, block_name: str, signal_name: str, exit_signal_name: str):
        """Handle remove button for signal-level exit - forward to panel."""
        panel = self._find_strategy_blocks_panel()
        if panel and hasattr(panel, '_on_signal_exit_remove_clicked'):
            panel._on_signal_exit_remove_clicked(block_name, signal_name, exit_signal_name)
    
    def _on_exit_recheck_config_clicked(self, block_name: str, signal_name: str, exit_signal_name: str):
        """Handle config button for exit condition RECHECK - show full dialog with mode."""
        from PyQt5.QtWidgets import QDialog, QVBoxLayout, QSpinBox, QPushButton, QLabel, QRadioButton, QButtonGroup, QFrame
        
        # Get current config
        config = self.orchestrator.get_current_config()
        if not config:
            return
        
        # Find current exit and its RECHECK config
        current_delay = 25
        current_mode = "WITHIN"
        for block in config.blocks:
            if block.name == block_name:
                for signal in block.signals:
                    if signal.name == signal_name:
                        if hasattr(signal, 'exit_conditions') and signal.exit_conditions:
                            for exit_cond in signal.exit_conditions:
                                if exit_cond.signal_name == exit_signal_name:
                                    if exit_cond.recheck_config:
                                        current_delay = exit_cond.recheck_config.bar_delay
                                        current_mode = getattr(exit_cond.recheck_config, 'mode', 'WITHIN')
                                    break
                        break
                break
        
        # Create full dialog
        dialog = QDialog(self)
        dialog.setWindowTitle("Configure Exit RECHECK Validation")
        dialog.setStyleSheet(get_dialog_stylesheet())
        layout = QVBoxLayout()
        layout.setSpacing(15)
        layout.setContentsMargins(20, 20, 20, 20)
        
        # Exit signal label
        signal_label = QLabel(f"Exit Signal: {exit_signal_name}")
        signal_label.setStyleSheet(get_label_style('info') + " font-weight: bold; font-size: 11pt;")
        layout.addWidget(signal_label)
        
        # Description
        desc = QLabel("Enter number of bars within which exit signal must reoccur for validation:")
        desc.setWordWrap(True)
        desc.setStyleSheet(get_label_style('info'))
        layout.addWidget(desc)
        
        # Bar delay spinner
        delay_input = QSpinBox()
        delay_input.setRange(1, 500)
        delay_input.setValue(current_delay)
        delay_input.setStyleSheet(get_spinbox_button_stylesheet())
        layout.addWidget(delay_input)
        
        # RECHECK Mode Selection
        layout.addSpacing(10)
        mode_label = QLabel("RECHECK Mode:")
        mode_label.setStyleSheet(get_label_style('info') + " font-weight: bold;")
        layout.addWidget(mode_label)
        
        mode_container = QFrame()
        mode_container.setStyleSheet(get_radio_container_stylesheet())
        mode_layout = QVBoxLayout()
        mode_layout.setSpacing(10)
        
        mode_group = QButtonGroup(dialog)
        
        within_radio = QRadioButton("WITHIN bar window (signal reoccurs anywhere within N bars)")
        within_radio.setStyleSheet(get_signal_radio_stylesheet())
        within_radio.setChecked(current_mode == "WITHIN")
        mode_group.addButton(within_radio)
        mode_layout.addWidget(within_radio)
        
        at_radio = QRadioButton("AT exact bar (signal reoccurs at exactly bar N)")
        at_radio.setStyleSheet(get_recheck_radio_stylesheet())
        at_radio.setChecked(current_mode == "AT")
        mode_group.addButton(at_radio)
        mode_layout.addWidget(at_radio)
        
        mode_container.setLayout(mode_layout)
        layout.addWidget(mode_container)
        
        layout.addSpacing(15)
        
        # Buttons
        button_layout = QHBoxLayout()
        button_layout.setSpacing(10)
        
        cancel_btn = QPushButton("✕ Cancel")
        set_hand_cursor(cancel_btn)
        cancel_btn.setStyleSheet(get_danger_button_stylesheet())
        cancel_btn.clicked.connect(dialog.reject)
        button_layout.addWidget(cancel_btn)
        
        ok_btn = QPushButton("✓ OK")
        set_hand_cursor(ok_btn)
        ok_btn.setStyleSheet(get_success_button_stylesheet())
        ok_btn.clicked.connect(dialog.accept)
        button_layout.addWidget(ok_btn)
        
        layout.addLayout(button_layout)
        dialog.setLayout(layout)
        
        if dialog.exec_() == QDialog.Accepted:
            bar_delay = delay_input.value()
            mode = "WITHIN" if within_radio.isChecked() else "AT"
            
            # Update via panel method
            panel = self._find_strategy_blocks_panel()
            if panel and hasattr(panel, '_on_exit_recheck_configured'):
                panel._on_exit_recheck_configured(block_name, signal_name, exit_signal_name, bar_delay, mode)
    
    def _on_exit_recheck_remove_clicked(self, block_name: str, signal_name: str, exit_signal_name: str):
        """Handle remove button for exit condition RECHECK."""
        panel = self._find_strategy_blocks_panel()
        if panel and hasattr(panel, '_on_exit_recheck_removed'):
            panel._on_exit_recheck_removed(block_name, signal_name, exit_signal_name)
    
    def _on_nested_recheck_config_clicked(self, signal_name: str, chain_index: int):
        """Handle config button for nested RECHECK - show dialog to edit."""
        from PyQt5.QtWidgets import QDialog, QVBoxLayout, QSpinBox, QPushButton, QLabel, QRadioButton, QButtonGroup, QFrame
        
        # Get current config
        config = self.orchestrator.get_current_config()
        if not config:
            return
        
        # Find nested RECHECK in chain
        current_delay = 25
        current_mode = "WITHIN"
        current_validation_mode = "SIGNAL"
        
        for block in config.blocks:
            if block.name == self.block_name:
                for signal in block.signals:
                    if signal.name == signal_name:
                        if hasattr(signal, 'recheck_chain') and signal.recheck_chain:
                            if 0 <= chain_index < len(signal.recheck_chain):
                                nested = signal.recheck_chain[chain_index]
                                current_delay = nested.bar_delay
                                current_mode = getattr(nested, 'mode', 'WITHIN')
                                current_validation_mode = getattr(nested, 'validation_mode', 'SIGNAL')
                        break
                break
        
        # Create dialog
        dialog = QDialog(self)
        dialog.setWindowTitle("Configure Nested RECHECK")
        dialog.setStyleSheet(get_dialog_stylesheet())
        layout = QVBoxLayout()
        layout.setSpacing(15)
        layout.setContentsMargins(20, 20, 20, 20)
        
        # Signal label
        signal_label = QLabel(f"Nested RECHECK for: {signal_name}")
        signal_label.setStyleSheet(get_label_style('info') + " font-weight: bold; font-size: 11pt;")
        layout.addWidget(signal_label)
        
        # Validate against selector
        target_label = QLabel("Validate Against:")
        target_label.setStyleSheet(get_label_style('info') + " font-weight: bold;")
        layout.addWidget(target_label)
        
        radio_container = QFrame()
        radio_container.setStyleSheet(get_radio_container_stylesheet())
        radio_layout = QVBoxLayout()
        radio_layout.setSpacing(10)
        
        target_group = QButtonGroup(dialog)
        
        signal_radio = QRadioButton("Original Signal")
        signal_radio.setStyleSheet(get_signal_radio_stylesheet())
        signal_radio.setChecked(current_validation_mode == "SIGNAL")
        target_group.addButton(signal_radio)
        radio_layout.addWidget(signal_radio)
        
        recheck_radio = QRadioButton("Previous RECHECK")
        recheck_radio.setStyleSheet(get_recheck_radio_stylesheet())
        recheck_radio.setChecked(current_validation_mode == "RECHECK")
        target_group.addButton(recheck_radio)
        radio_layout.addWidget(recheck_radio)
        
        radio_container.setLayout(radio_layout)
        layout.addWidget(radio_container)
        
        layout.addSpacing(10)
        
        # Bar delay
        delay_label = QLabel("Bar Delay:")
        delay_label.setStyleSheet(get_label_style('info') + " font-weight: bold;")
        layout.addWidget(delay_label)
        
        delay_input = QSpinBox()
        delay_input.setRange(1, 500)
        delay_input.setValue(current_delay)
        delay_input.setStyleSheet(get_spinbox_button_stylesheet())
        layout.addWidget(delay_input)
        
        layout.addSpacing(10)
        
        # Mode selector
        mode_label = QLabel("RECHECK Mode:")
        mode_label.setStyleSheet(get_label_style('info') + " font-weight: bold;")
        layout.addWidget(mode_label)
        
        mode_container = QFrame()
        mode_container.setStyleSheet(get_radio_container_stylesheet())
        mode_layout = QVBoxLayout()
        mode_layout.setSpacing(10)
        
        mode_group = QButtonGroup(dialog)
        
        within_radio = QRadioButton("WITHIN bar window (signal reoccurs anywhere within N bars)")
        within_radio.setStyleSheet(get_signal_radio_stylesheet())
        within_radio.setChecked(current_mode == "WITHIN")
        mode_group.addButton(within_radio)
        mode_layout.addWidget(within_radio)
        
        at_radio = QRadioButton("AT exact bar (signal reoccurs at exactly bar N)")
        at_radio.setStyleSheet(get_recheck_radio_stylesheet())
        at_radio.setChecked(current_mode == "AT")
        mode_group.addButton(at_radio)
        mode_layout.addWidget(at_radio)
        
        mode_container.setLayout(mode_layout)
        layout.addWidget(mode_container)
        
        layout.addSpacing(15)
        
        # Buttons
        button_layout = QHBoxLayout()
        button_layout.setSpacing(10)
        
        cancel_btn = QPushButton("✕ Cancel")
        set_hand_cursor(cancel_btn)
        cancel_btn.setStyleSheet(get_danger_button_stylesheet())
        cancel_btn.clicked.connect(dialog.reject)
        button_layout.addWidget(cancel_btn)
        
        ok_btn = QPushButton("✓ OK")
        set_hand_cursor(ok_btn)
        ok_btn.setStyleSheet(get_success_button_stylesheet())
        ok_btn.clicked.connect(dialog.accept)
        button_layout.addWidget(ok_btn)
        
        layout.addLayout(button_layout)
        dialog.setLayout(layout)
        
        if dialog.exec_() == QDialog.Accepted:
            validate_against = "SIGNAL" if signal_radio.isChecked() else "RECHECK"
            bar_delay = delay_input.value()
            mode = "WITHIN" if within_radio.isChecked() else "AT"
            
            # Update the nested RECHECK in chain
            panel = self._find_strategy_blocks_panel()
            if panel and hasattr(panel, '_on_nested_recheck_updated'):
                panel._on_nested_recheck_updated(
                    self.block_name,
                    signal_name,
                    chain_index,
                    validate_against,
                    bar_delay,
                    mode
                )
    
    def _on_nested_recheck_remove_clicked(self, signal_name: str, chain_index: int):
        """Handle remove button for nested RECHECK."""
        panel = self._find_strategy_blocks_panel()
        if panel and hasattr(panel, '_on_nested_recheck_removed'):
            panel._on_nested_recheck_removed(self.block_name, signal_name, chain_index)
    
    def _find_strategy_blocks_panel(self):
        """Find the StrategyBlocksPanel by traversing up the widget tree."""
        widget = self.parent()
        while widget is not None:
            if isinstance(widget, StrategyBlocksPanel):
                return widget
            widget = widget.parent()
        return None
    
    def update_position(self, position: int, total: int):
        """Update the position indicators and button states."""
        self.position = position
        self.total = total
        
        # Update button states
        self.up_button.setEnabled(position > 1)
        self.down_button.setEnabled(position < total)


class StrategyBlocksPanel(QWidget):
    """
    Panel for configuring strategy building blocks.
    
    Displays added blocks with reordering and removal capabilities.
    
    Signals:
        blocks_changed: Emitted when blocks are reordered or removed
    """
    
    blocks_changed = pyqtSignal()
    
    def __init__(self, orchestrator: StrategyBuilderOrchestrator, parent: Optional[QWidget] = None):
        """
        Initialize the Strategy Blocks Panel.
        
        Args:
            orchestrator: StrategyBuilderOrchestrator instance
            parent: Parent widget (optional)
        """
        super().__init__(parent)
        self.orchestrator = orchestrator
        
        # UI Components
        self.blocks_scroll_area: Optional[QScrollArea] = None
        self.blocks_container: Optional[QWidget] = None
        self.blocks_layout: Optional[QVBoxLayout] = None
        self.empty_label: Optional[QLabel] = None
        
        # Block items cache
        self.block_items: List[BlockConfigItem] = []
        
        self._init_ui()
        self._refresh_blocks()
    
    def _init_ui(self):
        """Initialize the user interface components."""
        layout = QVBoxLayout()
        layout.setSpacing(10)
        layout.setContentsMargins(10, 10, 10, 10)
        
        # Group box
        group_box = QGroupBox("🧩 Strategy Building Blocks")
        
        # Set title font programmatically (CSS doesn't work for QGroupBox::title)
        title_font = QFont()
        title_font.setPointSize(12)
        title_font.setBold(True)
        group_box.setFont(title_font)
        
        group_layout = QVBoxLayout()
        group_layout.setSpacing(15)
        group_layout.setContentsMargins(15, 20, 15, 15)  # Match backtest panel padding
        
        # Reset font for content (only title should be 12pt)
        content_font = QFont()
        content_font.setPointSize(10)
        
        # Info header
        info_layout = QHBoxLayout()
        info_label = QLabel("ℹ️ Blocks are executed in order from top to bottom")
        info_label.setFont(content_font)
        info_label.setStyleSheet(get_label_style('info') + " font-size: 9pt; font-style: italic; padding: 5px;")
        info_layout.addWidget(info_label)
        info_layout.addStretch()
        group_layout.addLayout(info_layout)
        
        # Scroll area for blocks
        self.blocks_scroll_area = QScrollArea()
        self.blocks_scroll_area.setWidgetResizable(True)
        self.blocks_scroll_area.setMinimumHeight(300)
        
        # Container widget for blocks
        self.blocks_container = QWidget()
        self.blocks_layout = QVBoxLayout()
        self.blocks_layout.setSpacing(10)
        self.blocks_layout.setContentsMargins(5, 5, 5, 5)
        
        # Empty state label - dark theme
        self.empty_label = QLabel("No blocks added yet.\n\nSearch and add blocks from the panel to the right.")
        self.empty_label.setAlignment(Qt.AlignCenter)
        self.empty_label.setStyleSheet(
            get_label_style('muted') + " font-size: 12pt; padding: 50px; "
            "background-color: #1E2128; border: 1px solid #3C4149; border-radius: 8px;"
        )
        self.blocks_layout.addWidget(self.empty_label)
        
        self.blocks_layout.addStretch()
        self.blocks_container.setLayout(self.blocks_layout)
        
        self.blocks_scroll_area.setWidget(self.blocks_container)
        group_layout.addWidget(self.blocks_scroll_area)
        
        group_box.setLayout(group_layout)
        layout.addWidget(group_box)
        
        # Sprint 1.8 Task 1.8.49: Strategy-level Exit Conditions Section
        self.strategy_exit_section = QGroupBox("🔴 Strategy Exit Conditions")
        exit_section_font = QFont()
        exit_section_font.setPointSize(12)
        exit_section_font.setBold(True)
        self.strategy_exit_section.setFont(exit_section_font)
        self.strategy_exit_section.setCheckable(True)
        self.strategy_exit_section.setChecked(True)  # EXPANDED by default - so buttons are visible!
        
        exit_section_layout = QVBoxLayout()
        exit_section_layout.setSpacing(10)
        exit_section_layout.setContentsMargins(15, 20, 15, 15)
        
        # Info text
        exit_info = QLabel("Strategy level exit conditions apply to the entire strategy and can trigger over any other signal or block specific exit condition.")
        exit_info.setStyleSheet(get_label_style('muted') + " font-size: 9pt; font-style: italic;")
        exit_section_layout.addWidget(exit_info)
        
        # Container for exit conditions list (no add button - use red button in search panel)
        self.strategy_exits_container = QWidget()
        self.strategy_exits_layout = QVBoxLayout()
        self.strategy_exits_layout.setSpacing(5)
        self.strategy_exits_layout.setContentsMargins(0, 10, 0, 0)
        self.strategy_exits_container.setLayout(self.strategy_exits_layout)
        exit_section_layout.addWidget(self.strategy_exits_container)
        
        self.strategy_exit_section.setLayout(exit_section_layout)
        layout.addWidget(self.strategy_exit_section)
        
        self.setLayout(layout)
    
    def _refresh_blocks(self):
        """Refresh the display from orchestrator's current configuration."""
        # Clear existing items
        self._clear_blocks()
        
        # Get current config
        config = self.orchestrator.get_current_config()
        
        if not config or not config.blocks:
            # Show empty state
            self.empty_label.setVisible(True)
            return
        
        # Hide empty state
        self.empty_label.setVisible(False)
        
        # Create block items
        total_blocks = len(config.blocks)
        for idx, block_config in enumerate(config.blocks, 1):
            block_info = {
                'name': block_config.name,
                'logic': block_config.logic,
                'signals': [],
                'exit_conditions': []  # Initialize block-level exits list
            }
            
            # Add block-level exit conditions if present
            if hasattr(block_config, 'exit_conditions') and block_config.exit_conditions:
                for exit_cond in block_config.exit_conditions:
                    block_info['exit_conditions'].append({
                        'signal_name': exit_cond.signal_name,
                        'percentage': exit_cond.percentage,
                        'exit_mode': exit_cond.exit_mode,
                        'binding_level': exit_cond.binding_level
                    })
                logger.debug(f"DEBUG: Block '{block_config.name}' has {len(block_info['exit_conditions'])} block-level exits")
            
            # Add signal info with timing constraints and recheck config
            for signal_config in block_config.signals:
                signal_dict = {
                    'name': signal_config.name,
                    'logic': signal_config.logic,
                    'timing_constraint': None,
                    'recheck_config': None
                }
                
                # Add timing constraint data if present
                if signal_config.timing_constraint:
                    signal_dict['timing_constraint'] = {
                        'reference_signal': signal_config.timing_constraint.reference,
                        'max_candles': signal_config.timing_constraint.max_candles
                    }
                
                # Add recheck config data if present
                if signal_config.recheck_config:
                    signal_dict['recheck_config'] = {
                        'enabled': signal_config.recheck_config.enabled,
                        'bar_delay': signal_config.recheck_config.bar_delay
                    }
                
                # Add recheck chain data if present
                if hasattr(signal_config, 'recheck_chain') and signal_config.recheck_chain:
                    signal_dict['recheck_chain'] = []
                    for nested in signal_config.recheck_chain:
                        signal_dict['recheck_chain'].append({
                            'enabled': nested.enabled,
                            'bar_delay': nested.bar_delay,
                            'validation_mode': nested.validation_mode,
                            'mode': getattr(nested, 'mode', 'WITHIN')  # Add mode with default
                        })
                
                # Sprint 1.8 Task 1.8.48: Add exit conditions data if present (with RECHECK support)
                if hasattr(signal_config, 'exit_conditions') and signal_config.exit_conditions:
                    signal_dict['exit_conditions'] = []
                    for exit_cond in signal_config.exit_conditions:
                        exit_dict = {
                            'signal_name': exit_cond.signal_name,
                            'percentage': exit_cond.percentage,
                            'exit_mode': exit_cond.exit_mode,
                            'binding_level': exit_cond.binding_level
                        }
                        
                        # Add RECHECK config if present on the exit condition
                        if exit_cond.recheck_config:
                            exit_dict['recheck_config'] = {
                                'mode': getattr(exit_cond.recheck_config, 'mode', 'WITHIN'),
                                'enabled': exit_cond.recheck_config.enabled,
                                'bar_delay': exit_cond.recheck_config.bar_delay
                            }
                        
                        signal_dict['exit_conditions'].append(exit_dict)
                
                block_info['signals'].append(signal_dict)
            
            # Create block item widget with parent set to this panel
            block_item = BlockConfigItem(
                block_config.name,
                block_info,
                idx,
                total_blocks,
                orchestrator=self.orchestrator,
                parent=self.blocks_container  # Set parent to ensure proper signal routing
            )
            
            # Connect signals
            block_item.move_up_clicked.connect(self._on_move_up)
            block_item.move_down_clicked.connect(self._on_move_down)
            block_item.remove_clicked.connect(self._on_remove)
            block_item.configure_timing_clicked.connect(self._on_configure_timing)
            
            # Add to layout (insert before stretch)
            self.blocks_layout.insertWidget(self.blocks_layout.count() - 1, block_item)
            self.block_items.append(block_item)
        
        # Sprint 1.8 Task 1.8.49: Refresh strategy-level exits
        self._refresh_strategy_exits()
    
    def _clear_blocks(self):
        """Clear all block items from the display."""
        # Remove all block items
        for block_item in self.block_items:
            self.blocks_layout.removeWidget(block_item)
            block_item.deleteLater()
        
        self.block_items.clear()
    
    def _clear_layout(self, layout):
        """
        Recursively clear a layout by removing all widgets and sub-layouts.
        
        Args:
            layout: QLayout to clear
        """
        if layout is not None:
            while layout.count():
                item = layout.takeAt(0)
                widget = item.widget()
                if widget is not None:
                    widget.deleteLater()
                else:
                    sub_layout = item.layout()
                    if sub_layout is not None:
                        self._clear_layout(sub_layout)
    
    def _get_block_level_references(self, block_name: str) -> List[Tuple[str, str]]:
        """
        Get list of available reference signals for block-level timing constraints
.
        
        Args:
            block_name: Current block name
            
        Returns:
            List of (display_name, reference_id) tuples from all previous blocks
        """
        references = []
        config = self.orchestrator.get_current_config()
        
        if not config:
            return references
        
        # Find current block index
        current_block_idx = None
        for block_idx, block in enumerate(config.blocks):
            if block.name == block_name:
                current_block_idx = block_idx
                break
        
        if current_block_idx is None:
            return references
        
        # Add all signals from all previous blocks
        for block_idx in range(current_block_idx):
            block = config.blocks[block_idx]
            for signal in block.signals:
                display_name = f"{block.name} → {signal.name}"
                reference_id = f"{block.name}::{signal.name}"
                references.append((display_name, reference_id))
        
        return references
    
    def _get_available_references(self, block_name: str, signal_name: str) -> List[Tuple[str, str]]:
        """
        Get list of available reference signals for timing constraints.
        
        Args:
            block_name: Current block name
            signal_name: Current signal name
            
        Returns:
            List of (display_name, reference_id) tuples
        """
        references = []
        config = self.orchestrator.get_current_config()
        
        if not config:
            return references
        
        # Find current block and signal
        current_block_idx = None
        current_signal_idx = None
        
        for block_idx, block in enumerate(config.blocks):
            if block.name == block_name:
                current_block_idx = block_idx
                for signal_idx, signal in enumerate(block.signals):
                    if signal.name == signal_name:
                        current_signal_idx = signal_idx
                        break
                break
        
        if current_block_idx is None or current_signal_idx is None:
            return references
        
        # Add all signals from previous blocks
        for block_idx in range(current_block_idx):
            block = config.blocks[block_idx]
            for signal in block.signals:
                display_name = f"{block.name} → {signal.name}"
                reference_id = f"{block.name}::{signal.name}"
                references.append((display_name, reference_id))
        
        # Add previous signals from current block
        current_block = config.blocks[current_block_idx]
        for signal_idx in range(current_signal_idx):
            signal = current_block.signals[signal_idx]
            display_name = f"{block_name} → {signal.name}"
            reference_id = f"{block_name}::{signal.name}"
            references.append((display_name, reference_id))
        
        return references
    
    def _get_current_constraint(self, block_name: str, signal_name: str) -> Optional[dict]:
        """
        Get current timing constraint for a signal.
        
        Args:
            block_name: Block name
            signal_name: Signal name
            
        Returns:
            Constraint dict or None
        """
        config = self.orchestrator.get_current_config()
        
        if not config:
            return None
        
        # Find signal
        for block in config.blocks:
            if block.name == block_name:
                for signal in block.signals:
                    if signal.name == signal_name:
                        if signal.timing_constraint:
                            return {
                                'candles': signal.timing_constraint.max_candles,
                                'reference': signal.timing_constraint.reference,
                                'reference_name': signal.timing_constraint.reference  # TODO: Get display name
                            }
                        return None
        
        return None
    
    def _on_configure_timing(self, block_name: str, signal_name: str):
        """
        Handle configure timing button click.
        
        Args:
            block_name: Block name
            signal_name: Signal name (empty string for block-level timing)
        """
        try:
            # Determine if this is block-level or signal-level timing
            is_block_level = (signal_name == "")
            
            if is_block_level:
                # Block-level timing constraint
                display_name = f"Block: {block_name}"
                # Get references: all signals from all previous blocks
                available_references = self._get_block_level_references(block_name)
            else:
                # Signal-level timing constraint
                display_name = f"Signal: {block_name} → {signal_name}"
                # Get references: previous signals
                available_references = self._get_available_references(block_name, signal_name)
            
            if not available_references:
                logger.info(f"No reference signals available for {display_name}")
                return
            
            # Get current constraint
            current_constraint = self._get_current_constraint(block_name, signal_name)
            
            # Use appropriate display name for dialog
            title_name = "Block Timing" if is_block_level else signal_name
            
            # Create and show dialog
            dialog = TimingConstraintDialog(
                block_name=block_name,
                signal_name=title_name,
                available_references=available_references,
                current_constraint=current_constraint,
                parent=self
            )
            
            if dialog.exec_() == QDialog.Accepted:
                # Get constraint from dialog
                constraint = dialog.get_constraint()
                
                # For block-level timing, apply constraint to first signal in block
                target_signal_name = signal_name
                if is_block_level:
                    # Get first signal in this block
                    config = self.orchestrator.get_current_config()
                    if config:
                        for block in config.blocks:
                            if block.name == block_name:
                                if block.signals:
                                    target_signal_name = block.signals[0].name
                                    logger.info(f"Block-level timing: Applying to first signal '{target_signal_name}'")
                                break
                
                # Save to orchestrator
                if constraint:
                    result = self.orchestrator.set_signal_timing_constraint(
                        block_name=block_name,
                        signal_name=target_signal_name,
                        constraint=constraint
                    )
                    
                    if result.success:
                        # Refresh display
                        self._refresh_blocks()
                        # Emit changed signal
                        self.blocks_changed.emit()
                        logger.info(f"Timing constraint configured for {block_name}::{signal_name}")
                    else:
                        logger.error(f"Failed to set timing constraint: {result.message}")
                else:
                    # Remove constraint
                    result = self.orchestrator.remove_signal_timing_constraint(
                        block_name=block_name,
                        signal_name=signal_name
                    )
                    
                    if result.success:
                        # Refresh display
                        self._refresh_blocks()
                        # Emit changed signal
                        self.blocks_changed.emit()
                        logger.info(f"Timing constraint removed for {block_name}::{signal_name}")
                    else:
                        logger.error(f"Failed to remove timing constraint: {result.message}")
        
        except Exception as e:
            logger.error(f"Error configuring timing constraint: {e}")
            import traceback
            traceback.print_exc()
    
    def _on_move_up(self, block_name: str):
        """Handle move up button click."""
        try:
            # Call orchestrator to move block up
            result = self.orchestrator.reorder_block(block_name, "up")
            
            if result.success:
                # Refresh display
                self._refresh_blocks()
                # Emit changed signal
                self.blocks_changed.emit()
            else:
                logger.error(f"Failed to move block up: {result.message}")
        except Exception as e:
            logger.error(f"Error moving block up: {e}")
    
    def _on_move_down(self, block_name: str):
        """Handle move down button click."""
        try:
            # Call orchestrator to move block down
            result = self.orchestrator.reorder_block(block_name, "down")
            
            if result.success:
                # Refresh display
                self._refresh_blocks()
                # Emit changed signal
                self.blocks_changed.emit()
            else:
                logger.error(f"Failed to move block down: {result.message}")
        except Exception as e:
            logger.error(f"Error moving block down: {e}")
    
    def _on_remove(self, block_name: str):
        """Handle remove button click."""
        try:
            # Call orchestrator to remove block
            result = self.orchestrator.remove_block(block_name)
            
            if result.success:
                # Refresh display
                self._refresh_blocks()
                # Emit changed signal
                self.blocks_changed.emit()
            else:
                logger.error(f"Failed to remove block: {result.message}")
        except Exception as e:
            logger.error(f"Error removing block: {e}")
    
    def _on_signal_recheck_configured(self, block_name: str, signal_name: str, bar_delay: int, mode: str = "WITHIN"):
        """
        Handle recheck configuration for a signal.
        
        Args:
            block_name: Block name
            signal_name: Signal name
            bar_delay: Number of bars for recheck validation
            mode: "AT" or "WITHIN" (default: WITHIN)
        """
        try:
            # Get current config
            config = self.orchestrator.get_current_config()
            if not config:
                logger.info("No configuration available")
                return
            
            # Find and update signal
            from src.strategy_builder.core.strategy_config_engine import RecheckConfig
            
            for block in config.blocks:
                if block.name == block_name:
                    for signal in block.signals:
                        if signal.name == signal_name:
                            # Set recheck config with mode
                            signal.recheck_config = RecheckConfig(enabled=True, bar_delay=bar_delay, mode=mode)
                            logger.info(f"Recheck configured for {block_name}::{signal_name} - {bar_delay} bars, mode={mode}")
                            
                            # Refresh display
                            self._refresh_blocks()
                            # Emit changed signal
                            self.blocks_changed.emit()
                            return
            
            logger.warning(f"Signal {block_name}::{signal_name} not found")
        except Exception as e:
            logger.error(f"Error configuring recheck: {e}")
            import traceback
            traceback.print_exc()
    
    def _on_nested_recheck_configured(
        self,
        block_name: str,
        signal_name: str,
        validate_against: str,
        bar_delay: int,
        mode: str = "WITHIN"
    ):
        """
        Handle configuration of a nested RECHECK validation.
        
        Args:
            block_name: Block name
            signal_name: Signal name
            validate_against: "SIGNAL" or "RECHECK"
            bar_delay: Number of bars for validation
            mode: "AT" or "WITHIN" (default: WITHIN)
        """
        try:
            # Get current config
            config = self.orchestrator.get_current_config()
            if not config:
                logger.info("No configuration available")
                return
            
            # Find and update signal
            from src.strategy_builder.core.strategy_config_engine import RecheckConfig
            
            for block in config.blocks:
                if block.name == block_name:
                    for signal in block.signals:
                        if signal.name == signal_name:
                            if not signal.recheck_config:
                                logger.info(f"No base RECHECK found for {block_name}::{signal_name}")
                                return
                                
                            # Create nested recheck config with mode
                            nested_recheck = RecheckConfig(
                                enabled=True,
                                bar_delay=bar_delay,
                                validation_mode=validate_against,
                                mode=mode
                            )
                            
                            # Add to recheck chain
                            if not hasattr(signal, 'recheck_chain'):
                                signal.recheck_chain = []
                            signal.recheck_chain.append(nested_recheck)
                            
                            logger.info(f"Nested RECHECK configured for {block_name}::{signal_name} "
                                f"- {bar_delay} bars, validating against {validate_against}, mode={mode}")
                            
                            # Refresh display
                            self._refresh_blocks()
                            # Emit changed signal
                            self.blocks_changed.emit()
                            return
            
            logger.warning(f"Signal {block_name}::{signal_name} not found")
        except Exception as e:
            logger.error(f"Error configuring nested recheck: {e}")
            import traceback
            traceback.print_exc()
    
    def _on_signal_recheck_removed(self, block_name: str, signal_name: str):
        """
        Handle removal of recheck configuration for a signal.
        
        Args:
            block_name: Block name
            signal_name: Signal name
        """
        try:
            # Get current config
            config = self.orchestrator.get_current_config()
            if not config:
                logger.info("No configuration available")
                return
            
            # Find and update signal
            for block in config.blocks:
                if block.name == block_name:
                    for signal in block.signals:
                        if signal.name == signal_name:
                            # Remove recheck config and chain
                            signal.recheck_config = None
                            if hasattr(signal, 'recheck_chain'):
                                signal.recheck_chain = []
                            logger.info(f"Recheck removed for {block_name}::{signal_name}")
                            
                            # Refresh display
                            self._refresh_blocks()
                            # Emit changed signal
                            self.blocks_changed.emit()
                            return
            
            logger.warning(f"Signal {block_name}::{signal_name} not found")
        except Exception as e:
            logger.error(f"Error removing recheck: {e}")
            import traceback
            traceback.print_exc()
    
    def refresh_from_orchestrator(self):
        """Public method to refresh display from orchestrator."""
        self._refresh_blocks()
    
    def add_block(self, block_name: str):
        """
        Add a block to the strategy.
        
        Args:
            block_name: Name of the block to add
            
        Returns:
            bool: True if successful
        """
        try:
            result = self.orchestrator.add_block(block_name)
            
            if result.success:
                self._refresh_blocks()
                self.blocks_changed.emit()
                return True
            else:
                logger.error(f"Failed to add block: {result.message}")
                return False
        except Exception as e:
            logger.error(f"Error adding block: {e}")
            return False
    
    def get_block_count(self) -> int:
        """Get the number of blocks currently configured."""
        return len(self.block_items)
    
    def get_block_names(self) -> List[str]:
        """Get list of configured block names in order."""
        return [item.block_name for item in self.block_items]
    
    def _on_add_strategy_exit(self):
        """Handle Add Strategy Exit Condition button click - Sprint 1.8 Task 1.8.49"""
        try:
            # Show exit condition dialog
            dialog = ExitConditionDialog(parent=self)
            
            if dialog.exec_() == QDialog.Accepted:
                # Get configuration from dialog
                config = dialog.get_config()
                
                # Validate that a signal was selected
                if not config or not config.get('signal_name'):
                    logger.info("No signal selected for exit condition")
                    return
                
                # Add to orchestrator at STRATEGY binding level
                result = self.orchestrator.add_exit_condition(
                    signal_name=config['signal_name'],
                    percentage=config.get('percentage', 50) / 100.0,  # Convert from % to 0.0-1.0
                    binding_level='STRATEGY',
                    exit_mode=config.get('exit_mode', 'ABSOLUTE'),
                    tp_proximity_threshold=config.get('tp_proximity_threshold', 2.0),
                    reversal_trigger=config.get('reversal_trigger', 0.5)
                )
                
                if result.success:
                    logger.info(f"Strategy exit condition added: {config['signal_name']}")
                    # Refresh display
                    self._refresh_strategy_exits()
                    self.blocks_changed.emit()
                else:
                    logger.error(f"Failed to add exit condition: {result.message}")
        
        except Exception as e:
            logger.error(f"Error adding strategy exit condition: {e}")
            import traceback
            traceback.print_exc()
    
    def _refresh_strategy_exits(self):
        """Refresh the strategy-level exit conditions display - Sprint 1.8 Task 1.8.49"""
        try:
            # Clear existing exit items - handle both widgets AND layouts
            while self.strategy_exits_layout.count():
                item = self.strategy_exits_layout.takeAt(0)
                if item.widget():
                    item.widget().deleteLater()
                elif item.layout():
                    # Clear layouts recursively
                    self._clear_layout(item.layout())
            
            # Get current config
            config = self.orchestrator.get_current_config()
            if not config or not hasattr(config, 'exit_conditions') or not config.exit_conditions:
                # No strategy-level exits
                no_exits_label = QLabel("No strategy-level exit conditions configured")
                no_exits_label.setStyleSheet(get_label_style('muted') + " font-size: 9pt; font-style: italic;")
                no_exits_label.setAlignment(Qt.AlignCenter)
                self.strategy_exits_layout.addWidget(no_exits_label)
                return
            
            # Display each exit condition - COPY RECHECK PATTERN EXACTLY
            for exit_cond in config.exit_conditions:
                # Capture signal_name at loop iteration to avoid closure issues
                current_signal_name = exit_cond.signal_name
                
                # Create exit row layout - NO QWidget wrapper, just like RECHECK
                exit_row_layout = QHBoxLayout()
                exit_row_layout.setSpacing(8)
                
                # Exit info label
                pct_display = int(exit_cond.percentage * 100)
                exit_text = f"🔴 {current_signal_name} ({pct_display}%) - {exit_cond.exit_mode} mode"
                exit_label = QLabel(exit_text)
                exit_label.setStyleSheet(get_exit_tree_item_style() + " font-size: 9pt; font-weight: bold;")
                exit_label.setToolTip(
                    f"Signal: {current_signal_name}\n"
                    f"Percentage: {pct_display}%\n"
                    f"Mode: {exit_cond.exit_mode}\n"
                    f"Binding: {exit_cond.binding_level}"
                )
                exit_row_layout.addWidget(exit_label, stretch=1)
                
                # Config/Edit button - same style as recheck gear button
                config_btn = QPushButton("⚙")
                set_hand_cursor(config_btn)
                config_btn.setStyleSheet(get_recheck_gear_button_stylesheet())
                config_btn.setToolTip("Configure exit condition")
                # Use functools.partial - proper PyQt5 pattern
                config_btn.clicked.connect(partial(self._on_edit_strategy_exit, current_signal_name))
                exit_row_layout.addWidget(config_btn)
                
                # Remove button - same style and size as recheck remove button
                remove_btn = QPushButton("✕")
                set_hand_cursor(remove_btn)
                remove_btn.setStyleSheet(get_recheck_remove_button_stylesheet())
                remove_btn.setToolTip("Remove this exit condition")
                # Use functools.partial - proper PyQt5 pattern
                remove_btn.clicked.connect(partial(self._on_remove_strategy_exit, current_signal_name))
                exit_row_layout.addWidget(remove_btn)
                
                # Add layout directly to parent - NO QWidget wrapper
                self.strategy_exits_layout.addLayout(exit_row_layout)
        
        except Exception as e:
            logger.error(f"Error refreshing strategy exits: {e}")
            import traceback
            traceback.print_exc()
    
    def _on_remove_strategy_exit(self, signal_name: str, checked: bool = False):
        """Handle removal of strategy-level exit condition - Sprint 1.8 Task 1.8.49"""
        logger.info(f"\n{'='*80}")
        logger.debug(f"DEBUG: _on_remove_strategy_exit CALLED")
        logger.info(f"  signal_name: {signal_name}")
        logger.info(f"  checked: {checked}")
        logger.info(f"{'='*80}\n")
        try:
            result = self.orchestrator.remove_exit_condition(
                signal_name=signal_name,
                binding_level='STRATEGY'
            )
            
            if result.success:
                logger.info(f"Strategy exit condition removed: {signal_name}")
                self._refresh_strategy_exits()
                self.blocks_changed.emit()
            else:
                logger.error(f"Failed to remove exit condition: {result.message}")
        
        except Exception as e:
            logger.error(f"Error removing strategy exit: {e}")
            import traceback
            traceback.print_exc()
    
    def _on_edit_strategy_exit(self, signal_name: str, checked: bool = False):
        """Handle double-click on exit condition to edit - Sprint 1.8 Task 1.8.50"""
        logger.info(f"\n{'='*80}")
        logger.debug(f"DEBUG: _on_edit_strategy_exit CALLED")
        logger.info(f"  signal_name: {signal_name}")
        logger.info(f"  checked: {checked}")
        logger.info(f"{'='*80}\n")
        try:
            # Get current config
            config = self.orchestrator.get_current_config()
            if not config or not hasattr(config, 'exit_conditions') or not config.exit_conditions:
                return
            
            # Find the exit condition
            current_exit = None
            for exit_cond in config.exit_conditions:
                if exit_cond.signal_name == signal_name:
                    current_exit = exit_cond
                    break
            
            if not current_exit:
                logger.warning(f"Exit condition {signal_name} not found")
                return
            
            # Show exit condition dialog pre-populated with current values (BUG FIX)
            dialog = ExitConditionDialog(
                signal_name=signal_name,
                existing_percentage=current_exit.percentage,
                existing_exit_mode=current_exit.exit_mode,
                existing_tp_proximity=current_exit.tp_proximity_threshold,
                existing_reversal=current_exit.reversal_trigger,
                parent=self
            )
            
            if dialog.exec_() == QDialog.Accepted:
                # Get new configuration from dialog
                new_config = dialog.get_config()
                
                if not new_config or not new_config.get('signal_name'):
                    logger.info("No signal selected for exit condition")
                    return
                
                # Remove old exit condition first
                remove_result = self.orchestrator.remove_exit_condition(
                    signal_name=signal_name,
                    binding_level='STRATEGY'
                )
                
                if not remove_result.success:
                    logger.error(f"Failed to remove old exit condition: {remove_result.message}")
                    return
                
                # Add updated exit condition
                add_result = self.orchestrator.add_exit_condition(
                    signal_name=new_config['signal_name'],
                    percentage=new_config.get('percentage', 50) / 100.0,
                    binding_level='STRATEGY',
                    exit_mode=new_config.get('exit_mode', 'ABSOLUTE'),
                    tp_proximity_threshold=new_config.get('tp_proximity_threshold', 2.0),
                    reversal_trigger=new_config.get('reversal_trigger', 0.5)
                )
                
                if add_result.success:
                    logger.info(f"Strategy exit condition updated: {new_config['signal_name']}")
                    # Refresh display
                    self._refresh_strategy_exits()
                    self.blocks_changed.emit()
                else:
                    logger.error(f"Failed to update exit condition: {add_result.message}")
        
        except Exception as e:
            logger.error(f"Error editing strategy exit: {e}")
            import traceback
            traceback.print_exc()
    
    def _on_edit_block_exit(self, block_name: str, signal_name: str):
        """Handle config button for block-level exit condition - show exit dialog."""
        logger.debug(f"DEBUG: _on_edit_block_exit called for block '{block_name}', signal '{signal_name}'")
        try:
            # Get current config to find the exit
            config = self.orchestrator.get_current_config()
            if not config:
                return
            
            # Find the block and its exit condition
            current_exit = None
            for block in config.blocks:
                if block.name == block_name:
                    if hasattr(block, 'exit_conditions') and block.exit_conditions:
                        for exit_cond in block.exit_conditions:
                            if exit_cond.signal_name == signal_name:
                                current_exit = exit_cond
                                break
                    break
            
            if not current_exit:
                logger.warning(f"Block exit condition {signal_name} not found in block {block_name}")
                return
            
            # Show exit condition dialog pre-populated with current values
            dialog = ExitConditionDialog(
                signal_name=signal_name,
                existing_percentage=current_exit.percentage,
                existing_exit_mode=current_exit.exit_mode,
                existing_tp_proximity=current_exit.tp_proximity_threshold,
                existing_reversal=current_exit.reversal_trigger,
                parent=self
            )
            
            if dialog.exec_() == QDialog.Accepted:
                # Get new configuration
                new_config = dialog.get_config()
                
                if not new_config or not new_config.get('signal_name'):
                    logger.info("No signal selected for exit condition")
                    return
                
                # Remove old exit condition first
                remove_result = self.orchestrator.remove_exit_condition(
                    signal_name=signal_name,
                    binding_level='BLOCK',
                    block_name=block_name
                )
                
                if not remove_result.success:
                    logger.error(f"Failed to remove old block exit condition: {remove_result.message}")
                    return
                
                # Add updated exit condition
                add_result = self.orchestrator.add_exit_condition(
                    signal_name=new_config['signal_name'],
                    percentage=new_config.get('percentage', 50) / 100.0,
                    binding_level='BLOCK',
                    block_name=block_name,
                    exit_mode=new_config.get('exit_mode', 'ABSOLUTE'),
                    tp_proximity_threshold=new_config.get('tp_proximity_threshold', 2.0),
                    reversal_trigger=new_config.get('reversal_trigger', 0.5)
                )
                
                if add_result.success:
                    logger.info(f"Block exit condition updated: {block_name} -> {new_config['signal_name']}")
                    self._refresh_blocks()
                    self.blocks_changed.emit()
                else:
                    logger.error(f"Failed to update block exit condition: {add_result.message}")
        
        except Exception as e:
            logger.error(f"Error editing block exit: {e}")
            import traceback
            traceback.print_exc()
    
    def _on_duplicate_block_exit(self, block_name: str, exit_signal_name: str):
        """Handle duplicate button - add another exit to this block with same signal pre-populated."""
        logger.debug(f"DEBUG: _on_duplicate_block_exit called for block '{block_name}', exit_signal '{exit_signal_name}'")
        try:
            # Show exit condition dialog pre-populated with the current exit's signal (ready to duplicate)
            # Issue 1 Fix: Pass binding context so dialog auto-selects BLOCK binding level
            dialog = ExitConditionDialog(
                signal_name=exit_signal_name,
                parent=self,
                orchestrator=self.orchestrator,
                is_duplicate=True,
                binding_level="BLOCK",
                block_name=block_name
            )
            
            if dialog.exec_() == QDialog.Accepted:
                # Get configuration from dialog
                config = dialog.get_config()
                
                # Validate that a signal was selected
                if not config or not config.get('signal_name'):
                    logger.info("No signal selected for exit condition")
                    return
                
                # Add to orchestrator at BLOCK binding level
                result = self.orchestrator.add_exit_condition(
                    signal_name=config['signal_name'],
                    percentage=config.get('percentage', 50) / 100.0,
                    binding_level='BLOCK',
                    block_name=block_name,
                    exit_mode=config.get('exit_mode', 'ABSOLUTE'),
                    tp_proximity_threshold=config.get('tp_proximity_threshold', 2.0),
                    reversal_trigger=config.get('reversal_trigger', 0.5)
                )
                
                if result.success:
                    logger.info(f"Block exit condition added: {block_name} -> {config['signal_name']}")
                    self._refresh_blocks()
                    self.blocks_changed.emit()
                else:
                    logger.error(f"Failed to add block exit condition: {result.message}")
        
        except Exception as e:
            logger.error(f"Error adding block exit condition: {e}")
            import traceback
            traceback.print_exc()
    
    def _on_remove_block_exit(self, block_name: str, signal_name: str):
        """Handle remove button for block-level exit condition."""
        logger.debug(f"DEBUG: _on_remove_block_exit called for block '{block_name}', signal '{signal_name}'")
        try:
            result = self.orchestrator.remove_exit_condition(
                signal_name=signal_name,
                binding_level='BLOCK',
                block_name=block_name
            )
            
            if result.success:
                logger.info(f"Block exit condition removed: {block_name} -> {signal_name}")
                self._refresh_blocks()
                self.blocks_changed.emit()
            else:
                logger.error(f"Failed to remove block exit condition: {result.message}")
        
        except Exception as e:
            logger.error(f"Error removing block exit: {e}")
            import traceback
            traceback.print_exc()
    
    def _on_signal_exit_config_clicked(self, block_name: str, signal_name: str, exit_signal_name: str):
        """Handle config button for signal-level exit condition."""
        logger.debug(f"DEBUG: _on_signal_exit_config_clicked called for block '{block_name}', signal '{signal_name}', exit '{exit_signal_name}'")
        try:
            # Get current config to find the exit
            config = self.orchestrator.get_current_config()
            if not config:
                return
            
            # Find the signal and its exit condition
            current_exit = None
            for block in config.blocks:
                if block.name == block_name:
                    for signal in block.signals:
                        if signal.name == signal_name:
                            if hasattr(signal, 'exit_conditions') and signal.exit_conditions:
                                for exit_cond in signal.exit_conditions:
                                    if exit_cond.signal_name == exit_signal_name:
                                        current_exit = exit_cond
                                        break
                            break
                    break
            
            if not current_exit:
                logger.warning(f"Signal exit condition {exit_signal_name} not found in signal {block_name}::{signal_name}")
                return
            
            # Show exit condition dialog pre-populated (CRITICAL: Include RECHECK values)
            # CRITICAL FIX: ExitCondition has recheck_config (RecheckConfig object), not separate fields
            existing_recheck_enabled = False
            existing_recheck_bar_delay = 3
            if current_exit.recheck_config:
                existing_recheck_enabled = current_exit.recheck_config.enabled
                existing_recheck_bar_delay = current_exit.recheck_config.bar_delay
                logger.debug(f"DEBUG: Loading RECHECK from exit: enabled={existing_recheck_enabled}, bar_delay={existing_recheck_bar_delay}")
            
            dialog = ExitConditionDialog(
                signal_name=exit_signal_name,
                existing_percentage=current_exit.percentage,
                existing_exit_mode=current_exit.exit_mode,
                existing_tp_proximity=current_exit.tp_proximity_threshold,
                existing_reversal=current_exit.reversal_trigger,
                existing_recheck_enabled=existing_recheck_enabled,
                existing_recheck_bar_delay=existing_recheck_bar_delay,
                parent=self
            )
            
            if dialog.exec_() == QDialog.Accepted:
                new_config = dialog.get_config()
                
                if not new_config or not new_config.get('signal_name'):
                    logger.info("No signal selected for exit condition")
                    return
                
                # Remove old
                remove_result = self.orchestrator.remove_exit_condition(
                    signal_name=exit_signal_name,
                    binding_level='SIGNAL',
                    block_name=block_name,
                    parent_signal_name=signal_name
                )
                
                if not remove_result.success:
                    logger.error(f"Failed to remove old signal exit: {remove_result.message}")
                    return
                
                # Add updated with RECHECK values
                # CRITICAL FIX: Dialog already returns percentage as 0.0-1.0, don't divide again!
                add_result = self.orchestrator.add_exit_condition(
                    signal_name=new_config['signal_name'],
                    percentage=new_config.get('percentage', 0.5),  # Already 0.0-1.0 from dialog
                    binding_level='SIGNAL',
                    block_name=block_name,
                    parent_signal_name=signal_name,
                    exit_mode=new_config.get('exit_mode', 'ABSOLUTE'),
                    tp_proximity_threshold=new_config.get('tp_proximity_threshold', 2.0),
                    reversal_trigger=new_config.get('reversal_trigger', 0.5),
                    recheck_enabled=new_config.get('recheck_enabled', False),
                    recheck_bar_delay=new_config.get('recheck_bar_delay')
                )
                
                # DEBUG: Log what we're saving
                logger.debug(f"DEBUG: Saving exit with percentage={new_config.get('percentage')}, recheck_enabled={new_config.get('recheck_enabled')}, recheck_bar_delay={new_config.get('recheck_bar_delay')}")
                
                if add_result.success:
                    logger.info(f"Signal exit updated: {block_name}::{signal_name} -> {new_config['signal_name']}")
                    self._refresh_blocks()
                    self.blocks_changed.emit()
                else:
                    logger.error(f"Failed to update signal exit: {add_result.message}")
        
        except Exception as e:
            logger.error(f"Error editing signal exit: {e}")
            import traceback
            traceback.print_exc()
    
    def _on_signal_exit_duplicate_clicked(self, block_name: str, signal_name: str, exit_signal_name: str):
        """Handle duplicate button for signal-level exit - add another exit to this signal with same signal pre-populated."""
        logger.debug(f"DEBUG: _on_signal_exit_duplicate_clicked called for block '{block_name}', signal '{signal_name}', exit_signal '{exit_signal_name}'")
        try:
            # Show exit condition dialog pre-populated with the current exit's signal (ready to duplicate)
            # Issue 1 Fix: Pass binding context so dialog auto-selects SIGNAL binding level
            dialog = ExitConditionDialog(
                signal_name=exit_signal_name,
                parent=self,
                orchestrator=self.orchestrator,
                is_duplicate=True,
                binding_level="SIGNAL",
                block_name=block_name,
                parent_signal_name=signal_name
            )
            
            if dialog.exec_() == QDialog.Accepted:
                config = dialog.get_config()
                
                if not config or not config.get('signal_name'):
                    logger.info("No signal selected for exit condition")
                    return
                
                # Add to orchestrator at SIGNAL binding level
                result = self.orchestrator.add_exit_condition(
                    signal_name=config['signal_name'],
                    percentage=config.get('percentage', 50) / 100.0,
                    binding_level='SIGNAL',
                    block_name=block_name,
                    parent_signal_name=signal_name,
                    exit_mode=config.get('exit_mode', 'ABSOLUTE'),
                    tp_proximity_threshold=config.get('tp_proximity_threshold', 2.0),
                    reversal_trigger=config.get('reversal_trigger', 0.5)
                )
                
                if result.success:
                    logger.info(f"Signal exit added: {block_name}::{signal_name} -> {config['signal_name']}")
                    self._refresh_blocks()
                    self.blocks_changed.emit()
                else:
                    logger.error(f"Failed to add signal exit: {result.message}")
        
        except Exception as e:
            logger.error(f"Error adding signal exit: {e}")
            import traceback
            traceback.print_exc()
    
    def _on_signal_exit_remove_clicked(self, block_name: str, signal_name: str, exit_signal_name: str):
        """Handle remove button for signal-level exit condition."""
        logger.debug(f"DEBUG: _on_signal_exit_remove_clicked called for block '{block_name}', signal '{signal_name}', exit '{exit_signal_name}'")
        try:
            result = self.orchestrator.remove_exit_condition(
                signal_name=exit_signal_name,
                binding_level='SIGNAL',
                block_name=block_name,
                parent_signal_name=signal_name
            )
            
            if result.success:
                logger.info(f"Signal exit removed: {block_name}::{signal_name} -> {exit_signal_name}")
                self._refresh_blocks()
                self.blocks_changed.emit()
            else:
                logger.error(f"Failed to remove signal exit: {result.message}")
        
        except Exception as e:
            logger.error(f"Error removing signal exit: {e}")
            import traceback
            traceback.print_exc()
    
    def _on_exit_recheck_configured(self, block_name: str, signal_name: str, exit_signal_name: str, bar_delay: int, mode: str = "WITHIN"):
        """Handle RECHECK configuration for an exit condition."""
        logger.debug(f"DEBUG: _on_exit_recheck_configured called: block='{block_name}', signal='{signal_name}', exit='{exit_signal_name}', bars={bar_delay}, mode={mode}")
        try:
            # Get current config
            config = self.orchestrator.get_current_config()
            if not config:
                logger.info("No configuration available")
                return
            
            # Find and update the exit condition
            from src.strategy_builder.core.strategy_config_engine import RecheckConfig
            
            for block in config.blocks:
                if block.name == block_name:
                    for signal in block.signals:
                        if signal.name == signal_name:
                            if hasattr(signal, 'exit_conditions') and signal.exit_conditions:
                                for exit_cond in signal.exit_conditions:
                                    if exit_cond.signal_name == exit_signal_name:
                                        # Set RECHECK config for this exit with mode
                                        exit_cond.recheck_config = RecheckConfig(enabled=True, bar_delay=bar_delay, mode=mode)
                                        logger.info(f"RECHECK configured for exit {exit_signal_name} - {bar_delay} bars, mode={mode}")
                                        
                                        # Refresh display
                                        self._refresh_blocks()
                                        self.blocks_changed.emit()
                                        return
            
            logger.warning(f"Exit condition {exit_signal_name} not found in {block_name}::{signal_name}")
        except Exception as e:
            logger.error(f"Error configuring exit RECHECK: {e}")
            import traceback
            traceback.print_exc()
    
    def _on_exit_recheck_removed(self, block_name: str, signal_name: str, exit_signal_name: str):
        """Handle removal of RECHECK from an exit condition."""
        logger.debug(f"DEBUG: _on_exit_recheck_removed called: block='{block_name}', signal='{signal_name}', exit='{exit_signal_name}'")
        try:
            # Get current config
            config = self.orchestrator.get_current_config()
            if not config:
                logger.info("No configuration available")
                return
            
            # Find and update the exit condition
            for block in config.blocks:
                if block.name == block_name:
                    for signal in block.signals:
                        if signal.name == signal_name:
                            if hasattr(signal, 'exit_conditions') and signal.exit_conditions:
                                for exit_cond in signal.exit_conditions:
                                    if exit_cond.signal_name == exit_signal_name:
                                        # Remove RECHECK config
                                        exit_cond.recheck_config = None
                                        logger.info(f"RECHECK removed from exit {exit_signal_name}")
                                        
                                        # Refresh display
                                        self._refresh_blocks()
                                        self.blocks_changed.emit()
                                        return
            
            logger.warning(f"Exit condition {exit_signal_name} not found in {block_name}::{signal_name}")
        except Exception as e:
            logger.error(f"Error removing exit RECHECK: {e}")
            import traceback
            traceback.print_exc()
    
    def _on_nested_recheck_updated(
        self,
        block_name: str,
        signal_name: str,
        chain_index: int,
        validate_against: str,
        bar_delay: int,
        mode: str = "WITHIN"
    ):
        """Handle update of existing nested RECHECK in chain."""
        try:
            config = self.orchestrator.get_current_config()
            if not config:
                logger.info("No configuration available")
                return
            
            from src.strategy_builder.core.strategy_config_engine import RecheckConfig
            
            for block in config.blocks:
                if block.name == block_name:
                    for signal in block.signals:
                        if signal.name == signal_name:
                            if hasattr(signal, 'recheck_chain') and signal.recheck_chain:
                                if 0 <= chain_index < len(signal.recheck_chain):
                                    # Update the nested RECHECK at this index
                                    signal.recheck_chain[chain_index] = RecheckConfig(
                                        enabled=True,
                                        bar_delay=bar_delay,
                                        validation_mode=validate_against,
                                        mode=mode
                                    )
                                    logger.info(f"Nested RECHECK updated for {block_name}::{signal_name} at index {chain_index}")
                                    
                                    self._refresh_blocks()
                                    self.blocks_changed.emit()
                                    return
            
            logger.warning(f"Nested RECHECK not found at index {chain_index} for {block_name}::{signal_name}")
        except Exception as e:
            logger.error(f"Error updating nested recheck: {e}")
            import traceback
            traceback.print_exc()
    
    def _on_nested_recheck_removed(self, block_name: str, signal_name: str, chain_index: int):
        """Handle removal of nested RECHECK from chain."""
        try:
            config = self.orchestrator.get_current_config()
            if not config:
                logger.info("No configuration available")
                return
            
            for block in config.blocks:
                if block.name == block_name:
                    for signal in block.signals:
                        if signal.name == signal_name:
                            if hasattr(signal, 'recheck_chain') and signal.recheck_chain:
                                if 0 <= chain_index < len(signal.recheck_chain):
                                    # Remove this nested RECHECK from chain
                                    signal.recheck_chain.pop(chain_index)
                                    logger.info(f"Nested RECHECK removed from {block_name}::{signal_name} at index {chain_index}")
                                    
                                    self._refresh_blocks()
                                    self.blocks_changed.emit()
                                    return
            
            logger.warning(f"Nested RECHECK not found at index {chain_index} for {block_name}::{signal_name}")
        except Exception as e:
            logger.error(f"Error removing nested recheck: {e}")
            import traceback
            traceback.print_exc()
