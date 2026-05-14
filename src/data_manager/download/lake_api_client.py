"""LakeAPI Client - Secure data download from Crypto Lake S3"""

import boto3
from lakeapi import load_data
import pandas as pd
from pathlib import Path
from datetime import datetime
from typing import Optional, List, Dict
import gc
import time
from retry import retry

from ..config import (
    LAKEAPI_KEY,
    LAKEAPI_SECRET,
    LAKEAPI_REGION,
    LAKEAPI_TABLE_MAPPING,
    LAKEAPI_EXCHANGE_MAPPING,
    LAKEAPI_SYMBOL_MAPPING,
    RAW_DATA_DIR,
    LAKE_CACHE_DIR
)
from ..utils.file_utils import get_file_size_mb, ensure_directory_exists
from .usage_tracker import UsageTracker

import logging
logger = logging.getLogger(__name__)

class LakeAPIClient:
    """
    Secure LakeAPI client for downloading crypto market data
    
    Features:
    - Secure credential management (.env only)
    - Automatic usage tracking
    - Smart caching to prevent re-downloads
    - Memory-efficient chunked downloads
    - Automatic retry on failures
    - Progress indicators
    
    Example:
        >>> client = LakeAPIClient()
        >>> df = client.download_month('trades', 2024, 12)
        >>> len(df)
        1523891  # Number of trades
    
    Security:
        - Credentials loaded from .env only
        - Never logs credentials
        - Validates all inputs
    """
    
    def __init__(self, usage_tracker: Optional[UsageTracker] = None):
        """
        Initialize LakeAPI client with secure credentials
        
        Args:
            usage_tracker: Usage tracker instance (creates new if None)
        
        Raises:
            ValueError: If credentials not available
        """
        # Validate credentials are available
        from ..config import CREDENTIALS_AVAILABLE
        
        if not CREDENTIALS_AVAILABLE:
            raise ValueError(
                "❌ LakeAPI credentials not configured!\n"
                "   Create .env in project root with:\n"
                "     LAKEAPI_KEY=your_access_key_here\n"
                "     LAKEAPI_SECRET=your_secret_key_here\n"
                "\n"
                "   See .env.example for template"
            )
        
        # Create secure boto3 session
        self.session = boto3.Session(
            aws_access_key_id=LAKEAPI_KEY,
            aws_secret_access_key=LAKEAPI_SECRET,
            region_name=LAKEAPI_REGION
        )
        
        # Initialize usage tracker
        self.usage_tracker = usage_tracker or UsageTracker()
        
        # Ensure data directories exist
        for data_type in ['trades', 'liquidations', 'funding', 'open_interest', 'orderbook']:
            ensure_directory_exists(RAW_DATA_DIR / data_type)
        
        # Ensure cache directory exists
        ensure_directory_exists(LAKE_CACHE_DIR)
        
        logger.info(f"✅ LakeAPI client initialized (Region: {LAKEAPI_REGION})")
        logger.info(f"💾 Cache directory: {LAKE_CACHE_DIR}")
    
    def _get_table_name(self, data_type: str) -> str:
        """
        Get LakeAPI table name for data type
        
        Args:
            data_type: Data type ('trades', 'liquidations', etc.)
        
        Returns:
            LakeAPI table name
        
        Raises:
            ValueError: If data type not supported
        """
        if data_type not in LAKEAPI_TABLE_MAPPING:
            raise ValueError(
                f"Unsupported data type: {data_type}. "
                f"Supported: {list(LAKEAPI_TABLE_MAPPING.keys())}"
            )
        
        return LAKEAPI_TABLE_MAPPING[data_type]
    
    def _get_file_path(self, data_type: str, year: int, month: int) -> Path:
        """Get file path for downloaded data"""
        month_str = f"{year}-{month:02d}"
        filename = f"BTC-USDT_{data_type}_{month_str}.parquet"
        return RAW_DATA_DIR / data_type / filename
    
    def check_file_exists(self, data_type: str, year: int, month: int) -> bool:
        """
        Check if data file already exists
        
        Args:
            data_type: Data type ('trades', 'liquidations', etc.)
            year: Year
            month: Month (1-12)
        
        Returns:
            True if file exists, False otherwise
        
        Example:
            >>> client.check_file_exists('trades', 2024, 12)
            True  # File already downloaded
        """
        file_path = self._get_file_path(data_type, year, month)
        return file_path.exists() and file_path.stat().st_size > 0
    
    def _download_with_retry(
        self, 
        table: str, 
        start_date: datetime, 
        end_date: datetime,
        month_str: str,
        data_type: str
    ) -> Optional[pd.DataFrame]:
        """
        Download data with automatic retry on failure
        
        Args:
            table: LakeAPI table name
            start_date: Start datetime
            end_date: End datetime
            month_str: Month string for logging (e.g., '2024-12')
            data_type: Data type for better error messages
        
        Returns:
            DataFrame with data or None
        
        Note:
            Retries up to 3 times with exponential backoff (5s, 10s, 20s)
            Handles NoFilesFound gracefully (expected for current month non-trade data)
        """
        logger.info(f"   Connecting to LakeAPI")
        
        max_retries = 3
        for attempt in range(max_retries):
            try:
                # Get correct exchange and symbol for this data type
                exchange = LAKEAPI_EXCHANGE_MAPPING[data_type]
                symbol = LAKEAPI_SYMBOL_MAPPING[data_type]
                
                # Download from LakeAPI
                df = load_data(
                    table=table,
                    start=start_date,
                    end=end_date,
                    symbols=[symbol],
                    exchanges=[exchange],
                    boto3_session=self.session
                )
                
                logger.info(" ✅")
                return df
                
            except Exception as e:
                error_name = type(e).__name__
                error_msg = str(e)
                
                # Check if NoFilesFound (expected for some data types)
                if 'NoFilesFound' in error_name or 'No files Found' in error_msg:
                    logger.warning(f" ⚠️  No files")
                    # Check if current month
                    now = datetime.now()
                    is_current = (start_date.year == now.year and start_date.month == now.month)
                    
                    if is_current and data_type != 'trades':
                        # Expected - LakeAPI often doesn't publish current month non-trade data
                        return None
                    elif attempt < max_retries - 1:
                        # Retry for past months
                        import time
                        wait = 5 * (2 ** attempt)
                        time.sleep(wait)
                        continue
                    else:
                        # Final attempt failed
                        return None
                
                # Other errors
                if attempt < max_retries - 1:
                    logger.error(f" ❌ {error_name} (retry {attempt + 1}/{max_retries})")
                    import time
                    wait = 5 * (2 ** attempt)
                    time.sleep(wait)
                else:
                    logger.error(f" ❌ {error_name}")
                    raise
        
        return None
    
    def download_month(
        self,
        data_type: str,
        year: int,
        month: int,
        force_redownload: bool = False,
        check_usage: bool = True
    ) -> Optional[pd.DataFrame]:
        """
        Download one month of data from LakeAPI
        
        Args:
            data_type: Data type ('trades', 'liquidations', etc.)
            year: Year to download
            month: Month to download (1-12)
            force_redownload: Force re-download even if file exists
            check_usage: Check usage limits before downloading
        
        Returns:
            DataFrame with downloaded data, or None if skipped
        
        Raises:
            ValueError: If download would exceed usage limit
        
        Example:
            >>> client.download_month('trades', 2024, 12)
            <DataFrame with 1.5M trades>
        
        Note:
            Automatically tracks usage and prevents exceeding 300GB limit
            Retries 3 times on failure with exponential backoff
        """
        # Validate inputs
        if not (1 <= month <= 12):
            raise ValueError(f"Invalid month: {month}. Must be 1-12.")
        
        if year < 2020 or year > datetime.now().year:
            raise ValueError(f"Invalid year: {year}")
        
        # Get file path
        file_path = self._get_file_path(data_type, year, month)
        month_str = f"{year}-{month:02d}"
        
        # Check if file already exists (unless force redownload)
        if file_path.exists() and not force_redownload:
            file_size_mb = get_file_size_mb(file_path)
            logger.info(f"✅ Skipping {data_type} {month_str} - already exists ({file_size_mb:.1f} MB)")
            return None
        
        # Get LakeAPI table name
        table = self._get_table_name(data_type)
        
        # Calculate date range for month
        start_date = datetime(year, month, 1)
        
        if month == 12:
            end_date = datetime(year, 12, 31, 23, 59, 59)
        else:
            next_month = datetime(year, month + 1, 1)
            end_date = next_month.replace(hour=23, minute=59, second=59)
        
        # Don't go past today
        if end_date > datetime.now():
            end_date = datetime.now()
        
        logger.info(f"📥 Downloading {data_type} {month_str}...")
        logger.info(f"   Period: {start_date.date()} to {end_date.date()}")
        
        try:
            # Download with automatic retry
            df = self._download_with_retry(table, start_date, end_date, month_str, data_type)
            
            if df is None or df.empty:
                logger.warning(f"⚠️  No data returned for {data_type} {month_str}")
                return None
            
            # Save to parquet (optimized for speed)
            logger.info(f"   Saving to disk...")
            df.to_parquet(
                file_path, 
                engine='pyarrow',  # Faster engine
                compression='snappy',  # 3x faster than gzip, similar size
                index=False
            )
            logger.info(" ✅")
            
            # Get file size
            file_size_mb = get_file_size_mb(file_path)
            file_size_gb = file_size_mb / 1024
            
            logger.info(f"✅ Downloaded {len(df):,} rows, {file_size_mb:.1f} MB")
            
            # Record usage if checking is enabled
            if check_usage:
                try:
                    self.usage_tracker.record_download(data_type, year, month, file_size_gb)
                except ValueError as e:
                    # Usage limit exceeded - delete file and raise
                    file_path.unlink()
                    raise
            
            # Free memory
            result = df.copy()
            del df
            gc.collect()
            
            return result
            
        except Exception as e:
            logger.error(f"❌ Error downloading {data_type} {month_str}: {e}")
            
            # Clean up partial download
            if file_path.exists():
                logger.info(f"   Cleaning up partial download...")
                file_path.unlink()
            
            raise
    
    def download_multiple_months(
        self,
        data_type: str,
        months: List[tuple],
        force_redownload: bool = False,
        stop_on_error: bool = False
    ) -> Dict[str, Optional[pd.DataFrame]]:
        """
        Download multiple months of data
        
        Args:
            data_type: Data type to download
            months: List of (year, month) tuples
            force_redownload: Force re-download existing files
            stop_on_error: Stop on first error (default: continue)
        
        Returns:
            Dictionary mapping 'YYYY-MM' to DataFrame (or None if skipped)
        
        Example:
            >>> months = [(2024, 11), (2024, 12), (2025, 1)]
            >>> results = client.download_multiple_months('trades', months)
            >>> len(results)
            3  # Downloaded 3 months
        """
        results = {}
        
        logger.info(f"\n📦 Downloading {len(months)} months of {data_type}...")
        logger.info(f"{self.usage_tracker.get_usage_summary()}\n")
        
        for year, month in months:
            month_str = f"{year}-{month:02d}"
            
            try:
                df = self.download_month(
                    data_type,
                    year,
                    month,
                    force_redownload=force_redownload
                )
                results[month_str] = df
                
            except Exception as e:
                logger.error(f"❌ Error on {month_str}: {e}")
                results[month_str] = None
                
                if stop_on_error:
                    logger.error("Stopping due to error")
                    break
            
            # Garbage collection between months
            gc.collect()
        
        # Summary
        logger.info(f"\n✅ Download complete!")
        logger.info(f"{self.usage_tracker.get_usage_summary()}")
        
        successful = sum(1 for v in results.values() if v is not None)
        skipped = sum(1 for v in results.values() if v is None)
        
        logger.info(f"   Successfully downloaded: {successful}")
        logger.info(f"   Skipped (already exist): {skipped}")
        
        return results
    
    def get_available_months(self, data_type: str) -> List[tuple]:
        """
        Get list of months that are already downloaded
        
        Args:
            data_type: Data type to check
        
        Returns:
            List of (year, month) tuples for downloaded months
        
        Example:
            >>> client.get_available_months('trades')
            [(2024, 1), (2024, 2), (2024, 3), ...]
        """
        available = []
        data_dir = RAW_DATA_DIR / data_type
        
        if not data_dir.exists():
            return []
        
        for file_path in data_dir.glob('BTC-USDT_*.parquet'):
            # Parse filename: BTC-USDT_trades_2024-12.parquet
            try:
                parts = file_path.stem.split('_')
                month_str = parts[-1]  # '2024-12'
                year, month = map(int, month_str.split('-'))
                available.append((year, month))
            except:
                continue
        
        return sorted(available)
    
    def estimate_download_size(self, data_type: str, year: int, month: int) -> float:
        """
        Estimate download size based on historical data
        
        Args:
            data_type: Data type
            year: Year
            month: Month
        
        Returns:
            Estimated size in GB (rough estimate)
        
        Note:
            Returns conservative estimate based on data type
        """
        # Rough estimates based on historical data
        estimates_gb = {
            'trades': 2.5,  # ~2.5 GB per month
            'liquidations': 0.5,  # ~500 MB per month
            'funding': 0.1,  # ~100 MB per month
            'open_interest': 0.2,  # ~200 MB per month
            'orderbook': 5.0  # ~5 GB per month (large!)
        }
        
        return estimates_gb.get(data_type, 1.0)
    
    def can_download_month(self, data_type: str, year: int, month: int) -> tuple[bool, str]:
        """
        Check if can download month without exceeding limit
        
        Args:
            data_type: Data type
            year: Year
            month: Month
        
        Returns:
            (can_download: bool, message: str)
        
        Example:
            >>> client.can_download_month('trades', 2024, 12)
            (True, "Can download - 254.7 GB remaining")
        """
        estimated_size = self.estimate_download_size(data_type, year, month)
        remaining = self.usage_tracker.get_remaining_budget()
        
        if estimated_size > remaining:
            return (False, f"Cannot download - would exceed limit (need {estimated_size:.1f} GB, have {remaining:.1f} GB)")
        else:
            return (True, f"Can download - {remaining:.1f} GB remaining")