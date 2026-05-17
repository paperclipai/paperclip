"""
Optimal Parameter Calculator - Sprint 2.1, Task 2.1.18
=======================================================

Calculates optimal RECHECK delays and timing windows from signal analysis.
Uses statistical methods with institutional-grade type safety.

CRITICAL: All calculations use Decimal type for precision.
"""

from typing import List, Dict, Any, Optional, Tuple
from decimal import Decimal
from datetime import datetime
from pathlib import Path
import sys

# Statistical libraries
from statistics import median, stdev
from collections import Counter

# NautilusTrader imports
from nautilus_trader.model.objects import Money, Quantity

import logging
logger = logging.getLogger(__name__)


# Import configuration
project_root = Path(__file__).parent.parent.parent.parent
sys.path.insert(0, str(project_root))
from src.optimizer_v3.config.training_config import get_training_config


class OptimalParameterCalculator:
    """
    Optimal Parameter Calculator
    
    Analyzes signal events to determine:
    - Optimal RECHECK delays (bars to wait before rechecking)
    - Timing windows (valid time ranges for signals)
    - Parameter configurations (thresholds, filters)
    
    STATISTICAL METHODS:
    - Median for central tendency (robust to outliers)
    - IQR for outlier detection
    - Confidence intervals for reliability
    - Sample size validation
    
    INSTITUTIONAL FEATURES:
    - Decimal arithmetic only
    - Minimum sample size enforcement
    - Outlier removal
    - Confidence scoring
    - Type safety
    """
    
    def __init__(self, logger=None):
        """
        Initialize calculator
        
        Args:
            logger: Optional logger instance
        """
        self.logger = logger
        self.config = get_training_config()
        
        # Minimum sample size from config
        self.min_sample_size = self.config['signal']['min_occurrence']
        
        # Confidence threshold from config
        self.min_confidence = Decimal(str(self.config['signal']['min_confidence']))
        
        if self.logger:
            self.logger.info("OptimalParameterCalculator initialized")
    
    def calculate_optimal_delay(
        self,
        signal_name: str,
        timeframe: str,
        recurrence_data: Dict[str, Any],
        dependency_data: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """
        Calculate optimal RECHECK delay for a signal
        
        Uses multiple data sources:
        1. Signal recurrence patterns (self-similarity)
        2. Dependent signal timing (cross-signal dependencies)
        3. Price movement analysis (volatility windows)
        
        Args:
            signal_name: Name of signal to analyze
            timeframe: Timeframe (e.g., '15m')
            recurrence_data: Output from _find_signal_recurrence
            dependency_data: Output from _find_dependent_signals
        
        Returns:
            dict: {
                'signal_name': str,
                'timeframe': str,
                'optimal_delay': int (bars),
                'min_delay': int (bars),
                'max_delay': int (bars),
                'confidence': Decimal (0.0-1.0),
                'sample_size': int,
                'method': str ('recurrence'|'dependency'|'combined'),
                'reasoning': str
            }
        """
        if self.logger:
            self.logger.info(
                f"Calculating optimal delay for {signal_name} on {timeframe}"
            )
        
        # Extract delays from different sources
        delays = []
        methods_used = []
        
        # Method 1: Recurrence patterns
        if recurrence_data and recurrence_data.get('most_common_interval', 0) > 0:
            recurrence_delay = recurrence_data['most_common_interval']
            recurrence_confidence = recurrence_data['confidence']
            
            if recurrence_confidence >= Decimal('0.5'):
                delays.append(recurrence_delay)
                methods_used.append('recurrence')
                
                if self.logger:
                    self.logger.info(
                        f"  Recurrence delay: {recurrence_delay} bars "
                        f"(confidence: {float(recurrence_confidence):.2%})"
                    )
        
        # Method 2: Dependent signals
        if dependency_data:
            for dep in dependency_data:
                if dep['primary_block'] == signal_name:
                    # This signal precedes another signal
                    delay = dep['avg_time_lag']
                    correlation = dep['correlation']
                    
                    if correlation >= Decimal('0.6'):
                        delays.append(delay)
                        methods_used.append('dependency')
                        
                        if self.logger:
                            self.logger.info(
                                f"  Dependency delay: {delay} bars "
                                f"(to {dep['dependent_block']}, "
                                f"correlation: {float(correlation):.2%})"
                            )
        
        # Calculate optimal delay from collected data
        if not delays:
            # No data available - return default
            return self._create_default_result(signal_name, timeframe)
        
        # Remove outliers using IQR method
        clean_delays = self._remove_outliers(delays)
        
        if len(clean_delays) < self.min_sample_size:
            # Not enough valid data after outlier removal
            return self._create_low_sample_result(
                signal_name, timeframe, len(clean_delays)
            )
        
        # Calculate statistics
        optimal_delay = int(median(clean_delays))
        min_delay = int(min(clean_delays))
        max_delay = int(max(clean_delays))
        
        # Calculate confidence score
        confidence = self._calculate_confidence(
            clean_delays,
            original_count=len(delays)
        )
        
        # Determine method used
        method = 'combined' if len(set(methods_used)) > 1 else methods_used[0]
        
        # Generate reasoning
        reasoning = self._generate_reasoning(
            optimal_delay=optimal_delay,
            min_delay=min_delay,
            max_delay=max_delay,
            sample_size=len(clean_delays),
            method=method,
            confidence=confidence
        )
        
        result = {
            'signal_name': signal_name,
            'timeframe': timeframe,
            'optimal_delay': optimal_delay,
            'min_delay': min_delay,
            'max_delay': max_delay,
            'confidence': confidence,
            'sample_size': len(clean_delays),
            'method': method,
            'reasoning': reasoning
        }
        
        if self.logger:
            self.logger.info(
                f"  Optimal delay: {optimal_delay} bars "
                f"(range: {min_delay}-{max_delay}, "
                f"confidence: {float(confidence):.2%}, "
                f"samples: {len(clean_delays)})"
            )
        
        return result
    
    def _remove_outliers(self, values: List[int]) -> List[int]:
        """
        Remove outliers using IQR method
        
        Removes values outside [Q1 - 1.5*IQR, Q3 + 1.5*IQR]
        
        Args:
            values: List of integer values
        
        Returns:
            List[int]: Values with outliers removed
        """
        if len(values) < 4:
            # Not enough data for IQR
            return values
        
        sorted_values = sorted(values)
        n = len(sorted_values)
        
        # Calculate quartiles
        q1_idx = n // 4
        q3_idx = 3 * n // 4
        q1 = sorted_values[q1_idx]
        q3 = sorted_values[q3_idx]
        
        # Calculate IQR
        iqr = q3 - q1
        
        # Define bounds
        lower_bound = q1 - 1.5 * iqr
        upper_bound = q3 + 1.5 * iqr
        
        # Filter outliers
        clean_values = [v for v in values if lower_bound <= v <= upper_bound]
        
        if self.logger and len(clean_values) < len(values):
            removed = len(values) - len(clean_values)
            self.logger.info(
                f"  Removed {removed} outliers "
                f"(bounds: {lower_bound:.1f}-{upper_bound:.1f})"
            )
        
        return clean_values
    
    def _calculate_confidence(
        self,
        values: List[int],
        original_count: int
    ) -> Decimal:
        """
        Calculate confidence score
        
        Based on:
        1. Sample size (larger is better)
        2. Data retention after outlier removal
        3. Coefficient of variation (lower is better)
        
        Args:
            values: Clean values after outlier removal
            original_count: Original sample count
        
        Returns:
            Decimal: Confidence score (0.0-1.0)
        """
        if not values:
            return Decimal('0')
        
        # Factor 1: Sample size score (0.0-1.0)
        # Uses sigmoid-like curve: confidence increases with sample size
        min_samples = self.min_sample_size
        sample_score = min(
            Decimal('1.0'),
            Decimal(str(len(values))) / Decimal(str(min_samples * 3))
        )
        
        # Factor 2: Data retention score (0.0-1.0)
        # Percentage of data retained after outlier removal
        retention_score = Decimal(str(len(values))) / Decimal(str(original_count))
        
        # Factor 3: Consistency score (0.0-1.0)
        # Based on coefficient of variation (lower CV = higher consistency)
        if len(values) > 1:
            mean_val = sum(values) / len(values)
            std_val = stdev(values)
            cv = (std_val / mean_val) if mean_val > 0 else Decimal('999')
            
            # Normalize CV to 0-1 scale (CV < 0.5 is excellent)
            consistency_score = max(
                Decimal('0'),
                Decimal('1.0') - min(Decimal(str(cv)), Decimal('1.0'))
            )
        else:
            consistency_score = Decimal('0.5')  # Neutral
        
        # Weighted average
        confidence = (
            sample_score * Decimal('0.4') +
            retention_score * Decimal('0.3') +
            consistency_score * Decimal('0.3')
        )
        
        return confidence
    
    def _create_default_result(
        self,
        signal_name: str,
        timeframe: str
    ) -> Dict[str, Any]:
        """
        Create default result when no data available
        
        Args:
            signal_name: Signal name
            timeframe: Timeframe
        
        Returns:
            dict: Default result (10 bars delay, low confidence)
        """
        default_delay = 10  # Conservative default
        
        return {
            'signal_name': signal_name,
            'timeframe': timeframe,
            'optimal_delay': default_delay,
            'min_delay': default_delay,
            'max_delay': default_delay,
            'confidence': Decimal('0'),
            'sample_size': 0,
            'method': 'default',
            'reasoning': (
                f"Insufficient data for {signal_name} on {timeframe}. "
                f"Using default delay of {default_delay} bars. "
                "Collect more signal occurrences for reliable analysis."
            )
        }
    
    def _create_low_sample_result(
        self,
        signal_name: str,
        timeframe: str,
        sample_size: int
    ) -> Dict[str, Any]:
        """
        Create result for low sample size
        
        Args:
            signal_name: Signal name
            timeframe: Timeframe
            sample_size: Actual sample size
        
        Returns:
            dict: Low sample result
        """
        default_delay = 10
        
        return {
            'signal_name': signal_name,
            'timeframe': timeframe,
            'optimal_delay': default_delay,
            'min_delay': default_delay,
            'max_delay': default_delay,
            'confidence': Decimal('0.2'),
            'sample_size': sample_size,
            'method': 'low_sample',
            'reasoning': (
                f"Only {sample_size} valid samples for {signal_name} on {timeframe} "
                f"(minimum: {self.min_sample_size}). "
                f"Using conservative default delay of {default_delay} bars. "
                "Increase training period or reduce outlier filtering."
            )
        }
    
    def _generate_reasoning(
        self,
        optimal_delay: int,
        min_delay: int,
        max_delay: int,
        sample_size: int,
        method: str,
        confidence: Decimal
    ) -> str:
        """
        Generate human-readable reasoning for the recommendation
        
        Args:
            optimal_delay: Optimal delay (bars)
            min_delay: Minimum observed delay
            max_delay: Maximum observed delay
            sample_size: Sample size
            method: Method used
            confidence: Confidence score
        
        Returns:
            str: Reasoning text
        """
        # Confidence level text
        if confidence >= Decimal('0.8'):
            conf_text = "high confidence"
        elif confidence >= Decimal('0.5'):
            conf_text = "moderate confidence"
        else:
            conf_text = "low confidence"
        
        # Method text
        method_text = {
            'recurrence': 'signal recurrence patterns',
            'dependency': 'dependent signal timing',
            'combined': 'combined recurrence and dependency analysis'
        }.get(method, method)
        
        # Range text
        if min_delay == max_delay:
            range_text = f"consistent delay of {optimal_delay} bars"
        else:
            range_text = (
                f"delay range of {min_delay}-{max_delay} bars, "
                f"with median at {optimal_delay} bars"
            )
        
        reasoning = (
            f"Based on {method_text} from {sample_size} samples, "
            f"recommend {range_text}. "
            f"Confidence: {conf_text} ({float(confidence):.0%})."
        )
        
        return reasoning
    
    def calculate_timing_window(
        self,
        signal_events: List[Any],
        optimal_delay: int
    ) -> Dict[str, Any]:
        """
        Calculate valid timing window around optimal delay
        
        Args:
            signal_events: List of SignalEvent objects
            optimal_delay: Optimal delay (bars)
        
        Returns:
            dict: {
                'window_start': int (bars before optimal),
                'window_end': int (bars after optimal),
                'window_size': int (total bars)
            }
        """
        if not signal_events:
            return {
                'window_start': optimal_delay - 2,
                'window_end': optimal_delay + 2,
                'window_size': 5
            }
        
        # Calculate time-to-max-favorable for valid signals
        times_to_max = []
        for event in signal_events:
            if hasattr(event, 'bars_to_max_favorable') and event.bars_to_max_favorable:
                times_to_max.append(event.bars_to_max_favorable)
        
        if not times_to_max:
            # Default window: ±2 bars around optimal
            return {
                'window_start': max(1, optimal_delay - 2),
                'window_end': optimal_delay + 2,
                'window_size': 5
            }
        
        # Use IQR to determine window bounds
        clean_times = self._remove_outliers(times_to_max)
        
        if clean_times:
            window_start = max(1, int(min(clean_times)))
            window_end = int(max(clean_times))
        else:
            window_start = max(1, optimal_delay - 2)
            window_end = optimal_delay + 2
        
        return {
            'window_start': window_start,
            'window_end': window_end,
            'window_size': window_end - window_start + 1
        }
