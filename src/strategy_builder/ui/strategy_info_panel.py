"""
Strategy Information Panel - UI Component for Strategy Builder

This panel displays and manages basic strategy metadata including:
- Strategy name
- Auto-generated description
- Strategy type (Bullish/Bearish)
- Required signals count (auto-calculated)

Author: Strategy Builder Team
Date: 2026-01-16
"""

from typing import Optional
from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, 
    QLineEdit, QTextEdit, QRadioButton, QButtonGroup,
    QGroupBox, QFrame
)
from PyQt5.QtCore import pyqtSignal, Qt
from PyQt5.QtGui import QFont

from src.strategy_builder.integration.strategy_builder_orchestrator import (
    StrategyBuilderOrchestrator
)
from src.strategy_builder.ui.styles import get_label_style, get_color, get_radio_button_style


class StrategyInfoPanel(QWidget):
    """
    Panel for displaying and editing strategy information.
    
    Signals:
        strategy_name_changed: Emitted when strategy name is modified
        strategy_type_changed: Emitted when strategy type is changed (str: "Bullish" or "Bearish")
    """
    
    strategy_name_changed = pyqtSignal(str)
    strategy_type_changed = pyqtSignal(str)
    
    def __init__(self, orchestrator: StrategyBuilderOrchestrator, parent: Optional[QWidget] = None):
        """
        Initialize the Strategy Information Panel.
        
        Args:
            orchestrator: StrategyBuilderOrchestrator instance for backend communication
            parent: Parent widget (optional)
        """
        super().__init__(parent)
        self.orchestrator = orchestrator
        
        # CRITICAL: Store actual strategy name separately from display
        # Display may include version "(vX)" but actual name does not
        self._actual_strategy_name: str = ""
        
        # UI Components
        self.name_input: Optional[QLineEdit] = None
        self.desc_label: Optional[QLabel] = None
        self.description_text: Optional[QTextEdit] = None
        self.bullish_radio: Optional[QRadioButton] = None
        self.bearish_radio: Optional[QRadioButton] = None
        self.type_button_group: Optional[QButtonGroup] = None
        self.required_signals_label: Optional[QLabel] = None
        self.optional_signals_label: Optional[QLabel] = None
        self.rechecked_signals_label: Optional[QLabel] = None
        self.exit_conditions_label: Optional[QLabel] = None  # Sprint 1.8 Task 1.8.51
        self.time_constraint_label: Optional[QLabel] = None
        
        self._init_ui()
        self._connect_signals()
    
    def _init_ui(self):
        """Initialize the user interface components."""
        # Main layout - increased spacing
        layout = QVBoxLayout()
        layout.setSpacing(20)
        layout.setContentsMargins(15, 15, 15, 15)
        
        # Group box for all strategy info
        group_box = QGroupBox("💡 Strategy Information")
        
        # Set title font programmatically (CSS doesn't work for QGroupBox::title)
        title_font = QFont()
        title_font.setPointSize(12)
        title_font.setBold(True)
        group_box.setFont(title_font)
        
        group_layout = QVBoxLayout()
        group_layout.setSpacing(20)  # Match backtest panel spacing
        group_layout.setContentsMargins(15, 20, 15, 15)  # Add internal padding
        
        # Reset font for content (only title should be 12pt, not content)
        # CRITICAL: Make it instance variable so it persists!
        self.content_font = QFont()
        self.content_font.setPointSize(10)  # Normal size for content
        self.content_font.setBold(False)  # Explicitly not bold
        
        # Strategy Name
        name_layout = QVBoxLayout()
        name_layout.setSpacing(8)
        name_label = QLabel("Strategy Name:")
        name_label.setFont(self.content_font)
        name_label.setStyleSheet(get_label_style('muted'))
        name_label.setToolTip("Enter a unique name for your strategy")
        self.name_input = QLineEdit()
        self.name_input.setFont(self.content_font)
        self.name_input.setPlaceholderText("e.g., Example_MA_Crossover")
        self.name_input.setMaxLength(100)
        self.name_input.setMinimumHeight(36)  # Bigger input
        name_layout.addWidget(name_label)
        name_layout.addWidget(self.name_input)
        group_layout.addLayout(name_layout)
        
        # Description (Auto-generated) - Now scrollable with word wrap!
        desc_layout = QVBoxLayout()
        desc_layout.setSpacing(8)
        self.desc_label = QLabel("Description:")
        self.desc_label.setFont(self.content_font)
        self.desc_label.setStyleSheet(get_label_style('muted'))
        self.desc_label.setToolTip("Strategy description (auto-generated from blocks)")
        self.description_text = QTextEdit()
        self.description_text.setFont(self.content_font)
        # Apply muted text styling for better readability
        self.description_text.setStyleSheet(f"color: {get_color('text_muted')}; background-color: {get_color('bg_input')};")
        self.description_text.setPlaceholderText(
            "Description will be auto-generated when you add building blocks...\n\n"
            "Example:\n"
            "Moving Average crossover with momentum confirmation. "
            "Entry on golden cross with volume confirmation within 5 candles..."
        )
        self.description_text.setMinimumHeight(130)  # Allow scrolling instead of max
        self.description_text.setMaximumHeight(190)  # Cap the max height
        self.description_text.setWordWrapMode(1)  # Enable word wrap (WordWrap mode)
        self.description_text.setLineWrapMode(1)  # Wrap at widget width
        self.description_text.setReadOnly(True)  # Auto-generated, not editable
        desc_layout.addWidget(self.desc_label)
        desc_layout.addWidget(self.description_text)
        group_layout.addLayout(desc_layout)
        
        # Compact metadata row: Strategy Type | Required Signals | Optional Signals | Time Constraint
        meta_layout = QHBoxLayout()
        meta_layout.setSpacing(15)
        
        # Strategy Type
        type_label = QLabel("Strategy Type:")
        type_label.setStyleSheet(get_label_style('muted'))
        type_label.setToolTip("Select whether this is a bullish or bearish strategy")
        meta_layout.addWidget(type_label)
        
        self.bullish_radio = QRadioButton("Bullish")
        self.bullish_radio.setFont(self.content_font)
        self.bullish_radio.setStyleSheet(get_radio_button_style('bullish'))
        self.bullish_radio.setToolTip("Strategy designed for uptrending markets")
        self.bullish_radio.setChecked(True)
        meta_layout.addWidget(self.bullish_radio)
        
        self.bearish_radio = QRadioButton("Bearish")
        self.bearish_radio.setFont(self.content_font)
        self.bearish_radio.setStyleSheet(get_radio_button_style('bearish'))
        self.bearish_radio.setToolTip("Strategy designed for downtrending markets")
        meta_layout.addWidget(self.bearish_radio)
        
        # Button group
        self.type_button_group = QButtonGroup()
        self.type_button_group.addButton(self.bullish_radio)
        self.type_button_group.addButton(self.bearish_radio)
        
        # Separator
        sep1 = QLabel("|")
        sep1.setStyleSheet(f"color: {get_color('text_muted')}; font-weight: bold;")
        meta_layout.addWidget(sep1)
        
        # Required Signals
        req_sig_label = QLabel("Required:")
        req_sig_label.setStyleSheet(get_label_style('muted'))
        req_sig_label.setToolTip("Number of signals required for strategy entry")
        meta_layout.addWidget(req_sig_label)
        
        self.required_signals_label = QLabel("0")
        required_signals_font = QFont()
        required_signals_font.setBold(True)
        required_signals_font.setPointSize(10)
        self.required_signals_label.setFont(required_signals_font)
        self.required_signals_label.setStyleSheet(f"color: {get_color('success')};")
        meta_layout.addWidget(self.required_signals_label)
        
        # Separator
        sep2 = QLabel("|")
        sep2.setStyleSheet(f"color: {get_color('text_muted')}; font-weight: bold;")
        meta_layout.addWidget(sep2)
        
        # Optional Signals
        opt_sig_label = QLabel("Optional:")
        opt_sig_label.setStyleSheet(get_label_style('muted'))
        opt_sig_label.setToolTip("Number of optional signals (boosters)")
        meta_layout.addWidget(opt_sig_label)
        
        self.optional_signals_label = QLabel("0")
        optional_signals_font = QFont()
        optional_signals_font.setBold(True)
        optional_signals_font.setPointSize(10)
        self.optional_signals_label.setFont(optional_signals_font)
        self.optional_signals_label.setStyleSheet(f"color: {get_color('info')};")
        meta_layout.addWidget(self.optional_signals_label)
        
        # Separator
        sep3 = QLabel("|")
        sep3.setStyleSheet(f"color: {get_color('text_muted')}; font-weight: bold;")
        meta_layout.addWidget(sep3)
        
        # Rechecked Signals
        recheck_sig_label = QLabel("Rechecked:")
        recheck_sig_label.setStyleSheet(get_label_style('muted'))
        recheck_sig_label.setToolTip("Number of signals with recheck validation configured")
        meta_layout.addWidget(recheck_sig_label)
        
        self.rechecked_signals_label = QLabel("0")
        rechecked_signals_font = QFont()
        rechecked_signals_font.setBold(True)
        rechecked_signals_font.setPointSize(10)
        self.rechecked_signals_label.setFont(rechecked_signals_font)
        self.rechecked_signals_label.setStyleSheet(f"color: {get_color('warning')};")
        meta_layout.addWidget(self.rechecked_signals_label)
        
        # Sprint 1.8 Task 1.8.51: Exit Conditions count
        # Separator
        sep5 = QLabel("|")
        sep5.setStyleSheet(f"color: {get_color('text_muted')}; font-weight: bold;")
        meta_layout.addWidget(sep5)
        
        # Exit Conditions label
        exit_cond_label = QLabel("Exit Conditions:")
        exit_cond_label.setStyleSheet(get_label_style('muted'))
        exit_cond_label.setToolTip("Number of exit conditions configured")
        meta_layout.addWidget(exit_cond_label)
        
        self.exit_conditions_label = QLabel("0")
        exit_conditions_font = QFont()
        exit_conditions_font.setBold(True)
        exit_conditions_font.setPointSize(10)
        self.exit_conditions_label.setFont(exit_conditions_font)
        self.exit_conditions_label.setStyleSheet(f"color: {get_color('error')};")  # Red for exits
        meta_layout.addWidget(self.exit_conditions_label)
        
        # Separator
        sep4 = QLabel("|")
        sep4.setStyleSheet(f"color: {get_color('text_muted')}; font-weight: bold;")
        meta_layout.addWidget(sep4)
        
        # Time Constraint
        time_const_label = QLabel("Time Constraint:")
        time_const_label.setStyleSheet(get_label_style('muted'))
        time_const_label.setToolTip("Whether timing constraints are configured")
        meta_layout.addWidget(time_const_label)
        
        self.time_constraint_label = QLabel("No")
        time_constraint_font = QFont()
        time_constraint_font.setBold(True)
        time_constraint_font.setPointSize(10)
        self.time_constraint_label.setFont(time_constraint_font)
        self.time_constraint_label.setStyleSheet(f"color: {get_color('text_disabled')};")
        meta_layout.addWidget(self.time_constraint_label)
        
        meta_layout.addStretch()
        group_layout.addLayout(meta_layout)
        
        group_box.setLayout(group_layout)
        layout.addWidget(group_box)
        layout.addStretch()
        
        self.setLayout(layout)
    
    def _connect_signals(self):
        """Connect UI signals to handlers."""
        # Name input changes
        self.name_input.textChanged.connect(self._on_name_changed)
        
        # Strategy type radio buttons
        self.bullish_radio.toggled.connect(self._on_type_changed)
        self.bearish_radio.toggled.connect(self._on_type_changed)
    
    def _on_name_changed(self, text: str):
        """
        Handle strategy name change (triggered by user edits).
        
        Args:
            text: New strategy name (may include version for display)
        """
        # CRITICAL: Always strip version pattern when storing actual name
        # User should never be typing version suffix - it's display-only
        import re
        clean_name = text.strip()
        clean_name = re.sub(r'\s*\(v\d+\)\s*$', '', clean_name)
        self._actual_strategy_name = clean_name
        
        self.strategy_name_changed.emit(text)
    
    def _on_type_changed(self):
        """Handle strategy type change."""
        strategy_type = self.get_strategy_type()
        self.strategy_type_changed.emit(strategy_type)
    
    def get_strategy_name(self) -> str:
        """
        Get the current strategy name (WITHOUT version suffix).
        
        Returns the actual strategy name, stripping any version suffix like " (vX)"
        that may have been added for display purposes.
        
        Returns:
            Strategy name string without version
        """
        # Return stored actual name if available
        if self._actual_strategy_name:
            return self._actual_strategy_name
        
        # Otherwise get from input and strip version suffix if present
        name = self.name_input.text().strip()
        
        # Strip version suffix pattern: " (v1)", " (v13)", etc.
        import re
        name = re.sub(r'\s*\(v\d+\)\s*$', '', name)
        
        return name
    
    def set_strategy_name(self, name: str):
        """
        Set the strategy name.
        
        Args:
            name: Strategy name to set
        """
        self.name_input.setText(name)
    
    def get_strategy_type(self) -> str:
        """
        Get the current strategy type.
        
        Returns:
            "Bullish" or "Bearish"
        """
        return "Bullish" if self.bullish_radio.isChecked() else "Bearish"
    
    def set_strategy_type(self, strategy_type: str):
        """
        Set the strategy type.
        
        Args:
            strategy_type: "Bullish" or "Bearish"
        """
        if strategy_type.lower() == "bullish":
            self.bullish_radio.setChecked(True)
        elif strategy_type.lower() == "bearish":
            self.bearish_radio.setChecked(True)
    
    def get_description(self) -> str:
        """
        Get the current description.
        
        Returns:
            Description text
        """
        return self.description_text.toPlainText()
    
    def set_description(self, description: str):
        """
        Set the description text.
        
        Args:
            description: Description to set
        """
        self.description_text.setPlainText(description)
    
    def update_description_from_config(self):
        """
        Update description based on current strategy configuration.
        
        This method retrieves the current config from the orchestrator
        and generates a description from the blocks and signals.
        """
        try:
            config = self.orchestrator.get_current_config()
            
            if not config or not config.blocks:
                self.set_description("No blocks added yet...")
                return
            
            # Use the backend's generate_description() method for intelligent description
            if hasattr(self.orchestrator, 'config_engine') and hasattr(self.orchestrator.config_engine, 'generate_description'):
                generated_desc = self.orchestrator.config_engine.generate_description()
                
                # Enhance with additional information
                required_blocks = [b for b in config.blocks if b.logic == 'AND']
                optional_blocks = [b for b in config.blocks if b.logic == 'OR']
                
                # Count total required signals - ALL signals from REQUIRED blocks
                total_required_signals = 0
                for block in required_blocks:
                    total_required_signals += len(block.signals)
                
                # Count optional signals too for complete picture
                total_optional_signals = 0
                for block in optional_blocks:
                    total_optional_signals += len(block.signals)
                
                # Build stats string for label - clearer wording
                # Format: "Description: X blocks, Y signals (breakdown)"
                block_text = f"{len(config.blocks)} block(s) ({len(required_blocks)} required, {len(optional_blocks)} optional)"
                signal_text = f"{total_required_signals + total_optional_signals} signal(s) ({total_required_signals} required, {total_optional_signals} optional)"
                
                # Update label with stats
                self.desc_label.setText(f"Description: {block_text}, {signal_text}.")
                
                # Set only the actual description in text area
                description_lines = []
                description_lines.append(generated_desc)
                
                # Add timing constraint info if any
                has_timing = False
                has_recheck = False
                for block in config.blocks:
                    for signal in block.signals:
                        if signal.timing_constraint:
                            has_timing = True
                        if hasattr(signal, 'recheck_config') and signal.recheck_config and signal.recheck_config.enabled:
                            has_recheck = True
                        if has_timing and has_recheck:
                            break
                    if has_timing and has_recheck:
                        break
                
                # Combine timing and recheck info on one line if both exist
                features = []
                if has_timing:
                    features.append("timing constraints between signals")
                if has_recheck:
                    features.append("signal recheck validations")
                
                if features:
                    description_lines.append(f"\nIncludes {' and '.join(features)}.")
                
                self.set_description("\n".join(description_lines))
            else:
                # Fallback to simple description if backend method not available
                description_parts = []
                for block in config.blocks:
                    block_desc = f"- {block.name}"
                    if hasattr(block, 'signals') and block.signals:
                        signal_names = [s.name for s in block.signals[:3]]  # First 3 signals
                        block_desc += f" ({', '.join(signal_names)})"
                        if len(block.signals) > 3:
                            block_desc += f" +{len(block.signals) - 3} more"
                    description_parts.append(block_desc)
                
                if description_parts:
                    generated = "Strategy with:\n" + "\n".join(description_parts)
                    self.set_description(generated)
        except Exception as e:
            # Gracefully handle any errors
            self.set_description(f"Error generating description: {str(e)}")
    
    def get_required_signals(self) -> int:
        """
        Get the current required signals count.
        
        Returns:
            Number of required signals
        """
        return int(self.required_signals_label.text())
    
    def set_required_signals(self, count: int):
        """
        Set the required signals count.
        
        Args:
            count: Number of required signals
        """
        self.required_signals_label.setText(str(count))
        
        # Always use consistent green for any count > 0
        if count == 0:
            self.required_signals_label.setStyleSheet(f"color: {get_color('text_disabled')};")
        else:
            self.required_signals_label.setStyleSheet(f"color: {get_color('success')}; font-weight: bold;")
    
    def update_required_signals_from_config(self):
        """
        Update required signals count based on current strategy configuration.
        
        ALWAYS calculates from blocks - never trusts stored required_signals value
        because it may be stale/incorrect when loading from JSON.
        """
        try:
            config = self.orchestrator.get_current_config()
            
            # ALWAYS calculate from blocks - count ALL signals from REQUIRED blocks
            # Don't use config.required_signals as it may be stale
            total_required = 0
            if config and hasattr(config, 'blocks'):
                for block in config.blocks:
                    if hasattr(block, 'logic') and block.logic == "AND":
                        # For REQUIRED (AND) blocks: count ALL signals
                        if hasattr(block, 'signals'):
                            total_required += len(block.signals)
            
            self.set_required_signals(total_required)
        except Exception as e:
            # Gracefully handle errors
            self.set_required_signals(0)
    
    def refresh_from_orchestrator(self):
        """
        Refresh all fields from the orchestrator's current configuration.

        This is called when the strategy configuration changes elsewhere
        in the application.
        """
        # Update strategy name from config
        try:
            config = self.orchestrator.get_current_config()
            if config and hasattr(config, 'name') and config.name:
                # CRITICAL: Store actual name (without version) separately
                self._actual_strategy_name = config.name
                
                # Include version in display if available
                display_name = config.name
                if hasattr(config, 'version') and config.version:
                    display_name = f"{config.name} (v{config.version})"
                
                # CRITICAL: Block signals during programmatic update
                # This prevents _on_name_changed from overwriting _actual_strategy_name
                self.name_input.blockSignals(True)
                self.set_strategy_name(display_name)
                self.name_input.blockSignals(False)
            
            # CRITICAL: Also load strategy_type from config
            # Block signals during programmatic update to prevent triggering change events
            if config and hasattr(config, 'strategy_type'):
                self.bullish_radio.blockSignals(True)
                self.bearish_radio.blockSignals(True)
                self.set_strategy_type(config.strategy_type)
                self.bullish_radio.blockSignals(False)
                self.bearish_radio.blockSignals(False)
        except Exception:
            pass  # Gracefully handle if config not available

        self.update_description_from_config()
        self.update_required_signals_from_config()
        self._update_metadata_row()
    
    def _update_metadata_row(self):
        """Update the metadata row (optional signals and time constraint)."""
        try:
            config = self.orchestrator.get_current_config()
            
            if not config or not config.blocks:
                self.optional_signals_label.setText("0")
                self.optional_signals_label.setStyleSheet(f"color: {get_color('text_disabled')};")
                self.time_constraint_label.setText("No")
                self.time_constraint_label.setStyleSheet(f"color: {get_color('text_disabled')};")
                return
            
            # Count optional signals - ONLY from OR (OPTIONAL) blocks
            # Signal logic within blocks doesn't matter - block logic determines requirement
            optional_count = 0
            for block in config.blocks:
                if block.logic == "OR":
                    # Count all signals in OPTIONAL blocks
                    optional_count += len(block.signals) if hasattr(block, 'signals') else 0
            
            self.optional_signals_label.setText(str(optional_count))
            if optional_count > 0:
                self.optional_signals_label.setStyleSheet(f"color: {get_color('info')}; font-weight: bold;")
            else:
                self.optional_signals_label.setStyleSheet(f"color: {get_color('text_disabled')};")
            
            # Count rechecked signals - signals with recheck validation configured
            recheck_count = 0
            for block in config.blocks:
                if hasattr(block, 'signals'):
                    for signal in block.signals:
                        if hasattr(signal, 'recheck_config') and signal.recheck_config and signal.recheck_config.enabled:
                            recheck_count += 1
            
            self.rechecked_signals_label.setText(str(recheck_count))
            if recheck_count > 0:
                self.rechecked_signals_label.setStyleSheet(f"color: {get_color('warning')}; font-weight: bold;")
            else:
                self.rechecked_signals_label.setStyleSheet(f"color: {get_color('text_disabled')};")
            
            # Check for time constraints
            has_timing = False
            for block in config.blocks:
                if hasattr(block, 'signals'):
                    for signal in block.signals:
                        if hasattr(signal, 'timing_constraint') and signal.timing_constraint:
                            has_timing = True
                            break
                if has_timing:
                    break
            
            if has_timing:
                self.time_constraint_label.setText("Yes")
                self.time_constraint_label.setStyleSheet(f"color: {get_color('success')}; font-weight: bold;")
            else:
                self.time_constraint_label.setText("No")
                self.time_constraint_label.setStyleSheet(f"color: {get_color('text_disabled')};")
            
            # Sprint 1.8 Task 1.8.53: Call exit conditions count update
            self._update_exit_conditions_count()
                
        except Exception as e:
            # Gracefully handle errors
            self.optional_signals_label.setText("0")
            self.time_constraint_label.setText("No")
    
    def _update_exit_conditions_count(self):
        """Count exit conditions across all levels - Sprint 1.8 Task 1.8.52"""
        try:
            config = self.orchestrator.get_current_config()
            count = 0
            
            if config:
                # Strategy-level exits
                if hasattr(config, 'exit_conditions') and config.exit_conditions:
                    count += len(config.exit_conditions)
                
                # Block-level exits
                if hasattr(config, 'blocks'):
                    for block in config.blocks:
                        if hasattr(block, 'exit_conditions') and block.exit_conditions:
                            count += len(block.exit_conditions)
                        
                        # Signal-level exits
                        if hasattr(block, 'signals'):
                            for signal in block.signals:
                                if hasattr(signal, 'exit_conditions') and signal.exit_conditions:
                                    count += len(signal.exit_conditions)
            
            self.exit_conditions_label.setText(str(count))
            if count > 0:
                self.exit_conditions_label.setStyleSheet(f"color: {get_color('error')}; font-weight: bold;")
            else:
                self.exit_conditions_label.setStyleSheet(f"color: {get_color('text_disabled')};")
        except Exception:
            self.exit_conditions_label.setText("0")
    
    def create_strategy_in_orchestrator(self) -> bool:
        """
        Create/update the strategy in the orchestrator with current panel values.
        
        Returns:
            True if successful, False otherwise
        """
        name = self.get_strategy_name()
        description = self.get_description()
        
        if not name:
            return False
        
        try:
            result = self.orchestrator.create_strategy(name, description)
            return result.success if hasattr(result, 'success') else False
        except Exception:
            return False
