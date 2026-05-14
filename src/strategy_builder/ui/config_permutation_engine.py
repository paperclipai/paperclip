"""
Config Permutation Engine — Config Discovery Phase 2

Generates N scenario configs from parameter ranges and runs them
via the existing multicore backtest engine. Each permutation is a
variant of the current strategy config with one or more parameters
swept across a user-defined range.

Design goals:
- Zero hardcoded style values (styles come from styles.py)
- Non-blocking: runs in a QThread, emits signals per scenario
- Reuses cached bars loaded once before the discovery loop
- Extends generate_pairwise_scenarios() from test_scenarios.py
- Produces DiscoveryResult objects consumed by ConfigDiscoveryResultsDialog

Author: UIEngineer (BTCAAAAA-149)
Date: 2026-05-04
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

from PyQt5.QtCore import QThread, pyqtSignal


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class ParameterRange:
    """
    Defines a single parameter axis for the permutation sweep.

    Attributes:
        key:      Dot-notation path into the config dict.
                  Nested keys use '.' separator, e.g. 'adaptive_sl.volatility_lookback'.
        label:    Human-readable axis label shown in the results table.
        values:   Explicit list of values to sweep.
                  If None, linspace(min_val, max_val, steps) is used.
        min_val:  Range minimum (used when values is None).
        max_val:  Range maximum (used when values is None).
        steps:    Number of steps (used when values is None).
        fmt:      Format string for display (e.g., '{:.1f}%' or '{}x').
    """
    key: str
    label: str
    values: Optional[List[Any]] = None
    min_val: Optional[float] = None
    max_val: Optional[float] = None
    steps: int = 5
    fmt: str = '{}'

    def get_values(self) -> List[Any]:
        """Return the concrete list of values for this axis."""
        if self.values is not None:
            return list(self.values)
        if self.min_val is None or self.max_val is None:
            raise ValueError(f"ParameterRange '{self.key}': must supply either values or min_val+max_val")
        if self.steps < 2:
            return [self.min_val]
        step = (self.max_val - self.min_val) / (self.steps - 1)
        return [round(self.min_val + step * i, 6) for i in range(self.steps)]

    def format_value(self, v: Any) -> str:
        """Return formatted string for display."""
        try:
            return self.fmt.format(v)
        except Exception:
            return str(v)


@dataclass
class DiscoveryScenario:
    """
    One permutation scenario produced by ConfigPermutationEngine.

    Attributes:
        scenario_id:  Unique identifier (e.g., 'DISC_001').
        description:  Short human-readable label (axes + values).
        config_delta: Dict of {key: value} overrides applied on top of the
                      base config.  Nested keys use dot notation.
        param_labels: Ordered list of (axis_label, formatted_value) tuples
                      for display in the results table.
    """
    scenario_id: str
    description: str
    config_delta: Dict[str, Any]
    param_labels: List[Tuple[str, str]] = field(default_factory=list)


@dataclass
class DiscoveryResult:
    """
    Aggregated metrics for one DiscoveryScenario run.

    All monetary values are USD.  All percentages are 0-100 floats.
    """
    scenario_id: str
    description: str
    config_delta: Dict[str, Any]
    param_labels: List[Tuple[str, str]]

    # Core metrics
    total_pnl: float = 0.0
    win_rate: float = 0.0          # 0–100
    trade_count: int = 0
    avg_pnl_per_trade: float = 0.0
    sharpe_ratio: float = 0.0

    # Exit type distribution (counts)
    exit_tp1: int = 0
    exit_tp2: int = 0
    exit_tp3: int = 0
    exit_sl: int = 0
    exit_time: int = 0             # max_bars_held exits

    # Extra stats
    avg_bars_held: float = 0.0
    max_drawdown: float = 0.0      # peak-to-trough PnL drawdown

    # Raw data for further analysis
    raw_trades: List[Dict[str, Any]] = field(default_factory=list)
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# Default parameter ranges
# ---------------------------------------------------------------------------

DEFAULT_PARAMETER_RANGES: List[ParameterRange] = [
    ParameterRange(
        key='adaptive_sl.volatility_lookback',
        label='Vol Lookback',
        min_val=10, max_val=30, steps=3,
        fmt='{:.0f} bars',
    ),
    ParameterRange(
        key='adaptive_sl.volatility_multiplier',
        label='Vol Multiplier',
        min_val=0.8, max_val=1.8, steps=3,
        fmt='{:.1f}x',
    ),
    ParameterRange(
        key='adaptive_sl.min_sl_pct',
        label='Min SL %',
        min_val=0.5, max_val=1.2, steps=3,
        fmt='{:.1f}%',
    ),
    ParameterRange(
        key='adaptive_sl.max_sl_pct',
        label='Max SL %',
        min_val=1.5, max_val=3.0, steps=3,
        fmt='{:.1f}%',
    ),
    ParameterRange(
        key='tpsl_mode',
        label='TP/SL Mode',
        values=['Fibonacci', 'Hybrid', 'Fixed'],
        fmt='{}',
    ),
    ParameterRange(
        key='max_bars_held',
        label='Max Bars',
        values=[50, 100, 200],
        fmt='{:.0f}',
    ),
]


# ---------------------------------------------------------------------------
# Permutation generation helpers
# ---------------------------------------------------------------------------

def _set_nested(d: Dict, key: str, value: Any) -> Dict:
    """
    Return a deep copy of *d* with *key* set to *value*.
    Key may use dot notation for nested dicts: 'adaptive_sl.volatility_lookback'.
    """
    import copy
    result = copy.deepcopy(d)
    parts = key.split('.')
    target = result
    for part in parts[:-1]:
        if not isinstance(target.get(part), dict):
            target[part] = {}
        target = target[part]
    target[parts[-1]] = value
    return result


def generate_single_axis_permutations(
    base_config: Dict[str, Any],
    ranges: List[ParameterRange],
) -> List[DiscoveryScenario]:
    """
    Generate one-at-a-time permutations: each axis swept independently,
    all other axes held at base_config values.

    This is the fastest sweep strategy: O(sum of steps) scenarios.
    """
    scenarios: List[DiscoveryScenario] = []
    idx = 1
    for rng in ranges:
        for val in rng.get_values():
            delta = {rng.key: val}
            applied = _set_nested(base_config, rng.key, val)
            label_str = f"{rng.label}={rng.format_value(val)}"
            scenarios.append(DiscoveryScenario(
                scenario_id=f"DISC_{idx:04d}",
                description=label_str,
                config_delta=delta,
                param_labels=[(rng.label, rng.format_value(val))],
            ))
            idx += 1
    return scenarios


def generate_pairwise_permutations(
    base_config: Dict[str, Any],
    ranges: List[ParameterRange],
) -> List[DiscoveryScenario]:
    """
    Generate pairwise permutations (every pair of axes tested at least once).
    Falls back to single-axis if allpairspy is unavailable.

    The resulting scenario count is O(max_axis_steps^2) — much smaller than
    full factorial but guarantees pairwise coverage.
    """
    # Build value lists per axis
    axes = [(r, r.get_values()) for r in ranges]

    try:
        from allpairspy import AllPairs
        value_lists = [vals for _, vals in axes]
        combinations = list(AllPairs(value_lists))
    except ImportError:
        # Fallback: zip longest (quick pairwise approximation)
        max_len = max(len(vals) for _, vals in axes)
        combinations = []
        for i in range(max_len):
            combo = []
            for _, vals in axes:
                combo.append(vals[i % len(vals)])
            combinations.append(combo)

    scenarios: List[DiscoveryScenario] = []
    for idx, combo in enumerate(combinations, 1):
        config = dict(base_config)
        delta: Dict[str, Any] = {}
        param_labels: List[Tuple[str, str]] = []
        parts: List[str] = []
        for (rng, _), val in zip(axes, combo):
            config = _set_nested(config, rng.key, val)
            delta[rng.key] = val
            param_labels.append((rng.label, rng.format_value(val)))
            parts.append(f"{rng.label}={rng.format_value(val)}")

        scenarios.append(DiscoveryScenario(
            scenario_id=f"DISC_{idx:04d}",
            description=', '.join(parts),
            config_delta=delta,
            param_labels=param_labels,
        ))
    return scenarios


# ---------------------------------------------------------------------------
# Metrics aggregation
# ---------------------------------------------------------------------------

def aggregate_metrics(
    scenario: DiscoveryScenario,
    trades: List[Dict[str, Any]],
    error: Optional[str] = None,
) -> DiscoveryResult:
    """
    Aggregate per-trade exit data into a DiscoveryResult.

    Expected trade dict keys (produced by multicore engine):
        pnl, exit_condition_name, bars_held, exit_reason
    """
    result = DiscoveryResult(
        scenario_id=scenario.scenario_id,
        description=scenario.description,
        config_delta=scenario.config_delta,
        param_labels=scenario.param_labels,
        raw_trades=trades,
        error=error,
    )

    if not trades or error:
        return result

    pnl_values = [t.get('pnl', 0.0) for t in trades]
    bars_values = [t.get('bars_held', 0) for t in trades]

    result.trade_count = len(trades)
    result.total_pnl = sum(pnl_values)
    winning = [p for p in pnl_values if p > 0]
    result.win_rate = (len(winning) / result.trade_count) * 100.0 if result.trade_count else 0.0
    result.avg_pnl_per_trade = result.total_pnl / result.trade_count if result.trade_count else 0.0
    result.avg_bars_held = sum(bars_values) / len(bars_values) if bars_values else 0.0

    # Sharpe ratio (annualised, assume each trade = 1 period)
    if result.trade_count > 1:
        mean_pnl = result.avg_pnl_per_trade
        variance = sum((p - mean_pnl) ** 2 for p in pnl_values) / (result.trade_count - 1)
        std_pnl = math.sqrt(variance) if variance > 0 else 0.0
        result.sharpe_ratio = (mean_pnl / std_pnl) * math.sqrt(result.trade_count) if std_pnl > 0 else 0.0
    else:
        result.sharpe_ratio = 0.0

    # Exit type distribution
    for trade in trades:
        ec = (trade.get('exit_condition_name') or '').upper()
        er = (trade.get('exit_reason') or '').upper()
        if ec == 'TP1':
            result.exit_tp1 += 1
        elif ec == 'TP2':
            result.exit_tp2 += 1
        elif ec == 'TP3':
            result.exit_tp3 += 1
        elif 'STOP' in er or ec == 'SL':
            result.exit_sl += 1
        elif 'TIME' in er or 'MAX_BARS' in er or 'MAX BARS' in er:
            result.exit_time += 1

    # Max drawdown (peak-to-trough cumulative PnL)
    peak = 0.0
    cum = 0.0
    max_dd = 0.0
    for p in pnl_values:
        cum += p
        if cum > peak:
            peak = cum
        dd = peak - cum
        if dd > max_dd:
            max_dd = dd
    result.max_drawdown = max_dd

    return result


# ---------------------------------------------------------------------------
# Worker thread
# ---------------------------------------------------------------------------

class ConfigPermutationWorker(QThread):
    """
    QThread that runs N permutation scenarios sequentially.

    If *data_provider* is supplied (and cached_bars is None), the worker loads
    bars itself at the start of run() — keeping the main UI thread unblocked.
    A baseline backtest is also run inside the thread when *run_baseline* is True.

    Signals:
        scenario_complete(DiscoveryResult)  — emitted after each scenario
        progress_updated(int, int, str)     — current, total, message
        baseline_ready(object)              — DiscoveryResult for the baseline row
        discovery_complete(list)            — all DiscoveryResult objects when done
        error_occurred(str)                 — emitted on fatal error
    """

    scenario_complete = pyqtSignal(object)   # DiscoveryResult
    progress_updated = pyqtSignal(int, int, str)
    baseline_ready = pyqtSignal(object)      # DiscoveryResult (baseline)
    discovery_complete = pyqtSignal(list)    # List[DiscoveryResult]
    error_occurred = pyqtSignal(str)

    def __init__(
        self,
        scenarios: List[DiscoveryScenario],
        base_strategy_config: Dict[str, Any],
        base_backtest_config: Dict[str, Any],
        cached_bars: Any = None,        # List[Bar] — if None, loaded from data_provider
        data_provider: Any = None,      # BacktestDataProvider — used when cached_bars is None
        run_baseline: bool = True,      # Run baseline (current config) before permutations
        parent=None,
    ):
        super().__init__(parent)
        self.scenarios = scenarios
        self.base_strategy_config = base_strategy_config
        self.base_backtest_config = base_backtest_config
        self.cached_bars = cached_bars
        self.data_provider = data_provider
        self.run_baseline = run_baseline
        self._should_stop = False

    def stop(self):
        """Request early termination."""
        self._should_stop = True

    def run(self):
        """Load bars (if needed), run baseline, then run all scenarios."""
        from src.optimizer_v3.core.multicore_backtest_engine import MulticoreBacktestEngine
        from src.optimizer_v3.core.trade_registry import get_trade_registry
        import copy

        # ----------------------------------------------------------------
        # Step 1: Load bars off main thread if not already cached
        # ----------------------------------------------------------------
        bars = self.cached_bars
        if bars is None:
            if self.data_provider is None:
                self.error_occurred.emit(
                    "ConfigPermutationWorker: cached_bars is None and no data_provider supplied."
                )
                return
            try:
                self.progress_updated.emit(0, 1, "Loading bars (once for all scenarios)…")
                bars = self.data_provider.load_bars_for_backtest(
                    timeframe=self.base_backtest_config.get('timeframe', '15m'),
                    start_date=self.base_backtest_config['start_date'],
                    end_date=self.base_backtest_config['end_date'],
                )
            except Exception as exc:
                import traceback
                self.error_occurred.emit(
                    f"Failed to load bars for Config Discovery:\n{traceback.format_exc()}"
                )
                return

        engine = MulticoreBacktestEngine()

        # ----------------------------------------------------------------
        # Step 2: Baseline run (current config — comparison row)
        # ----------------------------------------------------------------
        if self.run_baseline and not self._should_stop:
            self.progress_updated.emit(0, len(self.scenarios) + 1, "Running baseline scenario…")
            baseline_scenario = DiscoveryScenario(
                scenario_id='BASELINE',
                description='[BASELINE] Current config',
                config_delta={},
                param_labels=[],
            )
            try:
                get_trade_registry().clear()
                bl_mc = engine.run_backtest(
                    bars=bars,
                    strategy_config=self.base_strategy_config,
                    backtest_config=copy.deepcopy(self.base_backtest_config),
                    progress_callback=None,
                )
                bl_trades = bl_mc.get('trades', [])
                baseline_dr = aggregate_metrics(baseline_scenario, bl_trades)
            except Exception as exc:
                import traceback
                baseline_dr = aggregate_metrics(baseline_scenario, [], error=str(exc))
                baseline_dr.error = traceback.format_exc()
            baseline_dr.scenario_id = 'BASELINE'
            self.baseline_ready.emit(baseline_dr)

        # ----------------------------------------------------------------
        # Step 3: Permutation scenarios
        # ----------------------------------------------------------------
        results: List[DiscoveryResult] = []
        total = len(self.scenarios)

        for i, scenario in enumerate(self.scenarios):
            if self._should_stop:
                break

            self.progress_updated.emit(
                i, total,
                f"Scenario {i + 1}/{total}: {scenario.description}",
            )

            try:
                # Build merged backtest config: base + delta overrides
                bc = copy.deepcopy(self.base_backtest_config)
                for key, val in scenario.config_delta.items():
                    bc = _set_nested(bc, key, val)

                # Clear trade registry between runs (avoid cross-contamination)
                get_trade_registry().clear()

                mc_results = engine.run_backtest(
                    bars=bars,
                    strategy_config=self.base_strategy_config,
                    backtest_config=bc,
                    progress_callback=None,  # No per-bar progress for discovery runs
                )

                trades = mc_results.get('trades', [])
                result = aggregate_metrics(scenario, trades)

            except Exception as exc:
                import traceback
                result = aggregate_metrics(scenario, [], error=str(exc))
                result.error = traceback.format_exc()

            results.append(result)
            self.scenario_complete.emit(result)

        self.progress_updated.emit(total, total, "Discovery complete")
        self.discovery_complete.emit(results)


# ---------------------------------------------------------------------------
# Engine facade
# ---------------------------------------------------------------------------

class ConfigPermutationEngine:
    """
    High-level facade used by BacktestConfigPanel to launch Config Discovery.

    Usage (off-main-thread bar loading — preferred):
        engine = ConfigPermutationEngine(
            base_strategy_config=...,
            base_backtest_config=...,
            data_provider=self.data_provider,   # bars loaded inside worker
        )
        scenarios = engine.build_scenarios(
            ranges=DEFAULT_PARAMETER_RANGES,
            strategy='single_axis',
        )
        worker = engine.create_worker(scenarios)
        worker.baseline_ready.connect(dialog.set_baseline)
        worker.discovery_complete.connect(on_complete)
        worker.start()

    Legacy usage (pre-loaded bars):
        engine = ConfigPermutationEngine(
            base_strategy_config=...,
            base_backtest_config=...,
            cached_bars=pre_loaded_bars,
        )
    """

    def __init__(
        self,
        base_strategy_config: Dict[str, Any],
        base_backtest_config: Dict[str, Any],
        cached_bars: Any = None,
        data_provider: Any = None,
    ):
        self.base_strategy_config = base_strategy_config
        self.base_backtest_config = base_backtest_config
        self.cached_bars = cached_bars
        self.data_provider = data_provider

    def build_scenarios(
        self,
        ranges: Optional[List[ParameterRange]] = None,
        strategy: str = 'single_axis',
        max_scenarios: Optional[int] = None,
    ) -> List[DiscoveryScenario]:
        """
        Build the list of scenarios to run.

        Args:
            ranges:         Parameter ranges to sweep (defaults to DEFAULT_PARAMETER_RANGES).
            strategy:       'single_axis' or 'pairwise'.
            max_scenarios:  Cap on total scenario count (truncate if exceeded).

        Returns:
            List of DiscoveryScenario objects.
        """
        if ranges is None:
            ranges = DEFAULT_PARAMETER_RANGES

        if strategy == 'pairwise':
            scenarios = generate_pairwise_permutations(self.base_backtest_config, ranges)
        else:
            scenarios = generate_single_axis_permutations(self.base_backtest_config, ranges)

        if max_scenarios is not None:
            scenarios = scenarios[:max_scenarios]

        return scenarios

    def create_worker(
        self,
        scenarios: List[DiscoveryScenario],
        run_baseline: bool = True,
        parent=None,
    ) -> ConfigPermutationWorker:
        """
        Create (but do not start) a worker thread for the given scenarios.

        If *data_provider* was supplied to this engine, the worker loads bars
        on its own thread (preferred — avoids UI freeze).  Otherwise the worker
        uses *cached_bars* directly.
        """
        return ConfigPermutationWorker(
            scenarios=scenarios,
            base_strategy_config=self.base_strategy_config,
            base_backtest_config=self.base_backtest_config,
            cached_bars=self.cached_bars,
            data_provider=self.data_provider,
            run_baseline=run_baseline,
            parent=parent,
        )
