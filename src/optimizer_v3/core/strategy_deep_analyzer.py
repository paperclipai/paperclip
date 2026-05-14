"""
Strategy Deep Analyzer
======================

DEEP STRATEGY UNDERSTANDING: Analyzes current strategy configuration in institutional detail

This module provides the intelligence to understand:
1. What blocks are currently in the strategy and WHY
2. How signals interact (AND/OR logic, timing dependencies)
3. Current trade frequency and signal interaction effects
4. Root causes of poor metrics (not just "it's low")
5. Strategy gaps (missing components)
6. Signal sequence optimization opportunities

This is the "brain" that reads strategy configuration and provides
expert-level analysis before making recommendations.

Author: Optimizer v3 Team
Date: 2026-01-23
Sprint: 1.6 (Intelligent Recommendations - COMPLETE REBUILD)
"""

from typing import Dict, List, Optional, Tuple, Set
from dataclasses import dataclass
from enum import Enum
import math

from src.optimizer_v3.core.block_intelligence_extractor import (
    BlockIntelligenceExtractor,
    BlockIntelligence,
    BlockPurpose
)

import logging
logger = logging.getLogger(__name__)



class RootCause(Enum):
    """Root causes for poor metric performance"""
    TOO_FEW_TRADES = "too_few_trades"  # Not enough data
    TOO_MANY_FALSE_ENTRIES = "too_many_false_entries"  # Win rate low, many trades
    MISSING_TREND_FILTER = "missing_trend_filter"  # Trading against trend
    MISSING_RISK_MANAGEMENT = "missing_risk_management"  # No drawdown control
    POOR_EXIT_STRATEGY = "poor_exit_strategy"  # Wins giving back gains
    CHOPPY_MARKET_EXPOSURE = "choppy_market_exposure"  # No volatility filter
    SIGNAL_OVERTIGHTNESS = "signal_overtightness"  # Too many restrictive filters
    MISSING_ENTRY_CONFIRMATION = "missing_entry_confirmation"  # Too loose
    SIGNAL_SEQUENCE_WRONG = "signal_sequence_wrong"  # Wrong timing order
    INADEQUATE_SIGNAL_VALIDATION = "inadequate_signal_validation"  # Missing rechecks


@dataclass
class TradeFrequencyAnalysis:
    """Analysis of trade frequency and signal interactions"""
    current_trades_per_year: int
    current_trades_per_month: float
    signal_frequency_product: float  # Combined probability of all signals
    individual_signal_rates: Dict[str, float]  # Each signal's estimated frequency
    frequency_assessment: str  # "TOO_LOW", "LOW", "OPTIMAL", "HIGH"
    frequency_risk: str  # Risk of overfitting due to low trades
    minimum_needed_for_validation: int  # Min trades for statistical validity


@dataclass
class StrategyGaps:
    """Identified gaps in strategy configuration"""
    missing_purposes: List[BlockPurpose]  # Block purposes not covered
    coverage_score: float  # 0-1, how well strategy covers key purposes
    critical_gaps: List[str]  # Critical missing components
    nice_to_have_gaps: List[str]  # Non-critical improvements
    redundant_blocks: List[str]  # Blocks that overlap too much


@dataclass
class SignalInteraction:
    """Analysis of how signals interact"""
    logic_type: str  # "AND" or "OR"
    interaction_factor: float  # How much signals reduce trade frequency
    complementary: bool  # Do signals complement each other?
    conflicting: bool  # Do signals potentially conflict?
    sequence_matters: bool  # Is timing sequence important?
    timing_dependencies: List[Tuple[str, str, int]]  # (from, to, max_candles)


@dataclass
class RootCauseAnalysis:
    """Deep analysis of why metrics are poor"""
    root_causes: List[RootCause]  # Identified root causes
    primary_cause: RootCause  # Most likely root cause
    confidence: float  # 0-1, confidence in diagnosis
    reasoning: str  # Detailed explanation
    supporting_evidence: List[str]  # Data points supporting diagnosis


@dataclass
class StrategyAnalysisReport:
    """Complete strategy analysis report"""
    # Current state
    strategy_name: str
    num_blocks: int
    num_signals: int
    block_names: List[str]
    
    # Trade frequency
    trade_frequency: TradeFrequencyAnalysis
    
    # Strategy gaps
    gaps: StrategyGaps
    
    # Signal interactions
    signal_interactions: SignalInteraction
    
    # Root cause analysis for each poor metric
    root_causes: Dict[str, RootCauseAnalysis]  # metric -> root cause
    
    # Overall assessment
    strategy_quality_score: float  # 0-10
    key_issues: List[str]
    strengths: List[str]


class StrategyDeepAnalyzer:
    """
    INSTITUTIONAL-GRADE STRATEGY ANALYZER
    
    Performs deep analysis of strategy configuration to understand:
    - What the strategy is trying to do
    - Why metrics might be poor
    - What's missing
    - How signals interact
    - Trade frequency impacts
    - Root causes of issues
    
    This provides the intelligence needed for sophisticated recommendations.
    """
    
    def __init__(self, intelligence_extractor: BlockIntelligenceExtractor):
        """
        Initialize analyzer with intelligence extractor
        
        Args:
            intelligence_extractor: Extractor with block intelligence
        """
        self.intelligence = intelligence_extractor
        self.intelligence_db = intelligence_extractor.get_all_intelligence()
    
    def analyze_strategy(
        self,
        strategy_config,
        backtest_results: Dict,
        lookback_days: int = 180
    ) -> StrategyAnalysisReport:
        """
        Perform deep analysis of strategy configuration
        
        Args:
            strategy_config: Strategy configuration object with blocks, signals
            backtest_results: Dictionary with metric results
            lookback_days: Days of backtest data
        
        Returns:
            Complete strategy analysis report
        """
        logger.info("🔍 Beginning deep strategy analysis...")
        
        # Extract strategy components
        blocks = self._extract_blocks(strategy_config)
        signals = self._extract_all_signals(strategy_config)
        
        # Analyze trade frequency
        trade_freq = self._analyze_trade_frequency(
            backtest_results.get('num_trades', 0),
            lookback_days,
            blocks,
            signals
        )
        
        # Identify gaps
        gaps = self._identify_strategy_gaps(blocks)
        
        # Analyze signal interactions
        interactions = self._analyze_signal_interactions(strategy_config, blocks)
        
        # Root cause analysis for each poor metric
        root_causes = self._analyze_root_causes(
            backtest_results,
            blocks,
            gaps,
            trade_freq
        )
        
        # Calculate quality score
        quality_score = self._calculate_quality_score(
            backtest_results,
            gaps,
            trade_freq
        )
        
        # Identify key issues and strengths
        key_issues = self._identify_key_issues(root_causes, gaps, trade_freq)
        strengths = self._identify_strengths(backtest_results, blocks, trade_freq)
        
        report = StrategyAnalysisReport(
            strategy_name=getattr(strategy_config, 'name', 'Unknown'),
            num_blocks=len(blocks),
            num_signals=len(signals),
            block_names=blocks,
            trade_frequency=trade_freq,
            gaps=gaps,
            signal_interactions=interactions,
            root_causes=root_causes,
            strategy_quality_score=quality_score,
            key_issues=key_issues,
            strengths=strengths
        )
        
        logger.info("✅ Strategy analysis complete")
        return report
    
    def _extract_blocks(self, strategy_config) -> List[str]:
        """Extract block names from strategy configuration"""
        blocks = []
        
        if hasattr(strategy_config, 'blocks'):
            for block in strategy_config.blocks:
                if hasattr(block, 'name'):
                    blocks.append(block.name)
        
        return blocks
    
    def _extract_all_signals(self, strategy_config) -> List[str]:
        """Extract all signal names from strategy"""
        signals = []
        
        if hasattr(strategy_config, 'blocks'):
            for block in strategy_config.blocks:
                if hasattr(block, 'signals'):
                    for signal in block.signals:
                        if hasattr(signal, 'name'):
                            signals.append(f"{block.name}::{signal.name}")
        
        return signals
    
    def _analyze_trade_frequency(
        self,
        actual_trades: int,
        lookback_days: int,
        blocks: List[str],
        signals: List[str]
    ) -> TradeFrequencyAnalysis:
        """
        Analyze trade frequency and signal interaction effects
        
        CRITICAL: This calculates how signals multiply to reduce trade frequency
        """
        # Calculate trades per year/month
        days_per_year = 365
        trades_per_year = (actual_trades / lookback_days) * days_per_year
        trades_per_month = trades_per_year / 12
        
        # Estimate individual signal frequencies
        signal_rates = {}
        combined_probability = 1.0
        
        for block_name in blocks:
            intel = self.intelligence_db.get(block_name)
            if intel:
                # Use extracted restrictiveness
                signal_rates[block_name] = intel.overall_restrictiveness
                combined_probability *= intel.overall_restrictiveness
        
        # Assess frequency
        if trades_per_month < 3:
            frequency_assessment = "TOO_LOW"
            risk = "HIGH"  # High risk of overfitting
        elif trades_per_month < 8:
            frequency_assessment = "LOW"
            risk = "MODERATE"
        elif trades_per_month < 20:
            frequency_assessment = "OPTIMAL"
            risk = "LOW"
        else:
            frequency_assessment = "HIGH"
            risk = "LOW"
        
        # Minimum trades for statistical validity (rule of thumb: 30+ trades)
        min_needed = max(30, int(len(blocks) * 10))  # At least 10x number of parameters
        
        return TradeFrequencyAnalysis(
            current_trades_per_year=int(trades_per_year),
            current_trades_per_month=trades_per_month,
            signal_frequency_product=combined_probability,
            individual_signal_rates=signal_rates,
            frequency_assessment=frequency_assessment,
            frequency_risk=risk,
            minimum_needed_for_validation=min_needed
        )
    
    def _identify_strategy_gaps(self, blocks: List[str]) -> StrategyGaps:
        """
        Identify missing components in strategy
        
        Key purposes every strategy should consider:
        - ENTRY_CONFIRMATION: Validates entry signals
        - TREND_FILTER: Aligns with higher timeframe
        - RISK_MANAGEMENT: Controls drawdowns
        """
        # Get purposes covered by current blocks
        covered_purposes = set()
        for block_name in blocks:
            intel = self.intelligence_db.get(block_name)
            if intel:
                covered_purposes.add(intel.purpose)
        
        # Critical purposes every strategy needs
        critical_purposes = {
            BlockPurpose.ENTRY_CONFIRMATION,
            BlockPurpose.RISK_MANAGEMENT
        }
        
        # Important purposes for robust strategies
        important_purposes = {
            BlockPurpose.TREND_FILTER,
            BlockPurpose.VOLATILITY_FILTER
        }
        
        # Find gaps
        missing_critical = critical_purposes - covered_purposes
        missing_important = important_purposes - covered_purposes
        missing_all = set(BlockPurpose) - covered_purposes
        
        # Generate gap descriptions
        critical_gaps = []
        for purpose in missing_critical:
            critical_gaps.append(f"CRITICAL: Missing {purpose.value} - strategy lacks essential component")
        
        nice_to_have = []
        for purpose in missing_important:
            nice_to_have.append(f"Missing {purpose.value} - would improve robustness")
        
        # Calculate coverage score
        total_purposes = len(BlockPurpose)
        covered_count = len(covered_purposes)
        coverage_score = covered_count / total_purposes
        
        # Check for redundancy
        redundant = self._detect_redundant_blocks(blocks)
        
        return StrategyGaps(
            missing_purposes=list(missing_all),
            coverage_score=coverage_score,
            critical_gaps=critical_gaps,
            nice_to_have_gaps=nice_to_have,
            redundant_blocks=redundant
        )
    
    def _detect_redundant_blocks(self, blocks: List[str]) -> List[str]:
        """Detect blocks that serve similar purposes"""
        purpose_blocks = {}
        
        for block_name in blocks:
            intel = self.intelligence_db.get(block_name)
            if intel:
                purpose = intel.purpose
                if purpose not in purpose_blocks:
                    purpose_blocks[purpose] = []
                purpose_blocks[purpose].append(block_name)
        
        # If more than 2 blocks serve same purpose, might be redundant
        redundant = []
        for purpose, block_list in purpose_blocks.items():
            if len(block_list) > 2:
                redundant.extend(block_list[2:])  # 3rd block onwards might be redundant
        
        return redundant
    
    def _analyze_signal_interactions(
        self,
        strategy_config,
        blocks: List[str]
    ) -> SignalInteraction:
        """
        Analyze how signals interact with each other
        
        Key questions:
        - Are they combined with AND or OR?
        - Do they complement or conflict?
        - Is sequence important?
        """
        # Simplified analysis (would need full config object for complete analysis)
        # Assume AND logic between blocks (conservative)
        logic_type = "AND"
        
        # Calculate interaction factor (multiplicative for AND)
        interaction_factor = 1.0
        for block_name in blocks:
            intel = self.intelligence_db.get(block_name)
            if intel:
                interaction_factor *= intel.overall_restrictiveness
        
        # Check for complementary signals
        purposes = set()
        for block_name in blocks:
            intel = self.intelligence_db.get(block_name)
            if intel:
                purposes.add(intel.purpose)
        
        complementary = len(purposes) >= 2  # Different purposes = complementary
        
        # Check for potential conflicts (e.g., two reversal detectors)
        purpose_counts = {}
        for block_name in blocks:
            intel = self.intelligence_db.get(block_name)
            if intel:
                purpose = intel.purpose
                purpose_counts[purpose] = purpose_counts.get(purpose, 0) + 1
        
        conflicting = any(count > 2 for count in purpose_counts.values())
        
        # Sequence matters for entry confirmation after trend filter
        has_trend = BlockPurpose.TREND_FILTER in purposes
        has_entry = BlockPurpose.ENTRY_CONFIRMATION in purposes
        sequence_matters = has_trend and has_entry
        
        return SignalInteraction(
            logic_type=logic_type,
            interaction_factor=interaction_factor,
            complementary=complementary,
            conflicting=conflicting,
            sequence_matters=sequence_matters,
            timing_dependencies=[]  # Would extract from config if available
        )
    
    def _analyze_root_causes(
        self,
        metrics: Dict,
        blocks: List[str],
        gaps: StrategyGaps,
        trade_freq: TradeFrequencyAnalysis
    ) -> Dict[str, RootCauseAnalysis]:
        """
        Identify root causes for each poor metric
        
        This is the EXPERT ANALYSIS that understands WHY metrics are poor
        """
        root_causes = {}
        
        # Analyze win rate
        win_rate = metrics.get('win_rate', 0)
        if win_rate < 60:
            root_causes['win_rate'] = self._diagnose_low_win_rate(
                win_rate,
                metrics,
                blocks,
                gaps,
                trade_freq
            )
        
        # Analyze profit factor
        profit_factor = metrics.get('profit_factor', 0)
        if profit_factor < 2.0:
            root_causes['profit_factor'] = self._diagnose_low_profit_factor(
                profit_factor,
                metrics,
                blocks,
                gaps
            )
        
        # Analyze max drawdown
        max_dd = metrics.get('max_drawdown_pct', 0)
        if max_dd > 15:
            root_causes['max_drawdown_pct'] = self._diagnose_high_drawdown(
                max_dd,
                metrics,
                blocks,
                gaps
            )
        
        # Analyze consecutive losses
        max_consec = metrics.get('max_consecutive_losses', 0)
        if max_consec > 8:
            root_causes['max_consecutive_losses'] = self._diagnose_consecutive_losses(
                max_consec,
                metrics,
                blocks,
                gaps
            )
        
        return root_causes
    
    def _diagnose_low_win_rate(
        self,
        win_rate: float,
        metrics: Dict,
        blocks: List[str],
        gaps: StrategyGaps,
        trade_freq: TradeFrequencyAnalysis
    ) -> RootCauseAnalysis:
        """Diagnose why win rate is low"""
        num_trades = metrics.get('num_trades', 0)
        
        # Too few trades?
        if trade_freq.frequency_assessment == "TOO_LOW":
            return RootCauseAnalysis(
                root_causes=[RootCause.TOO_FEW_TRADES],
                primary_cause=RootCause.TOO_FEW_TRADES,
                confidence=0.9,
                reasoning=f"Win rate {win_rate:.1f}% based on only {num_trades} trades - insufficient sample size",
                supporting_evidence=[
                    f"Only {trade_freq.current_trades_per_month:.1f} trades/month",
                    f"Need minimum {trade_freq.minimum_needed_for_validation} trades for validation",
                    "Low sample size makes win rate unreliable"
                ]
            )
        
        # Many trades but low win rate = too many false entries
        if num_trades > 30 and win_rate < 50:
            missing_entry_conf = BlockPurpose.ENTRY_CONFIRMATION not in [
                self.intelligence_db[b].purpose for b in blocks if b in self.intelligence_db
            ]
            
            if missing_entry_conf:
                return RootCauseAnalysis(
                    root_causes=[RootCause.MISSING_ENTRY_CONFIRMATION],
                    primary_cause=RootCause.MISSING_ENTRY_CONFIRMATION,
                    confidence=0.85,
                    reasoning=f"Win rate {win_rate:.1f}% with {num_trades} trades indicates too many false entries",
                    supporting_evidence=[
                        "No entry confirmation block detected",
                        f"Win rate below 50% ({win_rate:.1f}%)",
                        "Strategy likely taking low-quality signals"
                    ]
                )
        
        # Missing trend filter?
        missing_trend = BlockPurpose.TREND_FILTER not in [
            self.intelligence_db[b].purpose for b in blocks if b in self.intelligence_db
        ]
        
        if missing_trend:
            return RootCauseAnalysis(
                root_causes=[RootCause.MISSING_TREND_FILTER],
                primary_cause=RootCause.MISSING_TREND_FILTER,
                confidence=0.75,
                reasoning="Win rate likely suffering from trading against trend",
                supporting_evidence=[
                    "No trend filter detected in strategy",
                    "Win rate below optimal",
                    "Strategy may be taking counter-trend trades"
                ]
            )
        
        # Default: too many false entries
        return RootCauseAnalysis(
            root_causes=[RootCause.TOO_MANY_FALSE_ENTRIES],
            primary_cause=RootCause.TOO_MANY_FALSE_ENTRIES,
            confidence=0.65,
            reasoning="Win rate indicates entry signals need improvement",
            supporting_evidence=[
                f"Win rate {win_rate:.1f}% below target (60%)",
                "Entry quality needs enhancement"
            ]
        )
    
    def _diagnose_low_profit_factor(
        self,
        profit_factor: float,
        metrics: Dict,
        blocks: List[str],
        gaps: StrategyGaps
    ) -> RootCauseAnalysis:
        """Diagnose why profit factor is low"""
        avg_win = metrics.get('avg_win', 0)
        avg_loss = metrics.get('avg_loss', 0)
        
        # Check if exits are the issue
        has_exit_opt = BlockPurpose.EXIT_OPTIMIZATION in [
            self.intelligence_db[b].purpose for b in blocks if b in self.intelligence_db
        ]
        
        if not has_exit_opt and avg_win > 0 and avg_loss > 0:
            if avg_win / abs(avg_loss) < 1.5:
                return RootCauseAnalysis(
                    root_causes=[RootCause.POOR_EXIT_STRATEGY],
                    primary_cause=RootCause.POOR_EXIT_STRATEGY,
                    confidence=0.80,
                    reasoning=f"Profit factor {profit_factor:.2f} limited by poor risk/reward ratio",
                    supporting_evidence=[
                        f"Average win (${avg_win:.2f}) only {avg_win/abs(avg_loss):.2f}x average loss",
                        "No exit optimization block detected",
                        "Winners not being maximized"
                    ]
                )
        
        return RootCauseAnalysis(
            root_causes=[RootCause.POOR_EXIT_STRATEGY],
            primary_cause=RootCause.POOR_EXIT_STRATEGY,
            confidence=0.70,
            reasoning="Profit factor suggests exit strategy needs optimization",
            supporting_evidence=[
                f"Profit factor {profit_factor:.2f} below target (2.0)",
                "Win/loss ratio suboptimal"
            ]
        )
    
    def _diagnose_high_drawdown(
        self,
        max_dd: float,
        metrics: Dict,
        blocks: List[str],
        gaps: StrategyGaps
    ) -> RootCauseAnalysis:
        """Diagnose why drawdown is high"""
        has_risk_mgmt = BlockPurpose.RISK_MANAGEMENT in [
            self.intelligence_db[b].purpose for b in blocks if b in self.intelligence_db
        ]
        
        if not has_risk_mgmt:
            return RootCauseAnalysis(
                root_causes=[RootCause.MISSING_RISK_MANAGEMENT],
                primary_cause=RootCause.MISSING_RISK_MANAGEMENT,
                confidence=0.90,
                reasoning=f"Max drawdown {max_dd:.1f}% indicates missing risk management",
                supporting_evidence=[
                    "No risk management block detected (ATR, position sizing, etc.)",
                    f"Drawdown {max_dd:.1f}% exceeds acceptable level (15%)",
                    "CRITICAL: Risk controls mandatory"
                ]
            )
        
        return RootCauseAnalysis(
            root_causes=[RootCause.MISSING_RISK_MANAGEMENT],
            primary_cause=RootCause.MISSING_RISK_MANAGEMENT,
            confidence=0.75,
            reasoning="Drawdown suggests risk management ineffective",
            supporting_evidence=[
                f"Max drawdown {max_dd:.1f}% above acceptable threshold"
            ]
        )
    
    def _diagnose_consecutive_losses(
        self,
        max_consec: int,
        metrics: Dict,
        blocks: List[str],
        gaps: StrategyGaps
    ) -> RootCauseAnalysis:
        """Diagnose why consecutive losses are high"""
        has_volatility = BlockPurpose.VOLATILITY_FILTER in [
            self.intelligence_db[b].purpose for b in blocks if b in self.intelligence_db
        ]
        
        if not has_volatility:
            return RootCauseAnalysis(
                root_causes=[RootCause.CHOPPY_MARKET_EXPOSURE],
                primary_cause=RootCause.CHOPPY_MARKET_EXPOSURE,
                confidence=0.85,
                reasoning=f"Consecutive losses ({max_consec}) suggest trading in choppy markets",
                supporting_evidence=[
                    "No volatility/choppy market filter (ADX, ATR, etc.)",
                    f"Consecutive losses {max_consec} exceed acceptable (8)",
                    "Strategy likely trading in ranging conditions"
                ]
            )
        
        return RootCauseAnalysis(
            root_causes=[RootCause.CHOPPY_MARKET_EXPOSURE],
            primary_cause=RootCause.CHOPPY_MARKET_EXPOSURE,
            confidence=0.70,
            reasoning="Consecutive losses indicate poor market condition filtering",
            supporting_evidence=[
                f"Max consecutive losses: {max_consec}"
            ]
        )
    
    def _calculate_quality_score(
        self,
        metrics: Dict,
        gaps: StrategyGaps,
        trade_freq: TradeFrequencyAnalysis
    ) -> float:
        """Calculate overall strategy quality score (0-10)"""
        score = 5.0  # Base score
        
        # Metric-based adjustments
        win_rate = metrics.get('win_rate', 0)
        if win_rate >= 60:
            score += 2
        elif win_rate >= 50:
            score += 1
        else:
            score -= 1
        
        profit_factor = metrics.get('profit_factor', 0)
        if profit_factor >= 2.0:
            score += 2
        elif profit_factor >= 1.5:
            score += 1
        else:
            score -= 1
        
        # Coverage-based adjustments
        score += gaps.coverage_score * 2  # Up to +2 for full coverage
        
        # Trade frequency penalty
        if trade_freq.frequency_assessment == "TOO_LOW":
            score -= 2
        elif trade_freq.frequency_assessment == "LOW":
            score -= 0.5
        
        return max(0, min(10, score))
    
    def _identify_key_issues(
        self,
        root_causes: Dict[str, RootCauseAnalysis],
        gaps: StrategyGaps,
        trade_freq: TradeFrequencyAnalysis
    ) -> List[str]:
        """Identify key issues from analysis"""
        issues = []
        
        # Critical gaps
        issues.extend(gaps.critical_gaps)
        
        # Root cause issues
        for metric, analysis in root_causes.items():
            if analysis.confidence >= 0.75:
                issues.append(f"{metric}: {analysis.reasoning}")
        
        # Trade frequency issues
        if trade_freq.frequency_assessment == "TOO_LOW":
            issues.append(f"CRITICAL: Only {trade_freq.current_trades_per_month:.1f} trades/month - insufficient for validation")
        
        return issues[:5]  # Top 5 issues
    
    def _identify_strengths(
        self,
        metrics: Dict,
        blocks: List[str],
        trade_freq: TradeFrequencyAnalysis
    ) -> List[str]:
        """Identify strategy strengths"""
        strengths = []
        
        # Metric strengths
        win_rate = metrics.get('win_rate', 0)
        if win_rate >= 60:
            strengths.append(f"Strong win rate ({win_rate:.1f}%)")
        
        profit_factor = metrics.get('profit_factor', 0)
        if profit_factor >= 2.0:
            strengths.append(f"Excellent profit factor ({profit_factor:.2f})")
        
        # Configuration strengths
        if len(blocks) >= 3:
            strengths.append(f"Good signal diversity ({len(blocks)} blocks)")
        
        if trade_freq.frequency_assessment == "OPTIMAL":
            strengths.append(f"Optimal trade frequency ({trade_freq.current_trades_per_month:.1f}/month)")
        
        return strengths
