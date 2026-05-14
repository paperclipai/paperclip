"""
Signal Statistics Loader
Loads and caches signal occurrence statistics for Strategy Builder UI

Provides historical frequency data to help users understand:
- How often each signal occurs
- Which signals are rare vs common
- Occurrence percentages

Author: Strategy Builder Team
Date: 2026-01-17
"""

import json
from pathlib import Path
from typing import Dict, Optional, Any
from datetime import datetime

import logging
logger = logging.getLogger(__name__)

class SignalStatisticsLoader:
    """
    Loads and caches signal occurrence statistics.
    
    Singleton pattern ensures statistics are loaded once and shared
    across all UI components.
    """
    
    _instance = None
    _statistics: Optional[Dict[str, Any]] = None
    _loaded = False
    _load_time: Optional[datetime] = None
    
    def __new__(cls):
        """Singleton pattern"""
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance
    
    def __init__(self):
        """Initialize loader"""
        self.stats_file = Path(__file__).parent.parent.parent.parent / 'data' / 'catalog' / 'signal_occurrence_statistics.json'
    
    def load(self, force_reload: bool = False) -> bool:
        """
        Load signal statistics from JSON file.
        
        Args:
            force_reload: Force reload even if already loaded
            
        Returns:
            True if loaded successfully, False otherwise
        """
        if self._loaded and not force_reload:
            return True
        
        if not self.stats_file.exists():
            logger.warning(f"Signal statistics file not found: {self.stats_file}")
            logger.info("Run: python scripts/analyze_signal_occurrences.py")
            return False
        
        try:
            with open(self.stats_file, 'r') as f:
                self._statistics = json.load(f)
            
            self._loaded = True
            self._load_time = datetime.now()
            
            logger.info(f"✅ Loaded signal statistics: {self._statistics.get('total_blocks', 0)} blocks")
            return True
            
        except Exception as e:
            logger.error(f"❌ Failed to load signal statistics: {e}")
            return False
    
    def is_loaded(self) -> bool:
        """Check if statistics are loaded"""
        return self._loaded
    
    def get_block_statistics(self, block_name: str) -> Optional[Dict[str, Any]]:
        """
        Get statistics for a specific block.
        
        Args:
            block_name: Name of the building block
            
        Returns:
            Dict with block statistics or None if not found
        """
        if not self._loaded:
            self.load()
        
        if not self._loaded or not self._statistics:
            return None
        
        blocks = self._statistics.get('blocks', {})
        return blocks.get(block_name)
    
    def get_signal_occurrence(self, block_name: str, signal_name: str) -> Optional[Dict[str, Any]]:
        """
        Get occurrence data for a specific signal.
        
        Args:
            block_name: Name of the building block
            signal_name: Name of the signal
            
        Returns:
            Dict with count, percentage, total_candles or None
        """
        block_stats = self.get_block_statistics(block_name)
        
        if not block_stats or 'signals' not in block_stats:
            return None
        
        return block_stats['signals'].get(signal_name)
    
    def get_formatted_occurrence(self, block_name: str, signal_name: str) -> str:
        """
        Get formatted occurrence string for display in UI.
        
        Args:
            block_name: Name of the building block
            signal_name: Name of the signal
            
        Returns:
            Formatted string like "2,049 found (11.9%)" or empty string
        """
        occurrence = self.get_signal_occurrence(block_name, signal_name)
        
        if not occurrence:
            return ""
        
        count = occurrence.get('count', 0)
        percentage = occurrence.get('percentage', 0.0)
        
        # Format count with commas
        count_str = f"{count:,}"
        
        # Format percentage with 1 decimal
        pct_str = f"{percentage:.1f}%"
        
        return f"{count_str} found ({pct_str})"
    
    def get_all_signals_for_block(self, block_name: str) -> Dict[str, Dict[str, Any]]:
        """
        Get all signal statistics for a block.
        
        Args:
            block_name: Name of the building block
            
        Returns:
            Dict mapping signal names to their statistics
        """
        block_stats = self.get_block_statistics(block_name)
        
        if not block_stats or 'signals' not in block_stats:
            return {}
        
        return block_stats['signals']
    
    def get_metadata(self) -> Dict[str, Any]:
        """
        Get analysis metadata.
        
        Returns:
            Dict with analysis_date, data_timeframe, data_days, total_blocks
        """
        if not self._loaded:
            self.load()
        
        if not self._statistics:
            return {}
        
        return {
            'analysis_date': self._statistics.get('analysis_date'),
            'data_timeframe': self._statistics.get('data_timeframe'),
            'data_days': self._statistics.get('data_days'),
            'total_blocks': self._statistics.get('total_blocks')
        }
    
    def get_top_signals(self, limit: int = 20, exclude_common: bool = True) -> list:
        """
        Get top N most frequent signals across all blocks.
        
        Args:
            limit: Number of signals to return
            exclude_common: Exclude ERROR, INSUFFICIENT_DATA, NEUTRAL, NO_PATTERN
            
        Returns:
            List of dicts with block, signal, count, percentage
        """
        if not self._loaded:
            self.load()
        
        if not self._statistics:
            return []
        
        all_signals = []
        blocks = self._statistics.get('blocks', {})
        
        for block_name, block_data in blocks.items():
            if 'signals' not in block_data:
                continue
            
            for signal, stats in block_data['signals'].items():
                if exclude_common and signal in ['ERROR', 'INSUFFICIENT_DATA', 'NEUTRAL', 'NO_PATTERN']:
                    continue
                
                all_signals.append({
                    'block': block_name,
                    'signal': signal,
                    'count': stats.get('count', 0),
                    'percentage': stats.get('percentage', 0.0)
                })
        
        # Sort by count descending
        all_signals.sort(key=lambda x: x['count'], reverse=True)
        
        return all_signals[:limit]
    
    def get_rare_signals(self, threshold_pct: float = 5.0) -> list:
        """
        Get rare signals (below threshold percentage).
        
        Args:
            threshold_pct: Percentage threshold (default 5%)
            
        Returns:
            List of dicts with block, signal, count, percentage
        """
        if not self._loaded:
            self.load()
        
        if not self._statistics:
            return []
        
        rare_signals = []
        blocks = self._statistics.get('blocks', {})
        
        for block_name, block_data in blocks.items():
            if 'signals' not in block_data:
                continue
            
            for signal, stats in block_data['signals'].items():
                # Skip common status signals
                if signal in ['ERROR', 'INSUFFICIENT_DATA', 'NEUTRAL', 'NO_PATTERN']:
                    continue
                
                percentage = stats.get('percentage', 0.0)
                count = stats.get('count', 0)
                
                if percentage < threshold_pct and count > 0:
                    rare_signals.append({
                        'block': block_name,
                        'signal': signal,
                        'count': count,
                        'percentage': percentage
                    })
        
        # Sort by percentage ascending (rarest first)
        rare_signals.sort(key=lambda x: x['percentage'])
        
        return rare_signals
    
    def get_load_info(self) -> str:
        """
        Get formatted load information string.
        
        Returns:
            String like "Loaded 83 blocks at 05:46 AM"
        """
        if not self._loaded:
            return "Not loaded"
        
        if not self._load_time:
            return "Loaded (time unknown)"
        
        total_blocks = self._statistics.get('total_blocks', 0) if self._statistics else 0
        time_str = self._load_time.strftime("%I:%M %p")
        
        return f"Loaded {total_blocks} blocks at {time_str}"
    
    def clear_cache(self):
        """Clear cached statistics (force reload on next access)"""
        self._statistics = None
        self._loaded = False
        self._load_time = None
        logger.info("Signal statistics cache cleared")


# Global singleton instance
_loader = SignalStatisticsLoader()


# Convenience functions for easy access
def load_statistics(force_reload: bool = False) -> bool:
    """Load signal statistics"""
    return _loader.load(force_reload)


def get_signal_display(block_name: str, signal_name: str) -> str:
    """Get formatted signal occurrence for display"""
    return _loader.get_formatted_occurrence(block_name, signal_name)


def is_statistics_loaded() -> bool:
    """Check if statistics are loaded"""
    return _loader.is_loaded()


def get_statistics_metadata() -> Dict[str, Any]:
    """Get analysis metadata"""
    return _loader.get_metadata()
