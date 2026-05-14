"""
Signal Statistics Incremental Updater
Updates signal occurrence statistics as strategies run on new dates

Critical Requirements:
- Update stats when strategy runs on new dates (test/paper/live)
- NEVER double-count signals on already-analyzed dates
- Maintain data integrity and accuracy
- Thread-safe for concurrent strategy runs

Author: Strategy Builder Team
Date: 2026-01-17
"""

import json
import threading
from pathlib import Path
from typing import Dict, Set, Optional, Any, List
from datetime import datetime, date
from collections import defaultdict

import logging
logger = logging.getLogger(__name__)

class SignalStatisticsUpdater:
    """
    Incrementally updates signal occurrence statistics.
    
    Features:
    - Tracks analyzed dates per block to prevent double-counting
    - Thread-safe for concurrent updates
    - Atomic file writes
    - Backup before updates
    """
    
    def __init__(self, stats_file: Optional[Path] = None):
        """
        Initialize the statistics updater.
        
        Args:
            stats_file: Path to statistics JSON file (default: data/catalog/signal_occurrence_statistics.json)
        """
        if stats_file is None:
            self.stats_file = Path(__file__).parent.parent.parent / 'data' / 'catalog' / 'signal_occurrence_statistics.json'
        else:
            self.stats_file = Path(stats_file)
        
        # Thread lock for atomic updates
        self._lock = threading.Lock()
        
        # Track analyzed dates per block
        # Format: {block_name: set(date_strings)}
        self.analyzed_dates_file = self.stats_file.parent / 'signal_statistics_analyzed_dates.json'
        self.analyzed_dates: Dict[str, Set[str]] = {}
        
        # Load existing data
        self._load_analyzed_dates()
    
    def _load_analyzed_dates(self):
        """Load the set of already-analyzed dates for each block."""
        if not self.analyzed_dates_file.exists():
            # Initialize with dates from initial analysis if stats file exists
            if self.stats_file.exists():
                self._initialize_analyzed_dates_from_stats()
            return
        
        try:
            with open(self.analyzed_dates_file, 'r') as f:
                data = json.load(f)
            
            # Convert lists back to sets
            self.analyzed_dates = {
                block_name: set(dates) 
                for block_name, dates in data.items()
            }
            
            logger.info(f"✅ Loaded analyzed dates for {len(self.analyzed_dates)} blocks")
            
        except Exception as e:
            logger.error(f"⚠️  Failed to load analyzed dates: {e}")
            self.analyzed_dates = {}
    
    def _initialize_analyzed_dates_from_stats(self):
        """
        Initialize analyzed dates from existing statistics file.
        
        Assumes initial 180-day analysis covered all dates in the data period.
        """
        try:
            with open(self.stats_file, 'r') as f:
                stats = json.load(f)
            
            # Get analysis period
            data_days = stats.get('data_days', 180)
            analysis_date = stats.get('analysis_date')
            
            if not analysis_date:
                logger.warning("⚠️  No analysis_date in stats file - cannot initialize date tracking")
                return
            
            # Parse analysis date
            analysis_dt = datetime.fromisoformat(analysis_date)
            
            # Generate date range (last N days from analysis date)
            from datetime import timedelta
            dates_analyzed = []
            for i in range(data_days):
                d = analysis_dt.date() - timedelta(days=i)
                dates_analyzed.append(d.isoformat())
            
            # Set same dates for all blocks
            blocks = stats.get('blocks', {})
            for block_name in blocks.keys():
                self.analyzed_dates[block_name] = set(dates_analyzed)
            
            # Save to file
            self._save_analyzed_dates()
            
            logger.info(f"✅ Initialized analyzed dates: {data_days} days for {len(blocks)} blocks")
            
        except Exception as e:
            logger.error(f"❌ Failed to initialize analyzed dates: {e}")
    
    def _save_analyzed_dates(self):
        """Save analyzed dates to file."""
        try:
            # Convert sets to lists for JSON
            data = {
                block_name: sorted(list(dates))
                for block_name, dates in self.analyzed_dates.items()
            }
            
            # Atomic write with temp file
            temp_file = self.analyzed_dates_file.with_suffix('.tmp')
            with open(temp_file, 'w') as f:
                json.dump(data, f, indent=2)
            
            # Atomic rename
            temp_file.replace(self.analyzed_dates_file)
            
        except Exception as e:
            logger.error(f"❌ Failed to save analyzed dates: {e}")
    
    def update_statistics(
        self,
        block_name: str,
        signal_occurrences: Dict[str, List[str]],
        new_dates: Optional[Set[str]] = None
    ) -> bool:
        """
        Update statistics for a block with new signal occurrences.
        
        Args:
            block_name: Name of the building block
            signal_occurrences: Dict mapping signal names to list of date strings where they occurred
            new_dates: Set of new dates being analyzed (optional - will be inferred from signal_occurrences)
        
        Returns:
            True if updated successfully, False otherwise
        
        Example:
            signal_occurrences = {
                'BULLISH': ['2026-01-17', '2026-01-18'],
                'BEARISH': ['2026-01-19']
            }
        """
        with self._lock:
            try:
                # Infer new dates if not provided
                if new_dates is None:
                    new_dates = set()
                    for dates in signal_occurrences.values():
                        new_dates.update(dates)
                
                # Get already-analyzed dates for this block
                analyzed = self.analyzed_dates.get(block_name, set())
                
                # Filter out already-analyzed dates (CRITICAL: prevent double-counting)
                truly_new_dates = new_dates - analyzed
                
                if not truly_new_dates:
                    logger.info(f"ℹ️  No new dates to analyze for {block_name} - all dates already processed")
                    return True
                
                # Count only signals on truly new dates
                new_signal_counts = defaultdict(int)
                for signal, dates in signal_occurrences.items():
                    for d in dates:
                        if d in truly_new_dates:
                            new_signal_counts[signal] += 1
                
                if not new_signal_counts:
                    logger.info(f"ℹ️  No new signals found on new dates for {block_name}")
                    return True
                
                # Load current statistics
                if not self.stats_file.exists():
                    logger.error(f"❌ Statistics file not found: {self.stats_file}")
                    return False
                
                with open(self.stats_file, 'r') as f:
                    stats = json.load(f)
                
                # Get block stats
                blocks = stats.get('blocks', {})
                if block_name not in blocks:
                    logger.error(f"❌ Block {block_name} not found in statistics")
                    return False
                
                block_stats = blocks[block_name]
                signals = block_stats.get('signals', {})
                
                # Update counts and recalculate percentages
                total_new_candles = len(truly_new_dates)
                old_total_candles = block_stats.get('total_candles', 0)
                new_total_candles = old_total_candles + total_new_candles
                
                for signal, new_count in new_signal_counts.items():
                    if signal not in signals:
                        # New signal type discovered
                        signals[signal] = {
                            'count': new_count,
                            'percentage': 0.0,  # Will be calculated below
                            'total_candles': new_total_candles
                        }
                    else:
                        # Existing signal - add to count
                        old_count = signals[signal].get('count', 0)
                        signals[signal]['count'] = old_count + new_count
                        signals[signal]['total_candles'] = new_total_candles
                
                # Recalculate all percentages with new total
                for signal in signals:
                    count = signals[signal]['count']
                    percentage = (count / new_total_candles * 100) if new_total_candles > 0 else 0
                    signals[signal]['percentage'] = round(percentage, 2)
                
                # Update block totals
                block_stats['total_candles'] = new_total_candles
                block_stats['signals'] = signals
                
                # Update metadata
                stats['last_updated'] = datetime.now().isoformat()
                if 'update_history' not in stats:
                    stats['update_history'] = []
                
                stats['update_history'].append({
                    'timestamp': datetime.now().isoformat(),
                    'block': block_name,
                    'new_dates_count': len(truly_new_dates),
                    'new_signals_count': sum(new_signal_counts.values()),
                    'updated_total_candles': new_total_candles
                })
                
                # Keep only last 100 updates in history
                if len(stats['update_history']) > 100:
                    stats['update_history'] = stats['update_history'][-100:]
                
                # Save updated statistics (atomic write)
                self._save_stats_atomic(stats)
                
                # Update analyzed dates
                self.analyzed_dates[block_name] = analyzed | truly_new_dates
                self._save_analyzed_dates()
                
                logger.info(f"✅ Updated statistics for {block_name}:")
                logger.info(f"   New dates analyzed: {len(truly_new_dates)}")
                logger.info(f"   New signals found: {sum(new_signal_counts.values())}")
                logger.info(f"   Total candles: {old_total_candles} → {new_total_candles}")
                
                return True
                
            except Exception as e:
                logger.error(f"❌ Failed to update statistics for {block_name}: {e}")
                import traceback
                traceback.print_exc()
                return False
    
    def _save_stats_atomic(self, stats: Dict[str, Any]):
        """
        Save statistics file atomically (with backup).
        
        Args:
            stats: Statistics dictionary to save
        """
        # Create backup
        if self.stats_file.exists():
            backup_file = self.stats_file.with_suffix('.backup')
            import shutil
            shutil.copy2(self.stats_file, backup_file)
        
        # Atomic write
        temp_file = self.stats_file.with_suffix('.tmp')
        with open(temp_file, 'w') as f:
            json.dump(stats, f, indent=2)
        
        # Atomic rename
        temp_file.replace(self.stats_file)
    
    def get_analyzed_dates(self, block_name: str) -> Set[str]:
        """
        Get set of already-analyzed dates for a block.
        
        Args:
            block_name: Name of the block
        
        Returns:
            Set of date strings (ISO format)
        """
        return self.analyzed_dates.get(block_name, set()).copy()
    
    def is_date_analyzed(self, block_name: str, date_string: str) -> bool:
        """
        Check if a specific date has been analyzed for a block.
        
        Args:
            block_name: Name of the block
            date_string: Date in ISO format (YYYY-MM-DD)
        
        Returns:
            True if date was already analyzed, False otherwise
        """
        analyzed = self.analyzed_dates.get(block_name, set())
        return date_string in analyzed
    
    def get_statistics_summary(self) -> Dict[str, Any]:
        """
        Get summary of current statistics state.
        
        Returns:
            Dict with summary information
        """
        if not self.stats_file.exists():
            return {'status': 'not_found'}
        
        try:
            with open(self.stats_file, 'r') as f:
                stats = json.load(f)
            
            total_blocks = len(stats.get('blocks', {}))
            total_signals = sum(
                len(block.get('signals', {}))
                for block in stats.get('blocks', {}).values()
            )
            
            total_dates_tracked = sum(
                len(dates) for dates in self.analyzed_dates.values()
            )
            
            return {
                'status': 'ok',
                'total_blocks': total_blocks,
                'total_signals': total_signals,
                'total_dates_tracked': total_dates_tracked,
                'analysis_date': stats.get('analysis_date'),
                'last_updated': stats.get('last_updated'),
                'data_days': stats.get('data_days'),
                'update_count': len(stats.get('update_history', []))
            }
        except Exception as e:
            return {'status': 'error', 'error': str(e)}


# Global singleton instance
_updater = SignalStatisticsUpdater()


# Convenience functions
def update_block_statistics(
    block_name: str,
    signal_occurrences: Dict[str, List[str]],
    new_dates: Optional[Set[str]] = None
) -> bool:
    """Update statistics for a block (convenience function)"""
    return _updater.update_statistics(block_name, signal_occurrences, new_dates)


def is_date_analyzed(block_name: str, date_string: str) -> bool:
    """Check if date was already analyzed (convenience function)"""
    return _updater.is_date_analyzed(block_name, date_string)


def get_statistics_summary() -> Dict[str, Any]:
    """Get statistics summary (convenience function)"""
    return _updater.get_statistics_summary()
