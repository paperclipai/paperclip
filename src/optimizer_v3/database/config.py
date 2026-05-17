"""
Database Configuration Management
Task 0.2: PostgreSQL Configuration Loading

Loads database configuration from environment variables (.env file)
"""

import os
from typing import Dict, Any
from dotenv import load_dotenv


def get_db_config() -> Dict[str, Any]:
    """
    Load database configuration from environment
    
    Returns:
        Dictionary containing database connection parameters:
        - host: PostgreSQL host address
        - port: PostgreSQL port number
        - database: Database name
        - user: Database user
        - password: Database password
        - ssl: SSL enabled flag
        - ssl_cert_path: Path to SSL certificate
        - ssl_key_path: Path to SSL key
        - pool_size: Connection pool size
        - max_overflow: Maximum overflow connections
        - pool_timeout: Connection timeout in seconds
        - pool_recycle: Connection recycle time in seconds
    """
    load_dotenv()
    
    return {
        'host': os.getenv('POSTGRES_HOST', 'localhost'),
        'port': int(os.getenv('POSTGRES_PORT', '5432')),
        'database': os.getenv('POSTGRES_DB', 'optimizer_v3'),
        'user': os.getenv('POSTGRES_USER', 'optimizer_admin'),
        'password': os.getenv('POSTGRES_PASSWORD', ''),
        'ssl': os.getenv('POSTGRES_SSL', 'false').lower() == 'true',
        'ssl_cert_path': os.getenv('POSTGRES_SSL_CERT_PATH'),
        'ssl_key_path': os.getenv('POSTGRES_SSL_KEY_PATH'),
        'pool_size': int(os.getenv('POSTGRES_POOL_SIZE', '10')),
        'max_overflow': int(os.getenv('POSTGRES_MAX_OVERFLOW', '20')),
        'pool_timeout': int(os.getenv('POSTGRES_POOL_TIMEOUT', '30')),
        'pool_recycle': int(os.getenv('POSTGRES_POOL_RECYCLE', '3600'))
    }


def get_performance_config() -> Dict[str, Any]:
    """
    Load performance configuration from environment
    
    Returns:
        Dictionary containing PostgreSQL performance settings:
        - shared_buffers: Shared memory buffer size
        - work_mem: Memory for sort operations
        - maintenance_work_mem: Memory for maintenance operations
        - effective_cache_size: Expected OS cache size
        - wal_buffers: Write-ahead log buffers
        - checkpoint_timeout: Checkpoint interval
        - random_page_cost: Random page access cost
        - effective_io_concurrency: Expected concurrent I/O operations
    """
    load_dotenv()
    
    return {
        'shared_buffers': os.getenv('POSTGRES_SHARED_BUFFERS', '1GB'),
        'work_mem': os.getenv('POSTGRES_WORK_MEM', '32MB'),
        'maintenance_work_mem': os.getenv('POSTGRES_MAINTENANCE_WORK_MEM', '256MB'),
        'effective_cache_size': os.getenv('POSTGRES_EFFECTIVE_CACHE_SIZE', '3GB'),
        'wal_buffers': os.getenv('POSTGRES_WAL_BUFFERS', '16MB'),
        'checkpoint_timeout': os.getenv('POSTGRES_CHECKPOINT_TIMEOUT', '10min'),
        'random_page_cost': float(os.getenv('POSTGRES_RANDOM_PAGE_COST', '1.1')),
        'effective_io_concurrency': int(os.getenv('POSTGRES_EFFECTIVE_IO_CONCURRENCY', '200'))
    }


def get_monitoring_config() -> Dict[str, Any]:
    """
    Load monitoring configuration from environment
    
    Returns:
        Dictionary containing monitoring settings:
        - log_min_duration: Minimum query duration to log (ms)
        - log_connections: Log new connections
        - log_disconnections: Log disconnections
    """
    load_dotenv()
    
    return {
        'log_min_duration': int(os.getenv('POSTGRES_LOG_MIN_DURATION', '1000')),
        'log_connections': os.getenv('POSTGRES_LOG_CONNECTIONS', 'false').lower() == 'true',
        'log_disconnections': os.getenv('POSTGRES_LOG_DISCONNECTIONS', 'false').lower() == 'true'
    }


def get_backup_config() -> Dict[str, Any]:
    """
    Load backup configuration from environment
    
    Returns:
        Dictionary containing backup settings:
        - backup_path: Path to store backups
        - retention_days: Number of days to keep backups
        - compression: Enable backup compression
    """
    load_dotenv()
    
    return {
        'backup_path': os.getenv('POSTGRES_BACKUP_PATH', '/tmp/optimizer_v3_backups'),
        'retention_days': int(os.getenv('POSTGRES_BACKUP_RETENTION_DAYS', '30')),
        'compression': os.getenv('POSTGRES_BACKUP_COMPRESSION', 'true').lower() == 'true'
    }


def get_db_url() -> str:
    """
    Generate PostgreSQL database URL from configuration
    
    Returns:
        PostgreSQL connection URL string
        Format: postgresql://user:password@host:port/database
    """
    config = get_db_config()
    return (
        f"postgresql://{config['user']}:"
        f"{config['password']}@"
        f"{config['host']}:"
        f"{config['port']}/"
        f"{config['database']}"
    )


def validate_config() -> bool:
    """
    Validate that all required configuration is present
    
    Returns:
        True if configuration is valid, raises ValueError otherwise
    
    Raises:
        ValueError: If required configuration is missing
    """
    config = get_db_config()
    
    required_fields = ['host', 'port', 'database', 'user', 'password']
    missing_fields = [field for field in required_fields if not config.get(field)]
    
    if missing_fields:
        raise ValueError(
            f"Missing required database configuration: {', '.join(missing_fields)}\n"
            f"Please check your .env file and ensure all POSTGRES_* variables are set."
        )
    
    return True
