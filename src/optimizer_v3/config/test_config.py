"""
Test Configuration Loader for Sprint 1.5
Loads testing environment variables and provides configuration access
"""
from dotenv import load_dotenv
import os
from typing import Dict, Any


def get_test_config() -> Dict[str, Any]:
    """Load testing configuration from environment"""
    load_dotenv()
    
    return {
        'test': {
            'parallel_workers': int(os.getenv('TEST_PARALLEL_WORKERS', '4')),
            'timeout': int(os.getenv('TEST_TIMEOUT', '300')),
            'coverage': {
                'minimum': int(os.getenv('TEST_COVERAGE_MIN', '95')),
                'fail_under': os.getenv('TEST_COVERAGE_FAIL', 'true').lower() == 'true'
            },
            'verbosity': int(os.getenv('TEST_VERBOSITY', '2'))
        },
        'performance': {
            'max_runtime': int(os.getenv('PERF_MAX_RUNTIME', '300')),
            'max_memory': int(os.getenv('PERF_MAX_MEMORY', '2048')),
            'min_cpu_util': int(os.getenv('PERF_MIN_CPU_UTIL', '80')),
            'sample_interval': int(os.getenv('PERF_SAMPLE_INTERVAL', '1')),
            'history_length': int(os.getenv('PERF_HISTORY_LENGTH', '300'))
        },
        'load': {
            'configs': int(os.getenv('LOAD_TEST_CONFIGS', '100')),
            'concurrent': int(os.getenv('LOAD_TEST_CONCURRENT', '20')),
            'duration': int(os.getenv('LOAD_TEST_DURATION', '3600')),
            'ramp_up': int(os.getenv('LOAD_TEST_RAMP_UP', '300')),
            'monitor_interval': int(os.getenv('LOAD_TEST_MONITOR_INTERVAL', '60'))
        },
        'integration': {
            'timeout': int(os.getenv('INTEGRATION_TEST_TIMEOUT', '600')),
            'retries': int(os.getenv('INTEGRATION_TEST_RETRIES', '3')),
            'backoff': int(os.getenv('INTEGRATION_TEST_BACKOFF', '30')),
            'cleanup': os.getenv('INTEGRATION_TEST_CLEANUP', 'true').lower() == 'true'
        },
        'profiling': {
            'enabled': os.getenv('PROFILE_ENABLED', 'true').lower() == 'true',
            'output_dir': os.getenv('PROFILE_OUTPUT_DIR', 'profiles'),
            'stats_count': int(os.getenv('PROFILE_STATS_COUNT', '20')),
            'min_time': float(os.getenv('PROFILE_MIN_TIME', '0.1')),
            'sort_by': os.getenv('PROFILE_SORT_BY', 'cumtime')
        },
        'memory': {
            'enabled': os.getenv('MEMORY_PROFILE_ENABLED', 'true').lower() == 'true',
            'sample_interval': int(os.getenv('MEMORY_SAMPLE_INTERVAL', '1')),
            'leak_threshold': int(os.getenv('MEMORY_LEAK_THRESHOLD', '100')),
            'max_snapshots': int(os.getenv('MEMORY_MAX_SNAPSHOTS', '10')),
            'diff_baseline': os.getenv('MEMORY_DIFF_BASELINE', 'true').lower() == 'true'
        },
        'data': {
            'test_path': os.getenv('TEST_DATA_PATH', 'tests/data'),
            'strategies_path': os.getenv('TEST_STRATEGIES_PATH', 'tests/strategies'),
            'results_path': os.getenv('TEST_RESULTS_PATH', 'tests/results'),
            'cache': {
                'enabled': os.getenv('TEST_CACHE_ENABLED', 'true').lower() == 'true',
                'ttl': int(os.getenv('TEST_CACHE_TTL', '3600'))
            }
        },
        'validation': {
            'types': os.getenv('VALIDATE_TYPES', 'true').lower() == 'true',
            'ranges': os.getenv('VALIDATE_RANGES', 'true').lower() == 'true',
            'dependencies': os.getenv('VALIDATE_DEPENDENCIES', 'true').lower() == 'true',
            'risk_limits': os.getenv('VALIDATE_RISK_LIMITS', 'true').lower() == 'true',
            'performance': os.getenv('VALIDATE_PERFORMANCE', 'true').lower() == 'true'
        },
        'docs': {
            'enabled': os.getenv('DOC_TEST_ENABLED', 'true').lower() == 'true',
            'paths': os.getenv('DOC_TEST_PATHS', 'docs,src').split(','),
            'coverage_min': int(os.getenv('DOC_COVERAGE_MIN', '90')),
            'style_check': os.getenv('DOC_STYLE_CHECK', 'true').lower() == 'true',
            'link_check': os.getenv('DOC_LINK_CHECK', 'true').lower() == 'true'
        },
        'logging': {
            'level': os.getenv('TEST_LOG_LEVEL', 'INFO'),
            'format': os.getenv('TEST_LOG_FORMAT', '%(asctime)s | %(name)s | %(levelname)s | %(message)s'),
            'path': os.getenv('TEST_LOG_PATH', 'logs/testing'),
            'rotation': int(os.getenv('TEST_LOG_ROTATION', '5')),
            'max_size': int(os.getenv('TEST_LOG_MAX_SIZE', '10'))
        }
    }
