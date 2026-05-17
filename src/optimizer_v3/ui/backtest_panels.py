"""
Optimizer V3 - Backtest Progress & Results Panels
Provides real-time backtest monitoring with TP/SL configuration handling.
"""

from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QFormLayout, QGroupBox,
    QProgressBar, QTableWidget, QTableWidgetItem, QLabel,
    QDoubleSpinBox, QSpinBox, QCheckBox, QLineEdit, QComboBox, QFrame
)
from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtGui import QColor
from PyQt6.QtCharts import QChart, QChartView, QLineSeries
from decimal import Decimal
from typing import List, Union, Dict
import multiprocessing as mp
import psutil

from nautilus_trader.model.objects import Price, Quantity, Money
from nautilus_trader.model.currencies import USD

# Import all styles from centralized stylesheet
from src.strategy_builder.ui.styles import (
    MAIN_STYLESHEET,
    COLORS,
    get_main_stylesheet,
    get_label_style,
    get_primary_button_stylesheet,
    get_spinbox_button_stylesheet
)

# Define additional styles needed for optimizer UI
WINDOW_STYLE = get_main_stylesheet()
PANEL_STYLE = f"background-color: {COLORS['bg_medium']}; border-radius: 8px; padding: 10px;"
TABLE_STYLE = f"""
    QTableWidget {{
        background-color: {COLORS['bg_light']};
        border: 1px solid {COLORS['border']};
        color: {COLORS['text_primary']};
        gridline-color: {COLORS['border']};
    }}
    QTableWidget::item {{
        padding: 8px;
    }}
    QHeaderView::section {{
        background-color: {COLORS['bg_medium']};
        color: {COLORS['text_primary']};
        font-weight: bold;
        padding: 8px;
        border: 1px solid {COLORS['border']};
    }}
"""
PROGRESSBAR_STYLE = f"""
    QProgressBar {{
        background-color: {COLORS['bg_light']};
        border: 1px solid {COLORS['border']};
        border-radius: 6px;
        text-align: center;
        color: {COLORS['text_primary']};
        font-weight: bold;
    }}
    QProgressBar::chunk {{
        background-color: {COLORS['info']};
        border-radius: 5px;
    }}
"""
GROUPBOX_STYLE = f"""
    QGroupBox {{
        background-color: {COLORS['bg_medium']};
        border: 1px solid {COLORS['border']};
        border-radius: 8px;
        margin-top: 20px;
        padding-top: 35px;
        color: {COLORS['text_primary']};
        font-weight: bold;
    }}
    QGroupBox::title {{
        subcontrol-origin: margin;
        left: 12px;
        padding: 0 5px;
        color: {COLORS['info']};
        font-size: 12pt;
        font-weight: bold;
    }}
"""
INPUT_STYLE = f"""
    QLineEdit, QSpinBox, QDoubleSpinBox {{
        background-color: {COLORS['bg_input']};
        border: 1px solid {COLORS['border']};
        border-radius: 6px;
        padding: 8px;
        color: {COLORS['text_primary']};
    }}
    QLineEdit:focus, QSpinBox:focus, QDoubleSpinBox:focus {{
        border-color: {COLORS['border_focus']};
    }}
"""
INPUT_ERROR_STYLE = f"""
    QLineEdit {{
        background-color: {COLORS['bg_input']};
        border: 2px solid {COLORS['error']};
        border-radius: 6px;
        padding: 8px;
        color: {COLORS['text_primary']};
    }}
"""
COMBOBOX_STYLE = f"""
    QComboBox {{
        background-color: {COLORS['bg_input']};
        border: 1px solid {COLORS['border']};
        border-radius: 6px;
        padding: 6px 10px;
        color: {COLORS['text_primary']};
    }}
    QComboBox:hover {{
        border-color: {COLORS['border_focus']};
    }}
    QComboBox QAbstractItemView {{
        background-color: {COLORS['bg_input']};
        selection-background-color: {COLORS['info']};
        color: {COLORS['text_primary']};
    }}
"""
CHECKBOX_STYLE = f"""
    QCheckBox {{
        color: {COLORS['text_primary']};
        background: transparent;
    }}
    QCheckBox::indicator {{
        width: 18px;
        height: 18px;
        border-radius: 3px;
        border: 2px solid {COLORS['border']};
        background-color: {COLORS['bg_input']};
    }}
    QCheckBox::indicator:checked {{
        background-color: {COLORS['info']};
        border: 2px solid {COLORS['info']};
    }}
"""
LABEL_STYLE = get_label_style('default')
CHART_STYLE = f"background-color: {COLORS['bg_medium']}; border: 1px solid {COLORS['border']};"
SPACING_UNIT = 8
PRIMARY_COLOR = COLORS['info']
SECONDARY_COLOR = COLORS['border']


def create_font(size: int = 10, bold: bool = False):
    """
    Helper function to create standardized fonts.
    
    Args:
        size: Font size in points
        bold: Whether font should be bold
    
    Returns:
        QFont object (not used in this minimal implementation)
    """
    # Return None as PyQt6 handles fonts via stylesheet
    return None


class FibonacciTPStrategy:
    """Fibonacci-based take profit strategy"""
    
    def __init__(self, levels: List[float], adjustment_threshold: float):
        self.levels = [Decimal(str(level)) for level in levels]
        self.adjustment_threshold = Decimal(str(adjustment_threshold))
    
    def calculate_levels(self, entry_price: Price, position_size: Quantity) -> dict:
        """Calculate TP levels using Fibonacci ratios"""
        return {
            'tp1': Price(str(entry_price.as_decimal() * self.levels[0]), precision=2),
            'tp2': Price(str(entry_price.as_decimal() * self.levels[1]), precision=2),
            'tp3': Price(str(entry_price.as_decimal() * self.levels[2]), precision=2)
        }
    
    def adjust_levels(self, current_price: Price, market_data: dict) -> dict:
        """Adjust TP levels based on market conditions"""
        volatility = Decimal(str(market_data.get('volatility', 0)))
        if volatility > self.adjustment_threshold:
            return {
                'tp1': volatility * Decimal('0.5'),
                'tp2': volatility * Decimal('0.75'),
                'tp3': volatility
            }
        return {'tp1': Decimal('0'), 'tp2': Decimal('0'), 'tp3': Decimal('0')}


class HybridTPStrategy:
    """Hybrid take profit strategy combining multiple approaches"""
    
    def __init__(self, atr_multiplier: float = 2.0, min_distance: float = 0.005):
        self.atr_multiplier = Decimal(str(atr_multiplier))
        self.min_distance = Decimal(str(min_distance))
    
    def calculate_levels(self, entry_price: Price, position_size: Quantity) -> dict:
        """Calculate TP levels using hybrid approach"""
        base = entry_price.as_decimal()
        return {
            'tp1': Price(str(base * (Decimal('1') + self.min_distance * Decimal('2'))), precision=2),
            'tp2': Price(str(base * (Decimal('1') + self.min_distance * Decimal('3'))), precision=2),
            'tp3': Price(str(base * (Decimal('1') + self.min_distance * Decimal('4'))), precision=2)
        }
    
    def adjust_levels(self, current_price: Price, market_data: dict) -> dict:
        """Adjust TP levels based on ATR and market conditions"""
        atr = Decimal(str(market_data.get('atr', 0)))
        return {
            'tp1': atr * self.atr_multiplier * Decimal('0.5'),
            'tp2': atr * self.atr_multiplier * Decimal('0.75'),
            'tp3': atr * self.atr_multiplier
        }


class FixedTPStrategy:
    """Fixed take profit strategy with static levels"""
    
    def __init__(self, tp1_distance: float, tp2_distance: float, tp3_distance: float):
        self.distances = {
            'tp1': Decimal(str(tp1_distance)),
            'tp2': Decimal(str(tp2_distance)),
            'tp3': Decimal(str(tp3_distance))
        }
    
    def calculate_levels(self, entry_price: Price, position_size: Quantity) -> dict:
        """Calculate TP levels using fixed distances"""
        base = entry_price.as_decimal()
        return {
            'tp1': Price(str(base * (Decimal('1') + self.distances['tp1'])), precision=2),
            'tp2': Price(str(base * (Decimal('1') + self.distances['tp2'])), precision=2),
            'tp3': Price(str(base * (Decimal('1') + self.distances['tp3'])), precision=2)
        }
    
    def adjust_levels(self, current_price: Price, market_data: dict) -> dict:
        """Fixed strategy has no adjustments"""
        return {'tp1': Decimal('0'), 'tp2': Decimal('0'), 'tp3': Decimal('0')}


class AdaptiveSLStrategyV2:
    """Adaptive stop loss strategy v2.0 with dynamic adjustments"""
    
    def __init__(self, atr_period: int = 14, atr_multiplier: float = 2.0, min_distance: float = 0.005):
        self.atr_period = atr_period
        self.atr_multiplier = Decimal(str(atr_multiplier))
        self.min_distance = Decimal(str(min_distance))
    
    def calculate_level(self, entry_price: Price, position_size: Quantity) -> Price:
        """Calculate initial SL level"""
        return Price(str(entry_price.as_decimal() * (Decimal('1') - self.min_distance)), precision=2)
    
    def adjust_level(self, current_price: Price, market_data: dict) -> Price:
        """Adjust SL level based on ATR and market conditions"""
        atr = Decimal(str(market_data.get('atr', 0)))
        volatility = Decimal(str(market_data.get('volatility', 0)))
        
        # Dynamic adjustment based on both ATR and volatility
        adjustment = (atr * self.atr_multiplier + volatility) / Decimal('2')
        return Price(str(current_price.as_decimal() * (Decimal('1') - adjustment)), precision=2)


class StaticSLStrategy:
    """Static stop loss strategy with fixed distance"""
    
    def __init__(self, distance: float):
        self.distance = Decimal(str(distance))
    
    def calculate_level(self, entry_price: Price, position_size: Quantity) -> Price:
        """Calculate SL level using fixed distance"""
        return Price(str(entry_price.as_decimal() * (Decimal('1') - self.distance)), precision=2)
    
    def adjust_level(self, current_price: Price, market_data: dict) -> Price:
        """Static strategy has no adjustments"""
        return current_price


class TPSLConfigurationHandler:
    """Handle TP/SL configuration strategies"""
    
    def __init__(self):
        self.tp_strategy = None
        self.sl_strategy = None
        
    def configure_tp_strategy(self, strategy_type: str, params: dict):
        """Configure take profit strategy"""
        if strategy_type == 'fibonacci':
            self.tp_strategy = FibonacciTPStrategy(**params)
        elif strategy_type == 'hybrid':
            self.tp_strategy = HybridTPStrategy(**params)
        elif strategy_type == 'fixed':
            self.tp_strategy = FixedTPStrategy(**params)
        else:
            raise ValueError(f"Invalid TP strategy type: {strategy_type}")
    
    def configure_sl_strategy(self, strategy_type: str, params: dict):
        """Configure stop loss strategy"""
        if strategy_type == 'adaptive_v2':
            self.sl_strategy = AdaptiveSLStrategyV2(**params)
        elif strategy_type == 'static':
            self.sl_strategy = StaticSLStrategy(**params)
        else:
            raise ValueError(f"Invalid SL strategy type: {strategy_type}")
    
    def calculate_tp_levels(self, entry_price: Price, position_size: Quantity) -> dict:
        """Calculate take profit levels using configured strategy"""
        if not self.tp_strategy:
            raise RuntimeError("TP strategy not configured")
        return self.tp_strategy.calculate_levels(entry_price, position_size)
    
    def calculate_sl_level(self, entry_price: Price, position_size: Quantity) -> Price:
        """Calculate stop loss level using configured strategy"""
        if not self.sl_strategy:
            raise RuntimeError("SL strategy not configured")
        return self.sl_strategy.calculate_level(entry_price, position_size)
    
    def adjust_tp_levels(self, current_price: Price, market_data: dict) -> dict:
        """Adjust take profit levels based on market conditions"""
        if not self.tp_strategy:
            raise RuntimeError("TP strategy not configured")
        return self.tp_strategy.adjust_levels(current_price, market_data)
    
    def adjust_sl_level(self, current_price: Price, market_data: dict) -> Price:
        """Adjust stop loss level based on market conditions"""
        if not self.sl_strategy:
            raise RuntimeError("SL strategy not configured")
        return self.sl_strategy.adjust_level(current_price, market_data)


class BacktestConfigurationPanel(QWidget):
    """Backtest configuration panel with complete parameter handling"""
    
    def __init__(self):
        super().__init__()
        # Initialize with default values
        self.starting_capital = Money('1000', USD)
        self.capital_range = (
            Money('500', USD),
            Money('5000000', USD)
        )
        self.capital_step = {
            'micro': Money('100', USD),
            'small': Money('500', USD),
            'medium': Money('1000', USD),
            'large': Money('5000', USD)
        }
        self.risk_params = {
            'min_risk_reward': Decimal('2.0'),
            'risk_percent': Decimal('1.0'),
            'leverage': Decimal('1.0'),
            'confluence_required': 2,
            'max_bars_held': 20
        }
        self.stop_loss_params = {
            'delay_bars': 3,
            'emergency_enabled': True,
            'emergency_threshold': Decimal('3.0'),
            'volatility_lookback': 14,
            'volatility_multiplier': Decimal('2.0'),
            'min_distance': Decimal('0.005'),
            'max_distance': Decimal('0.02')
        }
        self.optimizer_enabled = False
        self.setup_ui()
    
    def get_config_for_mode(self, is_optimizer_mode: bool = False) -> dict:
        """Get configuration based on mode"""
        config = {
            'capital': {
                'amount': self.starting_capital,
                'currency': 'USD'
            },
            'risk': self.risk_params.copy(),
            'stop_loss': self.stop_loss_params.copy()
        }
        
        if is_optimizer_mode:
            config['optimization_ranges'] = {
                'capital': {
                    'min': self.capital_range[0],
                    'max': self.capital_range[1],
                    'steps': self.capital_step.copy()
                },
                'risk_reward': (Decimal('1.5'), Decimal('3.0')),
                'risk_percent': (Decimal('0.5'), Decimal('2.0')),
                'confluence': (1, 3),
                'bars_held': (10, 30),
                'volatility_multiplier': (Decimal('1.5'), Decimal('2.5')),
                'stop_loss_distance': (Decimal('0.003'), Decimal('0.025'))
            }
        
        return config
    
    def set_starting_capital(self, amount: str):
        """Set starting capital amount"""
        try:
            self.starting_capital = Money(amount, USD)
        except ValueError as e:
            raise ValueError(f"Invalid starting capital: {str(e)}")
    
    def get_starting_capital(self) -> Money:
        """Get current starting capital"""
        return self.starting_capital
    
    def setup_ui(self):
        """Set up the UI components"""
        layout = QVBoxLayout()
        layout.setSpacing(SPACING_UNIT)
        
        # Risk/Reward Configuration
        risk_reward_group = QGroupBox("Risk/Reward Configuration")
        risk_reward_group.setStyleSheet(GROUPBOX_STYLE)
        risk_reward_layout = QFormLayout()
        risk_reward_layout.setSpacing(SPACING_UNIT)
        
        # Add risk parameter inputs
        self.min_rr_input = QDoubleSpinBox()
        self.min_rr_input.setStyleSheet(INPUT_STYLE)
        self.min_rr_input.setRange(1.0, 5.0)
        self.min_rr_input.setValue(float(self.risk_params['min_risk_reward']))
        risk_reward_layout.addRow("Min Risk/Reward:", self.min_rr_input)
        
        self.risk_percent_input = QDoubleSpinBox()
        self.risk_percent_input.setStyleSheet(INPUT_STYLE)
        self.risk_percent_input.setRange(0.1, 5.0)
        self.risk_percent_input.setValue(float(self.risk_params['risk_percent']))
        risk_reward_layout.addRow("Risk %:", self.risk_percent_input)
        
        risk_reward_group.setLayout(risk_reward_layout)
        layout.addWidget(risk_reward_group)
        
        # Starting Capital
        capital_group = QGroupBox("Starting Capital")
        capital_group.setStyleSheet(GROUPBOX_STYLE)
        capital_layout = QFormLayout()
        capital_layout.setSpacing(SPACING_UNIT)
        
        self.capital_input = QLineEdit()
        self.capital_input.setStyleSheet(INPUT_STYLE)
        self.capital_input.setText(str(self.starting_capital.as_decimal()))
        capital_layout.addRow("Amount (USD):", self.capital_input)
        
        capital_group.setLayout(capital_layout)
        layout.addWidget(capital_group)
        
        self.setLayout(layout)
    
    def set_optimizer_mode(self, enabled: bool):
        """Enable/disable optimizer mode"""
        self.optimizer_enabled = enabled
        self.capital_input.setEnabled(not enabled)


class BacktestProgressPanel(QWidget):
    """Real-time backtest progress tracking with TP/SL configuration handling"""
    
    TP_CONFIG_TYPES = {
        'FIBONACCI': 'fibonacci',
        'HYBRID': 'hybrid',
        'FIXED': 'fixed'
    }
    
    SL_CONFIG_TYPES = {
        'ADAPTIVE_V2': 'adaptive_v2',
        'STATIC': 'static'
    }
    
    def __init__(self, config_panel: BacktestConfigurationPanel):
        super().__init__()
        self.tp_config = self.TP_CONFIG_TYPES['FIBONACCI']
        self.sl_config = self.SL_CONFIG_TYPES['ADAPTIVE_V2']
        self.config_handler = TPSLConfigurationHandler()
        self.config_panel = config_panel
        self.setup_ui()
        
        # Configure default strategies
        self.config_handler.configure_tp_strategy('fibonacci', {
            'levels': [1.618, 2.618, 3.618],
            'adjustment_threshold': 0.01
        })
        self.config_handler.configure_sl_strategy('adaptive_v2', {
            'atr_period': 14,
            'atr_multiplier': 2.0,
            'min_distance': 0.005
        })
    
    def set_tp_config(self, config_type: str):
        """Set take profit configuration type"""
        if config_type not in self.TP_CONFIG_TYPES.values():
            raise ValueError(f"Invalid TP config type: {config_type}")
        self.tp_config = config_type
    
    def set_sl_config(self, config_type: str):
        """Set stop loss configuration type"""
        if config_type not in self.SL_CONFIG_TYPES.values():
            raise ValueError(f"Invalid SL config type: {config_type}")
        self.sl_config = config_type
    
    def setup_ui(self):
        """Set up the UI components"""
        layout = QVBoxLayout()
        layout.setSpacing(SPACING_UNIT)
        
        # Progress bar
        self.progress_bar = QProgressBar()
        self.progress_bar.setStyleSheet(PROGRESSBAR_STYLE)
        layout.addWidget(self.progress_bar)
        
        # Results table
        self.results_table = QTableWidget()
        self.results_table.setStyleSheet(TABLE_STYLE)
        self.results_table.setColumnCount(4)
        self.results_table.setHorizontalHeaderLabels([
            'Metric', 'Current', 'Best', 'Change'
        ])
        
        metrics = [
            'Candles Processed',
            'Trades Executed',
            'Current TP1',
            'Current TP2',
            'Current TP3',
            'Current SL',
            'Win Rate',
            'Profit Factor',
            'Exit Triggers',  # Sprint 1.8 Task 1.8.76
            'Exit P&L',       # Sprint 1.8 Task 1.8.76
            'Partial Exits'   # Sprint 1.8 Task 1.8.76
        ]
        self.results_table.setRowCount(len(metrics))
        for i, metric in enumerate(metrics):
            self.results_table.setItem(i, 0, QTableWidgetItem(metric))
        
        layout.addWidget(self.results_table)
        self.setLayout(layout)
    
    def update_progress(self, current: int, total: int):
        """Update progress bar"""
        self.progress_bar.setMaximum(total)
        self.progress_bar.setValue(current)
    
    def update_results(self, results: dict):
        """Update results panel with latest metrics"""
        self._update_metric(0, str(results.get('candles_processed', 0)))
        self._update_metric(1, str(results.get('trades_executed', 0)))
        self._update_metric(2, f"{results.get('current_tp1', 0.0):.2f}")
        self._update_metric(3, f"{results.get('current_tp2', 0.0):.2f}")
        self._update_metric(4, f"{results.get('current_tp3', 0.0):.2f}")
        self._update_metric(5, f"{results.get('current_sl', 0.0):.2f}")
        self._update_metric(6, f"{results.get('win_rate', 0.0):.2%}")
        self._update_metric(7, f"{results.get('profit_factor', 0.0):.2f}")
        # Sprint 1.8 Task 1.8.76: Exit condition metrics
        self._update_metric(8, str(results.get('exit_condition_triggers', 0)))
        self._update_metric(9, f"${results.get('exit_condition_pnl', 0.0):,.2f}")
        self._update_metric(10, str(results.get('partial_exit_count', 0)))
    
    def _update_metric(self, row: int, value: str, column: int = 1):
        """Update a specific metric in the results table"""
        item = QTableWidgetItem(value)
        item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
        self.results_table.setItem(row, column, item)
