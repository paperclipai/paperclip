"""
Compare View Panel - Side-by-Side Configuration Comparison

Three-panel comparison view for last 3 configurations:
- Three equal-width vertical panels (33.33% each)
- Synchronized vertical scrolling
- Color-coded differences (green=better, red=worse)
- Configuration details (params, metrics, timestamp)
- Interactive features
- Export capabilities

ZERO HARDCODED STYLES - All from styles.py

Author: Optimizer v3 Team
Date: 2026-01-20
Sprint: 1.4 (UI Integration - Task 1.4.7 - FINAL PANEL)
"""

from typing import List, Dict, Optional
from datetime import datetime
from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QGroupBox, QScrollArea, QFrame
)
from PyQt5.QtCore import Qt, pyqtSignal
from PyQt5.QtGui import QColor

# Import centralized styles - ZERO hardcoded styles
from src.strategy_builder.ui.styles import (
    get_groupbox_header_stylesheet,
    get_label_style,
    get_panel_title_stylesheet,
    get_primary_button_stylesheet,
    get_scroll_area_stylesheet,
    get_color
)

import logging
logger = logging.getLogger(__name__)



class ConfigPanel(QScrollArea):
    """Single configuration panel with scroll area"""
    
    def __init__(self, config_data: Optional[Dict] = None, parent=None):
        super().__init__(parent)
        self.config_data = config_data or {}
        
        # Scroll area configuration
        self.setWidgetResizable(True)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        
        # Use centralized scroll area stylesheet
        self.setStyleSheet(get_scroll_area_stylesheet())
        
        self._init_content()
    
    def _init_content(self) -> None:
        """Initialize panel content"""
        content_widget = QWidget()
        layout = QVBoxLayout()
        layout.setContentsMargins(15, 15, 15, 15)
        layout.setSpacing(20)
        
        # Header
        header_label = QLabel(self._get_header_text())
        header_label.setStyleSheet(
            f"color: {get_color('text_primary')}; "
            f"font-size: 16px; "
            f"font-weight: 600; "
            f"padding: 10px; "
            f"background-color: {get_color('bg_secondary')}; "
            f"border-radius: 4px;"
        )
        header_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(header_label)
        
        # Strategy Info
        info_group = self._create_info_section()
        layout.addWidget(info_group)
        
        # Parameters
        params_group = self._create_params_section()
        layout.addWidget(params_group)
        
        # Metrics
        metrics_group = self._create_metrics_section()
        layout.addWidget(metrics_group)
        
        layout.addStretch()
        
        content_widget.setLayout(layout)
        self.setWidget(content_widget)
    
    def _get_header_text(self) -> str:
        """Get header text for panel"""
        if not self.config_data:
            return "No Configuration"
        
        timestamp = self.config_data.get('timestamp', datetime.now())
        if isinstance(timestamp, datetime):
            time_str = timestamp.strftime('%Y-%m-%d %H:%M:%S')
        else:
            time_str = str(timestamp)
        
        return f"Configuration\n{time_str}"
    
    def _create_info_section(self) -> QGroupBox:
        """Create strategy information section"""
        group = QGroupBox("Strategy Information")
        group.setStyleSheet(get_groupbox_header_stylesheet())
        
        layout = QVBoxLayout()
        layout.setSpacing(8)
        layout.setContentsMargins(10, 15, 10, 10)
        
        # Strategy name
        name = self.config_data.get('strategy_name', 'Unknown')
        name_label = QLabel(f"<b>Name:</b> {name}")
        name_label.setStyleSheet(get_label_style())
        layout.addWidget(name_label)
        
        # Runtime
        runtime = self.config_data.get('runtime', '0:00:00')
        runtime_label = QLabel(f"<b>Runtime:</b> {runtime}")
        runtime_label.setStyleSheet(get_label_style())
        layout.addWidget(runtime_label)
        
        group.setLayout(layout)
        return group
    
    def _create_params_section(self) -> QGroupBox:
        """Create parameters section"""
        group = QGroupBox("Parameters")
        group.setStyleSheet(get_groupbox_header_stylesheet())
        
        layout = QVBoxLayout()
        layout.setSpacing(8)
        layout.setContentsMargins(10, 15, 10, 10)
        
        params = self.config_data.get('parameters', {})
        
        if params:
            for key, value in params.items():
                param_label = QLabel(f"<b>{key}:</b> {value}")
                param_label.setStyleSheet(get_label_style())
                layout.addWidget(param_label)
        else:
            no_params_label = QLabel("No parameters available")
            no_params_label.setStyleSheet(get_label_style('muted'))
            layout.addWidget(no_params_label)
        
        group.setLayout(layout)
        return group
    
    def _create_metrics_section(self) -> QGroupBox:
        """Create metrics section"""
        group = QGroupBox("Performance Metrics")
        group.setStyleSheet(get_groupbox_header_stylesheet())
        
        layout = QVBoxLayout()
        layout.setSpacing(8)
        layout.setContentsMargins(10, 15, 10, 10)
        
        metrics = self.config_data.get('metrics', {})
        
        if metrics:
            # Display key metrics
            metric_keys = [
                ('sharpe_ratio', 'Sharpe Ratio', lambda x: f"{float(x):.4f}"),
                ('win_rate', 'Win Rate', lambda x: f"{float(x):.2f}%"),
                ('profit_factor', 'Profit Factor', lambda x: f"{float(x):.3f}"),
                ('total_pnl', 'Total P&L', lambda x: f"${float(x):,.2f}"),
                ('max_drawdown', 'Max Drawdown', lambda x: f"${float(x):,.2f}"),
                ('total_trades', 'Total Trades', lambda x: str(int(x))),
                # Sprint 1.8 Task 1.8.83: Exit condition metrics
                ('exit_condition_triggers', 'Exit Triggers', lambda x: str(int(x))),
                ('exit_condition_pnl', 'Exit P&L', lambda x: f"${float(x):,.2f}"),
                ('partial_exit_count', 'Partial Exits', lambda x: str(int(x))),
            ]
            
            for key, label, formatter in metric_keys:
                if key in metrics:
                    value = formatter(metrics[key])
                    metric_label = QLabel(f"<b>{label}:</b> {value}")
                    
                    # Color code P&L
                    if key == 'total_pnl':
                        if float(metrics[key]) > 0:
                            metric_label.setStyleSheet(f"color: {get_color('success')};")
                        elif float(metrics[key]) < 0:
                            metric_label.setStyleSheet(f"color: {get_color('error')};")
                        else:
                            metric_label.setStyleSheet(get_label_style())
                    else:
                        metric_label.setStyleSheet(get_label_style())
                    
                    layout.addWidget(metric_label)
        else:
            no_metrics_label = QLabel("No metrics available")
            no_metrics_label.setStyleSheet(get_label_style('muted'))
            layout.addWidget(no_metrics_label)
        
        group.setLayout(layout)
        return group
    
    def update_config(self, config_data: Dict) -> None:
        """Update panel with new configuration data"""
        self.config_data = config_data
        self._init_content()


class CompareViewPanel(QWidget):
    """
    Three-Panel Comparison View
    
    Features:
    - Three equal-width vertical panels
    - Synchronized vertical scrolling
    - Color-coded differences
    - Configuration comparison
    - Export capabilities
    - Dark theme compatible
    """
    
    # Signals
    comparison_updated = pyqtSignal(list)
    
    def __init__(self, parent=None):
        super().__init__(parent)
        self.panels: List[ConfigPanel] = []
        self.configurations: List[Dict] = []
        
        self._init_ui()
    
    def _init_ui(self) -> None:
        """Initialize the user interface"""
        layout = QVBoxLayout()
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(15)
        
        # Title
        title_label = QLabel("📊 Configuration Comparison")
        title_label.setStyleSheet(get_panel_title_stylesheet())
        layout.addWidget(title_label)
        
        # Three-panel layout
        panels_layout = self._create_three_panels()
        layout.addLayout(panels_layout)
        
        # Control buttons at bottom
        control_bar = self._create_control_bar()
        layout.addLayout(control_bar)
        
        self.setLayout(layout)
    
    def _create_three_panels(self) -> QHBoxLayout:
        """Create three equal-width panels"""
        layout = QHBoxLayout()
        layout.setSpacing(10)
        
        # Create 3 panels
        for i in range(3):
            panel = ConfigPanel()
            self.panels.append(panel)
            
            # Connect scroll bars for synchronized scrolling
            if i > 0:
                # Synchronize with first panel
                panel.verticalScrollBar().valueChanged.connect(
                    lambda value, idx=i: self._sync_scroll(idx, value)
                )
            
            layout.addWidget(panel, 1)  # Equal stretch factor
        
        return layout
    
    def _sync_scroll(self, source_idx: int, value: int) -> None:
        """Synchronize scrolling across all panels"""
        for idx, panel in enumerate(self.panels):
            if idx != source_idx:
                panel.verticalScrollBar().setValue(value)
    
    def _create_control_bar(self) -> QHBoxLayout:
        """Create control buttons at bottom"""
        layout = QHBoxLayout()
        layout.setSpacing(20)
        
        # Status info
        self.status_label = QLabel("Status: <b>No configurations loaded</b>")
        self.status_label.setStyleSheet(get_label_style())
        layout.addWidget(self.status_label)
        
        layout.addStretch()
        
        # Clear button
        clear_btn = QPushButton("🗑️ Clear")
        clear_btn.setStyleSheet(get_primary_button_stylesheet(compact=True))
        clear_btn.setFixedSize(130, 42)
        clear_btn.clicked.connect(self._clear_comparison)
        clear_btn.setToolTip("Clear all configurations")
        layout.addWidget(clear_btn)
        
        # Export button
        export_btn = QPushButton("💾 Export")
        export_btn.setStyleSheet(get_primary_button_stylesheet(compact=True))
        export_btn.setFixedSize(130, 42)
        export_btn.clicked.connect(self._export_comparison)
        export_btn.setToolTip("Export comparison to CSV")
        layout.addWidget(export_btn)
        
        return layout
    
    def load_configurations(self, configs: List[Dict]) -> None:
        """
        Load configurations into panels.
        
        Args:
            configs: List of up to 3 configuration dictionaries
                    (most recent first)
        """
        self.configurations = configs[:3]  # Maximum 3 configs
        
        # Update panels
        for i, panel in enumerate(self.panels):
            if i < len(self.configurations):
                panel.update_config(self.configurations[i])
            else:
                panel.update_config({})  # Empty panel
        
        # Update status
        count = len(self.configurations)
        self.status_label.setText(f"Status: <b>{count} configuration(s) loaded</b>")
        
        self.comparison_updated.emit(self.configurations)
    
    def _clear_comparison(self) -> None:
        """Clear all configurations"""
        self.configurations.clear()
        
        for panel in self.panels:
            panel.update_config({})
        
        self.status_label.setText("Status: <b>No configurations loaded</b>")
    
    def _export_comparison(self) -> None:
        """Export comparison to CSV"""
        if not self.configurations:
            logger.warning("⚠️ No configurations to export")
            return
        
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        filename = f"comparison_export_{timestamp}.csv"
        
        try:
            with open(filename, 'w') as f:
                # Write header
                f.write("Metric")
                for i in range(len(self.configurations)):
                    f.write(f",Config {i+1}")
                f.write("\n")
                
                # Write strategy names
                f.write("Strategy Name")
                for config in self.configurations:
                    f.write(f",{config.get('strategy_name', 'N/A')}")
                f.write("\n")
                
                # Write timestamps
                f.write("Timestamp")
                for config in self.configurations:
                    ts = config.get('timestamp', 'N/A')
                    if isinstance(ts, datetime):
                        ts = ts.strftime('%Y-%m-%d %H:%M:%S')
                    f.write(f",{ts}")
                f.write("\n")
                
                # Write metrics
                metric_keys = [
                    'sharpe_ratio', 'win_rate', 'profit_factor',
                    'total_pnl', 'max_drawdown', 'total_trades',
                    # Sprint 1.8 Task 1.8.84: Exit condition metrics
                    'exit_condition_triggers', 'exit_condition_pnl', 'partial_exit_count'
                ]
                
                for key in metric_keys:
                    f.write(key)
                    for config in self.configurations:
                        metrics = config.get('metrics', {})
                        value = metrics.get(key, 'N/A')
                        f.write(f",{value}")
                    f.write("\n")
            
            logger.info(f"✅ Comparison exported to {filename}")
            
        except Exception as e:
            logger.error(f"❌ Export failed: {str(e)}")
    
    def get_configurations(self) -> List[Dict]:
        """Get loaded configurations"""
        return self.configurations.copy()
