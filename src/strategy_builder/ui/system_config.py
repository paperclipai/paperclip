from PyQt6.QtWidgets import (
    QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, QTabWidget,
    QLabel, QSpinBox, QDoubleSpinBox, QCheckBox, QLineEdit,
    QPushButton, QScrollArea, QGroupBox, QFormLayout
)
from src.strategy_builder.ui.styles import (
    WINDOW_STYLE,
    PANEL_STYLE,
    TAB_STYLE,
    FORM_STYLE,
    BUTTON_STYLE,
    LABEL_STYLE,
    INPUT_STYLE,
    GROUPBOX_STYLE,
    SPACING_UNIT,
    create_font,
    PRIMARY_COLOR,
    SECONDARY_COLOR,
    WindowGeometryMixin,
)
from decimal import Decimal
import os
from dotenv import load_dotenv, set_key

class SystemConfigWindow(WindowGeometryMixin, QMainWindow):
    """System configuration window with consistent styling"""

    GEOMETRY_SETTINGS_KEY = "systemConfigWindow"
    GEOMETRY_DEFAULT_SIZE = (900, 700)

    def __init__(self):
        super().__init__()
        self.setWindowTitle("System Configuration")
        self.setStyleSheet(WINDOW_STYLE)
        self.setup_ui()
        self.load_current_config()
    
    def setup_ui(self):
        central = QWidget()
        layout = QVBoxLayout()
        layout.setSpacing(SPACING_UNIT)
        
        # Create tab widget
        tabs = QTabWidget()
        tabs.setStyleSheet(TAB_STYLE)
        tabs.setFont(create_font())
        
        # Add configuration tabs
        tabs.addTab(self.create_block_config_tab(), "Block Optimization")
        tabs.addTab(self.create_signal_config_tab(), "Signal Logic")
        tabs.addTab(self.create_market_config_tab(), "Market Conditions")
        tabs.addTab(self.create_system_config_tab(), "System Integration")
        tabs.addTab(self.create_security_config_tab(), "Security")
        tabs.addTab(self.create_monitoring_config_tab(), "Monitoring")
        
        layout.addWidget(tabs)
        
        # Add save/reset buttons
        button_layout = QHBoxLayout()
        button_layout.setSpacing(SPACING_UNIT)
        
        save_btn = QPushButton("Save Configuration")
        save_btn.setStyleSheet(BUTTON_STYLE)
        save_btn.setFont(create_font(bold=True))
        save_btn.clicked.connect(self.save_configuration)
        
        reset_btn = QPushButton("Reset to Defaults")
        reset_btn.setStyleSheet(BUTTON_STYLE)
        reset_btn.setFont(create_font())
        reset_btn.clicked.connect(self.reset_to_defaults)
        
        button_layout.addWidget(save_btn)
        button_layout.addWidget(reset_btn)
        layout.addLayout(button_layout)
        
        central.setLayout(layout)
        self.setCentralWidget(central)
    
    def create_block_config_tab(self) -> QWidget:
        """Create block optimization configuration tab"""
        tab = QWidget()
        layout = QVBoxLayout()
        layout.setSpacing(SPACING_UNIT)
        
        # Testing group
        test_group = QGroupBox("Testing Configuration")
        test_group.setStyleSheet(GROUPBOX_STYLE)
        test_group.setFont(create_font(bold=True))
        
        test_form = QFormLayout()
        test_form.setSpacing(SPACING_UNIT)
        
        self.block_max_combinations = QSpinBox()
        self.block_max_combinations.setStyleSheet(INPUT_STYLE)
        self.block_max_combinations.setRange(1, 1000)
        test_form.addRow("Maximum Combinations:", self.block_max_combinations)
        
        self.block_min_impact = QDoubleSpinBox()
        self.block_min_impact.setStyleSheet(INPUT_STYLE)
        self.block_min_impact.setRange(0.01, 1.0)
        self.block_min_impact.setSingleStep(0.01)
        test_form.addRow("Minimum Impact:", self.block_min_impact)
        
        test_group.setLayout(test_form)
        layout.addWidget(test_group)
        
        # Performance group
        perf_group = QGroupBox("Performance Requirements")
        perf_group.setStyleSheet(GROUPBOX_STYLE)
        perf_group.setFont(create_font(bold=True))
        
        perf_form = QFormLayout()
        perf_form.setSpacing(SPACING_UNIT)
        
        self.perf_min_improvement = QDoubleSpinBox()
        self.perf_min_improvement.setStyleSheet(INPUT_STYLE)
        self.perf_min_improvement.setRange(0.01, 1.0)
        self.perf_min_improvement.setSingleStep(0.01)
        perf_form.addRow("Minimum Improvement:", self.perf_min_improvement)
        
        self.perf_min_win_rate = QDoubleSpinBox()
        self.perf_min_win_rate.setStyleSheet(INPUT_STYLE)
        self.perf_min_win_rate.setRange(0.1, 1.0)
        self.perf_min_win_rate.setSingleStep(0.05)
        perf_form.addRow("Minimum Win Rate:", self.perf_min_win_rate)
        
        perf_group.setLayout(perf_form)
        layout.addWidget(perf_group)
        
        # Add more groups for other block optimization settings...
        
        # Wrap in scroll area
        scroll = QScrollArea()
        scroll.setWidget(tab)
        scroll.setWidgetResizable(True)
        tab.setLayout(layout)
        
        return scroll
    
    def create_signal_config_tab(self) -> QWidget:
        """Create signal logic configuration tab"""
        tab = QWidget()
        layout = QVBoxLayout()
        layout.setSpacing(SPACING_UNIT)
        
        # Logic group
        logic_group = QGroupBox("Logic Configuration")
        logic_group.setStyleSheet(GROUPBOX_STYLE)
        logic_group.setFont(create_font(bold=True))
        
        logic_form = QFormLayout()
        logic_form.setSpacing(SPACING_UNIT)
        
        self.logic_max_signals = QSpinBox()
        self.logic_max_signals.setStyleSheet(INPUT_STYLE)
        self.logic_max_signals.setRange(1, 10)
        logic_form.addRow("Maximum Signals:", self.logic_max_signals)
        
        self.logic_min_trades = QSpinBox()
        self.logic_min_trades.setStyleSheet(INPUT_STYLE)
        self.logic_min_trades.setRange(10, 100)
        logic_form.addRow("Minimum Trades:", self.logic_min_trades)
        
        logic_group.setLayout(logic_form)
        layout.addWidget(logic_group)
        
        # Add more groups for other signal logic settings...
        
        # Wrap in scroll area
        scroll = QScrollArea()
        scroll.setWidget(tab)
        scroll.setWidgetResizable(True)
        tab.setLayout(layout)
        
        return scroll
    
    def create_market_config_tab(self) -> QWidget:
        """Create market conditions configuration tab"""
        tab = QWidget()
        layout = QVBoxLayout()
        layout.setSpacing(SPACING_UNIT)
        
        # Session group
        session_group = QGroupBox("Session Configuration")
        session_group.setStyleSheet(GROUPBOX_STYLE)
        session_group.setFont(create_font(bold=True))
        
        session_form = QFormLayout()
        session_form.setSpacing(SPACING_UNIT)
        
        self.session_asia_start = QSpinBox()
        self.session_asia_start.setStyleSheet(INPUT_STYLE)
        self.session_asia_start.setRange(0, 23)
        session_form.addRow("Asia Session Start (UTC):", self.session_asia_start)
        
        self.session_asia_end = QSpinBox()
        self.session_asia_end.setStyleSheet(INPUT_STYLE)
        self.session_asia_end.setRange(0, 23)
        session_form.addRow("Asia Session End (UTC):", self.session_asia_end)
        
        session_group.setLayout(session_form)
        layout.addWidget(session_group)
        
        # Add more groups for other market condition settings...
        
        # Wrap in scroll area
        scroll = QScrollArea()
        scroll.setWidget(tab)
        scroll.setWidgetResizable(True)
        tab.setLayout(layout)
        
        return scroll
    
    def create_system_config_tab(self) -> QWidget:
        """Create system integration configuration tab"""
        tab = QWidget()
        layout = QVBoxLayout()
        layout.setSpacing(SPACING_UNIT)
        
        # System group
        system_group = QGroupBox("System Configuration")
        system_group.setStyleSheet(GROUPBOX_STYLE)
        system_group.setFont(create_font(bold=True))
        
        system_form = QFormLayout()
        system_form.setSpacing(SPACING_UNIT)
        
        self.system_max_threads = QSpinBox()
        self.system_max_threads.setStyleSheet(INPUT_STYLE)
        self.system_max_threads.setRange(1, 32)
        system_form.addRow("Maximum Threads:", self.system_max_threads)
        
        self.system_timeout = QSpinBox()
        self.system_timeout.setStyleSheet(INPUT_STYLE)
        self.system_timeout.setRange(60, 7200)
        system_form.addRow("System Timeout (seconds):", self.system_timeout)
        
        system_group.setLayout(system_form)
        layout.addWidget(system_group)
        
        # Add more groups for other system integration settings...
        
        # Wrap in scroll area
        scroll = QScrollArea()
        scroll.setWidget(tab)
        scroll.setWidgetResizable(True)
        tab.setLayout(layout)
        
        return scroll
    
    def create_security_config_tab(self) -> QWidget:
        """Create security configuration tab"""
        tab = QWidget()
        layout = QVBoxLayout()
        layout.setSpacing(SPACING_UNIT)
        
        # Security group
        security_group = QGroupBox("Security Configuration")
        security_group.setStyleSheet(GROUPBOX_STYLE)
        security_group.setFont(create_font(bold=True))
        
        security_form = QFormLayout()
        security_form.setSpacing(SPACING_UNIT)
        
        self.security_scan_enabled = QCheckBox()
        self.security_scan_enabled.setStyleSheet(INPUT_STYLE)
        security_form.addRow("Enable Security Scanning:", self.security_scan_enabled)
        
        self.security_min_score = QSpinBox()
        self.security_min_score.setStyleSheet(INPUT_STYLE)
        self.security_min_score.setRange(0, 100)
        security_form.addRow("Minimum Security Score:", self.security_min_score)
        
        security_group.setLayout(security_form)
        layout.addWidget(security_group)
        
        # Add more groups for other security settings...
        
        # Wrap in scroll area
        scroll = QScrollArea()
        scroll.setWidget(tab)
        scroll.setWidgetResizable(True)
        tab.setLayout(layout)
        
        return scroll
    
    def create_monitoring_config_tab(self) -> QWidget:
        """Create monitoring configuration tab"""
        tab = QWidget()
        layout = QVBoxLayout()
        layout.setSpacing(SPACING_UNIT)
        
        # Monitoring group
        monitor_group = QGroupBox("Monitoring Configuration")
        monitor_group.setStyleSheet(GROUPBOX_STYLE)
        monitor_group.setFont(create_font(bold=True))
        
        monitor_form = QFormLayout()
        monitor_form.setSpacing(SPACING_UNIT)
        
        self.monitor_enabled = QCheckBox()
        self.monitor_enabled.setStyleSheet(INPUT_STYLE)
        monitor_form.addRow("Enable Monitoring:", self.monitor_enabled)
        
        self.monitor_interval = QSpinBox()
        self.monitor_interval.setStyleSheet(INPUT_STYLE)
        self.monitor_interval.setRange(10, 300)
        monitor_form.addRow("Check Interval (seconds):", self.monitor_interval)
        
        monitor_group.setLayout(monitor_form)
        layout.addWidget(monitor_group)
        
        # Add more groups for other monitoring settings...
        
        # Wrap in scroll area
        scroll = QScrollArea()
        scroll.setWidget(tab)
        scroll.setWidgetResizable(True)
        tab.setLayout(layout)
        
        return scroll
    
    def load_current_config(self):
        """Load current configuration from .env file"""
        load_dotenv()
        
        # Block optimization
        self.block_max_combinations.setValue(int(os.getenv('BLOCK_MAX_COMBINATIONS', '100')))
        self.block_min_impact.setValue(float(os.getenv('BLOCK_MIN_IMPACT', '0.01')))
        self.perf_min_improvement.setValue(float(os.getenv('PERF_MIN_IMPROVEMENT', '0.05')))
        self.perf_min_win_rate.setValue(float(os.getenv('PERF_MIN_WIN_RATE', '0.55')))
        
        # Signal logic
        self.logic_max_signals.setValue(int(os.getenv('LOGIC_MAX_SIGNALS', '5')))
        self.logic_min_trades.setValue(int(os.getenv('LOGIC_MIN_TRADES', '30')))
        
        # Market conditions
        self.session_asia_start.setValue(int(os.getenv('SESSION_ASIA_START', '0')))
        self.session_asia_end.setValue(int(os.getenv('SESSION_ASIA_END', '8')))
        
        # System integration
        self.system_max_threads.setValue(int(os.getenv('SYSTEM_MAX_THREADS', '8')))
        self.system_timeout.setValue(int(os.getenv('SYSTEM_TIMEOUT', '7200')))
        
        # Security
        self.security_scan_enabled.setChecked(os.getenv('SECURITY_SCAN_ENABLED', 'true').lower() == 'true')
        self.security_min_score.setValue(int(os.getenv('SECURITY_MIN_SCORE', '90')))
        
        # Monitoring
        self.monitor_enabled.setChecked(os.getenv('MONITOR_ENABLED', 'true').lower() == 'true')
        self.monitor_interval.setValue(int(os.getenv('MONITOR_INTERVAL', '60')))
    
    def save_configuration(self):
        """Save configuration to .env file"""
        # Block optimization
        set_key('.env', 'BLOCK_MAX_COMBINATIONS', str(self.block_max_combinations.value()))
        set_key('.env', 'BLOCK_MIN_IMPACT', str(self.block_min_impact.value()))
        set_key('.env', 'PERF_MIN_IMPROVEMENT', str(self.perf_min_improvement.value()))
        set_key('.env', 'PERF_MIN_WIN_RATE', str(self.perf_min_win_rate.value()))
        
        # Signal logic
        set_key('.env', 'LOGIC_MAX_SIGNALS', str(self.logic_max_signals.value()))
        set_key('.env', 'LOGIC_MIN_TRADES', str(self.logic_min_trades.value()))
        
        # Market conditions
        set_key('.env', 'SESSION_ASIA_START', str(self.session_asia_start.value()))
        set_key('.env', 'SESSION_ASIA_END', str(self.session_asia_end.value()))
        
        # System integration
        set_key('.env', 'SYSTEM_MAX_THREADS', str(self.system_max_threads.value()))
        set_key('.env', 'SYSTEM_TIMEOUT', str(self.system_timeout.value()))
        
        # Security
        set_key('.env', 'SECURITY_SCAN_ENABLED', str(self.security_scan_enabled.isChecked()).lower())
        set_key('.env', 'SECURITY_MIN_SCORE', str(self.security_min_score.value()))
        
        # Monitoring
        set_key('.env', 'MONITOR_ENABLED', str(self.monitor_enabled.isChecked()).lower())
        set_key('.env', 'MONITOR_INTERVAL', str(self.monitor_interval.value()))
    def showEvent(self, event):
        """Called when window is shown - restore geometry and apply hand cursors."""
        super().showEvent(event)
        self._restore_window_geometry(event)
        from PyQt5.QtCore import QTimer
        from .styles import apply_hand_cursor_to_buttons
        QTimer.singleShot(200, lambda: apply_hand_cursor_to_buttons(self))

    def closeEvent(self, event):
        """Save window geometry on close."""
        self._save_window_geometry()
        super().closeEvent(event)

    
    def reset_to_defaults(self):
        """Reset configuration to default values"""
        # Block optimization
        self.block_max_combinations.setValue(100)
        self.block_min_impact.setValue(0.01)
        self.perf_min_improvement.setValue(0.05)
        self.perf_min_win_rate.setValue(0.55)
        
        # Signal logic
        self.logic_max_signals.setValue(5)
        self.logic_min_trades.setValue(30)
        
        # Market conditions
        self.session_asia_start.setValue(0)
        self.session_asia_end.setValue(8)
        
        # System integration
        self.system_max_threads.setValue(8)
        self.system_timeout.setValue(7200)
        
        # Security
        self.security_scan_enabled.setChecked(True)
        self.security_min_score.setValue(90)
        
        # Monitoring
        self.monitor_enabled.setChecked(True)
        self.monitor_interval.setValue(60)
