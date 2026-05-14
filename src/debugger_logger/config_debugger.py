"""
Configuration Debugger - Institutional Grade

Provides micro-granular logging of configuration usage with full audit trail.
Designed for trading systems where real money is at risk.

Features:
- Field-level tracking of configuration values
- Source tracking (where config value came from)
- Usage validation (verify value used matches config)
- Decision logging (every if/else, every branch)
- Mismatch detection and alerting
- Full audit trail with timestamps

Author: BTC_Engine_v3
Date: 2026-01-11
"""

from enum import Enum
from typing import Any, Dict, Optional, List
from datetime import datetime
import json
from pathlib import Path
import traceback

import logging
logger = logging.getLogger(__name__)

class DebugLevel(Enum):
    """Debug logging levels"""
    CRITICAL = 1  # Only critical mismatches
    HIGH = 2      # Important decisions
    MEDIUM = 3    # All config reads
    LOW = 4       # Every field access
    TRACE = 5     # Everything including calculations


class ConfigDebugger:
    """
    Institutional-grade configuration debugger.
    
    Tracks every configuration value from source to usage,
    validates that values used match expected values,
    and logs every decision point.
    """
    
    # Class-level flags for global control (can be toggled via UI)
    # DEFAULT: Disabled - no console spam, user must enable if needed
    CONSOLE_ENABLED = False
    LOGFILE_ENABLED = False
    
    def __init__(
        self,
        name: str,
        level: DebugLevel = DebugLevel.MEDIUM,
        log_file: Optional[Path] = None,
        console_output: bool = True
    ):
        """
        Initialize the configuration debugger.
        
        Args:
            name: Name of the component being debugged (e.g., 'UniversalOptimizer')
            level: Minimum debug level to log
            log_file: Optional file to write logs to
            console_output: Whether to print to console
        """
        self.name = name
        self.level = level
        self.log_file = log_file
        self.console_output = console_output
        
        # Configuration registry - tracks all config values
        self.config_registry: Dict[str, Dict[str, Any]] = {}
        
        # Usage registry - tracks all config value usages
        self.usage_registry: List[Dict[str, Any]] = []
        
        # Mismatch registry - tracks all mismatches
        self.mismatch_registry: List[Dict[str, Any]] = []
        
        # Decision registry - tracks all decision points
        self.decision_registry: List[Dict[str, Any]] = []
        
        self._init_log_file()
        self._log_header()
    
    def _init_log_file(self):
        """Initialize log file if specified"""
        if self.log_file:
            self.log_file.parent.mkdir(parents=True, exist_ok=True)
            # Clear existing log
            with open(self.log_file, 'w') as f:
                f.write("")
    
    def _log_header(self):
        """Write log header"""
        header = f"""
╔{'═' * 78}╗
║ INSTITUTIONAL-GRADE CONFIGURATION DEBUGGER                                ║
║ Component: {self.name:<63} ║
║ Level: {self.level.name:<67} ║
║ Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S'):<65} ║
╚{'═' * 78}╝

"""
        self._write_log(header, force=True)
    
    def _write_log(self, message: str, force: bool = False):
        """Write to log file and/or console (respects global toggle flags)"""
        # Check global console flag (can be toggled via UI)
        if (self.console_output or force) and ConfigDebugger.CONSOLE_ENABLED:
            logger.info(message)
        
        # Check global logfile flag (can be toggled via UI)
        if self.log_file and ConfigDebugger.LOGFILE_ENABLED:
            with open(self.log_file, 'a') as f:
                f.write(message + '\n')
    
    def _should_log(self, level: DebugLevel) -> bool:
        """Check if message should be logged based on level"""
        return level.value <= self.level.value
    
    def register_config_source(
        self,
        config_dict: Dict[str, Any],
        source: str,
        source_type: str = "file"
    ):
        """
        Register a configuration source.
        
        Args:
            config_dict: Dictionary of configuration values
            source: Source identifier (file path, function name, etc.)
            source_type: Type of source (file, dict, object, etc.)
        """
        timestamp = datetime.now().isoformat()
        
        for key, value in config_dict.items():
            self.config_registry[key] = {
                'value': value,
                'source': source,
                'source_type': source_type,
                'registered_at': timestamp,
                'type': type(value).__name__
            }
        
        if self._should_log(DebugLevel.MEDIUM):
            msg = f"""
[CONFIG_SOURCE_REGISTERED] {timestamp}
Source: {source} ({source_type})
Fields Registered: {len(config_dict)}
Fields: {', '.join(config_dict.keys())}
"""
            self._write_log(msg)
    
    def get_config_value(
        self,
        key: str,
        default: Any = None,
        location: Optional[str] = None
    ) -> Any:
        """
        Get a configuration value with full tracking.
        
        Args:
            key: Configuration key
            default: Default value if key not found
            location: Code location requesting the value (file:line)
        
        Returns:
            Configuration value
        """
        timestamp = datetime.now().isoformat()
        
        # Get stack trace for location if not provided
        if location is None:
            stack = traceback.extract_stack()
            if len(stack) >= 2:
                caller = stack[-2]
                location = f"{caller.filename}:{caller.lineno} in {caller.name}"
        
        if key in self.config_registry:
            value = self.config_registry[key]['value']
            source = self.config_registry[key]['source']
            
            # Log the usage
            usage = {
                'timestamp': timestamp,
                'key': key,
                'value': value,
                'source': source,
                'location': location,
                'found': True
            }
            self.usage_registry.append(usage)
            
            if self._should_log(DebugLevel.LOW):
                msg = f"[CONFIG_READ] {key} = {value} (from {source}) at {location}"
                self._write_log(msg)
            
            return value
        else:
            # Key not found - use default
            usage = {
                'timestamp': timestamp,
                'key': key,
                'value': default,
                'source': 'DEFAULT',
                'location': location,
                'found': False
            }
            self.usage_registry.append(usage)
            
            if self._should_log(DebugLevel.MEDIUM):
                msg = f"[CONFIG_MISSING] {key} not found, using default: {default} at {location}"
                self._write_log(msg)
            
            return default
    
    def validate_config_usage(
        self,
        key: str,
        expected_value: Any,
        actual_value: Any,
        location: Optional[str] = None
    ) -> bool:
        """
        Validate that a config value is being used correctly.
        
        Args:
            key: Configuration key
            expected_value: Expected value from config
            actual_value: Actual value being used
            location: Code location performing validation
        
        Returns:
            True if values match, False otherwise
        """
        timestamp = datetime.now().isoformat()
        
        if location is None:
            stack = traceback.extract_stack()
            if len(stack) >= 2:
                caller = stack[-2]
                location = f"{caller.filename}:{caller.lineno}"
        
        matches = expected_value == actual_value
        
        if not matches:
            # MISMATCH DETECTED - CRITICAL
            mismatch = {
                'timestamp': timestamp,
                'key': key,
                'expected': expected_value,
                'actual': actual_value,
                'location': location,
                'severity': 'CRITICAL'
            }
            self.mismatch_registry.append(mismatch)
            
            msg = f"""
╔{'═' * 78}╗
║ ❌ CRITICAL MISMATCH DETECTED                                             ║
╚{'═' * 78}╝
Timestamp: {timestamp}
Key: {key}
Expected: {expected_value} ({type(expected_value).__name__})
Actual: {actual_value} ({type(actual_value).__name__})
Location: {location}

⚠️  CONFIG VALUE NOT BEING USED AS CONFIGURED!
⚠️  THIS COULD LEAD TO INCORRECT TRADING DECISIONS!
"""
            self._write_log(msg, force=True)
        
        else:
            if self._should_log(DebugLevel.TRACE):
                msg = f"[CONFIG_VALIDATED] {key}: {expected_value} == {actual_value} ✓ at {location}"
                self._write_log(msg)
        
        return matches
    
    def log_decision(
        self,
        decision_type: str,
        condition: str,
        result: bool,
        config_keys_used: List[str],
        location: Optional[str] = None
    ):
        """
        Log a decision point (if/else, switch, etc.).
        
        Args:
            decision_type: Type of decision (if, switch, etc.)
            condition: Condition being evaluated
            result: Result of the condition (True/False)
            config_keys_used: Config keys involved in the decision
            location: Code location of the decision
        """
        timestamp = datetime.now().isoformat()
        
        if location is None:
            stack = traceback.extract_stack()
            if len(stack) >= 2:
                caller = stack[-2]
                location = f"{caller.filename}:{caller.lineno}"
        
        decision = {
            'timestamp': timestamp,
            'type': decision_type,
            'condition': condition,
            'result': result,
            'config_keys': config_keys_used,
            'location': location
        }
        self.decision_registry.append(decision)
        
        if self._should_log(DebugLevel.HIGH):
            config_vals = {key: self.config_registry.get(key, {}).get('value', 'NOT_FOUND') 
                          for key in config_keys_used}
            msg = f"[DECISION] {decision_type}: {condition} = {result} (using {config_vals}) at {location}"
            self._write_log(msg)
    
    def log_action(
        self,
        action: str,
        config_keys_used: List[str],
        parameters: Dict[str, Any],
        location: Optional[str] = None
    ):
        """
        Log an action being taken (e.g., calculate TP, set SL).
        
        Args:
            action: Description of the action
            config_keys_used: Config keys used in the action
            parameters: Parameters passed to the action
            location: Code location of the action
        """
        timestamp = datetime.now().isoformat()
        
        if location is None:
            stack = traceback.extract_stack()
            if len(stack) >= 2:
                caller = stack[-2]
                location = f"{caller.filename}:{caller.lineno}"
        
        if self._should_log(DebugLevel.HIGH):
            config_vals = {key: self.config_registry.get(key, {}).get('value', 'NOT_FOUND') 
                          for key in config_keys_used}
            msg = f"""
[ACTION] {action}
  Config Used: {config_vals}
  Parameters: {parameters}
  Location: {location}
"""
            self._write_log(msg)
    
    def generate_report(self) -> str:
        """
        Generate a comprehensive audit report.
        
        Returns:
            Formatted audit report string
        """
        report = f"""
╔{'═' * 78}╗
║ CONFIGURATION AUDIT REPORT                                                ║
║ Component: {self.name:<63} ║
║ Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S'):<64} ║
╚{'═' * 78}╝

1. CONFIGURATION REGISTRY
{'─' * 80}
Total Fields: {len(self.config_registry)}

"""
        
        for key, info in sorted(self.config_registry.items()):
            report += f"  {key}:\n"
            report += f"    Value: {info['value']}\n"
            report += f"    Type: {info['type']}\n"
            report += f"    Source: {info['source']}\n"
            report += f"    Registered: {info['registered_at']}\n\n"
        
        report += f"""
2. USAGE SUMMARY
{'─' * 80}
Total Reads: {len(self.usage_registry)}
Found: {sum(1 for u in self.usage_registry if u['found'])}
Missing (used default): {sum(1 for u in self.usage_registry if not u['found'])}

"""
        
        # Show missing keys
        missing_keys = [u['key'] for u in self.usage_registry if not u['found']]
        if missing_keys:
            report += "Missing Keys:\n"
            for key in set(missing_keys):
                count = missing_keys.count(key)
                report += f"  - {key} (requested {count} times)\n"
            report += "\n"
        
        report += f"""
3. MISMATCH SUMMARY
{'─' * 80}
Total Mismatches: {len(self.mismatch_registry)}

"""
        
        if self.mismatch_registry:
            report += "❌ CRITICAL MISMATCHES DETECTED:\n\n"
            for mismatch in self.mismatch_registry:
                report += f"  Key: {mismatch['key']}\n"
                report += f"  Expected: {mismatch['expected']}\n"
                report += f"  Actual: {mismatch['actual']}\n"
                report += f"  Location: {mismatch['location']}\n"
                report += f"  Time: {mismatch['timestamp']}\n\n"
        else:
            report += "✓ No mismatches detected\n\n"
        
        report += f"""
4. DECISION SUMMARY
{'─' * 80}
Total Decisions: {len(self.decision_registry)}

"""
        
        if self.decision_registry:
            # Show last 10 decisions
            report += "Recent Decisions:\n"
            for decision in self.decision_registry[-10:]:
                report += f"  [{decision['type']}] {decision['condition']} = {decision['result']}\n"
                report += f"    Config: {decision['config_keys']}\n"
                report += f"    Location: {decision['location']}\n\n"
        
        report += f"\n{'═' * 80}\n"
        
        return report
    
    def save_report(self, output_file: Path):
        """Save audit report to file"""
        report = self.generate_report()
        output_file.parent.mkdir(parents=True, exist_ok=True)
        with open(output_file, 'w') as f:
            f.write(report)
    
    def export_json(self, output_file: Path):
        """Export all data as JSON for further analysis"""
        data = {
            'component': self.name,
            'level': self.level.name,
            'config_registry': self.config_registry,
            'usage_registry': self.usage_registry,
            'mismatch_registry': self.mismatch_registry,
            'decision_registry': self.decision_registry,
            'summary': {
                'total_fields': len(self.config_registry),
                'total_reads': len(self.usage_registry),
                'total_mismatches': len(self.mismatch_registry),
                'total_decisions': len(self.decision_registry)
            }
        }
        
        output_file.parent.mkdir(parents=True, exist_ok=True)
        with open(output_file, 'w') as f:
            json.dump(data, f, indent=2, default=str)
    
    # ============================================================================
    # TRADE ID TRACKING - For Multiple Simultaneous Positions
    # ============================================================================
    
    def log_trade_opened(
        self,
        trade_id: Any,
        position_details: Dict[str, Any],
        location: Optional[str] = None
    ):
        """
        Log when a trade/position is opened.
        
        Critical for tracking multiple simultaneous positions.
        
        Args:
            trade_id: Unique trade identifier (MUST be unique per position)
            position_details: All details about the position (side, size, entry, etc.)
            location: Code location where position was opened
        """
        timestamp = datetime.now().isoformat()
        
        if location is None:
            stack = traceback.extract_stack()
            if len(stack) >= 2:
                caller = stack[-2]
                location = f"{caller.filename}:{caller.lineno}"
        
        msg = f"""
╔{'═' * 78}╗
║ 🟢 TRADE OPENED                                                            ║
╚{'═' * 78}╝
Timestamp: {timestamp}
Trade ID: {trade_id} ({type(trade_id).__name__})
Side: {position_details.get('side', 'UNKNOWN')}
Size: {position_details.get('size', 'UNKNOWN')}
Entry Price: {position_details.get('entry_price', 'UNKNOWN')}
Status: {position_details.get('status', 'OPEN')}
Location: {location}

Full Details: {json.dumps(position_details, indent=2, default=str)}
"""
        self._write_log(msg, force=True)
    
    def log_trade_updated(
        self,
        trade_id: Any,
        old_data: Dict[str, Any],
        new_data: Dict[str, Any],
        location: Optional[str] = None
    ):
        """
        Log when a trade/position is updated (especially OPEN -> CLOSED).
        
        CRITICAL: This verifies the correct OPEN position is being closed.
        
        Args:
            trade_id: Trade identifier being updated
            old_data: Previous trade data
            new_data: New trade data (with updates)
            location: Code location where update occurred
        """
        timestamp = datetime.now().isoformat()
        
        if location is None:
            stack = traceback.extract_stack()
            if len(stack) >= 2:
                caller = stack[-2]
                location = f"{caller.filename}:{caller.lineno}"
        
        # Identify what changed
        changes = {}
        for key in set(list(old_data.keys()) + list(new_data.keys())):
            old_val = old_data.get(key, 'NOT_SET')
            new_val = new_data.get(key, 'NOT_SET')
            if old_val != new_val:
                changes[key] = {'from': old_val, 'to': new_val}
        
        msg = f"""
╔{'═' * 78}╗
║ 🔄 TRADE UPDATED                                                           ║
╚{'═' * 78}╝
Timestamp: {timestamp}
Trade ID: {trade_id} ({type(trade_id).__name__})
Location: {location}

Changes Detected ({len(changes)}):
{json.dumps(changes, indent=2, default=str)}

Old Status: {old_data.get('status', 'UNKNOWN')}
New Status: {new_data.get('status', 'UNKNOWN')}
"""
        
        # CRITICAL: Check if this is a close event
        if old_data.get('status') == 'OPEN' and new_data.get('status') == 'CLOSED':
            msg += f"""
⚠️  POSITION CLOSED DETECTED!
   - ID: {trade_id}
   - Entry: {old_data.get('entry_price', 'UNKNOWN')}
   - Exit: {new_data.get('exit_price', 'UNKNOWN')}
   - P&L: {new_data.get('pnl', 'UNKNOWN')}
"""
        
        self._write_log(msg, force=True)
    
    def log_trade_not_found(
        self,
        trade_id: Any,
        operation: str,
        location: Optional[str] = None
    ):
        """
        Log when a trade ID is not found (CRITICAL ERROR).
        
        This indicates attempting to update/close a position that doesn't exist.
        
        Args:
            trade_id: Trade identifier that was not found
            operation: What operation was attempted
            location: Code location where error occurred
        """
        timestamp = datetime.now().isoformat()
        
        if location is None:
            stack = traceback.extract_stack()
            if len(stack) >= 2:
                caller = stack[-2]
                location = f"{caller.filename}:{caller.lineno}"
        
        msg = f"""
╔{'═' * 78}╗
║ ❌ TRADE ID NOT FOUND - CRITICAL ERROR                                     ║
╚{'═' * 78}╝
Timestamp: {timestamp}
Trade ID: {trade_id} ({type(trade_id).__name__})
Operation: {operation}
Location: {location}

⚠️  ATTEMPTING TO {operation.upper()} POSITION THAT DOESN'T EXIST!
⚠️  THIS COULD INDICATE:
    - ID mismatch between open and close
    - Duplicate close attempts
    - Race condition in position tracking
    - ID generation collision
"""
        self._write_log(msg, force=True)
    
    def log_multiple_positions(
        self,
        open_positions: List[Dict[str, Any]],
        location: Optional[str] = None
    ):
        """
        Log state of all open positions (for debugging simultaneous positions).
        
        Args:
            open_positions: List of all currently open position data
            location: Code location where this snapshot was taken
        """
        timestamp = datetime.now().isoformat()
        
        if location is None:
            stack = traceback.extract_stack()
            if len(stack) >= 2:
                caller = stack[-2]
                location = f"{caller.filename}:{caller.lineno}"
        
        msg = f"""
╔{'═' * 78}╗
║ 📊 OPEN POSITIONS SNAPSHOT                                                 ║
╚{'═' * 78}╝
Timestamp: {timestamp}
Total Open Positions: {len(open_positions)}
Location: {location}

"""
        
        if open_positions:
            for i, pos in enumerate(open_positions, 1):
                msg += f"""
Position {i}:
  ID: {pos.get('id', 'UNKNOWN')}
  Side: {pos.get('side', 'UNKNOWN')}
  Entry: {pos.get('entry_price', 'UNKNOWN')}
  Status: {pos.get('status', 'UNKNOWN')}
  Timestamp: {pos.get('timestamp', 'UNKNOWN')}
"""
        else:
            msg += "  (No open positions)\n"
        
        self._write_log(msg)
