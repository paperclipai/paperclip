"""
Metrics Display Panel - Comprehensive Performance Analysis

Institutional-grade performance metrics and analysis:
- Performance metrics table (Sharpe, Win Rate, Profit Factor, etc.)
- Risk metrics (VaR, Max Drawdown, Sortino, etc.)
- Parameter comparison (user vs optimized)
- Statistical significance indicators
- Proper NautilusTrader type formatting
- Export capabilities

ZERO HARDCODED STYLES - All from styles.py

Author: Optimizer v3 Team
Date: 2026-01-20
Sprint: 1.4 (UI Integration - Task 1.4.6)
"""

from typing import Dict, Optional, List
from decimal import Decimal
from datetime import datetime
from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QGroupBox, QTableWidget, QTableWidgetItem, QHeaderView,
    QAbstractItemView, QScrollArea, QTabWidget, QCheckBox,
    QDialog, QProgressDialog
)
from PyQt5.QtCore import Qt, pyqtSignal, QThread
from PyQt5.QtGui import QColor
from PyQt5.QtWidgets import QApplication

# Import centralized styles - ZERO hardcoded styles
from src.strategy_builder.ui.styles import (
    get_groupbox_header_stylesheet,
    get_label_style,
    get_panel_title_stylesheet,
    get_primary_button_stylesheet,
    get_tab_widget_stylesheet,
    get_table_stylesheet,
    get_color
)

# Import NEW intelligent recommendation engine (Sprint 1.6 - with AI & status messages)
from src.optimizer_v3.core.intelligent_recommendation_engine import (
    IntelligentRecommendationEngine,
    IntegratedRecommendation
)
from src.detectors.building_blocks.registry import BlockRegistry

# Import recommendation worker (Sprint 1.6 - background AI generation)
from src.optimizer_v3.ui.recommendation_worker import RecommendationWorker

# Import AI request preview window (Sprint 1.6 - preview before sending)
from src.optimizer_v3.core.ai_request_preview_window import AIRequestPreviewWindow
from src.optimizer_v3.core.comprehensive_ai_request_builder import ComprehensiveAIRequestBuilder

import logging
logger = logging.getLogger(__name__)

class MetricsDisplayPanel(QWidget):
    """
    Comprehensive Metrics Display Panel
    
    Features:
    - Performance metrics with proper type formatting
    - Risk metrics analysis
    - Parameter comparison view
    - Statistical significance testing
    - Export capabilities
    - Dark theme compatible
    """
    
    # Signals
    metrics_updated = pyqtSignal(dict)
    recommendations_generated = pyqtSignal(list)  # Emits List[Dict] for AI Recommendations Panel
    
    def __init__(self, parent=None):
        super().__init__(parent)
        self.current_metrics: Dict = {}
        self.baseline_metrics: Dict = {}
        self.full_backtest_results: Optional[Dict] = None  # FIXED: Store full results with trade list
        
        # NEW Intelligent recommendation engine (Sprint 1.6 - with AI & status messages)
        self.rec_engine: Optional[IntelligentRecommendationEngine] = None
        self.recommendation_cache: Dict[str, Optional[IntegratedRecommendation]] = {}  # Cache recommendation objects
        self.batch_recommendations: List[IntegratedRecommendation] = []  # Batch AI recommendations
        
        self._init_ui()
    
    def _init_ui(self) -> None:
        """Initialize the user interface"""
        layout = QVBoxLayout()
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(15)
        
        # Title
        title_label = QLabel("📊 Performance Metrics")
        title_label.setStyleSheet(get_panel_title_stylesheet())
        layout.addWidget(title_label)
        
        # STACKED LAYOUT (Design v2): Performance on top, Risk below - FULL WIDTH TABLES
        
        # Performance Metrics (top, full width)
        perf_group = self._create_performance_group()
        layout.addWidget(perf_group)
        
        # Risk Metrics (bottom, full width)
        risk_group = self._create_risk_group()
        layout.addWidget(risk_group)
        
        # Control buttons at bottom
        control_bar = self._create_control_bar()
        layout.addLayout(control_bar)
        
        self.setLayout(layout)
    
    def _create_performance_group(self) -> QGroupBox:
        """Create performance metrics group - Design v2 with checkboxes"""
        # Performance metrics table
        perf_group = QGroupBox("📊 Performance Metrics")
        perf_group.setStyleSheet(get_groupbox_header_stylesheet())
        
        perf_layout = QVBoxLayout()
        perf_layout.setContentsMargins(10, 15, 10, 10)
        
        # Create metrics table with Recommendations + CHECKBOX column (Design v2)
        # Checkbox is ON THE RIGHT (after recommendation)
        self.perf_table = QTableWidget()
        self.perf_table.setColumnCount(5)  # Added checkbox column at END
        self.perf_table.setHorizontalHeaderLabels(['Metric', 'Value', 'Rating', 'Recommendation', ''])  # No checkbox in header
        
        # Table styling
        # Use centralized table stylesheet (ZERO hardcoded styles)
        self.perf_table.setStyleSheet(get_table_stylesheet())
        
        self.perf_table.setAlternatingRowColors(True)
        self.perf_table.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)  # FIXED: Multi-row selection (Ctrl+Click, Shift+Click)
        self.perf_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.perf_table.setSortingEnabled(False)  # Disable sorting (checkboxes break it)
        
        # Column widths: Metric | Value | Rating | Recommendation | Checkbox
        # READABLE widths - we have FULL WIDTH now (stacked layout)
        self.perf_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Fixed)  # Metric
        self.perf_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Fixed)  # Value
        self.perf_table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeMode.Fixed)  # Rating
        self.perf_table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeMode.Stretch)  # Recommendation (takes remaining space)
        self.perf_table.horizontalHeader().setSectionResizeMode(4, QHeaderView.ResizeMode.Fixed)  # Checkbox
        
        self.perf_table.setColumnWidth(0, 350)  # Metric name (VERY WIDE per user request)
        self.perf_table.setColumnWidth(1, 350)  # Value column (VERY WIDE per user request)
        self.perf_table.setColumnWidth(2, 350)  # Rating column (VERY WIDE per user request)
        # Column 3 (Recommendation) stretches to fill remaining width
        self.perf_table.setColumnWidth(4, 50)   # Checkbox column
        self.perf_table.verticalHeader().setVisible(False)
        
        # CRITICAL: Enable word wrap and auto-resize rows for multiline recommendations
        self.perf_table.setWordWrap(True)
        self.perf_table.verticalHeader().setSectionResizeMode(QHeaderView.ResizeMode.ResizeToContents)
        
        # Populate with metric rows with institutional-grade tooltips
        metrics = [
            ('Total P&L', '$0.00', '-', 
             'Total Profit & Loss\n\n'
             'Sum of all realized trade profits and losses.\n\n'
             'Calculation:\n'
             'Total P&L = Σ(Trade PnL)\n\n'
             'Interpretation:\n'
             '• Positive: Strategy is profitable overall\n'
             '• Negative: Strategy is losing money\n'
             '• Zero: Break-even performance\n\n'
             'Institutional Benchmark:\n'
             '✓ Good: Positive and growing\n'
             '⚠ Fair: Small positive or near break-even\n'
             '✗ Poor: Negative'),
            
            ('Total Return %', '0.00%', '-',
             'Total Return Percentage\n\n'
             'Percentage return on starting capital.\n\n'
             'Calculation:\n'
             'Return % = (Total P&L / Starting Capital) × 100\n\n'
             'Example:\n'
             '$10,000 capital → $500 profit = 5% return\n\n'
             'Interpretation:\n'
             '• Higher is better\n'
             '• Compare to buy-and-hold returns\n'
             '• Annualize for multi-period comparison\n\n'
             'Institutional Benchmark (Annual):\n'
             '✓ Good: >15% (outperforms markets)\n'
             '⚠ Fair: 8-15% (matches markets)\n'
             '✗ Poor: <8% (underperforms)'),
            
            ('Sharpe Ratio', '0.0000', '-',
             'Sharpe Ratio (Risk-Adjusted Return)\n\n'
             'Measures return per unit of risk (volatility).\n\n'
             'Calculation:\n'
             'Sharpe = (Avg Return - Risk Free Rate) / Std Dev\n'
             'Simplified: Sharpe = Avg Trade / Std Deviation\n\n'
             'Interpretation:\n'
             '• Higher = Better risk-adjusted returns\n'
             '• Accounts for volatility, not just returns\n'
             '• Industry standard for comparing strategies\n\n'
             'Institutional Benchmark:\n'
             '✓ Good: ≥2.0 (excellent risk-adjusted returns)\n'
             '⚠ Fair: 1.0-2.0 (acceptable)\n'
             '✗ Poor: <1.0 (poor risk management)'),
            
            ('Win Rate', '0.00%', '-',
             'Win Rate (Percentage of Winning Trades)\n\n'
             'Percentage of trades that ended in profit.\n\n'
             'Calculation:\n'
             'Win Rate = (Winning Trades / Total Trades) × 100\n\n'
             'Example:\n'
             '60 wins out of 100 trades = 60% win rate\n\n'
             'Interpretation:\n'
             '• NOT the only important metric\n'
             '• Must consider with Profit Factor\n'
             '• High win rate can still lose money if losses are large\n\n'
             'Institutional Benchmark:\n'
             '✓ Good: ≥60% (highly selective)\n'
             '⚠ Fair: 50-60% (balanced)\n'
             '✗ Poor: <50% (need high R:R to profit)'),
            
            ('Profit Factor', '0.000', '-',
             'Profit Factor (Gross Profit / Gross Loss)\n\n'
             'Ratio of total winning trades to total losing trades.\n\n'
             'Calculation:\n'
             'Profit Factor = Gross Profit / |Gross Loss|\n\n'
             'Example:\n'
             '$10,000 in wins / $5,000 in losses = 2.0\n\n'
             'Interpretation:\n'
             '• >1.0: Profitable strategy\n'
             '• =1.0: Break-even\n'
             '• <1.0: Losing strategy\n\n'
             'Institutional Benchmark:\n'
             '✓ Good: ≥2.0 (wins are 2x losses)\n'
             '⚠ Fair: 1.5-2.0 (acceptable)\n'
             '✗ Poor: <1.5 (marginal profitability)'),
            
            ('Max Drawdown', '$0.00', '-',
             'Maximum Drawdown (Largest Peak-to-Trough Decline)\n\n'
             'Largest drop from equity peak to trough.\n\n'
             'Calculation:\n'
             'Max DD = Peak Equity - Lowest Trough After Peak\n\n'
             'Example:\n'
             'Peak: $12,000 → Trough: $10,000 = $2,000 drawdown\n\n'
             'Interpretation:\n'
             '• Measures worst-case scenario\n'
             '• Critical for position sizing\n'
             '• Expect 2-3x in live trading\n\n'
             'Risk Management:\n'
             '✓ Good: <10% of capital\n'
             '⚠ Monitor: 10-20% of capital\n'
             '✗ High Risk: >20% of capital'),
            
            ('Number of Trades', '0', '-',
             'Total Number of Trades Executed\n\n'
             'Count of all completed trades (entries + exits).\n\n'
             'Statistical Significance:\n'
             '• <30 trades: Not statistically significant\n'
             '• 30-100 trades: Moderate confidence\n'
             '• >100 trades: High statistical confidence\n\n'
             'Interpretation:\n'
             '• More trades = More reliable metrics\n'
             '• Too few trades = Unreliable results\n'
             '• Too many trades = High transaction costs\n\n'
             'Institutional Minimum:\n'
             '• Backtesting: ≥100 trades for confidence\n'
             '• Live validation: ≥30 trades minimum'),
            
            ('Average Trade P&L', '$0.00', '-',
             'Average Profit/Loss Per Trade\n\n'
             'Mean P&L across all trades.\n\n'
             'Calculation:\n'
             'Avg Trade = Total P&L / Number of Trades\n\n'
             'Example:\n'
             '$1,000 profit / 50 trades = $20 per trade\n\n'
             'Interpretation:\n'
             '• Must exceed transaction costs\n'
             '• Higher = More efficient strategy\n'
             '• Consistency matters more than size\n\n'
             'After Costs:\n'
             '• Consider commissions (~$2-5 per trade)\n'
             '• Consider slippage (~0.1-0.5%)\n'
             '• Net avg should be >$10 minimum'),
            
            ('Average Win', '$0.00', '-',
             'Average Winning Trade Size\n\n'
             'Mean profit of all winning trades only.\n\n'
             'Calculation:\n'
             'Avg Win = Gross Profit / Number of Wins\n\n'
             'Use With:\n'
             '• Compare to Average Loss\n'
             '• Calculate realistic R:R ratios\n'
             '• Size positions appropriately\n\n'
             'Interpretation:\n'
             '• Larger wins = Better asymmetry\n'
             '• Should be >2x Average Loss for sustainability\n'
             '• Consistency of win size matters'),
            
            ('Average Loss', '$0.00', '-',
             'Average Losing Trade Size\n\n'
             'Mean loss of all losing trades only.\n\n'
             'Calculation:\n'
             'Avg Loss = |Gross Loss| / Number of Losses\n\n'
             'Risk Management:\n'
             '• Should be consistent (good risk control)\n'
             '• Large variance = Poor stop loss discipline\n'
             '• Should be ≤1% of capital per trade\n\n'
             'Interpretation:\n'
             '• Smaller losses = Better risk management\n'
             '• Consistency indicates discipline\n'
             '• Wide variation = Poor execution'),
            
            ('Largest Win', '$0.00', '-',
             'Largest Single Winning Trade\n\n'
             'The most profitable trade in the series.\n\n'
             'Analysis:\n'
             '• If >>Average Win: Outlier dependency risk\n'
             '• If ≈Average Win: Consistent performance\n\n'
             'Warning Signs:\n'
             '✗ Largest Win > 50% of Total P&L\n'
             '  → Strategy depends on rare events\n'
             '✗ Largest Win > 10x Average Win\n'
             '  → Not repeatable performance\n\n'
             'Healthy Strategy:\n'
             '✓ Largest Win ≤ 3x Average Win\n'
             '✓ Profits distributed across many trades'),
            
            ('Largest Loss', '$0.00', '-',
             'Largest Single Losing Trade\n\n'
             'The worst trade in the series.\n\n'
             'Risk Assessment:\n'
             '• Should be ≤2x Average Loss\n'
             '• If much larger: Stop loss failure\n'
             '• Indicates worst-case scenario\n\n'
             'Warning Signs:\n'
             '✗ Largest Loss > 3x Average Loss\n'
             '  → Stop loss not working properly\n'
             '✗ Largest Loss > 5% of capital\n'
             '  → Excessive single-trade risk\n\n'
             'Institutional Standard:\n'
             '✓ Largest Loss ≤ 1.5x Average Loss\n'
             '✓ Largest Loss < 2% of capital'),
            
            ('Risk/Reward Ratio', '0.00', '-',
             'Risk to Reward Ratio (R:R)\n\n'
             'Ratio of average win to average loss.\n\n'
             'Calculation:\n'
             'R:R = |Average Win| / |Average Loss|\n\n'
             'Example:\n'
             '$150 avg win / $100 avg loss = 1.5:1\n\n'
             'Win Rate Requirements:\n'
             '• 1:1 R:R needs >50% win rate to profit\n'
             '• 2:1 R:R needs >33% win rate to profit\n'
             '• 3:1 R:R needs >25% win rate to profit\n\n'
             'Institutional Target:\n'
             '✓ Good: ≥2:1 (wins are 2x losses)\n'
             '⚠ Fair: 1.5-2:1 (acceptable)\n'
             '✗ Poor: <1.5:1 (need high win rate)'),
            
            ('Recovery Factor', '0.00', '-',
             'Recovery Factor (Profit / Max Drawdown)\n\n'
             'How many times profit covers worst drawdown.\n\n'
             'Calculation:\n'
             'Recovery = Net Profit / Max Drawdown\n\n'
             'Example:\n'
             '$1,000 profit / $200 max DD = 5.0\n\n'
             'Interpretation:\n'
             '• Higher = Better drawdown recovery\n'
             '• Measures resilience\n'
             '• Important for live trading psychology\n\n'
             'Institutional Benchmark:\n'
             '✓ Good: ≥5.0 (strong recovery)\n'
             '⚠ Fair: 2.0-5.0 (acceptable)\n'
             '✗ Poor: <2.0 (weak recovery)'),
        ]
        
        self.perf_table.setRowCount(len(metrics))
        for row, (metric, value, rating, tooltip) in enumerate(metrics):
            # Column 0: Metric name
            item_metric = self._create_item(metric, align_left=True)
            item_metric.setToolTip(tooltip)
            self.perf_table.setItem(row, 0, item_metric)
            
            # Column 1: Value
            self.perf_table.setItem(row, 1, self._create_item(value))
            
            # Column 2: Rating
            self.perf_table.setItem(row, 2, self._create_item(rating))
            
            # Column 3: Recommendation (populated later by _update_performance_table)
            
            # Column 4: Checkbox (AT THE END, on the right)
            # Use actual QCheckBox widget (proper Qt approach)
            checkbox = QCheckBox()
            checkbox.setChecked(False)
            checkbox.stateChanged.connect(self._on_checkbox_changed)
            checkbox.setStyleSheet("QCheckBox { margin-left: 15px; background: transparent; }")  # Transparent background
            
            # Create container widget for centering
            checkbox_widget = QWidget()
            checkbox_layout = QHBoxLayout(checkbox_widget)
            checkbox_layout.addWidget(checkbox)
            checkbox_layout.setAlignment(Qt.AlignmentFlag.AlignCenter)
            checkbox_layout.setContentsMargins(0, 0, 0, 0)
            
            self.perf_table.setCellWidget(row, 4, checkbox_widget)
        
        perf_layout.addWidget(self.perf_table)
        perf_group.setLayout(perf_layout)
        
        return perf_group
    
    def _create_risk_group(self) -> QGroupBox:
        """Create risk metrics group - Design v2 with checkboxes"""
        # Risk metrics table
        risk_group = QGroupBox("⚠️ Risk Metrics")
        risk_group.setStyleSheet(get_groupbox_header_stylesheet())
        
        risk_layout = QVBoxLayout()
        risk_layout.setContentsMargins(10, 15, 10, 10)
        
        # Create risk table with Recommendations + CHECKBOX column (Design v2)
        # Checkbox is ON THE RIGHT (after recommendation)
        self.risk_table = QTableWidget()
        self.risk_table.setColumnCount(5)  # Added checkbox column at END
        self.risk_table.setHorizontalHeaderLabels(['Metric', 'Value', 'Status', 'Recommendation', ''])  # No checkbox in header
        
        # Use centralized table stylesheet (ZERO hardcoded styles)
        self.risk_table.setStyleSheet(get_table_stylesheet())
        
        self.risk_table.setAlternatingRowColors(True)
        self.risk_table.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)  # FIXED: Multi-row selection (Ctrl+Click, Shift+Click)
        self.risk_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.risk_table.setSortingEnabled(False)  # Disable sorting (checkboxes break it)
        
        # Column widths: Metric | Value | Status | Recommendation | Checkbox
        # READABLE widths - we have FULL WIDTH now (stacked layout)
        self.risk_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Fixed)  # Metric
        self.risk_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Fixed)  # Value
        self.risk_table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeMode.Fixed)  # Status
        self.risk_table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeMode.Stretch)  # Recommendation (takes remaining space)
        self.risk_table.horizontalHeader().setSectionResizeMode(4, QHeaderView.ResizeMode.Fixed)  # Checkbox
        
        self.risk_table.setColumnWidth(0, 350)  # Metric name (VERY WIDE per user request)
        self.risk_table.setColumnWidth(1, 350)  # Value column (VERY WIDE per user request)
        self.risk_table.setColumnWidth(2, 350)  # Status column (VERY WIDE per user request)
        # Column 3 (Recommendation) stretches to fill remaining width
        self.risk_table.setColumnWidth(4, 50)   # Checkbox column
        self.risk_table.verticalHeader().setVisible(False)
        
        # CRITICAL: Enable word wrap and auto-resize rows for multiline recommendations
        self.risk_table.setWordWrap(True)
        self.risk_table.verticalHeader().setSectionResizeMode(QHeaderView.ResizeMode.ResizeToContents)
        
        # Populate with risk metrics with institutional-grade tooltips
        risk_metrics = [
            ('Max Drawdown %', '0.00%', '-',
             'Maximum Drawdown Percentage\n\n'
             'Largest peak-to-trough decline as % of capital.\n\n'
             'Calculation:\n'
             'Max DD% = (Max DD$ / Starting Capital) × 100\n\n'
             'Example:\n'
             '$10,000 capital → $2,000 drawdown = 20% DD\n\n'
             'Interpretation:\n'
             '• Measures maximum pain endured\n'
             '• Critical for position sizing\n'
             '• Expect 2-3x worse in live trading\n\n'
             'Institutional Limits:\n'
             '✓ Good: <10% (conservative)\n'
             '⚠ Monitor: 10-20% (standard)\n'
             '✗ High Risk: >20% (aggressive)'),
            
            ('Max Drawdown Duration', '0 days', '-',
             'Maximum Drawdown Duration\n\n'
             'Longest time to recover from a drawdown.\n\n'
             'Measures:\n'
             '• Days from peak to new peak\n'
             '• Psychological endurance required\n'
             '• Strategy resilience\n\n'
             'Interpretation:\n'
             '• Shorter = Faster recovery\n'
             '• Longer = More psychological stress\n'
             '• Critical for trader psychology\n\n'
             'Institutional Tolerance:\n'
             '✓ Good: <30 days (quick recovery)\n'
             '⚠ Monitor: 30-90 days (moderate)\n'
             '✗ Concern: >90 days (prolonged)'),
            
            ('Value at Risk (95%)', '$0.00', '-',
             'Value at Risk - 95th Percentile\n\n'
             'Maximum expected loss in 95% of cases.\n\n'
             'Calculation:\n'
             'VaR(95%) = 5th percentile of P&L distribution\n\n'
             'Example:\n'
             'VaR = -$500 means:\n'
             '• 95% of trades lose <$500\n'
             '• 5% of trades lose >$500\n\n'
             'Interpretation:\n'
             '• Risk management tool\n'
             '• Position sizing input\n'
             '• Regulatory requirement for institutions\n\n'
             'Use For:\n'
             '• Setting position limits\n'
             '• Capital requirements\n'
             '• Risk budgeting'),
            
            ('Expected Shortfall', '$0.00', '-',
             'Expected Shortfall (Conditional VaR)\n\n'
             'Average loss when VaR is exceeded.\n\n'
             'Calculation:\n'
             'ES = Average of losses beyond VaR threshold\n\n'
             'Example:\n'
             '• VaR(95%) = -$500\n'
             '• ES = -$800 (avg of worst 5% losses)\n\n'
             'Interpretation:\n'
             '• Tail risk measurement\n'
             '• "What if VaR is breached?"\n'
             '• More conservative than VaR\n\n'
             'Institutional Use:\n'
             '• Stress testing\n'
             '• Capital allocation\n'
             '• Risk limit setting\n'
             '• Basel III compliance'),
            
            ('Sortino Ratio', '0.0000', '-',
             'Sortino Ratio (Downside Risk-Adjusted Return)\n\n'
             'Like Sharpe, but only penalizes downside volatility.\n\n'
             'Calculation:\n'
             'Sortino = Avg Return / Downside Deviation\n\n'
             'Difference from Sharpe:\n'
             '• Sharpe: Penalizes all volatility (up & down)\n'
             '• Sortino: Only penalizes downside volatility\n'
             '• Better for asymmetric strategies\n\n'
             'Interpretation:\n'
             '• Higher = Better downside-adjusted returns\n'
             '• Preferred by hedge funds\n'
             '• More realistic for active strategies\n\n'
             'Institutional Benchmark:\n'
             '✓ Good: ≥2.0 (excellent)\n'
             '⚠ Monitor: 1.0-2.0 (acceptable)\n'
             '✗ Poor: <1.0 (poor downside protection)'),
            
            ('Calmar Ratio', '0.00', '-',
             'Calmar Ratio (Return / Max Drawdown)\n\n'
             'Annual return divided by max drawdown.\n\n'
             'Calculation:\n'
             'Calmar = Annual Return% / Max Drawdown%\n\n'
             'Example:\n'
             '20% annual return / 10% max DD = 2.0\n\n'
             'Interpretation:\n'
             '• Measures return per unit of drawdown risk\n'
             '• Higher = Better drawdown-adjusted returns\n'
             '• Popular in managed futures industry\n\n'
             'Institutional Benchmark:\n'
             '✓ Good: ≥3.0 (excellent)\n'
             '⚠ Monitor: 1.0-3.0 (acceptable)\n'
             '✗ Poor: <1.0 (poor drawdown management)'),
            
            ('Max Consecutive Losses', '0', '-',
             'Maximum Consecutive Losing Trades\n\n'
             'Longest losing streak experienced.\n\n'
             'Psychological Impact:\n'
             '• Tests trader discipline\n'
             '• Indicates when to reduce size\n'
             '• Stress testing metric\n\n'
             'Interpretation:\n'
             '• Shorter = More consistent\n'
             '• Longer = Higher psychological stress\n'
             '• Prepare for 2x in live trading\n\n'
             'Risk Management:\n'
             '✓ Good: ≤3 (high consistency)\n'
             '⚠ Monitor: 4-5 (normal variance)\n'
             '✗ Concern: >5 (review strategy)'),
            
            ('Max Consecutive Wins', '0', '-',
             'Maximum Consecutive Winning Trades\n\n'
             'Longest winning streak experienced.\n\n'
             'Analysis:\n'
             '• If >>average: Watch for overconfidence\n'
             '• Prepare for regression to mean\n'
             '• Don\'t increase risk after wins\n\n'
             'Interpretation:\n'
             '• Shows best-case scenarios\n'
             '• Balance with max consecutive losses\n'
             '• Don\'t size up during streaks\n\n'
             'Behavioral Warning:\n'
             '⚠ Long win streaks can lead to:\n'
             '• Overconfidence\n'
             '• Increased position sizing\n'
             '• Complacency in risk management'),
            
            ('Average Drawdown', '$0.00', '-',
             'Average Drawdown\n\n'
             'Mean of all drawdown periods.\n\n'
             'Calculation:\n'
             'Avg DD = Sum of all drawdowns / Count\n\n'
             'Interpretation:\n'
             '• Typical drawdown experience\n'
             '• More realistic than max drawdown\n'
             '• Better for regular expectation setting\n\n'
             'Use For:\n'
             '• Position sizing baseline\n'
             '• Psychological preparation\n'
             '• Capital requirements\n\n'
             'Guideline:\n'
             '• Avg DD typically 30-50% of Max DD\n'
             '• Prepare for this regularly\n'
             '• Don\'t panic at average levels'),
            
            ('Standard Deviation', '$0.00', '-',
             'Standard Deviation of Returns\n\n'
             'Volatility of P&L distribution.\n\n'
             'Calculation:\n'
             'σ = √(Σ(Return - Mean)² / N)\n\n'
             'Interpretation:\n'
             '• Higher = More volatile returns\n'
             '• Lower = More consistent returns\n'
             '• Used in Sharpe Ratio denominator\n\n'
             'Normal Distribution:\n'
             '• 68% of trades within ±1σ\n'
             '• 95% of trades within ±2σ\n'
             '• 99.7% of trades within ±3σ\n\n'
             'Risk Management:\n'
             '• Position sizing input\n'
             '• Volatility targeting\n'
             '• Risk parity allocation'),
            
            ('Downside Deviation', '$0.00', '-',
             'Downside Deviation (Semi-Deviation)\n\n'
             'Standard deviation of negative returns only.\n\n'
             'Calculation:\n'
             'DD = √(Σ(Negative Returns)² / N)\n\n'
             'Difference from Std Dev:\n'
             '• Std Dev: Includes all returns (up & down)\n'
             '• Downside Dev: Only negative returns\n'
             '• More relevant for risk measurement\n\n'
             'Interpretation:\n'
             '• Lower = Less downside volatility\n'
             '• Used in Sortino Ratio\n'
             '• Better risk measure for asymmetric returns\n\n'
             'Institutional Preference:\n'
             '• Preferred over std dev for risk\n'
             '• Separates good volatility from bad\n'
             '• More conservative risk measure'),
            
            ('Ulcer Index', '0.00', '-',
             'Ulcer Index (Drawdown Stress Measure)\n\n'
             'Measures depth and duration of drawdowns.\n\n'
             'Calculation:\n'
             'UI = √(Σ(Drawdown%)² / N)\n\n'
             'What It Measures:\n'
             '• Investor stress/discomfort\n'
             '• Combines DD depth + duration\n'
             '• More comprehensive than max DD\n\n'
             'Interpretation:\n'
             '• Lower = Less stressful equity curve\n'
             '• Higher = More painful drawdowns\n'
             '• Alternative to standard deviation\n\n'
             'Behavioral Finance:\n'
             '• Accounts for psychological pain\n'
             '• Better for understanding trader stress\n'
             '• Used to compare strategies\n\n'
             'Target:\n'
             '✓ Good: <5% (smooth equity curve)\n'
             '⚠ Monitor: 5-10% (normal variance)\n'
             '✗ High: >10% (stressful drawdowns)'),
        ]
        
        self.risk_table.setRowCount(len(risk_metrics))
        for row, (metric, value, status, tooltip) in enumerate(risk_metrics):
            # Column 0: Metric name
            item_metric = self._create_item(metric, align_left=True)
            item_metric.setToolTip(tooltip)
            self.risk_table.setItem(row, 0, item_metric)
            
            # Column 1: Value
            self.risk_table.setItem(row, 1, self._create_item(value))
            
            # Column 2: Status
            self.risk_table.setItem(row, 2, self._create_item(status))
            
            # Column 3: Recommendation (populated later by _update_risk_table)
            
            # Column 4: Checkbox (AT THE END, on the right)
            # Use actual QCheckBox widget (proper Qt approach)
            checkbox = QCheckBox()
            checkbox.setChecked(False)
            checkbox.stateChanged.connect(self._on_checkbox_changed)
            checkbox.setStyleSheet("QCheckBox { margin-left: 15px; background: transparent; }")  # Transparent background
            
            # Create container widget for centering
            checkbox_widget = QWidget()
            checkbox_layout = QHBoxLayout(checkbox_widget)
            checkbox_layout.addWidget(checkbox)
            checkbox_layout.setAlignment(Qt.AlignmentFlag.AlignCenter)
            checkbox_layout.setContentsMargins(0, 0, 0, 0)
            
            self.risk_table.setCellWidget(row, 4, checkbox_widget)
        
        risk_layout.addWidget(self.risk_table)
        risk_group.setLayout(risk_layout)
        
        return risk_group
    
    def _create_comparison_tab(self) -> QWidget:
        """Create parameter comparison tab"""
        widget = QWidget()
        layout = QVBoxLayout()
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(15)
        
        # Comparison table
        comp_group = QGroupBox("Configuration Comparison")
        comp_group.setStyleSheet(get_groupbox_header_stylesheet())
        
        comp_layout = QVBoxLayout()
        comp_layout.setContentsMargins(10, 15, 10, 10)
        
        # Status label
        self.comp_status_label = QLabel("No comparison data available. Run optimization to compare configurations.")
        self.comp_status_label.setStyleSheet(get_label_style('muted'))
        self.comp_status_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        comp_layout.addWidget(self.comp_status_label)
        
        # Create comparison table
        self.comp_table = QTableWidget()
        self.comp_table.setColumnCount(4)
        self.comp_table.setHorizontalHeaderLabels(['Parameter', 'Original', 'Optimized', 'Change'])
        
        # Use centralized table stylesheet (ZERO hardcoded styles)
        self.comp_table.setStyleSheet(get_table_stylesheet())
        
        self.comp_table.setAlternatingRowColors(True)
        self.comp_table.setSelectionMode(QAbstractItemView.SelectionMode.NoSelection)
        self.comp_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.comp_table.setSortingEnabled(True)  # Excel-like sorting
        self.comp_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self.comp_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Fixed)
        self.comp_table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeMode.Fixed)
        self.comp_table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeMode.Fixed)
        self.comp_table.setColumnWidth(1, 120)
        self.comp_table.setColumnWidth(2, 120)
        self.comp_table.setColumnWidth(3, 100)
        self.comp_table.verticalHeader().setVisible(False)
        self.comp_table.setVisible(False)  # Hidden until data available
        
        comp_layout.addWidget(self.comp_table)
        comp_group.setLayout(comp_layout)
        layout.addWidget(comp_group)
        
        widget.setLayout(layout)
        return widget
    
    def _create_control_bar(self) -> QHBoxLayout:
        """Create control buttons at bottom - Design v2 with selection controls"""
        layout = QHBoxLayout()
        layout.setSpacing(15)
        
        # Status info
        self.status_label = QLabel("Status: <b>No data</b>")
        self.status_label.setStyleSheet(get_label_style())
        layout.addWidget(self.status_label)
        
        layout.addStretch()
        
        # Copy All button (matches Trades tab naming)
        copy_btn = QPushButton("📋 Copy All")
        copy_btn.setStyleSheet(get_primary_button_stylesheet(compact=True))
        copy_btn.setFixedSize(170, 52)
        copy_btn.clicked.connect(self._copy_all_metrics)
        copy_btn.setToolTip("Copy all metrics to clipboard")
        layout.addWidget(copy_btn)
        
        # Copy Selection button (matches Trades tab naming)
        copy_sel_btn = QPushButton("📋 Copy Selection")
        copy_sel_btn.setStyleSheet(get_primary_button_stylesheet(compact=True))
        copy_sel_btn.setFixedSize(260, 52)
        copy_sel_btn.clicked.connect(self._copy_selected_metrics)
        copy_sel_btn.setToolTip("Copy selected rows to clipboard")
        layout.addWidget(copy_sel_btn)
        
        # Select All button
        select_all_btn = QPushButton("☑ Select All")
        select_all_btn.setStyleSheet(get_primary_button_stylesheet(compact=True))
        select_all_btn.setFixedSize(170, 52)
        select_all_btn.clicked.connect(self._select_all_recommendations)
        select_all_btn.setToolTip("Select all recommendations for application")
        layout.addWidget(select_all_btn)
        
        # Clear All button
        clear_all_btn = QPushButton("☐ Clear All")
        clear_all_btn.setStyleSheet(get_primary_button_stylesheet(compact=True))
        clear_all_btn.setFixedSize(170, 52)
        clear_all_btn.clicked.connect(self._clear_all_recommendations)
        clear_all_btn.setToolTip("Deselect all recommendations")
        layout.addWidget(clear_all_btn)
        
        # Apply Recommendation(s) button (Design v2 - PRIMARY ACTION)
        self.apply_btn = QPushButton("💡 Apply Recommendation(s)")
        self.apply_btn.setStyleSheet(get_primary_button_stylesheet(compact=False))  # Prominent
        self.apply_btn.setFixedSize(380, 52)
        self.apply_btn.clicked.connect(self._apply_selected_recommendations)
        self.apply_btn.setEnabled(False)  # Disabled until selections made
        self.apply_btn.setToolTip("Apply selected recommendations to strategy configuration")
        layout.addWidget(self.apply_btn)
        
        # Auto-Retest checkbox
        self.auto_retest_check = QPushButton("🔄 Auto-Retest")
        self.auto_retest_check.setStyleSheet(get_primary_button_stylesheet(compact=True))
        self.auto_retest_check.setCheckable(True)
        self.auto_retest_check.setChecked(False)
        self.auto_retest_check.setFixedSize(200, 52)
        self.auto_retest_check.setToolTip(
            "Auto-Retest After Applying Recommendations\n\n"
            "When enabled:\n"
            "• Recommendations are applied to config\n"
            "• Backtest runs automatically\n"
            "• Results compared with original\n\n"
            "When disabled:\n"
            "• Recommendations applied only\n"
            "• Manual retest required"
        )
        layout.addWidget(self.auto_retest_check)
        
        # Export button (moved to end)
        export_btn = QPushButton("💾 Export")
        export_btn.setStyleSheet(get_primary_button_stylesheet(compact=True))
        export_btn.setFixedSize(140, 52)  # FIXED: Wider for consistency
        export_btn.clicked.connect(self._export_metrics)
        export_btn.setToolTip("Export metrics to CSV")
        layout.addWidget(export_btn)
        
        return layout
    
    def _create_item(self, text: str, align_left: bool = False) -> QTableWidgetItem:
        """Create table item with proper alignment"""
        item = QTableWidgetItem(text)
        if align_left:
            item.setTextAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)
        else:
            item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
        return item
    
    def update_metrics(self, metrics: Dict, backtest_complete: bool = False, backtest_results: Optional[Dict] = None) -> None:
        """
        Update metrics display.
        
        Args:
            metrics: Dictionary with performance metrics (summary only)
            backtest_complete: If True, runs AI recommendations (expensive operation)
            backtest_results: FULL backtest results with trade list (for AI analysis)
        """
        # SAVE checkbox states BEFORE updating (critical fix for auto-uncheck bug)
        saved_perf_states = self._save_checkbox_states(self.perf_table)
        saved_risk_states = self._save_checkbox_states(self.risk_table)
        
        self.current_metrics = metrics
        self.full_backtest_results = backtest_results  # FIXED: Save full results
        
        # Initialize recommendation engine on first use (but don't run it yet)
        if self.rec_engine is None:
            self._initialize_recommendation_engine()
        
        # ONLY populate AI Recommendations Panel when backtest is COMPLETE
        # (NOT on every metrics update)
        # DO NOT auto-generate - wait for user to click "Approve & Send to AI" button
        if backtest_complete:
            logger.info("[UI] Backtest complete - populating AI Recommendations panel preview...")
            self._populate_ai_recommendations_panel()
        
        # Update tables with metrics and recommendations
        self._update_performance_table()
        self._update_risk_table()
        
        # RESTORE checkbox states AFTER updating (preserves user selections)
        self._restore_checkbox_states(self.perf_table, saved_perf_states)
        self._restore_checkbox_states(self.risk_table, saved_risk_states)
        
        self.status_label.setText("Status: <b>Data loaded</b>")
        self.metrics_updated.emit(metrics)
    
    def _save_checkbox_states(self, table: QTableWidget) -> Dict[int, bool]:
        """
        Save checkbox states from a table.
        
        Args:
            table: The table to save states from
        
        Returns:
            Dictionary mapping row number to checkbox checked state
        """
        states = {}
        for row in range(table.rowCount()):
            checkbox_widget = table.cellWidget(row, 4)
            if checkbox_widget:
                checkbox = checkbox_widget.findChild(QCheckBox)
                if checkbox and checkbox.isVisible():
                    states[row] = checkbox.isChecked()
        return states
    
    def _restore_checkbox_states(self, table: QTableWidget, states: Dict[int, bool]) -> None:
        """
        Restore checkbox states to a table.
        
        Args:
            table: The table to restore states to
            states: Dictionary mapping row number to checkbox checked state
        """
        for row, checked in states.items():
            checkbox_widget = table.cellWidget(row, 4)
            if checkbox_widget:
                checkbox = checkbox_widget.findChild(QCheckBox)
                if checkbox and checkbox.isVisible() and checkbox.isEnabled():
                    # Block signals while restoring state to prevent triggering updates
                    checkbox.blockSignals(True)
                    checkbox.setChecked(checked)
                    checkbox.blockSignals(False)
    
    def _update_performance_table(self) -> None:
        """Update performance metrics table"""
        if not self.current_metrics:
            return
        
        # Initialize recommendation engine on first use
        if self.rec_engine is None:
            self._initialize_recommendation_engine()
        
        # Update each row with actual data - Sprint 1.8 Task 1.8.74: Added exit metrics
        metrics_map = {
            0: ('total_pnl', lambda x: f"${float(x):,.2f}"),
            1: ('total_return', lambda x: f"{float(x):.2f}%"),
            2: ('sharpe_ratio', lambda x: f"{float(x):.4f}"),
            3: ('win_rate', lambda x: f"{float(x):.2f}%"),
            4: ('profit_factor', lambda x: f"{float(x):.3f}"),
            5: ('max_drawdown', lambda x: f"${float(x):,.2f}"),
            6: ('total_trades', lambda x: str(int(x))),
            7: ('avg_trade_pnl', lambda x: f"${float(x):,.2f}"),
            8: ('avg_win', lambda x: f"${float(x):,.2f}"),
            9: ('avg_loss', lambda x: f"${float(x):,.2f}"),
            10: ('largest_win', lambda x: f"${float(x):,.2f}"),
            11: ('largest_loss', lambda x: f"${float(x):,.2f}"),
            12: ('risk_reward_ratio', lambda x: f"{float(x):.2f}"),
            13: ('recovery_factor', lambda x: f"{float(x):.2f}"),
            # Sprint 1.8 Task 1.8.74: Exit condition metrics (if available)
            14: ('exit_condition_triggers', lambda x: str(int(x))),
            15: ('exit_condition_pnl', lambda x: f"${float(x):,.2f}"),
            16: ('partial_exit_count', lambda x: str(int(x))),
        }
        
        for row, (key, formatter) in metrics_map.items():
            if key in self.current_metrics:
                value = self.current_metrics[key]
                formatted = formatter(value)
                item = self._create_item(formatted)
                
                # Color code certain metrics
                if key in ['total_pnl', 'avg_trade_pnl']:
                    if float(value) > 0:
                        item.setForeground(QColor(get_color('success')))
                    elif float(value) < 0:
                        item.setForeground(QColor(get_color('error')))
                
                self.perf_table.setItem(row, 1, item)  # Column 1: Value
                
                # Set rating
                rating = self._get_rating(key, value)
                rating_item = self._create_item(rating)
                if rating == '✓ Good':
                    rating_item.setForeground(QColor(get_color('success')))
                elif rating == '⚠ Fair':
                    rating_item.setForeground(QColor(get_color('warning')))
                elif rating == '✗ Poor':
                    rating_item.setForeground(QColor(get_color('error')))
                self.perf_table.setItem(row, 2, rating_item)  # Column 2: Rating
                
                # Map batch recommendations to this metric (from cached batch results)
                rec_obj = None
                rec_text = ""
                
                if rating in ['⚠ Fair', '✗ Poor']:
                    # Find recommendation from batch results that targets this metric
                    for batch_rec in self.batch_recommendations:
                        if batch_rec.metric_targeted == key or key in str(batch_rec.expected_impact):
                            rec_obj = batch_rec
                            if self.rec_engine:
                                rec_text = self.rec_engine.format_recommendation_text(rec_obj)
                            else:
                                rec_text = batch_rec.reasoning[:100] + "..."
                            self.recommendation_cache[f"perf_{row}"] = rec_obj
                            break
                    
                    if not rec_obj:
                        # No AI recommendation found - use generic
                        rec_text = self._get_generic_recommendation(key, value, rating)
                        self.recommendation_cache[f"perf_{row}"] = None
                else:
                    self.recommendation_cache[f"perf_{row}"] = None
                
                rec_item = self._create_item(rec_text, align_left=True)
                self.perf_table.setItem(row, 3, rec_item)  # Column 3: Recommendation
                
                # Show/hide checkbox - ONLY visible for intelligent recommendations
                checkbox_widget = self.perf_table.cellWidget(row, 4)
                if checkbox_widget:
                    # Find the QCheckBox inside the container widget
                    checkbox = checkbox_widget.findChild(QCheckBox)
                    if checkbox:
                        # Only show checkbox if we have an intelligent recommendation
                        is_actionable = rec_obj is not None and self._is_intelligent_recommendation(rec_text)
                        
                        # Block signals BEFORE any state changes
                        checkbox.blockSignals(True)
                        
                        if is_actionable:
                            # Show and enable checkbox for intelligent recommendations
                            checkbox_widget.setVisible(True)
                            checkbox.setEnabled(True)
                            # DON'T reset checked state - preserve user's selection
                        else:
                            # Hide checkbox completely for non-actionable recommendations
                            checkbox_widget.setVisible(False)
                            checkbox.setEnabled(False)
                            checkbox.setChecked(False)  # Reset when hiding
                        
                        # Re-enable signals AFTER all state changes complete
                        checkbox.blockSignals(False)
    
    def _update_risk_table(self) -> None:
        """Update risk metrics table"""
        if not self.current_metrics:
            return
        
        # Initialize recommendation engine on first use
        if self.rec_engine is None:
            self._initialize_recommendation_engine()
        
        # Update each row with actual risk data
        risk_metrics_map = {
            0: ('max_drawdown_pct', lambda x: f"{float(x):.2f}%"),
            1: ('max_drawdown_duration', lambda x: f"{int(x)} days"),
            2: ('var_95', lambda x: f"${float(x):,.2f}"),
            3: ('expected_shortfall', lambda x: f"${float(x):,.2f}"),
            4: ('sortino_ratio', lambda x: f"{float(x):.4f}"),
            5: ('calmar_ratio', lambda x: f"{float(x):.2f}"),
            6: ('max_consecutive_losses', lambda x: str(int(x))),
            7: ('max_consecutive_wins', lambda x: str(int(x))),
            8: ('avg_drawdown', lambda x: f"${float(x):,.2f}"),
            9: ('std_deviation', lambda x: f"${float(x):,.2f}"),
            10: ('downside_deviation', lambda x: f"${float(x):,.2f}"),
            11: ('ulcer_index', lambda x: f"{float(x):.2f}"),
        }
        
        for row, (key, formatter) in risk_metrics_map.items():
            if key in self.current_metrics:
                value = self.current_metrics[key]
                formatted = formatter(value)
                item = self._create_item(formatted)
                
                # Color code certain risk metrics
                if key == 'max_drawdown_pct':
                    if float(value) < 10.0:
                        item.setForeground(QColor(get_color('success')))
                    elif float(value) < 20.0:
                        item.setForeground(QColor(get_color('warning')))
                    else:
                        item.setForeground(QColor(get_color('error')))
                
                self.risk_table.setItem(row, 1, item)  # Column 1: Value
                
                # Set status
                status = self._get_risk_status(key, value)
                status_item = self._create_item(status)
                if status == '✓ Good':
                    status_item.setForeground(QColor(get_color('success')))
                elif status == '⚠ Monitor':
                    status_item.setForeground(QColor(get_color('warning')))
                elif status == '✗ High' or status == '✗ Poor':
                    status_item.setForeground(QColor(get_color('error')))  # RED for Poor/High
                self.risk_table.setItem(row, 2, status_item)  # Column 2: Status
                
                # Map batch recommendations to this risk metric
                rec_obj = None
                rec_text = ""
                
                if status in ['⚠ Monitor', '✗ High', '✗ Poor']:
                    # Find recommendation from batch results
                    for batch_rec in self.batch_recommendations:
                        if batch_rec.metric_targeted == key or key in str(batch_rec.expected_impact):
                            rec_obj = batch_rec
                            if self.rec_engine:
                                rec_text = self.rec_engine.format_recommendation_text(rec_obj)
                            else:
                                rec_text = batch_rec.reasoning[:100] + "..."
                            self.recommendation_cache[f"risk_{row}"] = rec_obj
                            break
                    
                    if not rec_obj:
                        # No AI recommendation found - use generic
                        rec_text = self._get_risk_recommendation_generic(key, value, status)
                        self.recommendation_cache[f"risk_{row}"] = None
                else:
                    self.recommendation_cache[f"risk_{row}"] = None
                
                rec_item = self._create_item(rec_text, align_left=True)
                self.risk_table.setItem(row, 3, rec_item)  # Column 3: Recommendation
                
                # Show/hide checkbox - ONLY visible for intelligent recommendations
                checkbox_widget = self.risk_table.cellWidget(row, 4)
                if checkbox_widget:
                    # Find the QCheckBox inside the container widget
                    checkbox = checkbox_widget.findChild(QCheckBox)
                    if checkbox:
                        # Only show checkbox if we have an intelligent recommendation
                        is_actionable = rec_obj is not None and self._is_intelligent_recommendation(rec_text)
                        
                        # Block signals BEFORE any state changes
                        checkbox.blockSignals(True)
                        
                        if is_actionable:
                            # Show and enable checkbox for intelligent recommendations
                            checkbox_widget.setVisible(True)
                            checkbox.setEnabled(True)
                            # DON'T reset checked state - preserve user's selection
                        else:
                            # Hide checkbox completely for non-actionable recommendations
                            checkbox_widget.setVisible(False)
                            checkbox.setEnabled(False)
                            checkbox.setChecked(False)  # Reset when hiding
                        
                        # Re-enable signals AFTER all state changes complete
                        checkbox.blockSignals(False)
    
    def _get_risk_status(self, metric_key: str, value) -> str:
        """Get status for risk metric value"""
        try:
            val = float(value)
            
            if metric_key == 'max_drawdown_pct':
                if val < 10.0:
                    return '✓ Good'
                elif val < 20.0:
                    return '⚠ Monitor'
                else:
                    return '✗ High'
            elif metric_key == 'max_drawdown_duration':
                val_int = int(val)
                if val_int < 30:
                    return '✓ Good'
                elif val_int < 90:
                    return '⚠ Monitor'
                else:
                    return '✗ High'
            elif metric_key == 'var_95':
                # VaR should be reasonable (less loss = better)
                abs_val = abs(val)
                if abs_val < 100.0:
                    return '✓ Good'
                elif abs_val < 200.0:
                    return '⚠ Monitor'
                else:
                    return '✗ High'
            elif metric_key == 'expected_shortfall':
                # ES should be controlled (less loss = better)
                abs_val = abs(val)
                if abs_val < 150.0:
                    return '✓ Good'
                elif abs_val < 300.0:
                    return '⚠ Monitor'
                else:
                    return '✗ High'
            elif metric_key == 'sortino_ratio':
                if val >= 2.0:
                    return '✓ Good'
                elif val >= 1.0:
                    return '⚠ Monitor'
                else:
                    return '✗ Poor'
            elif metric_key == 'calmar_ratio':
                if val >= 3.0:
                    return '✓ Good'
                elif val >= 1.0:
                    return '⚠ Monitor'
                else:
                    return '✗ Poor'
            elif metric_key == 'max_consecutive_losses':
                val_int = int(val)
                if val_int <= 3:
                    return '✓ Good'
                elif val_int <= 5:
                    return '⚠ Monitor'
                else:
                    return '✗ High'
            elif metric_key == 'max_consecutive_wins':
                val_int = int(val)
                if val_int >= 3:
                    return '✓ Good'
                elif val_int >= 2:
                    return '⚠ Monitor'
                else:
                    return '✗ Low'
            elif metric_key == 'avg_drawdown':
                # Average DD should be reasonable
                abs_val = abs(val)
                if abs_val < 150.0:
                    return '✓ Good'
                elif abs_val < 300.0:
                    return '⚠ Monitor'
                else:
                    return '✗ High'
            elif metric_key == 'std_deviation':
                # Lower volatility is better
                if val < 50.0:
                    return '✓ Good'
                elif val < 100.0:
                    return '⚠ Monitor'
                else:
                    return '✗ High'
            elif metric_key == 'downside_deviation':
                # Lower downside volatility is better
                if val < 40.0:
                    return '✓ Good'
                elif val < 80.0:
                    return '⚠ Monitor'
                else:
                    return '✗ High'
            elif metric_key == 'ulcer_index':
                # Lower UI = less stress
                if val < 5.0:
                    return '✓ Good'
                elif val < 10.0:
                    return '⚠ Monitor'
                else:
                    return '✗ High'
            else:
                return '-'
        except:
            return '-'
    
    def _get_rating(self, metric_key: str, value) -> str:
        """Get rating for metric value"""
        try:
            val = float(value)
            
            if metric_key == 'total_pnl':
                if val > 0:
                    return '✓ Good'
                elif val == 0:
                    return '⚠ Fair'
                else:
                    return '✗ Poor'
            elif metric_key == 'total_return':
                if val >= 15.0:
                    return '✓ Good'
                elif val >= 8.0:
                    return '⚠ Fair'
                else:
                    return '✗ Poor'
            elif metric_key == 'sharpe_ratio':
                if val >= 2.0:
                    return '✓ Good'
                elif val >= 1.0:
                    return '⚠ Fair'
                else:
                    return '✗ Poor'
            elif metric_key == 'win_rate':
                if val >= 60.0:
                    return '✓ Good'
                elif val >= 50.0:
                    return '⚠ Fair'
                else:
                    return '✗ Poor'
            elif metric_key == 'profit_factor':
                if val >= 2.0:
                    return '✓ Good'
                elif val >= 1.5:
                    return '⚠ Fair'
                else:
                    return '✗ Poor'
            elif metric_key == 'max_drawdown':
                # For drawdown, lower is better (it's negative impact)
                # This is in dollars, so context matters
                return '-'  # Better to check max_drawdown_pct in risk metrics
            elif metric_key == 'total_trades':
                val_int = int(val)
                if val_int >= 100:
                    return '✓ Good'
                elif val_int >= 30:
                    return '⚠ Fair'
                else:
                    return '✗ Poor'
            elif metric_key == 'avg_trade_pnl':
                if val > 10.0:
                    return '✓ Good'
                elif val > 0:
                    return '⚠ Fair'
                else:
                    return '✗ Poor'
            elif metric_key == 'avg_win':
                # Larger wins are better
                if val > 50.0:
                    return '✓ Good'
                elif val > 20.0:
                    return '⚠ Fair'
                else:
                    return '✗ Poor'
            elif metric_key == 'avg_loss':
                # Smaller losses are better (absolute value)
                abs_val = abs(val)
                if abs_val < 30.0:
                    return '✓ Good'
                elif abs_val < 60.0:
                    return '⚠ Fair'
                else:
                    return '✗ Poor'
            elif metric_key == 'largest_win':
                # Should not dominate total P&L
                if val > 0 and val < 200:
                    return '✓ Good'
                elif val >= 200:
                    return '⚠ Fair'  # Might be outlier dependency
                else:
                    return '-'
            elif metric_key == 'largest_loss':
                # Should be controlled
                abs_val = abs(val)
                if abs_val < 80.0:
                    return '✓ Good'
                elif abs_val < 150.0:
                    return '⚠ Fair'
                else:
                    return '✗ Poor'
            elif metric_key == 'risk_reward_ratio':
                if val >= 2.0:
                    return '✓ Good'
                elif val >= 1.5:
                    return '⚠ Fair'
                else:
                    return '✗ Poor'
            elif metric_key == 'recovery_factor':
                if val >= 5.0:
                    return '✓ Good'
                elif val >= 2.0:
                    return '⚠ Fair'
                else:
                    return '✗ Poor'
            # Sprint 1.8 Task 1.8.75: Exit condition metric ratings
            elif metric_key == 'exit_condition_triggers':
                # Number of times exit conditions triggered
                val_int = int(val)
                if val_int > 0:
                    return '✓ Good'  # Exit conditions being used
                else:
                    return '-'  # No exit conditions or none triggered
            elif metric_key == 'exit_condition_pnl':
                # P&L from exit condition exits (can be positive or negative)
                if val > 0:
                    return '✓ Good'  # Exits adding to profit
                elif val < 0:
                    return '✗ Poor'  # Exits losing money
                else:
                    return '-'  # No exit condition P&L
            elif metric_key == 'partial_exit_count':
                # Number of partial exits executed
                val_int = int(val)
                if val_int > 0:
                    return '✓ Good'  # Partial exits being used
                else:
                    return '-'  # No partial exits
            else:
                return '-'
        except:
            return '-'
    
    def _refresh_metrics(self) -> None:
        """Refresh metrics display"""
        if self.current_metrics:
            self.update_metrics(self.current_metrics)
    
    def _export_metrics(self) -> None:
        """Export metrics to CSV"""
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        filename = f"metrics_export_{timestamp}.csv"
        
        try:
            with open(filename, 'w') as f:
                f.write("Metric,Value,Rating\n")
                
                for row in range(self.perf_table.rowCount()):
                    metric = self.perf_table.item(row, 0).text()
                    value = self.perf_table.item(row, 1).text()
                    rating = self.perf_table.item(row, 2).text()
                    f.write(f"{metric},{value},{rating}\n")
            
            logger.info(f"✅ Metrics exported to {filename}")
            
        except Exception as e:
            logger.error(f"❌ Export failed: {str(e)}")
    
    def _generate_batch_recommendations(self) -> None:
        """
        Generate batch recommendations using NEW intelligent engine IN BACKGROUND THREAD
        
        This is called ONCE when backtest is complete (not on every metric update).
        Results are cached and mapped to individual table rows.
        
        CRITICAL FIX: Runs in background thread to prevent UI freeze.
        """
        logger.info("=" * 80)
        logger.info("[AI GEN] _generate_batch_recommendations() CALLED")
        logger.info(f"[AI GEN] rec_engine: {self.rec_engine is not None}")
        logger.info(f"[AI GEN] current_metrics: {self.current_metrics is not None}")
        if self.current_metrics:
            logger.info(f"[AI GEN] current_metrics keys: {list(self.current_metrics.keys())}")
        logger.info("=" * 80)
        
        if not self.rec_engine or not self.current_metrics:
            logger.error(f"[AI GEN] ❌ EARLY RETURN: rec_engine={self.rec_engine is not None}, metrics={self.current_metrics is not None}")
            return
        
        try:
            logger.info("[AI GEN] Getting strategy config...")
            # Prepare strategy config (get from orchestrator)
            strategy_config_obj = self._get_current_strategy_config()
            logger.info(f"[AI GEN] strategy_config_obj: {strategy_config_obj is not None}")
            
            if not strategy_config_obj:
                logger.warning("⚠️ No strategy config available - using generic recommendations")
                self.batch_recommendations = []
                return
            
            # Convert StrategyConfig object to dict format expected by engine
            strategy_config_dict = self._convert_strategy_config_to_dict(strategy_config_obj)
            
            # Prepare metrics dict with ratings for engine
            metrics_with_ratings = {}
            metrics_map = ['total_pnl', 'total_return', 'sharpe_ratio', 'win_rate', 'profit_factor',
                          'max_drawdown', 'total_trades', 'avg_trade_pnl', 'avg_win', 'avg_loss',
                          'largest_win', 'largest_loss', 'risk_reward_ratio', 'recovery_factor']
            
            for metric_key in metrics_map:
                if metric_key in self.current_metrics:
                    value = self.current_metrics[metric_key]
                    rating = self._get_rating(metric_key, value)
                    metrics_with_ratings[metric_key] = {
                        'value': float(value),
                        'rating': rating
                    }
            
            # Create progress dialog (NON-BLOCKING, 2X SIZE)
            self.progress_dialog = QProgressDialog(
                "Generating AI recommendations...",
                None,  # CRITICAL: No cancel button to avoid blocking
                0,
                100,
                self
            )
            self.progress_dialog.setWindowTitle("🤖 AI Analysis in Progress")
            self.progress_dialog.setWindowModality(Qt.WindowModality.NonModal)  # CRITICAL: Non-modal
            self.progress_dialog.setMinimumDuration(0)  # Show immediately
            self.progress_dialog.setValue(0)
            self.progress_dialog.setAutoClose(False)  # FIXED: Don't auto-close (manual control)
            self.progress_dialog.setAutoReset(False)  # FIXED: Don't auto-reset
            self.progress_dialog.setCancelButton(None)  # CRITICAL: Disable cancel to prevent blocking
            # FIXED: Make dialog 2x larger
            self.progress_dialog.setMinimumSize(800, 300)
            self.progress_dialog.resize(800, 300)
            # CRITICAL FIX: Force show() immediately to ensure dialog renders
            self.progress_dialog.show()
            QApplication.processEvents()  # Force UI update before starting worker
            
            # Create background worker (FIXED: Pass full backtest results with trade list)
            self.rec_worker = RecommendationWorker(
                engine=self.rec_engine,
                strategy_config=strategy_config_dict,
                backtest_results=self.full_backtest_results or self.current_metrics,  # Use full results if available
                metrics=metrics_with_ratings,
                lookback_days=180
            )
            
            # Connect signals
            self.rec_worker.recommendations_ready.connect(self._on_recommendations_ready)
            self.rec_worker.progress_update.connect(self._on_ai_progress)
            self.rec_worker.error_occurred.connect(self._on_ai_error)
            self.progress_dialog.canceled.connect(self.rec_worker.terminate)
            
            # CRITICAL FIX: Add minimum display time to ensure user sees progress
            # Even if worker finishes instantly, dialog stays visible for 1 second
            from PyQt5.QtCore import QTimer
            self.min_dialog_timer = QTimer()
            self.min_dialog_timer.setSingleShot(True)
            self.min_dialog_timer.timeout.connect(self._allow_dialog_close)
            self.dialog_can_close = False  # Flag to prevent instant close
            self.min_dialog_timer.start(1000)  # Minimum 1 second display
            
            # Start background generation
            logger.info("[UI] Starting AI recommendation generation in background thread...")
            self.rec_worker.start()
            
        except Exception as e:
            logger.error(f"⚠️ Failed to start background recommendation generation: {str(e)}")
            import traceback
            traceback.print_exc()
            self.batch_recommendations = []
    
    def _allow_dialog_close(self) -> None:
        """Allow progress dialog to close after minimum display time"""
        self.dialog_can_close = True
        # If recommendations are already ready, close dialog now
        if hasattr(self, 'progress_dialog') and hasattr(self, '_recommendations_waiting'):
            logger.info("[UI] Minimum dialog time elapsed - closing now")
            self.progress_dialog.close()
            # CRITICAL FIX: Finalize recommendations that were waiting for the timer.
            # Without this call, recommendations_generated is never emitted and
            # AIRecommendationsPanel.display_recommendations() is never invoked.
            del self._recommendations_waiting  # Clear the flag before calling
            self._finalize_recommendations()
    
    def _on_recommendations_ready(self, recommendations: List[IntegratedRecommendation]) -> None:
        """
        Handle completion of background AI recommendation generation.
        
        Args:
            recommendations: List of generated recommendations
        """
        # Store results first
        self.batch_recommendations = recommendations
        logger.info(f"[UI] ✅ Received {len(recommendations)} AI recommendations")
        
        # Close progress dialog ONLY if minimum time has elapsed
        if hasattr(self, 'progress_dialog'):
            if self.dialog_can_close:
                # Minimum time elapsed - close immediately
                logger.info("[UI] Closing dialog (minimum time already elapsed)")
                self.progress_dialog.close()
            else:
                # Minimum time not elapsed - mark as waiting and let timer close it
                logger.info("[UI] Recommendations ready but waiting for minimum dialog time...")
                self._recommendations_waiting = True
                return  # Don't update UI yet - wait for timer
        
        # Continue with UI updates
        self._finalize_recommendations()
    
    def _finalize_recommendations(self) -> None:
        """Finalize recommendations display (called after dialog closes)"""
        logger.info("[UI] Finalizing recommendations display...")
        
        # Update tables to show new recommendations
        self._update_performance_table()
        self._update_risk_table()
        
        # Update status
        self.status_label.setText(f"Status: <b>{len(self.batch_recommendations)} AI recommendations generated</b>")
        
        # CRITICAL: Populate AI Recommendations Panel with FULL preview data
        self._populate_ai_recommendations_panel()
        logger.info(f"[UI] ✅ Populated AI Recommendations Panel with full preview data")
        
        # P4: Emit recommendations_generated signal with batch recommendations
        # This wires to AIRecommendationsPanel.display_recommendations
        if self.batch_recommendations:
            self.recommendations_generated.emit(self.batch_recommendations)
            logger.info(f"[UI] Emitted recommendations_generated signal ({len(self.batch_recommendations)} recs)")
        
        # P3: Push full AI diagnosis (assessment, root_cause_analysis, implementation_order)
        # to the AI Recommendations Panel
        if self.rec_engine is not None:
            full_analysis = self.rec_engine.last_full_analysis
            if full_analysis:
                self._push_ai_analysis_to_panel(full_analysis)
                logger.info("[UI] Pushed full AI analysis to panel")
        
        # AUTO-SWITCH to AI Recommendations tab (BTCAAAAA-391 Bug 3).
        # Use a deferred QTimer.singleShot(0) so the tab switch runs after all
        # pending Qt events (dialog-close cleanup, focus-change events, etc.) have
        # been processed.  Without the deferral the tab switch could be overridden
        # by a focus-return event emitted by the closing QProgressDialog.
        from PyQt5.QtCore import QTimer
        QTimer.singleShot(0, self._switch_to_metrics_tab)
    
    def _on_ai_progress(self, message: str, percentage: int) -> None:
        """
        Handle progress updates from AI worker.

        Args:
            message: Progress message
            percentage: Progress percentage (0-100, or -1 for unknown)

        UX fix (BTCAAAAA-391): When STEP 4/5 is reached (80%) the worker blocks
        on the AI API HTTP call for 15-30 seconds with no further updates.  The
        progress bar appeared frozen.  We now switch to indeterminate / pulse mode
        at that point so users see activity, and restore determinate mode when
        STEP 5/5 arrives.
        """
        if not hasattr(self, 'progress_dialog'):
            return

        self.progress_dialog.setLabelText(message)

        if percentage == 80:
            # AI API call is about to start — switch to indeterminate (pulsing) mode
            # so the bar animates during the long HTTP wait instead of looking frozen.
            self.progress_dialog.setRange(0, 0)   # setRange(0, 0) = indeterminate
            self.progress_dialog.setLabelText(
                message + "\n\n⏳ Waiting for AI response... (may take 15–30 seconds)"
            )
        elif percentage == 95:
            # STEP 5/5 received — API call returned, restore determinate mode
            self.progress_dialog.setRange(0, 100)
            self.progress_dialog.setValue(percentage)
        elif percentage == 100:
            # Completion — snap to 100%
            self.progress_dialog.setRange(0, 100)
            self.progress_dialog.setValue(percentage)
        elif percentage >= 0:
            self.progress_dialog.setRange(0, 100)
            self.progress_dialog.setValue(percentage)
        # percentage == -1 → unknown; label already updated above, no bar change
    
    def _on_ai_error(self, error_msg: str) -> None:
        """
        Handle  error from AI worker.
        
        Args:
            error_msg: Error message
        """
        if hasattr(self, 'progress_dialog'):
            self.progress_dialog.close()
        
        logger.error(f"❌ AI Error: {error_msg}")
        self.status_label.setText(f"Status: <b>AI generation failed: {error_msg}</b>")
        self.batch_recommendations = []
    
    def _convert_strategy_config_to_dict(self, strategy_config_obj) -> Dict:
        """
        Convert StrategyConfig object to dict format with COMPLETE details for AI
        
        Extracts ALL parameters including:
        - Blocks and signals
        - Timing constraints
        - Recheck settings
        - Entry/exit conditions
        - AI-friendly explanations
        
        Args:
            strategy_config_obj: StrategyConfig object from orchestrator
        
        Returns:
            Dictionary format with complete strategy details
        """
        try:
            # Convert to dict format with COMPLETE details
            config_dict = {
                'name': getattr(strategy_config_obj, 'name', 'Unknown Strategy'),
                'strategy_type': getattr(strategy_config_obj, 'strategy_type', 'LONG_SHORT'),
                'blocks': [],
                
                # TIMING CONSTRAINTS - When strategy runs
                'timing_constraints': {
                    'session': getattr(strategy_config_obj, 'session', None),
                    'start_time': getattr(strategy_config_obj, 'start_time', None),
                    'end_time': getattr(strategy_config_obj, 'end_time', None),
                    'timezone': getattr(strategy_config_obj, 'timezone', 'UTC'),
                    'explanation': 'When the strategy is allowed to enter trades (e.g., "ASIA session" means 00:00-08:00 UTC)'
                },
                
                # RECHECK SETTINGS - How often signals are re-evaluated
                'recheck_settings': {
                    'enabled': getattr(strategy_config_obj, 'recheck_enabled', None),
                    'interval_minutes': getattr(strategy_config_obj, 'recheck_interval', None),
                    'max_rechecks': getattr(strategy_config_obj, 'max_rechecks', None),
                    'explanation': 'If enabled, strategy rechecks entry conditions every N minutes before entering (prevents false signals)'
                },
                
                # ENTRY CONDITIONS - How trades are triggered
                'entry_conditions': {
                    'require_all_blocks': getattr(strategy_config_obj, 'require_all_blocks', True),
                    'require_all_signals': getattr(strategy_config_obj, 'require_all_signals', True),
                    'explanation': 'If require_all_blocks=True, ALL blocks must trigger. If False, ANY block triggers entry.'
                },
                
                # EXIT CONDITIONS - How trades are closed
                'exit_conditions': {
                    'use_opposite_signal': getattr(strategy_config_obj, 'use_opposite_signal', False),
                    'use_time_exit': getattr(strategy_config_obj, 'use_time_exit', False),
                    'time_exit_hours': getattr(strategy_config_obj, 'time_exit_hours', None),
                    'explanation': 'Exit on opposite signal (reversal) or time-based exit after N hours'
                }
            }
            
            # Extract ONLY useful additional attributes (filter out internal metadata)
            # EXCLUDE internal system state that doesn't help AI understand strategy
            excluded_attrs = [
                'name', 'strategy_type', 'blocks', 'session', 'start_time', 'end_time',
                'timezone', 'recheck_enabled', 'recheck_interval', 'max_rechecks',
                'require_all_blocks', 'require_all_signals', 'use_opposite_signal',
                'use_time_exit', 'time_exit_hours',
                # Internal metadata - confuses AI
                'description', 'generation_status', 'validation_status', 'required_signals',
                'created_at', 'modified_at', 'version', 'id', 'uuid'
            ]
            
            # Collect strategy-level parameters (only add if they exist)
            strategy_params = {}
            for attr_name in dir(strategy_config_obj):
                if not attr_name.startswith('_') and not callable(getattr(strategy_config_obj, attr_name)):
                    if attr_name not in excluded_attrs:
                        try:
                            value = getattr(strategy_config_obj, attr_name, None)
                            # Only include non-None, non-empty values
                            if value is not None and value != '':
                                strategy_params[attr_name] = value
                        except:
                            pass  # Skip problematic attributes
            
            # Only add parameters dict if it has content
            if strategy_params:
                config_dict['parameters'] = strategy_params
            
            # Extract blocks with ENRICHED metadata from BlockRegistry
            if hasattr(strategy_config_obj, 'blocks'):
                registry = BlockRegistry()
                
                for block in strategy_config_obj.blocks:
                    block_name = getattr(block, 'name', '')
                    
                    # Get rich metadata from BlockRegistry
                    registry_block = registry.get_block(block_name)
                    
                    block_dict = {
                        'name': block_name,
                        'category': '',
                        'description': '',
                        'signals': [],
                        'logic': getattr(block, 'logic', 'AND')
                    }
                    
                    # Enrich from registry metadata (BlockMetadata is a dataclass)
                    if registry_block:
                        block_dict['category'] = registry_block.category
                        # Get description from registry, or generate basic one if empty
                        if registry_block.description:
                            block_dict['description'] = registry_block.description
                        else:
                            # Generate basic description from block name
                            block_dict['description'] = f"{block_name.replace('_', ' ').title()} detector"
                    
                    # Extract signals with ENRICHED details from registry's signal_tiers
                    # The Strategy Builder uses signal_tiers dict which contains descriptions
                    if hasattr(block, 'signals'):
                        for signal in block.signals:
                            signal_name = getattr(signal, 'name', '')
                            
                            # Start with minimal dict
                            signal_dict = {
                                'name': signal_name,
                                'description': ''
                            }
                            
                            # ENRICHED FROM REGISTRY: Get description from signal_tiers
                            if registry_block and hasattr(registry_block, 'signal_tiers'):
                                tier_info = registry_block.signal_tiers.get(signal_name, {})
                                
                                # Extract description from tier_info (like BlockRegistryAdapter does)
                                if 'description' in tier_info:
                                    signal_dict['description'] = tier_info['description']
                                else:
                                    # Generate from signal name if not found
                                    signal_dict['description'] = signal_name.replace('_', ' ').title()
                                
                                # Extract tier-specific parameters (only add if they exist)
                                tier_params = {}
                                for key, value in tier_info.items():
                                    if key not in ['description', 'points', 'base_points', 'formula']:
                                        tier_params[key] = value
                                
                                # Only add parameters dict if it has content
                                if tier_params:
                                    signal_dict['parameters'] = tier_params
                                
                                # Only add trigger_condition if it exists and is not empty
                                if 'trigger_condition' in tier_info and tier_info['trigger_condition']:
                                    signal_dict['trigger_condition'] = tier_info['trigger_condition']
                            
                            block_dict['signals'].append(signal_dict)
                    
                    # Extract block-level parameters (thresholds, periods, etc.)
                    # FILTER OUT internal metadata - keep only meaningful parameters
                    excluded_block_params = ['depends_on', 'indented', 'metadata', 'name', 'category', 'description', 'signals', 'logic']
                    
                    block_params = {}
                    for attr_name in dir(block):
                        if not attr_name.startswith('_') and not callable(getattr(block, attr_name)):
                            if attr_name not in excluded_block_params:
                                try:
                                    value = getattr(block, attr_name, None)
                                    # Only include non-None, non-empty values
                                    if value is not None and value != '':
                                        block_params[attr_name] = value
                                except:
                                    pass  # Skip any problematic attributes
                    
                    # Only add parameters dict if it has content
                    if block_params:
                        block_dict['parameters'] = block_params
                    
                    config_dict['blocks'].append(block_dict)
            
            return config_dict
            
        except Exception as e:
            logger.error(f"⚠️ Failed to convert strategy config: {str(e)}")
            import traceback
            traceback.print_exc()
            # Return minimal valid dict
            return {
                'name': 'Unknown Strategy',
                'strategy_type': 'LONG_SHORT',
                'blocks': [],
                'timing_constraints': {},
                'recheck_settings': {},
                'entry_conditions': {},
                'exit_conditions': {},
                'parameters': {}
            }
    
    def _initialize_recommendation_engine(self) -> None:
        """Initialize NEW intelligent recommendation engine (Sprint 1.6 with AI)"""
        try:
            # Create status callback to capture AI progress messages
            def ui_status_callback(message: str):
                # Print to console (could add UI display later)
                logger.info(f"[AI Engine] {message}")
            
            # Initialize NEW engine with status callback
            self.rec_engine = IntelligentRecommendationEngine(
                status_callback=ui_status_callback
            )
            logger.info("✅ NEW Intelligent Recommendation Engine initialized (with AI)")
        except Exception as e:
            logger.error(f"⚠️ Failed to initialize NEW recommendation engine: {str(e)}")
            import traceback
            traceback.print_exc()
            self.rec_engine = None
    
    def _get_current_strategy_config(self):
        """Get current strategy config from orchestrator"""
        try:
            # Access main window orchestrator
            main_window = self.window()
            if hasattr(main_window, 'orchestrator'):
                return main_window.orchestrator.get_current_config()
        except Exception as e:
            logger.warning(f"⚠️ Could not access strategy config: {str(e)}")
        return None
    
    def _is_intelligent_recommendation(self, rec_text: str) -> bool:
        """Check if recommendation is intelligent (from engine) vs generic"""
        # FIXED: AI recommendations contain "AI-ENHANCED:" prefix (not "Add '")
        return "AI-ENHANCED:" in rec_text or "🤖" in rec_text
    
    def _get_generic_recommendation(self, metric_key: str, value, rating: str) -> str:
        """Generate actionable recommendation text for performance metrics, including actual value."""
        try:
            val = float(value)
            
            if rating == '✓ Good':
                return ""  # No recommendation needed - performance is good
            elif rating == '⚠ Fair':
                if metric_key == 'total_pnl':
                    return f"Positive (${val:,.2f}) but could be improved - optimize entry/exit rules"
                elif metric_key == 'total_return':
                    return f"Matches market ({val:.2f}%) - consider improving R:R ratio"
                elif metric_key == 'sharpe_ratio':
                    return f"Acceptable ({val:.3f}) - reduce volatility or improve consistency"
                elif metric_key == 'win_rate':
                    return f"Average ({val:.1f}%) - balance with higher R:R ratio"
                elif metric_key == 'profit_factor':
                    return f"Profitable but marginal ({val:.3f}) - tighten entry criteria"
                elif metric_key == 'avg_trade_pnl':
                    return f"Positive (${val:,.2f}/trade) - increase position size cautiously"
                else:
                    return f"Monitor performance ({val}) - room for improvement"
            elif rating == '✗ Poor':
                if metric_key == 'total_pnl':
                    return f"Strategy losing money (${val:,.2f}) - review all parameters urgently"
                elif metric_key == 'total_return':
                    return f"Underperforming ({val:.2f}%) - consider alternative strategies"
                elif metric_key == 'sharpe_ratio':
                    return f"Poor risk-adjusted returns ({val:.3f}) - improve or abandon strategy"
                elif metric_key == 'win_rate':
                    if val < 50.0:
                        return f"Low win rate ({val:.1f}%) - need R:R >=2.0 to be profitable"
                    else:
                        return f"Win rate {val:.1f}% - review entry/exit criteria"
                elif metric_key == 'profit_factor':
                    return f"Unprofitable (PF={val:.3f}) - stop trading this strategy"
                elif metric_key == 'total_trades':
                    return f"Insufficient sample ({int(val)} trades) - collect more data before concluding"
                elif metric_key == 'avg_trade_pnl':
                    return f"Losing per trade (${val:,.2f}) - stop and review strategy completely"
                else:
                    return f"Needs attention (value={val}) - review parameters"
            else:
                return "Awaiting more data..."
        except:
            return "Awaiting more data..."
    
    def _get_risk_recommendation_generic(self, metric_key: str, value, status: str) -> str:
        """Generate actionable recommendation text for risk metrics"""
        try:
            val = float(value)
            
            if status == '✓ Good':
                return ""  # No recommendation needed - risk is well-managed
            elif status == '⚠ Monitor':
                if metric_key == 'max_drawdown_pct':
                    return "Drawdown elevated - consider reducing position size"
                elif metric_key == 'max_drawdown_duration':
                    return "Recovery taking time - review strategy resilience"
                elif metric_key == 'var_95':
                    return "Tail risk increasing - tighten stop losses"
                elif metric_key == 'expected_shortfall':
                  return "Worst-case losses growing - review risk limits"
                elif metric_key == 'sortino_ratio':
                    return "Downside volatility high - improve stop loss strategy"
                elif metric_key == 'calmar_ratio':
                    return "Returns not justifying drawdowns - optimize exits"
                elif metric_key == 'max_consecutive_losses':
                    return "Losing streaks lengthening - review entry criteria"
                elif metric_key == 'std_deviation':
                    return "Volatility rising - consider position sizing adjustment"
                elif metric_key == 'ulcer_index':
                    return "Drawdown stress increasing - improve risk management"
                else:
                    return "Monitor closely - risk increasing"
            elif status == '✗ High' or status == '✗ Poor':
                if metric_key == 'max_drawdown_pct':
                    return "CRITICAL: Reduce position size immediately - risk of ruin"
                elif metric_key == 'max_drawdown_duration':
                    return "CONCERN: Recovery too slow - consider strategy change"
                elif metric_key == 'var_95':
                    return "HIGH RISK: Tail losses excessive - tighten all stops"
                elif metric_key == 'expected_shortfall':
                    return "DANGER: Catastrophic loss potential - reduce exposure"
                elif metric_key == 'sortino_ratio':
                    return "POOR: Downside risk not managed - overhaul strategy"
                elif metric_key == 'calmar_ratio':
                    return "POOR: Drawdowns too large for returns - abandon strategy"
                elif metric_key == 'max_consecutive_losses':
                    return "WARNING: Losing streaks too long - halt trading and review"
                elif metric_key == 'std_deviation':
                    return "HIGH: Excessive volatility - reduce positions significantly"
                elif metric_key == 'ulcer_index':
                    return "SEVERE: Unacceptable drawdown stress - stop trading"
                else:
                    return "HIGH RISK: Take immediate corrective action"
            else:
                return "Awaiting more data..."
        except:
            return "Awaiting more data..."
    
    def get_metrics(self) -> Dict:
        """Get current metrics"""
        return self.current_metrics.copy()
    
    def _copy_all_metrics(self) -> None:
        """Copy all metrics to clipboard in tab-delimited format"""
        try:
            # Build tab-delimited text
            lines = []
            
            # Performance Metrics
            lines.append("PERFORMANCE METRICS")
            lines.append("Metric\tValue\tRating\tRecommendation")
            for row in range(self.perf_table.rowCount()):
                metric = self.perf_table.item(row, 0).text() if self.perf_table.item(row, 0) else ""
                value = self.perf_table.item(row, 1).text() if self.perf_table.item(row, 1) else ""
                rating = self.perf_table.item(row, 2).text() if self.perf_table.item(row, 2) else ""
                rec = self.perf_table.item(row, 3).text() if self.perf_table.item(row, 3) else ""
                lines.append(f"{metric}\t{value}\t{rating}\t{rec}")
            
            lines.append("")  # Blank line
            
            # Risk Metrics
            lines.append("RISK METRICS")
            lines.append("Metric\tValue\tStatus\tRecommendation")
            for row in range(self.risk_table.rowCount()):
                metric = self.risk_table.item(row, 0).text() if self.risk_table.item(row, 0) else ""
                value = self.risk_table.item(row, 1).text() if self.risk_table.item(row, 1) else ""
                status = self.risk_table.item(row, 2).text() if self.risk_table.item(row, 2) else ""
                rec = self.risk_table.item(row, 3).text() if self.risk_table.item(row, 3) else ""
                lines.append(f"{metric}\t{value}\t{status}\t{rec}")
            
            # Copy to clipboard
            clipboard_text = "\n".join(lines)
            QApplication.clipboard().setText(clipboard_text)
            
            logger.info(f"✅ Copied all metrics ({len(lines)} lines) to clipboard")
            self.status_label.setText("Status: <b>All metrics copied to clipboard</b>")
            
        except Exception as e:
            logger.error(f"❌ Copy failed: {str(e)}")
            self.status_label.setText(f"Status: <b>Copy failed: {str(e)}</b>")
    
    def _copy_selected_metrics(self) -> None:
        """Copy selected rows to clipboard in tab-delimited format"""
        try:
            lines = []
            
            # Get selected rows from performance table
            perf_selected_rows = set()
            for index in self.perf_table.selectedIndexes():
                perf_selected_rows.add(index.row())
            
            if perf_selected_rows:
                lines.append("PERFORMANCE METRICS")
                lines.append("Metric\tValue\tRating\tRecommendation")
                for row in sorted(perf_selected_rows):
                    metric = self.perf_table.item(row, 0).text() if self.perf_table.item(row, 0) else ""
                    value = self.perf_table.item(row, 1).text() if self.perf_table.item(row, 1) else ""
                    rating = self.perf_table.item(row, 2).text() if self.perf_table.item(row, 2) else ""
                    rec = self.perf_table.item(row, 3).text() if self.perf_table.item(row, 3) else ""
                    lines.append(f"{metric}\t{value}\t{rating}\t{rec}")
                lines.append("")  # Blank line
            
            # Get selected rows from risk table
            risk_selected_rows = set()
            for index in self.risk_table.selectedIndexes():
                risk_selected_rows.add(index.row())
            
            if risk_selected_rows:
                lines.append("RISK METRICS")
                lines.append("Metric\tValue\tStatus\tRecommendation")
                for row in sorted(risk_selected_rows):
                    metric = self.risk_table.item(row, 0).text() if self.risk_table.item(row, 0) else ""
                    value = self.risk_table.item(row, 1).text() if self.risk_table.item(row, 1) else ""
                    status = self.risk_table.item(row, 2).text() if self.risk_table.item(row, 2) else ""
                    rec = self.risk_table.item(row, 3).text() if self.risk_table.item(row, 3) else ""
                    lines.append(f"{metric}\t{value}\t{status}\t{rec}")
            
            if not lines:
                logger.warning("⚠️ No rows selected")
                self.status_label.setText("Status: <b>No rows selected</b>")
                return
            
            # Copy to clipboard
            clipboard_text = "\n".join(lines)
            QApplication.clipboard().setText(clipboard_text)
            
            total_selected = len(perf_selected_rows) + len(risk_selected_rows)
            logger.info(f"✅ Copied {total_selected} selected rows to clipboard")
            self.status_label.setText(f"Status: <b>{total_selected} selected rows copied to clipboard</b>")
            
        except Exception as e:
            logger.error(f"❌ Copy failed: {str(e)}")
            self.status_label.setText(f"Status: <b>Copy failed: {str(e)}</b>")
    
    def _select_all_recommendations(self) -> None:
        """Select all recommendation checkboxes"""
        # Select all performance metrics (checkbox is column 4)
        for row in range(self.perf_table.rowCount()):
            checkbox_widget = self.perf_table.cellWidget(row, 4)
            if checkbox_widget:
                checkbox = checkbox_widget.findChild(QCheckBox)
                if checkbox and checkbox.isEnabled():  # Only check if enabled
                    checkbox.setChecked(True)
        
        # Select all risk metrics (checkbox is column 4)
        for row in range(self.risk_table.rowCount()):
            checkbox_widget = self.risk_table.cellWidget(row, 4)
            if checkbox_widget:
                checkbox = checkbox_widget.findChild(QCheckBox)
                if checkbox and checkbox.isEnabled():  # Only check if enabled
                    checkbox.setChecked(True)
        
        # Update apply button
        self._update_apply_button()
    
    def _clear_all_recommendations(self) -> None:
        """Clear all recommendation checkboxes"""
        # Clear all performance metrics (checkbox is column 4)
        for row in range(self.perf_table.rowCount()):
            checkbox_widget = self.perf_table.cellWidget(row, 4)
            if checkbox_widget:
                checkbox = checkbox_widget.findChild(QCheckBox)
                if checkbox:
                    checkbox.setChecked(False)
        
        # Clear all risk metrics (checkbox is column 4)
        for row in range(self.risk_table.rowCount()):
            checkbox_widget = self.risk_table.cellWidget(row, 4)
            if checkbox_widget:
                checkbox = checkbox_widget.findChild(QCheckBox)
                if checkbox:
                    checkbox.setChecked(False)
        
        # Update apply button
        self._update_apply_button()
    
    def _on_checkbox_changed(self, state) -> None:
        """Handle checkbox state change"""
        # Called when any checkbox changes state
        self._update_apply_button()
    
    def _update_apply_button(self) -> None:
        """Update apply button text and enabled state based on selections"""
        # Count selected checkboxes (checkbox is column 4)
        selected_count = 0
        
        # Count performance metrics
        for row in range(self.perf_table.rowCount()):
            checkbox_widget = self.perf_table.cellWidget(row, 4)
            if checkbox_widget:
                checkbox = checkbox_widget.findChild(QCheckBox)
                if checkbox and checkbox.isChecked():
                    selected_count += 1
        
        # Count risk metrics
        for row in range(self.risk_table.rowCount()):
            checkbox_widget = self.risk_table.cellWidget(row, 4)
            if checkbox_widget:
                checkbox = checkbox_widget.findChild(QCheckBox)
                if checkbox and checkbox.isChecked():
                    selected_count += 1
        
        # Update button (show count when >0)
        if selected_count > 0:
            self.apply_btn.setText(f"💡 Apply Recommendation(s) ({selected_count})")
        else:
            self.apply_btn.setText("💡 Apply Recommendation(s)")
        self.apply_btn.setEnabled(selected_count > 0)
    
    def _apply_selected_recommendations(self) -> None:
        """
        Apply selected recommendations to strategy configuration.

        End-to-end flow (Sprint 1.9.3):
        1. Read selected recommendation checkboxes from UI.
        2. Delegate each recommendation to the orchestrator (preferred) OR use the
           engine's apply_recommendations() as a config-dict fallback.
        3. Show per-recommendation confirmation / error feedback.
        4. Trigger re-evaluation (auto-retest) when the toggle is active.
        """
        # 1. Collect selected recommendations with cached objects
        selected_recs = []
        
        # Collect from performance metrics (checkbox is column 4)
        for row in range(self.perf_table.rowCount()):
            checkbox_widget = self.perf_table.cellWidget(row, 4)
            if checkbox_widget:
                checkbox = checkbox_widget.findChild(QCheckBox)
                if checkbox and checkbox.isChecked():
                    rec = self.recommendation_cache.get(f"perf_{row}")
                    if rec:
                        selected_recs.append(rec)
        
        # Collect from risk metrics (checkbox is column 4)
        for row in range(self.risk_table.rowCount()):
            checkbox_widget = self.risk_table.cellWidget(row, 4)
            if checkbox_widget:
                checkbox = checkbox_widget.findChild(QCheckBox)
                if checkbox and checkbox.isChecked():
                    rec = self.recommendation_cache.get(f"risk_{row}")
                    if rec:
                        selected_recs.append(rec)
        
        if not selected_recs:
            return

        # 2. Try engine-level batch apply when an orchestrator config dict is available
        #    but the orchestrator doesn't own the mutation directly.  When the orchestrator
        #    DOES own the mutation (add_building_block / update_parameter etc.) we still
        #    delegate to it below via _apply_single_recommendation() so Strategy Builder UI
        #    stays consistent.  The engine path is a reliable fallback for testing and for
        #    cases where the orchestrator surface is not fully wired yet.
        engine_fallback_used = False
        orchestrator = self._get_orchestrator()
        if self.rec_engine is not None and orchestrator is not None:
            strategy_config_obj = self._get_current_strategy_config()
            if strategy_config_obj is not None:
                # Build mutable config dict snapshot for engine apply
                config_snapshot = self._convert_strategy_config_to_dict(strategy_config_obj)
                engine_result = self.rec_engine.apply_recommendations(
                    config_snapshot, selected_recs
                )
                if engine_result["applied"]:
                    logger.info(
                        f"[Apply] Engine pre-apply OK: {len(engine_result['applied'])} mutations"
                        f" | skipped={len(engine_result['skipped'])}"
                        f" | failed={len(engine_result['failed'])}"
                    )
                    engine_fallback_used = True
        
        # Build version description for Git commit
        block_names = [rec.block_name for rec in selected_recs if rec.type == 'ADD_BLOCK']
        param_names = [rec.parameter_name for rec in selected_recs if rec.type == 'ADJUST_PARAM']
        
        description_parts = []
        if block_names:
            description_parts.append(f"blocks={', '.join(b for b in block_names if b)}")
        if param_names:
            description_parts.append(f"params={', '.join(p for p in param_names if p)}")
        
        version_message = "Applied recommendations: " + (" | ".join(description_parts) if description_parts else "multiple changes")
        
        # 3. Apply each recommendation via orchestrator (preferred path)
        applied_count = 0
        failed_count = 0
        applied_blocks = []
        applied_params = []
        
        for rec in selected_recs:
            if self._apply_single_recommendation(rec):
                applied_count += 1
                if rec.type == 'ADD_BLOCK':
                    applied_blocks.append(rec.block_name)
                elif rec.type == 'ADJUST_PARAM':
                    applied_params.append(rec.parameter_name)
            else:
                failed_count += 1
        
        # Save configuration version (Git commit) - Sprint 1.6 Task 1.6.8
        if applied_count > 0:
            orchestrator = self._get_orchestrator()
            if orchestrator and hasattr(orchestrator, 'save_config_version'):
                orchestrator.save_config_version(version_message)
        
        # Refresh Strategy Builder UI
        if applied_count > 0:
            self._refresh_strategy_builder_ui()
        
        # 3a. Show confirmation / error feedback dialog
        self._show_apply_feedback(
            applied_count=applied_count,
            failed_count=failed_count,
            total_count=len(selected_recs),
            applied_blocks=applied_blocks,
            applied_params=applied_params,
        )
        
        # Update status label
        status_text = f"Status: <b>{applied_count}/{len(selected_recs)} recommendations applied</b>"
        if failed_count:
            status_text += f" | <span style='color:red'>{failed_count} failed</span>"
        if applied_blocks:
            status_text += f" | Blocks: {', '.join(applied_blocks)}"
        if applied_params:
            status_text += f" | Params: {', '.join(applied_params)}"
        self.status_label.setText(status_text)
        
        # 4. Trigger re-evaluation (auto-retest) when toggle is active
        if applied_count > 0 and self.auto_retest_check.isChecked():
            logger.info("[Apply] Auto-retest toggled — triggering strategy re-evaluation...")
            self._trigger_retest()
    
    def _show_apply_feedback(
        self,
        applied_count: int,
        failed_count: int,
        total_count: int,
        applied_blocks: List[str],
        applied_params: List[str],
    ) -> None:
        """
        Show confirmation or error feedback after applying recommendations.

        Args:
            applied_count: Number of successfully applied recommendations.
            failed_count: Number of failed recommendations.
            total_count: Total number of selected recommendations.
            applied_blocks: Names of newly-added building blocks.
            applied_params: Names of adjusted parameters.
        """
        from PyQt5.QtWidgets import QMessageBox

        if applied_count == 0 and failed_count == 0:
            return  # Nothing to report

        if applied_count > 0 and failed_count == 0:
            # All succeeded
            detail_parts = []
            if applied_blocks:
                detail_parts.append(f"Blocks added: {', '.join(b for b in applied_blocks if b)}")
            if applied_params:
                detail_parts.append(f"Parameters updated: {', '.join(p for p in applied_params if p)}")
            detail_text = "\n".join(detail_parts) if detail_parts else ""

            QMessageBox.information(
                self,
                "Recommendations Applied",
                f"Successfully applied {applied_count} recommendation(s).\n\n"
                f"{detail_text}\n\n"
                f"Strategy configuration updated. Use Auto-Retest to evaluate the changes."
            )
        elif applied_count > 0 and failed_count > 0:
            # Partial success
            QMessageBox.warning(
                self,
                "Partial Apply",
                f"{applied_count} of {total_count} recommendation(s) applied successfully.\n"
                f"{failed_count} recommendation(s) could not be applied.\n\n"
                f"Check the application log for details on failed recommendations."
            )
        else:
            # All failed
            QMessageBox.critical(
                self,
                "Apply Failed",
                f"None of the {total_count} recommendation(s) could be applied.\n\n"
                f"The strategy remains unchanged.\n"
                f"Ensure the Strategy Builder is connected and the configuration is loaded."
            )
    
    def _apply_single_recommendation(self, rec: IntegratedRecommendation) -> bool:
        """
        Apply a single recommendation
        
        Args:
            rec: IntegratedRecommendation object
        
        Returns:
            True if successfully applied, False otherwise
        """
        try:
            if rec.type == 'ADD_BLOCK':
                # Add building block to strategy
                success = self._add_building_block(rec.block_name)
                if success:
                    logger.info(f"✅ Added building block: {rec.block_name}")
                return success
                
            elif rec.type == 'ADJUST_PARAM':
                # Modify parameter (SL, TP, position size, etc.)
                new_value = rec.configuration.get('new_value') if rec.configuration else None
                success = self._adjust_parameter(rec.parameter_name or 'unknown', new_value)
                if success:
                    logger.info(f"✅ Adjusted {rec.parameter_name}: {new_value}")
                return success
            
            elif rec.type == 'ADD_RECHECK':
                # Add recheck validation to an existing block's signal
                block_name = rec.block_name
                signal_name = rec.signal_name
                config = rec.configuration or {}
                success = self._add_recheck_config(block_name, signal_name, config)
                if success:
                    logger.info(f"✅ Added recheck to {block_name}::{signal_name}: {config}")
                return success

            elif rec.type == 'ADD_TIMING':
                # Set max_candles dependency between two signals
                config = rec.configuration or {}
                success = self._add_timing_config(rec.block_name, config)
                if success:
                    logger.info(f"✅ Added timing constraint to {rec.block_name}: {config}")
                return success

            else:
                logger.warning(f"⚠️ Unknown recommendation type '{rec.type}' — skipping")
                return False
            
        except Exception as e:
            logger.error(f"❌ Failed to apply recommendation: {str(e)}")
            return False
    
    def _add_building_block(self, block_name: str) -> bool:
        """
        Add building block to current strategy
        
        Args:
            block_name: Registry name of block to add
        
        Returns:
            True if successful, False otherwise
        """
        try:
            # Access orchestrator
            orchestrator = self._get_orchestrator()
            if not orchestrator:
                logger.warning("⚠️ Orchestrator not available")
                return False
            
            # Add block via orchestrator
            if hasattr(orchestrator, 'add_building_block'):
                return orchestrator.add_building_block(block_name)
            else:
                logger.warning("⚠️ Orchestrator does not support add_building_block method")
                return False
                
        except Exception as e:
            logger.error(f"❌ Failed to add block {block_name}: {str(e)}")
            return False
    
    def _adjust_parameter(self, param_name: str, new_value) -> bool:
        """
        Adjust strategy parameter
        
        Args:
            param_name: Parameter to adjust
            new_value: New parameter value
        
        Returns:
            True if successful, False otherwise
        """
        try:
            orchestrator = self._get_orchestrator()
            if not orchestrator:
                return False
            
            # Adjust parameter via orchestrator
            if hasattr(orchestrator, 'update_parameter'):
                return orchestrator.update_parameter(param_name, new_value)
            else:
                logger.warning("⚠️ Orchestrator does not support update_parameter method")
                return False
                
        except Exception as e:
            logger.error(f"❌ Failed to adjust {param_name}: {str(e)}")
            return False

    def _add_recheck_config(self, block_name: str, signal_name: str, config: dict) -> bool:
        """
        Add recheck validation config to an existing block's signal.

        ADD_RECHECK adds a delayed revalidation of the signal N bars later to filter
        false positives without adding a new block (frequency-preserving).

        Args:
            block_name: Name of the building block
            signal_name: Name of the signal to add recheck to
            config: Configuration dict, e.g. {"bar_delay": 25, "validation_mode": "SIGNAL"}

        Returns:
            True if successful, False otherwise
        """
        try:
            orchestrator = self._get_orchestrator()
            if not orchestrator:
                logger.warning("⚠️ Orchestrator not available for ADD_RECHECK")
                return False

            if hasattr(orchestrator, 'add_recheck_config'):
                return orchestrator.add_recheck_config(block_name, signal_name, config)
            else:
                # Graceful fallback: use update_parameter if orchestrator does not support recheck
                logger.warning(
                    f"⚠️ Orchestrator does not support add_recheck_config — "
                    f"cannot apply ADD_RECHECK for {block_name}::{signal_name}"
                )
                return False

        except Exception as e:
            logger.error(f"❌ Failed to add recheck config for {block_name}::{signal_name}: {str(e)}")
            return False

    def _add_timing_config(self, block_name: str, config: dict) -> bool:
        """
        Set a max_candles timing dependency on a block's signals.

        ADD_TIMING sets a temporal constraint — signal B must occur within N candles
        after signal A.

        Args:
            block_name: Name of the building block
            config: Configuration dict, e.g. {"max_candles": 10}

        Returns:
            True if successful, False otherwise
        """
        try:
            orchestrator = self._get_orchestrator()
            if not orchestrator:
                logger.warning("⚠️ Orchestrator not available for ADD_TIMING")
                return False

            if hasattr(orchestrator, 'add_timing_config'):
                return orchestrator.add_timing_config(block_name, config)
            else:
                # Graceful fallback: log clearly; do not crash
                logger.warning(
                    f"⚠️ Orchestrator does not support add_timing_config — "
                    f"cannot apply ADD_TIMING for {block_name}"
                )
                return False

        except Exception as e:
            logger.error(f"❌ Failed to add timing config for {block_name}: {str(e)}")
            return False

    def _get_orchestrator(self):
        """Get orchestrator from main window"""
        try:
            main_window = self.window()
            if hasattr(main_window, 'orchestrator'):
                return main_window.orchestrator
        except:
            pass
        return None
    
    def _find_main_window(self):
        """
        Locate StrategyBuilderMainWindow from within an embedded panel.

        MetricsDisplayPanel lives inside BacktestConfigPanel → BacktestConfigDialog.
        BacktestConfigDialog is parented to StrategyBuilderMainWindow, so
        self.window() returns the dialog, not the main window.  We must walk up
        one more level.  QApplication.activeWindow() is the last-resort fallback.
        """
        # Walk the Qt parent chain looking for a widget that owns blocks_panel
        widget = self
        while widget is not None:
            if hasattr(widget, 'blocks_panel'):
                return widget
            widget = widget.parent()

        # Fallback: check the active top-level window
        active = QApplication.activeWindow()
        if active and hasattr(active, 'blocks_panel'):
            return active

        # Fallback: scan all top-level widgets
        for top in QApplication.topLevelWidgets():
            if hasattr(top, 'blocks_panel'):
                return top

        return None

    def _refresh_strategy_builder_ui(self) -> None:
        """
        Refresh Strategy Builder UI after applying recommendations.

        Forces the Strategy Blocks Panel to reload and display the updated
        configuration.  Uses refresh_from_orchestrator() which is the canonical
        public API on StrategyBlocksPanel.
        """
        try:
            main_window = self._find_main_window()

            if main_window is None:
                logger.warning("⚠️ StrategyBuilderMainWindow not found — skipping UI refresh")
                return

            blocks_panel = main_window.blocks_panel
            if blocks_panel is None:
                logger.warning("⚠️ blocks_panel is None — skipping UI refresh")
                return

            # Primary: canonical public refresh method
            if hasattr(blocks_panel, 'refresh_from_orchestrator'):
                blocks_panel.refresh_from_orchestrator()
                logger.info("🔄 Strategy Builder Building Blocks refreshed via refresh_from_orchestrator()")
            else:
                logger.warning("⚠️ Strategy Blocks Panel missing refresh_from_orchestrator — forcing repaint")
                blocks_panel.update()
                blocks_panel.repaint()

        except Exception as e:
            logger.error(f"❌ UI refresh failed: {str(e)}")
    
    def _trigger_retest(self) -> None:
        """Trigger automatic backtest retest after applying recommendations"""
        try:
            # Access backtest config panel
            main_window = self.window()
            if hasattr(main_window, 'backtest_config_panel'):
                config_panel = main_window.backtest_config_panel
                
                # Trigger backtest run
                if hasattr(config_panel, '_on_run_clicked'):
                    config_panel._on_run_clicked()
                    logger.info("🔄 Auto-retest triggered - backtest started")
                else:
                    logger.warning("⚠️ Backtest panel does not support _on_run_clicked method")
            else:
                logger.warning("⚠️ Backtest panel not accessible for auto-retest")
                
        except Exception as e:
            logger.error(f"❌ Auto-retest failed: {str(e)}")
    
    def _show_ai_request_preview(self) -> None:
        """
        Show AI Request Preview Window (NEW FLOW - Sprint 1.6)
        
        Backtest completes → Preview window → User approves → AI request sent
        
        This replaces automatic AI generation with user-gated preview.
        """
        try:
            logger.info("[UI] Building comprehensive AI request...")
            logger.debug(f"[DEBUG] full_backtest_results type: {type(self.full_backtest_results)}")
            if self.full_backtest_results:
                logger.debug(f"[DEBUG] full_backtest_results keys: {self.full_backtest_results.keys()}")
            
            # Build comprehensive request using builder
            request_builder = ComprehensiveAIRequestBuilder()
            
            # Get strategy config
            strategy_config_obj = self._get_current_strategy_config()
            if not strategy_config_obj:
                logger.warning("⚠️ No strategy config - cannot build AI request")
                return
            
            strategy_config_dict = self._convert_strategy_config_to_dict(strategy_config_obj)
            logger.debug(f"[DEBUG] Strategy config blocks: {len(strategy_config_dict.get('blocks', []))}")
            
            # Get backtest config - TRY MULTIPLE SOURCES + BUILD MANUALLY IF NEEDED
            backtest_config = {}
            
            # Source 1: From full_backtest_results
            if self.full_backtest_results and 'config' in self.full_backtest_results:
                backtest_config = self.full_backtest_results['config']
                logger.debug(f"[DEBUG] Got backtest config from full_backtest_results: {len(backtest_config)} keys")
            
            # Source 2: Try to get from orchestrator's last backtest
            if not backtest_config:
                orchestrator = self._get_orchestrator()
                if orchestrator and hasattr(orchestrator, 'get_backtest_config'):
                    backtest_config = orchestrator.get_backtest_config()
                    logger.debug(f"[DEBUG] Got backtest config from orchestrator: {len(backtest_config)} keys")
                elif orchestrator and hasattr(orchestrator, 'last_backtest_config'):
                    backtest_config = orchestrator.last_backtest_config
                    logger.debug(f"[DEBUG] Got backtest config from orchestrator.last_backtest_config")
            
            # Source 3: BUILD MANUALLY from main window components (FALLBACK)
            if not backtest_config:
                logger.debug("[DEBUG] No backtest config from orchestrator - building manually...")
                backtest_config = self._build_backtest_config_manually()
                if backtest_config:
                    logger.debug(f"[DEBUG] Built backtest config manually: {len(backtest_config)} keys")
            
            # Get trades - TRY MULTIPLE SOURCES
            trades = []
            
            # Source 1: From full_backtest_results
            if self.full_backtest_results and 'trades' in self.full_backtest_results:
                trades = self.full_backtest_results['trades']
                logger.debug(f"[DEBUG] Got {len(trades)} trades from full_backtest_results")
            
            # Source 2: From TradesPanel (CRITICAL - this is where trades are actually stored!)
            if not trades:
                dialog = self.window()
                if hasattr(dialog, 'backtest_panel'):
                    backtest_panel = dialog.backtest_panel
                    if hasattr(backtest_panel, 'trades_panel'):
                        trades_panel = backtest_panel.trades_panel
                        if hasattr(trades_panel, 'get_trades'):
                            trades = trades_panel.get_trades()
                            logger.debug(f"[DEBUG] Got {len(trades)} trades from TradesPanel.get_trades()")
            
            # Source 3: Try orchestrator's last backtest
            if not trades:
                orchestrator = self._get_orchestrator()
                if orchestrator and hasattr(orchestrator, 'get_last_trades'):
                    trades = orchestrator.get_last_trades()
                    logger.debug(f"[DEBUG] Got {len(trades)} trades from orchestrator.get_last_trades()")
                elif orchestrator and hasattr(orchestrator, 'last_backtest_trades'):
                    trades = orchestrator.last_backtest_trades
                    logger.debug(f"[DEBUG] Got {len(trades)} trades from orchestrator.last_backtest_trades")
            
            logger.debug(f"[DEBUG] Final data: strategy_blocks={len(strategy_config_dict.get('blocks', []))}, backtest_config={len(backtest_config)}, trades={len(trades)}, metrics={len(self.current_metrics)}")
            
            # Get available blocks with signals properly extracted
            # ComprehensiveAIRequestBuilder already imported at top of file (line 51)
            builder = ComprehensiveAIRequestBuilder()
            _strategy_type = strategy_config_dict.get("strategy_type", "")
            _strategy_direction = (
                "BEARISH" if "bearish" in _strategy_type.lower()
                else "BULLISH" if "bullish" in _strategy_type.lower()
                else None
            )
            _current_block_names = set(
                b.get("name", "") for b in strategy_config_dict.get("blocks", [])
            )
            available_blocks = builder._extract_available_blocks(
                strategy_direction=_strategy_direction,
                current_block_names=_current_block_names,
            )
            
            # Create preview window
            preview_window = AIRequestPreviewWindow(self)
            
            # Populate with data
            preview_window.populate_preview(
                strategy_config=strategy_config_dict,
                backtest_config=backtest_config,
                trades=trades,
                metrics=self.current_metrics,
                available_blocks=available_blocks
            )
            
            # Wire "Approve & Send" to actual AI generation
            preview_window.send_approved.connect(self._on_ai_request_approved)
            
            # Show window (modal - blocks until closed)
            preview_window.show()
            logger.info("[UI] ✓ AI Request Preview window opened")
            
        except Exception as e:
            logger.error(f"❌ Failed to show AI request preview: {str(e)}")
            import traceback
            traceback.print_exc()
    
    def _build_backtest_config_manually(self) -> Dict:
        """
        Build backtest config by reading ACTUAL RUNTIME VALUES from BacktestConfigPanel UI fields.
        
        NAUTILUS EXPERT: NO HARDCODED VALUES - reads directly from UI spinboxes, combos, checkboxes
        at the moment this method is called. Includes institutional descriptions for AI context.
        
        CRITICAL FIX: MetricsDisplayPanel IS INSIDE BacktestConfigDialog, so we access parent directly!
        
        Returns:
            Dictionary with complete backtest configuration and AI-friendly explanations
        """
        config = {}
        
        try:
            # ULTIMATE FIX: Search for BacktestConfigPanel in ALL widgets
            # The widget hierarchy is complex, so we find it by type instead
            
            dialog = self.window()
            logger.debug(f"[DEBUG] Our window: {type(dialog).__name__}")
            
            # Search all children for BacktestConfigPanel by checking for lookback_spin
            panel = None
            for child in dialog.findChildren(QWidget):
                if hasattr(child, 'lookback_spin') and hasattr(child, 'capital_spin'):
                    panel = child
                    logger.debug(f"[DEBUG] Found BacktestConfigPanel: {type(panel).__name__}")
                    break
            
            if not panel:
                logger.warning("[DEBUG] Could not find BacktestConfigPanel in widget tree")
                # Try backup: check if dialog itself is the panel
                if hasattr(dialog, 'lookback_spin'):
                    panel = dialog
                    logger.debug("[DEBUG] Dialog itself has config fields")
                else:
                    logger.debug("[DEBUG] No config UI found")
                    return config
            
            # ===== READ RUNTIME VALUES FROM UI FIELDS =====
            
            # Basic Settings
            config['lookback_days'] = panel.lookback_spin.value()
            config['training_window'] = panel.training_spin.value()
            config['testing_window'] = panel.testing_spin.value()
            config['mode'] = 'Mode 1 (Historical)' if panel.mode1_radio.isChecked() else 'Mode 2 (Live Replay)'
            config['tpsl_method'] = panel.tpsl_combo.currentText()
            config['sl_adjustment'] = panel.sl_combo.currentText()
            
            # Adaptive SL Settings
            config['sl_delayed'] = panel.delayed_sl_check.isChecked()
            config['sl_delay_bars'] = panel.delay_spin.value()
            config['sl_emergency_pct'] = panel.emergency_spin.value()
            config['sl_vol_lookback'] = panel.vol_lookback_spin.value()
            config['sl_vol_multiplier'] = panel.vol_multi_spin.value() / 10.0  # Stored as 12 = 1.2x
            config['sl_min_pct'] = panel.min_sl_spin.value() / 10.0  # Stored as 7 = 0.7%
            config['sl_max_pct'] = panel.max_sl_spin.value() / 10.0  # Stored as 20 = 2.0%
            config['sl_use_structure'] = panel.structure_check.isChecked()
            
            # Risk/Reward Settings
            config['starting_capital'] = panel.capital_spin.value()
            config['currency'] = 'USD'
            config['min_risk_reward'] = panel.rr_spin.value() / 10.0  # Stored as 12 = 1.2:1
            config['risk_per_trade_pct'] = panel.risk_spin.value()
            config['max_leverage'] = panel.leverage_spin.value()
            config['confluence_required'] = panel.confluence_spin.value()
            config['max_bars_held'] = panel.max_bars_spin.value()
            
            # Active Preset
            if panel.conservative_radio.isChecked():
                config['sl_preset'] = 'Conservative'
            elif panel.balanced_radio.isChecked():
                config['sl_preset'] = 'Balanced'
            elif panel.aggressive_radio.isChecked():
                config['sl_preset'] = 'Aggressive'
            else:
                config['sl_preset'] = 'Custom'
            
            # ===== ADD INSTITUTIONAL DESCRIPTIONS FOR AI =====
            
            config['explanation'] = (
                f"BACKTEST CONFIGURATION (Read from UI at runtime)\n\n"
                f"=== TIMEFRAME ===\n"
                f"Lookback Period: {config['lookback_days']} days\n"
                f"  → Total historical data loaded for analysis\n"
                f"Training Window: {config['training_window']} days\n"
                f"  → Period for strategy calibration and pattern learning\n"
                f"Testing Window: {config['testing_window']} days\n"
                f"  → Out-of-sample validation period\n"
                f"Mode: {config['mode']}\n"
                f"  → Historical = fast batch processing | Live Replay = real-time simulation\n\n"
                
                f"=== CAPITAL & RISK ===\n"
                f"Starting Capital: ${config['starting_capital']:,} {config['currency']}\n"
                f"  → Initial account balance for position sizing\n"
                f"Risk per Trade: {config['risk_per_trade_pct']}% of capital\n"
                f"  → ${config['starting_capital'] * config['risk_per_trade_pct'] / 100:.2f} maximum risk per trade\n"
                f"Leverage: {config['max_leverage']}x\n"
                f"  → Maximum position size multiplier (higher = more risk)\n"
                f"Min Risk:Reward: {config['min_risk_reward']:.1f}:1\n"
                f"  → Minimum profit target vs risk for trade entry\n\n"
                
                f"=== ENTRY CONDITIONS ===\n"
                f"Confluence Required: {config['confluence_required']} points\n"
                f"  → Minimum signal strength for trade entry (strategy-specific)\n"
                f"Max Bars Held: {config['max_bars_held']} candles\n"
                f"  → Auto-exit after this duration to prevent stuck positions\n\n"
                
                f"=== TAKE PROFIT / STOP LOSS ===\n"
                f"TP/SL Method: {config['tpsl_method']}\n"
                f"  → How initial TP/SL levels are calculated at entry\n"
                f"  → Fibonacci = retracement levels | Hybrid = Fib + ATR | Fixed = percentage\n"
                f"SL Adjustment: {config['sl_adjustment']}\n"
                f"  → How SL behaves after entry\n"
                f"  → Adaptive v2.0 = dynamic adjustment | Static = fixed at entry\n\n"
                
                f"=== ADAPTIVE SL SETTINGS (Preset: {config['sl_preset']}) ===\n"
                f"Delayed Activation: {'Yes' if config['sl_delayed'] else 'No'}\n"
                f"  → Prevents immediate stop-outs from entry volatility\n"
                f"Delay Period: {config['sl_delay_bars']} bars\n"
                f"  → Wait {config['sl_delay_bars']} candles before activating normal SL\n"
                f"Emergency SL: {config['sl_emergency_pct']}%\n"
                f"  → Wide catastrophic protection during delay period\n"
                f"Volatility Lookback: {config['sl_vol_lookback']} bars\n"
                f"  → Candles used to measure market volatility (ATR)\n"
                f"Volatility Multiplier: {config['sl_vol_multiplier']:.1f}x\n"
                f"  → SL distance = ATR × {config['sl_vol_multiplier']:.1f}\n"
                f"Min SL Distance: {config['sl_min_pct']:.1f}%\n"
                f"  → Floor to prevent stops too tight to entry\n"
                f"Max SL Distance: {config['sl_max_pct']:.1f}%\n"
                f"  → Ceiling to cap risk per trade\n"
                f"Market Structure: {'Yes' if config['sl_use_structure'] else 'No'}\n"
                f"  → Place SL beyond key swing highs/lows vs percentage only\n\n"
                
                f"=== INTERPRETATION FOR AI ===\n"
                f"This configuration uses {config['sl_preset'].lower()} risk management:\n"
            )
            
            # Add preset-specific interpretation
            if config['sl_preset'] == 'Conservative':
                config['explanation'] += (
                    f"  → Wider stops ({config['sl_max_pct']:.1f}% max) for maximum protection\n"
                    f"  → Higher win rate expected (60-70%)\n"
                    f"  → Lower trade frequency (quality over quantity)\n"
                    f"  → Best for volatile markets and risk-averse trading\n"
                )
            elif config['sl_preset'] == 'Balanced':
                config['explanation'] += (
                    f"  → Balanced stops ({config['sl_max_pct']:.1f}% max) for optimal risk/reward\n"
                    f"  → Moderate win rate expected (50-60%)\n"
                    f"  → Moderate trade frequency\n"
                    f"  → Recommended for most market conditions\n"
                )
            elif config['sl_preset'] == 'Aggressive':
                config['explanation'] += (
                    f"  → Tighter stops ({config['sl_max_pct']:.1f}% max) for active trading\n"
                    f"  → Lower win rate acceptable (40-50%)\n"
                    f"  → Higher trade frequency (more opportunities)\n"
                    f"  → Best for momentum strategies and active traders\n"
                )
            else:
                config['explanation'] += (
                    f"  → User-customized stop loss parameters\n"
                    f"  → Fine-tuned for specific strategy requirements\n"
                )
            
            logger.debug(f"[DEBUG] ✅ Read {len(config)} backtest parameters from UI at runtime")
            return config
                
        except Exception as e:
            logger.error(f"[DEBUG] ❌ Failed to read backtest config from UI: {str(e)}")
            import traceback
            traceback.print_exc()
        
        return config
    
    def _on_ai_request_approved(self, request_data: Dict) -> None:
        """
        Handle user approval of AI request from preview window.

        NOW the actual AI generation happens (after user preview & approval).
        
        CRITICAL: Uses the EXACT data from preview (request_data parameter).
        This ensures what user reviewed is what AI receives.

        Args:
            request_data: Complete request data from preview window (EXACT preview data)
        """
        logger.info("=" * 80)
        logger.info("[AI REQUEST] ✅ _on_ai_request_approved() CALLED")
        logger.info(f"[AI REQUEST] Request data keys: {list(request_data.keys()) if request_data else 'None'}")
        logger.info(f"[AI REQUEST] Using EXACT preview data (no rebuild)")
        logger.info(f"[AI REQUEST] Trades in preview: {len(request_data.get('trades', []))}")
        logger.info(f"[AI REQUEST] Metrics in preview: {len(request_data.get('metrics', {}))}")
        logger.info("=" * 80)

        # CRITICAL FIX: Use the EXACT data from preview, don't rebuild
        # This ensures what the user approved is what the AI receives
        logger.info("[AI REQUEST] Calling _generate_batch_recommendations_with_preview_data()...")
        try:
            self._generate_batch_recommendations_with_preview_data(request_data)
            logger.info("[AI REQUEST] ✅ _generate_batch_recommendations() completed")
        except Exception as e:
            logger.error(f"[AI REQUEST] ❌ ERROR in _generate_batch_recommendations(): {e}")
            import traceback
            traceback.print_exc()
    
    def _generate_batch_recommendations_with_preview_data(self, preview_data: Dict) -> None:
        """
        Generate AI recommendations using EXACT data from preview window.
        
        CRITICAL: This ensures what the user approved in preview is what AI receives.
        NO rebuilding, NO re-gathering - uses preview_data AS-IS.
        
        Args:
            preview_data: Complete request data from preview window (strategy, backtest, trades, metrics)
        """
        logger.info("=" * 80)
        logger.info("[AI GEN PREVIEW] Using EXACT preview data for AI request")
        logger.info(f"[AI GEN PREVIEW] Preview data keys: {list(preview_data.keys())}")
        logger.info(f"[AI GEN PREVIEW] Trades count: {len(preview_data.get('trades', []))}")
        logger.info(f"[AI GEN PREVIEW] Metrics count: {len(preview_data.get('metrics', {}))}")
        logger.info("=" * 80)
        
        if not self.rec_engine:
            logger.error("[AI GEN PREVIEW] ❌ No recommendation engine available")
            return
        
        # CRITICAL: Check if OpenRouter API key is configured
        if not self._check_api_key_configured():
            self._show_api_key_warning()
            # Continue anyway - will use data-driven recommendations as fallback
        
        try:
            # Extract components from preview data (NO REBUILDING)
            strategy_config = preview_data.get('strategy_config', {})
            backtest_results = {
                'config': preview_data.get('backtest_config', {}),
                'trades': preview_data.get('trades', []),
                'metrics': preview_data.get('metrics', {})
            }
            
            # Prepare metrics with ratings
            metrics_with_ratings = {}
            for metric_key, metric_value in preview_data.get('metrics', {}).items():
                if isinstance(metric_value, (int, float)):
                    rating = self._get_rating(metric_key, metric_value)
                    metrics_with_ratings[metric_key] = {
                        'value': float(metric_value),
                        'rating': rating
                    }
            
            # Create progress dialog
            self.progress_dialog = QProgressDialog(
                "Generating AI recommendations using approved data...",
                None,
                0,
                100,
                self
            )
            self.progress_dialog.setWindowTitle("🤖 AI Analysis in Progress")
            self.progress_dialog.setWindowModality(Qt.WindowModality.NonModal)
            self.progress_dialog.setMinimumDuration(0)
            self.progress_dialog.setValue(0)
            self.progress_dialog.setAutoClose(False)
            self.progress_dialog.setAutoReset(False)
            self.progress_dialog.setCancelButton(None)
            self.progress_dialog.setMinimumSize(800, 300)
            self.progress_dialog.resize(800, 300)
            self.progress_dialog.show()
            QApplication.processEvents()
            
            # Create worker with EXACT preview data
            self.rec_worker = RecommendationWorker(
                engine=self.rec_engine,
                strategy_config=strategy_config,
                backtest_results=backtest_results,
                metrics=metrics_with_ratings,
                lookback_days=180
            )
            
            # Connect signals
            self.rec_worker.recommendations_ready.connect(self._on_recommendations_ready)
            self.rec_worker.progress_update.connect(self._on_ai_progress)
            self.rec_worker.error_occurred.connect(self._on_ai_error)
            
            # Minimum display time
            from PyQt5.QtCore import QTimer
            self.min_dialog_timer = QTimer()
            self.min_dialog_timer.setSingleShot(True)
            self.min_dialog_timer.timeout.connect(self._allow_dialog_close)
            self.dialog_can_close = False
            self.min_dialog_timer.start(1000)
            
            # Start AI generation
            logger.info("[AI GEN PREVIEW] Starting worker with exact preview data...")
            self.rec_worker.start()
            
        except Exception as e:
            logger.error(f"❌ Failed to generate recommendations with preview data: {str(e)}")
            import traceback
            traceback.print_exc()
            self.batch_recommendations = []
    
    def _check_api_key_configured(self) -> bool:
        """
        Check if OpenRouter API key is configured in environment.
        
        Returns:
            True if API key is set, False otherwise
        """
        import os
        api_key = os.getenv('OPENROUTER_API_KEY')
        return api_key is not None and api_key.strip() != ''
    
    def _show_api_key_warning(self) -> None:
        """
        Show institutional-grade non-blocking warning dialog about missing API key.
        
        Informs user that AI enhancement is unavailable, but data-driven recommendations
        will still be provided as fallback.
        """
        from PyQt5.QtWidgets import QMessageBox
        
        msg = QMessageBox(self)
        msg.setIcon(QMessageBox.Icon.Warning)
        msg.setWindowTitle("⚠️ AI Configuration Required")
        msg.setText("<h3>OpenRouter API Key Not Configured</h3>")
        msg.setInformativeText(
            "<p><b>AI-Enhanced Recommendations Unavailable</b></p>"
            "<p>The system will continue with data-driven recommendations as a fallback, "
            "but AI-powered strategic insights will not be available.</p>"
            "<br>"
            "<p><b>To enable AI enhancement:</b></p>"
            "<ol>"
            "<li>Obtain an API key from <a href='https://openrouter.ai/keys'>OpenRouter.ai</a></li>"
            "<li>Add to your <code>.env</code> file:<br><code>OPENROUTER_API_KEY=your_key_here</code></li>"
            "<li>Restart the application</li>"
            "</ol>"
            "<br>"
            "<p><i>Note: AI enhancement provides deeper strategic analysis and context-aware "
            "recommendations. Data-driven recommendations are still highly effective for "
            "identifying technical improvements.</i></p>"
        )
        msg.setStandardButtons(QMessageBox.StandardButton.Ok)
        msg.setDefaultButton(QMessageBox.StandardButton.Ok)
        
        # Non-blocking - don't wait for user response
        msg.setModal(False)
        msg.show()
        
        logger.warning("⚠️ API key warning dialog shown to user")
    
    def _switch_to_metrics_tab(self) -> None:
        """
        Switch to Metrics tab after AI recommendations complete.
        
        The Apply buttons (⚠ Fair / ✗ Poor rows) live on the Metrics tab, so after AI
        recommendations are generated the user should land there first.
        Prefers the 'Metrics' tab; falls back to 'AI Recommendations' tab.
        """
        try:
            # Find the tab widget containing this panel
            # Look for QTabWidget parent
            parent = self.parent()
            while parent and not isinstance(parent, QTabWidget):
                parent = parent.parent()
            
            if parent and isinstance(parent, QTabWidget):
                # Prefer Metrics tab (where Apply buttons live)
                for i in range(parent.count()):
                    tab_text = parent.tabText(i).lower()
                    if 'metric' in tab_text:
                        parent.setCurrentIndex(i)
                        logger.info(f"[UI] ✅ Switched to tab: {parent.tabText(i)}")
                        return
                # Fallback: AI Recommendations tab
                for i in range(parent.count()):
                    tab_text = parent.tabText(i).lower()
                    if 'ai' in tab_text or 'rec' in tab_text:
                        parent.setCurrentIndex(i)
                        logger.info(f"[UI] ✅ Switched to tab: {parent.tabText(i)}")
                        return
            
            logger.warning("[UI] ⚠️ Could not find tab widget to switch")
                
        except Exception as e:
            logger.error(f"❌ Failed to switch tabs: {str(e)}")
    
    def _populate_ai_recommendations_panel(self):
        """
        Populate AI Recommendations Panel with complete preview data.
        
        CRITICAL FIX: Directly access TradesPanel instead of waiting for 1-second timer emission.
        """
        try:
            # BTCAAAAA-736: Prefer the serialized strategy_config threaded from the backtest worker
            # (already a plain dict with correct block/signal names). Fall back to the orchestrator
            # path only when backtest results are unavailable (e.g. standalone AI panel open).
            if self.full_backtest_results and self.full_backtest_results.get('strategy_config'):
                strategy_config_dict = self.full_backtest_results['strategy_config']
                logger.info("[AI Panel] Using strategy_config from backtest results (reliable path)")
            else:
                strategy_config_obj = self._get_current_strategy_config()
                if not strategy_config_obj:
                    logger.warning("⚠️ No strategy config available - cannot populate AI panel")
                    return
                strategy_config_dict = self._convert_strategy_config_to_dict(strategy_config_obj)
            
            # Get backtest config
            backtest_config = {}
            if self.full_backtest_results and 'config' in self.full_backtest_results:
                backtest_config = self.full_backtest_results['config']
            else:
                backtest_config = self._build_backtest_config_manually()
            
            # CRITICAL FIX: Get trades DIRECTLY from TradesPanel (don't wait for timer)
            # The 1-second timer emission might not have fired yet when AI recs are ready
            trades = []
            dialog = self.window()
            if hasattr(dialog, 'backtest_panel'):
                backtest_panel = dialog.backtest_panel
                if hasattr(backtest_panel, 'trades_panel'):
                    trades_panel = backtest_panel.trades_panel
                    if hasattr(trades_panel, 'get_trades'):
                        trades = trades_panel.get_trades()
                        logger.debug(f"[DEBUG] Got {len(trades)} trades DIRECTLY from TradesPanel.get_trades()")
            
            if not trades:
                logger.warning(f"[DEBUG] ⚠️ No trades available - checking current_metrics fallback")
                trades = self.current_metrics.get('trades', [])
                logger.debug(f"[DEBUG] Fallback got {len(trades)} trades from current_metrics")
            
            # Get available blocks
            from src.optimizer_v3.core.comprehensive_ai_request_builder import ComprehensiveAIRequestBuilder
            builder = ComprehensiveAIRequestBuilder()
            _strategy_type = strategy_config_dict.get("strategy_type", "")
            _strategy_direction = (
                "BEARISH" if "bearish" in _strategy_type.lower()
                else "BULLISH" if "bullish" in _strategy_type.lower()
                else None
            )
            _current_block_names = set(
                b.get("name", "") for b in strategy_config_dict.get("blocks", [])
            )
            available_blocks = builder._extract_available_blocks(
                strategy_direction=_strategy_direction,
                current_block_names=_current_block_names,
            )
            
            # Access AI Recommendations Panel and populate it
            dialog = self.window()
            if hasattr(dialog, 'backtest_panel'):
                backtest_panel = dialog.backtest_panel
                if hasattr(backtest_panel, 'ai_recommendations_panel'):
                    ai_panel = backtest_panel.ai_recommendations_panel
                    
                    # Call populate_preview() with full data (EXACT same as standalone window)
                    ai_panel.populate_preview(
                        strategy_config=strategy_config_dict,
                        backtest_config=backtest_config,
                        trades=trades,  # From metrics emission
                        metrics=self.current_metrics,
                        available_blocks=available_blocks
                    )
                    
                    logger.info(f"[UI] ✅ AI Recommendations Panel populated with:")
                    logger.info(f"     Strategy Blocks: {len(strategy_config_dict.get('blocks', []))}")
                    logger.info(f"     Trades: {len(trades)}")
                    logger.info(f"     Metrics: {len(self.current_metrics)}")
                    logger.info(f"     Available Blocks: {len(available_blocks)}")
                else:
                    logger.warning("⚠️ AI Recommendations Panel not found")
            else:
                logger.warning("⚠️ Backtest panel not found")
                
        except Exception as e:
            logger.error(f"❌ Failed to populate AI Recommendations Panel: {str(e)}")
            import traceback
            traceback.print_exc()

    def _push_ai_analysis_to_panel(self, full_analysis: Dict) -> None:
        """
        Push full AI diagnosis (assessment, root_cause_analysis, implementation_order)
        to the AI Recommendations Panel for display.

        Args:
            full_analysis: Dict from AIRecommendationEnhancer.last_full_analysis
        """
        try:
            dialog = self.window()
            if hasattr(dialog, 'backtest_panel'):
                backtest_panel = dialog.backtest_panel
                if hasattr(backtest_panel, 'ai_recommendations_panel'):
                    ai_panel = backtest_panel.ai_recommendations_panel
                    if hasattr(ai_panel, 'display_ai_analysis'):
                        ai_panel.display_ai_analysis(full_analysis)
                        logger.info("[UI] ✅ Full AI analysis pushed to AI Recommendations Panel")
                    else:
                        logger.warning("⚠️ AIRecommendationsPanel has no display_ai_analysis method")
                else:
                    logger.warning("⚠️ AI Recommendations Panel not found for analysis push")
            else:
                logger.warning("⚠️ Backtest panel not found for analysis push")
        except Exception as e:
            logger.error(f"❌ Failed to push AI analysis to panel: {str(e)}")
