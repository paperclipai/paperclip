"""LakeAPI Usage Tracker - 300GB/month limit enforcement"""

import json
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional
from ..config import USAGE_TRACKING_FILE, LAKEAPI_LIMIT_GB, LAKEAPI_WARNING_GB

import logging
logger = logging.getLogger(__name__)

class UsageTracker:
    """
    Track LakeAPI data transfer usage to stay under 300GB/month limit
    
    Critical for cost control - real money at risk!
    
    Example:
        >>> tracker = UsageTracker()
        >>> tracker.record_download('trades', 2024, 12, 2.5)
        >>> tracker.get_monthly_usage()
        2.5  # GB used this month
    """
    
    def __init__(self, tracking_file: Optional[Path] = None):
        """
        Initialize usage tracker
        
        Args:
            tracking_file: Path to usage tracking file (default: from config)
        """
        self.tracking_file = tracking_file or USAGE_TRACKING_FILE
        self.limit_gb = LAKEAPI_LIMIT_GB
        self.warning_gb = LAKEAPI_WARNING_GB
        
        # Ensure tracking file directory exists
        self.tracking_file.parent.mkdir(parents=True, exist_ok=True)
        
        # Load or initialize usage data
        self.usage_data = self._load_usage_data()
    
    def _load_usage_data(self) -> Dict:
        """Load usage data from file"""
        if not self.tracking_file.exists():
            # Initialize new tracking file
            return self._initialize_usage_data()
        
        try:
            with open(self.tracking_file, 'r') as f:
                data = json.load(f)
            
            # Check if we need to reset for new month
            current_month = datetime.now().strftime('%Y-%m')
            if data.get('month') != current_month:
                logger.info(f"📅 New month detected: {current_month}")
                logger.info(f"Previous month ({data.get('month')}): {data.get('total_gb', 0):.2f} GB used")
                return self._initialize_usage_data()
            
            return data
            
        except Exception as e:
            logger.error(f"⚠️  Error loading usage data: {e}")
            return self._initialize_usage_data()
    
    def _initialize_usage_data(self) -> Dict:
        """Initialize new usage data for current month"""
        current_month = datetime.now().strftime('%Y-%m')
        
        data = {
            'month': current_month,
            'total_gb': 0.0,
            'downloads': [],
            'limit_gb': self.limit_gb,
            'warning_gb': self.warning_gb,
            'created': datetime.now().isoformat()
        }
        
        self._save_usage_data(data)
        return data
    
    def _save_usage_data(self, data: Optional[Dict] = None):
        """Save usage data to file"""
        if data is None:
            data = self.usage_data
        
        try:
            with open(self.tracking_file, 'w') as f:
                json.dump(data, f, indent=2)
        except Exception as e:
            logger.error(f"⚠️  Error saving usage data: {e}")
    
    def record_download(self, data_type: str, year: int, month: int, size_gb: float) -> float:
        """
        Record a data download
        
        Args:
            data_type: Type of data ('trades', 'liquidations', etc.)
            year: Year downloaded
            month: Month downloaded
            size_gb: Size in gigabytes
        
        Returns:
            New total usage in GB
        
        Example:
            >>> tracker.record_download('trades', 2024, 12, 2.5)
            2.5  # Total GB used
        
        Raises:
            ValueError: If download would exceed limit
        """
        # Check if this would exceed limit
        new_total = self.usage_data['total_gb'] + size_gb
        
        if new_total > self.limit_gb:
            raise ValueError(
                f"❌ DOWNLOAD BLOCKED: Would exceed {self.limit_gb}GB limit!\n"
                f"Current: {self.usage_data['total_gb']:.2f} GB\n"
                f"Requested: {size_gb:.2f} GB\n"
                f"Would be: {new_total:.2f} GB\n"
                f"Limit: {self.limit_gb} GB"
            )
        
        # Record download
        download_record = {
            'timestamp': datetime.now().isoformat(),
            'data_type': data_type,
            'year': year,
            'month': month,
            'size_gb': round(size_gb, 3)
        }
        
        self.usage_data['downloads'].append(download_record)
        self.usage_data['total_gb'] = round(new_total, 3)
        
        # Save immediately
        self._save_usage_data()
        
        # Check if approaching warning threshold
        if new_total >= self.warning_gb:
            logger.warning(f"⚠️  WARNING: Approaching LakeAPI limit!")
            logger.info(f"Used: {new_total:.2f} GB / {self.limit_gb} GB ({new_total/self.limit_gb*100:.1f}%)")
        
        return new_total
    
    def get_monthly_usage(self) -> float:
        """
        Get total usage for current month
        
        Returns:
            Total GB used this month
        
        Example:
            >>> tracker.get_monthly_usage()
            45.3  # GB
        """
        return self.usage_data.get('total_gb', 0.0)
    
    def get_remaining_budget(self) -> float:
        """
        Get remaining budget for current month
        
        Returns:
            Remaining GB available
        
        Example:
            >>> tracker.get_remaining_budget()
            254.7  # GB remaining
        """
        used = self.get_monthly_usage()
        remaining = self.limit_gb - used
        return max(0.0, remaining)
    
    def is_approaching_limit(self) -> bool:
        """
        Check if approaching usage limit (>93%)
        
        Returns:
            True if >= warning threshold, False otherwise
        
        Example:
            >>> tracker.is_approaching_limit()
            False  # Still have budget
        """
        return self.get_monthly_usage() >= self.warning_gb
    
    def can_download(self, size_gb: float) -> bool:
        """
        Check if can download given size without exceeding limit
        
        Args:
            size_gb: Size to download in GB
        
        Returns:
            True if download allowed, False otherwise
        
        Example:
            >>> tracker.can_download(10.5)
            True  # Can download 10.5 GB
        """
        return (self.get_monthly_usage() + size_gb) <= self.limit_gb
    
    def get_usage_summary(self) -> str:
        """
        Get formatted usage summary
        
        Returns:
            Formatted string with usage details
        
        Example:
            >>> print(tracker.get_usage_summary())
            LakeAPI Usage (2026-01):
              Used: 45.3 GB / 300 GB (15.1%)
              Remaining: 254.7 GB
              Downloads: 23
        """
        used = self.get_monthly_usage()
        remaining = self.get_remaining_budget()
        pct = (used / self.limit_gb * 100) if self.limit_gb > 0 else 0
        downloads_count = len(self.usage_data.get('downloads', []))
        
        return (
            f"LakeAPI Usage ({self.usage_data.get('month', 'Unknown')}):\n"
            f"  Used: {used:.2f} GB / {self.limit_gb} GB ({pct:.1f}%)\n"
            f"  Remaining: {remaining:.2f} GB\n"
            f"  Downloads: {downloads_count}"
        )
    
    def get_downloads_by_type(self) -> Dict[str, float]:
        """
        Get total downloads grouped by data type
        
        Returns:
            Dictionary mapping data type to total GB
        
        Example:
            >>> tracker.get_downloads_by_type()
            {'trades': 25.3, 'liquidations': 5.2, 'funding': 2.1}
        """
        by_type = {}
        
        for download in self.usage_data.get('downloads', []):
            data_type = download.get('data_type', 'unknown')
            size = download.get('size_gb', 0.0)
            
            if data_type not in by_type:
                by_type[data_type] = 0.0
            
            by_type[data_type] += size
        
        # Round values
        return {k: round(v, 3) for k, v in by_type.items()}
    
    def get_warning_message(self) -> Optional[str]:
        """
        Get warning message if approaching or over limit
        
        Returns:
            Warning message if applicable, None otherwise
        
        Example:
            >>> tracker.get_warning_message()
            '⚠️  WARNING: 285 GB used (95% of limit)'
        """
        used = self.get_monthly_usage()
        
        if used >= self.limit_gb:
            return f"🛑 CRITICAL: {used:.2f} GB used - LIMIT EXCEEDED!"
        elif used >= self.warning_gb:
            pct = (used / self.limit_gb * 100)
            return f"⚠️  WARNING: {used:.2f} GB used ({pct:.1f}% of limit)"
        
        return None
    
    def get_download_history(self, limit: int = 10) -> List[Dict]:
        """
        Get recent download history
        
        Args:
            limit: Maximum number of records to return
        
        Returns:
            List of recent download records
        
        Example:
            >>> tracker.get_download_history(limit=5)
            [{'timestamp': '...', 'data_type': 'trades', ...}, ...]
        """
        downloads = self.usage_data.get('downloads', [])
        return downloads[-limit:] if limit else downloads
    
    def validate_limit(self):
        """
        Validate current usage is under limit
        
        Raises:
            ValueError: If limit exceeded
        
        Example:
            >>> tracker.validate_limit()  # Raises if over limit
        """
        used = self.get_monthly_usage()
        
        if used > self.limit_gb:
            raise ValueError(
                f"❌ LakeAPI limit exceeded!\n"
                f"Used: {used:.2f} GB\n"
                f"Limit: {self.limit_gb} GB\n"
                f"Over by: {used - self.limit_gb:.2f} GB"
            )