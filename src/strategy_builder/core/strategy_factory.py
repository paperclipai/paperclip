"""
Strategy Factory --- Template-based Generator
Generates production-grade NautilusTrader strategy code from JSON configuration.

Reference: CHILD-001 (BTCAAAAA-25614), docs/roadmap/child-issues/CHILD-001-strategy-factory.md
"""

import json
import re
import os
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Registry: maps human-readable block names to import paths and class names.
# ---------------------------------------------------------------------------
BLOCK_REGISTRY_MAP: Dict[str, Dict[str, str]] = {
    "Double_Top": {
        "import_path": "from src.detectors.building_blocks.patterns.double_top import DoubleTopPattern",
        "class_name": "DoubleTopPattern", "key": "double_top",
    },
    "Double_Bottom": {
        "import_path": "from src.detectors.building_blocks.patterns.double_bottom import DoubleBottomPattern",
        "class_name": "DoubleBottomPattern", "key": "double_bottom",
    },
    "M_Pattern": {
        "import_path": "from src.detectors.building_blocks.patterns.m_pattern import MPattern",
        "class_name": "MPattern", "key": "m_pattern",
    },
    "W_Pattern": {
        "import_path": "from src.detectors.building_blocks.patterns.w_pattern import WPattern",
        "class_name": "WPattern", "key": "w_pattern",
    },
    "RSI_Divergence": {
        "import_path": "from src.detectors.building_blocks.oscillators.rsi_divergence import RSIDivergence",
        "class_name": "RSIDivergence", "key": "rsi_divergence",
    },
    "MACD": {
        "import_path": "from src.detectors.building_blocks.oscillators.macd_signal import MACDSignal",
        "class_name": "MACDSignal", "key": "macd",
    },
    "EMA_20_50_Trend": {
        "import_path": "from src.detectors.building_blocks.moving_averages.ema_20_50_trend import EMA2050Trend",
        "class_name": "EMA2050Trend", "key": "ema_20_50_trend",
    },
    "EMA_200_Trend": {
        "import_path": "from src.detectors.building_blocks.moving_averages.ema_200_trend import EMA200Trend",
        "class_name": "EMA200Trend", "key": "ema_200_trend",
    },
    "EMA_20_50_Cross": {
        "import_path": "from src.detectors.building_blocks.moving_averages.ema_20_50_cross import EMA2050Cross",
        "class_name": "EMA2050Cross", "key": "ema_cross",
    },
    "HOD": {
        "import_path": "from src.detectors.building_blocks.price_levels.hod import HOD",
        "class_name": "HOD", "key": "hod",
    },
    "Asia_Session_50_Percent": {
        "import_path": "from src.detectors.building_blocks.price_levels.asia_session_50_percent import AsiaSession50Percent",
        "class_name": "AsiaSession50Percent", "key": "asia_session_50_percent",
    },
    "Session_Time": {
        "import_path": "from src.detectors.building_blocks.sessions.session_time import SessionTime",
        "class_name": "SessionTime", "key": "session_time",
    },
    "Kill_Zones": {
        "import_path": "from src.detectors.building_blocks.sessions.kill_zones import KillZones",
        "class_name": "KillZones", "key": "kill_zones",
    },
    "VWAP": {
        "import_path": "from src.detectors.building_blocks.institutional.vwap import VWAP",
        "class_name": "VWAP", "key": "vwap",
    },
    "ADR": {
        "import_path": "from src.detectors.building_blocks.volatility.adr import ADR",
        "class_name": "ADR", "key": "adr",
    },
    "Swing_Points": {
        "import_path": "from src.detectors.building_blocks.market_structure.swing_points import SwingPoints",
        "class_name": "SwingPoints", "key": "swing_points",
    },
    "Premium_Discount_Zones": {
        "import_path": "from src.detectors.building_blocks.market_structure.premium_discount_zones import PremiumDiscountZones",
        "class_name": "PremiumDiscountZones", "key": "premium_discount_zones",
    },
    "ADX": {
        "import_path": "from src.detectors.building_blocks.trend.adx import ADX",
        "class_name": "ADX", "key": "adx",
    },
    "Fibonacci_Retracements": {
        "import_path": "from src.detectors.building_blocks.fibonacci.fibonacci_retracements import FibonacciRetracements as Fibonacci",
        "class_name": "Fibonacci", "key": "fibonacci",
    },
}


@dataclass
class StrategyDef:
    """Strategy definition loaded from JSON config."""
    config_path: str = ""
    name: str = "GeneratedStrategy"
    number: str = "00"
    category: str = "GENERATED"
    timeframe: str = "15min"
    description: str = "Auto-generated strategy"
    author: str = "Strategy Factory"
    date: str = ""
    expected_frequency: str = "TBD"
    instrument_id: str = "BTC/USDT.BINANCE"
    blocks: List[Dict[str, Any]] = field(default_factory=list)
    min_confluence: int = 60
    entry_side: str = "LONG"
    entry_rules: List[str] = field(default_factory=list)
    exit_rules: List[str] = field(default_factory=list)
    tp1_multiplier: float = 1.5
    tp2_multiplier: float = 3.0
    tp3_multiplier: float = 5.0
    sl_atr_multiplier: float = 2.0
    max_leverage: float = 1.0
    risk_per_trade_pct: float = 1.0
    max_bars_held: int = 1000
    lookback_period: int = 100
    min_risk_reward: float = 2.0
    strategy_type: str = "Bullish"


@dataclass
class ValidationResult:
    valid: bool = True
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)


class StrategyFactory:
    """
    Template-based strategy generator.
    Reads JSON strategy definitions and generates production-grade
    NautilusTrader Strategy subclasses programmatically.
    """

    DEFAULT_OUTPUT_DIR = os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        "strategies",
    )

    INDENT = "    "

    # ------------------------------------------------------------------
    # Validation
    # ------------------------------------------------------------------

    def validate(self, definition: StrategyDef) -> ValidationResult:
        errors: List[str] = []
        warnings: List[str] = []

        if not definition.blocks:
            errors.append("Strategy must have at least one building block")
            return ValidationResult(valid=False, errors=errors)

        seen: set = set()
        max_achievable = 0

        for block in definition.blocks:
            name = block.get("name", "")
            if not name:
                errors.append("Block entry missing 'name' field")
                continue
            if name in seen:
                errors.append(f"Duplicate block: {name}")
            seen.add(name)
            if name not in BLOCK_REGISTRY_MAP:
                errors.append(
                    f"Block '{name}' not found in registry. "
                    f"Available: {', '.join(sorted(BLOCK_REGISTRY_MAP.keys()))}"
                )
            else:
                max_achievable += block.get("weight", 0)

        if not errors and max_achievable < definition.min_confluence:
            errors.append(
                f"Confluence threshold {definition.min_confluence} not achievable. "
                f"Max achievable: {max_achievable}"
            )

        if definition.max_leverage > 1.0:
            errors.append(
                f"Leverage {definition.max_leverage} exceeds 1.0 -- no margin allowed."
            )

        if definition.risk_per_trade_pct > 5.0:
            warnings.append(f"Risk per trade {definition.risk_per_trade_pct}% exceeds 5%.")

        if not definition.date:
            definition.date = datetime.now().strftime("%Y-%m-%d")

        return ValidationResult(
            valid=len(errors) == 0,
            errors=errors,
            warnings=warnings,
        )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _make_class_name(self, name: str) -> str:
        name = re.sub(r'([a-z])([A-Z])', r'\1 \2', name)
        name = re.sub(r'([A-Z]+)([A-Z][a-z])', r'\1 \2', name)
        clean = ''.join(c for c in name if c.isalnum() or c in (' ', '_', '-'))
        parts = clean.replace('-', ' ').replace('_', ' ').split()
        result = []
        for p in parts:
            if p.isupper() and len(p) > 1:
                result.append(p)
            else:
                result.append(p[0].upper() + p[1:] if p else '')
        return ''.join(result)

    def _make_strategy_id(self, number: str, name: str) -> str:
        suffix = name.upper().replace(" ", "_").replace("-", "_")[:30]
        return f"{number}_{suffix}"

    def _summarize_blocks(self, blocks: List[Dict]) -> str:
        return "\n".join(
            f"- {b['name']}: {b.get('description', b['name'])} ({b.get('weight', 0)} points)"
            for b in blocks
        )

    def _format_imports(self, blocks: List[Dict]) -> str:
        seen: set = set()
        lines: List[str] = []
        for block in blocks:
            meta = BLOCK_REGISTRY_MAP.get(block["name"])
            if meta and meta["import_path"] not in seen:
                lines.append(meta["import_path"])
                seen.add(meta["import_path"])
        return "\n".join(lines)

    def _block_metas(self, blocks: List[Dict]) -> List[Dict]:
        result: List[Dict] = []
        for block in blocks:
            meta = BLOCK_REGISTRY_MAP.get(block["name"])
            if meta:
                result.append({
                    "key": meta["key"],
                    "class_name": meta["class_name"],
                    "weight": block.get("weight", 10),
                    "timeframe": block.get("timeframe", "15min"),
                })
        return result

    # ------------------------------------------------------------------
    # Code Generation
    # ------------------------------------------------------------------

    def _docstring(self, d: StrategyDef) -> str:
        lines = [
            f'NautilusTrader Strategy -- Auto-generated by Strategy Factory.',
            f'',
            f'DO NOT EDIT MANUALLY -- Regenerate through Strategy Factory CLI.',
            f'',
            f'Strategy: {d.name}',
            f'Number: {d.number}',
            f'Category: {d.category}',
            f'Timeframe: {d.timeframe}',
            f'Risk:Reward: {d.min_risk_reward}',
            f'Expected Frequency: {d.expected_frequency}',
            f'Author: {d.author}',
            f'Date: {d.date}',
            f'',
            f'Description:',
            f'{d.description}',
            f'',
            f'Building Blocks:',
        ]
        lines.append(self._summarize_blocks(d.blocks))
        lines.append("")
        lines.append("Entry Logic:")
        for i, rule in enumerate(d.entry_rules, 1):
            lines.append(f"{i}. {rule}")
        lines.append("")
        lines.append("Exit Logic:")
        for i, rule in enumerate(d.exit_rules, 1):
            lines.append(f"{i}. {rule}")
        lines.append("")
        return '\n'.join(f"    {line}" if line else "" for line in lines)

    def generate(self, definition: StrategyDef) -> Tuple[str, str]:
        class_name = self._make_class_name(definition.name)
        strategy_id = self._make_strategy_id(definition.number, definition.name)
        is_short = definition.entry_side.upper() == "SHORT"
        entry_order_side = "SELL" if is_short else "BUY"
        metas = self._block_metas(definition.blocks)
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        # Standard boilerplate imports
        parts: List[str] = []
        parts.append(f'''"""
NautilusTrader Strategy --- Auto-generated by Strategy Factory.

DO NOT EDIT MANUALLY --- Regenerate through Strategy Factory CLI.

Strategy: {definition.name}
Number: {definition.number}
Category: {definition.category}
Timeframe: {definition.timeframe}
Risk:Reward: {definition.min_risk_reward}
Expected Frequency: {definition.expected_frequency}
Author: {definition.author}
Date: {definition.date}

Description:
{definition.description}

Building Blocks:
{self._summarize_blocks(definition.blocks)}

Entry Logic:
{self._format_rules(definition.entry_rules)}

Exit Logic:
{self._format_rules(definition.exit_rules)}
"""''')
        parts.append("")
        parts.append("from nautilus_trader.trading.strategy import Strategy")
        parts.append("from nautilus_trader.model.data import Bar")
        parts.append("from nautilus_trader.model.enums import OrderSide, TimeInForce")
        parts.append("from nautilus_trader.model.objects import Money, Price, Quantity")
        parts.append("from nautilus_trader.model.currencies import USD")
        parts.append("from nautilus_trader.model.identifiers import InstrumentId")
        parts.append("import pandas as pd")
        parts.append("from typing import Optional")
        parts.append("from src.strategies.risk_enforcer import RiskEnforcer")
        parts.append("")
        parts.append(self._format_imports(definition.blocks))
        parts.append("")
        parts.append("from src.strategies.universal_optimizer.modules.confluence_calculator import ConfluenceCalculator")
        parts.append("")

        # Class definition
        parts.append(f"class {class_name}(Strategy):")
        parts.append(f"{self.INDENT}\"\"\"")
        parts.append(f"{self.INDENT}{definition.description}")
        parts.append(f"{self.INDENT}")
        parts.append(f"{self.INDENT}Auto-generated by Strategy Factory from config: {definition.config_path}")
        parts.append(f"{self.INDENT}\"\"\"")

        # __init__
        parts.append("")
        parts.append(f"{self.INDENT}def __init__(self, config):")
        parts.append(f'{self.INDENT * 2}if isinstance(config, dict):')
        parts.append(f'{self.INDENT * 2}    from nautilus_trader.trading.config import StrategyConfig')
        parts.append(f'{self.INDENT * 2}    config = StrategyConfig(strategy_id=config.get("strategy_id", "{strategy_id}"))')
        parts.append(f'{self.INDENT * 2}super().__init__(config)')
        parts.append("")
        parts.append(f'{self.INDENT * 2}self.strategy_id = "{strategy_id}"')
        parts.append(f'{self.INDENT * 2}self.strategy_name = "{definition.name}"')
        parts.append("")
        parts.append(f'{self.INDENT * 2}self.min_confluence = {definition.min_confluence}')
        parts.append(f'{self.INDENT * 2}self.max_bars_held = {definition.max_bars_held}')
        parts.append(f'{self.INDENT * 2}self.lookback_period = {definition.lookback_period}')
        parts.append(f'{self.INDENT * 2}self.min_risk_reward = {definition.min_risk_reward}')
        parts.append(f'{self.INDENT * 2}self.max_leverage = {definition.max_leverage}')
        parts.append(f'{self.INDENT * 2}self.risk_per_trade_pct = {definition.risk_per_trade_pct}')
        parts.append("")
        parts.append(f'{self.INDENT * 2}self.daily_pnl_usd = 0.0')
        parts.append(f'{self.INDENT * 2}self.last_pnl_reset_utc = None')
        parts.append(f'{self.INDENT * 2}self.instrument_id = InstrumentId.from_str("{definition.instrument_id}")')
        parts.append(f'{self.INDENT * 2}self.risk = RiskEnforcer(self)')
        parts.append("")
        parts.append(f'{self.INDENT * 2}self.blocks = {{}}')
        parts.append(f'{self.INDENT * 2}self._initialize_blocks()')
        parts.append("")
        parts.append(f'{self.INDENT * 2}self.bars_data = []')
        parts.append(f'{self.INDENT * 2}self.trades_count = 0')
        parts.append(f'{self.INDENT * 2}self.wins = 0')
        parts.append(f'{self.INDENT * 2}self.losses = 0')
        parts.append(f'{self.INDENT * 2}self.total_confluence_scores = []')

        # _initialize_blocks
        parts.append("")
        parts.append(f"{self.INDENT}def _initialize_blocks(self):")
        parts.append(f"{self.INDENT * 2}self.detectors = {{")
        for m in metas:
            parts.append(f"{self.INDENT * 3}'{m['key']}': {m['class_name']}(timeframe='{m['timeframe']}'),")
        parts.append(f"{self.INDENT * 2}}}")
        parts.append(f"{self.INDENT * 2}self.blocks = {{")
        for m in metas:
            parts.append(f"{self.INDENT * 3}'{m['key']}': {{'weight': {m['weight']}, 'enabled': True}},")
        parts.append(f"{self.INDENT * 2}}}")

        # _bars_to_dataframe
        parts.append("")
        parts.append(f"{self.INDENT}def _bars_to_dataframe(self, bars) -> pd.DataFrame:")
        parts.append(f"{self.INDENT * 2}return pd.DataFrame([{{")
        parts.append(f"{self.INDENT * 3}'timestamp': bar.ts_event,")
        parts.append(f"{self.INDENT * 3}'open': float(bar.open),")
        parts.append(f"{self.INDENT * 3}'high': float(bar.high),")
        parts.append(f"{self.INDENT * 3}'low': float(bar.low),")
        parts.append(f"{self.INDENT * 3}'close': float(bar.close),")
        parts.append(f"{self.INDENT * 3}'volume': float(bar.volume)")
        parts.append(f"{self.INDENT * 2}}} for bar in bars])")

        # _update_dataframe
        parts.append("")
        parts.append(f"{self.INDENT}def _update_dataframe(self, bar: Bar) -> pd.DataFrame:")
        parts.append(f"{self.INDENT * 2}self.bars_data.append({{")
        parts.append(f"{self.INDENT * 3}'timestamp': bar.ts_event,")
        parts.append(f"{self.INDENT * 3}'open': float(bar.open),")
        parts.append(f"{self.INDENT * 3}'high': float(bar.high),")
        parts.append(f"{self.INDENT * 3}'low': float(bar.low),")
        parts.append(f"{self.INDENT * 3}'close': float(bar.close),")
        parts.append(f"{self.INDENT * 3}'volume': float(bar.volume)")
        parts.append(f"{self.INDENT * 2}}})")
        parts.append(f"{self.INDENT * 2}if len(self.bars_data) > self.max_bars_held:")
        parts.append(f"{self.INDENT * 3}self.bars_data.pop(0)")
        parts.append(f"{self.INDENT * 2}return pd.DataFrame(self.bars_data)")

        # on_start
        parts.append("")
        parts.append(f"{self.INDENT}def on_start(self):")
        parts.append(f'{self.INDENT * 2}self.log.info(f"{{self.strategy_name}} starting...")')
        parts.append(f'{self.INDENT * 2}self.log.info(f"Strategy ID: {{self.strategy_id}}")')
        parts.append(f'{self.INDENT * 2}self.log.info(f"Min Confluence: {{self.min_confluence}}")')
        parts.append(f'{self.INDENT * 2}self.log.info(f"Min R:R: {{self.min_risk_reward}}")')

        # on_bar
        parts.append("")
        parts.append(f"{self.INDENT}def on_bar(self, bar: Bar):")
        parts.append(f"{self.INDENT * 2}df = self._update_dataframe(bar)")
        parts.append(f"{self.INDENT * 2}if len(df) < self.lookback_period:")
        parts.append(f"{self.INDENT * 3}return")
        parts.append("")
        parts.append(f"{self.INDENT * 2}if RiskEnforcer.should_reset_daily_pnl(self.last_pnl_reset_utc):")
        parts.append(f"{self.INDENT * 2}    self.daily_pnl_usd = 0.0")
        parts.append(f"{self.INDENT * 2}    self.last_pnl_reset_utc = __import__('time').time()")
        parts.append("")
        parts.append(f"{self.INDENT * 2}results = self._analyze_blocks(df)")
        parts.append(f"{self.INDENT * 2}confluence, signals = self._calculate_confluence(results)")
        parts.append(f"{self.INDENT * 2}self.total_confluence_scores.append(confluence)")
        parts.append("")
        parts.append(f"{self.INDENT * 2}if confluence >= self.min_confluence:")
        parts.append(f"{self.INDENT * 2}    if self.portfolio.is_flat(self.instrument_id):")
        parts.append(f"{self.INDENT * 2}        self._execute_entry(confluence, results, signals)")

        # _analyze_blocks
        parts.append("")
        parts.append(f"{self.INDENT}def _analyze_blocks(self, df: pd.DataFrame) -> dict:")
        parts.append(f"{self.INDENT * 2}results = {{}}")
        for m in metas:
            parts.append(f"{self.INDENT * 2}results['{m['key']}'] = self.detectors['{m['key']}'].analyze(df)")
        parts.append(f"{self.INDENT * 2}return results")

        # _calculate_confluence
        parts.append("")
        parts.append(f"{self.INDENT}def _calculate_confluence(self, results: dict) -> tuple:")
        parts.append(f"{self.INDENT * 2}return ConfluenceCalculator.calculate_confluence(results, self.blocks)")

        # _calculate_position_size
        parts.append("")
        parts.append(f"{self.INDENT}def _calculate_position_size(self, risk_per_unit: float) -> Quantity:")
        parts.append(f"{self.INDENT * 2}account_balance = 10000.0")
        parts.append(f"{self.INDENT * 2}max_risk_dollars = account_balance * (self.risk_per_trade_pct / 100)")
        parts.append(f"{self.INDENT * 2}position_size = max_risk_dollars / abs(risk_per_unit)")
        parts.append(f"{self.INDENT * 2}position_size = round(position_size, 3)")
        parts.append(f"{self.INDENT * 2}return Quantity.from_str(str(position_size))")

        # _execute_entry
        parts.append("")
        parts.append(f"{self.INDENT}def _execute_entry(self, confluence: int, results: dict, signals: list):")
        parts.append(f'{self.INDENT * 2}self.log.info(f"HIGH CONFLUENCE DETECTED: {{confluence}} points")')
        parts.append(f"{self.INDENT * 2}for signal in signals:")
        parts.append(f'{self.INDENT * 3}self.log.info(f"  {{signal}}")')
        parts.append("")
        parts.append(f"{self.INDENT * 2}current_price = self.bars_data[-1]['close']")
        parts.append(f"{self.INDENT * 2}tp1, tp2, tp3, sl = self._calculate_tp_sl(results)")
        parts.append("")
        parts.append(f"{self.INDENT * 2}risk = abs(current_price - sl)")
        parts.append(f"{self.INDENT * 2}reward = abs(tp2 - current_price)")
        parts.append("")
        parts.append(f"{self.INDENT * 2}if risk <= 0:")
        parts.append(f'{self.INDENT * 3}self.log.warning("Invalid risk calculation - aborting entry")')
        parts.append(f"{self.INDENT * 3}return")
        parts.append("")
        parts.append(f"{self.INDENT * 2}rr_ratio = reward / risk")
        parts.append(f"{self.INDENT * 2}if rr_ratio < self.min_risk_reward:")
        parts.append(f'{self.INDENT * 2}    self.log.info(f"R:R {{rr_ratio:.2f}} below minimum {{self.min_risk_reward}} - skipping trade")')
        parts.append(f"{self.INDENT * 2}    return")
        parts.append("")
        parts.append(f'{self.INDENT * 2}self.log.info(f"R:R: {{rr_ratio:.2f}} - ENTERING {definition.entry_side}")')
        parts.append("")
        parts.append(f"{self.INDENT * 2}quantity = self._calculate_position_size(risk)")
        parts.append(f"{self.INDENT * 2}entry_side = OrderSide.{entry_order_side}")
        parts.append("")
        parts.append(f"{self.INDENT * 2}self.risk.check_and_submit(")
        parts.append(f"{self.INDENT * 2}    side=entry_side,")
        parts.append(f"{self.INDENT * 2}    quantity=quantity,")
        parts.append(f'{self.INDENT * 2}    price=Price(str(round(current_price, 2))),')
        parts.append(f"{self.INDENT * 2}    entry_price=current_price,")
        parts.append(f"{self.INDENT * 2}    instrument_id=self.instrument_id,")
        parts.append(f'{self.INDENT * 2}    daily_pnl=Money(f"{{self.daily_pnl_usd:.2f}}", USD),')
        parts.append(f"{self.INDENT * 2})")
        parts.append("")
        parts.append(f'{self.INDENT * 2}self.log.info(f"Entry: {{quantity}} @ {{current_price}}")')
        parts.append(f'{self.INDENT * 2}self.log.info(f"TP1: {{tp1}}, TP2: {{tp2}}, TP3: {{tp3}}")')
        parts.append(f'{self.INDENT * 2}self.log.info(f"SL: {{sl}}")')
        parts.append(f'{self.INDENT * 2}self.log.info(f"Risk: ${{risk:.2f}}, Reward: ${{reward:.2f}}, R:R: {{rr_ratio:.2f}}")')
        parts.append(f"{self.INDENT * 2}self.trades_count += 1")

        # _calculate_tp_sl
        parts.append("")
        parts.append(f"{self.INDENT}def _calculate_tp_sl(self, results: dict) -> tuple:")
        parts.append(f"{self.INDENT * 2}current_price = self.bars_data[-1]['close']")
        parts.append(f"{self.INDENT * 2}df = pd.DataFrame(self.bars_data).tail(20)")
        parts.append(f"{self.INDENT * 2}df['tr'] = df[['high', 'low', 'close']].apply(")
        parts.append(f"{self.INDENT * 2}    lambda x: max(x['high'] - x['low'],")
        parts.append(f"{self.INDENT * 2}                  abs(x['high'] - x['close']),")
        parts.append(f"{self.INDENT * 2}                  abs(x['low'] - x['close'])), axis=1")
        parts.append(f"{self.INDENT * 2})")
        parts.append(f"{self.INDENT * 2}atr = df['tr'].mean()")
        if is_short:
            parts.append(f"{self.INDENT * 2}sl = current_price + (atr * self.sl_atr_multiplier)")
            parts.append(f"{self.INDENT * 2}tp1 = current_price - (atr * self.tp1_multiplier)")
            parts.append(f"{self.INDENT * 2}tp2 = current_price - (atr * self.tp2_multiplier)")
            parts.append(f"{self.INDENT * 2}tp3 = current_price - (atr * self.tp3_multiplier)")
        else:
            parts.append(f"{self.INDENT * 2}sl = current_price - (atr * self.sl_atr_multiplier)")
            parts.append(f"{self.INDENT * 2}tp1 = current_price + (atr * self.tp1_multiplier)")
            parts.append(f"{self.INDENT * 2}tp2 = current_price + (atr * self.tp2_multiplier)")
            parts.append(f"{self.INDENT * 2}tp3 = current_price + (atr * self.tp3_multiplier)")
        parts.append(f"{self.INDENT * 2}return tp1, tp2, tp3, sl")

        # on_position_closed
        parts.append("")
        parts.append(f"{self.INDENT}def on_position_closed(self, position_data):")
        parts.append(f"{self.INDENT * 2}pnl = position_data.get('pnl', 0)")
        parts.append(f"{self.INDENT * 2}self.daily_pnl_usd += pnl")
        parts.append(f"{self.INDENT * 2}if pnl > 0:")
        parts.append(f"{self.INDENT * 3}self.wins += 1")
        parts.append(f"{self.INDENT * 2}else:")
        parts.append(f"{self.INDENT * 3}self.losses += 1")
        parts.append(f"{self.INDENT * 2}win_rate = (self.wins / self.trades_count * 100) if self.trades_count > 0 else 0")
        parts.append(f'{self.INDENT * 2}self.log.info(f"Performance: {{self.wins}}W / {{self.losses}}L = {{win_rate:.1f}}% win rate")')
        parts.append(f'{self.INDENT * 2}self.log.info(f"Daily PnL: ${{self.daily_pnl_usd:.2f}}")')
        parts.append(f"{self.INDENT * 2}if self.total_confluence_scores:")
        parts.append(f"{self.INDENT * 2}    avg = sum(self.total_confluence_scores) / len(self.total_confluence_scores)")
        parts.append(f'{self.INDENT * 2}    self.log.info(f"Average confluence: {{avg:.1f}}")')

        # on_stop
        parts.append("")
        parts.append(f"{self.INDENT}def on_stop(self):")
        parts.append(f'{self.INDENT * 2}self.log.info(f"{{self.strategy_name}} stopped")')
        parts.append(f'{self.INDENT * 2}self.log.info(f"Total trades: {{self.trades_count}}")')
        parts.append(f"{self.INDENT * 2}win_rate = (self.wins / self.trades_count * 100) if self.trades_count > 0 else 0")
        parts.append(f'{self.INDENT * 2}self.log.info(f"Win rate: {{win_rate:.1f}}%")')

        source = "\n".join(parts) + "\n"
        safe_name = definition.name.lower().replace(" ", "_").replace("-", "_")
        filename = f"strategy_{definition.number}_{safe_name}.py"
        return source, filename

    def _format_rules(self, rules: List[str]) -> str:
        return "\n".join(f"{i+1}. {r}" for i, r in enumerate(rules))

    def generate_and_write(
        self, definition: StrategyDef, output_dir: Optional[str] = None,
        overwrite: bool = False,
    ) -> Tuple[str, ValidationResult]:
        validation = self.validate(definition)
        if not validation.valid:
            return "", validation

        source, filename = self.generate(definition)
        dest_dir = output_dir or self.DEFAULT_OUTPUT_DIR
        os.makedirs(dest_dir, exist_ok=True)
        output_path = os.path.join(dest_dir, filename)

        if os.path.exists(output_path) and not overwrite:
            logger.warning(f"File exists, skipping: {output_path}")
            return output_path, ValidationResult(
                valid=True,
                warnings=[f"Skipped existing file: {output_path}"],
            )

        with open(output_path, "w") as f:
            f.write(source)

        logger.info(f"Generated: {output_path}")
        return output_path, validation

    # ------------------------------------------------------------------
    # Load definition from JSON
    # ------------------------------------------------------------------

    def load_definition(self, config_path: str) -> StrategyDef:
        with open(config_path, "r") as f:
            data = json.load(f)

        blocks_raw = data.get("blocks", data.get("building_blocks", []))
        blocks: List[Dict[str, Any]] = []
        for b in blocks_raw:
            if isinstance(b, str):
                meta = BLOCK_REGISTRY_MAP.get(b)
                blocks.append({
                    "name": b,
                    "weight": 10,
                    "description": meta["key"] if meta else b,
                })
            else:
                blocks.append({
                    "name": b["name"],
                    "weight": b.get("weight", 10),
                    "description": b.get("description", b["name"]),
                })

        return StrategyDef(
            config_path=config_path,
            name=data.get("name", data.get("strategy_name", "GeneratedStrategy")),
            number=str(data.get("number", "00")),
            category=data.get("category", "GENERATED"),
            timeframe=data.get("timeframe", "15min"),
            description=data.get("description", "Auto-generated strategy"),
            author=data.get("author", "Strategy Factory"),
            date=data.get("date", datetime.now().strftime("%Y-%m-%d")),
            expected_frequency=data.get("expected_frequency", "TBD"),
            instrument_id=data.get("instrument_id", "BTC/USDT.BINANCE"),
            blocks=blocks,
            min_confluence=data.get("min_confluence", 60),
            entry_side=data.get("entry_side", "LONG"),
            entry_rules=data.get("entry_rules", []),
            exit_rules=data.get("exit_rules", []),
            tp1_multiplier=data.get("tp1_multiplier", 1.5),
            tp2_multiplier=data.get("tp2_multiplier", 3.0),
            tp3_multiplier=data.get("tp3_multiplier", 5.0),
            sl_atr_multiplier=data.get("sl_atr_multiplier", 2.0),
            max_leverage=data.get("max_leverage", 1.0),
            risk_per_trade_pct=data.get("risk_per_trade_pct", 1.0),
            max_bars_held=data.get("max_bars_held", 1000),
            lookback_period=data.get("lookback_period", 100),
            min_risk_reward=data.get("min_risk_reward", 2.0),
            strategy_type=data.get("strategy_type", "Bullish"),
        )

    def load_definitions(
        self, config_dir: str, start: int = 0, end: Optional[int] = None
    ) -> List[StrategyDef]:
        if not os.path.isdir(config_dir):
            logger.error(f"Config directory not found: {config_dir}")
            return []

        definitions: List[StrategyDef] = []
        all_files = sorted(f for f in os.listdir(config_dir) if f.endswith(".json"))

        for fname in all_files:
            num_part = "".join(c for c in fname if c.isdigit())
            num = int(num_part) if num_part else 0
            if end is not None and (num < start or num >= end):
                continue
            if end is None and num < start:
                continue

            path = os.path.join(config_dir, fname)
            try:
                defn = self.load_definition(path)
                definitions.append(defn)
                logger.info(f"Loaded: {fname}")
            except Exception as e:
                logger.error(f"Failed to load {fname}: {e}")

        return definitions

    def batch_generate(
        self, definitions: List[StrategyDef], output_dir: Optional[str] = None
    ) -> List[Tuple[str, ValidationResult]]:
        results: List[Tuple[str, ValidationResult]] = []
        for defn in definitions:
            result = self.generate_and_write(defn, output_dir)
            results.append(result)
            if result[1].warnings:
                for w in result[1].warnings:
                    logger.warning(f"[{defn.name}] {w}")
        return results
