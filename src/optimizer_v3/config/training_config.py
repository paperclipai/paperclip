"""
Training System Configuration Loader
Sprint 2.1 - Task 2.1.0

Loads training configuration from environment variables.
All values properly typed for NautilusTrader integration.
"""

from dotenv import load_dotenv
import os
from decimal import Decimal
from typing import Dict, Any
from pathlib import Path


def get_training_config() -> Dict[str, Any]:
    """
    Load training configuration from environment
    
    Returns:
        dict: Complete training configuration with proper types
    """
    load_dotenv()
    
    return {
        'training': {
            'max_lookback': int(os.getenv('TRAINING_MAX_LOOKBACK', '180')),
            'min_signals': int(os.getenv('TRAINING_MIN_SIGNALS', '50')),
            'max_timeframes': int(os.getenv('TRAINING_MAX_TIMEFRAMES', '5')),
            'batch_size': int(os.getenv('TRAINING_BATCH_SIZE', '1000')),
            'parallel_blocks': int(os.getenv('TRAINING_PARALLEL_BLOCKS', '4'))
        },
        'signal': {
            'forward_bars': int(os.getenv('SIGNAL_FORWARD_BARS', '10')),
            'min_occurrence': int(os.getenv('SIGNAL_MIN_OCCURRENCE', '5')),
            'min_confidence': float(os.getenv('SIGNAL_MIN_CONFIDENCE', '0.95')),
            'max_correlation': float(os.getenv('SIGNAL_MAX_CORRELATION', '0.7')),
            'min_impact': float(os.getenv('SIGNAL_MIN_IMPACT', '0.001'))
        },
        'price': {
            'volatility_window': int(os.getenv('PRICE_VOLATILITY_WINDOW', '20')),
            'impact_threshold': float(os.getenv('PRICE_IMPACT_THRESHOLD', '0.002')),
            'noise_filter': float(os.getenv('PRICE_NOISE_FILTER', '0.0005')),
            'trend_strength': float(os.getenv('PRICE_TREND_STRENGTH', '0.6')),
            'reversal_threshold': float(os.getenv('PRICE_REVERSAL_THRESHOLD', '0.8'))
        },
        'position': {
            'max_size': Decimal(os.getenv('POSITION_MAX_SIZE', '1.0')),
            'min_size': Decimal(os.getenv('POSITION_MIN_SIZE', '0.001')),
            'size_increment': Decimal(os.getenv('POSITION_SIZE_INCREMENT', '0.001')),
            'risk_limit': int(os.getenv('POSITION_RISK_LIMIT', '500')),
            'max_notional': int(os.getenv('POSITION_MAX_NOTIONAL', '50000'))
        },
        'risk': {
            'max_drawdown': float(os.getenv('RISK_MAX_DRAWDOWN', '0.02')),
            'min_win_rate': float(os.getenv('RISK_MIN_WIN_RATE', '0.55')),
            'min_profit_factor': float(os.getenv('RISK_MIN_PROFIT_FACTOR', '1.5')),
            'max_correlation': float(os.getenv('RISK_MAX_CORRELATION', '0.7')),
            'max_exposure': float(os.getenv('RISK_MAX_EXPOSURE', '0.1'))
        },
        'database': {
            'max_signals': int(os.getenv('DB_MAX_SIGNALS', '1000000')),
            'cleanup_interval': int(os.getenv('DB_CLEANUP_INTERVAL', '86400')),
            'min_keep_days': int(os.getenv('DB_MIN_KEEP_DAYS', '30')),
            'compression': os.getenv('DB_COMPRESSION', 'true').lower() == 'true',
            'backup_enabled': os.getenv('DB_BACKUP_ENABLED', 'true').lower() == 'true'
        },
        'performance': {
            'max_memory': int(os.getenv('PERF_MAX_MEMORY', '4096')),
            'max_cpu': int(os.getenv('PERF_MAX_CPU', '90')),
            'max_disk': int(os.getenv('PERF_MAX_DISK', '90')),
            'min_signals_per_sec': int(os.getenv('PERF_MIN_SIGNALS_PER_SEC', '100'))
        },
        'resources': {
            'check_interval': int(os.getenv('RESOURCE_CHECK_INTERVAL', '60')),
            'warning_threshold': int(os.getenv('RESOURCE_WARNING_THRESHOLD', '80')),
            'critical_threshold': int(os.getenv('RESOURCE_CRITICAL_THRESHOLD', '90')),
            'auto_cleanup': os.getenv('RESOURCE_AUTO_CLEANUP', 'true').lower() == 'true',
            'history_length': int(os.getenv('RESOURCE_HISTORY_LENGTH', '1440'))
        },
        'ui': {
            'update_interval': int(os.getenv('UI_UPDATE_INTERVAL', '1000')),
            'chart_points': int(os.getenv('UI_CHART_POINTS', '1000')),
            'table_rows': int(os.getenv('UI_TABLE_ROWS', '1000')),
            'auto_refresh': os.getenv('UI_AUTO_REFRESH', 'true').lower() == 'true',
            'cache_timeout': int(os.getenv('UI_CACHE_TIMEOUT', '300'))
        },
        'logging': {
            'level': os.getenv('LOG_LEVEL', 'INFO'),
            'format': os.getenv('LOG_FORMAT', '%(asctime)s | %(name)s | %(levelname)s | %(message)s'),
            'path': Path(os.getenv('LOG_PATH', 'logs/training')),
            'rotation': int(os.getenv('LOG_ROTATION', '5')),
            'max_size': int(os.getenv('LOG_MAX_SIZE', '10'))
        }
    }
