"""
Strategy Configuration Engine
Core engine for managing strategy configuration and validation
Reference: docs/v3/UI-UX/03_COMPONENT_SPECS.md
"""

from typing import List, Optional, Dict, Any
from dataclasses import dataclass, field


@dataclass
class TimingConstraint:
    """Timing constraint for signal dependencies"""
    max_candles: int
    reference: str  # e.g., "Signal 1", "any previous signal"


@dataclass
class RecheckConfig:
    """Recheck validation configuration - requires signal to reoccur within bars"""
    enabled: bool = False
    bar_delay: int = 0  # Number of bars within which signal must reoccur
    parent_signal: Optional[str] = None  # Signal this recheck validates
    validation_mode: str = "SIGNAL"  # "SIGNAL" or "RECHECK"
    mode: str = "WITHIN"  # "AT" (exact bar) or "WITHIN" (within bar window)
    nested_rechecks: List[Any] = field(default_factory=list)


@dataclass
class ExitCondition:
    """Exit condition with intelligent mode support"""
    signal_name: str
    percentage: float = 0.5  # 0.0 to 1.0
    exit_mode: str = "ABSOLUTE"  # "ABSOLUTE" or "FLEXIBLE"
    tp_proximity_threshold: float = 2.0
    reversal_trigger: float = 0.5
    recheck_config: Optional[RecheckConfig] = None
    recheck_chain: List[RecheckConfig] = field(default_factory=list)
    parent_signal: Optional[str] = None
    binding_level: str = "STRATEGY"  # "STRATEGY", "BLOCK", "SIGNAL"


@dataclass
class DeferredExit:
    """Tracks deferred exit condition waiting for resolution"""
    exit_condition: ExitCondition
    position_id: str
    trigger_bar: int
    trigger_price: float
    nearest_tp: float
    nearest_tp_name: str
    peak_price_toward_tp: float


@dataclass
class SignalConfig:
    """Configuration for a single signal within a block"""
    name: str
    logic: str  # "AND" or "OR"
    weight: int = 10  # Confluence points awarded when this signal fires (default 10)
    timing_constraint: Optional[TimingConstraint] = None
    recheck_config: Optional[RecheckConfig] = None
    recheck_chain: List[RecheckConfig] = field(default_factory=list)  # For nested rechecks
    exit_conditions: List[ExitCondition] = field(default_factory=list)


@dataclass
class BlockConfig:
    """Configuration for a single building block"""
    name: str
    logic: str  # "AND" or "OR"
    signals: List[SignalConfig] = field(default_factory=list)
    metadata: Optional[Dict[str, Any]] = None
    indented: bool = False
    depends_on: Optional['BlockConfig'] = None
    exit_conditions: List[ExitCondition] = field(default_factory=list)
    parameters: dict = field(default_factory=dict)


@dataclass
class ValidationResult:
    """Result of configuration validation"""
    valid: bool
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)


@dataclass
class StrategyConfig:
    """Complete strategy configuration"""
    blocks: List[BlockConfig] = field(default_factory=list)
    required_signals: int = 0
    name: str = ""
    description: str = ""
    strategy_type: str = "Bullish"  # "Bullish" or "Bearish"
    side: str = ""  # "LONG" or "SHORT" — set by auto_fix
    exit_conditions: List[ExitCondition] = field(default_factory=list)
    
    def get_block(self, name: str) -> Optional[BlockConfig]:
        """Get block by name"""
        for block in self.blocks:
            if block.name == name:
                return block
        return None


class ConfigValidators:
    """Validation utilities for strategy configuration"""
    
    @staticmethod
    def validate_timing(signal: SignalConfig, block: BlockConfig, config: StrategyConfig) -> bool:
        """
        Validate timing constraint references exist.
        
        Args:
            signal: Signal with timing constraint
            block: Block containing the signal
            config: Full strategy configuration to check references
            
        Returns:
            True if reference is valid
        """
        if not signal.timing_constraint:
            return True
            
        reference = signal.timing_constraint.reference
        
        # Special case: "any previous signal"
        if reference == "any previous signal":
            return True
        
        # Check for cross-block reference format: "block_name::signal_name"
        if '::' in reference:
            block_name, signal_name = reference.split('::', 1)
            
            # Find referenced block
            for ref_block in config.blocks:
                if ref_block.name == block_name:
                    # Find referenced signal in that block
                    for ref_signal in ref_block.signals:
                        if ref_signal.name == signal_name:
                            return True
            
            return False
        
        # Check within same block (backward compatibility)
        for sig in block.signals:
            if sig.name in reference or reference in sig.name:
                return True
                
        return False
    
    @staticmethod
    def has_circular_dependencies(config: StrategyConfig) -> bool:
        """Check for circular dependencies in blocks"""
        # Simplified check - would need full graph analysis for production
        visited = set()
        
        for block in config.blocks:
            if block.depends_on:
                if block.depends_on.name == block.name:
                    return True
                visited.add(block.name)
                
        return False

    @staticmethod
    def validate_direction_consistency(config: StrategyConfig) -> List[str]:
        warnings = []
        strategy_type = config.strategy_type.lower()
        bullish_keywords = ["bullish", "long", "buy"]
        bearish_keywords = ["bearish", "short", "sell"]
        for block in config.blocks:
            for signal in block.signals:
                signal_lower = signal.name.lower()
                has_bullish = any(kw in signal_lower for kw in bullish_keywords)
                has_bearish = any(kw in signal_lower for kw in bearish_keywords)
                if strategy_type == "bullish" and has_bearish and not has_bullish:
                    warnings.append(
                        f"Signal '{block.name}.{signal.name}' contains bearish keywords "
                        f"but strategy_type is '{config.strategy_type}'"
                    )
                elif strategy_type == "bearish" and has_bullish and not has_bearish:
                    warnings.append(
                        f"Signal '{block.name}.{signal.name}' contains bullish keywords "
                        f"but strategy_type is '{config.strategy_type}'"
                    )
        return warnings

    @staticmethod
    def validate_recheck_config(signal: SignalConfig) -> List[str]:
        """
        Validate RECHECK configuration for a signal.
        
        Args:
            signal: Signal to validate
            
        Returns:
            List of error messages (empty if valid)
        """
        errors = []
        
        if not signal.recheck_config:
            return errors
            
        # Validate base RECHECK config
        if signal.recheck_config.enabled:
            if signal.recheck_config.bar_delay <= 0:
                errors.append(f"Invalid bar delay {signal.recheck_config.bar_delay} for {signal.name} RECHECK")
            
            if signal.recheck_config.validation_mode not in ["SIGNAL", "RECHECK"]:
                errors.append(f"Invalid validation mode {signal.recheck_config.validation_mode} for {signal.name} RECHECK")
        
        # Validate nested RECHECKs
        if signal.recheck_chain:
            for idx, nested in enumerate(signal.recheck_chain, 1):
                if not nested.enabled:
                    errors.append(f"Nested RECHECK {idx} for {signal.name} must be enabled")
                    
                if nested.bar_delay <= 0:
                    errors.append(f"Invalid bar delay {nested.bar_delay} for nested RECHECK {idx} of {signal.name}")
                    
                if nested.validation_mode not in ["SIGNAL", "RECHECK"]:
                    errors.append(f"Invalid validation mode {nested.validation_mode} for nested RECHECK {idx} of {signal.name}")
        
        return errors

    @staticmethod
    def validate_exit_conditions(config: StrategyConfig) -> List[str]:
        """
        Validate all exit conditions across strategy.
        
        Args:
            config: Strategy configuration to validate
            
        Returns:
            List of error messages (empty if valid)
        """
        errors = []
        
        # Validate strategy-level exits total <= 100%
        strategy_total = sum(exit_cond.percentage for exit_cond in config.exit_conditions)
        if strategy_total > 1.0:
            errors.append(f"Strategy-level exit conditions total {strategy_total*100:.1f}% exceeds 100%")
        
        # Validate block-level exits total <= 100%
        for block in config.blocks:
            block_total = sum(exit_cond.percentage for exit_cond in block.exit_conditions)
            if block_total > 1.0:
                errors.append(f"Block '{block.name}' exit conditions total {block_total*100:.1f}% exceeds 100%")
            
            # Validate signal-level exits total <= 100%
            for signal in block.signals:
                signal_total = sum(exit_cond.percentage for exit_cond in signal.exit_conditions)
                if signal_total > 1.0:
                    errors.append(f"Signal '{block.name}.{signal.name}' exit conditions total {signal_total*100:.1f}% exceeds 100%")
                
                # Validate each percentage in range (0, 1.0]
                for exit_cond in signal.exit_conditions:
                    if exit_cond.percentage <= 0 or exit_cond.percentage > 1.0:
                        errors.append(f"Exit condition '{exit_cond.signal_name}' has invalid percentage {exit_cond.percentage*100:.1f}% (must be 0-100%)")
                    
                    # Validate exit mode
                    if exit_cond.exit_mode not in ["ABSOLUTE", "FLEXIBLE"]:
                        errors.append(f"Exit condition '{exit_cond.signal_name}' has invalid exit_mode '{exit_cond.exit_mode}' (must be ABSOLUTE or FLEXIBLE)")
                    
                    # Validate binding level
                    if exit_cond.binding_level not in ["STRATEGY", "BLOCK", "SIGNAL"]:
                        errors.append(f"Exit condition '{exit_cond.signal_name}' has invalid binding_level '{exit_cond.binding_level}'")
        
        # Validate each exit condition percentage in strategy-level and block-level
        for exit_cond in config.exit_conditions:
            if exit_cond.percentage <= 0 or exit_cond.percentage > 1.0:
                errors.append(f"Strategy exit condition '{exit_cond.signal_name}' has invalid percentage {exit_cond.percentage*100:.1f}%")
            
            if exit_cond.exit_mode not in ["ABSOLUTE", "FLEXIBLE"]:
                errors.append(f"Strategy exit condition '{exit_cond.signal_name}' has invalid exit_mode '{exit_cond.exit_mode}'")
            
            if exit_cond.binding_level not in ["STRATEGY", "BLOCK", "SIGNAL"]:
                errors.append(f"Strategy exit condition '{exit_cond.signal_name}' has invalid binding_level '{exit_cond.binding_level}'")
        
        for block in config.blocks:
            for exit_cond in block.exit_conditions:
                if exit_cond.percentage <= 0 or exit_cond.percentage > 1.0:
                    errors.append(f"Block '{block.name}' exit condition '{exit_cond.signal_name}' has invalid percentage {exit_cond.percentage*100:.1f}%")
                
                if exit_cond.exit_mode not in ["ABSOLUTE", "FLEXIBLE"]:
                    errors.append(f"Block '{block.name}' exit condition '{exit_cond.signal_name}' has invalid exit_mode '{exit_cond.exit_mode}'")
                
                if exit_cond.binding_level not in ["STRATEGY", "BLOCK", "SIGNAL"]:
                    errors.append(f"Block '{block.name}' exit condition '{exit_cond.signal_name}' has invalid binding_level '{exit_cond.binding_level}'")
        
        return errors


class StrategyConfigEngine:
    """
    Core configuration management system for Strategy Builder
    Manages block addition, signal configuration, and validation
    """
    
    def __init__(self, registry):
        """
        Initialize configuration engine
        
        Args:
            registry: BlockRegistry instance for validation
        """
        self.registry = registry
        self.config = StrategyConfig()
        self.validators = ConfigValidators()
        
    def add_block(self, block_name: str, logic: str = 'AND') -> bool:
        """
        Add building block with AND/OR logic
        
        Args:
            block_name: Name of block from registry
            logic: "AND" (mandatory) or "OR" (optional)
            
        Returns:
            True if added successfully
            
        Raises:
            ValueError: If block already exists
        """
        # Check if block already added
        if self.config.get_block(block_name):
            raise ValueError(f"Block {block_name} already added")
        
        # Get metadata from registry (if available)
        metadata = None
        if self.registry:
            try:
                metadata = self.registry.get_block(block_name)
            except:
                pass
        
        # Create block configuration
        block_config = BlockConfig(
            name=block_name,
            logic=logic,
            signals=[],
            metadata=metadata
        )
        
        self.config.blocks.append(block_config)
        self.recalculate_requirements()
        return True
        
    def remove_block(self, block_name: str) -> bool:
        """
        Remove block from strategy
        
        Args:
            block_name: Name of block to remove
            
        Returns:
            True if removed successfully
        """
        block = self.config.get_block(block_name)
        if not block:
            return False
            
        self.config.blocks.remove(block)
        self.recalculate_requirements()
        return True
        
    def reorder_block(self, from_index: int, to_index: int) -> bool:
        """
        Move block to new position
        
        Args:
            from_index: Current index
            to_index: Target index
            
        Returns:
            True if reordered successfully
        """
        if from_index < 0 or from_index >= len(self.config.blocks):
            return False
        if to_index < 0 or to_index >= len(self.config.blocks):
            return False
            
        block = self.config.blocks.pop(from_index)
        self.config.blocks.insert(to_index, block)
        return True
        
    def indent_block(self, block_name: str) -> bool:
        """
        Indent block to create dependency on previous block
        
        Args:
            block_name: Name of block to indent
            
        Returns:
            True if indented successfully
        """
        block = self.config.get_block(block_name)
        if not block:
            return False
            
        # Find block index
        idx = self.config.blocks.index(block)
        if idx == 0:
            raise ValueError("Cannot indent first block")
            
        # Set dependency on previous block
        block.indented = True
        block.depends_on = self.config.blocks[idx - 1]
        return True
        
    def add_signal(self, block_name: str, signal_name: str,
                   logic: str = 'AND',
                   constraint: Optional[TimingConstraint] = None) -> bool:
        """
        Add signal to block with configuration
        
        Args:
            block_name: Name of block
            signal_name: Name of signal
            logic: "AND" (required) or "OR" (optional)
            constraint: Optional timing constraint
            
        Returns:
            True if added successfully
            
        Raises:
            ValueError: If block not found or signal invalid
        """
        block = self.config.get_block(block_name)
        if not block:
            raise ValueError(f"Block {block_name} not in strategy")
        
        # Validate signal exists in registry (if registry available)
        if self.registry:
            try:
                # Would validate with registry here
                pass
            except:
                pass
        
        # Create signal configuration
        signal_config = SignalConfig(
            name=signal_name,
            logic=logic,
            timing_constraint=constraint
        )
        
        block.signals.append(signal_config)
        self.recalculate_requirements()
        return True
        
    def recalculate_requirements(self):
        """
        Calculate total required signals (AND blocks only)
        OR blocks are optional and don't count toward requirements
        """
        total = 0
        for block in self.config.blocks:
            if block.logic == 'AND':
                # Count AND signals in this block
                and_signals = [s for s in block.signals if s.logic == 'AND']
                # Each AND block requires at least 1 signal
                total += max(len(and_signals), 1)
        
        self.config.required_signals = total
        
    def generate_description(self) -> str:
        """
        Auto-generate strategy description from blocks and signals
        
        Returns:
            Human-readable description string
        """
        if not self.config.blocks:
            return "Empty strategy"
            
        parts = []
        
        for block in self.config.blocks:
            logic_str = "REQUIRED" if block.logic == 'AND' else "OPTIONAL"
            
            # Get first 2 signal names
            signal_names = [s.name for s in block.signals[:2]]
            if not signal_names:
                signal_names = ["<no signals>"]
                
            block_desc = f"{block.name} ({logic_str}): {', '.join(signal_names)}"
            if len(block.signals) > 2:
                block_desc += f" + {len(block.signals) - 2} more"
                
            parts.append(block_desc)
        
        return " + ".join(parts)
        
    def validate(self) -> ValidationResult:
        """
        Comprehensive validation of strategy configuration
        
        Returns:
            ValidationResult with valid flag and error/warning lists
        """
        errors = []
        warnings = []
        
        # Must have at least one block
        if len(self.config.blocks) == 0:
            errors.append("Strategy must have at least one building block")
            return ValidationResult(valid=False, errors=errors, warnings=warnings)
        
        # Each block must have at least one signal
        for block in self.config.blocks:
            if len(block.signals) == 0:
                errors.append(f"Block {block.name} must have at least one signal")
        
        # Check timing constraints and RECHECK configs
        for block in self.config.blocks:
            for signal in block.signals:
                # Validate timing constraints
                if signal.timing_constraint:
                    if not self.validators.validate_timing(signal, block, self.config):
                        errors.append(
                            f"Invalid timing constraint on {block.name}.{signal.name}: "
                            f"reference '{signal.timing_constraint.reference}' not found"
                        )
                
                # Validate RECHECK configurations
                recheck_errors = self.validators.validate_recheck_config(signal)
                if recheck_errors:
                    errors.extend([f"{block.name}.{error}" for error in recheck_errors])
        
        # Check circular dependencies
        if self.validators.has_circular_dependencies(self.config):
            errors.append("Circular dependencies detected in block structure")
        
        # Direction consistency errors (reject mismatches)
        direction_errors = self.validators.validate_direction_consistency(self.config)
        errors.extend(direction_errors)

        # Warnings for best practices
        if self.config.required_signals == 0:
            warnings.append("Strategy has no required (AND) signals")
        
        return ValidationResult(
            valid=len(errors) == 0,
            errors=errors,
            warnings=warnings
        )
