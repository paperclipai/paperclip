"""Checksum utilities for file integrity verification"""

import hashlib
import logging
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional
import json

import logging
logger = logging.getLogger(__name__)


logger = logging.getLogger(__name__)


def calculate_checksum(file_path: Path, algorithm: str = 'sha256') -> str:
    """
    Calculate checksum for file
    
    Args:
        file_path: Path to file
        algorithm: Hash algorithm ('sha256', 'md5', 'sha1')
    
    Returns:
        Hexadecimal checksum string
    
    Raises:
        FileNotFoundError: If file doesn't exist
        ValueError: If algorithm not supported
    
    Example:
        >>> calculate_checksum(Path('data.parquet'))
        'a7f5c2e8b9d1...'  # SHA256 hash
    
    Note:
        Uses SHA256 by default for institutional-grade integrity checking
    """
    if not file_path.exists():
        raise FileNotFoundError(f"File not found: {file_path}")
    
    # Select hash algorithm
    if algorithm == 'sha256':
        hasher = hashlib.sha256()
    elif algorithm == 'md5':
        hasher = hashlib.md5()
    elif algorithm == 'sha1':
        hasher = hashlib.sha1()
    else:
        raise ValueError(f"Unsupported algorithm: {algorithm}")
    
    # Read file in chunks to handle large files
    with open(file_path, 'rb') as f:
        for chunk in iter(lambda: f.read(8192), b''):
            hasher.update(chunk)
    
    return hasher.hexdigest()


def verify_checksum(file_path: Path, expected_checksum: str, algorithm: str = 'sha256') -> bool:
    """
    Verify file checksum matches expected value
    
    Args:
        file_path: Path to file
        expected_checksum: Expected checksum hex string
        algorithm: Hash algorithm used
    
    Returns:
        True if checksum matches, False otherwise
    
    Example:
        >>> verify_checksum(Path('data.parquet'), 'a7f5c2e8b9d1...')
        True  # Checksum matches
    
    Note:
        Returns False if file doesn't exist or checksum doesn't match
    """
    try:
        actual_checksum = calculate_checksum(file_path, algorithm)
        return actual_checksum == expected_checksum
    except Exception:
        return False


def save_checksum_metadata(file_path: Path, metadata_file: Optional[Path] = None) -> Dict[str, str]:
    """
    Calculate and save checksum metadata for file
    
    Args:
        file_path: Path to file
        metadata_file: Path to metadata file (default: {file}.checksum.json)
    
    Returns:
        Dictionary with checksum metadata
    
    Example:
        >>> save_checksum_metadata(Path('data.parquet'))
        {
            'file': 'data.parquet',
            'checksum': 'a7f5c2e8...',
            'algorithm': 'sha256',
            'size_bytes': 2560000,
            'timestamp': '2026-01-08T12:30:00'
        }
    
    Note:
        Saves metadata as JSON file for later verification
    """
    if not file_path.exists():
        raise FileNotFoundError(f"File not found: {file_path}")
    
    # Calculate checksum
    checksum = calculate_checksum(file_path)
    
    # Get file metadata
    stat = file_path.stat()
    
    metadata = {
        'file': file_path.name,
        'checksum': checksum,
        'algorithm': 'sha256',
        'size_bytes': stat.st_size,
        'timestamp': datetime.now().isoformat()
    }
    
    # Save metadata
    if metadata_file is None:
        metadata_file = file_path.parent / f"{file_path.name}.checksum.json"
    
    with open(metadata_file, 'w') as f:
        json.dump(metadata, f, indent=2)
    
    return metadata


def load_checksum_metadata(metadata_file: Path) -> Optional[Dict[str, str]]:
    """
    Load checksum metadata from file
    
    Args:
        metadata_file: Path to metadata file
    
    Returns:
        Dictionary with checksum metadata, or None if file doesn't exist
    
    Example:
        >>> load_checksum_metadata(Path('data.parquet.checksum.json'))
        {'file': 'data.parquet', 'checksum': 'a7f5c2e8...', ...}
    """
    if not metadata_file.exists():
        return None
    
    try:
        with open(metadata_file, 'r') as f:
            return json.load(f)
    except Exception:
        return None


def verify_file_integrity(file_path: Path, metadata_file: Optional[Path] = None) -> bool:
    """
    Verify file integrity using stored checksum metadata
    
    Args:
        file_path: Path to file
        metadata_file: Path to metadata file (default: {file}.checksum.json)
    
    Returns:
        True if file is intact, False otherwise
    
    Example:
        >>> verify_file_integrity(Path('data.parquet'))
        True  # File matches stored checksum
    
    Note:
        Returns False if metadata file doesn't exist or checksum doesn't match
    """
    if metadata_file is None:
        metadata_file = file_path.parent / f"{file_path.name}.checksum.json"
    
    # Load metadata
    metadata = load_checksum_metadata(metadata_file)
    if metadata is None:
        return False
    
    # Verify checksum
    return verify_checksum(
        file_path,
        metadata['checksum'],
        metadata.get('algorithm', 'sha256')
    )


def batch_calculate_checksums(directory: Path, pattern: str = "*.parquet") -> Dict[str, str]:
    """
    Calculate checksums for all files matching pattern in directory
    
    Args:
        directory: Directory to search
        pattern: File pattern to match
    
    Returns:
        Dictionary mapping filenames to checksums
    
    Example:
        >>> batch_calculate_checksums(Path('data/raw/trades'))
        {
            'BTC-USDT_trades_2024-01.parquet': 'a7f5c2e8...',
            'BTC-USDT_trades_2024-02.parquet': 'b8g6d3f9...',
            ...
        }
    
    Note:
        Useful for validating multiple downloaded files
    """
    directory = Path(directory)
    
    if not directory.exists():
        return {}
    
    checksums = {}
    
    for file_path in directory.glob(pattern):
        if file_path.is_file():
            try:
                checksum = calculate_checksum(file_path)
                checksums[file_path.name] = checksum
            except Exception as e:
                logger.error(f"Error calculating checksum for {file_path}: {e}")
    
    return checksums


def compare_checksums(checksums1: Dict[str, str], checksums2: Dict[str, str]) -> Dict[str, str]:
    """
    Compare two sets of checksums
    
    Args:
        checksums1: First set of checksums
        checksums2: Second set of checksums
    
    Returns:
        Dictionary of files with different checksums
    
    Example:
        >>> compare_checksums(old_checksums, new_checksums)
        {
            'modified_file.parquet': 'checksum_differs',
            'missing_file.parquet': 'missing_in_new',
            'new_file.parquet': 'new_in_new'
        }
    """
    differences = {}
    
    # Check files in first set
    for filename, checksum1 in checksums1.items():
        if filename not in checksums2:
            differences[filename] = 'missing_in_new'
        elif checksums2[filename] != checksum1:
            differences[filename] = 'checksum_differs'
    
    # Check for new files
    for filename in checksums2:
        if filename not in checksums1:
            differences[filename] = 'new_in_new'
    
    return differences