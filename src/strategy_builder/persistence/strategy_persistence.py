"""
Strategy Persistence
Save/load strategies to/from JSON and YAML files
Maintains version compatibility and data integrity
Reference: docs/v3/UI-UX/23_STRATEGY_PERSISTENCE.md
"""

import json
import yaml
from typing import Optional, List
from pathlib import Path
from dataclasses import dataclass, field, asdict
from enum import Enum

from src.strategy_builder.core.strategy_config_engine import (
    StrategyConfig,
    BlockConfig,
    SignalConfig,
    TimingConstraint,
    RecheckConfig,
    ExitCondition
)

try:
    from src.detectors.building_blocks.registry import BlockRegistry as _BlockRegistry
    _BLOCK_REGISTRY_AVAILABLE = True
except ImportError:
    _BlockRegistry = None
    _BLOCK_REGISTRY_AVAILABLE = False


def _block_registry_lookup(block_name: str):
    """Return BlockMetadata for block_name, or None if registry unavailable."""
    if not _BLOCK_REGISTRY_AVAILABLE or _BlockRegistry is None:
        return None
    try:
        return _BlockRegistry.get_block(block_name)
    except Exception:
        return None


class PersistenceFormat(Enum):
    """File format for persistence"""
    JSON = "json"
    YAML = "yaml"


@dataclass
class PersistenceResult:
    """Result of save/load operation"""
    success: bool
    config: Optional[StrategyConfig] = None
    errors: List[str] = field(default_factory=list)


class StrategyPersistence:
    """
    Strategy persistence manager
    Handles saving and loading strategies to/from files
    """
    
    VERSION = "1.0.0"
    
    def __init__(self):
        """Initialize persistence manager"""
        pass
        
    def save(
        self,
        config: StrategyConfig,
        filepath: Path,
        format: Optional[PersistenceFormat] = None
    ) -> PersistenceResult:
        """
        Save strategy to file
        
        Args:
            config: Strategy configuration to save
            filepath: Path to save file
            format: Format to use (auto-detected if not specified)
            
        Returns:
            PersistenceResult indicating success/failure
        """
        try:
            # Auto-detect format if not specified
            if format is None:
                format = self._detect_format(filepath)
                
            # Convert config to dict
            data = self._config_to_dict(config)
            
            # Add version info
            data['version'] = self.VERSION
            
            # Save based on format
            if format == PersistenceFormat.JSON:
                with open(filepath, 'w') as f:
                    json.dump(data, f, indent=2)
            elif format == PersistenceFormat.YAML:
                with open(filepath, 'w') as f:
                    yaml.dump(data, f, default_flow_style=False)
            else:
                return PersistenceResult(
                    success=False,
                    errors=[f"Unsupported format: {format}"]
                )
                
            return PersistenceResult(success=True)
            
        except Exception as e:
            return PersistenceResult(
                success=False,
                errors=[f"Save error: {str(e)}"]
            )
            
    def load(self, filepath: Path) -> PersistenceResult:
        """
        Load strategy from file
        
        Args:
            filepath: Path to load from
            
        Returns:
            PersistenceResult with loaded config
        """
        try:
            # Check file exists
            if not filepath.exists():
                return PersistenceResult(
                    success=False,
                    errors=[f"File not found: {filepath}"]
                )
                
            # Detect format
            format = self._detect_format(filepath)
            
            # Load based on format
            if format == PersistenceFormat.JSON:
                with open(filepath, 'r') as f:
                    data = json.load(f)
            elif format == PersistenceFormat.YAML:
                with open(filepath, 'r') as f:
                    data = yaml.safe_load(f)
            else:
                return PersistenceResult(
                    success=False,
                    errors=[f"Unsupported format: {format}"]
                )
                
            # Check version compatibility (optional for backward compatibility)
            # Old files may not have version field
            if 'version' not in data:
                # Assume version 1.0.0 for backward compatibility
                data['version'] = '1.0.0'
                
            # Convert dict to config
            config = self._dict_to_config(data)
            
            return PersistenceResult(
                success=True,
                config=config
            )
            
        except json.JSONDecodeError as e:
            return PersistenceResult(
                success=False,
                errors=[f"Invalid JSON: {str(e)}"]
            )
        except yaml.YAMLError as e:
            return PersistenceResult(
                success=False,
                errors=[f"Invalid YAML: {str(e)}"]
            )
        except Exception as e:
            return PersistenceResult(
                success=False,
                errors=[f"Load error: {str(e)}"]
            )
            
    def _detect_format(self, filepath: Path) -> PersistenceFormat:
        """
        Detect format from file extension
        
        Args:
            filepath: File path
            
        Returns:
            Detected format
        """
        suffix = filepath.suffix.lower()
        
        if suffix == '.json':
            return PersistenceFormat.JSON
        elif suffix in ['.yaml', '.yml']:
            return PersistenceFormat.YAML
        else:
            # Default to JSON
            return PersistenceFormat.JSON
    
    def _exit_condition_to_dict(self, exit_condition: ExitCondition) -> dict:
        """
        Convert ExitCondition to dictionary
        
        Args:
            exit_condition: Exit condition to serialize
            
        Returns:
            Dictionary representation
        """
        data = {
            'signal_name': exit_condition.signal_name,
            'percentage': exit_condition.percentage,
            'exit_mode': exit_condition.exit_mode,
            'tp_proximity_threshold': exit_condition.tp_proximity_threshold,
            'reversal_trigger': exit_condition.reversal_trigger,
            'binding_level': exit_condition.binding_level
        }
        
        # Add recheck config if present
        if exit_condition.recheck_config:
            data['recheck_config'] = {
                'enabled': exit_condition.recheck_config.enabled,
                'bar_delay': exit_condition.recheck_config.bar_delay,
                'validation_mode': exit_condition.recheck_config.validation_mode,
                'parent_signal': exit_condition.recheck_config.parent_signal
            }
        
        # Add nested recheck chain if present
        if exit_condition.recheck_chain:
            data['recheck_chain'] = []
            for nested_recheck in exit_condition.recheck_chain:
                nested_data = {
                    'enabled': nested_recheck.enabled,
                    'bar_delay': nested_recheck.bar_delay,
                    'validation_mode': nested_recheck.validation_mode,
                    'parent_signal': nested_recheck.parent_signal
                }
                data['recheck_chain'].append(nested_data)
        
        # Add parent_signal if present
        if exit_condition.parent_signal:
            data['parent_signal'] = exit_condition.parent_signal
        
        return data
    
    def _dict_to_exit_condition(self, data: dict) -> ExitCondition:
        """
        Convert dictionary to ExitCondition
        
        Args:
            data: Dictionary data
            
        Returns:
            Exit condition
        """
        # Create recheck config if present
        recheck_config = None
        if data.get('recheck_config'):
            rc_data = data['recheck_config']
            recheck_config = RecheckConfig(
                enabled=rc_data.get('enabled', False),
                bar_delay=rc_data.get('bar_delay', 0),
                validation_mode=rc_data.get('validation_mode', 'SIGNAL'),
                parent_signal=rc_data.get('parent_signal', None)
            )
        
        # Create nested recheck chain if present
        recheck_chain = []
        if data.get('recheck_chain'):
            for nested_data in data['recheck_chain']:
                nested_recheck = RecheckConfig(
                    enabled=nested_data.get('enabled', False),
                    bar_delay=nested_data.get('bar_delay', 0),
                    validation_mode=nested_data.get('validation_mode', 'SIGNAL'),
                    parent_signal=nested_data.get('parent_signal', None)
                )
                recheck_chain.append(nested_recheck)
        
        return ExitCondition(
            signal_name=data['signal_name'],
            percentage=data.get('percentage', 0.5),
            exit_mode=data.get('exit_mode', 'ABSOLUTE'),
            tp_proximity_threshold=data.get('tp_proximity_threshold', 2.0),
            reversal_trigger=data.get('reversal_trigger', 0.5),
            recheck_config=recheck_config,
            recheck_chain=recheck_chain,
            parent_signal=data.get('parent_signal', None),
            binding_level=data.get('binding_level', 'STRATEGY')
        )
            
    def _config_to_dict(self, config: StrategyConfig) -> dict:
        """
        Convert StrategyConfig to dictionary
        
        Args:
            config: Strategy configuration
            
        Returns:
            Dictionary representation
        """
        data = {
            'name': config.name,
            'description': config.description,
            'strategy_type': config.strategy_type,  # Save strategy type
            'blocks': []
        }
        
        # Add strategy-level exit conditions
        if hasattr(config, 'exit_conditions') and config.exit_conditions:
            data['exit_conditions'] = [
                self._exit_condition_to_dict(exit_cond)
                for exit_cond in config.exit_conditions
            ]
        
        for block in config.blocks:
            block_data = {
                'name': block.name,
                'logic': block.logic,
                'signals': [],
                'metadata': block.metadata,
                'indented': block.indented,
                'parameters': block.parameters,
            }
            
            # Add block-level exit conditions
            if hasattr(block, 'exit_conditions') and block.exit_conditions:
                block_data['exit_conditions'] = [
                    self._exit_condition_to_dict(exit_cond)
                    for exit_cond in block.exit_conditions
                ]
            
            for signal in block.signals:
                signal_data = {
                    'name': signal.name,
                    'logic': signal.logic,
                    'weight': getattr(signal, 'weight', 10)  # Persist per-signal weight
                }
                
                # Add timing constraint if present
                if signal.timing_constraint:
                    signal_data['timing_constraint'] = {
                        'max_candles': signal.timing_constraint.max_candles,
                        'reference': signal.timing_constraint.reference
                    }
                
                # Add recheck config if present
                if signal.recheck_config:
                    signal_data['recheck_config'] = {
                        'enabled': signal.recheck_config.enabled,
                        'bar_delay': signal.recheck_config.bar_delay,
                        'validation_mode': signal.recheck_config.validation_mode,
                        'parent_signal': signal.recheck_config.parent_signal
                    }
                    
                # Add nested recheck chain if present
                if hasattr(signal, 'recheck_chain') and signal.recheck_chain:
                    signal_data['recheck_chain'] = []
                    for nested_recheck in signal.recheck_chain:
                        nested_data = {
                            'enabled': nested_recheck.enabled,
                            'bar_delay': nested_recheck.bar_delay,
                            'validation_mode': nested_recheck.validation_mode,
                            'parent_signal': nested_recheck.parent_signal
                        }
                        signal_data['recheck_chain'].append(nested_data)
                
                # Add signal-level exit conditions
                if hasattr(signal, 'exit_conditions') and signal.exit_conditions:
                    signal_data['exit_conditions'] = [
                        self._exit_condition_to_dict(exit_cond)
                        for exit_cond in signal.exit_conditions
                    ]
                    
                block_data['signals'].append(signal_data)
                
            data['blocks'].append(block_data)
            
        return data
        
    def _dict_to_config(self, data: dict) -> StrategyConfig:
        """
        Convert dictionary to StrategyConfig
        
        Args:
            data: Dictionary data
            
        Returns:
            Strategy configuration
        """
        config = StrategyConfig()
        config.name = data.get('name', '')
        config.description = data.get('description', '')
        config.strategy_type = data.get('strategy_type', 'Bullish')  # Load strategy type
        
        # Parse strategy-level exit conditions
        if data.get('exit_conditions'):
            config.exit_conditions = [
                self._dict_to_exit_condition(exit_data)
                for exit_data in data['exit_conditions']
            ]
        
        for block_data in data.get('blocks', []):
            block = BlockConfig(
                name=block_data['name'],
                logic=block_data['logic'],
                signals=[],
                metadata=block_data.get('metadata'),
                indented=block_data.get('indented', False),
                parameters=block_data.get('parameters', {}),
            )
            
            # Parse block-level exit conditions
            if block_data.get('exit_conditions'):
                block.exit_conditions = [
                    self._dict_to_exit_condition(exit_data)
                    for exit_data in block_data['exit_conditions']
                ]
            
            for signal_data in block_data.get('signals', []):
                # Create timing constraint if present (check for both key existence and non-None value)
                timing_constraint = None
                if signal_data.get('timing_constraint'):  # This checks both existence and non-None
                    tc_data = signal_data['timing_constraint']
                    timing_constraint = TimingConstraint(
                        max_candles=tc_data['max_candles'],
                        reference=tc_data['reference']
                    )
                
                # Create recheck config if present (check for both key existence and non-None value)
                recheck_config = None
                if signal_data.get('recheck_config'):  # This checks both existence and non-None
                    rc_data = signal_data['recheck_config']
                    recheck_config = RecheckConfig(
                        enabled=rc_data.get('enabled', False),
                        bar_delay=rc_data.get('bar_delay', 0),
                        validation_mode=rc_data.get('validation_mode', 'SIGNAL'),
                        parent_signal=rc_data.get('parent_signal', None)
                    )
                    
                # Create nested recheck chain if present
                recheck_chain = []
                if signal_data.get('recheck_chain'):
                    for nested_data in signal_data['recheck_chain']:
                        nested_recheck = RecheckConfig(
                            enabled=nested_data.get('enabled', False),
                            bar_delay=nested_data.get('bar_delay', 0),
                            validation_mode=nested_data.get('validation_mode', 'SIGNAL'),
                            parent_signal=nested_data.get('parent_signal', None)
                        )
                        recheck_chain.append(nested_recheck)
                    
                _w = signal_data.get('weight')
                if _w is None:
                    _meta = _block_registry_lookup(block_data['name'])
                    _w = (_meta.signal_tiers.get(signal_data['name'], {}).get('base_points')
                          if _meta and _meta.signal_tiers else None)
                weight = _w or 10

                signal = SignalConfig(
                    name=signal_data['name'],
                    logic=signal_data['logic'],
                    weight=weight,
                    timing_constraint=timing_constraint,
                    recheck_config=recheck_config,
                    recheck_chain=recheck_chain
                )
                
                # Parse signal-level exit conditions
                if signal_data.get('exit_conditions'):
                    signal.exit_conditions = [
                        self._dict_to_exit_condition(exit_data)
                        for exit_data in signal_data['exit_conditions']
                    ]
                
                block.signals.append(signal)
                
            config.blocks.append(block)
            
        return config
