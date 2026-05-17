"""
Configuration Validator - Simplified version

This is a simplified stub. Main functionality is in ConfigDebugger.
"""

from typing import Dict, List, Any


class ValidationReport:
    """Validation report"""
    
    def __init__(self):
        self.errors: List[str] = []
        self.warnings: List[str] = []
        self.is_valid = True
    
    def add_error(self, error: str):
        self.errors.append(error)
        self.is_valid = False
    
    def add_warning(self, warning: str):
        self.warnings.append(warning)


class ConfigValidator:
    """Simplified config validator - delegates to ConfigDebugger"""
    
    def __init__(self, name: str):
        self.name = name
    
    def validate(self, config: Dict[str, Any]) -> ValidationReport:
        """Validate configuration"""
        report = ValidationReport()
        return report
