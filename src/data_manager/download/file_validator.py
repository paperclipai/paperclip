"""File Completeness Validator - Detect incomplete month files"""

import pandas as pd
from pathlib import Path
from datetime import datetime, timedelta
from typing import Dict, Optional
import calendar

import logging
logger = logging.getLogger(__name__)

class FileValidator:
    """
    Validate data file completeness
    
    Detects:
    - Incomplete past months (missing days)
    - Data quality issues
    - File corruption
    
    Example:
        >>> validator = FileValidator()
        >>> is_complete = validator.is_month_complete('data/raw/trades/BTC-USDT_trades_2025-12.parquet', 2025, 12)
        >>> if not is_complete:
        >>>     print("December incomplete! Needs redownload")
    """
    
    def __init__(self):
        """Initialize validator"""
        pass
    
    def is_month_complete(
        self,
        file_path: Path,
        year: int,
        month: int,
        current_month_ok: bool = True
    ) -> tuple[bool, str]:
        """
        Check if month file has complete data
        
        Args:
            file_path: Path to parquet file
            year: Year of data
            month: Month of data (1-12)
            current_month_ok: Allow partial data for current month
        
        Returns:
            (is_complete: bool, message: str)
        
        Example:
            >>> validator.is_month_complete(Path('trades_2025-12.parquet'), 2025, 12)
            (False, "Missing Dec 31 (only has 30/31 days)")
        """
        try:
            if not file_path.exists():
                return (False, "File does not exist")
            
            # Read parquet
            df = pd.read_parquet(file_path)
            
            if df.empty:
                return (False, "File is empty")
            
            # Convert timestamps (handle different column names)
            if 'origin_time' in df.columns:
                df['dt'] = pd.to_datetime(df['origin_time'])
            elif 'timestamp' in df.columns:
                df['dt'] = pd.to_datetime(df['timestamp'], unit='ms')
            else:
                return (False, "No timestamp column found")
            
            # Get data range
            first_date = df['dt'].min()
            last_date = df['dt'].max()
            
            # Check if this is current month
            now = datetime.now()
            is_current = (year == now.year and month == now.month)
            
            if is_current and current_month_ok:
                # Current month can be partial
                return (True, f"Current month (partial through {last_date.date()})")
            
            # For past months, check completeness
            expected_days = calendar.monthrange(year, month)[1]  # Days in month
            last_day_reached = last_date.day
            
            if last_day_reached < expected_days:
                missing_days = expected_days - last_day_reached
                return (
                    False,
                    f"Incomplete: Only through day {last_day_reached}/{expected_days} "
                    f"(missing {missing_days} day{'s' if missing_days > 1 else ''})"
                )
            
            # Check if data spans most of the month
            actual_days = (last_date - first_date).days + 1
            coverage = (actual_days / expected_days) * 100
            
            if coverage < 90:
                return (
                    False,
                    f"Low coverage: {coverage:.1f}% ({actual_days}/{expected_days} days)"
                )
            
            return (True, f"Complete: {actual_days}/{expected_days} days ({coverage:.1f}% coverage)")
            
        except Exception as e:
            return (False, f"Validation error: {e}")
    
    def validate_all_months(
        self,
        data_dir: Path,
        data_type: str = 'trades'
    ) -> Dict[str, tuple[bool, str]]:
        """
        Validate all month files in directory
        
        Args:
            data_dir: Directory containing month files
            data_type: Data type ('trades', 'liquidations', etc.)
        
        Returns:
            Dictionary mapping month_str to (is_complete, message)
        
        Example:
            >>> validator.validate_all_months(Path('data/raw/trades'))
            {
                '2025-12': (False, "Incomplete: Only through day 30/31"),
                '2026-01': (True, "Current month (partial)")
            }
        """
        results = {}
        
        data_path = data_dir / data_type
        if not data_path.exists():
            return {}
        
        for file_path in sorted(data_path.glob('BTC-USDT_*.parquet')):
            # Parse filename: BTC-USDT_trades_2025-12.parquet
            try:
                parts = file_path.stem.split('_')
                month_str = parts[-1]  # '2025-12'
                year, month = map(int, month_str.split('-'))
                
                is_complete, message = self.is_month_complete(file_path, year, month)
                results[month_str] = (is_complete, message)
                
            except Exception as e:
                results[file_path.name] = (False, f"Parse error: {e}")
        
        return results
    
    def print_validation_report(
        self,
        data_dir: Path,
        data_type: str = 'trades'
    ):
        """
        Print validation report for all files
        
        Args:
            data_dir: Directory containing month files
            data_type: Data type to validate
        """
        logger.info(f"\n{'='*80}")
        logger.info(f"FILE COMPLETENESS VALIDATION REPORT - {data_type.upper()}")
        logger.info(f"{'='*80}\n")
        
        results = self.validate_all_months(data_dir, data_type)
        
        if not results:
            logger.warning(f"⚠️  No files found in {data_dir / data_type}\n")
            return
        
        complete_count = 0
        incomplete_count = 0
        
        for month_str, (is_complete, message) in results.items():
            icon = "✅" if is_complete else "⚠️ "
            logger.info(f"{icon} {month_str}: {message}")
            
            if is_complete:
                complete_count += 1
            else:
                incomplete_count += 1
        
        logger.info(f"\n{'='*80}")
        logger.info(f"Summary: {complete_count} complete, {incomplete_count} incomplete")
        logger.info(f"{'='*80}\n")
        
        if incomplete_count > 0:
            logger.warning("⚠️  RECOMMENDATION: Re-download incomplete months with --force\n")


def main():
    """CLI for validation"""
    from ..config import RAW_DATA_DIR
    validator = FileValidator()
    validator.print_validation_report(RAW_DATA_DIR, 'trades')


if __name__ == "__main__":
    main()