"""
Building Block Intelligence Extractor
======================================

AUTO-LEARNING SYSTEM: Extracts and understands building block semantics automatically

This module solves the critical problem of hardcoded intelligence databases.
Instead of manually mapping blocks to improvements, this system:
1. Reads block metadata from registry (description, category, signals)
2. Analyzes signal names and semantics (BULLISH vs BEARISH, OVERBOUGHT vs OVERSOLD)
3. Infers block purpose from signal patterns
4. Calculates expected metric improvements based on block type
5. AUTO-UPDATES when new blocks are added to registry

Key Innovation: When you add a new building block to the registry,
this system automatically understands it without any manual configuration.

Author: Optimizer v3 Team
Date: 2026-01-23
Sprint: 1.6 (Intelligent Recommendations - COMPLETE REBUILD)
"""

from typing import Dict, List, Set, Optional, Tuple
from dataclasses import dataclass
from enum import Enum
import re

import logging
logger = logging.getLogger(__name__)

class BlockPurpose(Enum):
    """Automatically inferred block purpose categories"""
    ENTRY_CONFIRMATION = "entry_confirmation"  # Confirms entry signals
    TREND_FILTER = "trend_filter"              # Filters against/with trend
    REVERSAL_DETECTOR = "reversal_detector"    # Detects trend reversals
    CONTINUATION_FILTER = "continuation_filter" # Confirms trend continuation
    VOLATILITY_FILTER = "volatility_filter"    # Manages volatility-based risk
    RISK_MANAGEMENT = "risk_management"        # Stop loss, position sizing
    EXIT_OPTIMIZATION = "exit_optimization"    # Take profit, trailing stops
    SESSION_FILTER = "session_filter"          # Time-based filtering
    LIQUIDITY_DETECTOR = "liquidity_detector"  # Stop hunts, liquidity grabs
    STRUCTURE_BREAK = "structure_break"        # Market structure shifts
    VOLUME_CONFIRMATION = "volume_confirmation" # Volume-based validation
    MOMENTUM_SHIFT = "momentum_shift"          # Momentum indicators


class SignalImpact(Enum):
    """How signal affects trade frequency"""
    HIGHLY_RESTRICTIVE = 0.05  # 5% signal rate - very selective
    RESTRICTIVE = 0.15          # 15% signal rate - selective
    MODERATE = 0.30             # 30% signal rate - moderate
    PERMISSIVE = 0.60           # 60% signal rate - common
    NEUTRAL = 1.0               # 100% signal rate - always true


@dataclass
class SignalIntelligence:
    """Intelligence extracted from a single signal"""
    name: str
    signal_type: str  # BULLISH, BEARISH, NEUTRAL, CONFIRMATION, REJECTION
    restrictiveness: SignalImpact
    purpose: str
    metric_impacts: Dict[str, float]
    reasoning: str


@dataclass
class BlockIntelligence:
    """Complete intelligence about a building block"""
    name: str
    category: str
    purpose: BlockPurpose
    description: str
    signals: List[SignalIntelligence]
    overall_restrictiveness: float  # Combined signal frequency
    primary_metrics: List[str]  # Metrics this block primarily improves
    secondary_metrics: List[str]  # Metrics with minor improvement
    use_cases: List[str]  # When to recommend this block
    confidence: float  # How confident are we in this intelligence (0-1)
    auto_extracted: bool  # Was this extracted automatically or manually defined


class BlockIntelligenceExtractor:
    """
    AUTO-LEARNING INTELLIGENCE EXTRACTOR
    
    Analyzes building blocks from BlockRegistry and automatically extracts:
    - Signal semantics (what does each signal mean?)
    - Block purpose (what does this block do?)
    - Metric improvements (which metrics will improve?)
    - Trade frequency impact (how restrictive are the signals?)
    - Use cases (when should we recommend this?)
    
    NO HARDCODING REQUIRED - Works with ANY building block in registry
    """
    
    # Signal semantic patterns (for auto-detection)
    SIGNAL_PATTERNS = {
        'bullish': {
            'keywords': ['BULLISH', 'BUY', 'LONG', 'BOUNCE', 'SUPPORT', 'BREAKOUT', 
                        'UPTREND', 'HIGHER_HIGH', 'HIGHER_LOW', 'SPRING', 'ACCUMULATION'],
            'signal_type': 'BULLISH',
            'restrictiveness': SignalImpact.RESTRICTIVE
        },
        'bearish': {
            'keywords': ['BEARISH', 'SELL', 'SHORT', 'REJECTION', 'RESISTANCE', 'BREAKDOWN',
                        'DOWNTREND', 'LOWER_LOW', 'LOWER_HIGH', 'UPTHRUST', 'DISTRIBUTION'],
            'signal_type': 'BEARISH',
            'restrictiveness': SignalImpact.RESTRICTIVE
        },
        'overbought': {
            'keywords': ['OVERBOUGHT', 'EXTREME_HIGH'],
            'signal_type': 'BEARISH',  # Overbought is bearish signal
            'restrictiveness': SignalImpact.RESTRICTIVE
        },
        'oversold': {
            'keywords': ['OVERSOLD', 'EXTREME_LOW'],
            'signal_type': 'BULLISH',  # Oversold is bullish signal
            'restrictiveness': SignalImpact.RESTRICTIVE
        },
        'divergence': {
            'keywords': ['DIVERGENCE'],
            'signal_type': 'REVERSAL',
            'restrictiveness': SignalImpact.HIGHLY_RESTRICTIVE  # Divergence is rare
        },
        'cross': {
            'keywords': ['CROSS', 'CROSSOVER'],
            'signal_type': 'CONFIRMATION',
            'restrictiveness': SignalImpact.MODERATE
        },
        'trend': {
            'keywords': ['TREND', 'ABOVE_EMA', 'BELOW_EMA', 'STRONG_TREND'],
            'signal_type': 'FILTER',
            'restrictiveness': SignalImpact.MODERATE
        },
        'active': {
            'keywords': ['ACTIVE', 'TRIGGERED'],
            'signal_type': 'NEUTRAL',
            'restrictiveness': SignalImpact.PERMISSIVE
        },
        'zone': {
            'keywords': ['ZONE', 'LEVEL', 'FVG', 'ORDER_BLOCK'],
            'signal_type': 'CONFIRMATION',
            'restrictiveness': SignalImpact.RESTRICTIVE
        },
        'structure': {
            'keywords': ['BREAK', 'SHIFT', 'BOS', 'MSS', 'CHOCH'],
            'signal_type': 'STRUCTURE',
            'restrictiveness': SignalImpact.HIGHLY_RESTRICTIVE
        }
    }
    
    # Category to purpose mapping
    # Keys must match the plural category names stored in BlockRegistry
    CATEGORY_PURPOSE_MAP = {
        'PATTERNS': BlockPurpose.REVERSAL_DETECTOR,
        'OSCILLATORS': BlockPurpose.MOMENTUM_SHIFT,
        'TREND': BlockPurpose.TREND_FILTER,
        'SMC_ICT': BlockPurpose.LIQUIDITY_DETECTOR,
        'PRICE_LEVELS': BlockPurpose.ENTRY_CONFIRMATION,
        'SESSIONS': BlockPurpose.SESSION_FILTER,
        'VOLATILITY': BlockPurpose.VOLATILITY_FILTER,
        'RISK_MANAGEMENT': BlockPurpose.RISK_MANAGEMENT,
        'WYCKOFF': BlockPurpose.STRUCTURE_BREAK,
        'FIBONACCI': BlockPurpose.ENTRY_CONFIRMATION,
        'MARKET_STRUCTURE': BlockPurpose.STRUCTURE_BREAK,
        'ELLIOTT_WAVE': BlockPurpose.REVERSAL_DETECTOR,
        'SUPPLY_DEMAND': BlockPurpose.ENTRY_CONFIRMATION,
        'INSTITUTIONAL': BlockPurpose.VOLUME_CONFIRMATION,
        'MOVING_AVERAGES': BlockPurpose.TREND_FILTER,
        'PRICE_ACTION': BlockPurpose.ENTRY_CONFIRMATION,
        'SIGNALS': BlockPurpose.ENTRY_CONFIRMATION,
    }
    
    # Purpose to metric improvements mapping
    PURPOSE_METRICS_MAP = {
        BlockPurpose.ENTRY_CONFIRMATION: {
            'primary': ['win_rate', 'avg_loss'],
            'secondary': ['profit_factor', 'sharpe_ratio'],
            'improvements': {'win_rate': 0.12, 'avg_loss': -0.15, 'profit_factor': 0.20}
        },
        BlockPurpose.TREND_FILTER: {
            'primary': ['win_rate', 'profit_factor', 'recovery_factor'],
            'secondary': ['max_consecutive_losses'],
            'improvements': {'win_rate': 0.15, 'profit_factor': 0.30, 'recovery_factor': 0.25}
        },
        BlockPurpose.REVERSAL_DETECTOR: {
            'primary': ['win_rate', 'sharpe_ratio'],
            'secondary': ['avg_win'],
            'improvements': {'win_rate': 0.10, 'sharpe_ratio': 0.18, 'avg_win': 0.12}
        },
        BlockPurpose.VOLATILITY_FILTER: {
            'primary': ['max_drawdown_pct', 'avg_loss', 'sortino_ratio'],
            'secondary': ['calmar_ratio'],
            'improvements': {'max_drawdown_pct': -0.25, 'avg_loss': -0.20, 'sortino_ratio': 0.22}
        },
        BlockPurpose.RISK_MANAGEMENT: {
            'primary': ['max_drawdown_pct', 'avg_loss', 'max_consecutive_losses'],
            'secondary': ['recovery_factor'],
            'improvements': {'max_drawdown_pct': -0.30, 'avg_loss': -0.25, 'max_consecutive_losses': -0.35}
        },
        BlockPurpose.EXIT_OPTIMIZATION: {
            'primary': ['avg_win', 'largest_win', 'profit_factor'],
            'secondary': ['recovery_factor'],
            'improvements': {'avg_win': 0.18, 'largest_win': 0.25, 'profit_factor': 0.20}
        },
        BlockPurpose.SESSION_FILTER: {
            'primary': ['win_rate', 'profit_factor'],
            'secondary': ['avg_win'],
            'improvements': {'win_rate': 0.08, 'profit_factor': 0.15, 'avg_win': 0.10}
        },
        BlockPurpose.LIQUIDITY_DETECTOR: {
            'primary': ['win_rate', 'avg_win'],
            'secondary': ['sharpe_ratio'],
            'improvements': {'win_rate': 0.12, 'avg_win': 0.15, 'sharpe_ratio': 0.18}
        },
        BlockPurpose.STRUCTURE_BREAK: {
            'primary': ['win_rate', 'avg_loss'],
            'secondary': ['max_consecutive_losses'],
            'improvements': {'win_rate': 0.11, 'avg_loss': -0.18, 'max_consecutive_losses': -0.25}
        },
        BlockPurpose.VOLUME_CONFIRMATION: {
            'primary': ['win_rate', 'profit_factor'],
            'secondary': ['sharpe_ratio'],
            'improvements': {'win_rate': 0.09, 'profit_factor': 0.18, 'sharpe_ratio': 0.15}
        },
        BlockPurpose.MOMENTUM_SHIFT: {
            'primary': ['win_rate', 'sharpe_ratio', 'avg_loss'],
            'secondary': ['profit_factor'],
            'improvements': {'win_rate': 0.10, 'sharpe_ratio': 0.16, 'avg_loss': -0.12}
        }
    }
    
    def __init__(self):
        """Initialize extractor"""
        self.extracted_intelligence: Dict[str, BlockIntelligence] = {}
    
    def extract_from_registry(self, registry) -> Dict[str, BlockIntelligence]:
        """
        Extract intelligence from ALL blocks in BlockRegistry
        
        Args:
            registry: BlockRegistry class
        
        Returns:
            Dictionary mapping block_name -> BlockIntelligence
        """
        from src.detectors.building_blocks.registry import BlockRegistry
        
        registered_blocks = BlockRegistry.get_all_blocks()
        
        logger.info(f"🔬 Extracting intelligence from {len(registered_blocks)} registered blocks...")
        
        for block_name, metadata in registered_blocks.items():
            intelligence = self._extract_block_intelligence(block_name, metadata)
            self.extracted_intelligence[block_name] = intelligence
        
        logger.info(f"✅ Intelligence extraction complete: {len(self.extracted_intelligence)} blocks analyzed")
        
        return self.extracted_intelligence
    
    def _extract_block_intelligence(self, name: str, metadata) -> BlockIntelligence:
        """
        Extract intelligence from a single building block
        
        Analyzes:
        - Block category and description
        - Signal names and semantics
        - Inferred purpose
        - Expected metric improvements
        - Trade frequency impact
        """
        category = metadata.category.upper()
        description = metadata.description
        valid_signals = metadata.valid_signals
        
        # Extract signal intelligence
        signal_intel = []
        total_restrictiveness = 1.0
        
        for signal_name in valid_signals:
            sig_intel = self._analyze_signal(signal_name, category, description)
            signal_intel.append(sig_intel)
            # Multiply restrictiveness (AND logic assumption)
            total_restrictiveness *= sig_intel.restrictiveness.value
        
        # Infer block purpose from category
        purpose = self.CATEGORY_PURPOSE_MAP.get(category, BlockPurpose.ENTRY_CONFIRMATION)
        
        # Get metric improvements for this purpose
        purpose_data = self.PURPOSE_METRICS_MAP.get(purpose, {})
        primary_metrics = purpose_data.get('primary', ['win_rate'])
        secondary_metrics = purpose_data.get('secondary', [])
        
        # Generate use cases
        use_cases = self._generate_use_cases(purpose, primary_metrics, description)
        
        # Calculate confidence (higher if we have good signal semantic matches)
        confidence = self._calculate_extraction_confidence(signal_intel, category, description)
        
        return BlockIntelligence(
            name=name,
            category=category,
            purpose=purpose,
            description=description[:200],  # Truncate long descriptions
            signals=signal_intel,
            overall_restrictiveness=total_restrictiveness,
            primary_metrics=primary_metrics,
            secondary_metrics=secondary_metrics,
            use_cases=use_cases,
            confidence=confidence,
            auto_extracted=True
        )
    
    def _analyze_signal(self, signal_name: str, category: str, description: str) -> SignalIntelligence:
        """
        Analyze a single signal name to extract semantic meaning
        
        Uses pattern matching on signal name to determine:
        - Signal type (BULLISH, BEARISH, NEUTRAL, etc.)
        - Restrictiveness (how often does this signal fire?)
        - Purpose (what does this signal do?)
        """
        signal_upper = signal_name.upper()
        
        # Try to match signal patterns
        matched_pattern = None
        for pattern_name, pattern_data in self.SIGNAL_PATTERNS.items():
            for keyword in pattern_data['keywords']:
                if keyword in signal_upper:
                    matched_pattern = pattern_data
                    break
            if matched_pattern:
                break
        
        # Default to neutral if no match
        if not matched_pattern:
            matched_pattern = {
                'signal_type': 'NEUTRAL',
                'restrictiveness': SignalImpact.MODERATE
            }
        
        signal_type = matched_pattern['signal_type']
        restrictiveness = matched_pattern['restrictiveness']
        
        # Generate reasoning
        reasoning = self._generate_signal_reasoning(signal_name, signal_type, category)
        
        # Infer metric impacts based on signal type
        metric_impacts = self._infer_signal_metric_impacts(signal_type, restrictiveness)
        
        return SignalIntelligence(
            name=signal_name,
            signal_type=signal_type,
            restrictiveness=restrictiveness,
            purpose=reasoning,
            metric_impacts=metric_impacts,
            reasoning=reasoning
        )
    
    def _generate_signal_reasoning(self, signal_name: str, signal_type: str, category: str) -> str:
        """Generate human-readable reasoning for signal"""
        reasoning_templates = {
            'BULLISH': f"{signal_name} confirms bullish momentum/structure",
            'BEARISH': f"{signal_name} confirms bearish momentum/structure",
            'REVERSAL': f"{signal_name} indicates potential trend reversal",
            'CONFIRMATION': f"{signal_name} validates entry/exit conditions",
            'FILTER': f"{signal_name} filters trades based on market state",
            'NEUTRAL': f"{signal_name} provides market context",
            'STRUCTURE': f"{signal_name} detects market structure changes"
        }
        
        return reasoning_templates.get(signal_type, f"{signal_name} signal for {category} analysis")
    
    def _infer_signal_metric_impacts(self, signal_type: str, restrictiveness: SignalImpact) -> Dict[str, float]:
        """Infer which metrics this signal improves"""
        # More restrictive signals improve win rate more but reduce trade count
        restrictiveness_value = restrictiveness.value
        
        impacts = {}
        
        if restrictiveness_value < 0.2:  # Highly restrictive
            impacts = {'win_rate': 0.15, 'avg_loss': -0.20}
        elif restrictiveness_value < 0.4:  # Restrictive
            impacts = {'win_rate': 0.10, 'avg_loss': -0.12}
        else:  # Moderate/Permissive
            impacts = {'win_rate': 0.05, 'profit_factor': 0.08}
        
        return impacts
    
    def _generate_use_cases(self, purpose: BlockPurpose, primary_metrics: List[str], description: str) -> List[str]:
        """Generate use cases for when to recommend this block"""
        use_cases = []
        
        # Generate use case based on purpose and metrics
        for metric in primary_metrics:
            if metric == 'win_rate':
                use_cases.append(f"Add when win rate < 60% to improve entry quality")
            elif metric == 'avg_loss':
                use_cases.append(f"Add when average loss > $50 to reduce losing trade size")
            elif metric == 'max_drawdown_pct':
                use_cases.append(f"Add when max drawdown > 15% to improve risk management")
            elif metric == 'profit_factor':
                use_cases.append(f"Add when profit factor < 2.0 to improve win/loss ratio")
            elif metric == 'max_consecutive_losses':
                use_cases.append(f"Add when consecutive losses > 8 to reduce losing streaks")
        
        # Add purpose-specific use case
        purpose_use_cases = {
            BlockPurpose.TREND_FILTER: "Essential when trading against higher timeframe trend",
            BlockPurpose.LIQUIDITY_DETECTOR: "Critical for reversal strategies to catch stop hunts",
            BlockPurpose.VOLATILITY_FILTER: "Important during high volatility periods",
            BlockPurpose.RISK_MANAGEMENT: "Mandatory for drawdown control"
        }
        
        if purpose in purpose_use_cases:
            use_cases.append(purpose_use_cases[purpose])
        
        return use_cases[:3]  # Limit to top 3 use cases
    
    def _calculate_extraction_confidence(self, signal_intel: List[SignalIntelligence], 
                                        category: str, description: str) -> float:
        """
        Calculate confidence in extracted intelligence
        
        Higher confidence when:
        - Signal names match known patterns
        - Category is recognized
        - Description provides context
        """
        confidence = 0.5  # Base confidence
        
        # Boost for recognized category
        if category in self.CATEGORY_PURPOSE_MAP:
            confidence += 0.2
        
        # Boost for recognized signal patterns
        recognized_signals = sum(1 for sig in signal_intel if sig.signal_type != 'NEUTRAL')
        if signal_intel:
            confidence += 0.2 * (recognized_signals / len(signal_intel))
        
        # Boost for detailed description
        if len(description) > 50:
            confidence += 0.1
        
        return min(confidence, 0.95)  # Cap at 95% (never 100% certain)
    
    def get_intelligence(self, block_name: str) -> Optional[BlockIntelligence]:
        """Get extracted intelligence for a specific block"""
        return self.extracted_intelligence.get(block_name)
    
    def get_all_intelligence(self) -> Dict[str, BlockIntelligence]:
        """Get all extracted intelligence"""
        return self.extracted_intelligence
    
    def print_intelligence_summary(self):
        """Print summary of extracted intelligence"""
        logger.info("\n" + "=" * 80)
        logger.info("BUILDING BLOCK INTELLIGENCE SUMMARY")
        logger.info("=" * 80)
        
        by_purpose = {}
        for intel in self.extracted_intelligence.values():
            purpose = intel.purpose.value
            if purpose not in by_purpose:
                by_purpose[purpose] = []
            by_purpose[purpose].append(intel.name)
        
        logger.info(f"\nTotal Blocks: {len(self.extracted_intelligence)}")
        logger.info(f"\nBy Purpose:")
        for purpose, blocks in sorted(by_purpose.items()):
            logger.info(f"  {purpose}: {len(blocks)} blocks")
        
        avg_confidence = sum(i.confidence for i in self.extracted_intelligence.values()) / len(self.extracted_intelligence)
        logger.info(f"\nAverage Extraction Confidence: {avg_confidence:.1%}")
        logger.info("=" * 80)


if __name__ == '__main__':
    # Test extraction
    from src.detectors.building_blocks.registry import BlockRegistry
    extractor = BlockIntelligenceExtractor()
    intelligence = extractor.extract_from_registry(BlockRegistry)
    extractor.print_intelligence_summary()
    
    # Show example
    if 'liquidity_sweep' in intelligence:
        intel = intelligence['liquidity_sweep']
        logger.info(f"\n\nEXAMPLE: {intel.name}")
        logger.info(f"Purpose: {intel.purpose.value}")
        logger.info(f"Primary Metrics: {intel.primary_metrics}")
        logger.info(f"Signals: {[s.name for s in intel.signals]}")
        logger.info(f"Restrictiveness: {intel.overall_restrictiveness:.1%}")
        logger.info(f"Confidence: {intel.confidence:.1%}")
