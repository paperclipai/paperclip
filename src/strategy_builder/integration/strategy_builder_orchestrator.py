"""
Strategy Builder Orchestrator
Integration layer connecting all 5 core components
Provides high-level workflow orchestration
Reference: docs/v3/UI-UX/20_INTEGRATION_LAYER.md
"""

from enum import Enum
from typing import List, Optional, Any, Dict
from dataclasses import dataclass, field

from src.strategy_builder.core.registry_interface import RegistryInterface
from src.strategy_builder.core.strategy_config_engine import (
    StrategyConfigEngine,
    StrategyConfig,
    TimingConstraint
)
from src.strategy_builder.core.signal_dependency_resolver import SignalDependencyResolver
from src.strategy_builder.testing.walkforward_test_engine import (
    WalkforwardTestEngine,
    WalkforwardConfig,
    WalkforwardMode,
    WalkforwardResult
)
from src.strategy_builder.persistence.strategy_persistence import StrategyPersistence

import logging
logger = logging.getLogger(__name__)

class MockRegistry:
    """
    Mock registry for testing/standalone operation
    Provides basic registry interface without actual block data
    """
    
    def get_all_blocks(self) -> List[Dict[str, Any]]:
        """Return mock blocks"""
        return [
            {
                'name': 'Double_Top',
                'category': 'PATTERN',
                'type': 'SIGNAL',
                'weight': 10,
                'description': 'Double top pattern detector',
                'signals': [
                    {
                        'name': 'BEARISH_BREAKDOWN',
                        'count': 100,
                        'percentage': 50.0,
                        'description': 'Bearish breakdown signal'
                    }
                ]
            },
            {
                'name': 'RSI',
                'category': 'INDICATOR',
                'type': 'SIGNAL',
                'weight': 5,
                'description': 'RSI indicator',
                'signals': [
                    {
                        'name': 'OVERBOUGHT',
                        'count': 50,
                        'percentage': 25.0,
                        'description': 'Overbought condition'
                    }
                ]
            }
        ]
        
    def get_block(self, name: str) -> Optional[Dict[str, Any]]:
        """Get specific block"""
        blocks = self.get_all_blocks()
        for block in blocks:
            if block['name'] == name:
                return block
        return None


class WorkflowStep(Enum):
    """Workflow step enumeration"""
    CREATE_STRATEGY = "create_strategy"
    ADD_BLOCK = "add_block"
    ADD_SIGNAL = "add_signal"
    VALIDATE = "validate"
    VALIDATE_DEPENDENCIES = "validate_dependencies"
    GENERATE_CODE = "generate_code"
    RUN_BACKTEST = "run_backtest"
    SEARCH_BLOCKS = "search_blocks"
    GET_SIGNALS = "get_signals"


@dataclass
class WorkflowResult:
    """Result from a workflow operation"""
    success: bool
    step: WorkflowStep
    message: str = ""
    errors: List[str] = field(default_factory=list)
    validation_errors: List[str] = field(default_factory=list)
    strategy_config: Optional[StrategyConfig] = None
    test_result: Optional[WalkforwardResult] = None
    data: Optional[Any] = None


class StrategyBuilderOrchestrator:
    """
    High-level orchestrator connecting all strategy builder components
    Provides simplified workflow API for strategy creation and testing
    """
    
    def __init__(self, registry=None):
        """
        Initialize orchestrator with all components
        
        Args:
            registry: Optional BlockRegistry instance (uses mock if not provided)
        """
        # Initialize all 5 core components
        # Use mock registry if none provided
        if registry is None:
            registry = MockRegistry()
        
        # Share registry across components that need it
        self.registry = registry
        self.registry_interface = RegistryInterface(registry)
        self.config_engine = StrategyConfigEngine(registry)
        self.dependency_resolver = SignalDependencyResolver()
        self.test_engine = WalkforwardTestEngine()
        self.persistence = StrategyPersistence()
        
        # Track loaded strategy file path for version control
        self.loaded_strategy_path: Optional[str] = None
        
        # Track loaded strategy version from database (Sprint 2.0.2)
        # Set by main window when loading strategy from browser
        self.current_version_id: Optional[str] = None

        # Track loaded strategy ID from database (BTCAAAAA-33 fix)
        # Set by main window when loading strategy from browser
        self.current_strategy_id: Optional[str] = None
        
    def create_strategy(
        self,
        name: str,
        description: str = ""
    ) -> WorkflowResult:
        """
        Create a new strategy
        
        Args:
            name: Strategy name
            description: Strategy description
            
        Returns:
            WorkflowResult with strategy config
        """
        try:
            # Create new config through engine
            self.config_engine = StrategyConfigEngine(self.registry)
            self.config_engine.config.name = name
            self.config_engine.config.description = description or f"Strategy: {name}"
            
            return WorkflowResult(
                success=True,
                step=WorkflowStep.CREATE_STRATEGY,
                message=f"Strategy '{name}' created successfully",
                strategy_config=self.config_engine.config
            )
        except Exception as e:
            return WorkflowResult(
                success=False,
                step=WorkflowStep.CREATE_STRATEGY,
                message="Failed to create strategy",
                errors=[str(e)]
            )
            
    def add_block(
        self,
        block_name: str,
        logic: str = "AND"
    ) -> WorkflowResult:
        """
        Add a building block to the strategy
        
        Args:
            block_name: Name of the building block
            logic: Block logic ("AND" or "OR")
            
        Returns:
            WorkflowResult
        """
        try:
            # Check if strategy exists
            if not self.config_engine.config.name:
                return WorkflowResult(
                    success=False,
                    step=WorkflowStep.ADD_BLOCK,
                    message="No strategy created. Create a strategy first.",
                    errors=["Strategy not initialized"]
                )
                
            # Add block through engine
            self.config_engine.add_block(block_name, logic)
            
            return WorkflowResult(
                success=True,
                step=WorkflowStep.ADD_BLOCK,
                message=f"Block '{block_name}' added with logic '{logic}'",
                strategy_config=self.config_engine.config
            )
        except Exception as e:
            return WorkflowResult(
                success=False,
                step=WorkflowStep.ADD_BLOCK,
                message=f"Failed to add block '{block_name}'",
                errors=[str(e)]
            )
            
    def add_signal(
        self,
        block_name: str,
        signal_name: str,
        logic: str = "AND",
        within_candles: Optional[int] = None,
        reference_signal: Optional[str] = None
    ) -> WorkflowResult:
        """
        Add a signal to a block
        
        Args:
            block_name: Name of the block
            signal_name: Name of the signal
            logic: Signal logic ("AND" or "OR")
            within_candles: Optional timing constraint (candles)
            reference_signal: Optional reference signal for timing
            
        Returns:
            WorkflowResult
        """
        try:
            # Check if strategy exists
            if not self.config_engine.config.name:
                return WorkflowResult(
                    success=False,
                    step=WorkflowStep.ADD_SIGNAL,
                    message="No strategy created",
                    errors=["Strategy not initialized"]
                )
                
            # Create timing constraint if specified
            timing_constraint = None
            if within_candles and reference_signal:
                timing_constraint = TimingConstraint(
                    max_candles=within_candles,
                    reference=reference_signal
                )
                
            # Add signal through engine
            self.config_engine.add_signal(
                block_name=block_name,
                signal_name=signal_name,
                logic=logic,
                constraint=timing_constraint
            )
            
            return WorkflowResult(
                success=True,
                step=WorkflowStep.ADD_SIGNAL,
                message=f"Signal '{signal_name}' added to block '{block_name}'",
                strategy_config=self.config_engine.config
            )
        except Exception as e:
            return WorkflowResult(
                success=False,
                step=WorkflowStep.ADD_SIGNAL,
                message=f"Failed to add signal '{signal_name}'",
                errors=[str(e)]
            )
    
    def add_block_with_signals(
        self,
        block_name: str,
        signal_names: List[str],
        block_logic: str = "AND",
        signal_logic: str = "AND"
    ) -> WorkflowResult:
        """
        NEW: Add block with signals - handles both new blocks and adding signals to existing blocks
        
        This is the institutional-grade method that intelligently:
        1. Creates block if it doesn't exist
        2. Adds all specified signals to the block
        3. Handles both initial addition and subsequent signal additions
        
        Args:
            block_name: Name of the building block
            signal_names: List of signal names to add
            block_logic: Logic for the block itself ("AND" or "OR")
            signal_logic: Logic for the signals ("AND" or "OR")
            
        Returns:
            WorkflowResult
        """
        try:
            # Check if strategy exists
            if not self.config_engine.config.name:
                return WorkflowResult(
                    success=False,
                    step=WorkflowStep.ADD_BLOCK,
                    message="No strategy created. Create a strategy first.",
                    errors=["Strategy not initialized"]
                )
            
            # Check if block already exists in config
            block_exists = any(
                block.name == block_name 
                for block in self.config_engine.config.blocks
            )
            
            # If block doesn't exist, add it first
            if not block_exists:
                add_block_result = self.add_block(block_name, block_logic)
                if not add_block_result.success:
                    return add_block_result
            
            # Add all signals to the block
            signals_added = []
            errors = []
            
            for signal_name in signal_names:
                result = self.add_signal(
                    block_name=block_name,
                    signal_name=signal_name,
                    logic=signal_logic
                )
                
                if result.success:
                    signals_added.append(signal_name)
                else:
                    errors.extend(result.errors)
            
            # Determine overall success
            success = len(signals_added) > 0
            
            if success:
                message = f"Added {len(signals_added)} signal(s) to block '{block_name}'"
                if errors:
                    message += f" (with {len(errors)} error(s))"
            else:
                message = f"Failed to add signals to block '{block_name}'"
            
            return WorkflowResult(
                success=success,
                step=WorkflowStep.ADD_SIGNAL,
                message=message,
                errors=errors,
                strategy_config=self.config_engine.config,
                data={
                    'block_name': block_name,
                    'signals_added': signals_added,
                    'block_existed': block_exists
                }
            )
            
        except Exception as e:
            return WorkflowResult(
                success=False,
                step=WorkflowStep.ADD_BLOCK,
                message=f"Failed to add block with signals '{block_name}'",
                errors=[str(e)]
            )
            
    def validate_strategy(self) -> WorkflowResult:
        """
        Validate the current strategy configuration
        
        Returns:
            WorkflowResult with validation errors
        """
        try:
            # Validate through engine
            validation_result = self.config_engine.validate()
            
            return WorkflowResult(
                success=validation_result.valid,
                step=WorkflowStep.VALIDATE,
                message="Strategy validated" if validation_result.valid else "Validation failed",
                validation_errors=validation_result.errors,
                strategy_config=self.config_engine.config
            )
        except Exception as e:
            return WorkflowResult(
                success=False,
                step=WorkflowStep.VALIDATE,
                message="Validation error",
                errors=[str(e)]
            )
            
    def validate_dependencies(self) -> WorkflowResult:
        """
        Validate signal dependencies
        
        Returns:
            WorkflowResult with dependency validation
        """
        try:
            # Build dependency graph
            graph = self.dependency_resolver.build_graph(self.config_engine.config)
            
            # Check for circular dependencies
            has_circular = graph.has_circular_dependency()
            
            if has_circular:
                return WorkflowResult(
                    success=False,
                    step=WorkflowStep.VALIDATE_DEPENDENCIES,
                    message="Circular dependencies detected",
                    validation_errors=["Circular dependency in signal constraints"]
                )
                
            return WorkflowResult(
                success=True,
                step=WorkflowStep.VALIDATE_DEPENDENCIES,
                message="Dependencies validated successfully"
            )
        except Exception as e:
            return WorkflowResult(
                success=False,
                step=WorkflowStep.VALIDATE_DEPENDENCIES,
                message="Dependency validation error",
                errors=[str(e)]
            )
            
    def run_backtest(
        self,
        lookback_days: int = 180,
        training_window_days: int = 0,
        mode: WalkforwardMode = WalkforwardMode.MODE_1
    ) -> WorkflowResult:
        """
        Run walkforward backtest on the strategy
        
        Args:
            lookback_days: Days to look back for testing
            training_window_days: Optional training window
            mode: Test mode (MODE_1 or MODE_2)
            
        Returns:
            WorkflowResult with test results
        """
        try:
            # Validate first
            validation = self.validate_strategy()
            if not validation.success:
                return WorkflowResult(
                    success=False,
                    step=WorkflowStep.RUN_BACKTEST,
                    message="Cannot run backtest - validation failed",
                    validation_errors=validation.validation_errors
                )
                
            # Configure test engine
            test_config = WalkforwardConfig(
                mode=mode,
                lookback_days=lookback_days,
                training_window_days=training_window_days
            )
            self.test_engine = WalkforwardTestEngine(test_config)
            
            # Run backtest
            test_result = self.test_engine.run(self.config_engine.config)
            
            return WorkflowResult(
                success=True,
                step=WorkflowStep.RUN_BACKTEST,
                message="Backtest completed successfully",
                test_result=test_result
            )
        except Exception as e:
            return WorkflowResult(
                success=False,
                step=WorkflowStep.RUN_BACKTEST,
                message="Backtest error",
                errors=[str(e)]
            )
            
    def search_blocks(self, query: str = "", **filters) -> List[Any]:
        """
        Search for building blocks
        
        Args:
            query: Search query
            **filters: Additional filters
            
        Returns:
            List of search results
        """
        try:
            results = self.registry_interface.search_blocks(query, **filters)
            return results
        except Exception:
            return []
            
    def get_block_signals(self, block_name: str) -> List[Any]:
        """
        Get signals for a specific block
        
        Args:
            block_name: Block name
            
        Returns:
            List of signals
        """
        try:
            block_info = self.registry_interface.get_block(block_name)
            if block_info:
                return block_info.signals
            return []
        except Exception:
            return []
            
    def set_signal_timing_constraint(
        self,
        block_name: str,
        signal_name: str,
        constraint: Dict[str, Any]
    ) -> WorkflowResult:
        """
        Set timing constraint for a signal
        
        Args:
            block_name: Block name
            signal_name: Signal name
            constraint: Constraint dict with 'candles', 'reference', 'reference_name'
            
        Returns:
            WorkflowResult
        """
        try:
            # Find block and signal
            block_found = False
            signal_found = False
            
            for block in self.config_engine.config.blocks:
                if block.name == block_name:
                    block_found = True
                    for signal in block.signals:
                        if signal.name == signal_name:
                            signal_found = True
                            # Create timing constraint
                            signal.timing_constraint = TimingConstraint(
                                max_candles=constraint['candles'],
                                reference=constraint['reference']
                            )
                            break
                    break
            
            if not block_found:
                return WorkflowResult(
                    success=False,
                    step=WorkflowStep.ADD_SIGNAL,
                    message=f"Block '{block_name}' not found",
                    errors=[f"Block '{block_name}' does not exist"]
                )
            
            if not signal_found:
                return WorkflowResult(
                    success=False,
                    step=WorkflowStep.ADD_SIGNAL,
                    message=f"Signal '{signal_name}' not found in block '{block_name}'",
                    errors=[f"Signal '{signal_name}' does not exist in block '{block_name}'"]
                )
            
            return WorkflowResult(
                success=True,
                step=WorkflowStep.ADD_SIGNAL,
                message=f"Timing constraint set for {block_name}::{signal_name}",
                strategy_config=self.config_engine.config
            )
            
        except Exception as e:
            return WorkflowResult(
                success=False,
                step=WorkflowStep.ADD_SIGNAL,
                message="Failed to set timing constraint",
                errors=[str(e)]
            )
    
    def remove_signal_timing_constraint(
        self,
        block_name: str,
        signal_name: str
    ) -> WorkflowResult:
        """
        Remove timing constraint from a signal
        
        Args:
            block_name: Block name
            signal_name: Signal name
            
        Returns:
            WorkflowResult
        """
        try:
            # Find block and signal
            block_found = False
            signal_found = False
            
            for block in self.config_engine.config.blocks:
                if block.name == block_name:
                    block_found = True
                    for signal in block.signals:
                        if signal.name == signal_name:
                            signal_found = True
                            # Remove timing constraint
                            signal.timing_constraint = None
                            break
                    break
            
            if not block_found:
                return WorkflowResult(
                    success=False,
                    step=WorkflowStep.ADD_SIGNAL,
                    message=f"Block '{block_name}' not found",
                    errors=[f"Block '{block_name}' does not exist"]
                )
            
            if not signal_found:
                return WorkflowResult(
                    success=False,
                    step=WorkflowStep.ADD_SIGNAL,
                    message=f"Signal '{signal_name}' not found in block '{block_name}'",
                    errors=[f"Signal '{signal_name}' does not exist in block '{block_name}'"]
                )
            
            return WorkflowResult(
                success=True,
                step=WorkflowStep.ADD_SIGNAL,
                message=f"Timing constraint removed from {block_name}::{signal_name}",
                strategy_config=self.config_engine.config
            )
            
        except Exception as e:
            return WorkflowResult(
                success=False,
                step=WorkflowStep.ADD_SIGNAL,
                message="Failed to remove timing constraint",
                errors=[str(e)]
            )
    
    def reorder_block(
        self,
        block_name: str,
        direction: str
    ) -> WorkflowResult:
        """
        Reorder a block in the strategy
        
        Args:
            block_name: Block name
            direction: 'up' or 'down'
            
        Returns:
            WorkflowResult
        """
        try:
            blocks = self.config_engine.config.blocks
            
            # Find block index
            block_idx = None
            for idx, block in enumerate(blocks):
                if block.name == block_name:
                    block_idx = idx
                    break
            
            if block_idx is None:
                return WorkflowResult(
                    success=False,
                    step=WorkflowStep.ADD_BLOCK,
                    message=f"Block '{block_name}' not found",
                    errors=[f"Block '{block_name}' does not exist"]
                )
            
            # Move block
            if direction == "up":
                if block_idx == 0:
                    return WorkflowResult(
                        success=False,
                        step=WorkflowStep.ADD_BLOCK,
                        message="Block is already first",
                        errors=["Cannot move first block up"]
                    )
                # Swap with previous
                blocks[block_idx], blocks[block_idx - 1] = blocks[block_idx - 1], blocks[block_idx]
            elif direction == "down":
                if block_idx == len(blocks) - 1:
                    return WorkflowResult(
                        success=False,
                        step=WorkflowStep.ADD_BLOCK,
                        message="Block is already last",
                        errors=["Cannot move last block down"]
                    )
                # Swap with next
                blocks[block_idx], blocks[block_idx + 1] = blocks[block_idx + 1], blocks[block_idx]
            else:
                return WorkflowResult(
                    success=False,
                    step=WorkflowStep.ADD_BLOCK,
                    message=f"Invalid direction: {direction}",
                    errors=[f"Direction must be 'up' or 'down', got '{direction}'"]
                )
            
            return WorkflowResult(
                success=True,
                step=WorkflowStep.ADD_BLOCK,
                message=f"Block '{block_name}' moved {direction}",
                strategy_config=self.config_engine.config
            )
            
        except Exception as e:
            return WorkflowResult(
                success=False,
                step=WorkflowStep.ADD_BLOCK,
                message="Failed to reorder block",
                errors=[str(e)]
            )
    
    def remove_block(
        self,
        block_name: str
    ) -> WorkflowResult:
        """
        Remove a block from the strategy
        
        Args:
            block_name: Block name
            
        Returns:
            WorkflowResult
        """
        try:
            blocks = self.config_engine.config.blocks
            
            # Find and remove block
            initial_count = len(blocks)
            self.config_engine.config.blocks = [
                block for block in blocks if block.name != block_name
            ]
            
            if len(self.config_engine.config.blocks) == initial_count:
                return WorkflowResult(
                    success=False,
                    step=WorkflowStep.ADD_BLOCK,
                    message=f"Block '{block_name}' not found",
                    errors=[f"Block '{block_name}' does not exist"]
                )
            
            return WorkflowResult(
                success=True,
                step=WorkflowStep.ADD_BLOCK,
                message=f"Block '{block_name}' removed",
                strategy_config=self.config_engine.config
            )
            
        except Exception as e:
            return WorkflowResult(
                success=False,
                step=WorkflowStep.ADD_BLOCK,
                message="Failed to remove block",
                errors=[str(e)]
            )
    
    def save_strategy(
        self,
        filepath: str
    ) -> WorkflowResult:
        """
        Save strategy to file using centralized StrategyPersistence
        
        Args:
            filepath: Path to save file
            
        Returns:
            WorkflowResult
        """
        try:
            from pathlib import Path
            import json
            
            # Use centralized persistence layer for core save
            result = self.persistence.save(
                config=self.config_engine.config,
                filepath=Path(filepath)
            )
            
            if not result.success:
                return WorkflowResult(
                    success=False,
                    step=WorkflowStep.CREATE_STRATEGY,
                    message="Failed to save strategy",
                    errors=result.errors
                )
            
            # Add orchestrator-level workflow metadata (strategy_type, validation_status, etc.)
            # This is a thin layer on top of the core persistence
            filepath_obj = Path(filepath)
            with open(filepath_obj, 'r') as f:
                config_dict = json.load(f)
            
            # Add workflow metadata
            config_dict['strategy_type'] = getattr(self.config_engine.config, 'strategy_type', 'Bullish')
            config_dict['validation_status'] = getattr(self.config_engine.config, 'validation_status', None)
            config_dict['generation_status'] = getattr(self.config_engine.config, 'generation_status', None)
            
            # Write back with metadata
            with open(filepath_obj, 'w') as f:
                json.dump(config_dict, f, indent=2)
            
            return WorkflowResult(
                success=True,
                step=WorkflowStep.CREATE_STRATEGY,
                message=f"Strategy saved to {filepath}",
                data={'file_path': filepath}
            )
            
        except Exception as e:
            return WorkflowResult(
                success=False,
                step=WorkflowStep.CREATE_STRATEGY,
                message="Failed to save strategy",
                errors=[str(e)]
            )
    
    def load_strategy(
        self,
        filepath: str
    ) -> WorkflowResult:
        """
        Load strategy from file using centralized StrategyPersistence
        
        Args:
            filepath: Path to load file
            
        Returns:
            WorkflowResult
        """
        try:
            from pathlib import Path
            import json
            
            # Use centralized persistence layer for core load
            result = self.persistence.load(Path(filepath))
            
            if not result.success:
                return WorkflowResult(
                    success=False,
                    step=WorkflowStep.CREATE_STRATEGY,
                    message="Failed to load strategy",
                    errors=result.errors
                )
            
            # Set loaded config to engine
            self.config_engine = StrategyConfigEngine(self.registry)
            self.config_engine.config = result.config
            
            # Load orchestrator-level workflow metadata (strategy_type, validation_status, etc.)
            # Read raw JSON to get workflow metadata
            with open(filepath, 'r') as f:
                config_dict = json.load(f)
            
            # Load workflow metadata if present
            if 'strategy_type' in config_dict:
                setattr(self.config_engine.config, 'strategy_type', config_dict['strategy_type'])
            if 'validation_status' in config_dict:
                setattr(self.config_engine.config, 'validation_status', config_dict['validation_status'])
            if 'generation_status' in config_dict:
                setattr(self.config_engine.config, 'generation_status', config_dict['generation_status'])
            
            # CRITICAL: Track loaded strategy path for version control (Sprint 1.6)
            # This allows version control to work on ANY loaded strategy, not hardcoded
            self.loaded_strategy_path = filepath
            logger.info(f"ℹ️ Loaded strategy path set: {filepath}")
            
            return WorkflowResult(
                success=True,
                step=WorkflowStep.CREATE_STRATEGY,
                message=f"Strategy loaded from {filepath}",
                strategy_config=self.config_engine.config
            )
            
        except Exception as e:
            return WorkflowResult(
                success=False,
                step=WorkflowStep.CREATE_STRATEGY,
                message="Failed to load strategy",
                errors=[str(e)]
            )
    
    def generate_description(self) -> str:
        """
        Generate auto-description for current strategy
        
        Returns:
            Generated description string
        """
        try:
            config = self.config_engine.config
            
            if not config.blocks:
                return "No blocks configured yet."
            
            # Count blocks and signals
            num_blocks = len(config.blocks)
            num_signals = sum(len(block.signals) for block in config.blocks)
            num_required = sum(1 for block in config.blocks if block.logic == "AND")
            num_optional = num_blocks - num_required
            
            # Count timing constraints
            num_timing = sum(
                1 for block in config.blocks
                for signal in block.signals
                if signal.timing_constraint is not None
            )
            
            # Build description
            parts = []
            parts.append(f"Strategy with {num_blocks} building block(s) and {num_signals} signal(s).")
            
            if num_required > 0:
                parts.append(f"{num_required} required block(s).")
            if num_optional > 0:
                parts.append(f"{num_optional} optional block(s).")
            
            if num_timing > 0:
                parts.append(f"{num_timing} timing constraint(s) configured.")
            
            # List blocks
            block_names = [block.name for block in config.blocks]
            if len(block_names) <= 3:
                parts.append(f"Blocks: {', '.join(block_names)}.")
            else:
                parts.append(f"Blocks: {', '.join(block_names[:3])}, and {len(block_names) - 3} more.")
            
            return " ".join(parts)
            
        except Exception as e:
            return f"Error generating description: {str(e)}"
    
    def get_current_config(self) -> StrategyConfig:
        """
        Get current strategy configuration (in-memory)

        Returns:
            Current StrategyConfig
        """
        return self.config_engine.config

    def generate_code(self, output_dir: Optional[str] = None) -> WorkflowResult:
        """
        Generate NautilusTrader strategy code from current configuration.

        Args:
            output_dir: Directory to write the .py file (defaults to src/strategies/)

        Returns:
            WorkflowResult with success flag and output_path in data
        """
        from src.strategy_builder.core.nautilus_code_generator import NautilusCodeGenerator
        import os

        try:
            config = self.get_current_config()
            generator = NautilusCodeGenerator()
            generated = generator.generate(config)

            # Validate syntax before writing
            validation = generator.validate_syntax(generated.strategy_code)
            if not validation.is_valid:
                return WorkflowResult(
                    success=False,
                    step=WorkflowStep.GENERATE_CODE,
                    message="Generated code has syntax errors",
                    errors=validation.errors,
                )

            dest_dir = output_dir or os.path.join(
                os.path.dirname(os.path.abspath(__file__)),
                "..", "..", "..", "src", "strategies"
            )
            os.makedirs(dest_dir, exist_ok=True)
            output_path = os.path.join(dest_dir, generated.file_name)

            with open(output_path, "w") as f:
                f.write(generated.strategy_code)

            logger.info(f"Generated strategy written to {output_path}")
            result = WorkflowResult(
                success=True,
                step=WorkflowStep.GENERATE_CODE,
                message=f"Strategy code written to {output_path}",
            )
            result.output_path = output_path  # type: ignore[attr-defined]
            return result

        except Exception as e:
            logger.error(f"Code generation failed: {e}")
            return WorkflowResult(
                success=False,
                step=WorkflowStep.GENERATE_CODE,
                message=f"Code generation failed: {str(e)}",
                errors=[str(e)],
            )

    def serialize_config_for_backtest(self) -> dict:
        """
        Serialize in-memory strategy config to plain Dict for backtest execution
        
        INSTITUTIONAL PATTERN: Database Isolation
        - No database access during backtest
        - Config serialized from validated in-memory state
        - Pure Dict (no ORM objects, no database connections)
        
        Returns:
            dict: Serialized strategy configuration
        
        Raises:
            ValueError: If strategy not configured or validation failed
        """
        config = self.config_engine.config
        
        # Validate config exists
        if not config or not config.name:
            raise ValueError("No strategy configured - load or create strategy first")
        
        # Validate strategy has blocks
        if not config.blocks:
            raise ValueError("Strategy has no blocks - add building blocks first")
        
        # Serialize to plain dict
        config_dict = {
            'name': config.name,
            'description': getattr(config, 'description', ''),
            'strategy_type': getattr(config, 'strategy_type', 'Bearish'),
            'version_id': self.current_version_id,
            'blocks': [],
            'exit_conditions': [],
            'parameters': {},
        }
        
        # Serialize blocks
        for block in config.blocks:
            block_dict = {
                'name': block.name,
                'logic': block.logic,
                'signals': [],
                'exit_conditions': [],
                'metadata': getattr(block, 'metadata', None),
                'indented': getattr(block, 'indented', False),
                'parameters': getattr(block, 'parameters', {}),
            }
            
            # Serialize signals
            for signal in block.signals:
                signal_dict = {
                    'name': signal.name,
                    'logic': signal.logic,
                    'weight': getattr(signal, 'weight', 10),  # CRITICAL FIX: Add signal weight
                    'timing_constraint': None,
                    'exit_conditions': []
                }
                
                # Serialize timing constraint if exists
                if hasattr(signal, 'timing_constraint') and signal.timing_constraint:
                    signal_dict['timing_constraint'] = {
                        'max_candles': signal.timing_constraint.max_candles,
                        'reference': signal.timing_constraint.reference,
                        'reference_signal': signal.timing_constraint.reference  # Alias for compatibility
                    }
                
                # Serialize signal-level exit conditions
                if hasattr(signal, 'exit_conditions'):
                    for exit_cond in signal.exit_conditions:
                        signal_dict['exit_conditions'].append({
                            'signal_name': exit_cond.signal_name,
                            'percentage': float(exit_cond.percentage),
                            'exit_mode': getattr(exit_cond, 'exit_mode', 'ABSOLUTE'),
                            'binding_level': 'SIGNAL',
                            'recheck_config': {
                                'enabled': exit_cond.recheck_config.enabled,
                                'bar_delay': exit_cond.recheck_config.bar_delay,
                                'validation_mode': getattr(exit_cond.recheck_config, 'validation_mode', 'SIGNAL'),
                                'reference_type': getattr(exit_cond.recheck_config, 'reference_type', 'PARENT'),
                                'timing_mode': getattr(exit_cond.recheck_config, 'timing_mode', 'AT')
                            } if hasattr(exit_cond, 'recheck_config') and exit_cond.recheck_config else None
                        })
                
                block_dict['signals'].append(signal_dict)
            
            # Serialize block-level exit conditions
            if hasattr(block, 'exit_conditions'):
                for exit_cond in block.exit_conditions:
                    block_dict['exit_conditions'].append({
                        'signal_name': exit_cond.signal_name,
                        'percentage': float(exit_cond.percentage),
                        'exit_mode': getattr(exit_cond, 'exit_mode', 'ABSOLUTE'),
                        'binding_level': 'BLOCK',
                        'recheck_config': {
                            'enabled': exit_cond.recheck_config.enabled,
                            'bar_delay': exit_cond.recheck_config.bar_delay,
                            'validation_mode': getattr(exit_cond.recheck_config, 'validation_mode', 'SIGNAL'),
                            'reference_type': getattr(exit_cond.recheck_config, 'reference_type', 'PARENT'),
                            'timing_mode': getattr(exit_cond.recheck_config, 'timing_mode', 'AT')
                        } if hasattr(exit_cond, 'recheck_config') and exit_cond.recheck_config else None
                    })
            
            config_dict['blocks'].append(block_dict)
        
        # Serialize strategy-level exit conditions
        if hasattr(config, 'exit_conditions'):
            for exit_cond in config.exit_conditions:
                config_dict['exit_conditions'].append({
                    'signal_name': exit_cond.signal_name,
                    'percentage': float(exit_cond.percentage),
                    'exit_mode': getattr(exit_cond, 'exit_mode', 'ABSOLUTE'),
                    'binding_level': 'STRATEGY',
                    'recheck_config': {
                        'enabled': exit_cond.recheck_config.enabled,
                        'bar_delay': exit_cond.recheck_config.bar_delay,
                        'validation_mode': getattr(exit_cond.recheck_config, 'validation_mode', 'SIGNAL'),
                        'reference_type': getattr(exit_cond.recheck_config, 'reference_type', 'PARENT'),
                        'timing_mode': getattr(exit_cond.recheck_config, 'timing_mode', 'AT')
                    } if hasattr(exit_cond, 'recheck_config') and exit_cond.recheck_config else None
                })
        
        logger.info(f"✅ Serialized strategy config: {config_dict['name']}")
        logger.info(f"   Blocks: {len(config_dict['blocks'])}")
        logger.info(f"   Total signals: {sum(len(b['signals']) for b in config_dict['blocks'])}")
        
        return config_dict
    
    def get_current_strategy_for_backtest(self) -> Optional[Any]:
        """
        Get current strategy configuration from DATABASE for backtesting
        
        INSTITUTIONAL-GRADE METHOD for Sprint 2.0.2
        
        Architecture Decision:
        - Uses existing StrategyDatabaseManager (already instantiated and tested)
        - Loads the EXACT version user selected in Strategy Builder
        - Returns database Dict with all fields (blocks, signals, exits, timing, rechecks)
        - InstitutionalSignalEvaluator accesses via dict keys: config['blocks'], config['exit_conditions']
        
        Key Differences from get_current_config():
        - get_current_config() → Returns in-memory config (may have 0 blocks during editing)
        - get_current_strategy_for_backtest() → Loads from PostgreSQL database (complete saved version)
        
        Use Cases:
        - BacktestWorker: Use this method to get complete, validated strategy
        - UI Editing: Use get_current_config() for in-memory editing
        
        Returns:
            Dict from database with all strategy data, or None if not loaded
        """
        # Check if version is tracked
        if not self.current_version_id:
            logger.error("❌ No strategy version loaded for backtest")
            logger.info("   User must open a strategy from Strategy Browser first")
            return None
        
        try:
            # Use existing database manager (PostgreSQL connection)
            from src.optimizer_v3.database import get_database_manager
            
            db = get_database_manager()
            
            # Load strategy version from database
            # This returns Dict with JSONB fields already deserialized to Python objects
            version_dict = db.strategy.get_strategy_version(self.current_version_id)
            
            if not version_dict:
                logger.error(f"❌ Strategy version {self.current_version_id} not found in database")
                return None
            
            # Log what was loaded
            blocks_count = len(version_dict.get('blocks', []))
            total_signals = sum(len(b.get('signals', [])) for b in version_dict.get('blocks', []))
            
            logger.info(f"✅ Loaded strategy for backtest: {version_dict['name']}")
            logger.info(f"   Version: v{version_dict['version_number']}")
            logger.info(f"   Blocks: {blocks_count}")
            logger.info(f"   Total signals: {total_signals}")
            logger.info(f"   Exit conditions: {len(version_dict.get('exit_conditions', []))}")
            
            # CRITICAL FIX: Close PostgreSQL connections BEFORE returning
            # Multiprocessing fork() will happen next (bar aggregation with 31 CPUs)
            # SSL connections don't survive fork() - must close in parent process
            if hasattr(db, 'engine') and db.engine is not None:
                db.engine.dispose()  # Close all connections in pool
                logger.info("✅ Closed PostgreSQL connections before multiprocessing")
            
            # Return database dict directly
            # InstitutionalSignalEvaluator will access: config['blocks'], config['exit_conditions']
            return version_dict
            
        except Exception as e:
            import traceback
            logger.error(f"❌ ERROR loading strategy from database: {e}")
            traceback.print_exc()
            return None
    
    def add_building_block(self, block_name: str) -> bool:
        """
        Add building block with INTELLIGENT signal filtering (Sprint 1.6 Integration)
        
        CRITICAL FIXES:
        1. Uses add_block_with_signals() to ensure signals are included
        2. INTELLIGENT signal filtering based on strategy type (Bearish → only BEARISH signals)
        3. Uses signal_mapping.py for strategy-appropriate signal selection
        
        Example: liquidity_sweep + Bearish strategy → only BEARISH_SWEEP (not BULLISH+ERROR+NEUTRAL)
        
        Args:
            block_name: Registry name of block to add (e.g., 'liquidity_sweep')
        
        Returns:
            True if successful, False otherwise
        """
        try:
            from src.optimizer_v3.core.signal_mapping import get_signals_for_strategy
            
            # Get block metadata from registry
            block_metadata = self.registry.get_block(block_name)
            if not block_metadata:
                logger.error(f"❌ Block '{block_name}' not found in registry")
                return False
            
            # Get strategy type from config (Bullish, Bearish, Neutral)
            strategy_type = getattr(self.config_engine.config, 'strategy_type', 'Bearish')
            logger.info(f"📊 Strategy type: {strategy_type}")
            
            # INTELLIGENT: Get strategy-appropriate signals from mapping
            signal_names = get_signals_for_strategy(block_name, strategy_type)
            
            if not signal_names:
                # Fallback: No mapping found - use all registry signals (old behavior)
                logger.warning(f"⚠️ No intelligent mapping for '{block_name}' - using registry signals")
                if 'signals' in block_metadata:
                    for signal in block_metadata['signals']:
                        if isinstance(signal, dict) and 'name' in signal:
                            signal_names.append(signal['name'])
                        elif isinstance(signal, str):
                            signal_names.append(signal)
            
            if not signal_names:
                logger.warning(f"⚠️ No signals found for block '{block_name}', adding block only")
                result = self.add_block(block_name, logic="AND")
                return result.success
            
            logger.info(f"🎯 Intelligent signal selection: {signal_names}")
            
            # Add block WITH filtered signals using institutional-grade method
            result = self.add_block_with_signals(
                block_name=block_name,
                signal_names=signal_names,
                block_logic="AND",
                signal_logic="AND"
            )
            
            if result.success:
                logger.info(f"✅ Added building block '{block_name}' with {len(signal_names)} signal(s)")
            
            return result.success
            
        except Exception as e:
            logger.error(f"❌ Failed to add building block '{block_name}': {str(e)}")
            return False
    
    def update_parameter(self, param_name: str, new_value) -> bool:
        """
        Update strategy parameter (Sprint 1.6 Integration)
        
        Supports updating common strategy parameters like:
        - stop_loss: Stop loss percentage
        - take_profit: Take profit percentage
        - position_size: Position size
        - risk_per_trade: Risk per trade
        
        Args:
            param_name: Parameter name to update
            new_value: New parameter value
        
        Returns:
            True if successful, False otherwise
        """
        try:
            config = self.config_engine.config
            
            # Map parameter names to config attributes
            param_mapping = {
                'stop_loss': 'stop_loss',
                'take_profit': 'take_profit',
                'position_size': 'position_size',
                'risk_per_trade': 'risk_per_trade',
                'max_trades': 'max_trades',
                'session_filter': 'session_filter'
            }
            
            # Check if parameter is supported
            if param_name not in param_mapping:
                logger.warning(f"⚠️ Parameter '{param_name}' not yet supported for update")
                logger.info(f"   Supported parameters: {list(param_mapping.keys())}")
                return False
            
            # Get config attribute name
            config_attr = param_mapping[param_name]
            
            # Update parameter
            if hasattr(config, config_attr):
                setattr(config, config_attr, new_value)
                logger.info(f"✅ Updated {param_name} = {new_value}")
                return True
            else:
                # Add parameter if it doesn't exist
                setattr(config, config_attr, new_value)
                logger.info(f"✅ Added {param_name} = {new_value}")
                return True
                
        except Exception as e:
            logger.error(f"❌ Failed to update parameter '{param_name}': {str(e)}")
            return False
    
    def save_config_version(self, message: str) -> bool:
        """
        Save current configuration version with Git commit + DB sync

        Sprint 1.6 Requirement (Task 1.6.8):
        Version control integration using Git commits for tracking
        configuration changes made via intelligent recommendations.

        CRITICAL FIX: Uses self.loaded_strategy_path to save to the LOADED strategy file,
        not hardcoded to a single JSON file — dynamically follows the loaded strategy path.
        Works for ANY loaded strategy (HOD Rejection, RSI VWAP, etc.).

        DB SYNC (BTCAAAAA-25629): After JSON + git commit, also creates a new version
        in the database so the DB stays in sync with the file. Previously, recommendations
        like ADD_BLOCK liquidity_sweep were only persisted to JSON but never saved to the
        strategy_versions table, causing silent drift.

        Args:
            message: Commit message describing the change
                    (e.g., "Added building block: liquidity_sweep (via metrics recommendation)")

        Returns:
            True if successfully saved, False otherwise
        """
        try:
            import subprocess
            import os
            from pathlib import Path

            # Get project root (assumption: orchestrator is in src/strategy_builder/integration)
            project_root = Path(__file__).parent.parent.parent.parent

            # CRITICAL: Use loaded strategy path if available (dynamically tracks ANY loaded strategy)
            if self.loaded_strategy_path:
                config_file = Path(self.loaded_strategy_path)
                logger.info(f"💾 Saving to loaded strategy: {config_file.name}")
            else:
                # Fallback to current_strategy.json if no strategy loaded
                config_file = project_root / "user_strategies" / "current_strategy.json"
                logger.info(f"💾 No loaded strategy path - saving to: user_strategies/current_strategy.json")

            config_file.parent.mkdir(parents=True, exist_ok=True)

            # Persist current config
            save_result = self.save_strategy(str(config_file))
            if not save_result.success:
                logger.error(f"⚠️ Failed to save config file before version commit")
                return False

            # Git add the configuration file
            result_add = subprocess.run(
                ['git', 'add', str(config_file)],
                cwd=str(project_root),
                capture_output=True,
                text=True,
                timeout=5
            )

            if result_add.returncode != 0:
                logger.error(f"⚠️ Git add failed: {result_add.stderr}")
                return False

            # Git commit with message
            result_commit = subprocess.run(
                ['git', 'commit', '-m', f"[Strategy Config] {message}"],
                cwd=str(project_root),
                capture_output=True,
                text=True,
                timeout=10
            )

            commit_hash = None
            commit_ok = False

            if result_commit.returncode == 0:
                logger.info(f"✅ Configuration version saved: {message}")
                commit_ok = True
                for line in result_commit.stdout.splitlines():
                    if line.startswith('['):
                        parts = line.split()
                        if len(parts) >= 2:
                            commit_hash = parts[1].rstrip(']')
                            break
            elif "nothing to commit" in result_commit.stdout.lower():
                logger.info(f"ℹ️ No changes to commit (already saved)")
                commit_ok = True
                try:
                    result_log = subprocess.run(
                        ['git', 'log', '-1', '--format=%h'],
                        cwd=str(project_root),
                        capture_output=True,
                        text=True,
                        timeout=5
                    )
                    if result_log.returncode == 0:
                        commit_hash = result_log.stdout.strip()
                except Exception:
                    pass
            else:
                logger.error(f"⚠️ Git commit failed: {result_commit.stderr}")
                return False

            # ── DB SYNC: persist new version to database ────────────────────
            if commit_ok and self.current_strategy_id:
                try:
                    from src.optimizer_v3.database import get_database_manager

                    config = self.config_engine.config
                    blocks_serialized = []
                    for block in config.blocks:
                        block_dict = {
                            'name': block.name,
                            'logic': block.logic,
                            'signals': [],
                            'exit_conditions': [],
                        }
                        for signal in block.signals:
                            signal_dict = {
                                'name': signal.name,
                                'logic': signal.logic,
                                'weight': getattr(signal, 'weight', 10),
                            }
                            if hasattr(signal, 'exit_conditions') and signal.exit_conditions:
                                signal_dict['exit_conditions'] = []
                                for ec in signal.exit_conditions:
                                    signal_dict['exit_conditions'].append({
                                        'signal_name': ec.signal_name,
                                        'percentage': float(ec.percentage),
                                        'exit_mode': getattr(ec, 'exit_mode', 'ABSOLUTE'),
                                        'binding_level': 'SIGNAL',
                                    })
                            block_dict['signals'].append(signal_dict)
                        if hasattr(block, 'exit_conditions') and block.exit_conditions:
                            for ec in block.exit_conditions:
                                block_dict['exit_conditions'].append({
                                    'signal_name': ec.signal_name,
                                    'percentage': float(ec.percentage),
                                    'exit_mode': getattr(ec, 'exit_mode', 'ABSOLUTE'),
                                    'binding_level': 'BLOCK',
                                })
                        blocks_serialized.append(block_dict)

                    exit_conditions_serialized = []
                    for ec in getattr(config, 'exit_conditions', []):
                        exit_conditions_serialized.append({
                            'signal_name': ec.signal_name,
                            'percentage': float(ec.percentage),
                            'exit_mode': getattr(ec, 'exit_mode', 'ABSOLUTE'),
                            'binding_level': 'STRATEGY',
                        })

                    strategy_data = {
                        'strategy_id': self.current_strategy_id,
                        'name': config.name or 'GeneratedStrategy',
                        'description': getattr(config, 'description', ''),
                        'strategy_type': getattr(config, 'strategy_type', 'Bullish'),
                        'blocks': blocks_serialized,
                        'signals': {},
                        'parameters': {},
                        'entry_conditions': {},
                        'exit_conditions': exit_conditions_serialized,
                        'risk_management': {},
                        'backtest_config': {},
                        'git_commit_hash': commit_hash,
                        'notes': message,
                        'created_by': 'NautilusEngineer',
                    }

                    db = get_database_manager()
                    new_version_id = db.strategy.create_strategy_version(strategy_data)
                    self.current_version_id = new_version_id
                    logger.info(
                        f"✅ DB version synced: strategy={strategy_data['strategy_id'][:8]}... "
                        f"new version_id={new_version_id[:8]}..."
                    )

                    if hasattr(db, 'engine') and db.engine is not None:
                        db.engine.dispose()

                except Exception as db_exc:
                    logger.warning(
                        f"⚠️ DB sync failed (config saved to JSON + git, DB version skipped): {db_exc}"
                    )

            return True

        except subprocess.TimeoutExpired:
            logger.error(f"❌ Git operation timed out")
            return False
        except FileNotFoundError:
            logger.warning(f"⚠️ Git not available - version control disabled")
            return False
        except Exception as e:
            logger.error(f"❌ Version save failed: {str(e)}")
            return False
        
    def add_exit_condition(
        self,
        signal_name: str,
        percentage: float,
        binding_level: str = "STRATEGY",
        block_name: Optional[str] = None,
        parent_signal_name: Optional[str] = None,
        exit_mode: str = "ABSOLUTE",
        tp_proximity_threshold: float = 2.0,
        reversal_trigger: float = 0.5,
        recheck_enabled: bool = False,
        recheck_bar_delay: Optional[int] = None
    ) -> WorkflowResult:
        """
        Add exit condition at specified binding level
        Sprint 1.8 Task 1.8.30

        Args:
            signal_name: Name of signal that triggers exit
            percentage: Exit percentage (0.0-1.0)
            binding_level: "STRATEGY", "BLOCK", or "SIGNAL"
            block_name: Required if binding_level is "BLOCK" or "SIGNAL"
            parent_signal_name: Required if binding_level is "SIGNAL"
            exit_mode: Exit mode ("ABSOLUTE" or "FLEXIBLE")
            tp_proximity_threshold: TP proximity threshold for FLEXIBLE mode
            reversal_trigger: Reversal trigger for FLEXIBLE mode
            recheck_enabled: Enable RECHECK validation
            recheck_bar_delay: Number of bars for RECHECK validation
            exit_mode: "ABSOLUTE" or "FLEXIBLE"
            tp_proximity_threshold: For FLEXIBLE mode (percentage)
            reversal_trigger: For FLEXIBLE mode (percentage)
            
        Returns:
            WorkflowResult
        """
        try:
            from src.strategy_builder.core.strategy_config_engine import ExitCondition, RecheckConfig
            # Validate inputs
            if percentage <= 0 or percentage > 1.0:
                return WorkflowResult(
                    success=False,
                    step=WorkflowStep.ADD_SIGNAL,
                    message="Invalid percentage",
                    errors=["Percentage must be between 0 and 1.0"]
                )
            
            if exit_mode not in ["ABSOLUTE", "FLEXIBLE"]:
                return WorkflowResult(
                    success=False,
                    step=WorkflowStep.ADD_SIGNAL,
                    message="Invalid exit mode",
                    errors=["Exit mode must be 'ABSOLUTE' or 'FLEXIBLE'"]
                )
            
            if binding_level not in ["STRATEGY", "BLOCK", "SIGNAL"]:
                return WorkflowResult(
                    success=False,
                    step=WorkflowStep.ADD_SIGNAL,
                    message="Invalid binding level",
                    errors=["Binding level must be 'STRATEGY', 'BLOCK', or 'SIGNAL'"]
                )
            
            # Create RECHECK config if enabled
            recheck_config = None
            if recheck_enabled and recheck_bar_delay:
                recheck_config = RecheckConfig(
                    enabled=True,
                    bar_delay=recheck_bar_delay
                )
            
            # Create exit condition with RECHECK support
            exit_condition = ExitCondition(
                signal_name=signal_name,
                percentage=percentage,
                exit_mode=exit_mode,
                tp_proximity_threshold=tp_proximity_threshold,
                reversal_trigger=reversal_trigger,
                binding_level=binding_level,
                recheck_config=recheck_config
            )
            
            # Add at appropriate level
            if binding_level == "STRATEGY":
                self.config_engine.config.exit_conditions.append(exit_condition)
                message = f"Added strategy-level exit condition: {signal_name} ({percentage*100:.0f}%)"
                
            elif binding_level == "BLOCK":
                if not block_name:
                    return WorkflowResult(
                        success=False,
                        step=WorkflowStep.ADD_SIGNAL,
                        message="block_name required for BLOCK binding level",
                        errors=["block_name is required"]
                    )
                
                # Find block
                block_found = False
                for block in self.config_engine.config.blocks:
                    if block.name == block_name:
                        block.exit_conditions.append(exit_condition)
                        block_found = True
                        break
                
                if not block_found:
                    return WorkflowResult(
                        success=False,
                        step=WorkflowStep.ADD_SIGNAL,
                        message=f"Block '{block_name}' not found",
                        errors=[f"Block '{block_name}' does not exist"]
                    )
                
                message = f"Added block-level exit condition to '{block_name}': {signal_name} ({percentage*100:.0f}%)"
                
            else:  # SIGNAL level
                if not block_name or not parent_signal_name:
                    return WorkflowResult(
                        success=False,
                        step=WorkflowStep.ADD_SIGNAL,
                        message="block_name and parent_signal_name required for SIGNAL binding level",
                        errors=["block_name and parent_signal_name are required"]
                    )
                
                # Find block and signal
                signal_found = False
                for block in self.config_engine.config.blocks:
                    if block.name == block_name:
                        for signal in block.signals:
                            if signal.name == parent_signal_name:
                                signal.exit_conditions.append(exit_condition)
                                signal_found = True
                                break
                        break
                
                if not signal_found:
                    return WorkflowResult(
                        success=False,
                        step=WorkflowStep.ADD_SIGNAL,
                        message=f"Signal '{parent_signal_name}' not found in block '{block_name}'",
                        errors=[f"Signal '{parent_signal_name}' does not exist"]
                    )
                
                message = f"Added signal-level exit condition to '{block_name}::{parent_signal_name}': {signal_name} ({percentage*100:.0f}%)"
            
            return WorkflowResult(
                success=True,
                step=WorkflowStep.ADD_SIGNAL,
                message=message,
                strategy_config=self.config_engine.config
            )
            
        except Exception as e:
            return WorkflowResult(
                success=False,
                step=WorkflowStep.ADD_SIGNAL,
                message="Failed to add exit condition",
                errors=[str(e)]
            )
    
    def remove_exit_condition(
        self,
        signal_name: str,
        binding_level: str = "STRATEGY",
        block_name: Optional[str] = None,
        parent_signal_name: Optional[str] = None
    ) -> WorkflowResult:
        """
        Remove exit condition
        Sprint 1.8 Task 1.8.31
        
        Args:
            signal_name: Name of signal that triggers exit
            binding_level: "STRATEGY", "BLOCK", or "SIGNAL"
            block_name: Required if binding_level is "BLOCK" or "SIGNAL"
            parent_signal_name: Required if binding_level is "SIGNAL"
            
        Returns:
            WorkflowResult
        """
        try:
            # Remove at appropriate level
            if binding_level == "STRATEGY":
                initial_count = len(self.config_engine.config.exit_conditions)
                self.config_engine.config.exit_conditions = [
                    ec for ec in self.config_engine.config.exit_conditions
                    if ec.signal_name != signal_name
                ]
                
                if len(self.config_engine.config.exit_conditions) == initial_count:
                    return WorkflowResult(
                        success=False,
                        step=WorkflowStep.ADD_SIGNAL,
                        message=f"Exit condition '{signal_name}' not found at strategy level",
                        errors=["Exit condition does not exist"]
                    )
                
                message = f"Removed strategy-level exit condition: {signal_name}"
                
            elif binding_level == "BLOCK":
                if not block_name:
                    return WorkflowResult(
                        success=False,
                        step=WorkflowStep.ADD_SIGNAL,
                        message="block_name required for BLOCK binding level",
                        errors=["block_name is required"]
                    )
                
                # Find block
                block_found = False
                removed = False
                for block in self.config_engine.config.blocks:
                    if block.name == block_name:
                        block_found = True
                        initial_count = len(block.exit_conditions)
                        block.exit_conditions = [
                            ec for ec in block.exit_conditions
                            if ec.signal_name != signal_name
                        ]
                        removed = len(block.exit_conditions) < initial_count
                        break
                
                if not block_found:
                    return WorkflowResult(
                        success=False,
                        step=WorkflowStep.ADD_SIGNAL,
                        message=f"Block '{block_name}' not found",
                        errors=[f"Block '{block_name}' does not exist"]
                    )
                
                if not removed:
                    return WorkflowResult(
                        success=False,
                        step=WorkflowStep.ADD_SIGNAL,
                        message=f"Exit condition '{signal_name}' not found in block '{block_name}'",
                        errors=["Exit condition does not exist"]
                    )
                
                message = f"Removed block-level exit condition from '{block_name}': {signal_name}"
                
            else:  # SIGNAL level
                if not block_name or not parent_signal_name:
                    return WorkflowResult(
                        success=False,
                        step=WorkflowStep.ADD_SIGNAL,
                        message="block_name and parent_signal_name required for SIGNAL binding level",
                        errors=["block_name and parent_signal_name are required"]
                    )
                
                # Find block and signal
                signal_found = False
                removed = False
                for block in self.config_engine.config.blocks:
                    if block.name == block_name:
                        for signal in block.signals:
                            if signal.name == parent_signal_name:
                                signal_found = True
                                initial_count = len(signal.exit_conditions)
                                signal.exit_conditions = [
                                    ec for ec in signal.exit_conditions
                                    if ec.signal_name != signal_name
                                ]
                                removed = len(signal.exit_conditions) < initial_count
                                break
                        break
                
                if not signal_found:
                    return WorkflowResult(
                        success=False,
                        step=WorkflowStep.ADD_SIGNAL,
                        message=f"Signal '{parent_signal_name}' not found in block '{block_name}'",
                        errors=[f"Signal '{parent_signal_name}' does not exist"]
                    )
                
                if not removed:
                    return WorkflowResult(
                        success=False,
                        step=WorkflowStep.ADD_SIGNAL,
                        message=f"Exit condition '{signal_name}' not found",
                        errors=["Exit condition does not exist"]
                    )
                
                message = f"Removed signal-level exit condition from '{block_name}::{parent_signal_name}': {signal_name}"
            
            return WorkflowResult(
                success=True,
                step=WorkflowStep.ADD_SIGNAL,
                message=message,
                strategy_config=self.config_engine.config
            )
            
        except Exception as e:
            return WorkflowResult(
                success=False,
                step=WorkflowStep.ADD_SIGNAL,
                message="Failed to remove exit condition",
                errors=[str(e)]
            )
    
    def configure_exit_condition(
        self,
        signal_name: str,
        binding_level: str = "STRATEGY",
        block_name: Optional[str] = None,
        parent_signal_name: Optional[str] = None,
        **kwargs
    ) -> WorkflowResult:
        """
        Update exit condition settings
        Sprint 1.8 Task 1.8.32
        
        Args:
            signal_name: Name of signal that triggers exit
            binding_level: "STRATEGY", "BLOCK", or "SIGNAL"
            block_name: Required if binding_level is "BLOCK" or "SIGNAL"
            parent_signal_name: Required if binding_level is "SIGNAL"
            **kwargs: Settings to update (percentage, exit_mode, tp_proximity_threshold, reversal_trigger)
            
        Returns:
            WorkflowResult
        """
        try:
            # Find and update exit condition
            exit_condition = None
            
            if binding_level == "STRATEGY":
                for ec in self.config_engine.config.exit_conditions:
                    if ec.signal_name == signal_name:
                        exit_condition = ec
                        break
                        
            elif binding_level == "BLOCK":
                if not block_name:
                    return WorkflowResult(
                        success=False,
                        step=WorkflowStep.ADD_SIGNAL,
                        message="block_name required",
                        errors=["block_name is required"]
                    )
                
                for block in self.config_engine.config.blocks:
                    if block.name == block_name:
                        for ec in block.exit_conditions:
                            if ec.signal_name == signal_name:
                                exit_condition = ec
                                break
                        break
                        
            else:  # SIGNAL level
                if not block_name or not parent_signal_name:
                    return WorkflowResult(
                        success=False,
                        step=WorkflowStep.ADD_SIGNAL,
                        message="block_name and parent_signal_name required",
                        errors=["block_name and parent_signal_name are required"]
                    )
                
                for block in self.config_engine.config.blocks:
                    if block.name == block_name:
                        for signal in block.signals:
                            if signal.name == parent_signal_name:
                                for ec in signal.exit_conditions:
                                    if ec.signal_name == signal_name:
                                        exit_condition = ec
                                        break
                                break
                        break
            
            if not exit_condition:
                return WorkflowResult(
                    success=False,
                    step=WorkflowStep.ADD_SIGNAL,
                    message=f"Exit condition '{signal_name}' not found",
                    errors=["Exit condition does not exist"]
                )
            
            # Update settings
            updates = []
            for key, value in kwargs.items():
                if hasattr(exit_condition, key):
                    setattr(exit_condition, key, value)
                    updates.append(f"{key}={value}")
            
            if not updates:
                return WorkflowResult(
                    success=False,
                    step=WorkflowStep.ADD_SIGNAL,
                    message="No valid settings to update",
                    errors=["No valid settings provided"]
                )
            
            message = f"Updated exit condition '{signal_name}': {', '.join(updates)}"
            
            return WorkflowResult(
                success=True,
                step=WorkflowStep.ADD_SIGNAL,
                message=message,
                strategy_config=self.config_engine.config
            )
            
        except Exception as e:
            return WorkflowResult(
                success=False,
                step=WorkflowStep.ADD_SIGNAL,
                message="Failed to configure exit condition",
                errors=[str(e)]
            )
    
    def reset(self):
        """Reset orchestrator state"""
        self.config_engine = StrategyConfigEngine(self.registry)
        self.dependency_resolver = SignalDependencyResolver()
        self.test_engine = WalkforwardTestEngine()
