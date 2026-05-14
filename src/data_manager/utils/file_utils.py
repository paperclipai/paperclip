"""File operation utilities for data management"""

from pathlib import Path
from typing import Optional, List
import shutil
import os

import logging
logger = logging.getLogger(__name__)

def ensure_directory_exists(directory: Path) -> Path:
    """
    Create directory if it doesn't exist, including parent directories
    
    Args:
        directory: Path to directory
    
    Returns:
        Path to created directory
    
    Example:
        >>> ensure_directory_exists(Path('data/raw/trades'))
        PosixPath('data/raw/trades')
    
    Note:
        Safe to call multiple times - idempotent operation
    """
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def get_file_size_mb(file_path: Path) -> float:
    """
    Get file size in megabytes
    
    Args:
        file_path: Path to file
    
    Returns:
        File size in MB
    
    Raises:
        FileNotFoundError: If file doesn't exist
    
    Example:
        >>> get_file_size_mb(Path('data.parquet'))
        245.8  # File is 245.8 MB
    """
    if not file_path.exists():
        raise FileNotFoundError(f"File not found: {file_path}")
    
    size_bytes = file_path.stat().st_size
    size_mb = size_bytes / (1024 * 1024)
    
    return size_mb


def safe_delete_file(file_path: Path, backup: bool = True, backup_dir: Optional[Path] = None) -> bool:
    """
    Safely delete file with optional backup
    
    Args:
        file_path: Path to file to delete
        backup: Whether to backup before deleting
        backup_dir: Directory for backup (default: same dir with .backup suffix)
    
    Returns:
        True if deleted successfully, False otherwise
    
    Example:
        >>> safe_delete_file(Path('corrupted.parquet'), backup=True)
        True  # File deleted, backup created
    """
    if not file_path.exists():
        return False
    
    try:
        if backup:
            # Create backup
            if backup_dir is None:
                backup_path = file_path.parent / f"{file_path.name}.backup"
            else:
                backup_dir = Path(backup_dir)
                backup_dir.mkdir(parents=True, exist_ok=True)
                backup_path = backup_dir / file_path.name
            
            shutil.copy2(file_path, backup_path)
        
        # Delete original
        file_path.unlink()
        return True
        
    except Exception as e:
        logger.error(f"Error deleting file {file_path}: {e}")
        return False


def list_parquet_files(directory: Path, pattern: str = "*.parquet", recursive: bool = False) -> List[Path]:
    """
    List all parquet files in directory
    
    Args:
        directory: Directory to search
        pattern: File pattern to match
        recursive: Whether to search recursively
    
    Returns:
        List of matching file paths, sorted
    
    Example:
        >>> list_parquet_files(Path('data/raw/trades'))
        [PosixPath('data/raw/trades/BTC-USDT_trades_2024-01.parquet'), ...]
    """
    directory = Path(directory)
    
    if not directory.exists():
        return []
    
    if recursive:
        files = list(directory.rglob(pattern))
    else:
        files = list(directory.glob(pattern))
    
    return sorted(files)


def copy_file_with_metadata(source: Path, destination: Path, preserve_stats: bool = True) -> bool:
    """
    Copy file preserving metadata (modification time, permissions)
    
    Args:
        source: Source file path
        destination: Destination file path
        preserve_stats: Whether to preserve file stats
    
    Returns:
        True if copied successfully, False otherwise
    
    Example:
        >>> copy_file_with_metadata(Path('data.parquet'), Path('backup/data.parquet'))
        True
    """
    if not source.exists():
        raise FileNotFoundError(f"Source file not found: {source}")
    
    try:
        # Ensure destination directory exists
        destination.parent.mkdir(parents=True, exist_ok=True)
        
        if preserve_stats:
            # Preserve metadata
            shutil.copy2(source, destination)
        else:
            # Just copy file
            shutil.copy(source, destination)
        
        return True
        
    except Exception as e:
        logger.error(f"Error copying file: {e}")
        return False


def get_directory_size_mb(directory: Path) -> float:
    """
    Get total size of all files in directory (recursive) in MB
    
    Args:
        directory: Directory to measure
    
    Returns:
        Total size in MB
    
    Example:
        >>> get_directory_size_mb(Path('data/raw/trades'))
        1523.4  # Total size: 1.5 GB
    """
    directory = Path(directory)
    
    if not directory.exists():
        return 0.0
    
    total_bytes = 0
    for file_path in directory.rglob('*'):
        if file_path.is_file():
            total_bytes += file_path.stat().st_size
    
    total_mb = total_bytes / (1024 * 1024)
    return total_mb


def clean_temp_files(directory: Path, patterns: List[str] = None) -> int:
    """
    Clean temporary files from directory
    
    Args:
        directory: Directory to clean
        patterns: List of file patterns to delete (default: common temp patterns)
    
    Returns:
        Number of files deleted
    
    Example:
        >>> clean_temp_files(Path('data/temp'), patterns=['*.tmp', '*.temp'])
        5  # Deleted 5 temp files
    """
    if patterns is None:
        patterns = ['*.tmp', '*.temp', '*.bak', '*~', '.DS_Store']
    
    directory = Path(directory)
    
    if not directory.exists():
        return 0
    
    deleted_count = 0
    
    for pattern in patterns:
        for file_path in directory.rglob(pattern):
            if file_path.is_file():
                try:
                    file_path.unlink()
                    deleted_count += 1
                except Exception as e:
                    logger.error(f"Error deleting {file_path}: {e}")
    
    return deleted_count


def atomic_write(file_path: Path, content: str, encoding: str = 'utf-8') -> bool:
    """
    Write to file atomically (write to temp, then rename)
    
    Prevents file corruption if write is interrupted
    
    Args:
        file_path: Target file path
        content: Content to write
        encoding: File encoding
    
    Returns:
        True if successful, False otherwise
    
    Example:
        >>> atomic_write(Path('config.json'), '{"key": "value"}')
        True
    """
    file_path = Path(file_path)
    temp_path = file_path.parent / f".{file_path.name}.tmp"
    
    try:
        # Ensure directory exists
        file_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Write to temp file
        with open(temp_path, 'w', encoding=encoding) as f:
            f.write(content)
        
        # Atomic rename
        temp_path.replace(file_path)
        
        return True
        
    except Exception as e:
        logger.error(f"Error in atomic write: {e}")
        
        # Cleanup temp file if exists
        if temp_path.exists():
            try:
                temp_path.unlink()
            except:
                pass
        
        return False


def verify_file_permissions(file_path: Path, required_permissions: str = 'r') -> bool:
    """
    Verify file has required permissions
    
    Args:
        file_path: Path to file
        required_permissions: Required permissions ('r', 'w', 'x', or combinations)
    
    Returns:
        True if has required permissions, False otherwise
    
    Example:
        >>> verify_file_permissions(Path('data.parquet'), 'r')
        True  # File is readable
    """
    if not file_path.exists():
        return False
    
    permissions = {
        'r': os.access(file_path, os.R_OK),
        'w': os.access(file_path, os.W_OK),
        'x': os.access(file_path, os.X_OK),
    }
    
    for perm in required_permissions:
        if perm in permissions and not permissions[perm]:
            return False
    
    return True