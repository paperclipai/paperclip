"""
Automated Confluence Calculator Utility
Enhancement E3 from GAP Analysis

Automatically calculates total confluence score from multiple building blocks
and determines if setup meets institutional-grade trading criteria (70+ points).
"""

from typing import List, Dict, Any
from dataclasses import dataclass
from enum import Enum

import logging
logger = logging.getLogger(__name__)

class ConfluenceLevel(Enum):
    """Confluence quality levels"""
    INSUFFICIENT = "insufficient"  # < 40 points
    LOW = "low"                    # 40-54 points
    MEDIUM = "medium"              # 55-69 points
    HIGH = "high"                  # 70-84 points
    VERY_HIGH = "very_high"        # 85-99 points
    EXCEPTIONAL = "exceptional"    # 100+ points


@dataclass
class ConfluenceResult:
    """Result of confluence calculation"""
    total_score: int
    level: ConfluenceLevel
    num_factors: int
    factors: List[Dict[str, Any]]
    tradeable: bool  # True if >= 70 points
    recommendation: str
    

class ConfluenceCalculator:
    """
    Automated confluence calculator for building block combinations.
    
    Institutional-grade threshold: 70+ points
    Optimal range: 85-100 points
    
    Usage:
        calc = ConfluenceCalculator()
        result = calc.calculate([
            {'name': 'Order Block', 'points': 25, 'details': '...'},
            {'name': 'Fair Value Gap', 'points': 20, 'details': '...'},
            {'name': 'Kill Zone', 'points': 15, 'details': '...'},
            {'name': 'Liquidity Sweep', 'points': 15, 'details': '...'}
        ])
        
        if result.tradeable:
            logger.info(f"Trade setup approved: {result.total_score} points")
    """
    
    # Institutional-grade thresholds
    TRADEABLE_THRESHOLD = 70
    OPTIMAL_MIN = 85
    OPTIMAL_MAX = 100
    
    def __init__(self):
        """Initialize confluence calculator"""
        self.max_points_per_block = 35  # Maximum from any single block
        
    def calculate(self, confluence_factors: List[Dict[str, Any]]) -> ConfluenceResult:
        """
        Calculate total confluence score from list of factors.
        
        Args:
            confluence_factors: List of dicts with 'name', 'points', and optional 'details'
            
        Returns:
            ConfluenceResult with total score and assessment
            
        Example:
            factors = [
                {'name': 'Order Block', 'points': 25},
                {'name': 'FVG', 'points': 20},
                {'name': 'Kill Zone', 'points': 15},
                {'name': 'Premium Zone', 'points': 15}
            ]
            result = calc.calculate(factors)
        """
        if not confluence_factors:
            return ConfluenceResult(
                total_score=0,
                level=ConfluenceLevel.INSUFFICIENT,
                num_factors=0,
                factors=[],
                tradeable=False,
                recommendation="No confluence factors detected - DO NOT TRADE"
            )
        
        # Validate and calculate total
        validated_factors = []
        total_score = 0
        
        for factor in confluence_factors:
            if 'name' not in factor or 'points' not in factor:
                continue
                
            points = int(factor['points'])
            
            # Validate points range
            if points < 0 or points > self.max_points_per_block:
                raise ValueError(
                    f"Invalid points {points} for {factor['name']}. "
                    f"Must be 0-{self.max_points_per_block}"
                )
            
            total_score += points
            validated_factors.append(factor)
        
        # Determine confidence level
        level = self._get_confidence_level(total_score)
        
        # Determine if tradeable (institutional-grade threshold)
        tradeable = total_score >= self.TRADEABLE_THRESHOLD
        
        # Generate recommendation
        recommendation = self._get_recommendation(total_score, len(validated_factors))
        
        return ConfluenceResult(
            total_score=total_score,
            level=level,
            num_factors=len(validated_factors),
            factors=validated_factors,
            tradeable=tradeable,
            recommendation=recommendation
        )
    
    def _get_confidence_level(self, score: int) -> ConfluenceLevel:
        """Determine confidence level from score"""
        if score >= 100:
            return ConfluenceLevel.EXCEPTIONAL
        elif score >= 85:
            return ConfluenceLevel.VERY_HIGH
        elif score >= 70:
            return ConfluenceLevel.HIGH
        elif score >= 55:
            return ConfluenceLevel.MEDIUM
        elif score >= 40:
            return ConfluenceLevel.LOW
        else:
            return ConfluenceLevel.INSUFFICIENT
    
    def _get_recommendation(self, score: int, num_factors: int) -> str:
        """Generate trading recommendation based on score"""
        if score >= 100:
            return (
                f"EXCEPTIONAL SETUP ({score} points from {num_factors} factors) - "
                "Institutional-grade confluence. High-probability trade with excellent "
                "risk-reward. Consider increasing position size within risk limits."
            )
        elif score >= self.OPTIMAL_MIN:
            return (
                f"OPTIMAL SETUP ({score} points from {num_factors} factors) - "
                "Very high confluence. Meets all institutional criteria. "
                "Execute trade with standard position size."
            )
        elif score >= self.TRADEABLE_THRESHOLD:
            return (
                f"TRADEABLE SETUP ({score} points from {num_factors} factors) - "
                "High confluence. Meets institutional-grade threshold (70+). "
                "Execute trade with standard or reduced position size."
            )
        elif score >= 55:
            return (
                f"MARGINAL SETUP ({score} points from {num_factors} factors) - "
                "Medium confluence. Below institutional threshold. "
                "Consider waiting for additional confirmation or SKIP."
            )
        elif score >= 40:
            return (
                f"WEAK SETUP ({score} points from {num_factors} factors) - "
                "Low confluence. Well below institutional threshold. "
                "SKIP this trade and wait for better setup."
            )
        else:
            return (
                f"INSUFFICIENT SETUP ({score} points from {num_factors} factors) - "
                "Insufficient confluence. DO NOT TRADE. "
                "Wait for proper confluence (70+ points required)."
            )
    
    def get_required_additional_points(self, current_score: int) -> int:
        """
        Calculate how many additional confluence points needed to reach
        institutional-grade threshold.
        
        Args:
            current_score: Current confluence score
            
        Returns:
            Points needed to reach 70 (0 if already above threshold)
        """
        if current_score >= self.TRADEABLE_THRESHOLD:
            return 0
        return self.TRADEABLE_THRESHOLD - current_score
    
    def suggest_additional_factors(
        self, 
        current_factors: List[str],
        target_score: int = 70
    ) -> List[str]:
        """
        Suggest additional confluence factors to reach target score.
        
        Args:
            current_factors: List of factor names already present
            target_score: Target confluence score (default 70)
            
        Returns:
            List of suggested additional factors to check
        """
        # Common high-value factors
        suggestions = []
        
        high_value_factors = [
            ('Wyckoff Spring/UTAD', 30),
            ('Elliott Wave 5 Divergence', 30),
            ('Order Block + FVG', 25),
            ('Liquidity Sweep', 25),
            ('Premium/Discount Zone', 20),
            ('Kill Zone', 15),
            ('Session High/Low', 15),
            ('VWAP Deviation', 20),
            ('ADX > 25', 20),
            ('Volume Confirmation', 15),
        ]
        
        for factor_name, points in high_value_factors:
            # Check if not already in current factors
            already_present = any(
                factor_name.lower() in cf.lower() 
                for cf in current_factors
            )
            if not already_present:
                suggestions.append(f"{factor_name} (+{points} points)")
        
        return suggestions[:5]  # Return top 5 suggestions


# Convenience function for quick calculations
def calculate_confluence(factors: List[Dict[str, Any]]) -> ConfluenceResult:
    """
    Quick convenience function to calculate confluence.
    
    Args:
        factors: List of confluence factor dicts
        
    Returns:
        ConfluenceResult
        
    Example:
        result = calculate_confluence([
            {'name': 'Order Block', 'points': 25},
            {'name': 'FVG', 'points': 20},
            {'name': 'Kill Zone', 'points': 15}
        ])
        logger.info(f"Total: {result.total_score}, Tradeable: {result.tradeable}")
    """
    calc = ConfluenceCalculator()
    return calc.calculate(factors)


if __name__ == "__main__":
    # Example usage
    logger.info("=" * 70)
    logger.info("CONFLUENCE CALCULATOR - Institutional Grade Analysis")
    logger.info("=" * 70)
    
    # Example 1: High confluence trade (EXECUTE)
    logger.info("\n📊 Example 1: High Confluence Setup")
    factors1 = [
        {'name': 'Order Block', 'points': 25, 'details': 'Bullish OB at $43,500'},
        {'name': 'Fair Value Gap', 'points': 20, 'details': 'FVG mitigation'},
        {'name': 'Kill Zone', 'points': 15, 'details': 'London open'},
        {'name': 'Liquidity Sweep', 'points': 15, 'details': 'Swept lows'},
        {'name': 'Premium Zone', 'points': 10, 'details': 'In discount zone'},
    ]
    
    result1 = calculate_confluence(factors1)
    logger.info(f"Total Score: {result1.total_score} points")
    logger.info(f"Level: {result1.level.value.upper()}")
    logger.error(f"Tradeable: {'✅ YES' if result1.tradeable else '❌ NO'}")
    logger.info(f"Recommendation: {result1.recommendation}")
    
    # Example 2: Insufficient confluence (SKIP)
    logger.info("\n📊 Example 2: Insufficient Setup")
    factors2 = [
        {'name': '50 EMA Break', 'points': 15},
        {'name': 'RSI Overbought', 'points': 10},
    ]
    
    result2 = calculate_confluence(factors2)
    logger.info(f"Total Score: {result2.total_score} points")
    logger.info(f"Level: {result2.level.value.upper()}")
    logger.error(f"Tradeable: {'✅ YES' if result2.tradeable else '❌ NO'}")
    logger.info(f"Recommendation: {result2.recommendation}")
    
    # Show what's needed
    calc = ConfluenceCalculator()
    needed = calc.get_required_additional_points(result2.total_score)
    logger.warning(f"\n⚠️ Additional points needed: {needed}")
    
    suggestions = calc.suggest_additional_factors(['50 EMA Break', 'RSI'])
    logger.info(f"💡 Suggested additional factors:")
    for suggestion in suggestions:
        logger.info(f"   - {suggestion}")
    
    logger.info("\n" + "=" * 70)
    logger.info("✅ Confluence Calculator Ready for Production")
    logger.info("=" * 70)
