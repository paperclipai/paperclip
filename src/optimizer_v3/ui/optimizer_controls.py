"""
Optimizer Controls Panel - Window 2 Tab 1 Extension

Adds optimizer functionality to existing Backtest Configuration Tab 1:
- Optimize button to trigger parameter optimization
- Parameter selection checkboxes for optimization targets
- Configuration count estimator
- Zero hardcoded styles (uses styles.py)

Author: Optimizer v3 Team
Date: 2026-01-20
Sprint: 1.4 (UI Integration)
"""

from typing import List, Dict, Optional, Callable
from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QGroupBox, QCheckBox, QSpinBox, QGridLayout
)
from PyQt5.QtCore import Qt, pyqtSignal
from decimal import Decimal

# Import centralized styles - ZERO hardcoded styles
from src.strategy_builder.ui.styles import (
    get_primary_button_stylesheet,
    get_checkbox_style,
    get_groupbox_header_stylesheet,
    get_label_style,
    get_panel_title_stylesheet,
    get_color,
    COLORS
)


class OptimizerControls(QWidget):
    """
    Optimizer controls for Backtest Configuration Tab 1.
    
    Provides:
    - Optimize button to trigger parameter optimization
    - Parameter selection checkboxes
    - Configuration count estimator
    - Integration with existing backtest configuration
    """
    
    # Signals
    optimize_clicked = pyqtSignal(dict)  # Emits selected parameters
    
    def __init__(self, parent=None):
        super().__init__(parent)
        self.selected_params: Dict[str, bool] = {}
        self._init_ui()
    
    def _init_ui(self) -> None:
        """Initialize the user interface"""
        layout = QVBoxLayout()
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(15)
        
        # Title
        title_label = QLabel("💠 Parameter Optimization")
        title_label.setStyleSheet(get_panel_title_stylesheet())
        layout.addWidget(title_label)
        
        # Parameter Selection Group
        param_group = self._create_parameter_selection_group()
        layout.addWidget(param_group)
        
        # Config Count Estimator
        estimator_group = self._create_config_estimator_group()
        layout.addWidget(estimator_group)
        
        # Optimize Button
        optimize_layout = self._create_optimize_button()
        layout.addLayout(optimize_layout)
        
        layout.addStretch()
        self.setLayout(layout)
    
    def _create_parameter_selection_group(self) -> QGroupBox:
        """Create parameter selection checkbox group"""
        group = QGroupBox("Select Parameters to Optimize")
        group.setStyleSheet(get_groupbox_header_stylesheet())
        
        layout = QGridLayout()
        layout.setSpacing(12)
        
        # Define optimizable parameters with descriptions
        parameters = [
            # Stop Loss Parameters
            ('delay_bars', 'Stop Loss Delay (bars)', 
             'Optimize the delay period before SL activation'),
            ('emergency_sl', 'Emergency SL (%)',
             'Optimize catastrophic loss protection level'),
            ('vol_lookback', 'Volatility Lookback (bars)',
             'Optimize ATR calculation period'),
            ('vol_multiplier', 'Volatility Multiplier',
             'Optimize ATR multiplier for SL distance'),
            ('min_sl', 'Min Stop Loss (%)',
             'Optimize minimum SL distance'),
            ('max_sl', 'Max Stop Loss (%)',
             'Optimize maximum SL distance'),
            
            # Risk/Reward Parameters
            ('risk_reward', 'Min Risk:Reward Ratio',
             'Optimize minimum required R:R ratio'),
            ('risk_percent', 'Risk Per Trade (%)',
             'Optimize risk percentage per trade'),
            ('leverage', 'Max Leverage',
             'Optimize maximum leverage multiplier'),
            ('confluence', 'Min Confluence Points',
             'Optimize signal strength requirement'),
            ('max_bars_held', 'Max Bars Held',
             'Optimize maximum position hold time'),
            
            # TP/SL Configuration
            ('tpsl_mode', 'TP/SL Mode',
             'Test different TP/SL calculation methods'),
            ('sl_adjustment', 'SL Adjustment Mode',
             'Test Adaptive vs Static SL adjustment'),
        ]
        
        # Create checkboxes in 2-column grid
        self.param_checkboxes: Dict[str, QCheckBox] = {}
        row = 0
        col = 0
        
        for param_key, param_label, param_tooltip in parameters:
            checkbox = QCheckBox(param_label)
            checkbox.setStyleSheet(get_checkbox_style())
            checkbox.setToolTip(param_tooltip)
            checkbox.setChecked(False)  # Default: none selected
            checkbox.stateChanged.connect(self._on_param_selection_changed)
            
            self.param_checkboxes[param_key] = checkbox
            layout.addWidget(checkbox, row, col)
            
            # Alternate columns (2 per row)
            col += 1
            if col >= 2:
                col = 0
                row += 1
        
        # Select All / Clear All buttons
        button_layout = QHBoxLayout()
        button_layout.setSpacing(10)
        
        select_all_btn = QPushButton("✓ Select All")
        select_all_btn.setStyleSheet(get_primary_button_stylesheet(compact=True))
        select_all_btn.clicked.connect(self._select_all_params)
        button_layout.addWidget(select_all_btn)
        
        clear_all_btn = QPushButton("✗ Clear All")
        clear_all_btn.setStyleSheet(get_primary_button_stylesheet(compact=True))
        clear_all_btn.clicked.connect(self._clear_all_params)
        button_layout.addWidget(clear_all_btn)
        
        button_layout.addStretch()
        
        layout.addLayout(button_layout, row + 1, 0, 1, 2)
        
        group.setLayout(layout)
        return group
    
    def _create_config_estimator_group(self) -> QGroupBox:
        """Create configuration count estimator group"""
        group = QGroupBox("Optimization Complexity")
        group.setStyleSheet(get_groupbox_header_stylesheet())
        
        layout = QVBoxLayout()
        layout.setSpacing(10)
        
        # Explanation label
        info_label = QLabel(
            "Configure how many values to test for each selected parameter.\n"
            "Total configurations = Steps^SelectedParameters"
        )
        info_label.setStyleSheet(get_label_style('muted'))
        info_label.setWordWrap(True)
        layout.addWidget(info_label)
        
        # Steps per parameter control
        steps_layout = QHBoxLayout()
        steps_layout.setSpacing(10)
        
        steps_label = QLabel("Steps per parameter:")
        steps_label.setStyleSheet(get_label_style())
        steps_layout.addWidget(steps_label)
        
        self.steps_spin = QSpinBox()
        self.steps_spin.setRange(3, 20)
        self.steps_spin.setValue(5)
        self.steps_spin.setSuffix(" values")
        self.steps_spin.setToolTip(
            "Number of values to test for each parameter.\n\n"
            "Examples:\n"
            "• 3 steps: Min, Mid, Max\n"
            "• 5 steps: More granular testing (recommended)\n"
            "• 10+ steps: Very thorough, longer runtime"
        )
        self.steps_spin.valueChanged.connect(self._update_config_estimate)
        steps_layout.addWidget(self.steps_spin)
        
        steps_layout.addStretch()
        layout.addLayout(steps_layout)
        
        # Configuration count display
        count_layout = QHBoxLayout()
        count_layout.setSpacing(10)
        
        count_label = QLabel("Total configurations:")
        count_label.setStyleSheet(get_label_style())
        count_layout.addWidget(count_label)
        
        self.config_count_label = QLabel("<b>0</b>")
        self.config_count_label.setStyleSheet(
            f"color: {COLORS['info']}; font-size: 16pt; font-weight: bold;"
        )
        count_layout.addWidget(self.config_count_label)
        
        count_layout.addStretch()
        layout.addLayout(count_layout)
        
        # Estimated time display
        time_layout = QHBoxLayout()
        time_layout.setSpacing(10)
        
        time_label = QLabel("Estimated time:")
        time_label.setStyleSheet(get_label_style())
        time_layout.addWidget(time_label)
        
        self.estimated_time_label = QLabel("<b>~ 0 min</b>")
        self.estimated_time_label.setStyleSheet(
            f"color: {COLORS['text_secondary']}; font-size: 12pt;"
        )
        time_layout.addWidget(self.estimated_time_label)
        
        time_layout.addStretch()
        layout.addLayout(time_layout)
        
        # Warning for large configurations
        self.warning_label = QLabel("")
        self.warning_label.setStyleSheet(
            f"color: {COLORS['warning']}; font-weight: bold;"
        )
        self.warning_label.setWordWrap(True)
        self.warning_label.setVisible(False)
        layout.addWidget(self.warning_label)
        
        group.setLayout(layout)
        return group
    
    def _create_optimize_button(self) -> QHBoxLayout:
        """Create optimize button layout"""
        layout = QHBoxLayout()
        layout.setSpacing(10)
        
        # Main optimize button
        self.optimize_btn = QPushButton("🚀 Start Optimization")
        self.optimize_btn.setStyleSheet(get_primary_button_stylesheet())
        self.optimize_btn.setMinimumHeight(40)
        self.optimize_btn.setEnabled(False)  # Disabled until params selected
        self.optimize_btn.clicked.connect(self._on_optimize_clicked)
        self.optimize_btn.setToolTip(
            "Start Parameter Optimization\n\n"
            "Will test all combinations of selected parameters\n"
            "to find the optimal configuration for your strategy.\n\n"
            "Requirements:\n"
            "• At least one parameter selected\n"
            "• Valid backtest configuration\n"
            "• Strategy properly configured"
        )
        layout.addWidget(self.optimize_btn)
        
        # Status label
        self.status_label = QLabel("Select parameters to enable optimization")
        self.status_label.setStyleSheet(get_label_style('muted'))
        layout.addWidget(self.status_label)
        
        layout.addStretch()
        return layout
    
    def _on_param_selection_changed(self) -> None:
        """Handle parameter selection change"""
        # Update selected params dict
        self.selected_params = {
            key: checkbox.isChecked()
            for key, checkbox in self.param_checkboxes.items()
        }
        
        # Count selected parameters
        selected_count = sum(1 for checked in self.selected_params.values() if checked)
        
        # Update optimize button state
        self.optimize_btn.setEnabled(selected_count > 0)
        
        # Update status label
        if selected_count == 0:
            self.status_label.setText("Select parameters to enable optimization")
            self.status_label.setStyleSheet(get_label_style('muted'))
        else:
            self.status_label.setText(
                f"{selected_count} parameter{'s' if selected_count != 1 else ''} selected"
            )
            self.status_label.setStyleSheet(
                f"color: {COLORS['success']}; font-weight: bold;"
            )
        
        # Update config count estimate
        self._update_config_estimate()
    
    def _update_config_estimate(self) -> None:
        """Update configuration count estimate"""
        selected_count = sum(1 for checked in self.selected_params.values() if checked)
        steps = self.steps_spin.value()
        
        if selected_count == 0:
            total_configs = 0
        else:
            total_configs = steps ** selected_count
        
        # Update count label
        self.config_count_label.setText(f"<b>{total_configs:,}</b>")
        
        # Update color based on size
        if total_configs == 0:
            color = COLORS['text_muted']
        elif total_configs <= 125:  # 5^3 or less
            color = COLORS['success']
        elif total_configs <= 3125:  # 5^5 or less
            color = COLORS['info']
        else:
            color = COLORS['warning']
        
        self.config_count_label.setStyleSheet(
            f"color: {color}; font-size: 16pt; font-weight: bold;"
        )
        
        # Estimate time (rough: 2 seconds per config)
        estimated_seconds = total_configs * 2
        
        if estimated_seconds < 60:
            time_str = f"~ {estimated_seconds} sec"
        elif estimated_seconds < 3600:
            time_str = f"~ {estimated_seconds // 60} min"
        elif estimated_seconds < 86400:
            time_str = f"~ {estimated_seconds // 3600} hr {(estimated_seconds % 3600) // 60} min"
        else:
            time_str = f"~ {estimated_seconds // 86400} days"
        
        self.estimated_time_label.setText(f"<b>{time_str}</b>")
        
        # Show warning for very large configurations
        if total_configs > 10000:
            self.warning_label.setText(
                f"⚠️ Warning: {total_configs:,} configurations will take significant time. "
                "Consider reducing steps or selected parameters."
            )
            self.warning_label.setVisible(True)
        elif total_configs > 5000:
            self.warning_label.setText(
                f"⚡ Note: {total_configs:,} configurations may take a while. "
                "Optimization will run in background."
            )
            self.warning_label.setVisible(True)
        else:
            self.warning_label.setVisible(False)
    
    def _select_all_params(self) -> None:
        """Select all parameter checkboxes"""
        for checkbox in self.param_checkboxes.values():
            checkbox.setChecked(True)
    
    def _clear_all_params(self) -> None:
        """Clear all parameter checkboxes"""
        for checkbox in self.param_checkboxes.values():
            checkbox.setChecked(False)
    
    def _on_optimize_clicked(self) -> None:
        """Handle optimize button click"""
        # Get selected parameters
        selected = {
            key: True
            for key, checked in self.selected_params.items()
            if checked
        }
        
        if not selected:
            return
        
        # Emit signal with optimization configuration
        config = {
            'selected_params': selected,
            'steps_per_param': self.steps_spin.value(),
            'total_configs': int(self.config_count_label.text().replace('<b>', '').replace('</b>', '').replace(',', ''))
        }
        
        self.optimize_clicked.emit(config)
    
    def get_selected_parameters(self) -> Dict[str, bool]:
        """
        Get currently selected parameters.
        
        Returns:
            Dictionary mapping parameter keys to selection status
        """
        return self.selected_params.copy()
    
    def get_optimization_config(self) -> Dict:
        """
        Get complete optimization configuration.
        
        Returns:
            Dictionary with optimization settings
        """
        return {
            'selected_params': {
                key: True
                for key, checked in self.selected_params.items()
                if checked
            },
            'steps_per_param': self.steps_spin.value(),
            'total_configs': self._calculate_total_configs()
        }
    
    def _calculate_total_configs(self) -> int:
        """Calculate total configuration count"""
        selected_count = sum(1 for checked in self.selected_params.values() if checked)
        if selected_count == 0:
            return 0
        return self.steps_spin.value() ** selected_count
    
    def set_enabled(self, enabled: bool) -> None:
        """
        Enable or disable the entire optimizer controls.
        
        Args:
            enabled: Whether to enable the controls
        """
        for checkbox in self.param_checkboxes.values():
            checkbox.setEnabled(enabled)
        self.steps_spin.setEnabled(enabled)
        self._on_param_selection_changed()  # Update button state
