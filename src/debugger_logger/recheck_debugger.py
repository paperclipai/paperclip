"""
RECHECK Validation Debugger - Institutional Grade

Specialized debugger for RECHECK validation chains with full audit trail.
Handles nested RECHECK configurations and cascading validation.

Features:
- Chain-level validation tracking
- Nested RECHECK visualization
- Validation state tracking
- Performance metrics
- Full audit trail

Author: BTC_Engine_v3
Date: 2026-01-22
"""

from typing import Dict, List, Any, Optional
from datetime import datetime
from pathlib import Path
import json
from enum import Enum

import logging
logger = logging.getLogger(__name__)

class RecheckValidationState(Enum):
    """States for RECHECK validation process"""
    PENDING = "PENDING"
    VALIDATING = "VALIDATING"
    VALIDATED = "VALIDATED"
    FAILED = "FAILED"
    EXPIRED = "EXPIRED"


class RecheckDebugger:
    """
    Institutional-grade RECHECK validation debugger.
    
    Tracks nested RECHECK chains and their validation states.
    Provides detailed logging and visualization of validation process.
    """
    
    def __init__(
        self,
        log_file: Optional[Path] = None,
        console_output: bool = True
    ):
        """
        Initialize RECHECK debugger.
        
        Args:
            log_file: Optional file to write logs to
            console_output: Whether to print to console
        """
        self.log_file = log_file
        self.console_output = console_output
        
        # Validation state tracking
        self.validation_states: Dict[str, Dict[str, Any]] = {}
        
        # Performance metrics
        self.validation_times: Dict[str, List[float]] = {}
        
        self._init_log_file()
    
    def _init_log_file(self):
        """Initialize log file if specified"""
        if self.log_file:
            self.log_file.parent.mkdir(parents=True, exist_ok=True)
            with open(self.log_file, 'w') as f:
                f.write(f"RECHECK VALIDATION LOG - Started {datetime.now()}\n\n")
    
    def _write_log(self, message: str, force: bool = False):
        """Write to log file and/or console"""
        if self.console_output or force:
            logger.info(message)
        
        if self.log_file:
            with open(self.log_file, 'a') as f:
                f.write(message + '\n')
    
    def log_recheck_chain(
        self,
        block_name: str,
        signal_name: str,
        recheck_chain: List[Dict[str, Any]]
    ):
        """
        Log a complete RECHECK validation chain.
        
        Args:
            block_name: Name of the block
            signal_name: Name of the signal
            recheck_chain: List of RECHECK configurations in chain
        """
        chain_id = f"{block_name}::{signal_name}"
        timestamp = datetime.now().isoformat()
        
        # Initialize validation state
        self.validation_states[chain_id] = {
            'timestamp': timestamp,
            'block': block_name,
            'signal': signal_name,
            'chain': recheck_chain,
            'current_level': 0,
            'state': RecheckValidationState.PENDING,
            'validation_history': []
        }
        
        # Generate chain visualization
        chain_viz = self._visualize_chain(chain_id)
        
        msg = f"""
╔{'═' * 78}╗
║ 🔄 RECHECK CHAIN REGISTERED                                               ║
╚{'═' * 78}╝
Timestamp: {timestamp}
Block: {block_name}
Signal: {signal_name}
Chain Length: {len(recheck_chain)}

Chain Structure:
{chain_viz}
"""
        self._write_log(msg)
    
    def _visualize_chain(self, chain_id: str) -> str:
        """Generate ASCII visualization of RECHECK chain"""
        state = self.validation_states[chain_id]
        chain = state['chain']
        current_level = state['current_level']
        
        viz = []
        for i, recheck in enumerate(chain):
            prefix = "  " * i
            status = "🔄" if i == current_level else "⏳"
            mode = recheck.get('validation_mode', 'SIGNAL')
            delay = recheck.get('bar_delay', 0)
            
            if i == 0:
                viz.append(f"{prefix}└─ Base RECHECK ({delay} bars)")
            else:
                viz.append(f"{prefix}└─ {status} Level {i}: {mode} validation ({delay} bars)")
        
        return "\n".join(viz)
    
    def log_validation_start(
        self,
        chain_id: str,
        level: int,
        bar_index: int
    ):
        """
        Log start of validation for a RECHECK level.
        
        Args:
            chain_id: Chain identifier (block::signal)
            level: RECHECK level being validated
            bar_index: Current bar index
        """
        timestamp = datetime.now().isoformat()
        
        if chain_id not in self.validation_states:
            self._write_log(f"❌ ERROR: Chain {chain_id} not registered", force=True)
            return
        
        state = self.validation_states[chain_id]
        state['current_level'] = level
        state['state'] = RecheckValidationState.VALIDATING
        
        recheck = state['chain'][level]
        mode = recheck.get('validation_mode', 'SIGNAL')
        delay = recheck.get('bar_delay', 0)
        
        msg = f"""
[VALIDATION_START] {timestamp}
Chain: {chain_id}
Level: {level} ({mode})
Bar Index: {bar_index}
Delay Window: {delay} bars

Current Chain State:
{self._visualize_chain(chain_id)}
"""
        self._write_log(msg)
    
    def log_validation_result(
        self,
        chain_id: str,
        level: int,
        success: bool,
        bar_index: int,
        details: Optional[Dict[str, Any]] = None
    ):
        """
        Log validation result for a RECHECK level.
        
        Args:
            chain_id: Chain identifier (block::signal)
            level: RECHECK level that was validated
            success: Whether validation succeeded
            bar_index: Current bar index
            details: Optional validation details
        """
        timestamp = datetime.now().isoformat()
        
        if chain_id not in self.validation_states:
            self._write_log(f"❌ ERROR: Chain {chain_id} not registered", force=True)
            return
        
        state = self.validation_states[chain_id]
        recheck = state['chain'][level]
        mode = recheck.get('validation_mode', 'SIGNAL')
        
        # Update validation history
        state['validation_history'].append({
            'timestamp': timestamp,
            'level': level,
            'success': success,
            'bar_index': bar_index,
            'details': details
        })
        
        # Update state
        if success:
            if level == len(state['chain']) - 1:
                state['state'] = RecheckValidationState.VALIDATED
            else:
                state['current_level'] = level + 1
        else:
            state['state'] = RecheckValidationState.FAILED
        
        msg = f"""
╔{'═' * 78}╗
║ {'✅ RECHECK VALIDATED' if success else '❌ RECHECK FAILED':<76} ║
╚{'═' * 78}╝
Timestamp: {timestamp}
Chain: {chain_id}
Level: {level} ({mode})
Bar Index: {bar_index}
Result: {'SUCCESS' if success else 'FAILED'}

{json.dumps(details, indent=2) if details else 'No additional details'}

Updated Chain State:
{self._visualize_chain(chain_id)}
"""
        self._write_log(msg)
    
    def log_chain_expired(
        self,
        chain_id: str,
        bar_index: int,
        reason: str
    ):
        """
        Log when a RECHECK chain expires (validation window exceeded).
        
        Args:
            chain_id: Chain identifier (block::signal)
            bar_index: Current bar index
            reason: Reason for expiration
        """
        timestamp = datetime.now().isoformat()
        
        if chain_id not in self.validation_states:
            self._write_log(f"❌ ERROR: Chain {chain_id} not registered", force=True)
            return
        
        state = self.validation_states[chain_id]
        state['state'] = RecheckValidationState.EXPIRED
        
        msg = f"""
╔{'═' * 78}╗
║ ⌛ RECHECK CHAIN EXPIRED                                                  ║
╚{'═' * 78}╝
Timestamp: {timestamp}
Chain: {chain_id}
Bar Index: {bar_index}
Reason: {reason}

Final Chain State:
{self._visualize_chain(chain_id)}

Validation History:
{json.dumps(state['validation_history'], indent=2)}
"""
        self._write_log(msg)
    
    def generate_validation_report(self, chain_id: str) -> str:
        """
        Generate detailed validation report for a chain.
        
        Args:
            chain_id: Chain identifier to report on
            
        Returns:
            Formatted report string
        """
        if chain_id not in self.validation_states:
            return f"❌ ERROR: Chain {chain_id} not registered"
        
        state = self.validation_states[chain_id]
        
        report = f"""
╔{'═' * 78}╗
║ 📊 RECHECK VALIDATION REPORT                                              ║
╚{'═' * 78}╝
Chain: {chain_id}
Block: {state['block']}
Signal: {state['signal']}
Current State: {state['state'].value}
Chain Length: {len(state['chain'])}
Validation Progress: Level {state['current_level']} of {len(state['chain'])}

Chain Structure:
{self._visualize_chain(chain_id)}

Validation History:
"""
        
        for entry in state['validation_history']:
            report += f"""
[Level {entry['level']}] @ Bar {entry['bar_index']}
Result: {'SUCCESS' if entry['success'] else 'FAILED'}
{json.dumps(entry.get('details', {}), indent=2)}
"""
        
        return report
    
    def export_validation_data(self, output_file: Path):
        """
        Export all validation data as JSON.
        
        Args:
            output_file: Path to write JSON data
        """
        data = {
            'validation_states': {
                chain_id: {
                    **state,
                    'state': state['state'].value
                }
                for chain_id, state in self.validation_states.items()
            },
            'validation_times': self.validation_times,
            'summary': {
                'total_chains': len(self.validation_states),
                'validated': sum(1 for s in self.validation_states.values() 
                               if s['state'] == RecheckValidationState.VALIDATED),
                'failed': sum(1 for s in self.validation_states.values()
                            if s['state'] == RecheckValidationState.FAILED),
                'expired': sum(1 for s in self.validation_states.values()
                             if s['state'] == RecheckValidationState.EXPIRED)
            }
        }
        
        output_file.parent.mkdir(parents=True, exist_ok=True)
        with open(output_file, 'w') as f:
            json.dump(data, f, indent=2, default=str)
