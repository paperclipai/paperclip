"""
Multi-Timeframe Alignment Auto-Checker
Enhancement E4 from GAP Analysis

Automatically checks if multiple timeframes are aligned for institutional-grade
trade confirmation. Prevents taking trades against higher timeframe trends.
"""

from typing import Dict, List, Optional, Any
from dataclasses import dataclass
from enum import Enum

import logging
logger = logging.getLogger(__name__)

class TimeframeHierarchy(Enum):
    """Timeframe hierarchy for multi-timeframe analysis"""
    M1 = ("1min", 1, 0)
    M5 = ("5min", 5, 1)
    M15 = ("15min", 15, 2)
    M30 = ("30min", 30, 3)
    H1 = ("1hr", 60, 4)
    H4 = ("4hr", 240, 5)
    D1 = ("daily", 1440, 6)
    W1 = ("weekly", 10080, 7)
    
    def __init__(self, label: str, minutes: int, hierarchy_level: int):
        self.label = label
        self.minutes = minutes
        self.hierarchy_level = hierarchy_level


class TrendDirection(Enum):
    """Trend direction"""
    BULLISH = "bullish"
    BEARISH = "bearish"
    NEUTRAL = "neutral"
    UNKNOWN = "unknown"


class AlignmentQuality(Enum):
    """Quality of multi-timeframe alignment"""
    PERFECT = "perfect"            # All TFs aligned
    STRONG = "strong"             # HTF + execution TF aligned
    MODERATE = "moderate"          # Partial alignment
    WEAK = "weak"                 # Conflicting signals
    AGAINST_TREND = "against_trend"  # Trading against HTF


@dataclass
class TimeframeAnalysis:
    """Analysis result for a single timeframe"""
    timeframe: str
    trend: TrendDirection
    strength: float  # 0-100
    confidence: float  # 0-100
    details: Dict[str, Any]


@dataclass
class MTFAlignmentResult:
    """Result of multi-timeframe alignment check"""
    aligned: bool
    quality: AlignmentQuality
    execution_tf: str
    higher_tfs: List[str]
    timeframe_analyses: Dict[str, TimeframeAnalysis]
    confluence_score: int  # Bonus points from alignment
    recommendation: str
    warnings: List[str]


class MTFAlignmentChecker:
    """
    Multi-Timeframe Alignment Auto-Checker
    
    Checks if multiple timeframes are aligned before taking trades.
    Prevents costly mistakes of trading against higher timeframe trends.
    
    Usage:
        checker = MTFAlignmentChecker()
        
        # Check alignment for 15min trade
        result = checker.check_alignment(
            execution_tf='15min',
            timeframe_data={
                '15min': {'trend': TrendDirection.BULLISH, 'strength': 75},
                '1hr': {'trend': TrendDirection.BULLISH, 'strength': 80},
                '4hr': {'trend': TrendDirection.BULLISH, 'strength': 85}
            }
        )
        
        if result.aligned:
            logger.info(f"✅ Aligned! Confluence bonus: +{result.confluence_score} points")
        else:
            logger.error(f"❌ Not aligned: {result.recommendation}")
    """
    
    # Confluence point bonuses
    PERFECT_ALIGNMENT_BONUS = 30
    STRONG_ALIGNMENT_BONUS = 20
    MODERATE_ALIGNMENT_BONUS = 10
    
    def __init__(self):
        """Initialize MTF alignment checker"""
        self.min_strength_threshold = 60  # Minimum trend strength to consider
        
    def check_alignment(
        self,
        execution_tf: str,
        timeframe_data: Dict[str, Dict[str, Any]],
        require_htf: bool = True
    ) -> MTFAlignmentResult:
        """
        Check multi-timeframe alignment for a trade setup.
        
        Args:
            execution_tf: Timeframe for trade execution (e.g., '15min')
            timeframe_data: Dict of timeframe data with trend info
            require_htf: Require higher timeframe alignment (recommended: True)
            
        Returns:
            MTFAlignmentResult with alignment status and recommendations
            
        Example:
            result = checker.check_alignment(
                execution_tf='15min',
                timeframe_data={
                    '15min': {
                        'trend': TrendDirection.BULLISH,
                        'strength': 75,
                        'confidence': 80,
                        'details': {'ema_aligned': True}
                    },
                    '1hr': {
                        'trend': TrendDirection.BULLISH,
                        'strength': 80,
                        'confidence': 85
                    }
                }
            )
        """
        if not timeframe_data:
            return MTFAlignmentResult(
                aligned=False,
                quality=AlignmentQuality.WEAK,
                execution_tf=execution_tf,
                higher_tfs=[],
                timeframe_analyses={},
                confluence_score=0,
                recommendation="No timeframe data provided - cannot verify alignment",
                warnings=["Missing timeframe data"]
            )
        
        # Parse timeframe analyses
        analyses = {}
        for tf, data in timeframe_data.items():
            trend = data.get('trend', TrendDirection.UNKNOWN)
            if isinstance(trend, str):
                trend = TrendDirection(trend.lower())
            
            analyses[tf] = TimeframeAnalysis(
                timeframe=tf,
                trend=trend,
                strength=data.get('strength', 0.0),
                confidence=data.get('confidence', 0.0),
                details=data.get('details', {})
            )
        
        # Get execution timeframe analysis
        if execution_tf not in analyses:
            return MTFAlignmentResult(
                aligned=False,
                quality=AlignmentQuality.WEAK,
                execution_tf=execution_tf,
                higher_tfs=[],
                timeframe_analyses=analyses,
                confluence_score=0,
                recommendation=f"Execution timeframe {execution_tf} not in analysis data",
                warnings=[f"Missing {execution_tf} data"]
            )
        
        execution_analysis = analyses[execution_tf]
        
        # Identify higher timeframes
        higher_tfs = self._get_higher_timeframes(execution_tf, list(analyses.keys()))
        
        # Check alignment
        alignment_result = self._check_trend_alignment(
            execution_analysis,
            [analyses[tf] for tf in higher_tfs],
            require_htf
        )
        
        return MTFAlignmentResult(
            aligned=alignment_result['aligned'],
            quality=alignment_result['quality'],
            execution_tf=execution_tf,
            higher_tfs=higher_tfs,
            timeframe_analyses=analyses,
            confluence_score=alignment_result['confluence_score'],
            recommendation=alignment_result['recommendation'],
            warnings=alignment_result['warnings']
        )
    
    def _get_higher_timeframes(
        self,
        execution_tf: str,
        available_tfs: List[str]
    ) -> List[str]:
        """Get list of higher timeframes relative to execution timeframe"""
        # Map to hierarchy
        tf_map = {
            '1min': TimeframeHierarchy.M1,
            '5min': TimeframeHierarchy.M5,
            '15min': TimeframeHierarchy.M15,
            '30min': TimeframeHierarchy.M30,
            '1hr': TimeframeHierarchy.H1,
            '4hr': TimeframeHierarchy.H4,
            'daily': TimeframeHierarchy.D1,
            'weekly': TimeframeHierarchy.W1,
        }
        
        if execution_tf not in tf_map:
            return []
        
        exec_level = tf_map[execution_tf].hierarchy_level
        
        higher_tfs = []
        for tf in available_tfs:
            if tf in tf_map and tf_map[tf].hierarchy_level > exec_level:
                higher_tfs.append(tf)
        
        # Sort by hierarchy
        higher_tfs.sort(key=lambda x: tf_map[x].hierarchy_level)
        
        return higher_tfs
    
    def _check_trend_alignment(
        self,
        execution_analysis: TimeframeAnalysis,
        higher_tf_analyses: List[TimeframeAnalysis],
        require_htf: bool
    ) -> Dict[str, Any]:
        """Check if trends are aligned across timeframes"""
        warnings = []
        
        # Get execution trend
        exec_trend = execution_analysis.trend
        
        if exec_trend == TrendDirection.UNKNOWN:
            return {
                'aligned': False,
                'quality': AlignmentQuality.WEAK,
                'confluence_score': 0,
                'recommendation': "Execution timeframe trend unknown - DO NOT TRADE",
                'warnings': ["Unknown execution trend"]
            }
        
        if exec_trend == TrendDirection.NEUTRAL:
            warnings.append("Execution timeframe is neutral - consider waiting for clear trend")
        
        # No higher timeframes available
        if not higher_tf_analyses:
            if require_htf:
                return {
                    'aligned': False,
                    'quality': AlignmentQuality.WEAK,
                    'confluence_score': 0,
                    'recommendation': (
                        "No higher timeframe data available. "
                        "RISKY - cannot confirm alignment with HTF trend."
                    ),
                    'warnings': ["No HTF data available"]
                }
            else:
                return {
                    'aligned': True,
                    'quality': AlignmentQuality.MODERATE,
                    'confluence_score': 0,
                    'recommendation': (
                        f"Only {execution_analysis.timeframe} available - "
                        "consider checking higher timeframes for confirmation"
                    ),
                    'warnings': warnings
                }
        
        # Check alignment with higher timeframes
        aligned_count = 0
        conflicting_tfs = []
        
        for htf_analysis in higher_tf_analyses:
            if htf_analysis.trend == exec_trend:
                aligned_count += 1
            elif htf_analysis.trend != TrendDirection.NEUTRAL and \
                 htf_analysis.trend != TrendDirection.UNKNOWN:
                conflicting_tfs.append(htf_analysis.timeframe)
        
        total_htf = len(higher_tf_analyses)
        alignment_pct = (aligned_count / total_htf * 100) if total_htf > 0 else 0
        
        # Determine quality and score
        if alignment_pct == 100:
            # Perfect alignment
            quality = AlignmentQuality.PERFECT
            confluence_score = self.PERFECT_ALIGNMENT_BONUS
            aligned = True
            recommendation = (
                f"PERFECT ALIGNMENT ({aligned_count}/{total_htf} HTFs) - "
                f"All timeframes {exec_trend.value}. "
                f"Optimal setup with +{confluence_score} confluence points."
            )
        elif alignment_pct >= 75:
            # Strong alignment
            quality = AlignmentQuality.STRONG
            confluence_score = self.STRONG_ALIGNMENT_BONUS
            aligned = True
            recommendation = (
                f"STRONG ALIGNMENT ({aligned_count}/{total_htf} HTFs) - "
                f"Most timeframes {exec_trend.value}. "
                f"Good setup with +{confluence_score} confluence points."
            )
        elif alignment_pct >= 50:
            # Moderate alignment
            quality = AlignmentQuality.MODERATE
            confluence_score = self.MODERATE_ALIGNMENT_BONUS
            aligned = True
            recommendation = (
                f"MODERATE ALIGNMENT ({aligned_count}/{total_htf} HTFs) - "
                f"Partial alignment {exec_trend.value}. "
                f"Acceptable with +{confluence_score} points. Watch HTF."
            )
            warnings.append(f"Some HTFs not aligned: {', '.join(conflicting_tfs)}")
        else:
            # Weak/Against trend
            if conflicting_tfs:
                quality = AlignmentQuality.AGAINST_TREND
                confluence_score = 0
                aligned = False
                recommendation = (
                    f"⚠️ TRADING AGAINST TREND ({aligned_count}/{total_htf} aligned) - "
                    f"Higher timeframes {conflicting_tfs} are opposite direction. "
                    "HIGH RISK - Consider skipping or waiting for HTF alignment."
                )
                warnings.append("Trading against higher timeframe trend - HIGH RISK")
            else:
                quality = AlignmentQuality.WEAK
                confluence_score = 0
                aligned = False
                recommendation = (
                    f"WEAK ALIGNMENT ({aligned_count}/{total_htf} HTFs) - "
                    "Insufficient timeframe confirmation. Consider waiting."
                )
        
        return {
            'aligned': aligned,
            'quality': quality,
            'confluence_score': confluence_score,
            'recommendation': recommendation,
            'warnings': warnings
        }
    
    def get_required_timeframes(self, execution_tf: str) -> List[str]:
        """
        Get recommended higher timeframes to check for alignment.
        
        Args:
            execution_tf: Execution timeframe
            
        Returns:
            List of recommended timeframes to analyze
            
        Example:
            For 15min execution: ['15min', '1hr', '4hr']
        """
        recommendations = {
            '1min': ['1min', '5min', '15min'],
            '5min': ['5min', '15min', '1hr'],
            '15min': ['15min', '1hr', '4hr'],
            '30min': ['30min', '1hr', '4hr', 'daily'],
            '1hr': ['1hr', '4hr', 'daily'],
            '4hr': ['4hr', 'daily', 'weekly'],
            'daily': ['daily', 'weekly'],
        }
        
        return recommendations.get(execution_tf, [execution_tf])


# Convenience function
def check_mtf_alignment(
    execution_tf: str,
    timeframe_data: Dict[str, Dict[str, Any]]
) -> MTFAlignmentResult:
    """
    Quick convenience function to check multi-timeframe alignment.
    
    Args:
        execution_tf: Execution timeframe
        timeframe_data: Dictionary of timeframe trend data
        
    Returns:
        MTFAlignmentResult
        
    Example:
        result = check_mtf_alignment(
            execution_tf='15min',
            timeframe_data={
                '15min': {'trend': 'bullish', 'strength': 75},
                '1hr': {'trend': 'bullish', 'strength': 80},
                '4hr': {'trend': 'bullish', 'strength': 85}
            }
        )
    """
    checker = MTFAlignmentChecker()
    return checker.check_alignment(execution_tf, timeframe_data)


if __name__ == "__main__":
    # Example usage
    logger.info("=" * 70)
    logger.info("MULTI-TIMEFRAME ALIGNMENT CHECKER - Institutional Grade")
    logger.info("=" * 70)
    
    # Example 1: Perfect alignment (EXECUTE)
    logger.info("\n📊 Example 1: Perfect Alignment")
    result1 = check_mtf_alignment(
        execution_tf='15min',
        timeframe_data={
            '15min': {'trend': 'bullish', 'strength': 75, 'confidence': 80},
            '1hr': {'trend': 'bullish', 'strength': 80, 'confidence': 85},
            '4hr': {'trend': 'bullish', 'strength': 85, 'confidence': 90}
        }
    )
    logger.error(f"Aligned: {'✅ YES' if result1.aligned else '❌ NO'}")
    logger.info(f"Quality: {result1.quality.value.upper()}")
    logger.info(f"Confluence Bonus: +{result1.confluence_score} points")
    logger.info(f"Recommendation: {result1.recommendation}")
    
    # Example 2: Against trend (REJECT)
    logger.info("\n📊 Example 2: Trading Against Trend")
    result2 = check_mtf_alignment(
        execution_tf='15min',
        timeframe_data={
            '15min': {'trend': 'bullish', 'strength': 70, 'confidence': 75},
            '1hr': {'trend': 'bearish', 'strength': 80, 'confidence': 85},
            '4hr': {'trend': 'bearish', 'strength': 85, 'confidence': 90}
        }
    )
    logger.error(f"Aligned: {'✅ YES' if result2.aligned else '❌ NO'}")
    logger.info(f"Quality: {result2.quality.value.upper()}")
    logger.info(f"Confluence Bonus: +{result2.confluence_score} points")
    logger.info(f"Recommendation: {result2.recommendation}")
    if result2.warnings:
        logger.info(f"Warnings: {', '.join(result2.warnings)}")
    
    # Example 3: Moderate alignment
    logger.info("\n📊 Example 3: Moderate Alignment")
    result3 = check_mtf_alignment(
        execution_tf='15min',
        timeframe_data={
            '15min': {'trend': 'bullish', 'strength': 75, 'confidence': 80},
            '1hr': {'trend': 'bullish', 'strength': 70, 'confidence': 75},
            '4hr': {'trend': 'neutral', 'strength': 50, 'confidence': 60},
            'daily': {'trend': 'bearish', 'strength': 65, 'confidence': 70}
        }
    )
    logger.error(f"Aligned: {'✅ YES' if result3.aligned else '❌ NO'}")
    logger.info(f"Quality: {result3.quality.value.upper()}")
    logger.info(f"Confluence Bonus: +{result3.confluence_score} points")
    logger.info(f"Recommendation: {result3.recommendation}")
    
    # Show recommended timeframes
    checker = MTFAlignmentChecker()
    recommended = checker.get_required_timeframes('15min')
    logger.info(f"\n💡 Recommended timeframes for 15min execution: {', '.join(recommended)}")
    
    logger.info("\n" + "=" * 70)
    logger.info("✅ Multi-Timeframe Alignment Checker Ready for Production")
    logger.info("=" * 70)
