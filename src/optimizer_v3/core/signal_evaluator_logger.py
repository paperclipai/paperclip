"""
Signal Evaluator Debug Logger - Institutional Format

Provides detailed logging for signal evaluation debugging.
Compatible with Institutional Log Viewer UI.

Author: BTC_Engine_v3
Date: 2026-02-09
"""

import os
from datetime import datetime
from typing import Any, Dict, List, Optional
from pathlib import Path


class SignalEvaluatorLogger:
    """
    Debug logger for signal evaluation
    
    Logs in institutional format compatible with Log Viewer UI.
    Creates: logs/signal_evaluator.log
    
    Format:
    [TIMESTAMP] [LEVEL] [CATEGORY] Message
    """
    
    def __init__(self, log_dir: str = "logs"):
        """Initialize logger"""
        self.log_dir = Path(log_dir)
        self.log_dir.mkdir(parents=True, exist_ok=True)
        
        self.log_file = self.log_dir / "signal_evaluator.log"
        self.enabled = True
        
        # Clear log on initialization
        self.clear_log()
    
    def clear_log(self):
        """Clear existing log file"""
        self.log_file.unlink(missing_ok=True)

        # Write header
        self._write_raw("=" * 100)
        self._write_raw(f"SIGNAL EVALUATOR DEBUG LOG - {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        self._write_raw("=" * 100)
        self._write_raw("")
    
    def _write_raw(self, message: str):
        """Write raw message to log"""
        with open(self.log_file, 'a') as f:
            f.write(f"{message}\n")
    
    def _log(self, level: str, category: str, message: str):
        """
        Write log entry in institutional format
        
        Args:
            level: INFO, DECISION, WARNING, ERROR, CRITICAL
            category: SYSTEM, SIGNAL, TRADE, RISK, RECHECK, etc.
            message: Log message
        """
        if not self.enabled:
            return
        
        timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        formatted = f"[{timestamp}] [{level}] [{category}] {message}"
        self._write_raw(formatted)
    
    def section(self, title: str):
        """Write section header"""
        self._write_raw("")
        self._write_raw("#" * 100)
        self._write_raw(f"### {title} ###")
        self._write_raw("#" * 100)
        self._write_raw("")
    
    def subsection(self, title: str):
        """Write subsection header"""
        self._write_raw("")
        self._write_raw(f"--- {title} ---")
        self._write_raw("")
    
    # Backtest Configuration Logging
    
    def log_config_comparison(self, ui_config: Dict, system_config: Dict):
        """Log backtest configuration comparison"""
        self.section("BACKTEST CONFIGURATION")
        
        self._log("INFO", "SYSTEM", "Comparing UI settings vs System values")
        self._write_raw("")
        
        # Compare each setting
        all_keys = set(list(ui_config.keys()) + list(system_config.keys()))
        
        for key in sorted(all_keys):
            ui_val = ui_config.get(key, "NOT SET")
            sys_val = system_config.get(key, "NOT SET")
            
            if ui_val == sys_val:
                self._log("INFO", "CONFIG", f"✓ {key}: {ui_val}")
            else:
                self._log("WARNING", "CONFIG", f"✗ MISMATCH {key}:")
                self._log("WARNING", "CONFIG", f"  UI:     {ui_val}")
                self._log("WARNING", "CONFIG", f"  System: {sys_val}")
        
        self._write_raw("")
    
    def log_strategy_loaded(self, strategy_name: str, blocks: List, signals: List):
        """Log loaded strategy details"""
        self.subsection("STRATEGY CONFIGURATION")
        
        self._log("INFO", "SYSTEM", f"Strategy Name: {strategy_name}")
        self._log("INFO", "SYSTEM", f"Building Blocks: {len(blocks)}")
        self._log("INFO", "SYSTEM", f"Total Signals: {len(signals)}")
        self._write_raw("")
        
        for i, block in enumerate(blocks, 1):
            block_name = block.get('name', 'Unknown')
            block_signals = block.get('signals', [])
            self._log("INFO", "SIGNAL", f"Block #{i}: {block_name}")
            
            for j, signal in enumerate(block_signals, 1):
                signal_name = signal.get('name', 'Unknown')
                logic = signal.get('logic', 'OR')
                weight = signal.get('weight', 10)
                self._log("INFO", "SIGNAL", f"  Signal {j}: {signal_name} ({logic}, {weight} pts)")
            
            self._write_raw("")
    
    # Signal Evaluation Logging
    
    def log_bar_start(self, bar_index: int, total_bars: int, bar_data: Dict):
        """Log start of bar evaluation"""
        self.section(f"BAR {bar_index}/{total_bars} EVALUATION")
        
        self._log("INFO", "SYSTEM", f"Timestamp: {bar_data.get('timestamp', 'Unknown')}")
        self._log("INFO", "SYSTEM", f"OHLC: O={bar_data.get('open')}, H={bar_data.get('high')}, "
                  f"L={bar_data.get('low')}, C={bar_data.get('close')}")
        self._write_raw("")
    
    def log_building_block_eval(self, block_name: str, result: Dict):
        """Log building block evaluation result"""
        self.subsection(f"Building Block: {block_name}")
        
        signal = result.get('signal', 'NO_SIGNAL')
        metadata = result.get('metadata', {})
        
        if signal == 'NO_SIGNAL':
            self._log("INFO", "SIGNAL", f"✗ No signal fired")
        else:
            self._log("DECISION", "SIGNAL", f"✓ SIGNAL FIRED: {signal}")
            
            # Log metadata
            for key, value in metadata.items():
                self._log("INFO", "SIGNAL", f"  {key}: {value}")
        
        self._write_raw("")
    
    def log_timing_check(self, signal_id: str, passes: bool, reason: str = ""):
        """Log timing constraint check"""
        if passes:
            self._log("INFO", "SIGNAL", f"✓ Timing OK: {signal_id}")
        else:
            self._log("WARNING", "SIGNAL", f"✗ Timing FAIL: {signal_id} - {reason}")
    
    def log_recheck_queued(self, signal_id: str, bars_delay: int):
        """Log recheck queued"""
        self._log("INFO", "RECHECK", f"📅 RECHECK Queued: {signal_id} (validate in {bars_delay} bars)")
    
    def log_recheck_validated(self, signal_id: str, result: bool):
        """Log recheck validation result"""
        if result:
            self._log("DECISION", "RECHECK", f"✓ RECHECK CONFIRMED: {signal_id}")
        else:
            self._log("WARNING", "RECHECK", f"✗ RECHECK FAILED: {signal_id}")
    
    def log_confluence_calc(self, fired_signals: List[str], breakdown: Dict[str, int], total: int, threshold: int):
        """Log confluence calculation"""
        self.subsection("CONFLUENCE CALCULATION")
        
        self._log("INFO", "SIGNAL", f"Signals Fired: {len(fired_signals)}")
        
        for signal_id in fired_signals:
            points = breakdown.get(signal_id, 0)
            self._log("INFO", "SIGNAL", f"  {signal_id}: {points} pts")
        
        self._write_raw("")
        self._log("DECISION", "SIGNAL", f"Total Confluence: {total} pts")
        self._log("INFO", "SIGNAL", f"Threshold: {threshold} pts")
        
        if total >= threshold:
            self._log("DECISION", "TRADE", f"✓ ENTRY ALLOWED ({total} >= {threshold})")
        else:
            self._log("WARNING", "TRADE", f"✗ ENTRY BLOCKED ({total} < {threshold})")
        
        self._write_raw("")
    
    def log_entry_decision(self, should_enter: bool, confluence: int, reason: str = ""):
        """Log final entry decision"""
        self.subsection("ENTRY DECISION")
        
        if should_enter:
            self._log("DECISION", "TRADE", f"🟢 ENTER TRADE (Confluence: {confluence} pts)")
            if reason:
                self._log("INFO", "TRADE", f"Reason: {reason}")
        else:
            self._log("INFO", "TRADE", f"🔴 NO ENTRY (Confluence: {confluence} pts)")
            if reason:
                self._log("INFO", "TRADE", f"Reason: {reason}")
        
        self._write_raw("")
    
    def log_exit_decision(self, should_exit: bool, signal_id: str, percentage: float):
        """Log exit decision"""
        self.subsection("EXIT DECISION")
        
        if should_exit:
            self._log("DECISION", "TRADE", f"🔴 EXIT SIGNAL: {signal_id}")
            self._log("INFO", "TRADE", f"Exit Percentage: {percentage * 100:.1f}%")
        else:
            self._log("INFO", "TRADE", "✓ No exit signal")
        
        self._write_raw("")
    
    def log_error(self, component: str, error: str):
        """Log error"""
        self._log("ERROR", "SYSTEM", f"{component}: {error}")
    
    def log_summary(self, total_bars: int, trades_opened: int, trades_closed: int):
        """Log backtest summary"""
        self.section("BACKTEST SUMMARY")
        
        self._log("INFO", "SYSTEM", f"Total Bars Processed: {total_bars}")
        self._log("INFO", "TRADE", f"Trades Opened: {trades_opened}")
        self._log("INFO", "TRADE", f"Trades Closed: {trades_closed}")
        
        self._write_raw("")
        self._write_raw("=" * 100)
        self._write_raw("END OF LOG")
        self._write_raw("=" * 100)


# Global logger instance
_logger = None

def get_logger() -> SignalEvaluatorLogger:
    """Get global logger instance"""
    global _logger
    if _logger is None:
        _logger = SignalEvaluatorLogger()
    return _logger
