"""Date and time utility functions for data management"""

from datetime import datetime, timedelta
from typing import List, Tuple
from pathlib import Path
import time


def generate_month_range(start_date: str, end_date: str) -> List[Tuple[int, int]]:
    """
    Generate list of (year, month) tuples between start and end dates
    
    Args:
        start_date: Start date in 'YYYY-MM-DD' format
        end_date: End date in 'YYYY-MM-DD' format
    
    Returns:
        List of (year, month) tuples
    
    Example:
        >>> generate_month_range('2024-11-01', '2025-02-28')
        [(2024, 11), (2024, 12), (2025, 1), (2025, 2)]
    
    Raises:
        ValueError: If end_date is before start_date
    """
    start = datetime.strptime(start_date, '%Y-%m-%d')
    end = datetime.strptime(end_date, '%Y-%m-%d')
    
    if end < start:
        raise ValueError(f"End date {end_date} is before start date {start_date}")
    
    months = []
    current = start
    
    while current <= end:
        months.append((current.year, current.month))
        
        # Move to next month
        if current.month == 12:
            current = datetime(current.year + 1, 1, 1)
        else:
            current = datetime(current.year, current.month + 1, 1)
    
    return months


def get_current_month() -> str:
    """
    Get current month in 'YYYY-MM' format
    
    Returns:
        Current month string
    
    Example:
        >>> get_current_month()
        '2026-01'
    """
    return datetime.now().strftime('%Y-%m')


def is_current_month(year: int, month: int) -> bool:
    """
    Check if given year/month is the current month
    
    Args:
        year: Year
        month: Month (1-12)
    
    Returns:
        True if current month, False otherwise
    
    Example:
        >>> is_current_month(2026, 1)
        True  # If current month is January 2026
    """
    now = datetime.now()
    return now.year == year and now.month == month


def get_file_age_hours(file_path: Path) -> float:
    """
    Get file age in hours
    
    Args:
        file_path: Path to file
    
    Returns:
        File age in hours
    
    Raises:
        FileNotFoundError: If file doesn't exist
    
    Example:
        >>> get_file_age_hours(Path('data.parquet'))
        12.5  # File is 12.5 hours old
    """
    if not file_path.exists():
        raise FileNotFoundError(f"File not found: {file_path}")
    
    file_mtime = file_path.stat().st_mtime
    current_time = time.time()
    age_seconds = current_time - file_mtime
    age_hours = age_seconds / 3600
    
    return age_hours


def format_month_string(year: int, month: int) -> str:
    """
    Format year and month as 'YYYY-MM' string
    
    Args:
        year: Year
        month: Month (1-12)
    
    Returns:
        Formatted month string
    
    Example:
        >>> format_month_string(2025, 3)
        '2025-03'
    """
    return f"{year}-{month:02d}"


def parse_month_string(month_str: str) -> Tuple[int, int]:
    """
    Parse 'YYYY-MM' string into (year, month) tuple
    
    Args:
        month_str: Month string in 'YYYY-MM' format
    
    Returns:
        (year, month) tuple
    
    Raises:
        ValueError: If invalid format
    
    Example:
        >>> parse_month_string('2025-03')
        (2025, 3)
    """
    try:
        year, month = month_str.split('-')
        return (int(year), int(month))
    except (ValueError, AttributeError):
        raise ValueError(f"Invalid month string format: {month_str}. Expected 'YYYY-MM'")


def get_month_start_end(year: int, month: int) -> Tuple[datetime, datetime]:
    """
    Get start and end datetime for a given month
    
    Args:
        year: Year
        month: Month (1-12)
    
    Returns:
        (start_datetime, end_datetime) tuple
    
    Example:
        >>> get_month_start_end(2025, 2)
        (datetime(2025, 2, 1, 0, 0), datetime(2025, 2, 28, 23, 59, 59))
    """
    start = datetime(year, month, 1)
    
    # Get last day of month
    if month == 12:
        end = datetime(year, 12, 31, 23, 59, 59)
    else:
        # Last second of last day
        next_month = datetime(year, month + 1, 1)
        end = next_month - timedelta(seconds=1)
    
    return (start, end)


def is_file_stale(file_path: Path, max_age_hours: float = 24.0) -> bool:
    """
    Check if file is stale (older than max_age_hours)
    
    Args:
        file_path: Path to file
        max_age_hours: Maximum age in hours before file is considered stale
    
    Returns:
        True if file is stale or doesn't exist, False otherwise
    
    Example:
        >>> is_file_stale(Path('data.parquet'), max_age_hours=24.0)
        True  # File is older than 24 hours
    """
    if not file_path.exists():
        return True  # Missing file is considered stale
    
    try:
        age_hours = get_file_age_hours(file_path)
        return age_hours > max_age_hours
    except Exception:
        return True  # Error reading file = consider stale