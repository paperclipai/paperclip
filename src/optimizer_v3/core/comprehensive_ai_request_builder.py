"""
Comprehensive AI Request Builder
=================================

INSTITUTIONAL-GRADE DATA COLLECTION FOR AI REQUESTS

This module addresses the critical issues identified in Sprint 1.6:
1. ✅ Collects complete strategy configuration (blocks, signals, parameters)
2. ✅ Includes backtest configuration (timeframe, SL/TP, position sizing)
3. ✅ Provides all trade results with full details
4. ✅ Sends metrics with institutional ratings
5. ✅ Includes ALL available building blocks (83+ blocks with signals)
6. ✅ Provides signal occurrence rates and statistics

FIXES THE FOLLOWING DOCUMENTED PROBLEMS:
- AI receiving "0 trades" when UI shows "24 trades"
- Missing backtest configuration context
- Missing trade details for analysis
- Missing available blocks catalog
- Incomplete prompt structure

Author: Optimizer v3 Team  
Date: 2026-01-23
Sprint: 1.6 (AI Request System Rebuild)
"""

import json
import math
from collections import defaultdict
from typing import Dict, List, Optional, Any
from datetime import datetime
from pathlib import Path
import sys

import logging
logger = logging.getLogger(__name__)


# Add project root to path
project_root = Path(__file__).parent.parent.parent.parent  
sys.path.insert(0, str(project_root))

# Import helper methods for prompt formatting
from src.optimizer_v3.core.prompt_helper_methods import (
    identify_performance_problems,
    describe_strategy_intent,
    describe_strengths,
    describe_problems,
    analyze_trade_patterns,
    format_config_summary,
    define_primary_objective,
    format_available_blocks_summary,
    extract_relevant_config,
    extract_trade_summary,
    extract_metrics_summary,
    format_blocks_catalog
)


class ComprehensiveAIRequestBuilder:
    """
    COMPREHENSIVE AI REQUEST BUILDER
    
    Builds complete, structured AI requests with ALL necessary context:
    - Strategy configuration (complete)
    - Backtest configuration (all settings)
    - Trade results (every single trade)
    - Metrics (with ratings)
    - Available blocks catalog (all 83+ blocks)
    - Signal statistics (occurrence rates)
    """
    
    def __init__(self):
        """Initialize request builder"""
        self.block_registry = None
        self._load_block_registry()
    
    def _load_block_registry(self):
        """Load BlockRegistry for available blocks catalog"""
        try:
            from src.detectors.building_blocks.registry import BlockRegistry
            self.block_registry = BlockRegistry
            logger.info(f"✅ BlockRegistry loaded: {len(BlockRegistry.get_all_blocks())} blocks available")
        except Exception as e:
            logger.warning(f"⚠️ Could not load BlockRegistry: {e}")
            self.block_registry = None
    
    def build_complete_request(
        self,
        strategy_config: Dict,
        backtest_results: Dict,
        metrics_with_ratings: Dict[str, Dict],
        backtest_config: Optional[Dict] = None,
        analysis_report: Optional[Any] = None
    ) -> Dict[str, Any]:
        """
        Build complete AI request with ALL necessary data
        
        Args:
            strategy_config: Full strategy configuration
            backtest_results: COMPLETE backtest results (not just summary)
            metrics_with_ratings: Metrics with institutional ratings
            backtest_config: Backtest settings (timeframe, SL/TP, etc.)
            analysis_report: Optional analysis report
        
        Returns:
            Complete request data structure
        """
        logger.info("\n🔧 Building Comprehensive AI Request...")
        
        # Derive strategy direction for catalog filtering (B2/B3)
        strategy_type = (strategy_config or {}).get('strategy_type', '') if strategy_config else ''
        strategy_direction = 'BEARISH' if 'bearish' in strategy_type.lower() else 'BULLISH' if 'bullish' in strategy_type.lower() else None
        
        # Determine which blocks are already in the current strategy (for B3 compact format)
        current_block_names = set(
            b.get('name', '') for b in (strategy_config or {}).get('blocks', [])
        ) if strategy_config else set()
        
        request = {
            'metadata': self._build_metadata(),
            'strategy_configuration': self._extract_strategy_config(strategy_config),
            'backtest_configuration': self._extract_backtest_config(backtest_config, backtest_results),
            'trade_results': self._extract_trade_results(backtest_results),
            'performance_metrics': self._extract_metrics(metrics_with_ratings, backtest_results),
            'available_building_blocks': self._extract_available_blocks(
                strategy_direction=strategy_direction,
                current_block_names=current_block_names
            ),
            'signal_statistics': self._extract_signal_statistics(backtest_results),
            'analysis_context': self._extract_analysis_context(analysis_report)
        }
        
        # Validation
        self._validate_request(request)
        
        return request
    
    def _build_metadata(self) -> Dict:
        """Build metadata about the request"""
        return {
            'timestamp': datetime.now().isoformat(),
            'builder_version': '1.0.0',
            'sprint': '1.6',
            'purpose': 'Intelligent strategy optimization recommendations'
        }
    
    def _extract_strategy_config(self, config: Dict) -> Dict:
        """Extract complete strategy configuration"""
        if not config:
            return {}
        
        blocks_detail = []
        for block in config.get('blocks', []):
            block_detail = {
                'name': block.get('name', ''),
                'category': block.get('category', 'Unknown'),
                'signals': []
            }
            
            for signal in block.get('signals', []):
                signal_detail = {
                    'name': signal.get('name', ''),
                    'parameters': signal.get('parameters', {}),
                    'recheck_config': signal.get('recheck', None),
                    'timing_constraint': signal.get('timing', None)
                }
                block_detail['signals'].append(signal_detail)
            
            blocks_detail.append(block_detail)
        
        return {
            'name': config.get('name', 'Unknown Strategy'),
            'strategy_type': config.get('strategy_type', 'Unknown'),
            'description': config.get('description', ''),
            'blocks': blocks_detail,
            'total_blocks': len(blocks_detail),
            'total_signals': sum(len(b['signals']) for b in blocks_detail),
            'logic': config.get('logic', 'AND'),
            'created_date': config.get('created_date', 'Unknown'),
            'modified_date': config.get('modified_date', 'Unknown')
        }
    
    def _extract_backtest_config(self, config: Optional[Dict], results: Dict) -> Dict:
        """Extract backtest configuration settings"""
        if not config:
            # Try to extract from results if config not provided
            config = results.get('config', {})
        
        return {
            'timeframe': config.get('timeframe', results.get('timeframe', '15m')),
            'lookback_days': config.get('lookback_days', results.get('lookback_days', 180)),
            'start_date': config.get('start_date', results.get('start_date', 'Unknown')),
            'end_date': config.get('end_date', results.get('end_date', 'Unknown')),
            'position_sizing': {
                'position_size': config.get('position_size', 0.1),
                'use_dynamic_sizing': config.get('use_dynamic_sizing', False),
                'max_position_size': config.get('max_position_size', 1.0)
            },
            'risk_management': {
                'stop_loss': config.get('stop_loss', 0.02),
                'take_profit_levels': config.get('take_profit', [0.01, 0.015, 0.02]),
                'use_dynamic_tp': config.get('use_dynamic_tp', False),
                'use_adaptive_sl': config.get('use_adaptive_sl', False)
            },
            'execution': {
                'slippage': config.get('slippage', 0.0),
                'commission': config.get('commission', 0.0)
            }
        }
    
    def _extract_trade_results(self, results: Dict) -> Dict:
        """Extract ALL trade results with complete details"""
        trades = results.get('trades', [])
        
        if not trades:
            return {
                'total_trades': 0,
                'trades': [],
                'warning': '⚠️ CRITICAL: 0 trades executed - AI cannot analyze empty trade history'
            }
        
        # Extract detailed trade information
        detailed_trades = []
        for i, trade in enumerate(trades, 1):
            trade_detail = {
                'trade_number': i,
                'entry_time': str(trade.get('entry_time', 'Unknown')),
                'exit_time': str(trade.get('exit_time', 'Unknown')),
                'duration_bars': trade.get('duration_bars', 0),
                'duration_time': self._calculate_duration(trade),
                'side': trade.get('side', 'Unknown'),
                'entry_price': trade.get('entry_price', 0.0),
                'exit_price': trade.get('exit_price', 0.0),
                'position_size': trade.get('position_size', 0.0),
                'pnl': trade.get('pnl', 0.0),
                'pnl_percent': trade.get('pnl_percent', 0.0),
                'exit_reason': trade.get('exit_reason', 'Unknown'),
                'signals_fired': trade.get('signals_fired', []),
                'bars_data': {
                    'entry_bar': trade.get('entry_bar', 0),
                    'exit_bar': trade.get('exit_bar', 0),
                    'total_bars': trade.get('exit_bar', 0) - trade.get('entry_bar', 0)
                }
            }
            detailed_trades.append(trade_detail)
        
        # Calculate summary statistics
        winning_trades = [t for t in detailed_trades if t['pnl'] > 0]
        losing_trades = [t for t in detailed_trades if t['pnl'] < 0]
        
        winning_trades = [t for t in detailed_trades if t['pnl'] > 0]
        losing_trades = [t for t in detailed_trades if t['pnl'] < 0]

        base = {
            'total_trades': len(detailed_trades),
            'winning_trades': len(winning_trades),
            'losing_trades': len(losing_trades),
            'win_rate': (len(winning_trades) / len(detailed_trades) * 100) if detailed_trades else 0.0,
            'total_pnl': sum(t['pnl'] for t in detailed_trades),
            'avg_win': sum(t['pnl'] for t in winning_trades) / len(winning_trades) if winning_trades else 0.0,
            'avg_loss': sum(t['pnl'] for t in losing_trades) / len(losing_trades) if losing_trades else 0.0,
            'largest_win': max((t['pnl'] for t in winning_trades), default=0.0),
            'largest_loss': min((t['pnl'] for t in losing_trades), default=0.0),
        }

        if len(detailed_trades) > 50:
            # Use intelligent summarization instead of naive truncation
            summary = self._summarize_trades(detailed_trades)
            base.update(summary)
            base['summarization_mode'] = True
            base['note'] = (
                f'Intelligent statistical summary of all {len(detailed_trades)} trades. '
                'Raw sample of 15 representative trades included.'
            )
        else:
            base['trades'] = detailed_trades
            base['summarization_mode'] = False
            base['note'] = 'All trades included'

        return base
    
    def _summarize_trades(self, detailed_trades: List[Dict]) -> Dict:
        """
        Build an intelligent statistical summary for strategies with >50 trades.

        Returns a dict with:
        - avg_pnl_by_day_of_week: average PnL grouped by Mon-Sun
        - time_of_day_clusters: hourly PnL averages bucketed into 4 daily sessions
        - consecutive_loss_runs: stats on losing streaks
        - streak_stats: longest winning / losing streaks
        - drawdown_stats: max consecutive drawdown depth
        - trade_sample: 15 representative trades (best 5, worst 5, last 5)
        """
        # ── 1. Avg PnL by day of week ────────────────────────────────────────
        dow_pnl: Dict[int, List[float]] = defaultdict(list)   # 0=Mon … 6=Sun
        for t in detailed_trades:
            entry = t.get('entry_time', '')
            try:
                if isinstance(entry, str):
                    dt = datetime.fromisoformat(entry.replace('Z', '+00:00'))
                else:
                    dt = entry
                dow_pnl[dt.weekday()].append(t['pnl'])
            except Exception:
                pass  # unparseable timestamp — skip for this stat

        day_names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
        avg_pnl_by_dow = {
            day_names[dow]: round(sum(pnls) / len(pnls), 4)
            for dow, pnls in sorted(dow_pnl.items())
            if pnls
        }

        # ── 2. Time-of-day clusters (4 sessions) ────────────────────────────
        # Asian: 00-06, London: 07-12, NY: 13-18, Off-hours: 19-23
        session_pnl: Dict[str, List[float]] = {
            'Asian_0000_0600': [],
            'London_0700_1200': [],
            'NY_1300_1800': [],
            'OffHours_1900_2359': [],
        }
        for t in detailed_trades:
            entry = t.get('entry_time', '')
            try:
                if isinstance(entry, str):
                    dt = datetime.fromisoformat(entry.replace('Z', '+00:00'))
                else:
                    dt = entry
                h = dt.hour
                if h < 7:
                    session_pnl['Asian_0000_0600'].append(t['pnl'])
                elif h < 13:
                    session_pnl['London_0700_1200'].append(t['pnl'])
                elif h < 19:
                    session_pnl['NY_1300_1800'].append(t['pnl'])
                else:
                    session_pnl['OffHours_1900_2359'].append(t['pnl'])
            except Exception:
                pass

        time_of_day_clusters = {
            session: {
                'avg_pnl': round(sum(pnls) / len(pnls), 4) if pnls else 0.0,
                'trade_count': len(pnls),
            }
            for session, pnls in session_pnl.items()
        }

        # ── 3. Consecutive loss runs ─────────────────────────────────────────
        loss_runs: List[int] = []
        current_run = 0
        max_loss_run = 0
        for t in detailed_trades:
            if t['pnl'] < 0:
                current_run += 1
                max_loss_run = max(max_loss_run, current_run)
            else:
                if current_run > 0:
                    loss_runs.append(current_run)
                current_run = 0
        if current_run > 0:
            loss_runs.append(current_run)

        consecutive_loss_runs = {
            'max_consecutive_losses': max_loss_run,
            'avg_loss_run_length': round(sum(loss_runs) / len(loss_runs), 2) if loss_runs else 0.0,
            'total_loss_runs': len(loss_runs),
            'runs_of_3_or_more': sum(1 for r in loss_runs if r >= 3),
        }

        # ── 4. Win/loss streak stats ─────────────────────────────────────────
        win_runs: List[int] = []
        current_win_run = 0
        max_win_run = 0
        for t in detailed_trades:
            if t['pnl'] > 0:
                current_win_run += 1
                max_win_run = max(max_win_run, current_win_run)
            else:
                if current_win_run > 0:
                    win_runs.append(current_win_run)
                current_win_run = 0
        if current_win_run > 0:
            win_runs.append(current_win_run)

        streak_stats = {
            'max_win_streak': max_win_run,
            'max_loss_streak': max_loss_run,
            'avg_win_streak': round(sum(win_runs) / len(win_runs), 2) if win_runs else 0.0,
        }

        # ── 5. Drawdown stats ────────────────────────────────────────────────
        peak = 0.0
        max_drawdown = 0.0
        running_pnl = 0.0
        for t in detailed_trades:
            running_pnl += t['pnl']
            if running_pnl > peak:
                peak = running_pnl
            dd = peak - running_pnl
            if dd > max_drawdown:
                max_drawdown = dd

        drawdown_stats = {
            'max_drawdown_abs': round(max_drawdown, 4),
            'final_cumulative_pnl': round(running_pnl, 4),
        }

        # ── 6. Representative trade sample (best 5, worst 5, last 5) ─────────
        sorted_by_pnl = sorted(detailed_trades, key=lambda t: t['pnl'])
        worst_5 = sorted_by_pnl[:5]
        best_5 = sorted_by_pnl[-5:]
        last_5 = detailed_trades[-5:]
        # Deduplicate while preserving order
        seen: set = set()
        sample: List[Dict] = []
        for t in best_5 + worst_5 + last_5:
            tid = t['trade_number']
            if tid not in seen:
                seen.add(tid)
                sample.append(t)
        sample.sort(key=lambda t: t['trade_number'])

        return {
            'avg_pnl_by_day_of_week': avg_pnl_by_dow,
            'time_of_day_clusters': time_of_day_clusters,
            'consecutive_loss_runs': consecutive_loss_runs,
            'streak_stats': streak_stats,
            'drawdown_stats': drawdown_stats,
            'trade_sample': sample,
        }

    def _calculate_duration(self, trade: Dict) -> str:
        """Calculate human-readable trade duration"""
        try:
            entry = trade.get('entry_time')
            exit = trade.get('exit_time')
            if not entry or not exit:
                return 'Unknown'
            
            if isinstance(entry, str):
                entry = datetime.fromisoformat(entry.replace('Z', '+00:00'))
            if isinstance(exit, str):
                exit = datetime.fromisoformat(exit.replace('Z', '+00:00'))
            
            delta = exit - entry
            total_seconds = int(delta.total_seconds())
            
            if total_seconds < 3600:
                return f"{total_seconds // 60}m"
            elif total_seconds < 86400:
                hours = total_seconds // 3600
                mins = (total_seconds % 3600) // 60
                return f"{hours}h {mins}m"
            else:
                days = total_seconds // 86400
                hours = (total_seconds % 86400) // 3600
                return f"{days}d {hours}h"
        except Exception as e:
            return f"Unknown ({str(e)})"
    
    def _extract_metrics(self, metrics_with_ratings: Dict, backtest_results: Dict) -> Dict:
        """Extract all metrics with institutional ratings"""
        metrics = {}
        
        for key, data in metrics_with_ratings.items():
            if isinstance(data, dict):
                metrics[key] = {
                    'value': data.get('value', 0),
                    'rating': data.get('rating', ''),
                    'category': data.get('category', 'Performance'),
                    'threshold_poor': data.get('threshold_poor', None),
                    'threshold_good': data.get('threshold_good', None)
                }
        
        # Add any additional metrics from backtest_results
        for key in ['total_pnl', 'win_rate', 'profit_factor', 'sharpe_ratio', 'max_drawdown_pct']:
            if key in backtest_results and key not in metrics:
                metrics[key] = {
                    'value': backtest_results[key],
                    'rating': 'Unknown',
                    'category': 'Performance'
                }
        
        return metrics
    
    def _extract_available_blocks(
        self,
        strategy_direction: Optional[str] = None,
        current_block_names: Optional[set] = None
    ) -> List[Dict]:
        """Extract available building blocks from BlockRegistry.

        B2 — Direction filter:
            When strategy_direction is BEARISH, only BEARISH and NEUTRAL blocks
            are included in the catalog.  BULLISH-only blocks are excluded so the
            AI cannot recommend them for a short strategy.
            When strategy_direction is BULLISH (or unknown), all blocks are shown.

        B3 — Compact format for non-current blocks:
            Blocks NOT already in the strategy are emitted as a compact record
            (name, category, direction, one-line description only) to reduce
            token footprint from ~135K chars to <20K chars.
            Blocks already IN the strategy always emit the full signal-tier JSON
            so the AI can reason about existing configuration.
        """
        if not self.block_registry:
            return []
        
        if current_block_names is None:
            current_block_names = set()
            if strategy_direction is None:
                # Both params at defaults — likely a call-site that forgot to pass strategy context.
                # Blocks in the active strategy will be silently treated as "not in strategy" and
                # emitted in compact format with no signals key, causing ⚠️ Block X has NO signals!
                # warnings.  This warning surfaces any future regressions early.
                logger.warning(
                    "_extract_available_blocks() called with no strategy context "
                    "(strategy_direction=None, current_block_names=None). "
                    "All blocks will receive compact format — signals key will be absent for every block. "
                    "Pass strategy_direction and current_block_names from the active strategy config."
                )
        
        try:
            all_blocks = self.block_registry.get_all_blocks()
            
            blocks_catalog = []
            filtered_count = 0
            
            for block_name, metadata in all_blocks.items():
                # --- B2: Direction filter ---
                block_direction = getattr(metadata, 'direction', 'NEUTRAL')
                if strategy_direction == 'BEARISH' and block_direction == 'BULLISH':
                    filtered_count += 1
                    continue  # Exclude bullish-only blocks from bearish strategy catalog
                
                # Handle empty descriptions properly
                description = (metadata.description or '').strip()
                if not description:
                    description = f"{block_name.replace('_', ' ').title()} detector"
                
                is_in_strategy = block_name in current_block_names
                
                if is_in_strategy:
                    # --- B3: Full format for blocks already in strategy ---
                    block_info = {
                        'name': block_name,
                        'category': metadata.category,
                        'direction': block_direction,
                        'description': description,
                        'in_strategy': True,
                        'signals': []
                    }
                    
                    # Extract signals from signal_tiers (correct attribute name)
                    if hasattr(metadata, 'signal_tiers') and metadata.signal_tiers:
                        for signal_name, tier_info in metadata.signal_tiers.items():
                            if isinstance(tier_info, dict):
                                # Only include signals visible in Strategy Builder UI
                                ui_visible = tier_info.get('ui_visible', True)
                                if ui_visible is False:
                                    continue
                                
                                signal_description = tier_info.get('description', '')
                                if not signal_description:
                                    signal_description = signal_name.replace('_', ' ').title()
                                
                                signal_info = {
                                    'name': signal_name,
                                    'description': signal_description,
                                    'base_points': tier_info.get('base_points', tier_info.get('points', 0)),
                                    'formula': tier_info.get('formula', 'fixed')
                                }
                                block_info['signals'].append(signal_info)
                    
                    # BTCAAAAA-736: log if a full (in-strategy) block ends up with empty signals
                    if not block_info['signals']:
                        tiers = metadata.signal_tiers if metadata.signal_tiers else {}
                        logger.warning(
                            "BTCAAAAA-736 DIAG: Strategy block '%s' has EMPTY signals in catalog. "
                            "signal_tiers has %d entries. "
                            "Check: are all entries marked ui_visible=False? "
                            "block in registry: %s",
                            block_name, len(tiers), bool(metadata),
                        )
                    blocks_catalog.append(block_info)
                else:
                    # --- B3: Compact format for blocks NOT in strategy ---
                    # Only name, category, direction, and first sentence of description
                    short_desc = description.split('.')[0].strip()
                    blocks_catalog.append({
                        'name': block_name,
                        'category': metadata.category,
                        'direction': block_direction,
                        'description': short_desc,
                        'signals': [],   # Ensure key is always present; empty list for non-strategy blocks
                    })
            
            in_strategy_count = sum(1 for b in blocks_catalog if b.get('in_strategy'))
            compact_count = len(blocks_catalog) - in_strategy_count
            logger.info(
                f"   ✅ Extracted {len(blocks_catalog)} blocks "
                f"({in_strategy_count} full, {compact_count} compact, {filtered_count} filtered by direction)"
            )
            return blocks_catalog
            
        except Exception as e:
            logger.error(f"   ⚠️ Error extracting blocks: {e}")
            import traceback
            traceback.print_exc()
            return []
    
    # Keyword-based fire-rate heuristics (mirrors BlockIntelligenceExtractor.SIGNAL_PATTERNS)
    _HEURISTIC_FIRE_RATES: Dict[str, float] = {
        'DIVERGENCE':   0.05,
        'BREAK':        0.07,
        'SHIFT':        0.07,
        'BOS':          0.07,
        'MSS':          0.07,
        'CHOCH':        0.07,
        'BULLISH':      0.15,
        'BEARISH':      0.15,
        'BUY':          0.15,
        'SELL':         0.15,
        'LONG':         0.15,
        'SHORT':        0.15,
        'BOUNCE':       0.15,
        'SUPPORT':      0.15,
        'RESISTANCE':   0.15,
        'BREAKOUT':     0.15,
        'BREAKDOWN':    0.15,
        'OVERBOUGHT':   0.15,
        'OVERSOLD':     0.15,
        'ZONE':         0.15,
        'ORDER_BLOCK':  0.15,
        'FVG':          0.15,
        'SWEEP':        0.15,
        'CROSS':        0.30,
        'CROSSOVER':    0.30,
        'TREND':        0.30,
        'ABOVE_EMA':    0.30,
        'BELOW_EMA':    0.30,
        'ACTIVE':       0.60,
        'TRIGGERED':    0.60,
    }

    def _heuristic_fire_rate(self, signal_name: str) -> float:
        """
        Return an estimated fire rate (0–1) for a signal based on its name keywords.

        Order of matching: longest keyword wins (checked by iterating sorted keys).
        Falls back to 0.30 (moderate) if no keyword matches.
        """
        upper = signal_name.upper()
        # Check longest keyword matches first (descending length)
        for kw in sorted(self._HEURISTIC_FIRE_RATES, key=len, reverse=True):
            if kw in upper:
                return self._HEURISTIC_FIRE_RATES[kw]
        return 0.30  # default: moderate

    def _extract_signal_statistics(self, backtest_results: Optional[Dict] = None) -> Dict:
        """
        Extract per-signal occurrence statistics.

        Two-pass approach:
        1. **Empirical** — count how many trades in ``backtest_results`` contain each
           signal in their ``signals_fired`` list.  Fire rate = fires / total_trades.
        2. **Heuristic** — for signals present in the block registry but not observed
           in any trade, apply keyword-based estimated fire rates.

        Returns
        -------
        Dict with keys:
            - ``total_signals_available``  : int
            - ``total_trades_analysed``    : int
            - ``data_source``              : 'empirical' | 'heuristic' | 'mixed'
            - ``signal_occurrence_rates``  : {signal_name: {
                  'fires': int,
                  'fire_rate': float,   # 0–1
                  'fire_rate_pct': str, # e.g. '12.5%'
                  'classification': str, # filtering | momentum | neutral
                  'source': 'empirical' | 'heuristic'
              }}
        """
        signal_stats: Dict[str, Dict] = {}

        # ── 1. Empirical counts from trade data ─────────────────────────────
        trades = (backtest_results or {}).get('trades', [])
        total_trades = len(trades)

        empirical_fires: Dict[str, int] = {}
        for trade in trades:
            fired = trade.get('signals_fired', [])
            if isinstance(fired, list):
                for sig in fired:
                    if isinstance(sig, str):
                        empirical_fires[sig] = empirical_fires.get(sig, 0) + 1

        has_empirical = total_trades > 0 and bool(empirical_fires)

        # ── 2. Build stats from block registry signals ───────────────────────
        registry_signal_count = 0
        if self.block_registry:
            try:
                all_blocks = self.block_registry.get_all_blocks()
                for block_name, metadata in all_blocks.items():
                    if not hasattr(metadata, 'signal_tiers') or not metadata.signal_tiers:
                        continue
                    for sig_name, tier_info in metadata.signal_tiers.items():
                        if not isinstance(tier_info, dict):
                            continue
                        # Skip UI-invisible signals (same rule as _extract_available_blocks)
                        if tier_info.get('ui_visible') is False:
                            continue
                        registry_signal_count += 1
                        if sig_name in signal_stats:
                            continue  # already populated

                        if has_empirical and sig_name in empirical_fires:
                            fires = empirical_fires[sig_name]
                            rate = fires / total_trades
                            source = 'empirical'
                        elif has_empirical:
                            # Signal in registry but never fired in trades
                            fires = 0
                            rate = 0.0
                            source = 'empirical'
                        else:
                            fires = 0
                            rate = self._heuristic_fire_rate(sig_name)
                            source = 'heuristic'

                        signal_stats[sig_name] = {
                            'fires': fires,
                            'fire_rate': round(rate, 4),
                            'fire_rate_pct': f"{rate * 100:.1f}%",
                            'classification': self._classify_signal(rate),
                            'source': source,
                        }
            except Exception as e:
                logger.error(f"   ⚠️ Error building signal statistics from registry: {e}")

        # ── 3. Add empirical signals that weren't in registry ───────────────
        for sig_name, fires in empirical_fires.items():
            if sig_name not in signal_stats:
                rate = fires / total_trades if total_trades > 0 else 0.0
                signal_stats[sig_name] = {
                    'fires': fires,
                    'fire_rate': round(rate, 4),
                    'fire_rate_pct': f"{rate * 100:.1f}%",
                    'classification': self._classify_signal(rate),
                    'source': 'empirical',
                }

        # ── 4. Determine data source label ───────────────────────────────────
        sources = {v['source'] for v in signal_stats.values()}
        if sources == {'empirical'}:
            data_source = 'empirical'
        elif sources == {'heuristic'}:
            data_source = 'heuristic'
        elif sources:
            data_source = 'mixed'
        else:
            data_source = 'none'

        logger.info(
            f"   ✅ Signal statistics: {len(signal_stats)} signals, "
            f"source={data_source}, trades_analysed={total_trades}"
        )

        return {
            'total_signals_available': registry_signal_count,
            'total_trades_analysed': total_trades,
            'data_source': data_source,
            'signal_occurrence_rates': signal_stats,
        }

    @staticmethod
    def _classify_signal(fire_rate: float) -> str:
        """
        Classify signal role based on its fire rate.

        - ``filtering``  : < 20 %  — rare, used to narrow entries
        - ``momentum``   : 20–60 % — moderate, momentum/trend confirmation
        - ``neutral``    : > 60 %  — fires most of the time, broad context
        """
        if fire_rate < 0.20:
            return 'filtering'
        elif fire_rate <= 0.60:
            return 'momentum'
        else:
            return 'neutral'
    
    def _extract_analysis_context(self, analysis_report: Optional[Any]) -> Dict:
        """Extract analysis context if available"""
        if not analysis_report:
            return {'available': False}
        
        try:
            return {
                'available': True,
                'quality_score': analysis_report.strategy_quality_score if hasattr(analysis_report, 'strategy_quality_score') else None,
                'trade_frequency_assessment': analysis_report.trade_frequency.frequency_assessment if hasattr(analysis_report, 'trade_frequency') else None,
                'key_issues': analysis_report.key_issues if hasattr(analysis_report, 'key_issues') else [],
                'strengths': analysis_report.strengths if hasattr(analysis_report, 'strengths') else []
            }
        except Exception as e:
            return {'available': False, 'error': str(e)}
    
    def _validate_request(self, request: Dict):
        """Validate request completeness"""
        issues = []
        
        # Check strategy config
        if not request['strategy_configuration'].get('blocks'):
            issues.append("❌ Missing strategy blocks")
        
        # Check trades
        trade_count = request['trade_results'].get('total_trades', 0)
        if trade_count == 0:
            issues.append("⚠️ WARNING: 0 trades - AI cannot provide meaningful analysis")
        
        # Check metrics
        if not request['performance_metrics']:
            issues.append("⚠️ Missing performance metrics")
        
        # Check available blocks
        if not request['available_building_blocks']:
            issues.append("⚠️ Missing available blocks catalog")
        
        # Print validation results
        if issues:
            logger.warning("\n⚠️ Request Validation Issues:")
            for issue in issues:
                logger.info(f"   {issue}")
        else:
            logger.info("\n✅ Request validation passed - all data present")
        
        logger.info(f"\n📊 Request Summary:")
        logger.info(f"   - Strategy Blocks: {len(request['strategy_configuration'].get('blocks', []))}")
        logger.info(f"   - Total Trades: {trade_count}")
        logger.info(f"   - Metrics: {len(request['performance_metrics'])}")
        logger.info(f"   - Available Blocks: {len(request['available_building_blocks'])}")
    
    def format_for_ai_prompt(self, request: Dict) -> str:
        """
        Format complete request as AI prompt
        
        INSTITUTIONAL-GRADE PROMPT STRUCTURE:
        - Clear objective
        - Performance analysis context  
        - Specific improvement targets
        - Actionable recommendation format
        - Examples of good recommendations
        """
        
        # Extract key data sections for reference
        metrics = request['performance_metrics']
        trades = request['trade_results']
        strategy = request['strategy_configuration']
        config = request['backtest_configuration']
        
        prompt = f"""# INSTITUTIONAL TRADING STRATEGY OPTIMIZATION REQUEST

## YOUR ROLE
You are an elite quantitative trading strategist analyzing a Bitcoin futures strategy.
Your expertise: Institutional risk management, signal optimization, building block analysis.

## DATA STRUCTURE
All complete data is provided in JSON format at the end of this prompt.
DO NOT rely on summaries in this section - analyze the actual JSON data provided.

## YOUR TASK
1. Analyze the complete strategy configuration (SECTION 1 below)
2. Review all trade executions in SECTION 3 below ({trades.get('total_trades', 0)} trades total)
3. Assess performance metrics with ratings (SECTION 4 below)
4. Consider available building blocks for recommendations (SECTION 5 below)
5. Provide specific, actionable recommendations using JSON response format

**CRITICAL**: The actual number of trades is in SECTION 3's JSON data. Do NOT rely on this summary count - analyze the actual `trades` array in SECTION 3.

## ANALYTICAL FRAMEWORK

### What to Analyze:
- **Strategy Design**: Does the combination of blocks make sense? Are they complementary?
- **Trade Frequency**: Is {trades.get('total_trades', 0)} trades adequate for statistical significance?
- **Win Rate & Risk/Reward**: Analyze actual trade outcomes, not just aggregate metrics
- **Signal Quality**: Do the current blocks produce reliable signals?
- **Missing Elements**: What validation or confluence is missing?

### Red Flags to Identify:
- Win rate below 50% (coin flip)
- Sharpe ratio below 1.0 (poor risk-adjusted returns)
- Max drawdown exceeding 15% (excessive risk)
- Trade frequency too low (<3/month = insufficient data)
- Trade frequency too high (>30/month = potential overfitting)

### Key Principle:
DO NOT make assumptions. Base ALL analysis on the actual data provided in sections 1-6 below.

### Recommendation Types You Can Suggest:

1. **ADD_BLOCK**: Add a new building block to improve signal quality
   - When: Missing confluence, need additional filters
   - Example: Add `[relevant_block]` to confirm price context
   
2. **ADJUST_PARAM**: Modify strategy parameters
   - When: Win rate too low, drawdown too high, exits suboptimal
   - Example: Adjust `risk_per_trade_pct` from 10% to 5%
   
3. **ADD_TIMING**: Add session/time filters to improve trade timing
   - When: Need to avoid low-volatility periods
   - Example: Restrict entries to "ASIA" session only
   
4. **ADD_RECHECK**: Add signal recheck to reduce false signals
   - When: Too many false breakdown signals
   - Example: Recheck signals after 15 minutes before entry

### Recommendation Quality Standards:

✅ **GOOD RECOMMENDATION**:
- Addresses specific measurable problem (e.g., "Win rate 54% → target 60%")
- Uses available blocks appropriately
- Provides concrete configuration
- Realistic confidence score (0.70-0.90)
- Clear expected impact metrics

❌ **BAD RECOMMENDATION**:
- Vague ("improve risk management")
- Uses non-existent blocks
- No specific configuration
- Unrealistic confidence (>0.95)
- No measurable impact

### Example High-Quality Recommendation:

```json
{{
  "type": "ADD_BLOCK",
  "priority": 1,
  "block_name": "[relevant_block]",
  "signal_name": "[RELEVANT_SIGNAL]",
  "configuration": {{
    "parameter1": value1,
    "parameter2": value2
  }},
  "reasoning": "Current [entry_block] has [X]% win rate. Adding [relevant_block] confirmation will filter out weak signals where [condition not met], improving win rate to estimated [Y]-[Z]% based on [analysis basis].",
  "expected_impact": {{
    "win_rate": "+[X]-[Y]%",
    "trade_frequency": "-[Z]%",
    "sharpe_ratio": "+[N]"
  }},
  "confidence": 0.78,
  "warnings": [
    "Will reduce trade frequency by ~[X]% ([N] trades less per month)",
    "Requires [condition] before signal, may miss [edge case]"
  ]
}}
```

## RESPOND IN THIS EXACT JSON FORMAT:

```json
{{
  "assessment": "1-2 sentence professional summary of strategy quality",
  
  "understanding": {{
    "strategy_intent": "What this strategy is trying to do",
    "current_blocks": ["list", "of", "blocks"],
    "trade_count": {trades.get('total_trades', 0)},
    "key_strengths": ["strength1", "strength2"],
    "key_weaknesses": ["weakness1", "weakness2"]
  }},
  
  "recommendations": [
    {{
      "type": "ADD_BLOCK | ADD_TIMING | ADJUST_PARAM | ADD_RECHECK",
      "priority": 1,
      "block_name": "exact_block_name_from_available_blocks",
      "signal_name": "EXACT_SIGNAL_NAME",
      "configuration": {{
        "parameter1": value1,
        "parameter2": value2
      }},
      "reasoning": "Detailed explanation linking this to specific performance problem",
      "expected_impact": {{
        "metric1": "specific change (e.g., +5%)",
        "metric2": "specific change"
      }},
      "confidence": 0.75,
      "warnings": ["warning1", "warning2"]
    }}
  ],
  
  "implementation_order": [
    "Recommendation 1: block_name - reason",
    "Recommendation 2: block_name - reason"
  ],
  
  "overall_confidence": 0.80,
  
  "critical_notes": [
    "Any critical warnings or considerations"
  ]
}}
```

**IMPORTANT CONSTRAINTS**:
- Only recommend blocks from the Available Building Blocks list
- Every recommendation must address a specific measured problem
- Provide concrete configuration values, not placeholders
- Confidence scores between 0.60-0.90 (realistic)
- Expected impact must be measurable and specific

---

## COMPLETE DATA FOR YOUR ANALYSIS:

All data is provided in structured JSON format below.
Analyze this data directly - do not rely on summaries.

1. STRATEGY CONFIGURATION:
```json
{json.dumps(request['strategy_configuration'], indent=2)}
```

2. BACKTEST CONFIGURATION:
```json
{json.dumps(request['backtest_configuration'], indent=2)}
```

3. TRADE RESULTS ({request['trade_results']['total_trades']} trades):
```json
{json.dumps(request['trade_results'], indent=2)}
```

4. PERFORMANCE METRICS:
```json
{json.dumps(request['performance_metrics'], indent=2)}
```

5. AVAILABLE BUILDING BLOCKS ({len(request['available_building_blocks'])} blocks):
```json
{json.dumps(request['available_building_blocks'], indent=2)}
```

6. ANALYSIS CONTEXT:
```json
{json.dumps(request['analysis_context'], indent=2)}
```

7. SIGNAL OCCURRENCE STATISTICS ({len(request['signal_statistics'].get('signal_occurrence_rates', {}))} signals, source={request['signal_statistics'].get('data_source', 'unknown')}):

Use these statistics to understand how often each signal fires.
- **filtering** signals (<20% fire rate): rare, highly selective — good for narrowing entries
- **momentum** signals (20–60% fire rate): moderate frequency — good for trend confirmation
- **neutral** signals (>60% fire rate): fires most of the time — broad context only

```json
{json.dumps(request['signal_statistics'], indent=2)}
```

---

## YOUR RESPONSE:
Analyze the data above and respond in this EXACT JSON format:

{self._get_expected_response_format()}
"""
        
        return prompt
    
    def _get_expected_response_format(self) -> str:
        """Get expected response format"""
        return """{
  "assessment": "Professional analysis",
  "understanding": {
    "strategy_type": "Bearish/Bullish",
    "current_blocks": ["block1", "block2"],
    "trade_count": 24,
    "key_metrics": {}
  },
  "recommendations": [
    {
      "type": "ADD_RECHECK | ADD_TIMING | ADD_BLOCK | ADJUST_PARAM",
      "priority": 1,
      "block_name": "block_name",
      "signal_name": "SIGNAL_NAME",
      "configuration": {},
      "reasoning": "Detailed reasoning",
      "expected_impact": {},
      "confidence": 0.88,
      "warnings": []
    }
  ],
  "implementation_order": [],
  "overall_confidence": 0.87
}"""
    

# Test function
def test_request_builder():
    """Test comprehensive request builder"""
    logger.info("\n" + "="*80)
    logger.info("COMPREHENSIVE AI REQUEST BUILDER - TEST")
    logger.info("="*80)
    
    builder = ComprehensiveAIRequestBuilder()
    
    # Sample data
    strategy_config = {
        'name': 'HOD Rejection Test',
        'strategy_type': 'Bearish',
        'blocks': [
            {
                'name': 'hod',
                'category': 'PATTERN',
                'signals': [{'name': 'HOD_REJECTION'}]
            }
        ]
    }
    
    backtest_results = {
        'total_trades': 24,
        'total_pnl': 544.0,
        'win_rate': 58.3,
        'profit_factor': 1.97,
        'trades': [
            {
                'entry_time': '2025-10-01T08:00:00',
                'exit_time': '2025-10-01T12:30:00',
                'pnl': 75.50,
                'side': 'SHORT',
                'entry_bar': 100,
                'exit_bar': 1100
            }
        ] * 24
    }
    
    metrics = {
        'total_pnl': {'value': 544.0, 'rating': '✓ Good'},
        'win_rate': {'value': 58.3, 'rating': '✓ Good'}
    }
    
    backtest_config = {
        'timeframe': '15m',
        'lookback_days': 180,
        'stop_loss': 0.02,
        'take_profit': [0.01, 0.015, 0.02]
    }
    
    # Build request
    request = builder.build_complete_request(
        strategy_config,
        backtest_results,
        metrics,
        backtest_config
    )
    
    logger.info(f"\n✅ Request built successfully")
    logger.info(f"\nRequest size: {len(json.dumps(request, default=str))} bytes")
    
    # Test prompt formatting
    prompt = builder.format_for_ai_prompt(request)
    logger.info(f"Prompt size: {len(prompt)} characters")
    logger.info(f"\nFirst 500 characters of prompt:")
    logger.info(prompt[:500])
    
    logger.info("\n" + "="*80)


if __name__ == '__main__':
    test_request_builder()
